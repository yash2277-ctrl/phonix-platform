const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(process.env.DB_PATH || path.join(__dirname, 'phonix.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// ═══════════════════════════════════════════
//                 SCHEMA
// ═══════════════════════════════════════════
// Held in a constant rather than passed straight to exec(), because the migration
// step below reads it back to work out what an older database is missing. One
// declaration, two consumers — so the two can never disagree.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    plan TEXT DEFAULT 'FREE' CHECK(plan IN ('FREE','PRO','ENTERPRISE')),
    role TEXT DEFAULT 'user' CHECK(role IN ('user','admin')),
    avatar_url TEXT,
    bio TEXT,
    custom_instructions TEXT,
    preferences TEXT DEFAULT '{}',
    email_verified INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    usage_today INTEGER DEFAULT 0,
    usage_reset_at TEXT DEFAULT (datetime('now')),
    total_messages INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    last_login_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token TEXT UNIQUE NOT NULL,
    device_info TEXT,
    ip_address TEXT,
    is_valid INTEGER DEFAULT 1,
    last_used_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('PASSWORD_RESET','EMAIL_VERIFY')),
    used INTEGER DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT UNIQUE NOT NULL,
    prefix TEXT NOT NULL,
    scopes TEXT DEFAULT 'chat:read,chat:write',
    last_used_at TEXT,
    request_count INTEGER DEFAULT 0,
    revoked INTEGER DEFAULT 0,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    system_prompt TEXT,
    color TEXT DEFAULT '#8ba4ff',
    icon TEXT,
    is_archived INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    parent_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    title TEXT DEFAULT 'New Conversation',
    model TEXT DEFAULT 'blaze',
    system_prompt TEXT,
    temperature REAL DEFAULT 0.7,
    is_pinned INTEGER DEFAULT 0,
    is_archived INTEGER DEFAULT 0,
    is_deleted INTEGER DEFAULT 0,
    deleted_at TEXT,
    message_count INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    last_message_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    content TEXT NOT NULL,
    model TEXT,
    tokens INTEGER DEFAULT 0,
    finish_reason TEXT,
    latency_ms INTEGER,
    is_edited INTEGER DEFAULT 0,
    is_deleted INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS message_versions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    version INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating TEXT NOT NULL CHECK(rating IN ('up','down')),
    reason TEXT,
    comment TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    storage_path TEXT NOT NULL,
    extracted_text TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT DEFAULT 'FACT' CHECK(type IN ('PREFERENCE','FACT','CONTEXT','INSTRUCTION')),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    source TEXT DEFAULT 'manual',
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, type, key)
  );

  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#8ba4ff',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, name)
  );

  CREATE TABLE IF NOT EXISTS conversation_tags (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, tag_id)
  );

  CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug TEXT UNIQUE NOT NULL,
    password_hash TEXT,
    view_count INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    description TEXT,
    category TEXT DEFAULT 'general',
    use_count INTEGER DEFAULT 0,
    is_favorite INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    model TEXT,
    tokens INTEGER DEFAULT 0,
    latency_ms INTEGER,
    ok INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target TEXT,
    ip_address TEXT,
    meta TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- ═══ ARTIFACTS: versioned documents/code the assistant produces ═══
  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    identifier TEXT NOT NULL,
    title TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text/markdown',
    language TEXT,
    content TEXT NOT NULL,
    version INTEGER DEFAULT 1,
    is_published INTEGER DEFAULT 0,
    publish_slug TEXT UNIQUE,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, identifier)
  );

  CREATE TABLE IF NOT EXISTS artifact_versions (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    version INTEGER NOT NULL,
    change_note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- ═══ KNOWLEDGE BASE (RAG) ═══
  CREATE TABLE IF NOT EXISTS knowledge_docs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    source TEXT,
    mime_type TEXT,
    content TEXT NOT NULL,
    chunk_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS knowledge_chunks (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT,
    ordinal INTEGER NOT NULL,
    content TEXT NOT NULL,
    token_count INTEGER DEFAULT 0
  );

  -- Inverted index for BM25 scoring (no external embedding service required).
  CREATE TABLE IF NOT EXISTS knowledge_terms (
    term TEXT NOT NULL,
    chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    project_id TEXT,
    freq INTEGER DEFAULT 1,
    PRIMARY KEY (term, chunk_id)
  );

  -- ═══ TOOL USE ═══
  CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    tool TEXT NOT NULL,
    input TEXT,
    output TEXT,
    ok INTEGER DEFAULT 1,
    error TEXT,
    duration_ms INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- ═══ CITATIONS ═══
  CREATE TABLE IF NOT EXISTS citations (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT,
    title TEXT,
    url TEXT,
    excerpt TEXT
  );

  -- ═══ WEBHOOKS ═══
  CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    secret TEXT NOT NULL,
    events TEXT NOT NULL,
    is_active INTEGER DEFAULT 1,
    failure_count INTEGER DEFAULT 0,
    last_status INTEGER,
    last_fired_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  -- ═══ BATCH JOBS ═══
  CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
    total INTEGER DEFAULT 0,
    completed INTEGER DEFAULT 0,
    failed INTEGER DEFAULT 0,
    model TEXT,
    requests TEXT NOT NULL,
    results TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    finished_at TEXT
  );

