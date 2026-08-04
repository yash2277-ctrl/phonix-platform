const router = require('express').Router();
const { v4: uuid } = require('uuid');
const db = require('../db');
const { err, wrap } = require('../lib/errors');
const { V, body, query } = require('../lib/validate');
const A = require('../lib/auth');

router.use(A.authenticate);

const own = (id, userId) => db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(id, userId);
function mustOwn(id, userId) {
  const c = own(id, userId);
  if (!c) throw err.notFound('Conversation not found');
  return c;
}
const tagsFor = cid => db.prepare(
  'SELECT t.id, t.name, t.color FROM tags t JOIN conversation_tags ct ON ct.tag_id = t.id WHERE ct.conversation_id = ?'
).all(cid);

// ─── LIST ───
router.get('/',
  query({
    search: V.string({ max: 200 }), projectId: V.string({ max: 64 }), tag: V.string({ max: 60 }),
    archived: V.bool(), pinned: V.bool(), trashed: V.bool(),
    sort: V.enum(['recent', 'created', 'title', 'messages'], { default: 'recent' }),
    limit: V.int({ min: 1, max: 100, default: 50 }), offset: V.int({ min: 0, default: 0 })
  }),
  wrap(async (req, res) => {
    const { search, projectId, tag, archived, pinned, trashed, sort, limit, offset } = req.q;
    const params = [req.user.id];
    let sql = 'SELECT c.* FROM conversations c';
    if (tag) sql += ' JOIN conversation_tags ct ON ct.conversation_id = c.id JOIN tags t ON t.id = ct.tag_id';
    sql += ' WHERE c.user_id = ?';

    sql += trashed ? ' AND c.is_deleted = 1' : ' AND c.is_deleted = 0';
    if (!trashed) sql += archived ? ' AND c.is_archived = 1' : ' AND c.is_archived = 0';
    if (pinned) sql += ' AND c.is_pinned = 1';
    if (projectId) { sql += ' AND c.project_id = ?'; params.push(projectId); }
    if (tag) { sql += ' AND t.name = ?'; params.push(tag); }
    if (search) { sql += ' AND c.title LIKE ?'; params.push(`%${search}%`); }

    const order = {
      recent: ' ORDER BY c.is_pinned DESC, COALESCE(c.last_message_at, c.created_at) DESC',
      created: ' ORDER BY c.is_pinned DESC, c.created_at DESC',
      title: ' ORDER BY c.is_pinned DESC, c.title COLLATE NOCASE ASC',
      messages: ' ORDER BY c.is_pinned DESC, c.message_count DESC'
    }[sort];
    sql += order + ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = db.prepare(sql).all(...params);
    const conversations = rows.map(c => ({
      ...c,
      tags: tagsFor(c.id),
      lastMessage: db.prepare(
        'SELECT role, substr(content,1,160) content FROM messages WHERE conversation_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT 1'
      ).get(c.id) || null
    }));

    const total = db.prepare(
      `SELECT COUNT(*) c FROM conversations WHERE user_id = ? AND is_deleted = ${trashed ? 1 : 0}`
    ).get(req.user.id).c;

    res.json({ success: true, data: { conversations, pagination: { total, limit, offset, hasMore: offset + rows.length < total } } });
  })
);

// ─── CREATE ───
router.post('/',
  body({
    title: V.string({ max: 120 }), model: V.enum(['blaze', 'nova', 'ember'], { default: 'blaze' }),
    system_prompt: V.string({ max: 4000 }), projectId: V.string({ max: 64 }),
    temperature: V.number({ min: 0, max: 2, default: 0.7 })
  }),
  wrap(async (req, res) => {
    const { title, model, system_prompt, projectId, temperature } = req.data;
    if (projectId && !db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, req.user.id)) {
      throw err.notFound('Project not found');
    }
    const id = uuid();
    db.prepare(`INSERT INTO conversations (id, user_id, project_id, title, model, system_prompt, temperature)
                VALUES (?,?,?,?,?,?,?)`)
      .run(id, req.user.id, projectId || null, title || 'New Conversation', model, system_prompt || null, temperature);
    res.status(201).json({ success: true, data: { conversation: db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) } });
  })
);

