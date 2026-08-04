const vm = require('vm');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { v4: uuid } = require('uuid');
const db = require('../db');

// ═══════════════════════════════════════════
//   TOOL REGISTRY — capabilities the model
//   can invoke mid-answer (the agentic loop)
// ═══════════════════════════════════════════

const BLOCKED_HOSTS = /^(localhost|127\.|0\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1|\[)/i;

function safeFetch(target, { timeout = 8000, maxBytes = 400_000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(target); } catch { return reject(new Error('Invalid URL')); }
    if (!/^https?:$/.test(url.protocol)) return reject(new Error('Only http(s) URLs are allowed'));
    // Block SSRF against internal networks.
    if (BLOCKED_HOSTS.test(url.hostname)) return reject(new Error('That host is not permitted'));

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, {
      timeout,
      headers: { 'User-Agent': 'PhonixAI/3.0 (+bot)', 'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8' }
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return safeFetch(new URL(res.headers.location, url).href, { timeout, maxBytes }).then(resolve, reject);
      }
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let data = '', size = 0;
      res.setEncoding('utf8');
      res.on('data', c => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); return; }
        data += c;
      });
      res.on('end', () => resolve({ body: data, contentType: res.headers['content-type'] || '', url: url.href }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', e => reject(new Error(e.message)));
  });
}

// Strip HTML down to readable text.
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

