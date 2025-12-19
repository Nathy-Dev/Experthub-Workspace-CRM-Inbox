## Project snapshot

- Small single-repo web app with a static frontend in the project root (`index.html`, `script.js`, `styles.css`) and a minimal Express backend in `backend/`.
- Backend persists chat-like events into a Postgres table named `experthub_workspace_chat_history` and exposes three HTTP endpoints used by the UI.

## Where to look first (quick map)

- Backend entry: `backend/server.js` — Express app, DB connection (pg Pool), and endpoints:
  - GET `/api/conversations` — returns most-recent row per `session_id`.
  - GET `/api/conversations/:sessionId/messages` — returns ordered messages for a session.
  - POST `/api/messages` — inserts an AI reply (expects `session_id` and `message` in request body).
- Frontend: `index.html`, `script.js`, `styles.css` — tiny static UI that fetches from `http://localhost:3000`.
- DB: table referenced is `experthub_workspace_chat_history`; messages are stored as JSON in the `message` column.

## Big-picture architecture / data flow

1. Frontend calls backend APIs on localhost:3000 to list conversations and fetch messages.
2. Backend queries Postgres (Supabase-like connection string) against `experthub_workspace_chat_history`.
3. Backend normalizes rows (message JSON has `type` and `content`) before returning to the client.

Why this matters for edits: most visible changes are either UI-only (in the project root: `index.html`, `script.js`, `styles.css`) or data-shape/DB-related (in `backend/`). The project assumes the DB stores messages as JSON blobs.

## Project-specific conventions & notable patterns

- Message JSON shape: message objects in DB use fields like `{ type: 'human'|'ai', content: string, tool_calls: [], additional_kwargs: {}, response_metadata: {} }`. See `backend/server.js` normalization and insertion code.
- `session_id` is the conversation identifier; UI displays it with a `+` prefix (`+${session_id}` in `script.js`).
- Frontend uses numeric/phone-like session ids; keep `session_id` as the primary key when writing backend code.
- Backend currently constructs `messageJson` for POST `/api/messages` as an `ai` message regardless of client payload — be aware when enabling client-side sending.

## Developer workflows (how to run / debug)

- Start backend: open a terminal in `backend/` and run:

  node server.js

  (There is no `start` script in `package.json` — run `node server.js` directly or add an npm script.)

- Frontend: open `index.html` in a browser or serve the project root with a static server (e.g. `npx serve .` or `python -m http.server 5500`), then visit the file in your browser.

## Practical editing notes / common fixes

- To enable sending from the UI: `script.js` contains a commented-out payload that uses `conversation_id` and `API.send` (which is undefined). Change the payload to use `session_id` and POST to `/api/messages` (backend expects `{ session_id, message }`).

- DB credentials are hardcoded in `backend/server.js` (Supabase-like host and credentials). Do not commit real secrets; prefer moving them to environment variables (e.g., `process.env.DB_USER`, etc.).

- If you change the DB schema or the shape of `message`, update the normalization helpers in `backend/server.js` accordingly (functions at top of file that map `human` -> `user` and `ai` -> `agent`).

## Integration points / external dependencies

- Postgres (`pg` package). The app connects directly to a Postgres instance (the file uses a Supabase pooler URL pattern).
- No other external services are invoked by the code in this repo.

## Files you will edit most often

- `backend/server.js` — DB connection, query text, normalization and API behavior.
- `script.js` — UI fetches and rendering; enable/adjust send behavior here.

## Safety & review notes for an AI agent

- The repo contains hardcoded DB credentials in `backend/server.js`. Do not expose these values outside the repository. When suggesting changes, prefer recommending moving credentials to environment variables.

- Keep changes minimal and test locally: run `node backend/server.js` and load `index.html` (or a local static server) to verify behavior.

## Example edits (copy-paste friendly)

- Start backend quickly:

  cd backend; node server.js

- Fix frontend send to match backend (high-level):
  - change payload key `conversation_id` -> `session_id`
  - POST to `http://localhost:3000/api/messages`

## Nothing to run: tests & linters

- There are no test suites or linting config in this repo. Focus on manual verification when editing.

---

If anything in this file is unclear or you want the agent to recommend concrete refactors (move DB creds to .env, add npm start script, or enable UI send end-to-end), tell me which and I will update the instructions and/or propose the code changes.
