const router = require('express').Router();
const { v4: uuid } = require('uuid');
const db = require('../db');
const { err, wrap } = require('../lib/errors');
const { V, body } = require('../lib/validate');
const { rateLimit } = require('../lib/ratelimit');
const A = require('../lib/auth');
const ai = require('../lib/ai');
const safety = require('../lib/safety');
const rag = require('../lib/rag');
const artifactLib = require('../lib/artifacts');
const toolLib = require('../lib/tools');

const chatLimit = rateLimit({ windowMs: 60_000, max: 40, message: 'You are sending messages very quickly. Please slow down.' });

// ─── MODEL REGISTRY ───
router.get('/models', A.optionalAuth, wrap(async (req, res) => {
  const allowed = req.user ? A.planOf(req.user).models : ['blaze', 'ember'];
  res.json({
    success: true,
    data: {
      models: Object.values(ai.MODELS).map(m => ({
        id: m.id, name: m.name, description: m.description,
        contextWindow: m.contextWindow, available: allowed.includes(m.id)
      })),
      providerOnline: ai.isAvailable()
    }
  });
}));

/**
 * POST /stream — Server-Sent Events.
 * Persists the user message, streams the reply, then saves it with usage stats.
 * Works for guests (nothing persisted) and authenticated users alike.
 */
