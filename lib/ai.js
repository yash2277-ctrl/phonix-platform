const db = require('../db');

// ═══════════════════════════════════════════
//   AI ENGINE — model registry, context
//   assembly, streaming, graceful fallback
// ═══════════════════════════════════════════

let g4f = null;
try { const { G4F } = require('g4f'); g4f = new G4F(); }
catch (e) { console.warn('⚠  g4f unavailable:', e.message); }

const MODELS = {
  blaze: { id: 'blaze', name: 'PHØNIX Blaze', upstream: 'gpt-4',         contextWindow: 8192,  description: 'Fast and capable for everyday work', plans: ['FREE','PRO','ENTERPRISE'] },
  nova:  { id: 'nova',  name: 'PHØNIX Nova',  upstream: 'gpt-4',         contextWindow: 8192,  description: 'Advanced reasoning and analysis',    plans: ['PRO','ENTERPRISE'] },
  ember: { id: 'ember', name: 'PHØNIX Ember', upstream: 'gpt-3.5-turbo', contextWindow: 4096,  description: 'Quick, lightweight responses',       plans: ['FREE','PRO','ENTERPRISE'] }
};
const resolveModel = m => MODELS[m] || MODELS.blaze;

const BASE_PROMPT = `You are PHØNIX AI — an intelligent, versatile assistant. You are warm, direct, and precise.
Use markdown: fenced code blocks with language tags, tables, headings, lists, and blockquotes where they aid clarity.
Write clean, production-quality code. Be concise but complete; prefer substance over filler.
If you are unsure, say so plainly rather than inventing details. Never fabricate facts, citations, or quotes.`;

const THINKING_PROMPT = `Before answering anything non-trivial, reason privately inside <thinking>...</thinking> tags:
break the problem down, consider approaches, check your own assumptions and arithmetic.
Then give the final answer AFTER the closing tag. Keep the thinking genuinely useful, not performative.`;

// Rough token estimate (~4 chars/token) — good enough for budgeting and usage stats.
const estimateTokens = text => Math.max(1, Math.ceil((text || '').length / 4));

/**
 * Assemble the full message list: system prompt (+ user instructions, memories,
 * project/conversation prompt) followed by history trimmed to the context window.
 */
function buildContext({ user, conversation, history = [], message, attachments = [],
                       thinking = false, tools = null, artifactsEnabled = false, grounding = null }) {
  const safety = require('./safety');
  const parts = [BASE_PROMPT, safety.SAFETY_PROMPT];

  if (thinking) parts.push(THINKING_PROMPT);
  if (artifactsEnabled) parts.push(require('./artifacts').ARTIFACT_PROMPT);
  if (tools && tools.length) parts.push(require('./tools').toolsPrompt(tools));
  // Retrieved passages are untrusted input — mark them as data, not instructions.
  if (grounding?.text) parts.push(safety.sanitizeUntrusted(grounding.text, 'knowledge base').text);

  if (user?.custom_instructions) {
    parts.push(`The user's standing instructions:\n${String(user.custom_instructions).slice(0, 2000)}`);
  }

  if (user?.id) {
    const memories = db.prepare(
      'SELECT type, key, value FROM memories WHERE user_id = ? AND is_active = 1 ORDER BY updated_at DESC, created_at DESC LIMIT 40'
    ).all(user.id);
    if (memories.length) {
      parts.push('Known context about this user (use naturally; do not recite):\n' +
        memories.map(m => `- [${m.type}] ${m.key}: ${m.value}`).join('\n'));
    }
  }

  if (conversation?.project_id) {
    const proj = db.prepare('SELECT name, system_prompt FROM projects WHERE id = ?').get(conversation.project_id);
    if (proj?.system_prompt) parts.push(`Project "${proj.name}" instructions:\n${proj.system_prompt}`);
  }
  if (conversation?.system_prompt) parts.push(conversation.system_prompt);

  if (attachments.length) {
    const files = attachments
      .filter(a => a.extracted_text)
      .map(a => `--- File: ${a.filename} ---\n${String(a.extracted_text).slice(0, 12000)}`)
      .join('\n\n');
    if (files) parts.push(safety.sanitizeUntrusted(files, 'attached files').text);
  }

  const system = parts.join('\n\n');
  const model = resolveModel(conversation?.model);
  // Reserve room for the reply.
  let budget = model.contextWindow - estimateTokens(system) - 700;

  const clean = history
    .filter(m => m && typeof m.content === 'string' && ['user', 'assistant'].includes(m.role))
    .map(m => ({ role: m.role, content: m.content }));

  // Keep the most recent turns that fit.
  const kept = [];
  for (let i = clean.length - 1; i >= 0; i--) {
    const cost = estimateTokens(clean[i].content);
    if (cost > budget) break;
    budget -= cost;
    kept.unshift(clean[i]);
  }

  const messages = [{ role: 'system', content: system }, ...kept];
  const last = messages[messages.length - 1];
  if (message && (!last || last.role !== 'user' || last.content !== message)) {
    messages.push({ role: 'user', content: message });
  }
  return messages;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Call the provider with retries. Returns the full completion text. */
async function complete(messages, { model = 'blaze', retries = 2 } = {}) {
  if (!g4f) throw new Error('No AI provider configured');
  const upstream = resolveModel(model).upstream;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await g4f.chatCompletion(messages, { model: upstream });
      const text = typeof res === 'string' ? res : (res?.content || (res != null ? String(res) : ''));
      if (text && text.trim()) return text;
      lastErr = new Error('Empty response from provider');
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) await sleep(400 * Math.pow(2, attempt));
  }
  throw lastErr || new Error('AI provider failed');
}

