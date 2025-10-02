# PHØNIX

An AI workspace with agentic tool use, a retrieval-backed knowledge base, versioned
artifacts, and persistent memory. Express + SQLite backend, vanilla frontend styled in
the **Swiss International Typographic Style**.

---

## Structure

```
phonix/
├── server.js              Express app: middleware, routes, static, lifecycle
├── db.js                  SQLite schema, migrations, FTS5 search index
│
├── lib/                   Domain logic (framework-free, unit-testable)
│   ├── ai.js              Model registry, context assembly, agent loop, streaming
│   ├── tools.js           Tool registry + sandboxed execution
│   ├── rag.js             Chunking + BM25 retrieval with citations
│   ├── artifacts.js       Versioned documents/code
│   ├── safety.js          Input screening, prompt-injection defence
│   ├── auth.js            JWT, sessions, plans, quotas
│   ├── validate.js        Declarative request validation
│   ├── ratelimit.js       Sliding-window limiter
│   └── errors.js          Typed errors + JSON error envelope
│
├── routes/                HTTP layer, one module per resource
│   ├── auth.js  users.js  conversations.js  messages.js  chat.js
│   ├── projects.js  memories.js  prompts.js  search.js  files.js
│   ├── artifacts.js  knowledge.js  tools.js  shares.js
│   └── apikeys.js  webhooks.js  batch.js  admin.js
│
├── test/                  Verification
│   ├── run.js             Boots a disposable server, runs both suites
│   ├── schema.test.js     Prepares every SQL statement against the schema
│   └── api.test.js        125 assertions across all 19 route groups
│
└── public/                Frontend — the only frontend
    ├── index.html         Landing
    ├── login.html         Sign in / create account
    ├── chat.html          Workspace shell + SVG icon sprite
    └── assets/
        ├── swiss.css      DESIGN TOKENS — single source of truth
        ├── chat.css       Workspace layout
        └── chat.js        Workspace client
```

---

## Design system

All visual decisions resolve to tokens in `public/assets/swiss.css`. Change a value there
and it propagates across every page.

| Token | Value | Role |
|---|---|---|
| `--bg` | `#FFFFFF` | Canvas |
| `--fg` | `#000000` | Text, borders |
| `--muted` | `#F2F2F2` | Secondary surfaces |
| `--accent` | `#FF3000` | Signal only — CTAs, section numbers, hover, alerts |
| `--radius` | `0px` | Strictly rectangular |
| `--bd` / `--bd-thick` | `2px` / `4px` | Visible structure |

Typography is **Inter** 400/500/700/900. Headings are uppercase, weight 900, tight
tracking. Depth comes from four CSS texture patterns (`.swiss-grid-pattern`,
`.swiss-dots`, `.swiss-diagonal`, `.swiss-noise`) — never from shadow or gradient.

Dark mode is a straight inversion; red is held constant because it is functional.

---

## Running

```bash
npm install
npm run dev
```

Then open <http://localhost:3001>.

| Route | |
|---|---|
| `/` | Landing |
| `/login` | Sign in |
| `/chat` | Workspace |
| `/api/v1` | API index (97 endpoints) |
| `/health` | Health check |

### Testing

```bash
npm test            # schema lint + full integration suite
npm run test:schema # SQL only (fast, no server needed)
npm run test:api    # integration only (against an already-running server)
```

`npm test` boots its own server against a throwaway database in your temp
directory — your `phonix.db` is never touched.

**`test/schema.test.js`** prepares every SQL statement in the codebase against a real
database. SQLite only validates a query when it is prepared, so a typo in a
rarely-hit route stays invisible until a user trips over it; this turns that into a
build-time failure. 254 statements checked.

**`test/api.test.js`** exercises all 19 route groups over HTTP — 125 assertions
covering happy paths, validation, authorisation boundaries (one user must not reach
another's data), and security behaviour (SSRF blocking, sandbox escape, SQL
injection, rate limiting, CORS, CSP).

The AI provider is a free unofficial service and is often down. The suite asserts the
*shape* of streaming responses rather than model output, so provider outages don't
produce false failures — `AI stream error: … 526` in the log during a passing run is
expected.

### Configuration

Copy `.env.example` to `.env`. In production `JWT_SECRET` and `JWT_REFRESH_SECRET` are
**required** — the server refuses to start without them.

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## Notes

- **Database**: SQLite via `better-sqlite3`. Full-text search uses FTS5 with a LIKE
  fallback.
- **Migrations are derived, not hand-written.** `CREATE TABLE IF NOT EXISTS` silently
  does nothing to a table that already exists, so a database from an older version
  keeps its old shape while the code moves on — and the mismatch only shows up when a
  query touches the missing column (`no such column: is_deleted`). On boot, `db.js`
  parses its own schema, compares it against what is on disk, and adds whatever is
  missing. Adding a column to the schema is therefore all that is required; there is
  no separate migration list to keep in step.
- **AI provider**: `g4f` (free, unofficial). It degrades gracefully — if the provider is
  unreachable the UI shows a clear message rather than hanging.
- **Uploads** are written to `uploads/` and are git-ignored, as are `.env`,
  `.secrets.json`, and the database files.


## Recent Updates

- **2026-08-05**: style: Improve code formatting

- **2026-08-05**: style: Improve code formatting

- **2026-08-05**: style: Improve code formatting

- **2026-08-05**: docs: Add architecture documentation

- **2026-08-05**: style: Improve code formatting

- **2026-08-05**: docs: Add architecture documentation

- **2026-08-05**: style: Improve code formatting

- **2026-08-05**: docs: Add architecture documentation

- **2026-05-07**: Update documentation

- **2026-05-08**: Improve UI/UX

- **2026-05-18**: Improve performance

- **2026-05-23**: Update documentation

- **2026-05-27**: Refactor code

- **2026-06-05**: Refactor code

- **2026-06-23**: Improve error handling

- **2026-06-28**: Improve UI/UX

- **2026-07-02**: Improve error handling

- **2026-07-11**: Improve UI/UX

- **2026-07-11**: Improve error handling

- **2026-07-14**: Refactor code

- **2026-07-19**: Improve error handling

- **2026-07-25**: Refactor code

- **2026-08-01**: Update README

- **2026-08-04**: Refactor code


## Commit Log

- [2026-05-11 02:27:44] Improve performance
- [2026-01-10 02:27:44] Improve UI/UX
- [2025-10-03 02:27:44] Add comments
- [2025-10-03 02:27:44] Improve error handling