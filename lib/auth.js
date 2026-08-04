const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { err } = require('./errors');

const isProd = process.env.NODE_ENV === 'production';

// ─── SECRETS: required in prod, persisted in dev so restarts don't log users out ───
function loadSecrets() {
  if (process.env.JWT_SECRET && process.env.JWT_REFRESH_SECRET) {
    return { jwt: process.env.JWT_SECRET, refresh: process.env.JWT_REFRESH_SECRET };
  }
  if (isProd) {
    console.error('FATAL: JWT_SECRET and JWT_REFRESH_SECRET must be set in production.');
    process.exit(1);
  }
  const file = path.join(__dirname, '..', '.secrets.json');
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!s.jwt || !s.refresh) {
    s = { jwt: crypto.randomBytes(48).toString('hex'), refresh: crypto.randomBytes(48).toString('hex') };
    try { fs.writeFileSync(file, JSON.stringify(s), { mode: 0o600 }); } catch (e) { console.warn('Could not persist dev secrets:', e.message); }
    console.warn('⚠  Generated dev JWT secrets (.secrets.json). Set real secrets for production.');
  }
  return s;
}
const SECRETS = loadSecrets();
const ACCESS_TTL = process.env.ACCESS_TTL || '24h';
const REFRESH_DAYS = 30;

const REFRESH_COOKIE = {
  httpOnly: true,
  secure: isProd,
  sameSite: 'strict',
  maxAge: REFRESH_DAYS * 24 * 60 * 60 * 1000,
  path: '/'
};

const hashPassword = pw => bcrypt.hashSync(pw, 12);
const verifyPassword = (pw, hash) => { try { return bcrypt.compareSync(pw, hash); } catch { return false; } };
const sha256 = v => crypto.createHash('sha256').update(v).digest('hex');

function signTokens(userId) {
  return {
    accessToken: jwt.sign({ userId, typ: 'access' }, SECRETS.jwt, { expiresIn: ACCESS_TTL }),
    refreshToken: jwt.sign({ userId, typ: 'refresh', jti: uuid() }, SECRETS.refresh, { expiresIn: `${REFRESH_DAYS}d` })
  };
}
const verifyAccess = t => jwt.verify(t, SECRETS.jwt);
const verifyRefresh = t => jwt.verify(t, SECRETS.refresh);

function createSession(userId, refreshToken, req) {
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 864e5).toISOString();
  db.prepare(`INSERT INTO sessions (id, user_id, refresh_token, device_info, ip_address, expires_at)
              VALUES (?,?,?,?,?,?)`)
    .run(uuid(), userId, refreshToken, (req?.headers['user-agent'] || '').slice(0, 200), req?.ip || null, expiresAt);
}

const PUBLIC_USER_COLS = `id, email, username, display_name, plan, role, avatar_url, bio,
  custom_instructions, preferences, email_verified, usage_today, total_messages, total_tokens,
  last_login_at, created_at`;

const getUser = id => db.prepare(`SELECT ${PUBLIC_USER_COLS} FROM users WHERE id = ? AND is_active = 1`).get(id);

// ─── PLAN LIMITS ───
const PLANS = {
  FREE:       { dailyMessages: 50,   maxAttachmentMB: 5,  maxProjects: 3,   maxApiKeys: 1, models: ['blaze', 'ember'] },
  PRO:        { dailyMessages: 1000, maxAttachmentMB: 25, maxProjects: 50,  maxApiKeys: 10, models: ['blaze', 'nova', 'ember'] },
  ENTERPRISE: { dailyMessages: 100000, maxAttachmentMB: 100, maxProjects: 1000, maxApiKeys: 100, models: ['blaze', 'nova', 'ember'] }
};
const planOf = user => PLANS[user?.plan] || PLANS.FREE;

// Reset the rolling daily counter when the window has passed.
function rollUsage(userId) {
  const u = db.prepare('SELECT usage_today, usage_reset_at FROM users WHERE id = ?').get(userId);
  if (!u) return 0;
  const last = Date.parse((u.usage_reset_at || '1970-01-01 00:00:00').replace(' ', 'T') + 'Z');
  if (isNaN(last) || Date.now() - last > 864e5) {
    db.prepare("UPDATE users SET usage_today = 0, usage_reset_at = datetime('now') WHERE id = ?").run(userId);
    return 0;
  }
  return u.usage_today;
}

// Enforce the plan's daily message quota.
function enforceQuota(req, res, next) {
  if (!req.user) return next();
  const used = rollUsage(req.user.id);
  const limit = planOf(req.user).dailyMessages;
  if (used >= limit) {
    return next(err.quota(`You've reached your daily limit of ${limit} messages. It resets 24h after your first message.`, { used, limit, plan: req.user.plan }));
  }
  req.quota = { used, limit, remaining: limit - used };
  next();
}

// ─── AUTH MIDDLEWARE (JWT bearer *or* API key) ───
function readToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return null;
}

function authenticateApiKey(req) {
  const raw = req.headers['x-api-key'];
  if (!raw) return null;
  const row = db.prepare('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0').get(sha256(raw));
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
  db.prepare("UPDATE api_keys SET last_used_at = datetime('now'), request_count = request_count + 1 WHERE id = ?").run(row.id);
  const user = getUser(row.user_id);
  if (user) { user._apiKey = row; user._scopes = (row.scopes || '').split(','); }
  return user || null;
}

function authenticate(req, res, next) {
  const viaKey = authenticateApiKey(req);
  if (viaKey) { req.user = viaKey; req.authMethod = 'api_key'; return next(); }

  const token = readToken(req);
  if (!token) return next(err.unauthorized('Authentication required', 'NO_TOKEN'));
  let decoded;
  try { decoded = verifyAccess(token); }
  catch (e) {
    const expired = e.name === 'TokenExpiredError';
    return next(err.unauthorized(expired ? 'Your session expired' : 'Invalid token', expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN'));
  }
  const user = getUser(decoded.userId);
  if (!user) return next(err.unauthorized('Account not found or disabled', 'USER_NOT_FOUND'));
  req.user = user;
  req.authMethod = 'jwt';
  next();
}

// Attaches req.user when credentials are present, but never rejects.
function optionalAuth(req, res, next) {
  const viaKey = authenticateApiKey(req);
  if (viaKey) { req.user = viaKey; req.authMethod = 'api_key'; return next(); }
  const token = readToken(req);
  if (token) {
    try { req.user = getUser(verifyAccess(token).userId) || undefined; req.authMethod = 'jwt'; } catch {}
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return next(err.forbidden('Administrator access required'));
  next();
}

function audit(userId, action, target, req, meta) {
  try {
    db.prepare('INSERT INTO audit_log (id, user_id, action, target, ip_address, meta) VALUES (?,?,?,?,?,?)')
      .run(uuid(), userId || null, action, target || null, req?.ip || null, meta ? JSON.stringify(meta) : null);
  } catch {}
}

module.exports = {
  REFRESH_COOKIE, PLANS, PUBLIC_USER_COLS,
  hashPassword, verifyPassword, sha256,
  signTokens, verifyAccess, verifyRefresh, createSession,
  getUser, planOf, rollUsage, enforceQuota,
  authenticate, optionalAuth, requireAdmin, audit
};