const TOOLS = {
  // ─── Deterministic maths (models are unreliable at arithmetic) ───
  calculator: {
    description: 'Evaluate a mathematical expression precisely. Supports + - * / % ** ( ), and Math functions.',
    parameters: { expression: 'string — e.g. "(1234*5.5)/3" or "Math.sqrt(2)"' },
    safe: true,
    async run({ expression }) {
      if (typeof expression !== 'string' || !expression.trim()) throw new Error('expression is required');
      if (!/^[\d\s+\-*/%.,()e]|Math\./i.test(expression)) throw new Error('Unsupported expression');
      if (/[a-z_$]/i.test(expression.replace(/Math\.\w+/g, ''))) throw new Error('Only numbers and Math.* are allowed');
      const ctx = vm.createContext({ Math });
      const result = new vm.Script(`(${expression})`).runInContext(ctx, { timeout: 500 });
      if (typeof result !== 'number' || !isFinite(result)) throw new Error('Expression did not produce a finite number');
      return { expression, result };
    }
  },

  // ─── Sandboxed JavaScript execution ───
  run_javascript: {
    description: 'Execute a short JavaScript snippet in a sandbox and return its console output and return value. No network or filesystem.',
    parameters: { code: 'string — JS source. Use return or console.log for output.' },
    safe: true,
    async run({ code }) {
      if (typeof code !== 'string' || !code.trim()) throw new Error('code is required');
      if (code.length > 10_000) throw new Error('Code is too long (10k max)');
      const logs = [];
      const sandbox = {
        console: { log: (...a) => logs.push(a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')) },
        Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Map, Set, isNaN, parseInt, parseFloat
      };
      const ctx = vm.createContext(sandbox);
      let value;
      try {
        value = new vm.Script(`(function(){ ${code} })()`).runInContext(ctx, { timeout: 2000 });
      } catch (e) {
        return { ok: false, error: e.message, logs };
      }
      return { ok: true, returnValue: value === undefined ? null : JSON.parse(JSON.stringify(value ?? null)), logs };
    }
  },

  // ─── Read a web page ───
  fetch_url: {
    description: 'Fetch a public web page or JSON API and return its readable text content. Use for looking up current information.',
    parameters: { url: 'string — absolute http(s) URL' },
    safe: false,
    async run({ url }) {
      const { body, contentType, url: finalUrl } = await safeFetch(url);
      if (/json/.test(contentType)) {
        try { return { url: finalUrl, type: 'json', data: JSON.parse(body) }; } catch {}
      }
      const text = /html/.test(contentType) ? htmlToText(body) : body;
      const title = (body.match(/<title[^>]*>([^<]+)</i) || [])[1]?.trim();
      return { url: finalUrl, type: 'text', title: title || finalUrl, content: text.slice(0, 8000), truncated: text.length > 8000 };
    }
  },

  // ─── Search the user's own knowledge base ───
  search_knowledge: {
    description: "Search the user's uploaded knowledge base for relevant passages. Use before answering questions about their documents.",
    parameters: { query: 'string — what to look for', projectId: 'string (optional) — restrict to a project' },
    safe: true,
    async run({ query, projectId }, ctx) {
      const rag = require('./rag');
      const hits = rag.search({ userId: ctx.userId, projectId, query, limit: 5 });
      return {
        query,
        results: hits.map((h, i) => ({ n: i + 1, title: h.title, excerpt: h.content.slice(0, 700), score: Number(h.score.toFixed(3)) })),
        found: hits.length
      };
    }
  },

  // ─── Search past conversations ───
  search_conversations: {
    description: "Search the user's previous conversations for something discussed earlier.",
    parameters: { query: 'string' },
    safe: true,
    async run({ query }, ctx) {
      const rows = db.prepare(`
        SELECT m.content, c.title, m.created_at FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE c.user_id = ? AND m.is_deleted = 0 AND c.is_deleted = 0 AND m.content LIKE ?
        ORDER BY m.created_at DESC LIMIT 5`).all(ctx.userId, `%${query}%`);
      return { query, results: rows.map(r => ({ conversation: r.title, excerpt: r.content.slice(0, 400), date: r.created_at })) };
    }
  },

  // ─── Persist a durable fact ───
  remember: {
    description: 'Save a durable fact or preference about the user so it persists across future conversations.',
    parameters: { key: 'string — short label', value: 'string — the fact', type: 'PREFERENCE|FACT|CONTEXT|INSTRUCTION' },
    safe: true,
    async run({ key, value, type }, ctx) {
      if (!key || !value) throw new Error('key and value are required');
      const t = ['PREFERENCE', 'FACT', 'CONTEXT', 'INSTRUCTION'].includes(type) ? type : 'FACT';
      db.prepare(`INSERT INTO memories (id, user_id, type, key, value, source, updated_at)
                  VALUES (?,?,?,?,?, 'tool', datetime('now'))
                  ON CONFLICT(user_id, type, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
        .run(uuid(), ctx.userId, t, String(key).slice(0, 120), String(value).slice(0, 2000));
      return { saved: true, key, value, type: t };
    }
  },

  // ─── Current date/time ───
  current_datetime: {
    description: 'Get the current date and time. Use when the answer depends on today\'s date.',
    parameters: { timezone: 'string (optional) — IANA zone, e.g. Asia/Kolkata' },
    safe: true,
    async run({ timezone }) {
      const now = new Date();
      let local = now.toISOString();
      try { if (timezone) local = now.toLocaleString('en-GB', { timeZone: timezone }); } catch {}
      return { iso: now.toISOString(), local, timezone: timezone || 'UTC', unix: Math.floor(now / 1000) };
    }
  },

  // ─── Create/update an artifact ───
  create_artifact: {
    description: 'Create or update a standalone document, code file, or component that the user can keep and iterate on.',
    parameters: {
      identifier: 'string — stable slug, reuse to update',
      title: 'string', type: 'text/markdown | application/code | text/html',
      language: 'string (optional) — for code', content: 'string — full content'
    },
    safe: true,
    async run({ identifier, title, type, language, content }, ctx) {
      if (!identifier || !content) throw new Error('identifier and content are required');
      const artifacts = require('./artifacts');
      const a = artifacts.upsert({
        userId: ctx.userId, conversationId: ctx.conversationId,
        identifier, title: title || identifier, type, language, content
      });
      return { id: a.id, identifier: a.identifier, title: a.title, version: a.version, action: a.created ? 'created' : 'updated' };
    }
  }
};

// Describe tools to the model in a compact, parseable form.
function toolsPrompt(names = Object.keys(TOOLS)) {
  const list = names.filter(n => TOOLS[n]).map(n => {
    const t = TOOLS[n];
    const params = Object.entries(t.parameters).map(([k, v]) => `    "${k}": ${v}`).join('\n');
    return `- ${n}: ${t.description}\n  parameters:\n${params}`;
  }).join('\n');

  return `You have access to tools. When a tool would give a better answer than guessing, respond with ONLY this JSON on its own line and nothing else:

{"tool":"<tool_name>","input":{...}}

Available tools:
${list}

Rules:
- Use a tool when it improves accuracy (maths, current data, the user's documents, saving facts, producing a document).
- After you receive the tool result, continue and give the user a natural-language answer.
- Never invent tool results. Never call more than one tool per turn.
- If no tool is needed, just answer normally.`;
}

/** Detect a tool call in model output. Returns {tool, input} or null. */
function parseToolCall(text) {
  if (!text) return null;
  const trimmed = text.trim();
  // Accept bare JSON or a fenced json block.
  const candidates = [];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());
  if (trimmed.startsWith('{')) candidates.push(trimmed);
  const inline = trimmed.match(/\{\s*"tool"\s*:[\s\S]*?\}\s*\}?/);
  if (inline) candidates.push(inline[0]);

  for (const c of candidates) {
    try {
      const o = JSON.parse(c);
      if (o && typeof o.tool === 'string' && TOOLS[o.tool]) {
        return { tool: o.tool, input: o.input && typeof o.input === 'object' ? o.input : {} };
      }
    } catch {}
  }
  return null;
}

/** Execute a tool with logging and hard error containment. */
async function execute(name, input, ctx = {}) {
  const tool = TOOLS[name];
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const started = Date.now();
  let output, ok = true, error = null;
  try {
    output = await tool.run(input || {}, ctx);
  } catch (e) {
    ok = false; error = e.message; output = { error: e.message };
  }
  const duration = Date.now() - started;
  try {
    db.prepare(`INSERT INTO tool_calls (id, user_id, conversation_id, tool, input, output, ok, error, duration_ms)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(uuid(), ctx.userId || null, ctx.conversationId || null, name,
           JSON.stringify(input || {}).slice(0, 4000), JSON.stringify(output).slice(0, 8000),
           ok ? 1 : 0, error, duration);
  } catch {}
  return { ok, output, error, durationMs: duration };
}

const listTools = () => Object.entries(TOOLS).map(([name, t]) => ({
  name, description: t.description, parameters: t.parameters, requiresNetwork: !t.safe
}));

module.exports = { TOOLS, toolsPrompt, parseToolCall, execute, listTools, safeFetch, htmlToText };
