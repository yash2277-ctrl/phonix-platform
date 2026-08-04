const crypto = require('crypto');
const { v4: uuid } = require('uuid');
const db = require('../db');

// ═══════════════════════════════════════════
//   ARTIFACTS — versioned documents and code
//   the assistant produces and can iterate on
// ═══════════════════════════════════════════

const TYPES = ['text/markdown', 'application/code', 'text/html', 'image/svg+xml', 'application/json'];

/** Create a new artifact, or save a new version of an existing one. */
function upsert({ userId, conversationId = null, messageId = null, identifier, title, type, language, content, changeNote }) {
  const slug = String(identifier).toLowerCase().replace(/[^a-z0-9-_]/g, '-').slice(0, 80);
  const kind = TYPES.includes(type) ? type : 'text/markdown';
  const existing = db.prepare('SELECT * FROM artifacts WHERE user_id = ? AND identifier = ?').get(userId, slug);

  if (existing) {
    if (existing.content === content) return { ...existing, created: false, unchanged: true };
    const version = existing.version + 1;
    db.transaction(() => {
      // Snapshot the previous content before overwriting.
      db.prepare('INSERT INTO artifact_versions (id, artifact_id, content, version, change_note) VALUES (?,?,?,?,?)')
        .run(uuid(), existing.id, existing.content, existing.version, changeNote || null);
      db.prepare(`UPDATE artifacts SET content = ?, title = ?, type = ?, language = ?, version = ?,
                  updated_at = datetime('now') WHERE id = ?`)
        .run(content, title || existing.title, kind, language || existing.language, version, existing.id);
    })();
    return { ...db.prepare('SELECT * FROM artifacts WHERE id = ?').get(existing.id), created: false };
  }

  const id = uuid();
  db.prepare(`INSERT INTO artifacts (id, user_id, conversation_id, message_id, identifier, title, type, language, content)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, userId, conversationId, messageId, slug, title || slug, kind, language || null, content);
  return { ...db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id), created: true };
}

/** Extract artifacts the model wrote using <artifact> tags in its reply. */
function extractFromText(text) {
  const found = [];
  const re = /<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/gi;
  let m;
  while ((m = re.exec(text))) {
    const attrs = {};
    for (const a of m[1].matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = a[2];
    if (!attrs.identifier) continue;
    found.push({
      identifier: attrs.identifier,
      title: attrs.title || attrs.identifier,
      type: attrs.type || 'text/markdown',
      language: attrs.language || null,
      content: m[2].trim(),
      raw: m[0]
    });
  }
  return found;
}

/** Replace inline <artifact> blocks with a compact reference for display. */
function stripArtifacts(text, made = []) {
  let out = text;
  for (const a of made) {
    out = out.replace(a.raw, `\n\n📄 **${a.title}** — saved as an artifact (\`${a.identifier}\`, v${a.version || 1}).\n`);
  }
  return out.trim();
}

function publish(artifactId, userId) {
  const a = db.prepare('SELECT * FROM artifacts WHERE id = ? AND user_id = ?').get(artifactId, userId);
  if (!a) return null;
  const slug = a.publish_slug || crypto.randomBytes(8).toString('base64url');
  db.prepare('UPDATE artifacts SET is_published = 1, publish_slug = ? WHERE id = ?').run(slug, a.id);
  return { slug, url: `/a/${slug}` };
}

const ARTIFACT_PROMPT = `When you produce substantial standalone content — a document, a code file, a component, a report — wrap it in artifact tags so the user can save and iterate on it:

<artifact identifier="kebab-case-id" title="Human Title" type="application/code" language="python">
...full content...
</artifact>

Use type "application/code" for code (set language), "text/markdown" for prose, "text/html" for web pages.
Reuse the same identifier to revise an existing artifact. Keep short answers and explanations outside artifacts.`;

module.exports = { upsert, extractFromText, stripArtifacts, publish, ARTIFACT_PROMPT, TYPES };
