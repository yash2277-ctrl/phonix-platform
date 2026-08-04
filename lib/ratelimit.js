const { err } = require('./errors');

// In-memory sliding-window rate limiter with standard headers.
// (Single-process by design — swap the store for Redis when you scale out.)

function rateLimit({ windowMs = 60_000, max = 100, key, message } = {}) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  }, Math.min(windowMs, 60_000));
  if (sweep.unref) sweep.unref();

  return (req, res, next) => {
    const id = key ? key(req) : (req.user?.id || req.ip || req.socket.remoteAddress || 'anon');
    const now = Date.now();
    let e = hits.get(id);
    if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; hits.set(id, e); }
    e.count++;

    const remaining = Math.max(0, max - e.count);
    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', remaining);
    res.setHeader('RateLimit-Reset', Math.ceil((e.reset - now) / 1000));

    if (e.count > max) {
      const retry = Math.ceil((e.reset - now) / 1000);
      res.setHeader('Retry-After', retry);
      return next(err.tooMany(message || 'Too many requests. Please slow down.', { retryAfter: retry }));
    }
    next();
  };
}

// Progressive lockout for credential endpoints: repeated failures cost more.
function loginThrottle({ windowMs = 15 * 60_000, max = 8 } = {}) {
  const fails = new Map();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of fails) if (now > v.reset) fails.delete(k);
  }, 60_000);
  if (sweep.unref) sweep.unref();

  const mw = (req, res, next) => {
    const id = `${req.ip}:${(req.body?.email || '').toLowerCase()}`;
    const e = fails.get(id);
    if (e && e.count >= max && Date.now() < e.reset) {
      const retry = Math.ceil((e.reset - Date.now()) / 1000);
      res.setHeader('Retry-After', retry);
      return next(err.tooMany(`Too many failed attempts. Try again in ${Math.ceil(retry / 60)} minute(s).`, { retryAfter: retry }));
    }
    req.recordAuthFailure = () => {
      const cur = fails.get(id) || { count: 0, reset: Date.now() + windowMs };
      cur.count++; cur.reset = Date.now() + windowMs;
      fails.set(id, cur);
    };
    req.clearAuthFailures = () => fails.delete(id);
    next();
  };
  return mw;
}

module.exports = { rateLimit, loginThrottle };