`;

db.exec(SCHEMA);

// ─── FULL-TEXT SEARCH (FTS5, with graceful fallback) ───
let ftsEnabled = false;
try {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content, message_id UNINDEXED, conversation_id UNINDEXED, tokenize='porter unicode61'
    );
  `);
  ftsEnabled = true;
} catch (e) {
  console.warn('⚠  FTS5 unavailable, falling back to LIKE search:', e.message);
}
db.ftsEnabled = ftsEnabled;

// ═══════════════════════════════════════════
//          MIGRATIONS (safe to re-run)
// ═══════════════════════════════════════════
// `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists, so a
// database created by an earlier version keeps its old shape while the code moves
// on — and the mismatch only surfaces when a query touches the missing column.
//
// Rather than maintain a list of ALTERs by hand (which drifts out of step with the
// schema the moment someone adds a column and forgets), the schema above is parsed
// and compared against what is actually on disk. Anything missing gets added.

/** Split a CREATE TABLE body on commas that are not inside parentheses. */
function splitDefs(body) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(s => s.trim()).filter(Boolean);
}

/** Read the canonical column definitions out of the schema text. */
function parseSchema(sql) {
  const tables = new Map();
  const re = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    // Walk to the matching close paren so nested ( ) in defaults don't confuse us.
    let depth = 1, i = re.lastIndex;
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
      i++;
    }
    const cols = [];
    for (const def of splitDefs(sql.slice(re.lastIndex, i - 1))) {
      // Skip table-level constraints — they aren't columns.
      if (/^(PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CHECK|CONSTRAINT)\b/i.test(def)) continue;
      const name = def.match(/^["`\[]?(\w+)["`\]]?\s/);
      if (name) cols.push({ name: name[1], def });
    }
    tables.set(m[1], cols);
  }
  return tables;
}

/**
 * Bring an existing table up to the current schema.
 *
 * SQLite's ALTER TABLE ADD COLUMN cannot add a PRIMARY KEY or UNIQUE column, and
 * cannot add one whose default is non-constant — `datetime('now')` being the case
 * that matters here. For those, the column is added nullable without its default:
 * existing rows get NULL (correct, the value was never known for them) and new
 * rows go through INSERTs that supply it explicitly.
 */
function reconcile(table, wanted) {
  let existing;
  try { existing = db.prepare(`PRAGMA table_info(${table})`).all(); }
  catch { return []; }
  if (!existing.length) return [];               // table doesn't exist yet — schema just made it

  const have = new Set(existing.map(c => c.name));
  const added = [];

  for (const { name, def } of wanted) {
    if (have.has(name)) continue;
    if (/\bPRIMARY\s+KEY\b|\bUNIQUE\b/i.test(def)) {
      console.warn(`⚠  Cannot add ${table}.${name} (PRIMARY KEY/UNIQUE) — recreate the table to apply it`);
      continue;
    }

    // Drop a non-constant default, and any NOT NULL that would then be unsatisfiable.
    let clause = def.slice(def.indexOf(name) + name.length).trim();
    const paren = clause.search(/DEFAULT\s*\(/i);
    if (paren !== -1) {
      // Walk to the matching paren — `DEFAULT (datetime('now'))` nests, so a lazy
      // regex would stop at the inner one and leave a stray bracket behind.
      let i = clause.indexOf('(', paren), depth = 0, end = i;
      for (; end < clause.length; end++) {
        if (clause[end] === '(') depth++;
        else if (clause[end] === ')' && --depth === 0) { end++; break; }
      }
      clause = (clause.slice(0, paren) + clause.slice(end)).replace(/\s*NOT\s+NULL/i, '');
    } else if (/NOT\s+NULL/i.test(clause) && !/DEFAULT/i.test(clause)) {
      clause = clause.replace(/\s*NOT\s+NULL/i, '');
    }
    clause = clause.trim() || 'TEXT';

    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${clause}`);
      added.push(name);
    } catch (e) {
      console.warn(`⚠  Could not add ${table}.${name}: ${e.message}`);
    }
  }
  return added;
}

