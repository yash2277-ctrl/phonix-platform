const router = require('express').Router();
const db = require('../db');
const { wrap } = require('../lib/errors');
const { V, query } = require('../lib/validate');
const A = require('../lib/auth');
const rag = require('../lib/rag');

router.use(A.authenticate);

// Escape user input for FTS5 by quoting each term (prevents syntax errors/injection).
const ftsQuery = q => q.trim().split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
const snippet = (text, term) => {
  const i = text.toLowerCase().indexOf(term.toLowerCase().split(/\s+/)[0] || '');
  const start = Math.max(0, i - 60);
  return (start > 0 ? '…' : '') + text.slice(start, start + 200) + (text.length > start + 200 ? '…' : '');
};

// ─── GLOBAL SEARCH: messages + conversations + projects + prompts ───
router.get('/',
  query({
    q: V.string({ required: true, min: 1, max: 200 }),
    scope: V.enum(['all', 'messages', 'conversations', 'projects', 'prompts', 'knowledge', 'artifacts'], { default: 'all' }),
    limit: V.int({ min: 1, max: 50, default: 20 })
  }),
  wrap(async (req, res) => {
    const { q, scope, limit } = req.q;
    const uid = req.user.id;
    const out = {};

    if (scope === 'all' || scope === 'messages') {
      let rows = [];
      if (db.ftsEnabled) {
        try {
          rows = db.prepare(`
            SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title
            FROM messages_fts f
            JOIN messages m ON m.id = f.message_id
            JOIN conversations c ON c.id = m.conversation_id
            WHERE messages_fts MATCH ? AND c.user_id = ? AND m.is_deleted = 0 AND c.is_deleted = 0
            ORDER BY rank LIMIT ?`).all(ftsQuery(q), uid, limit);
        } catch { rows = []; }
      }
      if (!rows.length) {
        rows = db.prepare(`
          SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title
          FROM messages m JOIN conversations c ON c.id = m.conversation_id
          WHERE c.user_id = ? AND m.is_deleted = 0 AND c.is_deleted = 0 AND m.content LIKE ?
          ORDER BY m.created_at DESC LIMIT ?`).all(uid, `%${q}%`, limit);
      }
      out.messages = rows.map(r => ({
        id: r.id, conversationId: r.conversation_id, conversationTitle: r.title,
        role: r.role, snippet: snippet(r.content, q), createdAt: r.created_at
      }));
    }

    if (scope === 'all' || scope === 'conversations') {
      out.conversations = db.prepare(`SELECT id, title, model, message_count, last_message_at FROM conversations
                                      WHERE user_id = ? AND is_deleted = 0 AND title LIKE ?
                                      ORDER BY COALESCE(last_message_at, created_at) DESC LIMIT ?`)
        .all(uid, `%${q}%`, limit);
    }
    if (scope === 'all' || scope === 'projects') {
      out.projects = db.prepare(`SELECT id, name, description, color FROM projects
                                 WHERE user_id = ? AND (name LIKE ? OR description LIKE ?) LIMIT ?`)
        .all(uid, `%${q}%`, `%${q}%`, limit);
    }
    if (scope === 'all' || scope === 'prompts') {
      out.prompts = db.prepare(`SELECT id, title, description, category FROM prompts
                                WHERE user_id = ? AND (title LIKE ? OR body LIKE ?) LIMIT ?`)
        .all(uid, `%${q}%`, `%${q}%`, limit);
    }

    // Knowledge is searched through the BM25 index rather than LIKE, so results are
    // ranked by relevance and land on the matching passage instead of the whole file.
    if (scope === 'all' || scope === 'knowledge') {
      out.knowledge = rag.search({ userId: uid, query: q, limit })
        .map(h => ({
          id: h.docId, chunkId: h.chunkId, title: h.title, part: h.ordinal + 1,
          snippet: snippet(h.content, q), score: Number(h.score.toFixed(3))
        }));
    }

    if (scope === 'all' || scope === 'artifacts') {
      out.artifacts = db.prepare(`SELECT id, identifier, title, type, language, version, updated_at FROM artifacts
                                  WHERE user_id = ? AND (title LIKE ? OR content LIKE ?)
                                  ORDER BY updated_at DESC LIMIT ?`)
        .all(uid, `%${q}%`, `%${q}%`, limit);
    }

    const total = Object.values(out).reduce((n, arr) => n + (arr?.length || 0), 0);
    res.json({ success: true, data: { query: q, total, results: out, engine: db.ftsEnabled ? 'fts5' : 'like' } });
  })
);

module.exports = router;
