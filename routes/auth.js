const router = require('express').Router();
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { err, wrap } = require('../lib/errors');
const { V, body } = require('../lib/validate');
const { rateLimit, loginThrottle } = require('../lib/ratelimit');
const A = require('../lib/auth');

const limiter = rateLimit({ windowMs: 15 * 60_000, max: 40, message: 'Too many attempts. Please wait a few minutes.' });
const throttle = loginThrottle();

const publicUser = id => db.prepare(`SELECT ${A.PUBLIC_USER_COLS} FROM users WHERE id = ?`).get(id);

// ─── REGISTER ───
router.post('/register', limiter,
  body({
    email: V.email({ required: true }),
    username: V.username({ required: true }),
    password: V.password({ required: true, min: 8 }),
    displayName: V.string({ max: 60 })
  }),
  wrap(async (req, res) => {
    const { email, username, password, displayName } = req.data;

    const exists = db.prepare('SELECT email, username FROM users WHERE email = ? OR lower(username) = lower(?)').get(email, username);
    if (exists) {
      throw err.conflict(exists.email === email ? 'An account with that email already exists' : 'That username is taken');
    }

    const id = uuid();
    const isFirst = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
    db.prepare(`INSERT INTO users (id, email, username, password_hash, display_name, role)
                VALUES (?,?,?,?,?,?)`)
      .run(id, email, username, A.hashPassword(password), displayName || username, isFirst ? 'admin' : 'user');

    const { accessToken, refreshToken } = A.signTokens(id);
    A.createSession(id, refreshToken, req);

    // Email verification token (delivery is left to your mail provider).
    const raw = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO tokens (id, user_id, token_hash, type, expires_at)
                VALUES (?,?,?,'EMAIL_VERIFY', datetime('now','+2 days'))`)
      .run(uuid(), id, A.sha256(raw));

    A.audit(id, 'user.register', id, req);
    res.cookie('refreshToken', refreshToken, A.REFRESH_COOKIE);
    res.status(201).json({
      success: true,
      data: {
        user: publicUser(id),
        accessToken,
        ...(process.env.NODE_ENV !== 'production' ? { verifyToken: raw } : {})
      }
    });
  })
);

// ─── LOGIN ───
router.post('/login', limiter, throttle,
  body({ email: V.string({ required: true, max: 200 }), password: V.string({ required: true, max: 200 }) }),
  wrap(async (req, res) => {
    const ident = req.data.email.trim();
    const user = db.prepare('SELECT * FROM users WHERE email = ? OR lower(username) = lower(?)')
      .get(ident.toLowerCase(), ident);

    if (!user || !A.verifyPassword(req.data.password, user.password_hash)) {
      req.recordAuthFailure?.();
      throw err.unauthorized('Incorrect email or password', 'INVALID_CREDENTIALS');
    }
    if (!user.is_active) throw err.forbidden('This account has been disabled');

    req.clearAuthFailures?.();
    const { accessToken, refreshToken } = A.signTokens(user.id);
    A.createSession(user.id, refreshToken, req);
    db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
    A.audit(user.id, 'user.login', user.id, req);

    res.cookie('refreshToken', refreshToken, A.REFRESH_COOKIE);
    res.json({ success: true, data: { user: publicUser(user.id), accessToken } });
  })
);

// ─── REFRESH (with rotation + reuse detection) ───
router.post('/refresh', limiter, wrap(async (req, res) => {
  const token = req.cookies?.refreshToken || req.body?.refreshToken;
  if (!token) throw err.unauthorized('No refresh token', 'NO_REFRESH');

  let decoded;
  try { decoded = A.verifyRefresh(token); }
  catch { throw err.unauthorized('Invalid or expired refresh token', 'INVALID_REFRESH'); }

  const session = db.prepare('SELECT * FROM sessions WHERE refresh_token = ?').get(token);
  if (!session) throw err.unauthorized('Session not found', 'INVALID_SESSION');

  if (!session.is_valid) {
    // Token reuse → assume compromise, kill every session for this user.
    db.prepare('UPDATE sessions SET is_valid = 0 WHERE user_id = ?').run(session.user_id);
    A.audit(session.user_id, 'security.refresh_reuse', session.id, req);
    throw err.unauthorized('Session revoked. Please sign in again.', 'SESSION_REVOKED');
  }

  const tokens = A.signTokens(decoded.userId);
  db.prepare('UPDATE sessions SET is_valid = 0 WHERE id = ?').run(session.id);
  A.createSession(decoded.userId, tokens.refreshToken, req);

  res.cookie('refreshToken', tokens.refreshToken, A.REFRESH_COOKIE);
  res.json({ success: true, data: { accessToken: tokens.accessToken } });
}));

// ─── LOGOUT ───
router.post('/logout', A.authenticate, wrap(async (req, res) => {
  const token = req.cookies?.refreshToken;
  if (token) db.prepare('UPDATE sessions SET is_valid = 0 WHERE refresh_token = ?').run(token);
  res.clearCookie('refreshToken', { ...A.REFRESH_COOKIE, maxAge: undefined });
  A.audit(req.user.id, 'user.logout', req.user.id, req);
  res.json({ success: true, data: { message: 'Signed out' } });
}));

// ─── LOGOUT EVERYWHERE ───
router.post('/logout-all', A.authenticate, wrap(async (req, res) => {
  const r = db.prepare('UPDATE sessions SET is_valid = 0 WHERE user_id = ? AND is_valid = 1').run(req.user.id);
  res.clearCookie('refreshToken', { ...A.REFRESH_COOKIE, maxAge: undefined });
  A.audit(req.user.id, 'user.logout_all', req.user.id, req);
  res.json({ success: true, data: { revoked: r.changes } });
}));

// ─── ACTIVE DEVICES ───
router.get('/sessions', A.authenticate, wrap(async (req, res) => {
  const current = req.cookies?.refreshToken;
  const rows = db.prepare(`SELECT id, device_info, ip_address, last_used_at, created_at, expires_at, refresh_token
                           FROM sessions WHERE user_id = ? AND is_valid = 1 ORDER BY created_at DESC`).all(req.user.id);
  res.json({
    success: true,
    data: {
      sessions: rows.map(s => ({
        id: s.id, device: s.device_info, ip: s.ip_address,
        lastUsedAt: s.last_used_at, createdAt: s.created_at, expiresAt: s.expires_at,
        current: s.refresh_token === current
      }))
    }
  });
}));

router.delete('/sessions/:id', A.authenticate, wrap(async (req, res) => {
  const r = db.prepare('UPDATE sessions SET is_valid = 0 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!r.changes) throw err.notFound('Session not found');
  res.json({ success: true, data: { message: 'Device signed out' } });
}));

// ─── PASSWORD RESET ───
router.post('/forgot-password', limiter, body({ email: V.email({ required: true }) }), wrap(async (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(req.data.email);
  let devToken;
  if (user) {
    const raw = crypto.randomBytes(32).toString('hex');
    devToken = raw;
    db.prepare(`INSERT INTO tokens (id, user_id, token_hash, type, expires_at)
                VALUES (?,?,?,'PASSWORD_RESET', datetime('now','+1 hour'))`)
      .run(uuid(), user.id, A.sha256(raw));
    A.audit(user.id, 'user.forgot_password', user.id, req);
    // TODO: email the link — e.g. `${origin}/reset?token=${raw}`
  }
  // Always the same response so accounts can't be enumerated.
  res.json({
    success: true,
    data: {
      message: 'If an account exists for that email, a reset link is on its way.',
      ...(process.env.NODE_ENV !== 'production' && devToken ? { devToken } : {})
    }
  });
}));

router.post('/reset-password', limiter,
  body({ token: V.string({ required: true, max: 200 }), password: V.password({ required: true, min: 8 }) }),
  wrap(async (req, res) => {
    const row = db.prepare(`SELECT * FROM tokens WHERE token_hash = ? AND type = 'PASSWORD_RESET'
                            AND used = 0 AND expires_at > datetime('now')`).get(A.sha256(req.data.token));
    if (!row) throw err.badRequest('This reset link is invalid or has expired');

    db.prepare('UPDATE users SET password_hash = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(A.hashPassword(req.data.password), row.user_id);
    db.prepare('UPDATE tokens SET used = 1 WHERE id = ?').run(row.id);
    db.prepare('UPDATE sessions SET is_valid = 0 WHERE user_id = ?').run(row.user_id);
    A.audit(row.user_id, 'user.reset_password', row.user_id, req);

    res.json({ success: true, data: { message: 'Password updated. Please sign in.' } });
  })
);

// ─── EMAIL VERIFICATION ───
router.post('/verify-email', limiter, body({ token: V.string({ required: true, max: 200 }) }), wrap(async (req, res) => {
  const row = db.prepare(`SELECT * FROM tokens WHERE token_hash = ? AND type = 'EMAIL_VERIFY'
                          AND used = 0 AND expires_at > datetime('now')`).get(A.sha256(req.data.token));
  if (!row) throw err.badRequest('This verification link is invalid or has expired');
  db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').run(row.user_id);
  db.prepare('UPDATE tokens SET used = 1 WHERE id = ?').run(row.id);
  res.json({ success: true, data: { message: 'Email verified' } });
}));

module.exports = router;