/**
 * Stream a completion as Server-Sent Events.
 * Emits: meta → delta* → done  (or error). Falls back to a helpful message
 * so the client never hangs on a broken provider.
 */
async function streamCompletion(res, messages, { model = 'blaze', onFinish, signal } = {}) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const started = Date.now();
  const m = resolveModel(model);
  send('meta', { model: m.id, name: m.name, startedAt: new Date().toISOString() });

  // Heartbeat keeps proxies from closing an idle connection.
  const beat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);

  let full = '';
  let ok = true;
  try {
    const text = await complete(messages, { model });
    // Chunk into word-ish slices for a natural typing cadence.
    const chunks = text.match(/[\s\S]{1,42}/g) || [];
    for (const c of chunks) {
      if (signal?.aborted || res.writableEnded) break;
      full += c;
      send('delta', { text: c });
      await sleep(8);
    }
  } catch (e) {
    ok = false;
    console.error('AI stream error:', e.message);
    full = "I couldn't reach the AI provider just now. This usually clears up in a moment — please try again.";
    send('delta', { text: full });
    send('error', { code: 'UPSTREAM_ERROR', message: e.message });
  } finally {
    clearInterval(beat);
    const latency = Date.now() - started;
    send('done', { tokens: estimateTokens(full), latencyMs: latency, ok });
    if (!res.writableEnded) res.end();
    try { onFinish?.({ text: full, tokens: estimateTokens(full), latencyMs: latency, ok }); }
    catch (e) { console.error('onFinish hook failed:', e); }
  }
  return full;
}

/** Split a reply into its private reasoning and the user-facing answer. */
function splitThinking(text) {
  const m = String(text || '').match(/<thinking>([\s\S]*?)<\/thinking>/i);
  if (!m) return { thinking: null, answer: text };
  return { thinking: m[1].trim(), answer: text.replace(m[0], '').trim() };
}

/**
 * Agentic loop: let the model call tools, feed results back, repeat.
 * `emit(event, data)` streams progress (tool_use / tool_result / thinking).
 * Returns { text, toolCalls, citations }.
 */
async function runAgent({ messages, model = 'blaze', maxSteps = 4, ctx = {}, emit = () => {} }) {
  const tools = require('./tools');
  const safety = require('./safety');
  const convo = [...messages];
  const toolCalls = [];
  const citations = [];

  for (let step = 0; step < maxSteps; step++) {
    const raw = await complete(convo, { model });
    const call = tools.parseToolCall(raw);

    if (!call) {
      const { thinking, answer } = splitThinking(raw);
      if (thinking) emit('thinking', { text: thinking });
      return { text: answer || raw, thinking, toolCalls, citations };
    }

    emit('tool_use', { tool: call.tool, input: call.input, step: step + 1 });
    const result = await tools.execute(call.tool, call.input, ctx);
    toolCalls.push({ tool: call.tool, input: call.input, ok: result.ok, durationMs: result.durationMs });
    emit('tool_result', { tool: call.tool, ok: result.ok, durationMs: result.durationMs, error: result.error });

    // Turn retrieved sources into citations.
    if (call.tool === 'search_knowledge' && result.output?.results) {
      for (const r of result.output.results) {
        citations.push({ type: 'knowledge', title: r.title, excerpt: r.excerpt });
      }
    }
    if (call.tool === 'fetch_url' && result.ok) {
      citations.push({ type: 'web', title: result.output.title, url: result.output.url, excerpt: (result.output.content || '').slice(0, 300) });
    }

    // Tool output is untrusted — never let it act as an instruction.
    const payload = JSON.stringify(result.output).slice(0, 12_000);
    convo.push({ role: 'assistant', content: JSON.stringify({ tool: call.tool, input: call.input }) });
    convo.push({ role: 'user', content: safety.sanitizeUntrusted(`Result of ${call.tool}:\n${payload}`, 'tool result').text +
      '\n\nNow answer the original question using this result. Do not call another tool unless essential.' });
  }

  // Ran out of steps — ask for a final answer with what we have.
  convo.push({ role: 'user', content: 'Give your best final answer now, without calling any more tools.' });
  const final = await complete(convo, { model });
  const { thinking, answer } = splitThinking(final);
  return { text: answer || final, thinking, toolCalls, citations };
}

