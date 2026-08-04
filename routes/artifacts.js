const router = require('express').Router();
const db = require('../db');
const { err, wrap } = require('../lib/errors');
const { V, body, query } = require('../lib/validate');
const A = require('../lib/auth');
const artifacts = require('../lib/artifacts');

// ═══ PUBLIC: view a published artifact ═══
const publicRouter = require('express').Router();
publicRouter.get('/:slug', wrap(async (req, res) => {
  const a = db.prepare('SELECT * FROM artifacts WHERE publish_slug = ? AND is_published = 1').get(req.params.slug);
  if (!a) throw err.notFound('This artifact is not available');
  const owner = db.prepare('SELECT display_name FROM users WHERE id = ?').get(a.user_id);
  res.json({
    success: true,
    data: {
      artifact: {
        title: a.title, type: a.type, language: a.language, content: a.content,
        version: a.version, updatedAt: a.updated_at
      },
      author: owner?.display_name || 'Anonymous'
    }
  });
}));

// ═══ AUTHENTICATED ═══
router.use(A.authenticate);

const mustOwn = (id, uid) => {
  const a = db.prepare('SELECT * FROM artifacts WHERE id = ? AND user_id = ?').get(id, uid);
  if (!a) throw err.notFound('Artifact not found');
  return a;
};

router.get('/', query({ conversationId: V.string({ max: 64 }), type: V.string({ max: 40 }), search: V.string({ max: 120 }) }),
  wrap(async (req, res) => {
    const params = [req.user.id];
    let sql = `SELECT id, identifier, title, type, language, version, is_published, publish_slug,
               length(content) AS size, conversation_id, created_at, updated_at
               FROM artifacts WHERE user_id = ?`;
    if (req.q.conversationId) { sql += ' AND conversation_id = ?'; params.push(req.q.conversationId); }
    if (req.q.type) { sql += ' AND type = ?'; params.push(req.q.type); }
    if (req.q.search) { sql += ' AND (title LIKE ? OR identifier LIKE ?)'; params.push(`%${req.q.search}%`, `%${req.q.search}%`); }
    sql += ' ORDER BY updated_at DESC LIMIT 200';
    res.json({ success: true, data: { artifacts: db.prepare(sql).all(...params) } });
  })
);

router.get('/:id', wrap(async (req, res) => {
  const a = mustOwn(req.params.id, req.user.id);
  const versions = db.prepare('SELECT id, version, change_note, created_at, length(content) size FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC').all(a.id);
  res.json({ success: true, data: { artifact: a, versions } });
}));

router.post('/',
  body({
    identifier: V.string({ required: true, min: 1, max: 80 }),
    title: V.string({ required: true, min: 1, max: 160 }),
    content: V.string({ required: true, min: 1, max: 500_000 }),
    type: V.enum(artifacts.TYPES, { default: 'text/markdown' }),
    language: V.string({ max: 30 }),
    conversationId: V.string({ max: 64 }),
    changeNote: V.string({ max: 300 })
  }),
  wrap(async (req, res) => {
    const a = artifacts.upsert({ userId: req.user.id, ...req.data, conversationId: req.data.conversationId || null });
    res.status(a.created ? 201 : 200).json({ success: true, data: { artifact: a, action: a.created ? 'created' : (a.unchanged ? 'unchanged' : 'updated') } });
  })
);

router.patch('/:id',
  body({ content: V.string({ max: 500_000 }), title: V.string({ max: 160 }), changeNote: V.string({ max: 300 }) }),
  wrap(async (req, res) => {
    const a = mustOwn(req.params.id, req.user.id);
    const updated = artifacts.upsert({
      userId: req.user.id, identifier: a.identifier,
      title: req.data.title || a.title, type: a.type, language: a.language,
      content: req.data.content !== undefined ? req.data.content : a.content,
      changeNote: req.data.changeNote
    });
    res.json({ success: true, data: { artifact: updated } });
  })
);

// ─── VERSION HISTORY / ROLLBACK ───
router.get('/:id/versions/:version', wrap(async (req, res) => {
  const a = mustOwn(req.params.id, req.user.id);
  const v = db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?').get(a.id, req.params.version);
  if (!v) throw err.notFound('Version not found');
  res.json({ success: true, data: { version: v } });
}));

router.post('/:id/rollback', body({ version: V.int({ required: true, min: 1 }) }), wrap(async (req, res) => {
  const a = mustOwn(req.params.id, req.user.id);
  const v = db.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?').get(a.id, req.data.version);
  if (!v) throw err.notFound('Version not found');
  const updated = artifacts.upsert({
    userId: req.user.id, identifier: a.identifier, title: a.title, type: a.type,
    language: a.language, content: v.content, changeNote: `Rolled back to v${req.data.version}`
  });
  res.json({ success: true, data: { artifact: updated } });
}));

// ─── PUBLISH ───
router.post('/:id/publish', wrap(async (req, res) => {
  mustOwn(req.params.id, req.user.id);
  const pub = artifacts.publish(req.params.id, req.user.id);
  res.json({ success: true, data: pub });
}));

router.delete('/:id/publish', wrap(async (req, res) => {
  mustOwn(req.params.id, req.user.id);
  db.prepare('UPDATE artifacts SET is_published = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true, data: { message: 'Artifact unpublished' } });
}));

// ─── DOWNLOAD ───
router.get('/:id/download', wrap(async (req, res) => {
  const a = mustOwn(req.params.id, req.user.id);
  const ext = a.type === 'application/code' ? ({ python: 'py', javascript: 'js', typescript: 'ts', java: 'java', go: 'go', rust: 'rs', sql: 'sql' }[a.language] || 'txt')
    : a.type === 'text/html' ? 'html' : a.type === 'application/json' ? 'json' : a.type === 'image/svg+xml' ? 'svg' : 'md';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${a.identifier}.${ext}"`);
  res.send(a.content);
}));

router.delete('/:id', wrap(async (req, res) => {
  mustOwn(req.params.id, req.user.id);
  db.prepare('DELETE FROM artifacts WHERE id = ?').run(req.params.id);
  res.json({ success: true, data: { message: 'Artifact deleted' } });
}));

module.exports = { router, publicRouter };
