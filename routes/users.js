const router = require('express').Router();
const db = require('../db');
const { err, wrap } = require('../lib/errors');
const { V, body } = require('../lib/validate');
const A = require('../lib/auth');

router.use(A.authenticate);

const publicUser = id => db.prepare(`SELECT ${A.PUBLIC_USER_COLS} FROM users WHERE id = ?`).get(id);

// ─── PROFILE ───
router.get('/me', wrap(async (req, res) => {
  A.rollUsage(req.user.id);
  const user = publicUser(req.user.id);
  const plan = A.planOf(user);
  res.json({
    success: true,
    data: {
      user,
      limits: plan,
      usage: { today: user.usage_today, limit: plan.dailyMessages, remaining: Math.max(0, plan.dailyMessages - user.usage_today) }
    }
  });
}));

router.patch('/me',
  body({
    displayName: V.string({ max: 60 }),
    bio: V.string({ max: 500 }),
    avatar_url: V.string({ max: 500 }),
    customInstructions: V.string({ max: 4000 }),
    preferences: V.object()
  }),
  wrap(async (req, res) => {
    const map = {
      displayName: 'display_name',
      bio: 'bio',
      avatar_url: 'avatar_url',
      customInstructions: 'custom_instructions'
    };
    const sets = [], vals = [];
    for (const [k, col] of Object.entries(map)) {
      if (req.data[k] !== undefined) { sets.push(`${col} = ?`); vals.push(req.data[k]); }
    }
    if (req.data.preferences !== undefined) { sets.push('preferences = ?'); vals.push(JSON.stringify(req.data.preferences)); }
    if (!sets.length) throw err.badRequest('No fields to update');

    sets.push("updated_at = datetime('now')");
    vals.push(req.user.id);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    res.json({ success: true, data: { user: publicUser(req.user.id) } });
  })
);

// ─── PASSWORD ───
router.patch('/me/password',
  body({ currentPassword: V.string({ required: true, max: 200 }), newPassword: V.password({ required: true, min: 8 }) }),
  wrap(async (req, res) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!A.verifyPassword(req.data.currentPassword, row.password_hash)) {
      throw err.badRequest('Your current password is incorrect');
    }
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
      .run(A.hashPassword(req.data.newPassword), req.user.id);
    // Invalidate other devices after a credential change.
    db.prepare('UPDATE sessions SET is_valid = 0 WHERE user_id = ?').run(req.user.id);
    A.audit(req.user.id, 'user.change_password', req.user.id, req);
    res.json({ success: true, data: { message: 'Password updated. Other devices were signed out.' } });
  })
);

// ─── USAGE & STATS ───
router.get('/me/usage', wrap(async (req, res) => {
  A.rollUsage(req.user.id);
  const u = publicUser(req.user.id);
  const plan = A.planOf(u);
  const daily = db.prepare(`SELECT date(created_at) day, COUNT(*) messages, COALESCE(SUM(tokens),0) tokens
                            FROM usage_events WHERE user_id = ? AND created_at > datetime('now','-30 days')
                            GROUP BY day ORDER BY day DESC`).all(req.user.id);
  const byModel = db.prepare(`SELECT model, COUNT(*) count, COALESCE(SUM(tokens),0) tokens
                              FROM usage_events WHERE user_id = ? AND model IS NOT NULL
                              GROUP BY model ORDER BY count DESC`).all(req.user.id);
  res.json({
    success: true,
    data: {
      today: { used: u.usage_today, limit: plan.dailyMessages, remaining: Math.max(0, plan.dailyMessages - u.usage_today) },
      totals: { messages: u.total_messages, tokens: u.total_tokens },
      daily, byModel
    }
  });
}));

router.get('/me/stats', wrap(async (req, res) => {
  const one = sql => db.prepare(sql).get(req.user.id).c;
  res.json({
    success: true,
    data: {
      conversations: one('SELECT COUNT(*) c FROM conversations WHERE user_id = ? AND is_deleted = 0'),
      archived: one('SELECT COUNT(*) c FROM conversations WHERE user_id = ? AND is_archived = 1 AND is_deleted = 0'),
      trashed: one('SELECT COUNT(*) c FROM conversations WHERE user_id = ? AND is_deleted = 1'),
      projects: one('SELECT COUNT(*) c FROM projects WHERE user_id = ?'),
      memories: one('SELECT COUNT(*) c FROM memories WHERE user_id = ? AND is_active = 1'),
      prompts: one('SELECT COUNT(*) c FROM prompts WHERE user_id = ?'),
      attachments: one('SELECT COUNT(*) c FROM attachments WHERE user_id = ?'),
      shares: one('SELECT COUNT(*) c FROM shares WHERE user_id = ? AND is_active = 1'),
      messages: db.prepare(`SELECT COUNT(*) c FROM messages m JOIN conversations c2 ON m.conversation_id = c2.id
                            WHERE c2.user_id = ?`).get(req.user.id).c
    }
  });
}));

// ─── FULL DATA EXPORT (GDPR-friendly) ───
router.get('/me/export', wrap(async (req, res) => {
  const uid = req.user.id;
  const conversations = db.prepare('SELECT * FROM conversations WHERE user_id = ? AND is_deleted = 0').all(uid);
  const withMessages = conversations.map(c => ({
    ...c,
    messages: db.prepare('SELECT id, role, content, model, tokens, created_at FROM messages WHERE conversation_id = ? AND is_deleted = 0 ORDER BY created_at').all(c.id)
  }));
  const payload = {
    exportedAt: new Date().toISOString(),
    user: db.prepare(`SELECT ${A.PUBLIC_USER_COLS} FROM users WHERE id = ?`).get(uid),
    projects: db.prepare('SELECT * FROM projects WHERE user_id = ?').all(uid),
    conversations: withMessages,
    memories: db.prepare('SELECT * FROM memories WHERE user_id = ?').all(uid),
    prompts: db.prepare('SELECT * FROM prompts WHERE user_id = ?').all(uid),
    tags: db.prepare('SELECT * FROM tags WHERE user_id = ?').all(uid)
  };
  A.audit(uid, 'user.export', uid, req);
  res.setHeader('Content-Disposition', `attachment; filename="phonix-export-${Date.now()}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(payload, null, 2));
}));

// ─── DELETE ACCOUNT ───
router.delete('/me',
  body({ password: V.string({ required: true, max: 200 }), confirm: V.string({ max: 50 }) }),
  wrap(async (req, res) => {
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!A.verifyPassword(req.data.password, row.password_hash)) throw err.badRequest('Password is incorrect');
    if (req.data.confirm !== 'DELETE') throw err.badRequest('Type DELETE to confirm account deletion');

    // Cascades remove conversations, messages, memories, keys, sessions.
    db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
    res.clearCookie('refreshToken', { ...A.REFRESH_COOKIE, maxAge: undefined });
    A.audit(null, 'user.delete', req.user.id, req);
    res.json({ success: true, data: { message: 'Your account and all data have been deleted' } });
  })
);

module.exports = router;
