const router = require('express').Router();
const { v4: uuid } = require('uuid');
const db = require('../db');
const { err, wrap } = require('../lib/errors');
const { V, body } = require('../lib/validate');
const A = require('../lib/auth');
const ai = require('../lib/ai');

router.use(A.authenticate);

// ─── SUBMIT A BATCH ───
router.post('/',
  body({
    requests: V.array({ required: true, max: 100 }),
    model: V.enum(['blaze', 'nova', 'ember'], { default: 'ember' })
  }),
  wrap(async (req, res) => {
    const items = req.data.requests
      .filter(r => r && typeof r.message === 'string' && r.message.trim())
      .map((r, i) => ({ id: r.id || `req_${i + 1}`, message: r.message.slice(0, 20000) }));
    if (!items.length) throw err.badRequest('Provide at least one request with a message');

    const plan = A.planOf(req.user);
    const used = A.rollUsage(req.user.id);
    if (used + items.length > plan.dailyMessages) {
      throw err.quota(`This batch (${items.length}) would exceed your daily limit of ${plan.dailyMessages}.`, { used, limit: plan.dailyMessages });
    }

    const id = uuid();
    db.prepare('INSERT INTO batches (id, user_id, status, total, model, requests) VALUES (?,?,?,?,?,?)')
      .run(id, req.user.id, 'queued', items.length, req.data.model, JSON.stringify(items));

    // Process in the background so the request returns immediately.
    setImmediate(() => process_(id, req.user, items, req.data.model));

    res.status(202).json({
      success: true,
      data: { batch: { id, status: 'queued', total: items.length }, poll: `/api/v1/batch/${id}` }
    });
  })
);

async function process_(batchId, user, items, model) {
  db.prepare("UPDATE batches SET status = 'running' WHERE id = ?").run(batchId);
  const results = [];
  let done = 0, failed = 0;

  for (const item of items) {
    try {
      const messages = ai.buildContext({ user, conversation: { model }, history: [], message: item.message });
      const text = await ai.complete(messages, { model, retries: 1 });
      results.push({ id: item.id, ok: true, content: text, tokens: ai.estimateTokens(text) });
      done++;
    } catch (e) {
      results.push({ id: item.id, ok: false, error: e.message });
      failed++;
    }
    db.prepare('UPDATE batches SET completed = ?, failed = ?, results = ? WHERE id = ?')
      .run(done, failed, JSON.stringify(results), batchId);
  }

  db.prepare("UPDATE batches SET status = ?, finished_at = datetime('now') WHERE id = ?")
    .run(failed === items.length ? 'failed' : 'completed', batchId);
  db.prepare('UPDATE users SET usage_today = usage_today + ? WHERE id = ?').run(done, user.id);

  try { require('./webhooks').emit(user.id, 'batch.completed', { batchId, total: items.length, completed: done, failed }); } catch {}
}

// ─── STATUS / RESULTS ───
router.get('/', wrap(async (req, res) => {
  const batches = db.prepare(`SELECT id, status, total, completed, failed, model, created_at, finished_at
                              FROM batches WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`).all(req.user.id);
  res.json({ success: true, data: { batches } });
}));

router.get('/:id', wrap(async (req, res) => {
  const b = db.prepare('SELECT * FROM batches WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!b) throw err.notFound('Batch not found');
  res.json({
    success: true,
    data: {
      batch: {
        id: b.id, status: b.status, total: b.total, completed: b.completed, failed: b.failed,
        model: b.model, createdAt: b.created_at, finishedAt: b.finished_at,
        progress: b.total ? Math.round(((b.completed + b.failed) / b.total) * 100) : 0
      },
      results: b.results ? JSON.parse(b.results) : []
    }
  });
}));

router.post('/:id/cancel', wrap(async (req, res) => {
  const b = db.prepare('SELECT * FROM batches WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!b) throw err.notFound('Batch not found');
  if (['completed', 'failed'].includes(b.status)) throw err.badRequest('That batch has already finished');
  db.prepare("UPDATE batches SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?").run(b.id);
  res.json({ success: true, data: { message: 'Batch cancelled' } });
}));

module.exports = router;
