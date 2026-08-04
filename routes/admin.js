const router = require('express').Router();
const db = require('../db');
const { err, wrap } = require('../lib/errors');
const { V, body, query } = require('../lib/validate');
const A = require('../lib/auth');

router.use(A.authenticate, A.requireAdmin);

// ─── OVERVIEW ───
router.get('/stats', wrap(async (req, res) => {
  const c = sql => db.prepare(sql).get().c;
  res.json({
    success: true,
    data: {
      users: {
        total: c('SELECT COUNT(*) c FROM users'),
        active: c('SELECT COUNT(*) c FROM users WHERE is_active = 1'),
        newToday: c("SELECT COUNT(*) c FROM users WHERE created_at > datetime('now','-1 day')"),
        byPlan: db.prepare('SELECT plan, COUNT(*) count FROM users GROUP BY plan').all()
      },
      content: {
        conversations: c('SELECT COUNT(*) c FROM conversations WHERE is_deleted = 0'),
        messages: c('SELECT COUNT(*) c FROM messages WHERE is_deleted = 0'),
        attachments: c('SELECT COUNT(*) c FROM attachments'),
        shares: c('SELECT COUNT(*) c FROM shares WHERE is_active = 1')
      },
      activity: {
        messages24h: c("SELECT COUNT(*) c FROM usage_events WHERE created_at > datetime('now','-1 day')"),
        errors24h: c("SELECT COUNT(*) c FROM usage_events WHERE ok = 0 AND created_at > datetime('now','-1 day')"),
        avgLatencyMs: Math.round(db.prepare("SELECT AVG(latency_ms) a FROM usage_events WHERE latency_ms IS NOT NULL AND created_at > datetime('now','-1 day')").get().a || 0),
        byModel: db.prepare(`SELECT model, COUNT(*) count, COALESCE(SUM(tokens),0) tokens FROM usage_events
                             WHERE created_at > datetime('now','-7 days') AND model IS NOT NULL GROUP BY model`).all()
      },
      feedback: db.prepare('SELECT rating, COUNT(*) count FROM feedback GROUP BY rating').all()
    }
  });
}));

// ─── USERS ───
router.get('/users',
  query({ search: V.string({ max: 100 }), plan: V.enum(['FREE', 'PRO', 'ENTERPRISE']), limit: V.int({ min: 1, max: 200, default: 50 }), offset: V.int({ min: 0, default: 0 }) }),
  wrap(async (req, res) => {
    const params = [];
    let sql = `SELECT id, email, username, display_name, plan, role, is_active, email_verified,
               usage_today, total_messages, total_tokens, last_login_at, created_at FROM users WHERE 1=1`;
    if (req.q.search) { sql += ' AND (email LIKE ? OR username LIKE ? OR display_name LIKE ?)'; const s = `%${req.q.search}%`; params.push(s, s, s); }
    if (req.q.plan) { sql += ' AND plan = ?'; params.push(req.q.plan); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(req.q.limit, req.q.offset);
    res.json({ success: true, data: { users: db.prepare(sql).all(...params), total: db.prepare('SELECT COUNT(*) c FROM users').get().c } });
  })
);

router.patch('/users/:id',
  body({ plan: V.enum(['FREE', 'PRO', 'ENTERPRISE']), role: V.enum(['user', 'admin']), is_active: V.bool() }),
  wrap(async (req, res) => {
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
    if (!u) throw err.notFound('User not found');
    if (req.params.id === req.user.id && req.data.role === 'user') throw err.badRequest('You cannot remove your own admin role');

    const sets = [], vals = [];
    for (const k of ['plan', 'role']) if (req.data[k] !== undefined) { sets.push(`${k} = ?`); vals.push(req.data[k]); }
    if (req.data.is_active !== undefined) { sets.push('is_active = ?'); vals.push(req.data.is_active ? 1 : 0); }
    if (!sets.length) throw err.badRequest('No fields to update');
    vals.push(req.params.id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    A.audit(req.user.id, 'admin.update_user', req.params.id, req, req.data);
    res.json({ success: true, data: { user: db.prepare(`SELECT ${A.PUBLIC_USER_COLS} FROM users WHERE id = ?`).get(req.params.id) } });
  })
);

// ─── AUDIT LOG ───
router.get('/audit', query({ limit: V.int({ min: 1, max: 500, default: 100 }), action: V.string({ max: 60 }) }), wrap(async (req, res) => {
  const params = [];
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  if (req.q.action) { sql += ' AND action = ?'; params.push(req.q.action); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(req.q.limit);
  res.json({ success: true, data: { entries: db.prepare(sql).all(...params) } });
}));

// ─── FEEDBACK REVIEW ───
router.get('/feedback', query({ rating: V.enum(['up', 'down']), limit: V.int({ min: 1, max: 200, default: 50 }) }), wrap(async (req, res) => {
  const params = [];
  let sql = `SELECT f.*, substr(m.content,1,300) message_excerpt, u.username
             FROM feedback f JOIN messages m ON m.id = f.message_id JOIN users u ON u.id = f.user_id WHERE 1=1`;
  if (req.q.rating) { sql += ' AND f.rating = ?'; params.push(req.q.rating); }
  sql += ' ORDER BY f.created_at DESC LIMIT ?';
  params.push(req.q.limit);
  res.json({ success: true, data: { feedback: db.prepare(sql).all(...params) } });
}));

// ─── MAINTENANCE ───
router.post('/maintenance/purge-trash', body({ olderThanDays: V.int({ min: 0, max: 365, default: 30 }) }), wrap(async (req, res) => {
  const rows = db.prepare(`SELECT id FROM conversations WHERE is_deleted = 1 AND deleted_at < datetime('now', ?)`)
    .all(`-${req.data.olderThanDays} days`);
  rows.forEach(r => db.fts.removeConversation(r.id));
  const r = db.prepare(`DELETE FROM conversations WHERE is_deleted = 1 AND deleted_at < datetime('now', ?)`)
    .run(`-${req.data.olderThanDays} days`);
  res.json({ success: true, data: { purged: r.changes } });
}));

router.post('/maintenance/vacuum', wrap(async (req, res) => {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now') OR is_valid = 0").run();
  db.prepare("DELETE FROM tokens WHERE expires_at < datetime('now') OR used = 1").run();
  db.exec('VACUUM');
  res.json({ success: true, data: { message: 'Database compacted and stale records cleared' } });
}));

module.exports = router;
