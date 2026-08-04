const router = require('express').Router();
const db = require('../db');
const { wrap } = require('../lib/errors');
const { V, body, query } = require('../lib/validate');
const { rateLimit } = require('../lib/ratelimit');
const A = require('../lib/auth');
const tools = require('../lib/tools');

router.use(A.authenticate);

// ─── DISCOVERY ───
router.get('/', wrap(async (req, res) => {
  res.json({ success: true, data: { tools: tools.listTools() } });
}));

// ─── DIRECT EXECUTION (handy for testing and for API clients) ───
router.post('/:name/execute',
  rateLimit({ windowMs: 60_000, max: 30, message: 'Too many tool calls. Please slow down.' }),
  body({ input: V.object({ default: {} }), conversationId: V.string({ max: 64 }) }),
  wrap(async (req, res) => {
    const result = await tools.execute(req.params.name, req.data.input || {}, {
      userId: req.user.id, conversationId: req.data.conversationId || null
    });
    res.status(result.ok ? 200 : 400).json({
      success: result.ok,
      data: result.ok ? { tool: req.params.name, output: result.output, durationMs: result.durationMs } : undefined,
      error: result.ok ? undefined : { code: 'TOOL_ERROR', message: result.error }
    });
  })
);

// ─── CALL HISTORY ───
router.get('/history',
  query({ conversationId: V.string({ max: 64 }), limit: V.int({ min: 1, max: 200, default: 50 }) }),
  wrap(async (req, res) => {
    const params = [req.user.id];
    let sql = 'SELECT id, tool, input, output, ok, error, duration_ms, created_at FROM tool_calls WHERE user_id = ?';
    if (req.q.conversationId) { sql += ' AND conversation_id = ?'; params.push(req.q.conversationId); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(req.q.limit);

    const calls = db.prepare(sql).all(...params).map(c => ({
      ...c,
      input: (() => { try { return JSON.parse(c.input); } catch { return c.input; } })(),
      output: (() => { try { return JSON.parse(c.output); } catch { return c.output; } })(),
      ok: !!c.ok
    }));
    const stats = db.prepare(`SELECT tool, COUNT(*) calls, SUM(ok) ok, ROUND(AVG(duration_ms)) avgMs
                              FROM tool_calls WHERE user_id = ? GROUP BY tool ORDER BY calls DESC`).all(req.user.id);
    res.json({ success: true, data: { calls, stats } });
  })
);

module.exports = router;