// ─── READ ───
router.get('/:id', wrap(async (req, res) => {
  const c = mustOwn(req.params.id, req.user.id);
  res.json({ success: true, data: { conversation: { ...c, tags: tagsFor(c.id) } } });
}));

// ─── UPDATE ───
router.patch('/:id',
  body({
    title: V.string({ max: 120 }), model: V.enum(['blaze', 'nova', 'ember']),
    system_prompt: V.string({ max: 4000 }), projectId: V.string({ max: 64 }),
    temperature: V.number({ min: 0, max: 2 }), is_pinned: V.bool(), is_archived: V.bool()
  }),
  wrap(async (req, res) => {
    mustOwn(req.params.id, req.user.id);
    const map = { title: 'title', model: 'model', system_prompt: 'system_prompt', projectId: 'project_id', temperature: 'temperature' };
    const sets = [], vals = [];
    for (const [k, col] of Object.entries(map)) {
      if (req.data[k] !== undefined) { sets.push(`${col} = ?`); vals.push(req.data[k]); }
    }
    for (const k of ['is_pinned', 'is_archived']) {
      if (req.data[k] !== undefined) { sets.push(`${k} = ?`); vals.push(req.data[k] ? 1 : 0); }
    }
    if (!sets.length) throw err.badRequest('No fields to update');
    sets.push("updated_at = datetime('now')");
    vals.push(req.params.id);
    db.prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    res.json({ success: true, data: { conversation: db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id) } });
  })
);

// ─── TRASH / RESTORE / PURGE ───
router.delete('/:id', query({ permanent: V.bool() }), wrap(async (req, res) => {
  const c = mustOwn(req.params.id, req.user.id);
  if (req.q.permanent || c.is_deleted) {
    db.fts.removeConversation(c.id);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(c.id);
    return res.json({ success: true, data: { message: 'Conversation permanently deleted' } });
  }
  db.prepare("UPDATE conversations SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ?").run(c.id);
  res.json({ success: true, data: { message: 'Moved to trash', restorable: true } });
}));

router.post('/:id/restore', wrap(async (req, res) => {
  mustOwn(req.params.id, req.user.id);
  db.prepare('UPDATE conversations SET is_deleted = 0, deleted_at = NULL WHERE id = ?').run(req.params.id);
  res.json({ success: true, data: { conversation: db.prepare('SELECT * FROM conversations WHERE id = ?').get(req.params.id) } });
}));

router.post('/trash/empty', wrap(async (req, res) => {
  const rows = db.prepare('SELECT id FROM conversations WHERE user_id = ? AND is_deleted = 1').all(req.user.id);
  rows.forEach(r => db.fts.removeConversation(r.id));
  const r = db.prepare('DELETE FROM conversations WHERE user_id = ? AND is_deleted = 1').run(req.user.id);
  res.json({ success: true, data: { deleted: r.changes } });
}));

