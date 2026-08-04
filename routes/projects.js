const router = require('express').Router();
const { v4: uuid } = require('uuid');
const db = require('../db');
const { err, wrap } = require('../lib/errors');
const { V, body, query } = require('../lib/validate');
const A = require('../lib/auth');

router.use(A.authenticate);

const mustOwn = (id, uid) => {
  const p = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?').get(id, uid);
  if (!p) throw err.notFound('Project not found');
  return p;
};

router.get('/', query({ archived: V.bool() }), wrap(async (req, res) => {
  const rows = db.prepare(`SELECT * FROM projects WHERE user_id = ? AND is_archived = ?
                           ORDER BY updated_at DESC`).all(req.user.id, req.q.archived ? 1 : 0);
  const projects = rows.map(p => ({
    ...p,
    conversationCount: db.prepare('SELECT COUNT(*) c FROM conversations WHERE project_id = ? AND is_deleted = 0').get(p.id).c
  }));
  res.json({ success: true, data: { projects } });
}));

router.post('/',
  body({
    name: V.string({ required: true, min: 1, max: 80 }),
    description: V.string({ max: 500 }),
    system_prompt: V.string({ max: 4000 }),
    color: V.color(), icon: V.string({ max: 20 })
  }),
  wrap(async (req, res) => {
    const limit = A.planOf(req.user).maxProjects;
    const count = db.prepare('SELECT COUNT(*) c FROM projects WHERE user_id = ?').get(req.user.id).c;
    if (count >= limit) throw err.forbidden(`Your plan allows up to ${limit} projects.`);

    const id = uuid();
    db.prepare(`INSERT INTO projects (id, user_id, name, description, system_prompt, color, icon)
                VALUES (?,?,?,?,?,?,?)`)
      .run(id, req.user.id, req.data.name, req.data.description || null, req.data.system_prompt || null,
           req.data.color || '#8ba4ff', req.data.icon || null);
    res.status(201).json({ success: true, data: { project: db.prepare('SELECT * FROM projects WHERE id = ?').get(id) } });
  })
);

router.get('/:id', wrap(async (req, res) => {
  const p = mustOwn(req.params.id, req.user.id);
  const conversations = db.prepare(`SELECT id, title, model, message_count, last_message_at, created_at
                                    FROM conversations WHERE project_id = ? AND is_deleted = 0
                                    ORDER BY COALESCE(last_message_at, created_at) DESC`).all(p.id);
  res.json({ success: true, data: { project: p, conversations } });
}));

router.patch('/:id',
  body({
    name: V.string({ min: 1, max: 80 }), description: V.string({ max: 500 }),
    system_prompt: V.string({ max: 4000 }), color: V.color(), icon: V.string({ max: 20 }), is_archived: V.bool()
  }),
  wrap(async (req, res) => {
    mustOwn(req.params.id, req.user.id);
    const sets = [], vals = [];
    for (const k of ['name', 'description', 'system_prompt', 'color', 'icon']) {
      if (req.data[k] !== undefined) { sets.push(`${k} = ?`); vals.push(req.data[k]); }
    }
    if (req.data.is_archived !== undefined) { sets.push('is_archived = ?'); vals.push(req.data.is_archived ? 1 : 0); }
    if (!sets.length) throw err.badRequest('No fields to update');
    sets.push("updated_at = datetime('now')");
    vals.push(req.params.id);
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    res.json({ success: true, data: { project: db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id) } });
  })
);

router.delete('/:id', query({ withConversations: V.bool() }), wrap(async (req, res) => {
  const p = mustOwn(req.params.id, req.user.id);
  if (req.q.withConversations) {
    db.prepare("UPDATE conversations SET is_deleted = 1, deleted_at = datetime('now') WHERE project_id = ?").run(p.id);
  }
  db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
  res.json({ success: true, data: { message: 'Project deleted' } });
}));

module.exports = router;
