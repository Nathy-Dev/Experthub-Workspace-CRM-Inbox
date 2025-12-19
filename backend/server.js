// server.js - Express backend fully adapted to experthub_workspace_chat_history table

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const WebSocket = require('ws');

// load environment variables from .env
require('dotenv').config();

const app = express();
app.use(cors({
  origin: '*', // for now (you can restrict later)
  methods: ['GET', 'POST']
}));
app.use(express.json());

// ================================
// PostgreSQL Connection
// ================================
// Build Postgres config from environment variables. Supports either DATABASE_URL or individual vars.
const useConnectionString = !!process.env.DATABASE_URL;
let poolConfig = {};
if (useConnectionString) {
  poolConfig.connectionString = process.env.DATABASE_URL;
} else {
  poolConfig = {
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'postgres',
    password: process.env.DB_PASSWORD || '',
    port: parseInt(process.env.DB_PORT || '5432', 10),
  };
}

// SSL handling (set DB_SSL=true in .env to enable with rejectUnauthorized false)
if ((process.env.DB_SSL || '').toLowerCase() === 'true') {
  poolConfig.ssl = { rejectUnauthorized: false };
}

const pool = new Pool(poolConfig);


let lastMaxId = 0;

async function initDb() {
  try {
    await pool.query('SELECT 1');
    const r = await pool.query('SELECT COALESCE(MAX(id),0) as maxid FROM experthub_workspace_chat_history');
    lastMaxId = parseInt(r.rows[0].maxid, 10) || 0;
    console.log('✅ Database connected, lastMaxId=', lastMaxId);
  } catch (err) {
    console.error('❌ Database connection failed');
    console.error(err);
    process.exit(1);
  }
}

initDb();


// ================================
// Helper function to normalize messages
// ================================
function normalizeMessage(row) {
  const msg = row.message;

  if (msg.type === 'human') {
    return {
      sender: 'user',
      message: msg.content,
      created_at: row.updated_at
    };
  }

  if (msg.type === 'ai') {
    return {
      sender: 'agent',
      message: msg.content,
      created_at: row.updated_at
    };
  }

  return {
    sender: 'unknown',
    message: JSON.stringify(msg),
    created_at: row.updated_at
  };
}

// In-memory map to track when a session was last opened/read by the UI.
// NOTE: this is ephemeral (not persisted). For production, persist per-user read state.
const lastOpened = {}; // { [session_id]: ISO timestamp }

