const { v4: uuid } = require('uuid');
const db = require('../db');

// ═══════════════════════════════════════════
//   RETRIEVAL — chunking + BM25 ranking over
//   a local inverted index (no external API)
// ═══════════════════════════════════════════

const STOPWORDS = new Set(`a an and are as at be but by for from has have how i if in is it its of on or that the this to was were what when where which who will with you your`.split(/\s+/));

// Light stemmer: strips common English suffixes so "running" ≈ "run".
function stem(w) {
  if (w.length <= 3) return w;
  return w
    .replace(/(ational|tional|ization|iveness|fulness|ousness)$/, '')
    .replace(/(ies|ied)$/, 'y')
    .replace(/(sses|ss)$/, 'ss')
    .replace(/(ing|edly|ed|ly|es|s)$/, '')
    .replace(/(er|est)$/, '') || w;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s.+#-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && t.length < 40 && !STOPWORDS.has(t))
    .map(stem);
}

/**
 * Is this piece a label rather than a passage?
 *
 * Length alone is a poor test — "Refunds are issued within 30 days." is short but
 * complete, while "Shipping & Returns" is a heading that means nothing retrieved on
 * its own. What separates them is prose structure: a passage makes at least one
 * full statement, a label just names what follows. Labels get attached to the
 * passage they introduce; passages stand alone.
 */
function isLabel(p) {
  if (/^#{1,6}\s/.test(p)) return true;                    // markdown heading
  if (/[:：]$/.test(p)) return true;                        // "Requirements:"
  if (p.length < 25) return true;                           // too small to retrieve
  const hasSentence = /[.!?][")\]]?\s*$/.test(p) || /[.!?]\s+\S/.test(p);
  const words = p.split(/\s+/).length;
  return !hasSentence && words <= 12;                       // short, unpunctuated
}

/**
 * Split text into retrieval chunks.
 *
 * The governing rule is that a paragraph is a topic. Merging two paragraphs that
 * discuss different things produces a chunk that ranks for both and answers
 * neither — the single fastest way to wreck retrieval precision. So every prose
 * paragraph becomes its own chunk, and merging is reserved for labels, which
 * attach to the passage they introduce.
 *
 * Oversized paragraphs are split on sentence boundaries with a sentence of
 * overlap, so a passage cut mid-argument is still retrievable from either side.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.max=1200]   Hard ceiling before a sentence split.
 * @param {number} [opts.target=800] Preferred size of a split piece.
 */
function chunk(text, { max = 1200, target = 800 } = {}) {
  const clean = String(text).replace(/\r\n/g, '\n').trim();
  if (!clean) return [];

  const paras = clean.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);

  // 1 ─ Break oversized paragraphs into sentence-aligned pieces with overlap.
  const pieces = [];
  for (const p of paras) {
    if (p.length <= max) { pieces.push(p); continue; }

    const sents = p.match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g) || [p];
    let buf = '', prevTail = '';
    for (const sent of sents) {
      if (buf && buf.length + sent.length > target) {
        pieces.push(buf.trim());
        prevTail = (buf.match(/[^.!?]+[.!?]+\s*$/) || [''])[0];  // carry one sentence
        buf = prevTail + sent;
      } else {
        buf += sent;
      }
      // A single sentence longer than max still has to be cut somewhere.
      while (buf.length > max * 1.5) { pieces.push(buf.slice(0, max).trim()); buf = buf.slice(max); }
    }
    if (buf.trim()) pieces.push(buf.trim());
  }

  // 2 ─ Emit passages as chunks; let labels attach to the passage they introduce.
  const chunks = [];
  let pending = [];   // labels awaiting their passage

  for (const piece of pieces) {
    if (isLabel(piece)) { pending.push(piece); continue; }
    chunks.push([...pending, piece].join('\n\n'));
    pending = [];
  }

  // Trailing labels belong to what came before, not to nothing.
  if (pending.length) {
    const tail = pending.join('\n\n');
    const last = chunks[chunks.length - 1];
    if (last && last.length + tail.length + 2 <= max) chunks[chunks.length - 1] = `${last}\n\n${tail}`;
    else chunks.push(tail);
  }

  return chunks.length ? chunks : [clean];
}

