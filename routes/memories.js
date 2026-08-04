const router = require('express').Router();
const { v4: uuid } = require('uuid');
const db = require('../db');
const { err, wrap } = require('../lib/errors');
const { V, body, query } = require('../lib/validate');
const A = require('../lib/auth');

router.use(A.authenticate);

const TYPES = ['PREFERENCE', 'FACT', 'CONTEXT', 'INSTRUCTION'];

router.get('/', query({ type: V.enum(TYPES), includeInactive: V.bool() }), wrap(async (req, res) => {
  const params = [req.user.id];
  let sql = 'SELECT * FROM memories WHERE user_id = ?';
  if (!req.q.includeInactive) sql += ' AND is_active = 1';
  if (req.q.type) { sql += ' AND type = ?'; params.push(req.q.type); }
  sql += ' ORDER BY COALESCE(updated_at, created_at) DESC';
  res.json({ success: true, data: { memories: db.prepare(sql).all(...params) } });
}));

router.post('/',
  body({
    key: V.string({ required: true, min: 1, max: 120 }),
    value: V.string({ required: true, min: 1, max: 2000 }),
    type: V.enum(TYPES, { default: 'FACT' })
  }),
  wrap(async (req, res) => {
    const { key, value, type } = req.data;
    db.prepare(`INSERT INTO memories (id, user_id, type, key, value, source, updated_at)
                VALUES (?,?,?,?,?, 'manual', datetime('now'))
                ON CONFLICT(user_id, type, key) DO UPDATE SET value = excluded.value,
                is_active = 1, updated_at = datetime('now')`)
      .run(uuid(), req.user.id, type, key, value);
    const memory = db.prepare('SELECT * FROM memories WHERE user_id = ? AND type = ? AND key = ?').get(req.user.id, type, key);
    res.status(201).json({ success: true, data: { memory } });
  })
);

router.patch('/:id',
  body({ value: V.string({ max: 2000 }), key: V.string({ max: 120 }), is_active: V.bool() }),
  wrap(async (req, res) => {
    const m = db.prepare('SELECT * FROM memories WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!m) throw err.notFound('Memory not found');
    const sets = [], vals = [];
    for (const k of ['key', 'value']) if (req.data[k] !== undefined) { sets.push(`${k} = ?`); vals.push(req.data[k]); }
    if (req.data.is_active !== undefined) { sets.push('is_active = ?'); vals.push(req.data.is_active ? 1 : 0); }
    if (!sets.length) throw err.badRequest('No fields to update');
    sets.push("updated_at = datetime('now')");
    vals.push(req.params.id);
    db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    res.json({ success: true, data: { memory: db.prepare('SELECT * FROM memories WHERE id = ?').get(req.params.id) } });
  })
);

router.delete('/:id', wrap(async (req, res) => {
  const r = db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!r.changes) throw err.notFound('Memory not found');
  res.json({ success: true, data: { message: 'Memory deleted' } });
}));

router.delete('/', wrap(async (req, res) => {
  const r = db.prepare('DELETE FROM memories WHERE user_id = ?').run(req.user.id);
  A.audit(req.user.id, 'memories.clear', req.user.id, req);
  res.json({ success: true, data: { deleted: r.changes } });
}));

module.exports = router;