const migrated = [];
for (const [table, cols] of parseSchema(SCHEMA)) {
  const added = reconcile(table, cols);
  if (added.length) migrated.push(`${table}: +${added.join(', +')}`);
}
if (migrated.length) {
  console.log('✓ Schema migrated —', migrated.join('  |  '));
}

// ─── INDEXES ───
// Created *after* migrations: an index may reference a column that only exists
// once addColumn() has upgraded an older database. Each is guarded individually
// so a single failure can never stop the server from starting.
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_art_user ON artifacts(user_id, updated_at)',
  'CREATE INDEX IF NOT EXISTS idx_kchunk_doc ON knowledge_chunks(doc_id)',
  'CREATE INDEX IF NOT EXISTS idx_kterm_lookup ON knowledge_terms(term, user_id)',
  'CREATE INDEX IF NOT EXISTS idx_tool_conv ON tool_calls(conversation_id)',
  'CREATE INDEX IF NOT EXISTS idx_cite_msg ON citations(message_id)',
  'CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_id, is_deleted, is_archived)',
  'CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_mem_user ON memories(user_id, is_active)',
  'CREATE INDEX IF NOT EXISTS idx_sess_user ON sessions(user_id, is_valid)',
  'CREATE INDEX IF NOT EXISTS idx_att_msg ON attachments(message_id)',
  'CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_events(user_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_share_slug ON shares(slug)',
  'CREATE INDEX IF NOT EXISTS idx_apikey_hash ON api_keys(key_hash)'
];
for (const sql of INDEXES) {
  try { db.exec(sql); }
  catch (e) { console.warn('⚠  Skipped index:', e.message); }
}

// ─── FTS SYNC HELPERS ───
const fts = {
  index(message) {
    if (!ftsEnabled) return;
    try {
      db.prepare('INSERT INTO messages_fts (content, message_id, conversation_id) VALUES (?, ?, ?)')
        .run(message.content, message.id, message.conversation_id);
    } catch (e) { /* non-fatal */ }
  },
  update(id, content) {
    if (!ftsEnabled) return;
    try {
      db.prepare('UPDATE messages_fts SET content = ? WHERE message_id = ?').run(content, id);
    } catch (e) { /* non-fatal */ }
  },
  remove(id) {
    if (!ftsEnabled) return;
    try { db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(id); } catch (e) {}
  },
  removeConversation(cid) {
    if (!ftsEnabled) return;
    try { db.prepare('DELETE FROM messages_fts WHERE conversation_id = ?').run(cid); } catch (e) {}
  }
};
db.fts = fts;

// Backfill the search index once if it's empty but messages exist.
if (ftsEnabled) {
  try {
    const n = db.prepare('SELECT COUNT(*) c FROM messages_fts').get().c;
    const m = db.prepare('SELECT COUNT(*) c FROM messages').get().c;
    if (n === 0 && m > 0) {
      const rows = db.prepare('SELECT id, conversation_id, content FROM messages').all();
      const ins = db.prepare('INSERT INTO messages_fts (content, message_id, conversation_id) VALUES (?,?,?)');
      db.transaction(rs => rs.forEach(r => ins.run(r.content, r.id, r.conversation_id)))(rows);
      console.log(`✓ Search index built (${rows.length} messages)`);
    }
  } catch (e) { /* non-fatal */ }
}

module.exports = db;
