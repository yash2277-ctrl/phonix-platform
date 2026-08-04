const router = require('express').Router();
const { v4: uuid } = require('uuid');
const db = require('../db');
const { err, wrap } = require('../lib/errors');
const { V, body, query } = require('../lib/validate');
const A = require('../lib/auth');
const ai = require('../lib/ai');

router.use(A.authenticate);

function mustOwnConversation(cid, userId) {
  const c = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(cid, userId);
  if (!c) throw err.notFound('Conversation not found');
  return c;
}
function mustOwnMessage(mid, userId) {
  const m = db.prepare(`SELECT m.*, c.user_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
                        WHERE m.id = ?`).get(mid);
  if (!m || m.user_id !== userId) throw err.notFound('Message not found');
  return m;
}
const attachmentsFor = mid => db.prepare(
  'SELECT id, filename, mime_type, size_bytes FROM attachments WHERE message_id = ?'
).all(mid);

// ─── LIST MESSAGES ───
router.get('/:conversationId',
  query({ limit: V.int({ min: 1, max: 200, default: 100 }), before: V.string({ max: 40 }), order: V.enum(['asc', 'desc'], { default: 'asc' }) }),
  wrap(async (req, res) => {
    mustOwnConversation(req.params.conversationId, req.user.id);
    const params = [req.params.conversationId];
    let sql = 'SELECT * FROM messages WHERE conversation_id = ? AND is_deleted = 0';
    if (req.q.before) { sql += ' AND created_at < ?'; params.push(req.q.before); }
    sql += ` ORDER BY created_at ${req.q.order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`;
    params.push(req.q.limit);

    const messages = db.prepare(sql).all(...params).map(m => ({
      ...m,
      attachments: attachmentsFor(m.id),
      feedback: db.prepare('SELECT rating FROM feedback WHERE message_id = ? AND user_id = ?').get(m.id, req.user.id)?.rating || null
    }));
    res.json({ success: true, data: { messages } });
  })
);

// ─── CREATE MESSAGE ───
router.post('/:conversationId',
  body({
    role: V.enum(['user', 'assistant', 'system'], { required: true }),
    content: V.string({ required: true, min: 1, max: 100000 }),
    model: V.string({ max: 40 }), tokens: V.int({ min: 0 }),
    attachmentIds: V.array({ max: 10 })
  }),
  wrap(async (req, res) => {
    const conv = mustOwnConversation(req.params.conversationId, req.user.id);
    const { role, content, model } = req.data;
    const tokens = req.data.tokens || ai.estimateTokens(content);
    const id = uuid();

    db.transaction(() => {
      db.prepare('INSERT INTO messages (id, conversation_id, role, content, model, tokens) VALUES (?,?,?,?,?,?)')
        .run(id, conv.id, role, content, model || null, tokens);
      db.fts.index({ id, conversation_id: conv.id, content });

      if (req.data.attachmentIds?.length) {
        const upd = db.prepare('UPDATE attachments SET message_id = ? WHERE id = ? AND user_id = ?');
        req.data.attachmentIds.forEach(aid => upd.run(id, aid, req.user.id));
      }

      db.prepare(`UPDATE conversations SET message_count = message_count + 1, total_tokens = total_tokens + ?,
                  last_message_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(tokens, conv.id);

      if (role === 'user') {
        A.rollUsage(req.user.id);
        db.prepare('UPDATE users SET total_messages = total_messages + 1, usage_today = usage_today + 1, total_tokens = total_tokens + ? WHERE id = ?')
          .run(tokens, req.user.id);
        db.prepare('INSERT INTO usage_events (id, user_id, kind, model, tokens) VALUES (?,?,?,?,?)')
          .run(uuid(), req.user.id, 'message', model || conv.model, tokens);

        if (conv.title === 'New Conversation') {
          db.prepare('UPDATE conversations SET title = ? WHERE id = ?')
            .run(content.slice(0, 50) + (content.length > 50 ? '…' : ''), conv.id);
        }
        // Learn durable facts the user states about themselves.
        for (const mem of ai.extractMemories(content)) {
          try {
            db.prepare(`INSERT INTO memories (id, user_id, type, key, value, source, updated_at)
                        VALUES (?,?,?,?,?, 'auto', datetime('now'))
                        ON CONFLICT(user_id, type, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
              .run(uuid(), req.user.id, mem.type, mem.key, mem.value);
          } catch {}
        }
      }
    })();

    res.status(201).json({ success: true, data: { message: db.prepare('SELECT * FROM messages WHERE id = ?').get(id) } });
  })
);

