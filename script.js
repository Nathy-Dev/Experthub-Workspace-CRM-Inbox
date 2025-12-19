const conversationList = document.getElementById('conversationList');
const messagesEl = document.getElementById('messages');
const chatHeader = document.getElementById('chatHeader');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');

let activeConversationId = null;
let lastSeenTimestamp = new Date(0).toISOString();
const lastMessageIdBySession = {};
const conversationElements = new Map();

const API_BASE = 'https://experthub-workspace-crm-inbox.onrender.com';
const API = {
    conversations: `${API_BASE}/api/conversations`,
    messages: (sessionId) => `${API_BASE}/api/conversations/${sessionId}/messages`,
    send: `${API_BASE}/api/messages`,
    longPoll: `${API_BASE}/api/long-poll`,
};

function formatTime(iso) {
    try {
        return new Date(iso).toLocaleTimeString();
    } catch (e) {
        return '';
    }
}

function renderMessage(msg) {
    // avoid rendering duplicates by id
    if (msg.id) {
        const existing = messagesEl.querySelector(`[data-id="${msg.id}"]`);
        if (existing) return existing;
    }

    const div = document.createElement('div');
    div.className = `bubble ${msg.sender}`;
    if (msg.id) div.dataset.id = msg.id;
    div.innerHTML = `
        ${msg.message}
        <div class="timestamp">${formatTime(msg.time)}</div>
    `;
    messagesEl.appendChild(div);
    return div;
}

async function loadConversations() {
    try {
        const res = await fetch(API.conversations);
        const data = await res.json();

        // Efficiently update conversation list without full clear to avoid flicker
        const seen = new Set();

        data.forEach((conv) => {
            const sid = conv.session_id;
            seen.add(sid);

            const unread = conv.unread_count && conv.unread_count > 0 ? conv.unread_count : 0;
            const lastMessage = conv.last_message || '';

            let el = conversationElements.get(sid);
            if (!el) {
                el = document.createElement('div');
                el.className = 'conversation';
                el.dataset.sessionId = sid;

                const main = document.createElement('div');
                main.className = 'conversation-main';
                main.innerHTML = `<h4>+${sid}</h4>`;

                const p = document.createElement('p');
                p.textContent = lastMessage;

                el.appendChild(main);
                el.appendChild(p);
                el.onclick = () => selectConversation(sid, el);

                conversationElements.set(sid, el);
            } else {
                // update last message text
                const p = el.querySelector('p');
                if (p && p.textContent !== lastMessage) p.textContent = lastMessage;
            }

            // Ensure DOM order matches server order by appending in sequence
            conversationList.appendChild(el);

            // update badge
            const main = el.querySelector('.conversation-main');
            let badge = main.querySelector('.badge');
            if (unread) {
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'badge';
                    main.appendChild(badge);
                }
                badge.textContent = unread;
            } else if (badge) {
                badge.remove();
            }
        });

        // remove conversations no longer present
        for (const [sid, el] of conversationElements.entries()) {
            if (!seen.has(sid)) {
                el.remove();
                conversationElements.delete(sid);
            }
        }

        if (data && data.length) {
            const latest = data[0].updated_at || data[0].updatedAt || null;
            if (latest) lastSeenTimestamp = new Date(latest).toISOString();
        }
    } catch (err) {
        console.error('Failed to load conversations', err);
    }
}

async function selectConversation(sessionId, element) {
    document.querySelectorAll('.conversation').forEach((c) => c.classList.remove('active'));
    element.classList.add('active');

    activeConversationId = sessionId;
    chatHeader.textContent = `+${sessionId}`;

    messageInput.disabled = false;
    sendBtn.disabled = false;

    // force full reload when opening a conversation to ensure messages are complete
    await loadMessages(sessionId, true);
}

async function loadMessages(sessionId, force = false) {
    try {
        const res = await fetch(API.messages(sessionId));
        const data = await res.json();

        if (!Array.isArray(data) || data.length === 0) return;

        // If force, clear and render all; otherwise append only messages with id > lastId
        if (force) {
            messagesEl.innerHTML = '';
            data.forEach((msg) => renderMessage(msg));
        } else {
            const lastId = lastMessageIdBySession[sessionId] || 0;
            const newMsgs = data.filter((m) => (m.id || 0) > lastId);
            newMsgs.forEach((msg) => renderMessage(msg));
        }

        // update lastMessageId for this session
        const lastMsg = data[data.length - 1];
        if (lastMsg && lastMsg.id) lastMessageIdBySession[sessionId] = lastMsg.id;

        messagesEl.scrollTop = messagesEl.scrollHeight;

        if (data && data.length) {
            const last = data[data.length - 1].time;
            if (last) lastSeenTimestamp = new Date(last).toISOString();
        }
    } catch (err) {
        console.error('Failed to load messages', err);
    }
}

sendBtn.onclick = async () => {
    const text = messageInput.value.trim();
    if (!text || !activeConversationId) return;

    const payload = { session_id: activeConversationId, message: text };

    try {
        const res = await fetch(API.send, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('send failed');

        // optimistic render
        renderMessage({ sender: 'agent', message: text, time: new Date().toISOString() });
        messageInput.value = '';
        messagesEl.scrollTop = messagesEl.scrollHeight;
        await loadConversations();
    } catch (err) {
        console.error('Failed to send message', err);
    }
};

loadConversations();

// WebSocket client for real-time updates (replaces polling)
try {
    const ws = new WebSocket(`wss://experthub-workspace-crm-inbox.onrender.com`);

    ws.addEventListener('open', () => {
        console.log('WebSocket connected');
    });

    ws.addEventListener('message', (evt) => {
        try {
            const msg = JSON.parse(evt.data);
            if (msg && msg.type === 'message' && msg.data) {
                const d = msg.data;

                // Update conversation row: last_message, move to top, update unread badge
                const sid = d.session_id;
                let el = conversationElements.get(sid);
                const lastMessageText = d.message || '';

                if (!el) {
                    // create a new conversation element and prepend
                    el = document.createElement('div');
                    el.className = 'conversation';
                    el.dataset.sessionId = sid;

                    const main = document.createElement('div');
                    main.className = 'conversation-main';
                    main.innerHTML = `<h4>+${sid}</h4>`;

                    const p = document.createElement('p');
                    p.textContent = lastMessageText;

                    el.appendChild(main);
                    el.appendChild(p);
                    el.onclick = () => selectConversation(sid, el);

                    conversationElements.set(sid, el);
                } else {
                    const p = el.querySelector('p');
                    if (p && p.textContent !== lastMessageText) p.textContent = lastMessageText;
                }

                // move to top
                conversationList.prepend(el);

                // update badge if conversation not active
                const main = el.querySelector('.conversation-main');
                let badge = main.querySelector('.badge');
                if (activeConversationId !== sid) {
                    // increment unread
                    const prev = badge ? parseInt(badge.textContent || '0', 10) : 0;
                    const next = prev + 1;
                    if (!badge) {
                        badge = document.createElement('span');
                        badge.className = 'badge';
                        main.appendChild(badge);
                    }
                    badge.textContent = String(next);
                } else {
                    // if active, append message to messages pane
                    renderMessage({ id: d.id, sender: d.sender, message: d.message, time: d.time });
                    // update lastMessageId for session
                    if (d.id) lastMessageIdBySession[sid] = d.id;
                }
            }
        } catch (err) {
            console.error('Invalid WS message', err);
        }
    });

    ws.addEventListener('close', () => {
        console.log('WebSocket closed');
    });
} catch (err) {
    console.error('WebSocket init failed', err);
}
// end of file
