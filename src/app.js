import {
  signup,
  login,
  logout,
  getUser,
  handleAuthCallback,
} from "@netlify/identity";

/* ===================== State ===================== */

const state = {
  authMode: "login", // "login" | "signup"
  character: null,
  messages: [], // ordered array of message objects (see serializeMessage on the server)
  replyTarget: null, // { id, snippet }
  pollTimer: null,
  lastPolledId: null,
};

const el = (id) => document.getElementById(id);

/* ===================== Boot ===================== */

async function boot() {
  try {
    await handleAuthCallback();
  } catch {
    // no pending callback token in the URL — normal case, ignore
  }

  const user = await getUser().catch(() => null);
  if (user) {
    showChat();
  } else {
    showAuth();
  }
}

/* ===================== Auth screen ===================== */

function showAuth() {
  el("auth-screen").hidden = false;
  el("chat-screen").hidden = true;
  stopPolling();
}

function setAuthError(message) {
  const box = el("auth-error");
  if (!message) {
    box.hidden = true;
    box.textContent = "";
  } else {
    box.hidden = false;
    box.textContent = message;
  }
}

el("auth-toggle-mode").addEventListener("click", () => {
  state.authMode = state.authMode === "login" ? "signup" : "login";
  setAuthError(null);
  el("auth-submit").textContent = state.authMode === "login" ? "Log in" : "Sign up";
  el("auth-toggle-mode").textContent =
    state.authMode === "login" ? "Need an account? Sign up" : "Already have an account? Log in";
});

el("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setAuthError(null);

  const email = el("auth-email").value.trim();
  const password = el("auth-password").value;
  const submitBtn = el("auth-submit");
  submitBtn.disabled = true;

  try {
    if (state.authMode === "login") {
      await login(email, password);
      showChat();
    } else {
      const user = await signup(email, password);
      if (user && (user.confirmedAt || user.confirmed_at)) {
        showChat();
      } else {
        setAuthError("Account created! Check your email to confirm it, then log in.");
        state.authMode = "login";
        el("auth-submit").textContent = "Log in";
        el("auth-toggle-mode").textContent = "Need an account? Sign up";
      }
    }
  } catch (err) {
    setAuthError(err?.message || "Something went wrong. Try again.");
  } finally {
    submitBtn.disabled = false;
  }
});

el("logout-btn").addEventListener("click", async () => {
  await logout().catch(() => {});
  state.messages = [];
  state.character = null;
  el("message-list").innerHTML = "";
  showAuth();
});

/* ===================== Chat screen ===================== */

async function showChat() {
  el("auth-screen").hidden = true;
  el("chat-screen").hidden = false;

  try {
    const me = await api("/api/me");
    state.character = me.character;
    renderHeader(me.character);

    const data = await api("/api/messages");
    state.messages = data.messages;
    renderAllMessages();
    scrollToBottom();

    startPolling();
  } catch (err) {
    console.error(err);
    if (err.status === 401) {
      showAuth();
    }
  }
}

function renderHeader(character) {
  el("character-avatar").textContent = character.avatarEmoji || "🙂";
  el("character-name").textContent = character.name;
  el("status-text").textContent = character.currentActivity || "around";
  el("status-dot").classList.add("active");
}

/* ===================== API helper ===================== */

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
      // ignore
    }
    const error = new Error(message);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/* ===================== Rendering ===================== */

function renderAllMessages() {
  const list = el("message-list");
  list.innerHTML = "";
  let lastDate = null;
  let lastSender = null;

  for (const msg of state.messages) {
    const dateKey = new Date(msg.createdAt).toDateString();
    if (dateKey !== lastDate) {
      list.appendChild(dateSeparator(msg.createdAt));
      lastDate = dateKey;
      lastSender = null;
    }
    list.appendChild(messageRow(msg, msg.sender === lastSender));
    lastSender = msg.sender;
  }
}

function dateSeparator(iso) {
  const div = document.createElement("div");
  div.className = "date-separator";
  const d = new Date(iso);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  div.textContent = isToday
    ? "Today"
    : d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  return div;
}

function findMessage(id) {
  return state.messages.find((m) => m.id === id);
}

function messageRow(msg, grouped) {
  const row = document.createElement("div");
  row.className = `msg-row from-${msg.sender}${grouped ? " grouped" : ""}`;
  row.dataset.id = msg.id;

  if (msg.replyToMessageId) {
    const original = findMessage(msg.replyToMessageId);
    if (original) {
      const quote = document.createElement("div");
      quote.className = "reply-quote";
      quote.textContent = original.content;
      row.appendChild(quote);
    }
  }

  const wrap = document.createElement("div");
  wrap.className = "bubble-wrap";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = msg.content;
  wrap.appendChild(bubble);

  const reactionEmoji = msg.sender === "user" ? msg.characterReaction : msg.userReaction;
  if (reactionEmoji) {
    const badge = document.createElement("span");
    badge.className = "reaction-badge";
    badge.textContent = reactionEmoji;
    wrap.appendChild(badge);
  }

  row.appendChild(wrap);

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const time = new Date(msg.createdAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  if (msg.sender === "user") {
    meta.innerHTML = `<span>${time}</span><span class="${msg.readAt ? "read-ticks" : ""}">${
      msg.readAt ? "✓✓" : "✓"
    }</span>`;
  } else {
    meta.textContent = time;
  }
  row.appendChild(meta);

  attachRowInteractions(row, msg);
  return row;
}

function scrollToBottom() {
  const list = el("message-list");
  list.scrollTop = list.scrollHeight;
}

/* ===================== Composer / sending ===================== */

const textarea = el("composer-input");
const sendBtn = el("composer-send");

textarea.addEventListener("input", () => {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
  sendBtn.disabled = textarea.value.trim().length === 0;
});

textarea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    el("composer").requestSubmit();
  }
});