/** Index a document: chunk it, then write term frequencies into the inverted index. */
function indexDocument({ userId, projectId = null, title, content, source = null, mimeType = null }) {
  const docId = uuid();
  const chunks = chunk(content);

  const insDoc = db.prepare(`INSERT INTO knowledge_docs (id, user_id, project_id, title, source, mime_type, content, chunk_count)
                             VALUES (?,?,?,?,?,?,?,?)`);
  const insChunk = db.prepare(`INSERT INTO knowledge_chunks (id, doc_id, user_id, project_id, ordinal, content, token_count)
                               VALUES (?,?,?,?,?,?,?)`);
  const insTerm = db.prepare(`INSERT INTO knowledge_terms (term, chunk_id, user_id, project_id, freq) VALUES (?,?,?,?,?)
                              ON CONFLICT(term, chunk_id) DO UPDATE SET freq = freq + excluded.freq`);

  // The title describes every chunk in the document, so it is indexed into each of
  // them. Because the contribution is identical across a document's chunks it can't
  // skew ranking *within* the document, but it makes the document findable by name.
  const titleTokens = [...new Set(tokenize(title))];

  db.transaction(() => {
    insDoc.run(docId, userId, projectId, title, source, mimeType, String(content).slice(0, 2_000_000), chunks.length);
    chunks.forEach((text, i) => {
      const cid = uuid();
      const tokens = tokenize(text);
      insChunk.run(cid, docId, userId, projectId, i, text, tokens.length);

      const freqs = new Map();
      for (const t of tokens) freqs.set(t, (freqs.get(t) || 0) + 1);
      for (const t of titleTokens) if (!freqs.has(t)) freqs.set(t, 1);

      for (const [term, f] of freqs) insTerm.run(term, cid, userId, projectId, f);
    });
  })();

  return { id: docId, title, chunks: chunks.length };
}

const K1 = 1.5, B = 0.75;

/** BM25 search across the user's indexed chunks. */
function search({ userId, projectId = null, query, limit = 5 }) {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length) return [];

  const scopeSql = projectId ? 'AND project_id = ?' : '';
  const scopeArgs = projectId ? [projectId] : [];

  const totals = db.prepare(`SELECT COUNT(*) n, COALESCE(AVG(token_count),1) avg FROM knowledge_chunks WHERE user_id = ? ${scopeSql}`)
    .get(userId, ...scopeArgs);
  const N = totals.n || 0;
  if (!N) return [];
  const avgdl = totals.avg || 1;

  const ph = terms.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT kt.term, kt.chunk_id, kt.freq, kc.content, kc.token_count, kc.ordinal, kd.title, kd.id AS doc_id
    FROM knowledge_terms kt
    JOIN knowledge_chunks kc ON kc.id = kt.chunk_id
    JOIN knowledge_docs kd ON kd.id = kc.doc_id
    WHERE kt.user_id = ? ${projectId ? 'AND kt.project_id = ?' : ''} AND kt.term IN (${ph})
  `).all(userId, ...scopeArgs, ...terms);

  // Document frequency per term.
  const dfMap = new Map();
  for (const t of terms) {
    const seen = new Set(rows.filter(r => r.term === t).map(r => r.chunk_id));
    dfMap.set(t, seen.size);
  }

  const scores = new Map();
  for (const r of rows) {
    const df = dfMap.get(r.term) || 1;
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    const dl = r.token_count || 1;
    const tf = r.freq;
    const score = idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (dl / avgdl))));
    const cur = scores.get(r.chunk_id) || { score: 0, content: r.content, title: r.title, docId: r.doc_id, ordinal: r.ordinal, matched: new Set() };
    cur.score += score;
    cur.matched.add(r.term);
    scores.set(r.chunk_id, cur);
  }

  return [...scores.entries()]
    .map(([chunkId, v]) => ({
      chunkId, docId: v.docId, title: v.title, ordinal: v.ordinal,
      content: v.content,
      // Reward chunks matching more distinct query terms.
      score: v.score * (1 + 0.25 * (v.matched.size - 1)),
      matchedTerms: [...v.matched]
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Build a grounded context block plus the citation list for a query.
 * Returns null when nothing relevant is indexed.
 */
function buildGroundedContext({ userId, projectId, query, limit = 5, minRatio = 0.35 }) {
  const all = search({ userId, projectId, query, limit });
  if (!all.length) return null;

  // BM25 scores aren't comparable across corpus sizes, so gate on relevance
  // *relative* to the best hit, with a small absolute floor to reject noise.
  const top = all[0].score;
  if (top < 0.08) return null;
  const hits = all.filter(h => h.score >= top * minRatio);
  if (!hits.length) return null;

  const sources = hits.map((h, i) => ({
    ordinal: i + 1, type: 'knowledge', id: h.docId, title: h.title,
    excerpt: h.content.slice(0, 400), score: Number(h.score.toFixed(3))
  }));

  const block = hits.map((h, i) =>
    `[${i + 1}] ${h.title}${h.ordinal ? ` (part ${h.ordinal + 1})` : ''}\n${h.content.slice(0, 2000)}`
  ).join('\n\n');

  return {
    sources,
    text: `Relevant passages from the user's knowledge base. Cite them inline as [1], [2] when you use them. If they don't answer the question, say so rather than guessing.\n\n${block}`
  };
}

function deleteDocument(docId, userId) {
  const doc = db.prepare('SELECT * FROM knowledge_docs WHERE id = ? AND user_id = ?').get(docId, userId);
  if (!doc) return false;
  db.prepare('DELETE FROM knowledge_docs WHERE id = ?').run(docId);   // cascades chunks → terms
  return true;
}

module.exports = { indexDocument, search, buildGroundedContext, deleteDocument, chunk, tokenize };