/** Propose natural follow-up questions after an exchange. */
async function suggestFollowUps(userMessage, assistantReply) {
  try {
    const out = await complete([
      { role: 'system', content: 'Given an exchange, propose 3 short follow-up questions the user might naturally ask next. Reply with ONLY a JSON array of strings, max 9 words each.' },
      { role: 'user', content: `User asked: ${userMessage.slice(0, 500)}\n\nAssistant replied: ${assistantReply.slice(0, 900)}` }
    ], { model: 'ember', retries: 0 });
    const m = out.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(m ? m[0] : out);
    return Array.isArray(arr) ? arr.filter(s => typeof s === 'string').slice(0, 3) : [];
  } catch { return []; }
}

/** Ask for a short conversation title; falls back to a truncation. */
async function generateTitle(firstMessage) {
  const fallback = firstMessage.slice(0, 48).trim() + (firstMessage.length > 48 ? '…' : '');
  try {
    const out = await complete([
      { role: 'system', content: 'Reply with a concise 3-6 word title for the conversation. No quotes, no punctuation at the end.' },
      { role: 'user', content: firstMessage.slice(0, 600) }
    ], { model: 'ember', retries: 0 });
    const title = out.replace(/^["'\s]+|["'\s.]+$/g, '').split('\n')[0].slice(0, 60);
    return title.length >= 3 ? title : fallback;
  } catch {
    return fallback;
  }
}

/** Heuristically extract durable facts the user states about themselves. */
function extractMemories(text) {
  const found = [];
  // Conservative: never run past a conjunction or punctuation, so we capture the
  // fact itself rather than the rest of the sentence.
  const NEXT = c => `(?:\\s+(?!and\\b|but\\b|so\\b|because\\b|then\\b|while\\b|which\\b)[${c}]+)`;
  const patterns = [
    [/\b[Mm]y name is ([A-Z][a-z]+(?: [A-Z][a-z]+)?)/, 'name', 'FACT'],
    [new RegExp(`\\bi(?:'m| am) (?:a|an) ([\\w\\-/]+${NEXT('\\w\\-/')}{0,3})`, 'i'), 'role', 'FACT'],
    [new RegExp(`\\bi work (?:at|for) ([\\w\\-.&]+${NEXT('\\w\\-.&')}{0,3})`, 'i'), 'employer', 'FACT'],
    [new RegExp(`\\bi prefer ([\\w\\-]+${NEXT('\\w\\-')}{0,5})`, 'i'), 'preference', 'PREFERENCE'],
    [new RegExp(`\\bi use ([\\w\\-.+#]+${NEXT('\\w\\-.+#')}{0,4})`, 'i'), 'stack', 'CONTEXT'],
    [new RegExp(`\\balways ([\\w\\-]+${NEXT('\\w\\-')}{0,6})`, 'i'), 'instruction', 'INSTRUCTION']
  ];
  for (const [re, key, type] of patterns) {
    const m = text.match(re);
    if (m && m[1]) found.push({ type, key, value: m[1].trim().replace(/[.,!?]$/, '').slice(0, 200) });
  }
  return found;
}

module.exports = {
  MODELS, resolveModel, BASE_PROMPT, THINKING_PROMPT,
  buildContext, complete, streamCompletion,
  runAgent, splitThinking, suggestFollowUps,
  generateTitle, estimateTokens, extractMemories,
  isAvailable: () => !!g4f
};