// ─── DUPLICATE / FORK ───
router.post('/:id/fork', body({ upToMessageId: V.string({ max: 64 }), title: V.string({ max: 120 }) }), wrap(async (req, res) => {
  const src = mustOwn(req.params.id, req.user.id);
  const newId = uuid();

  db.prepare(`INSERT INTO conversations (id, user_id, project_id, parent_id, title, model, system_prompt, temperature)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(newId, req.user.id, src.project_id, src.id, req.data.title || `${src.title} (copy)`, src.model, src.system_prompt, src.temperature);

  let msgs = db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND is_deleted = 0 ORDER BY created_at').all(src.id);
  if (req.data.upToMessageId) {
    const idx = msgs.findIndex(m => m.id === req.data.upToMessageId);
    if (idx >= 0) msgs = msgs.slice(0, idx + 1);
  }

  const ins = db.prepare('INSERT INTO messages (id, conversation_id, role, content, model, tokens) VALUES (?,?,?,?,?,?)');
  db.transaction(() => {
    for (const m of msgs) {
      const mid = uuid();
      ins.run(mid, newId, m.role, m.content, m.model, m.tokens);
      db.fts.index({ id: mid, conversation_id: newId, content: m.content });
    }
    db.prepare("UPDATE conversations SET message_count = ?, last_message_at = datetime('now') WHERE id = ?").run(msgs.length, newId);
  })();

  res.status(201).json({ success: true, data: { conversation: db.prepare('SELECT * FROM conversations WHERE id = ?').get(newId), copiedMessages: msgs.length } });
}));

// ─── EXPORT ONE CONVERSATION (json | markdown | text) ───
router.get('/:id/export', query({ format: V.enum(['json', 'markdown', 'text'], { default: 'markdown' }) }), wrap(async (req, res) => {
  const c = mustOwn(req.params.id, req.user.id);
  const msgs = db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id = ? AND is_deleted = 0 ORDER BY created_at').all(c.id);
  const safe = (c.title || 'conversation').replace(/[^\w\-. ]+/g, '_').slice(0, 60);

  if (req.q.format === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.json"`);
    return res.json({ conversation: c, messages: msgs });
  }
  if (req.q.format === 'text') {
    const txt = msgs.map(m => `${m.role === 'user' ? 'You' : 'Phønix'}: ${m.content}`).join('\n\n');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.txt"`);
    return res.send(txt);
  }
  const md = [`# ${c.title}`, `_Exported ${new Date().toISOString().slice(0, 10)} · model: ${c.model}_`, '',
    ...msgs.map(m => `### ${m.role === 'user' ? 'You' : 'Phønix'}\n\n${m.content}\n`)].join('\n');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}.md"`);
  res.send(md);
}));

// ─── TAGS ───
router.post('/:id/tags', body({ name: V.string({ required: true, max: 60 }), color: V.color() }), wrap(async (req, res) => {
  mustOwn(req.params.id, req.user.id);
  let tag = db.prepare('SELECT * FROM tags WHERE user_id = ? AND name = ?').get(req.user.id, req.data.name);
  if (!tag) {
    const tid = uuid();
    db.prepare('INSERT INTO tags (id, user_id, name, color) VALUES (?,?,?,?)')
      .run(tid, req.user.id, req.data.name, req.data.color || '#8ba4ff');
    tag = db.prepare('SELECT * FROM tags WHERE id = ?').get(tid);
  }
  db.prepare('INSERT OR IGNORE INTO conversation_tags (conversation_id, tag_id) VALUES (?,?)').run(req.params.id, tag.id);
  res.status(201).json({ success: true, data: { tag, tags: tagsFor(req.params.id) } });
}));

router.delete('/:id/tags/:tagId', wrap(async (req, res) => {
  mustOwn(req.params.id, req.user.id);
  db.prepare('DELETE FROM conversation_tags WHERE conversation_id = ? AND tag_id = ?').run(req.params.id, req.params.tagId);
  res.json({ success: true, data: { tags: tagsFor(req.params.id) } });
}));

// ─── BULK ACTIONS ───
router.post('/bulk',
  body({ ids: V.array({ required: true, max: 200 }), action: V.enum(['archive', 'unarchive', 'pin', 'unpin', 'trash', 'restore', 'delete'], { required: true }) }),
  wrap(async (req, res) => {
    const { ids, action } = req.data;
    const valid = ids.filter(id => typeof id === 'string' && own(id, req.user.id));
    if (!valid.length) throw err.badRequest('No matching conversations');

    const ph = valid.map(() => '?').join(',');
    const sql = {
      archive: `UPDATE conversations SET is_archived = 1 WHERE id IN (${ph})`,
      unarchive: `UPDATE conversations SET is_archived = 0 WHERE id IN (${ph})`,
      pin: `UPDATE conversations SET is_pinned = 1 WHERE id IN (${ph})`,
      unpin: `UPDATE conversations SET is_pinned = 0 WHERE id IN (${ph})`,
      trash: `UPDATE conversations SET is_deleted = 1, deleted_at = datetime('now') WHERE id IN (${ph})`,
      restore: `UPDATE conversations SET is_deleted = 0, deleted_at = NULL WHERE id IN (${ph})`,
      delete: `DELETE FROM conversations WHERE id IN (${ph})`
    }[action];

    if (action === 'delete') valid.forEach(id => db.fts.removeConversation(id));
    const r = db.prepare(sql).run(...valid);
    res.json({ success: true, data: { action, affected: r.changes } });
  })
);

module.exports = router;
