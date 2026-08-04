const router = require('express').Router();
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { err, wrap } = require('../lib/errors');
const { V, body } = require('../lib/validate');
const A = require('../lib/auth');

router.use(A.authenticate);

const SCOPES = ['chat:read', 'chat:write', 'conversations:read', 'conversations:write'];

router.get('/', wrap(async (req, res) => {
  const keys = db.prepare(`SELECT id, name, prefix, scopes, last_used_at, request_count, revoked, expires_at, created_at
                           FROM api_keys WHERE user_id = ? ORDER BY created_at DESC`).all(req.user.id);
  res.json({
    success: true,
    data: {
      keys: keys.map(k => ({ ...k, key: `phx_${k.prefix}…`, revoked: !!k.revoked, scopes: (k.scopes || '').split(',') })),
      availableScopes: SCOPES
    }
  });
}));

router.post('/',
  body({
    name: V.string({ required: true, min: 1, max: 60 }),
    scopes: V.array({ max: 10 }),
    expiresInDays: V.int({ min: 1, max: 3650 })
  }),
  wrap(async (req, res) => {
    const limit = A.planOf(req.user).maxApiKeys;
    const active = db.prepare('SELECT COUNT(*) c FROM api_keys WHERE user_id = ? AND revoked = 0').get(req.user.id).c;
    if (active >= limit) throw err.forbidden(`Your plan allows up to ${limit} active API key(s).`);

    const scopes = (req.data.scopes?.length ? req.data.scopes : ['chat:read', 'chat:write'])
      .filter(s => SCOPES.includes(s));
    if (!scopes.length) throw err.badRequest(`Scopes must be from: ${SCOPES.join(', ')}`);

    // Show the secret exactly once; store only its hash.
    const secret = `phx_${crypto.randomBytes(24).toString('base64url')}`;
    const id = uuid();
    const expires = req.data.expiresInDays ? new Date(Date.now() + req.data.expiresInDays * 864e5).toISOString() : null;

    db.prepare(`INSERT INTO api_keys (id, user_id, name, key_hash, prefix, scopes, expires_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(id, req.user.id, req.data.name, A.sha256(secret), secret.slice(4, 12), scopes.join(','), expires);

    A.audit(req.user.id, 'apikey.create', id, req);
    res.status(201).json({
      success: true,
      data: {
        key: { id, name: req.data.name, scopes, expiresAt: expires },
        secret,
        warning: 'Copy this key now — it will not be shown again.'
      }
    });
  })
);

router.delete('/:id', wrap(async (req, res) => {
  const r = db.prepare('UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!r.changes) throw err.notFound('API key not found');
  A.audit(req.user.id, 'apikey.revoke', req.params.id, req);
  res.json({ success: true, data: { message: 'API key revoked' } });
}));

module.exports = router;
