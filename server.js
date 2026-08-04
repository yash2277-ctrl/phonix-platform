try { require('dotenv').config(); } catch { /* dotenv optional */ }

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');

const db = require('./db');
const ai = require('./lib/ai');
const { errorHandler, notFoundHandler, wrap } = require('./lib/errors');
const { rateLimit } = require('./lib/ratelimit');
const A = require('./lib/auth');

const app = express();
const PORT = process.env.PORT || 3001;
const isProd = process.env.NODE_ENV === 'production';

// ═══════════════════════════════════════
//              MIDDLEWARE
// ═══════════════════════════════════════
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Correlation id on every request — surfaces in logs and error payloads.
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.id);
  next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      baseUri: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  hsts: isProd ? undefined : false
}));

const ALLOWED_ORIGINS = (process.env.CLIENT_ORIGINS || `http://localhost:${PORT},http://127.0.0.1:${PORT}`)
  .split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)),
  credentials: true,
  exposedHeaders: ['X-Request-Id', 'RateLimit-Remaining', 'RateLimit-Reset']
}));

// Generous limit only for the upload endpoint (base64 payloads).
app.use('/api/v1/files', express.json({ limit: '150mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

morgan.token('id', req => req.id);
app.use(morgan(isProd ? ':id :remote-addr :method :url :status :response-time ms' : ':method :url :status :response-time ms', {
  skip: req => req.path === '/health' || req.path === '/api/v1/health'
}));

// Baseline API protection (individual routers add stricter limits).
app.use('/api/', rateLimit({ windowMs: 60_000, max: 400 }));

// ═══════════════════════════════════════
//                ROUTES
// ═══════════════════════════════════════
const shares = require('./routes/shares');
const artifactRoutes = require('./routes/artifacts');
const webhookRoutes = require('./routes/webhooks');

app.use('/api/v1/auth', require('./routes/auth'));
app.use('/api/v1/users', require('./routes/users'));
app.use('/api/v1/conversations', require('./routes/conversations'));
app.use('/api/v1/messages', require('./routes/messages'));
app.use('/api/v1/chat', require('./routes/chat'));
app.use('/api/v1/projects', require('./routes/projects'));
app.use('/api/v1/memories', require('./routes/memories'));
app.use('/api/v1/prompts', require('./routes/prompts'));
app.use('/api/v1/search', require('./routes/search'));
app.use('/api/v1/files', require('./routes/files'));
app.use('/api/v1/shares', shares.router);
app.use('/api/v1/public/shares', shares.publicRouter);
app.use('/api/v1/keys', require('./routes/apikeys'));
app.use('/api/v1/admin', require('./routes/admin'));
// ─── v3 capabilities ───
app.use('/api/v1/artifacts', artifactRoutes.router);
app.use('/api/v1/public/artifacts', artifactRoutes.publicRouter);
app.use('/api/v1/knowledge', require('./routes/knowledge'));
app.use('/api/v1/tools', require('./routes/tools'));
app.use('/api/v1/webhooks', webhookRoutes.router);
app.use('/api/v1/batch', require('./routes/batch'));

// ─── TAGS (small enough to live here) ───
app.get('/api/v1/tags', A.authenticate, wrap(async (req, res) => {
  const tags = db.prepare(`SELECT t.*, COUNT(ct.conversation_id) usageCount FROM tags t
                           LEFT JOIN conversation_tags ct ON ct.tag_id = t.id
                           WHERE t.user_id = ? GROUP BY t.id ORDER BY usageCount DESC, t.name`).all(req.user.id);
  res.json({ success: true, data: { tags } });
}));
app.delete('/api/v1/tags/:id', A.authenticate, wrap(async (req, res) => {
  db.prepare('DELETE FROM tags WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ success: true, data: { message: 'Tag deleted' } });
}));

// ─── API DISCOVERY ───
app.get('/api/v1', (req, res) => {
  res.json({
    success: true,
    data: {
      name: 'PHØNIX AI API', version: '3.0.0',
      docs: '/api/v1/docs',
      endpoints: {
        auth: ['POST /auth/register', 'POST /auth/login', 'POST /auth/refresh', 'POST /auth/logout',
               'POST /auth/logout-all', 'GET /auth/sessions', 'DELETE /auth/sessions/:id',
               'POST /auth/forgot-password', 'POST /auth/reset-password', 'POST /auth/verify-email'],
        users: ['GET /users/me', 'PATCH /users/me', 'PATCH /users/me/password', 'GET /users/me/usage',
                'GET /users/me/stats', 'GET /users/me/export', 'DELETE /users/me'],
        conversations: ['GET /conversations', 'POST /conversations', 'GET /conversations/:id',
                        'PATCH /conversations/:id', 'DELETE /conversations/:id', 'POST /conversations/:id/restore',
                        'POST /conversations/:id/fork', 'GET /conversations/:id/export',
                        'POST /conversations/:id/tags', 'POST /conversations/bulk', 'POST /conversations/trash/empty'],
        messages: ['GET /messages/:conversationId', 'POST /messages/:conversationId', 'PATCH /messages/:messageId',
                   'DELETE /messages/:messageId', 'GET /messages/:messageId/versions', 'POST /messages/:messageId/feedback'],
        chat: ['GET /chat/models', 'POST /chat/stream (SSE)', 'POST /chat/completions', 'POST /chat/title', 'POST /chat/regenerate'],
        projects: ['GET /projects', 'POST /projects', 'GET /projects/:id', 'PATCH /projects/:id', 'DELETE /projects/:id'],
        memories: ['GET /memories', 'POST /memories', 'PATCH /memories/:id', 'DELETE /memories/:id'],
        prompts: ['GET /prompts', 'POST /prompts', 'POST /prompts/seed', 'PATCH /prompts/:id', 'POST /prompts/:id/use'],
        search: ['GET /search?q='],
        files: ['POST /files', 'GET /files', 'GET /files/:id', 'DELETE /files/:id'],
        shares: ['GET /shares', 'POST /shares', 'DELETE /shares/:id', 'GET /public/shares/:slug'],
        keys: ['GET /keys', 'POST /keys', 'DELETE /keys/:id'],
        admin: ['GET /admin/stats', 'GET /admin/users', 'PATCH /admin/users/:id', 'GET /admin/audit'],
        artifacts: ['GET /artifacts', 'POST /artifacts', 'GET /artifacts/:id', 'PATCH /artifacts/:id',
                    'POST /artifacts/:id/rollback', 'POST /artifacts/:id/publish', 'GET /artifacts/:id/download',
                    'GET /public/artifacts/:slug'],
        knowledge: ['GET /knowledge', 'POST /knowledge', 'POST /knowledge/from-file', 'POST /knowledge/from-url',
                    'GET /knowledge/search?q=', 'POST /knowledge/ask', 'DELETE /knowledge/:id'],
        tools: ['GET /tools', 'POST /tools/:name/execute', 'GET /tools/history'],
        agent: ['POST /chat/agent (SSE: thinking, tool_use, artifact, citations, suggestions)', 'POST /chat/count-tokens'],
        webhooks: ['GET /webhooks', 'POST /webhooks', 'POST /webhooks/:id/test', 'DELETE /webhooks/:id'],
        batch: ['POST /batch', 'GET /batch', 'GET /batch/:id', 'POST /batch/:id/cancel']
      }
    }
  });
});

// ─── HEALTH & READINESS ───
function health(req, res) {
  let dbOk = true;
  try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
  res.status(dbOk ? 200 : 503).json({
    status: dbOk ? 'ok' : 'degraded',
    version: '3.0.0',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    checks: { database: dbOk, aiProvider: ai.isAvailable(), search: db.ftsEnabled ? 'fts5' : 'like' },
    stats: dbOk ? {
      users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
      conversations: db.prepare('SELECT COUNT(*) c FROM conversations WHERE is_deleted = 0').get().c,
      messages: db.prepare('SELECT COUNT(*) c FROM messages WHERE is_deleted = 0').get().c
    } : undefined,
    memory: { rssMB: Math.round(process.memoryUsage().rss / 1048576) }
  });
}
app.get('/health', health);
app.get('/api/v1/health', health);

// ═══════════════════════════════════════
//          STATIC + PAGES
// ═══════════════════════════════════════
app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProd ? '1h' : 0, etag: true }));

const page = f => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
app.get('/', page('index.html'));
app.get('/login', page('login.html'));
app.get('/signup', page('login.html'));
app.get('/chat', page('chat.html'));
app.get('/s/:slug', page('index.html'));   // shared conversation viewer
app.get('/a/:slug', page('index.html'));   // published artifact viewer

// ═══════════════════════════════════════
//         ERRORS + LIFECYCLE
// ═══════════════════════════════════════
app.use(notFoundHandler);
app.use(errorHandler);

// Background housekeeping: expire stale sessions/tokens hourly.
const janitor = setInterval(() => {
  try {
    db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
    db.prepare("DELETE FROM tokens WHERE expires_at < datetime('now')").run();
  } catch (e) { console.error('Janitor error:', e.message); }
}, 3600_000);
if (janitor.unref) janitor.unref();

const server = app.listen(PORT, () => {
  // Build the banner programmatically: hand-padded box drawing drifts out of
  // alignment the moment a value changes length (a 4-digit port, say).
  const W = 48;
  const row = (label, value) => `  ║ ${`${label}  ${value}`.padEnd(W - 2)}║`;
  const rule = (l, r, fill = '═') => `  ${l}${fill.repeat(W)}${r}`;
  const centre = s => {
    // Emoji occupy two columns in most terminals but count as one code point.
    const width = [...s].length + (/\p{Extended_Pictographic}/u.test(s) ? 1 : 0);
    const pad = Math.max(0, W - width);
    const left = Math.floor(pad / 2);
    return `  ║${' '.repeat(left)}${s}${' '.repeat(pad - left)}║`;
  };

  console.log([
    '',
    rule('╔', '╗'),
    centre('🔥 PHØNIX AI — Server v3'),
    rule('╠', '╣'),
    row('Landing ', `http://localhost:${PORT}`),
    row('Chat    ', `http://localhost:${PORT}/chat`),
    row('Login   ', `http://localhost:${PORT}/login`),
    row('API     ', `http://localhost:${PORT}/api/v1`),
    row('Health  ', `http://localhost:${PORT}/health`),
    rule('╠', '╣'),
    row('Provider', ai.isAvailable() ? 'online' : 'offline'),
    row('Search  ', db.ftsEnabled ? 'FTS5' : 'LIKE (FTS5 unavailable)'),
    row('Mode    ', isProd ? 'production' : 'development'),
    row('Tools   ', `${require('./lib/tools').listTools().length} registered`),
    rule('╚', '╝'),
    ''
  ].join('\n'));
});

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully…`);
  clearInterval(janitor);
  server.close(() => {
    try { db.close(); } catch {}
    console.log('Closed cleanly.');
    process.exit(0);
  });
  setTimeout(() => { console.error('Forced exit.'); process.exit(1); }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', r => console.error('Unhandled rejection:', r));
process.on('uncaughtException', e => { console.error('Uncaught exception:', e); shutdown('uncaughtException'); });

module.exports = app;
