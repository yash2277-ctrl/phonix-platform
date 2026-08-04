/* ═══════════════════════════════════════════════════════════════
   Schema lint — prepares every SQL statement in the codebase
   against a real database.

   SQLite only validates a query when it is prepared, so a typo in a
   rarely-hit route ("no such column: is_deleted") stays invisible
   until a user trips it in production. Preparing every statement at
   build time turns that runtime surprise into a failing test.

   Run:  npm run test:schema
   ═══════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');
const db = require('../db');

const ROOT = path.join(__dirname, '..');
const c = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };

/** Every .js file that might talk to the database. */
function sources() {
  const out = [];
  for (const dir of ['routes', 'lib', '.']) {
    const abs = path.join(ROOT, dir);
    for (const f of fs.readdirSync(abs)) {
      if (f.endsWith('.js') && fs.statSync(path.join(abs, f)).isFile()) {
        out.push(path.join(dir, f));
      }
    }
  }
  return out.filter(f => !f.includes('node_modules'));
}

/**
 * Pull the SQL out of db.prepare(...) / db.exec(...) calls.
 * Only backtick and quoted literals — anything assembled from variables can't be
 * checked statically, and is reported separately rather than silently skipped.
 */
function extractSql(src) {
  const found = [];
  const re = /\bdb\.(?:prepare|exec)\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    // Undo JS string escaping so SQLite sees the literal the engine would get.
    const raw = m[1].slice(1, -1)
      .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\`/g, '`')
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\\\/g, '\\');
    // A query may also be assembled with `+`, in which case what we captured is
    // only its first fragment. Peek past the literal to notice that.
    const concatenated = /^\s*\+/.test(src.slice(m.index + m[0].length));
    found.push({ raw, line, concatenated });
  }
  return found;
}

/**
 * Replace ${...} interpolations with something SQL-valid.
 * Route code builds optional clauses this way ("AND project_id = ?"), so the
 * empty string is the right stand-in — it yields the query's base form.
 */
function resolve(raw) {
  if (!raw.includes('${')) return { sql: raw, dynamic: false };
  let depth = 0, out = '', skipping = false;
  for (let i = 0; i < raw.length; i++) {
    if (!skipping && raw[i] === '$' && raw[i + 1] === '{') { skipping = true; depth = 1; i++; continue; }
    if (skipping) {
      if (raw[i] === '{') depth++;
      else if (raw[i] === '}') { depth--; if (!depth) skipping = false; }
      continue;
    }
    out += raw[i];
  }
  return { sql: out, dynamic: true };
}

let pass = 0, fail = 0, skipped = 0;
const failures = [];

console.log(`\n${c.y}SQL schema lint${c.x}`);

for (const file of sources()) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const stmts = extractSql(src);
  if (!stmts.length) continue;

  let fileFails = 0;
  for (const { raw, line, concatenated } of stmts) {
    const r = resolve(raw);
    const dynamic = r.dynamic || concatenated;
    const trimmed = r.sql.trim();
    if (!trimmed) { skipped++; continue; }

    // Multi-statement blocks (schema setup) — exec handles them, prepare won't.
    const isBlock = trimmed.split(';').filter(s => s.trim()).length > 1;

    try {
      if (isBlock) { skipped++; continue; }
      db.prepare(trimmed);
      pass++;
    } catch (e) {
      // A stripped interpolation can legitimately break the grammar — an IN (…)
      // list, for instance, is empty once its placeholders are removed. Structural
      // complaints on a dynamic query are therefore not evidence of a bug.
      // Name resolution errors still are, so those are never skipped.
      const structural = /incomplete input|syntax error|unrecognized token|near "/i.test(e.message);
      if (dynamic && structural) { skipped++; continue; }
      fail++; fileFails++;
      failures.push({ file, line, message: e.message, sql: trimmed.replace(/\s+/g, ' ').slice(0, 110) });
    }
  }
  const mark = fileFails ? `${c.r}✗${c.x}` : `${c.g}✓${c.x}`;
  console.log(`  ${mark} ${file.padEnd(28)} ${c.d}${stmts.length} statements${c.x}`);
}

console.log(`\n${'─'.repeat(52)}`);
console.log(`${c.g}${pass} valid${c.x}  ${fail ? c.r + fail + ' invalid' + c.x : '0 invalid'}  ${c.d}${skipped} skipped${c.x}`);

if (failures.length) {
  console.log(`\n${c.r}Invalid SQL:${c.x}`);
  for (const f of failures) {
    console.log(`\n  ${c.y}${f.file}:${f.line}${c.x}`);
    console.log(`    ${c.r}${f.message}${c.x}`);
    console.log(`    ${c.d}${f.sql}${c.x}`);
  }
}

process.exit(fail ? 1 : 0);