el("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const content = textarea.value.trim();
  if (!content) return;

  const replyToMessageId = state.replyTarget?.id || null;
  clearReplyPreview();
  textarea.value = "";
  textarea.style.height = "auto";
  sendBtn.disabled = true;

  // Optimistic bubble
  const tempId = `temp-${Date.now()}`;
  const optimistic = {
    id: tempId,
    sender: "user",
    content,
    replyToMessageId,
    createdAt: new Date().toISOString(),
    readAt: null,
  };
  state.messages.push(optimistic);
  renderAllMessages();
  scrollToBottom();

  try {
    const result = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ content, replyToMessageId }),
    });

    // Swap the optimistic message for the confirmed one.
    const idx = state.messages.findIndex((m) => m.id === tempId);
    if (idx !== -1) state.messages[idx] = result.userMessage;

    if (result.reaction) {
      const target = findMessage(result.reaction.messageId);
      if (target) target.characterReaction = result.reaction.emoji;
    }

    renderAllMessages();
    scrollToBottom();

    await revealCharacterMessages(result.characterMessages);
    state.lastPolledId = latestMessageId();
  } catch (err) {
    console.error(err);
    const idx = state.messages.findIndex((m) => m.id === tempId);
    if (idx !== -1) state.messages.splice(idx, 1);
    renderAllMessages();
  } finally {
    sendBtn.disabled = textarea.value.trim().length === 0;
  }
});

async function revealCharacterMessages(messages) {
  for (const msg of messages) {
    const typingMs = Math.min(3200, 450 + msg.content.length * 28);
    el("typing-indicator").hidden = false;
    scrollToBottom();
    await sleep(typingMs);
    el("typing-indicator").hidden = true;

    state.messages.push(msg);
    renderAllMessages();
    scrollToBottom();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function latestMessageId() {
  if (state.messages.length === 0) return null;
  return state.messages[state.messages.length - 1].id;
}

/* ===================== Reply UI ===================== */

function setReplyTarget(msg) {
  state.replyTarget = { id: msg.id, snippet: msg.content };
  el("reply-preview").hidden = false;
  el("reply-preview-text").textContent = msg.content;
  textarea.focus();
}

function clearReplyPreview() {
  state.replyTarget = null;
  el("reply-preview").hidden = true;
}

el("reply-preview-cancel").addEventListener("click", clearReplyPreview);

/* ===================== Reactions & reply trigger (long-press) ===================== */

let pressTimer = null;

function attachRowInteractions(row, msg) {
  const start = () => {
    pressTimer = setTimeout(() => {
      openReactionPicker(row, msg);
      pressTimer = null;
    }, 420);
  };
  const cancel = () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  };

  row.addEventListener("pointerdown", start);
  row.addEventListener("pointerup", cancel);
  row.addEventListener("pointerleave", cancel);
  row.addEventListener("pointercancel", cancel);

  // Desktop convenience: double-click to reply.
  row.addEventListener("dblclick", () => setReplyTarget(msg));
}

function openReactionPicker(row, msg) {
  const picker = el("reaction-picker");
  const rect = row.getBoundingClientRect();
  picker.hidden = false;
  picker.style.left = `${Math.min(
    Math.max(rect.left, 12),
    window.innerWidth - picker.offsetWidth - 12
  )}px`;
  picker.style.top = `${rect.top - 52}px`;

  const onPick = async (e) => {
    const btn = e.target.closest("button[data-emoji]");
    if (!btn) return;
    picker.hidden = true;
    picker.removeEventListener("click", onPick);
    try {
      const result = await api("/api/react", {
        method: "POST",
        body: JSON.stringify({ messageId: msg.id, emoji: btn.dataset.emoji }),
      });
      msg.userReaction = result.emoji;
      renderAllMessages();
    } catch (err) {
      console.error(err);
    }
  };
  picker.addEventListener("click", onPick);

  const dismiss = (e) => {
    if (!picker.contains(e.target)) {
      picker.hidden = true;
      document.removeEventListener("pointerdown", dismiss, true);
    }
  };
  setTimeout(() => document.addEventListener("pointerdown", dismiss, true), 0);
}

/* ===================== Polling for spontaneous messages ===================== */

function startPolling() {
  stopPolling();
  state.lastPolledId = latestMessageId();
  state.pollTimer = setInterval(pollForNewMessages, 7000);
  document.addEventListener("visibilitychange", handleVisibility);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  document.removeEventListener("visibilitychange", handleVisibility);
}

function handleVisibility() {
  if (document.hidden) {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  } else if (!state.pollTimer) {
    pollForNewMessages();
    state.pollTimer = setInterval(pollForNewMessages, 7000);
  }
}

async function pollForNewMessages() {
  if (!state.lastPolledId) return;
  try {
    const data = await api(`/api/messages?after_id=${encodeURIComponent(state.lastPolledId)}`);
    if (data.messages.length === 0) return;

    const characterOnly = data.messages.filter((m) => m.sender === "character");
    const userEchoes = data.messages.filter((m) => m.sender === "user");
    for (const m of userEchoes) state.messages.push(m); // rare: sent from another tab/device

    if (characterOnly.length > 0) {
      await revealCharacterMessages(characterOnly);
    } else if (userEchoes.length > 0) {
      renderAllMessages();
      scrollToBottom();
    }
    state.lastPolledId = latestMessageId();
  } catch (err) {
    if (err.status === 401) {
      stopPolling();
      showAuth();
    }
  }
}

boot();