router.post('/stream', chatLimit, A.optionalAuth,
  body({
    message: V.string({ required: true, min: 1, max: 100000 }),
    conversationId: V.string({ max: 64 }),
    model: V.enum(['blaze', 'nova', 'ember'], { default: 'blaze' }),
    history: V.array({ max: 100 }),
    attachmentIds: V.array({ max: 10 }),
    persist: V.bool({ default: true })
  }),
  wrap(async (req, res) => {
    const { message, conversationId, model, history = [], attachmentIds = [] } = req.data;
    const persist = req.data.persist !== false && !!req.user;

    // Plan gating + quota (authenticated users only).
    if (req.user) {
      const plan = A.planOf(req.user);
      if (!plan.models.includes(model)) throw err.forbidden(`The ${ai.resolveModel(model).name} model requires an upgraded plan`);
      const used = A.rollUsage(req.user.id);
      if (used >= plan.dailyMessages) {
        throw err.quota(`You've reached your daily limit of ${plan.dailyMessages} messages.`, { used, limit: plan.dailyMessages });
      }
    }

    let conversation = null;
    if (persist && conversationId) {
      conversation = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, req.user.id);
      if (!conversation) throw err.notFound('Conversation not found');
    }

    // Pull attachments so their text can enter the context.
    const attachments = attachmentIds.length && req.user
      ? db.prepare(`SELECT * FROM attachments WHERE user_id = ? AND id IN (${attachmentIds.map(() => '?').join(',')})`)
          .all(req.user.id, ...attachmentIds)
      : [];

    // Prefer stored history for accuracy; fall back to what the client sent.
    let priorMessages = history;
    if (conversation) {
      priorMessages = db.prepare(
        'SELECT role, content FROM messages WHERE conversation_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT 40'
      ).all(conversation.id).reverse();
    }

    // Persist the user's message before streaming.
    let userMessageId = null;
    if (persist && conversation) {
      userMessageId = uuid();
      const tokens = ai.estimateTokens(message);
      db.transaction(() => {
        db.prepare('INSERT INTO messages (id, conversation_id, role, content, tokens) VALUES (?,?,?,?,?)')
          .run(userMessageId, conversation.id, 'user', message, tokens);
        db.fts.index({ id: userMessageId, conversation_id: conversation.id, content: message });
        attachmentIds.forEach(aid =>
          db.prepare('UPDATE attachments SET message_id = ? WHERE id = ? AND user_id = ?').run(userMessageId, aid, req.user.id));
        db.prepare(`UPDATE conversations SET message_count = message_count + 1, last_message_at = datetime('now'),
                    updated_at = datetime('now') WHERE id = ?`).run(conversation.id);
        db.prepare('UPDATE users SET total_messages = total_messages + 1, usage_today = usage_today + 1 WHERE id = ?')
          .run(req.user.id);
        for (const mem of ai.extractMemories(message)) {
          try {
            db.prepare(`INSERT INTO memories (id, user_id, type, key, value, source, updated_at)
                        VALUES (?,?,?,?,?, 'auto', datetime('now'))
                        ON CONFLICT(user_id, type, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
              .run(uuid(), req.user.id, mem.type, mem.key, mem.value);
          } catch {}
        }
      })();
    }

    const messages = ai.buildContext({
      user: req.user,
      conversation: conversation || { model },
      history: priorMessages,
      message,
      attachments
    });

    // Let the client abort mid-stream.
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    await ai.streamCompletion(res, messages, {
      model,
      signal: controller.signal,
      onFinish: ({ text, tokens, latencyMs, ok }) => {
        if (req.user) {
          db.prepare('INSERT INTO usage_events (id, user_id, kind, model, tokens, latency_ms, ok) VALUES (?,?,?,?,?,?,?)')
            .run(uuid(), req.user.id, 'chat', model, tokens, latencyMs, ok ? 1 : 0);
          db.prepare('UPDATE users SET total_tokens = total_tokens + ? WHERE id = ?').run(tokens, req.user.id);
        }
        if (persist && conversation && ok && text) {
          const aid = uuid();
          db.transaction(() => {
            db.prepare(`INSERT INTO messages (id, conversation_id, parent_id, role, content, model, tokens, latency_ms)
                        VALUES (?,?,?,?,?,?,?,?)`)
              .run(aid, conversation.id, userMessageId, 'assistant', text, model, tokens, latencyMs);
            db.fts.index({ id: aid, conversation_id: conversation.id, content: text });
            db.prepare(`UPDATE conversations SET message_count = message_count + 1, total_tokens = total_tokens + ?,
                        last_message_at = datetime('now') WHERE id = ?`).run(tokens, conversation.id);
          })();

          // Auto-title a brand-new conversation from its first exchange.
          if (conversation.title === 'New Conversation') {
            ai.generateTitle(message)
              .then(t => db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(t, conversation.id))
              .catch(() => {});
          }
        }
      }
    });
  })
);

/**
 * POST /agent — the full experience: safety screening, knowledge grounding,
 * extended thinking, tool use, artifacts, citations and follow-up suggestions.
 * Streams SSE events: meta → thinking → tool_use → tool_result → delta → artifact → citations → suggestions → done
 */
router.post('/agent', chatLimit, A.authenticate, A.enforceQuota,
  body({
    message: V.string({ required: true, min: 1, max: 100000 }),
    conversationId: V.string({ max: 64 }),
    model: V.enum(['blaze', 'nova', 'ember'], { default: 'blaze' }),
    thinking: V.bool({ default: true }),
    useTools: V.bool({ default: true }),
    useKnowledge: V.bool({ default: true }),
    artifacts: V.bool({ default: true }),
    suggestions: V.bool({ default: true }),
    tools: V.array({ max: 12 }),
    maxSteps: V.int({ min: 1, max: 6, default: 4 }),
    projectId: V.string({ max: 64 })
  }),
  wrap(async (req, res) => {
    const d = req.data;

    // 1) Safety screen before anything else.
    const screen = safety.screenInput(d.message);
    if (screen.action !== 'allow') {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.flushHeaders?.();
      const send = (e, x) => res.write(`event: ${e}\ndata: ${JSON.stringify(x)}\n\n`);
      send('meta', { model: d.model, safety: screen.action });
      send('delta', { text: screen.message });
      send('done', { blocked: true, category: screen.category, tokens: 0, ok: true });
      return res.end();
    }

    const plan = A.planOf(req.user);
    if (!plan.models.includes(d.model)) throw err.forbidden(`The ${ai.resolveModel(d.model).name} model requires an upgraded plan`);

    let conversation = null;
    if (d.conversationId) {
      conversation = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(d.conversationId, req.user.id);
      if (!conversation) throw err.notFound('Conversation not found');
    }

    // 2) Ground the answer in the user's knowledge base.
    const grounding = d.useKnowledge
      ? rag.buildGroundedContext({ userId: req.user.id, projectId: d.projectId || conversation?.project_id || null, query: d.message })
      : null;

    const history = conversation
      ? db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT 30')
          .all(conversation.id).reverse()
      : [];

    const allowedTools = d.useTools ? (d.tools?.length ? d.tools : Object.keys(toolLib.TOOLS)) : null;

    const messages = ai.buildContext({
      user: req.user,
      conversation: conversation || { model: d.model, project_id: d.projectId },
      history, message: d.message,
      thinking: d.thinking, tools: allowedTools,
      artifactsEnabled: d.artifacts, grounding
    });

    // 3) Stream the agent's work.
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const send = (e, x) => { if (!res.writableEnded) res.write(`event: ${e}\ndata: ${JSON.stringify(x)}\n\n`); };
    const beat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);

    const started = Date.now();
    send('meta', {
      model: d.model, thinking: d.thinking, tools: !!allowedTools,
      grounded: !!grounding, sources: grounding?.sources?.length || 0
    });
    if (grounding) send('sources', { sources: grounding.sources });

    // Persist the user's message.
    let userMessageId = null;
    if (conversation) {
      userMessageId = uuid();
      db.transaction(() => {
        db.prepare('INSERT INTO messages (id, conversation_id, role, content, tokens) VALUES (?,?,?,?,?)')
          .run(userMessageId, conversation.id, 'user', d.message, ai.estimateTokens(d.message));
        db.fts.index({ id: userMessageId, conversation_id: conversation.id, content: d.message });
        db.prepare(`UPDATE conversations SET message_count = message_count + 1,
                    last_message_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(conversation.id);
        db.prepare('UPDATE users SET total_messages = total_messages + 1, usage_today = usage_today + 1 WHERE id = ?').run(req.user.id);
      })();
    }

    let result;
    try {
      result = await ai.runAgent({
        messages, model: d.model, maxSteps: d.maxSteps,
        ctx: { userId: req.user.id, conversationId: conversation?.id || null },
        emit: send
      });
    } catch (e) {
      result = { text: "I couldn't reach the AI provider just now. Please try again in a moment.", toolCalls: [], citations: [] };
      send('error', { code: 'UPSTREAM_ERROR', message: e.message });
    }

    // 4) Extract artifacts, then stream the visible answer.
    let visible = result.text || '';
    const madeArtifacts = [];
    if (d.artifacts) {
      for (const found of artifactLib.extractFromText(visible)) {
        try {
          const saved = artifactLib.upsert({
            userId: req.user.id, conversationId: conversation?.id || null,
            identifier: found.identifier, title: found.title, type: found.type,
            language: found.language, content: found.content
          });
          madeArtifacts.push({ ...found, id: saved.id, version: saved.version });
          send('artifact', { id: saved.id, identifier: saved.identifier, title: saved.title, type: saved.type, language: saved.language, version: saved.version });
        } catch {}
      }
      if (madeArtifacts.length) visible = artifactLib.stripArtifacts(visible, madeArtifacts);
    }

    for (let i = 0; i < visible.length; i += 42) {
      if (res.writableEnded) break;
      send('delta', { text: visible.slice(i, i + 42) });
      await new Promise(r => setTimeout(r, 6));
    }

    // 5) Persist the reply, citations, and usage.
    const tokens = ai.estimateTokens(visible);
    const latency = Date.now() - started;
    const citations = [...(grounding?.sources || []).map(s => ({ type: 'knowledge', title: s.title, excerpt: s.excerpt })), ...(result.citations || [])];

    if (conversation && visible) {
      const aid = uuid();
      db.transaction(() => {
        db.prepare(`INSERT INTO messages (id, conversation_id, parent_id, role, content, model, tokens, latency_ms)
                    VALUES (?,?,?,?,?,?,?,?)`)
          .run(aid, conversation.id, userMessageId, 'assistant', visible, d.model, tokens, latency);
        db.fts.index({ id: aid, conversation_id: conversation.id, content: visible });
        db.prepare(`UPDATE conversations SET message_count = message_count + 1, total_tokens = total_tokens + ?,
                    last_message_at = datetime('now') WHERE id = ?`).run(tokens, conversation.id);
        citations.forEach((c, i) =>
          db.prepare('INSERT INTO citations (id, message_id, ordinal, source_type, title, url, excerpt) VALUES (?,?,?,?,?,?,?)')
            .run(uuid(), aid, i + 1, c.type, c.title || null, c.url || null, (c.excerpt || '').slice(0, 500)));
        if (madeArtifacts.length) {
          db.prepare('UPDATE artifacts SET message_id = ? WHERE id IN (' + madeArtifacts.map(() => '?').join(',') + ')')
            .run(aid, ...madeArtifacts.map(a => a.id));
        }
      })();
      if (conversation.title === 'New Conversation') {
        ai.generateTitle(d.message).then(t =>
          db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(t, conversation.id)).catch(() => {});
      }
    }

    db.prepare('INSERT INTO usage_events (id, user_id, kind, model, tokens, latency_ms, ok) VALUES (?,?,?,?,?,?,?)')
      .run(uuid(), req.user.id, 'agent', d.model, tokens, latency, 1);
    db.prepare('UPDATE users SET total_tokens = total_tokens + ? WHERE id = ?').run(tokens, req.user.id);

    if (citations.length) send('citations', { citations: citations.map((c, i) => ({ n: i + 1, ...c })) });

    // 6) Suggested follow-ups.
    if (d.suggestions && visible) {
      const s = await ai.suggestFollowUps(d.message, visible);
      if (s.length) send('suggestions', { suggestions: s });
    }

    clearInterval(beat);
    send('done', {
      tokens, latencyMs: latency, ok: true,
      toolCalls: result.toolCalls?.length || 0,
      artifacts: madeArtifacts.length,
      citations: citations.length,
      hadThinking: !!result.thinking
    });
    res.end();
  })
);

// ─── TOKEN COUNTING ───
router.post('/count-tokens', A.authenticate,
  body({ text: V.string({ max: 500_000 }), messages: V.array({ max: 200 }), model: V.enum(['blaze', 'nova', 'ember'], { default: 'blaze' }) }),
  wrap(async (req, res) => {
    let total = 0;
    if (req.data.text) total += ai.estimateTokens(req.data.text);
    for (const m of req.data.messages || []) total += ai.estimateTokens(m?.content || '');
    const model = ai.resolveModel(req.data.model);
    res.json({
      success: true,
      data: {
        tokens: total, model: model.id, contextWindow: model.contextWindow,
        remaining: Math.max(0, model.contextWindow - total),
        withinLimit: total < model.contextWindow,
        note: 'Approximate (~4 chars/token).'
      }
    });
  })
);

// ─── NON-STREAMING COMPLETION (handy for API-key clients) ───
router.post('/completions', chatLimit, A.authenticate, A.enforceQuota,
  body({
    message: V.string({ required: true, min: 1, max: 100000 }),
    model: V.enum(['blaze', 'nova', 'ember'], { default: 'blaze' }),
    history: V.array({ max: 100 })
  }),
  wrap(async (req, res) => {
    const started = Date.now();
    const messages = ai.buildContext({
      user: req.user, conversation: { model: req.data.model },
      history: req.data.history || [], message: req.data.message
    });
    let text;
    try { text = await ai.complete(messages, { model: req.data.model }); }
    catch (e) { throw err.upstream('The AI provider is temporarily unavailable. Please try again.'); }

    const tokens = ai.estimateTokens(text);
    const latency = Date.now() - started;
    db.prepare('INSERT INTO usage_events (id, user_id, kind, model, tokens, latency_ms) VALUES (?,?,?,?,?,?)')
      .run(uuid(), req.user.id, 'completion', req.data.model, tokens, latency);
    db.prepare('UPDATE users SET usage_today = usage_today + 1, total_tokens = total_tokens + ? WHERE id = ?')
      .run(tokens, req.user.id);

    res.json({ success: true, data: { content: text, model: req.data.model, tokens, latencyMs: latency } });
  })
);

// ─── TITLE SUGGESTION ───
router.post('/title', A.authenticate, body({ message: V.string({ required: true, max: 4000 }), conversationId: V.string({ max: 64 }) }),
  wrap(async (req, res) => {
    const title = await ai.generateTitle(req.data.message);
    if (req.data.conversationId) {
      db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?')
        .run(title, req.data.conversationId, req.user.id);
    }
    res.json({ success: true, data: { title } });
  })
);

// ─── REGENERATE LAST ASSISTANT REPLY ───
router.post('/regenerate', chatLimit, A.authenticate, A.enforceQuota,
  body({ conversationId: V.string({ required: true, max: 64 }), model: V.enum(['blaze', 'nova', 'ember']) }),
  wrap(async (req, res) => {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(req.data.conversationId, req.user.id);
    if (!conv) throw err.notFound('Conversation not found');

    const last = db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND role = 'assistant' AND is_deleted = 0
                             ORDER BY created_at DESC LIMIT 1`).get(conv.id);
    if (last) {
      db.prepare('UPDATE messages SET is_deleted = 1 WHERE id = ?').run(last.id);
      db.fts.remove(last.id);
      db.prepare('UPDATE conversations SET message_count = MAX(message_count - 1, 0) WHERE id = ?').run(conv.id);
    }
    const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id = ? AND is_deleted = 0 ORDER BY created_at')
      .all(conv.id);
    const lastUser = [...history].reverse().find(m => m.role === 'user');
    if (!lastUser) throw err.badRequest('Nothing to regenerate');

    const model = req.data.model || conv.model;
    const messages = ai.buildContext({ user: req.user, conversation: conv, history: history.slice(0, -1), message: lastUser.content });
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    await ai.streamCompletion(res, messages, {
      model, signal: controller.signal,
      onFinish: ({ text, tokens, latencyMs, ok }) => {
        if (ok && text) {
          const aid = uuid();
          db.prepare(`INSERT INTO messages (id, conversation_id, role, content, model, tokens, latency_ms)
                      VALUES (?,?,?,?,?,?,?)`).run(aid, conv.id, 'assistant', text, model, tokens, latencyMs);
          db.fts.index({ id: aid, conversation_id: conv.id, content: text });
          db.prepare("UPDATE conversations SET message_count = message_count + 1, last_message_at = datetime('now') WHERE id = ?").run(conv.id);
        }
      }
    });
  })
);

module.exports = router;
