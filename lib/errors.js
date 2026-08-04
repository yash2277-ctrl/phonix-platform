// Typed application errors + consistent JSON error envelope.

class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

const err = {
  badRequest: (m = 'Invalid request', d) => new AppError(400, 'BAD_REQUEST', m, d),
  validation: (m = 'Validation failed', d) => new AppError(422, 'VALIDATION_ERROR', m, d),
  unauthorized: (m = 'Authentication required', c = 'UNAUTHORIZED') => new AppError(401, c, m),
  forbidden: (m = 'You do not have access to this resource') => new AppError(403, 'FORBIDDEN', m),
  notFound: (m = 'Not found') => new AppError(404, 'NOT_FOUND', m),
  conflict: (m = 'Already exists') => new AppError(409, 'CONFLICT', m),
  tooMany: (m = 'Too many requests', d) => new AppError(429, 'RATE_LIMITED', m, d),
  quota: (m = 'Daily limit reached', d) => new AppError(429, 'QUOTA_EXCEEDED', m, d),
  payload: (m = 'Payload too large') => new AppError(413, 'PAYLOAD_TOO_LARGE', m),
  upstream: (m = 'Upstream provider unavailable') => new AppError(502, 'UPSTREAM_ERROR', m),
  internal: (m = 'Something went wrong') => new AppError(500, 'SERVER_ERROR', m)
};

// Wrap async route handlers so rejections reach the error middleware.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function notFoundHandler(req, res) {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
      requestId: req.id
    });
  }
  res.status(404).sendFile(require('path').join(__dirname, '..', 'public', 'index.html'));
}

function errorHandler(e, req, res, next) {
  if (res.headersSent) return next(e);

  const isApp = e instanceof AppError;
  const status = isApp ? e.status : (e.status || 500);

  // SQLite constraint violations map to friendly conflicts.
  let code = isApp ? e.code : 'SERVER_ERROR';
  let message = isApp ? e.message : 'Something went wrong';
  if (!isApp && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({ success: false, error: { code: 'CONFLICT', message: 'That value is already taken' }, requestId: req.id });
  }
  if (e.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' }, requestId: req.id });
  }
  if (e instanceof SyntaxError && 'body' in e) {
    return res.status(400).json({ success: false, error: { code: 'BAD_JSON', message: 'Malformed JSON body' }, requestId: req.id });
  }

  if (status >= 500) {
    console.error(`[${req.id}] ${req.method} ${req.path} →`, e);
  }

  const body = { success: false, error: { code, message }, requestId: req.id };
  if (isApp && e.details) body.error.details = e.details;
  if (status >= 500 && process.env.NODE_ENV !== 'production') body.error.stack = e.stack;
  res.status(status).json(body);
}

module.exports = { AppError, err, wrap, errorHandler, notFoundHandler };
