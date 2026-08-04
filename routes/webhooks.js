const router = require('express').Router();
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { err, wrap } = require('../lib/errors');
const { V, body } = require('../lib/validate');
const A = require('../lib/auth');
const { safeFetch } = require('../lib/tools');

const EVENTS = ['message.created', 'conversation.created', 'artifact.created', 'batch.completed', 'quota.reached'];

router.use(A.authenticate);

router.get('/', wrap(async (req, res) => {
  const hooks = db.prepare('SELECT id, url, events, is_active, failure_count, last_status, last_fired_at, created_at FROM webhooks WHERE user_id = ?')
    .all(req.user.id);
  res.json({ success: true, data: { webhooks: hooks.map(h => ({ ...h, events: h.events.split(','), is_active: !!h.is_active })), availableEvents: EVENTS } });
}));

router.post('/',
  body({ url: V.string({ required: true, max: 2000 }), events: V.array({ required: true, max: 10 }) }),
  wrap(async (req, res) => {
    let u;
    try { u = new URL(req.data.url); } catch { throw err.badRequest('Invalid URL'); }
    if (u.protocol !== 'https:' && process.env.NODE_ENV === 'production') throw err.badRequest('Webhook URLs must use HTTPS');

    const events = req.data.events.filter(e => EVENTS.includes(e));
    if (!events.length) throw err.badRequest(`Events must be from: ${EVENTS.join(', ')}`);

    const id = uuid();
    const secret = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO webhooks (id, user_id, url, secret, events) VALUES (?,?,?,?,?)')
      .run(id, req.user.id, req.data.url, secret, events.join(','));
    res.status(201).json({
      success: true,
      data: { webhook: { id, url: req.data.url, events }, secret, note: 'Verify the X-Phonix-Signature header (HMAC-SHA256 of the raw body).' }
    });
  })
);

router.post('/:id/test', wrap(async (req, res) => {
  const h = db.prepare('SELECT * FROM webhooks WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!h) throw err.notFound('Webhook not found');
  const result = await deliver(h, 'test.ping', { message: 'Hello from PHØNIX', at: new Date().toISOString() });
  res.json({ success: result.ok, data: result });
}));

router.delete('/:id', wrap(async (req, res) => {
  const r = db.prepare('DELETE FROM webhooks WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!r.changes) throw err.notFound('Webhook not found');
  res.json({ success: true, data: { message: 'Webhook deleted' } });
}));

/** Deliver a signed event. Best-effort: never throws into the request path. */
async function deliver(hook, event, payload) {
  const body = JSON.stringify({ event, data: payload, timestamp: new Date().toISOString() });
  const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
  try {
    const https = require(hook.url.startsWith('https') ? 'https' : 'http');
    const u = new URL(hook.url);
    const status = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', timeout: 6000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Phonix-Event': event,
          'X-Phonix-Signature': signature
        }
      }, r => { r.resume(); resolve(r.statusCode); });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body); req.end();
    });
    db.prepare("UPDATE webhooks SET last_status = ?, last_fired_at = datetime('now'), failure_count = CASE WHEN ? < 400 THEN 0 ELSE failure_count + 1 END WHERE id = ?")
      .run(status, status, hook.id);
    return { ok: status < 400, status };
  } catch (e) {
    db.prepare("UPDATE webhooks SET failure_count = failure_count + 1, last_fired_at = datetime('now') WHERE id = ?").run(hook.id);
    return { ok: false, error: e.message };
  }
}

/** Fire an event to all of a user's subscribed hooks (fire-and-forget). */
function emit(userId, event, payload) {
  try {
    const hooks = db.prepare("SELECT * FROM webhooks WHERE user_id = ? AND is_active = 1 AND failure_count < 10").all(userId);
    for (const h of hooks) {
      if (h.events.split(',').includes(event)) deliver(h, event, payload).catch(() => {});
    }
  } catch {}
}

module.exports = { router, emit, EVENTS };
