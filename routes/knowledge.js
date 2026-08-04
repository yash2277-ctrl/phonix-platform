const router = require('express').Router();
const db = require('../db');
const { err, wrap } = require('../lib/errors');
const { V, body, query } = require('../lib/validate');
const A = require('../lib/auth');
const rag = require('../lib/rag');
const tools = require('../lib/tools');

router.use(A.authenticate);

// ─── LIST DOCUMENTS ───
router.get('/', query({ projectId: V.string({ max: 64 }) }), wrap(async (req, res) => {
  const params = [req.user.id];
  let sql = `SELECT id, title, source, mime_type, chunk_count, project_id, length(content) size, created_at
             FROM knowledge_docs WHERE user_id = ?`;
  if (req.q.projectId) { sql += ' AND project_id = ?'; params.push(req.q.projectId); }
  sql += ' ORDER BY created_at DESC';
  const docs = db.prepare(sql).all(...params);
  const chunks = db.prepare('SELECT COUNT(*) c FROM knowledge_chunks WHERE user_id = ?').get(req.user.id).c;
  res.json({ success: true, data: { documents: docs, totalChunks: chunks } });
}));

// ─── ADD FROM TEXT ───
router.post('/',
  body({
    title: V.string({ required: true, min: 1, max: 200 }),
    content: V.string({ required: true, min: 1, max: 1_000_000 }),
    projectId: V.string({ max: 64 }), source: V.string({ max: 300 })
  }),
  wrap(async (req, res) => {
    if (req.data.projectId && !db.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(req.data.projectId, req.user.id)) {
      throw err.notFound('Project not found');
    }
    const doc = rag.indexDocument({
      userId: req.user.id, projectId: req.data.projectId || null,
      title: req.data.title, content: req.data.content, source: req.data.source || 'manual'
    });
    res.status(201).json({ success: true, data: { document: doc } });
  })
);

// ─── ADD FROM AN UPLOADED FILE ───
router.post('/from-file', body({ attachmentId: V.string({ required: true, max: 64 }), projectId: V.string({ max: 64 }) }),
  wrap(async (req, res) => {
    const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND user_id = ?').get(req.data.attachmentId, req.user.id);
    if (!att) throw err.notFound('File not found');
    if (!att.extracted_text) throw err.badRequest('No readable text could be extracted from that file');
    const doc = rag.indexDocument({
      userId: req.user.id, projectId: req.data.projectId || null,
      title: att.filename, content: att.extracted_text, source: `upload:${att.id}`, mimeType: att.mime_type
    });
    res.status(201).json({ success: true, data: { document: doc } });
  })
);

// ─── ADD FROM A URL ───
router.post('/from-url', body({ url: V.string({ required: true, max: 2000 }), projectId: V.string({ max: 64 }) }),
  wrap(async (req, res) => {
    let page;
    try { page = await tools.execute('fetch_url', { url: req.data.url }, { userId: req.user.id }); }
    catch (e) { throw err.badRequest(`Could not fetch that URL: ${e.message}`); }
    if (!page.ok) throw err.badRequest(`Could not fetch that URL: ${page.error}`);

    const content = page.output.type === 'json' ? JSON.stringify(page.output.data, null, 2) : page.output.content;
    if (!content?.trim()) throw err.badRequest('That page had no readable text');
    const doc = rag.indexDocument({
      userId: req.user.id, projectId: req.data.projectId || null,
      title: page.output.title || req.data.url, content, source: req.data.url
    });
    res.status(201).json({ success: true, data: { document: doc } });
  })
);

// ─── SEARCH (with relevance scores) ───
router.get('/search',
  query({ q: V.string({ required: true, min: 1, max: 300 }), projectId: V.string({ max: 64 }), limit: V.int({ min: 1, max: 20, default: 5 }) }),
  wrap(async (req, res) => {
    const hits = rag.search({ userId: req.user.id, projectId: req.q.projectId || null, query: req.q.q, limit: req.q.limit });
    res.json({
      success: true,
      data: {
        query: req.q.q,
        results: hits.map((h, i) => ({
          rank: i + 1, docId: h.docId, title: h.title, part: h.ordinal + 1,
          excerpt: h.content.slice(0, 600), score: Number(h.score.toFixed(3)), matchedTerms: h.matchedTerms
        }))
      }
    });
  })
);

// ─── GROUNDED ANSWER PREVIEW ───
router.post('/ask', body({ question: V.string({ required: true, min: 1, max: 1000 }), projectId: V.string({ max: 64 }) }),
  wrap(async (req, res) => {
    const grounded = rag.buildGroundedContext({ userId: req.user.id, projectId: req.data.projectId || null, query: req.data.question });
    if (!grounded) return res.json({ success: true, data: { grounded: false, message: 'Nothing relevant found in your knowledge base' } });
    res.json({ success: true, data: { grounded: true, sources: grounded.sources } });
  })
);

router.get('/:id', wrap(async (req, res) => {
  const doc = db.prepare('SELECT * FROM knowledge_docs WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!doc) throw err.notFound('Document not found');
  const chunks = db.prepare('SELECT id, ordinal, content, token_count FROM knowledge_chunks WHERE doc_id = ? ORDER BY ordinal').all(doc.id);
  res.json({ success: true, data: { document: doc, chunks } });
}));

router.delete('/:id', wrap(async (req, res) => {
  if (!rag.deleteDocument(req.params.id, req.user.id)) throw err.notFound('Document not found');
  res.json({ success: true, data: { message: 'Document removed from knowledge base' } });
}));

module.exports = router;
