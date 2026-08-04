const router = require('express').Router();
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { err, wrap } = require('../lib/errors');
const { V, body } = require('../lib/validate');
const { rateLimit } = require('../lib/ratelimit');
const A = require('../lib/auth');

const slugId = () => crypto.randomBytes(9).toString('base64url');

// ═══ PUBLIC (no auth): view a shared conversation ═══
const publicRouter = require('express').Router();

publicRouter.get('/:slug', rateLimit({ windowMs: 60_000, max: 60 }), wrap(async (req, res) => {
  const share = db.prepare('SELECT * FROM shares WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!share) throw err.notFound('This shared conversation is unavailable');
  if (share.expires_at && Date.parse(share.expires_at) < Date.now()) throw err.notFound('This share link has expired');

  if (share.password_hash) {
    const pw = req.headers['x-share-password'] || req.query.password;
    if (!pw || !A.verifyPassword(String(pw), share.password_hash)) {
      return res.status(401).json({ success: false, error: { code: 'SHARE_PASSWORD_REQUIRED', message: 'This conversation is password protected' } });
    }
  }

  const conv = db.prepare('SELECT id, title, model, created_at FROM conversations WHERE id = ?').get(share.conversation_id);
  if (!conv) throw err.notFound('Conversation no longer exists');
  const messages = db.prepare(`SELECT role, content, created_at FROM messages
                               WHERE conversation_id = ? AND is_deleted = 0 ORDER BY created_at`).all(conv.id);
  const owner = db.prepare('SELECT display_name FROM users WHERE id = ?').get(share.user_id);

  db.prepare('UPDATE shares SET view_count = view_count + 1 WHERE id = ?').run(share.id);
  res.json({ success: true, data: { conversation: conv, messages, sharedBy: owner?.display_name || 'Anonymous', views: share.view_count + 1 } });
}));

// ═══ AUTHENTICATED: manage shares ═══
router.use(A.authenticate);

router.get('/', wrap(async (req, res) => {
  const shares = db.prepare(`SELECT s.*, c.title FROM shares s JOIN conversations c ON c.id = s.conversation_id
                             WHERE s.user_id = ? ORDER BY s.created_at DESC`).all(req.user.id);
  res.json({
    success: true,
    data: {
      shares: shares.map(s => ({
        id: s.id, slug: s.slug, conversationId: s.conversation_id, title: s.title,
        url: `/s/${s.slug}`, views: s.view_count, protected: !!s.password_hash,
        active: !!s.is_active, expiresAt: s.expires_at, createdAt: s.created_at
      }))
    }
  });
}));

router.post('/',
  body({
    conversationId: V.string({ required: true, max: 64 }),
    password: V.string({ max: 100 }),
    expiresInDays: V.int({ min: 1, max: 365 })
  }),
  wrap(async (req, res) => {
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?')
      .get(req.data.conversationId, req.user.id);
    if (!conv) throw err.notFound('Conversation not found');

    const existing = db.prepare('SELECT * FROM shares WHERE conversation_id = ? AND is_active = 1').get(conv.id);
    if (existing) {
      return res.json({ success: true, data: { share: { ...existing, url: `/s/${existing.slug}` }, existing: true } });
    }

    const id = uuid(), slug = slugId();
    const expires = req.data.expiresInDays
      ? new Date(Date.now() + req.data.expiresInDays * 864e5).toISOString() : null;
    db.prepare(`INSERT INTO shares (id, conversation_id, user_id, slug, password_hash, expires_at)
                VALUES (?,?,?,?,?,?)`)
      .run(id, conv.id, req.user.id, slug, req.data.password ? A.hashPassword(req.data.password) : null, expires);

    A.audit(req.user.id, 'share.create', id, req);
    res.status(201).json({
      success: true,
      data: { share: { id, slug, url: `/s/${slug}`, protected: !!req.data.password, expiresAt: expires } }
    });
  })
);

router.delete('/:id', wrap(async (req, res) => {
  const r = db.prepare('UPDATE shares SET is_active = 0 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!r.changes) throw err.notFound('Share not found');
  res.json({ success: true, data: { message: 'Share link revoked' } });
}));

module.exports = { router, publicRouter };