// ─── EDIT MESSAGE (keeps version history) ───
router.patch('/:messageId',
  body({ content: V.string({ required: true, min: 1, max: 100000 }) }),
  wrap(async (req, res) => {
    const m = mustOwnMessage(req.params.messageId, req.user.id);
    const version = db.prepare('SELECT COUNT(*) c FROM message_versions WHERE message_id = ?').get(m.id).c + 1;

    db.transaction(() => {
      db.prepare('INSERT INTO message_versions (id, message_id, content, version) VALUES (?,?,?,?)')
        .run(uuid(), m.id, m.content, version);
      db.prepare("UPDATE messages SET content = ?, is_edited = 1, tokens = ? WHERE id = ?")
        .run(req.data.content, ai.estimateTokens(req.data.content), m.id);
      db.fts.update(m.id, req.data.content);
    })();

    res.json({ success: true, data: { message: db.prepare('SELECT * FROM messages WHERE id = ?').get(m.id), versionsSaved: version } });
  })
);

router.get('/:messageId/versions', wrap(async (req, res) => {
  const m = mustOwnMessage(req.params.messageId, req.user.id);
  const versions = db.prepare('SELECT id, content, version, created_at FROM message_versions WHERE message_id = ? ORDER BY version DESC').all(m.id);
  res.json({ success: true, data: { current: m.content, versions } });
}));

// ─── DELETE MESSAGE (soft, or truncate the thread from here) ───
router.delete('/:messageId', query({ andAfter: V.bool() }), wrap(async (req, res) => {
  const m = mustOwnMessage(req.params.messageId, req.user.id);
  let removed = 1;

  if (req.q.andAfter) {
    const later = db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND created_at >= ? AND is_deleted = 0')
      .all(m.conversation_id, m.created_at);
    db.transaction(() => {
      later.forEach(x => { db.prepare('UPDATE messages SET is_deleted = 1 WHERE id = ?').run(x.id); db.fts.remove(x.id); });
    })();
    removed = later.length;
  } else {
    db.prepare('UPDATE messages SET is_deleted = 1 WHERE id = ?').run(m.id);
    db.fts.remove(m.id);
  }

  db.prepare('UPDATE conversations SET message_count = MAX(message_count - ?, 0) WHERE id = ?').run(removed, m.conversation_id);
  res.json({ success: true, data: { deleted: removed } });
}));

// ─── FEEDBACK ───
router.post('/:messageId/feedback',
  body({ rating: V.enum(['up', 'down'], { required: true }), reason: V.string({ max: 100 }), comment: V.string({ max: 1000 }) }),
  wrap(async (req, res) => {
    const m = mustOwnMessage(req.params.messageId, req.user.id);
    db.prepare(`INSERT INTO feedback (id, message_id, user_id, rating, reason, comment) VALUES (?,?,?,?,?,?)
                ON CONFLICT(message_id, user_id) DO UPDATE SET rating = excluded.rating,
                reason = excluded.reason, comment = excluded.comment, created_at = datetime('now')`)
      .run(uuid(), m.id, req.user.id, req.data.rating, req.data.reason || null, req.data.comment || null);
    res.json({ success: true, data: { message: 'Thanks for the feedback' } });
  })
);

router.delete('/:messageId/feedback', wrap(async (req, res) => {
  mustOwnMessage(req.params.messageId, req.user.id);
  db.prepare('DELETE FROM feedback WHERE message_id = ? AND user_id = ?').run(req.params.messageId, req.user.id);
  res.json({ success: true, data: { message: 'Feedback removed' } });
}));

module.exports = router;
