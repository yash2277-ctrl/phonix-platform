const router = require('express').Router();
const { v4: uuid } = require('uuid');
const db = require('../db');
const { err, wrap } = require('../lib/errors');
const { V, body, query } = require('../lib/validate');
const A = require('../lib/auth');

router.use(A.authenticate);

// Starter library offered to every new account.
const STARTERS = [
  { title: 'Explain like I\'m five', body: 'Explain the following in simple terms with a concrete analogy:\n\n', category: 'learning' },
  { title: 'Code review', body: 'Review this code for bugs, readability, and performance. Give specific, actionable suggestions:\n\n', category: 'code' },
  { title: 'Write tests', body: 'Write thorough unit tests for the following code, covering edge cases:\n\n', category: 'code' },
  { title: 'Summarise', body: 'Summarise the key points below in a short bulleted list:\n\n', category: 'writing' },
  { title: 'Make it sharper', body: 'Tighten this writing. Keep my voice, cut filler, improve flow:\n\n', category: 'writing' }
];

router.get('/', query({ category: V.string({ max: 40 }), favorite: V.bool() }), wrap(async (req, res) => {
  const params = [req.user.id];
  let sql = 'SELECT * FROM prompts WHERE user_id = ?';
  if (req.q.category) { sql += ' AND category = ?'; params.push(req.q.category); }
  if (req.q.favorite) sql += ' AND is_favorite = 1';
  sql += ' ORDER BY is_favorite DESC, use_count DESC, created_at DESC';
  const prompts = db.prepare(sql).all(...params);
  const categories = db.prepare('SELECT DISTINCT category FROM prompts WHERE user_id = ?').all(req.user.id).map(r => r.category);
  res.json({ success: true, data: { prompts, categories } });
}));

router.post('/',
  body({
    title: V.string({ required: true, min: 1, max: 120 }),
    body: V.string({ required: true, min: 1, max: 8000 }),
    description: V.string({ max: 300 }), category: V.string({ max: 40, default: 'general' })
  }),
  wrap(async (req, res) => {
    const id = uuid();
    db.prepare('INSERT INTO prompts (id, user_id, title, body, description, category) VALUES (?,?,?,?,?,?)')
      .run(id, req.user.id, req.data.title, req.data.body, req.data.description || null, req.data.category);
    res.status(201).json({ success: true, data: { prompt: db.prepare('SELECT * FROM prompts WHERE id = ?').get(id) } });
  })
);

router.post('/seed', wrap(async (req, res) => {
  const ins = db.prepare('INSERT INTO prompts (id, user_id, title, body, category) VALUES (?,?,?,?,?)');
  let added = 0;
  db.transaction(() => {
    for (const p of STARTERS) {
      const exists = db.prepare('SELECT id FROM prompts WHERE user_id = ? AND title = ?').get(req.user.id, p.title);
      if (!exists) { ins.run(uuid(), req.user.id, p.title, p.body, p.category); added++; }
    }
  })();
  res.status(201).json({ success: true, data: { added } });
}));

router.patch('/:id',
  body({
    title: V.string({ max: 120 }), body: V.string({ max: 8000 }),
    description: V.string({ max: 300 }), category: V.string({ max: 40 }), is_favorite: V.bool()
  }),
  wrap(async (req, res) => {
    const p = db.prepare('SELECT * FROM prompts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!p) throw err.notFound('Prompt not found');
    const sets = [], vals = [];
    for (const k of ['title', 'body', 'description', 'category']) {
      if (req.data[k] !== undefined) { sets.push(`${k} = ?`); vals.push(req.data[k]); }
    }
    if (req.data.is_favorite !== undefined) { sets.push('is_favorite = ?'); vals.push(req.data.is_favorite ? 1 : 0); }
    if (!sets.length) throw err.badRequest('No fields to update');
    sets.push("updated_at = datetime('now')");
    vals.push(req.params.id);
    db.prepare(`UPDATE prompts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    res.json({ success: true, data: { prompt: db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id) } });
  })
);

router.post('/:id/use', wrap(async (req, res) => {
  const p = db.prepare('SELECT * FROM prompts WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!p) throw err.notFound('Prompt not found');
  db.prepare('UPDATE prompts SET use_count = use_count + 1 WHERE id = ?').run(p.id);
  res.json({ success: true, data: { body: p.body, useCount: p.use_count + 1 } });
}));

router.delete('/:id', wrap(async (req, res) => {
  const r = db.prepare('DELETE FROM prompts WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!r.changes) throw err.notFound('Prompt not found');
  res.json({ success: true, data: { message: 'Prompt deleted' } });
}));

module.exports = router;