function isoNow() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ================================
// GET all conversations (distinct session_id)
// ================================
app.get('/api/conversations', async (req, res) => {
  try {
    // Get the most recent row per session_id, then order sessions by their latest updated_at DESC
    const query = `
      SELECT session_id, message->>'content' AS last_message, message->>'type' AS last_sender, updated_at, id
      FROM (
        -- pick latest row per session based on id (insert order) to avoid timestamp precision issues
        SELECT session_id, message, updated_at, id,
               ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY id DESC) rn
        FROM experthub_workspace_chat_history
      ) t
      WHERE rn = 1
      ORDER BY updated_at DESC, id DESC
    `;

    const { rows } = await pool.query(query);

    // Compute unread counts per session based on in-memory lastOpened timestamps
    const enriched = [];
    for (const r of rows) {
      const sid = r.session_id;
      const last = lastOpened[sid] || new Date(0).toISOString();

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM experthub_workspace_chat_history WHERE session_id = $1 AND updated_at > $2`,
        [sid, last]
      );

      const unread_count = parseInt(countResult.rows[0].count, 10) || 0;

      enriched.push({
        session_id: sid,
        last_message: r.last_message,
        last_sender: r.last_sender,
        updated_at: r.updated_at,
        unread_count,
      });
    }

    res.json(enriched);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch conversations' });
  }
});



// ================================
// GET messages for a session
// ================================
app.get('/api/conversations/:sessionId/messages', async (req, res) => {
  const { sessionId } = req.params;

  try {
    const query = `
      SELECT
        id,
        message->>'type' AS sender,
        message->>'content' AS content,
        updated_at
      FROM experthub_workspace_chat_history
      WHERE session_id = $1
      -- Order by insertion id to reflect real chronological order
      ORDER BY id ASC
    `;

    const { rows } = await pool.query(query, [sessionId]);

    const messages = rows.map(row => ({
      id: row.id,
      sender: row.sender === 'human' ? 'user' : 'agent',
      message: row.content,
      time: row.updated_at
    }));

    // Mark this session as opened/read now (so future /api/conversations shows zero unread up to now)
    lastOpened[sessionId] = isoNow();

    res.json(messages);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ================================
// FETCH ONLY NEW MESSAGES for a session
// ================================
app.get(
  '/api/conversations/:sessionId/messages/after/:lastMessageId',
  async (req, res) => {
    const { sessionId, lastMessageId } = req.params;

    const lastId = parseInt(lastMessageId, 10);

    if (isNaN(lastId)) {
      return res.json([]); // Safe fallback
    }

    try {
      const { rows } = await pool.query(
        `
        SELECT
          id,
          message->>'type' AS sender,
          message->>'content' AS content,
          updated_at AS created_at
        FROM experthub_workspace_chat_history
        WHERE session_id = $1
          AND id > $2
        ORDER BY id ASC
        `,
        [sessionId, lastId]
      );

      res.json(rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch new messages' });
    }
  }
);



// ================================
// SEND a message (agent reply)
// ================================
app.post('/api/messages', async (req, res) => {
  try {
    const { session_id, message } = req.body;

    if (!session_id || !message) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const messageJson = {
      type: 'ai',
      content: message,
      tool_calls: [],
      additional_kwargs: {},
      response_metadata: {},
      invalid_tool_calls: []
    };

    const insertMessage = `
      INSERT INTO experthub_workspace_chat_history (session_id, message, updated_at)
      VALUES ($1, $2, NOW())
      RETURNING *
    `;

    const result = await pool.query(insertMessage, [session_id, messageJson]);

    // when a new AI message is inserted, do NOT mark as read. Leave unread for clients.
    const inserted = result.rows[0];

    // Broadcast the new message to all websocket clients (normalized)
    try {
      const payload = {
        type: 'message',
        data: {
          id: inserted.id,
          session_id: inserted.session_id,
          sender: inserted.message.type === 'human' ? 'user' : 'agent',
          message: inserted.message.content,
          time: inserted.updated_at,
        },
      };
      // update lastMaxId to avoid re-broadcast from poll
      if (inserted.id && inserted.id > lastMaxId) lastMaxId = inserted.id;
      if (globalThis.wss) {
        globalThis.wss.clients.forEach((c) => {
          if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(payload));
        });
      }
    } catch (bErr) {
      console.error('Broadcast failed', bErr);
    }

    res.status(201).json(normalizeMessage(inserted));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});


// ================================
// Long-poll endpoint (simple polling helper)
// Clients can call /api/long-poll?since=ISO_TIMESTAMP[&sessionId=...] to wait for new messages.
// This is a lightweight long-polling implementation: checks DB every 1.5s up to 25s.
// Response: { new: boolean, timestamp: ISO, sessionId?: string }
// ================================
app.get('/api/long-poll', async (req, res) => {
  try {
    const { since, sessionId } = req.query;
    const sinceTs = since ? new Date(since).toISOString() : new Date(0).toISOString();

    const timeoutMs = 25000;
    const intervalMs = 1500;
    let elapsed = 0;

    while (elapsed < timeoutMs) {
      let found = false;

      if (sessionId) {
        const q = `SELECT 1 FROM experthub_workspace_chat_history WHERE session_id = $1 AND updated_at > $2 LIMIT 1`;
        const r = await pool.query(q, [sessionId, sinceTs]);
        found = r.rowCount > 0;
      } else {
        const q = `SELECT 1 FROM experthub_workspace_chat_history WHERE updated_at > $1 LIMIT 1`;
        const r = await pool.query(q, [sinceTs]);
        found = r.rowCount > 0;
      }

      if (found) {
        return res.json({ new: true, timestamp: isoNow(), sessionId: sessionId || null });
      }

      await sleep(intervalMs);
      elapsed += intervalMs;
    }

    // nothing new within timeout
    res.json({ new: false, timestamp: isoNow(), sessionId: sessionId || null });
  } catch (err) {
    console.error('Long-poll error', err);
    res.status(500).json({ error: 'Long-poll failed' });
  }
});

// ================================
// Server start
// ================================
const PORT = parseInt(process.env.PORT || 3000);
const server = http.createServer(app);

// setup WebSocket server
const wss = new WebSocket.Server({ server });
globalThis.wss = wss; // expose for broadcasts from handlers

// Broadcast helper
function broadcastMessage(obj) {
  const raw = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(raw);
  });
}

// Server-side lightweight poll to detect new messages and broadcast them
async function pollNewMessages() {
  try {
    const { rows } = await pool.query(
      `SELECT id, session_id, message->>'type' AS type, message->>'content' AS content, updated_at FROM experthub_workspace_chat_history WHERE id > $1 ORDER BY id ASC`,
      [lastMaxId]
    );

    if (rows.length === 0) return;

    for (const r of rows) {
      const payload = {
        type: 'message',
        data: {
          id: r.id,
          session_id: r.session_id,
          sender: r.type === 'human' ? 'user' : 'agent',
          message: r.content,
          time: r.updated_at,
        },
      };
      broadcastMessage(payload);
      if (r.id && r.id > lastMaxId) lastMaxId = r.id;
    }
  } catch (err) {
    console.error('pollNewMessages error', err);
  }
}

// poll every 1.5s (server internal only)
setInterval(pollNewMessages, 1500);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

