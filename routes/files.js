const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { err, wrap } = require('../lib/errors');
const { V, body } = require('../lib/validate');
const { rateLimit } = require('../lib/ratelimit');
const A = require('../lib/auth');

router.use(A.authenticate);

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Accepts base64 JSON uploads — no extra dependency, works everywhere.
const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-yaml|sql|csv))/;
const ALLOWED = /^(image\/(png|jpe?g|gif|webp|svg\+xml)|text\/.*|application\/(pdf|json|xml|javascript|zip|x-yaml|sql|csv|octet-stream))$/;

const uploadLimit = rateLimit({ windowMs: 60_000, max: 20, message: 'Too many uploads. Please wait a moment.' });

router.post('/', uploadLimit,
  body({
    filename: V.string({ required: true, min: 1, max: 255 }),
    mimeType: V.string({ required: true, max: 120 }),
    data: V.string({ required: true, max: 140_000_000 }),   // base64 payload
    conversationId: V.string({ max: 64 })
  }),
  wrap(async (req, res) => {
    const { filename, mimeType, data, conversationId } = req.data;
    if (!ALLOWED.test(mimeType)) throw err.badRequest(`Files of type ${mimeType} are not supported`);

    const base64 = data.includes(',') ? data.split(',').pop() : data;
    let buf;
    try { buf = Buffer.from(base64, 'base64'); }
    catch { throw err.badRequest('File data is not valid base64'); }

    const maxMB = A.planOf(req.user).maxAttachmentMB;
    if (buf.length > maxMB * 1024 * 1024) throw err.payload(`Files must be under ${maxMB} MB on your plan`);
    if (!buf.length) throw err.badRequest('File is empty');

    if (conversationId && !db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, req.user.id)) {
      throw err.notFound('Conversation not found');
    }

    // Store with a random name; never trust the client's filename on disk.
    const safeExt = (path.extname(filename) || '').replace(/[^.\w]/g, '').slice(0, 12);
    const storedName = `${crypto.randomBytes(16).toString('hex')}${safeExt}`;
    const userDir = path.join(UPLOAD_DIR, req.user.id);
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, storedName), buf, { mode: 0o600 });

    // Extract text so the model can actually read the file.
    let extracted = null;
    if (TEXTUAL.test(mimeType)) {
      extracted = buf.toString('utf8').slice(0, 200_000);
    } else if (mimeType === 'application/pdf') {
      const raw = buf.toString('latin1');
      const chunks = [...raw.matchAll(/\(([^()\\]{3,})\)/g)].map(m => m[1]);
      if (chunks.length) extracted = chunks.join(' ').replace(/\s+/g, ' ').slice(0, 200_000);
    }

    const id = uuid();
    db.prepare(`INSERT INTO attachments (id, user_id, conversation_id, filename, mime_type, size_bytes, storage_path, extracted_text)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, req.user.id, conversationId || null, filename.slice(0, 255), mimeType, buf.length,
           path.join(req.user.id, storedName), extracted);

    res.status(201).json({
      success: true,
      data: {
        attachment: {
          id, filename, mimeType, size: buf.length,
          hasText: !!extracted, textPreview: extracted ? extracted.slice(0, 300) : null
        }
      }
    });
  })
);

router.get('/', wrap(async (req, res) => {
  const files = db.prepare(`SELECT id, filename, mime_type, size_bytes, conversation_id, created_at
                            FROM attachments WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`).all(req.user.id);
  const totalBytes = db.prepare('SELECT COALESCE(SUM(size_bytes),0) s FROM attachments WHERE user_id = ?').get(req.user.id).s;
  res.json({ success: true, data: { files, totalBytes } });
}));

router.get('/:id', wrap(async (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!a) throw err.notFound('File not found');
  const full = path.join(UPLOAD_DIR, a.storage_path);
  // Guard against path traversal.
  if (!full.startsWith(UPLOAD_DIR) || !fs.existsSync(full)) throw err.notFound('File is no longer stored');
  res.setHeader('Content-Type', a.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(a.filename)}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(full).pipe(res);
}));

router.delete('/:id', wrap(async (req, res) => {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!a) throw err.notFound('File not found');
  const full = path.join(UPLOAD_DIR, a.storage_path);
  if (full.startsWith(UPLOAD_DIR)) { try { fs.unlinkSync(full); } catch {} }
  db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  res.json({ success: true, data: { message: 'File deleted' } });
}));

module.exports = router;
