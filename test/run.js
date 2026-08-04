/* ═══════════════════════════════════════════════════════════════
   Test runner — `npm test`

   Boots a server against a throwaway database, runs the schema lint
   and the integration suite against it, then tears everything down.
   Your real phonix.db is never touched.
   ═══════════════════════════════════════════════════════════════ */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.TEST_PORT || 3199;
const DB = path.join(os.tmpdir(), `phonix-test-${Date.now()}.db`);
const c = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m' };

const env = { ...process.env, DB_PATH: DB, PORT: String(PORT), NODE_ENV: 'development' };

function cleanup() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(DB + suffix); } catch {}
  }
}

(async () => {
  // ─── 1. Schema lint (no server needed) ───
  const lint = spawnSync(process.execPath, [path.join(__dirname, 'schema.test.js')],
    { env, stdio: 'inherit', cwd: ROOT });

  // ─── 2. Boot server ───
  console.log(`\n${c.d}starting server on :${PORT}…${c.x}`);
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')],
    { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  let serverLog = '';
  server.stdout.on('data', d => { serverLog += d; });
  server.stderr.on('data', d => { serverLog += d; });

  const up = await (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://localhost:${PORT}/health`);
        if (r.ok) return true;
      } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    return false;
  })();

  if (!up) {
    console.error(`\n${c.r}Server failed to start.${c.x}\n${serverLog}`);
    server.kill('SIGKILL');
    cleanup();
    process.exit(1);
  }

  // ─── 3. Integration suite ───
  const api = spawnSync(process.execPath, [path.join(__dirname, 'api.test.js')],
    { env: { ...env, TEST_BASE: `http://localhost:${PORT}` }, stdio: 'inherit', cwd: ROOT });

  server.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 400));
  server.kill('SIGKILL');
  cleanup();

  // Surface anything the server logged that looks like a genuine fault.
  const noise = serverLog.split('\n')
    .filter(l => /error|exception|unhandled/i.test(l))
    .filter(l => !/ExperimentalWarning|trace-warnings/.test(l));
  if (noise.length) {
    console.log(`\n${c.y}Server-side errors logged during the run:${c.x}`);
    noise.slice(0, 15).forEach(l => console.log('  ' + c.d + l.trim() + c.x));
  }

  const failed = lint.status || api.status;
  console.log(failed ? `\n${c.r}TESTS FAILED${c.x}` : `\n${c.g}ALL TESTS PASSED${c.x}`);
  process.exit(failed ? 1 : 0);
})();
