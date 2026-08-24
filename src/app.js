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
  view: "auth", // "auth" | "list" | "form" | "chat"
  conversations: [], // roster from GET /api/characters
  formMode: "create", // "create" | "edit"
  editingCharacterId: null,
  character: null, // current chat's character info (from /api/me)
  conversationId: null,
  messages: [],
  replyTarget: null,
  pollTimer: null,
  headerTimer: null,
  lastPolledId: null,
  revealing: false, // true while a typing-reveal animation is in progress
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
    showList();
  } else {
    showAuth();
  }
}

/* ===================== Screen switching ===================== */

function showScreen(name) {
  state.view = name;
  el("auth-screen").hidden = name !== "auth";
  el("list-screen").hidden = name !== "list";
  el("form-screen").hidden = name !== "form";
  el("chat-screen").hidden = name !== "chat";
  if (name !== "chat") stopPolling();
}

/* ===================== Auth screen ===================== */

function showAuth() {
  showScreen("auth");
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
      showList();
    } else {
      const user = await signup(email, password);
      if (user && (user.confirmedAt || user.confirmed_at)) {
        showList();
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

async function doLogout() {
  await logout().catch(() => {});
  state.conversations = [];
  state.character = null;
  state.conversationId = null;
  state.messages = [];
  showAuth();
}
el("list-logout-btn").addEventListener("click", doLogout);

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

/* ===================== Character list screen ===================== */

async function showList() {
  showScreen("list");
  try {
    const data = await api("/api/characters");
    state.conversations = data.conversations;
    renderConversationList();
  } catch (err) {
    console.error(err);
    if (err.status === 401) showAuth();
  }
}

function timeAgo(iso) {
  if (!iso) return "";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function renderConversationList() {
  const list = el("conversation-list");
  const empty = el("list-empty");
  list.innerHTML = "";

  if (state.conversations.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  for (const convo of state.conversations) {
    const row = document.createElement("button");
    row.className = "conversation-row";
    row.type = "button";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = convo.avatarEmoji || "🙂";
    row.appendChild(avatar);

    const body = document.createElement("div");
    body.className = "conversation-row-body";

    const top = document.createElement("div");
    top.className = "conversation-row-top";
    const name = document.createElement("span");
    name.className = "conversation-row-name";
    name.textContent = convo.name;
    top.appendChild(name);
    if (convo.lastMessage) {
      const time = document.createElement("span");
      time.className = "conversation-row-time";
      time.textContent = timeAgo(convo.lastMessage.createdAt);
      top.appendChild(time);
    }
    body.appendChild(top);

    const preview = document.createElement("p");
    preview.className = "conversation-row-preview";
    if (convo.lastMessage) {
      const prefix = convo.lastMessage.sender === "user" ? "You: " : "";
      preview.textContent = prefix + convo.lastMessage.content;
    } else {
      preview.textContent = convo.tagline || convo.currentActivity || "say hi";
    }
    body.appendChild(preview);

    row.appendChild(body);
    row.addEventListener("click", () => openConversation(convo.conversationId));
    list.appendChild(row);
  }
}

el("new-character-fab").addEventListener("click", () => openCreateForm());

/* ===================== Character create/edit form ===================== */

function resetForm() {
  el("form-seed").value = "";
  el("form-avatar").value = "";
  el("form-name").value = "";
  el("form-tagline").value = "";
  el("form-persona").value = "";
  el("form-style").value = "";
  el("form-activity").value = "";
  el("form-mood").value = "";
  el("form-timezone").value = "";
  setFormError(null);
}

function populateForm(data) {
  el("form-avatar").value = data.avatarEmoji || "";
  el("form-name").value = data.name || "";
  el("form-tagline").value = data.tagline || "";
  el("form-persona").value = data.persona || "";
  el("form-style").value = data.communicationStyle || "";
  el("form-activity").value = data.currentActivity || "";
  el("form-mood").value = data.currentMood || "";
  el("form-timezone").value = data.timezone || "";
}

function setFormError(message) {
  const box = el("form-error");
  if (!message) {
    box.hidden = true;
    box.textContent = "";
  } else {
    box.hidden = false;
    box.textContent = message;
  }
}

function openCreateForm() {
  state.formMode = "create";
  state.editingCharacterId = null;
  el("form-title").textContent = "New character";
  el("form-submit").textContent = "Create character";
  el("generate-block").hidden = false;
  resetForm();
  showScreen("form");
}

function openEditForm() {
  if (!state.character) return;
  const cached = state.conversations.find((c) => c.characterId === state.character.id);
  state.formMode = "edit";
  state.editingCharacterId = state.character.id;
  el("form-title").textContent = "Edit character";
  el("form-submit").textContent = "Save changes";
  el("generate-block").hidden = true;
  setFormError(null);
  populateForm({
    avatarEmoji: state.character.avatarEmoji,
    name: state.character.name,
    tagline: state.character.tagline,
    persona: cached?.persona,
    communicationStyle: cached?.communicationStyle,
    currentActivity: cached?.currentActivity,
    currentMood: cached?.currentMood,
    timezone: cached?.timezone,
  });
  showScreen("form");
}

el("chat-edit-btn").addEventListener("click", openEditForm);

el("form-back-btn").addEventListener("click", () => {
  if (state.formMode === "edit" && state.conversationId) {
    showScreen("chat");
    startPolling();
  } else {
    showList();
  }
});

el("generate-btn").addEventListener("click", async () => {
  const btn = el("generate-btn");
  const label = el("generate-btn-label");
  const seedPrompt = el("form-seed").value.trim();
  btn.disabled = true;
  const prevLabel = label.textContent;
  label.textContent = "✨ Generating…";
  setFormError(null);

  try {
    const result = await api("/api/generate-character", {
      method: "POST",
      body: JSON.stringify({ seedPrompt }),
    });
    populateForm(result.draft);
  } catch (err) {
    console.error(err);
    setFormError(err.message || "Couldn't generate a character. Try again.");
  } finally {
    btn.disabled = false;
    label.textContent = prevLabel;
  }
});

el("character-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  setFormError(null);

  const name = el("form-name").value.trim();
  const persona = el("form-persona").value.trim();
  if (!name || !persona) {
    setFormError("Name and persona are required.");
    return;
  }

  const payload = {
    name,
    avatarEmoji: el("form-avatar").value.trim(),
    tagline: el("form-tagline").value.trim(),
    persona,
    communicationStyle: el("form-style").value.trim(),
    currentActivity: el("form-activity").value.trim(),
    currentMood: el("form-mood").value.trim(),
    timezone: el("form-timezone").value.trim(),
  };

  const submitBtn = el("form-submit");
  submitBtn.disabled = true;

  try {
    if (state.formMode === "create") {
      const result = await api("/api/characters", { method: "POST", body: JSON.stringify(payload) });
      await showList(); // refresh roster cache so the new character is there for later edits
      await openConversation(result.conversationId);
    } else {
      payload.characterId = state.editingCharacterId;
      await api("/api/characters", { method: "PATCH", body: JSON.stringify(payload) });
      await showList();
      if (state.conversationId) await openConversation(state.conversationId);
    }
  } catch (err) {
    console.error(err);
    setFormError(err.message || "Something went wrong. Try again.");
  } finally {
    submitBtn.disabled = false;
  }
});

/* ===================== Chat screen ===================== */

el("chat-back-btn").addEventListener("click", () => showList());

async function openConversation(conversationId) {
  state.conversationId = conversationId;
  state.messages = [];
  state.replyTarget = null;
  clearReplyPreview();
  el("message-list").innerHTML = "";
  showScreen("chat");

  try {
    const me = await api(`/api/me?conversationId=${encodeURIComponent(conversationId)}`);
    state.character = me.character;
    renderHeader(me.character);

    const data = await api(`/api/messages?conversationId=${encodeURIComponent(conversationId)}`);
    state.messages = data.messages;
    renderAllMessages();
    scrollToBottom();

    startPolling();
  } catch (err) {
    console.error(err);
    if (err.status === 401) showAuth();
    else if (err.status === 404) showList();
  }
}

function renderHeader(character) {
  el("character-avatar").textContent = character.avatarEmoji || "🙂";
  el("character-name").textContent = character.name;
  el("status-text").textContent = character.currentActivity || "around";
  const dot = el("status-dot");
  const isBusy = Boolean(character.busy);
  dot.classList.toggle("active", !isBusy);
  dot.classList.toggle("busy", isBusy);
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

function hasMessage(id) {
  return state.messages.some((m) => m.id === id);
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
  if (!content || !state.conversationId) return;

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
      body: JSON.stringify({ conversationId: state.conversationId, content, replyToMessageId }),
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

    // Mark these as already-seen right away — before the animated reveal
    // below, which can take several seconds. Otherwise a poll tick firing
    // mid-reveal would see them as "new" (they're already in the DB) and
    // duplicate them.
    const lastOfExchange =
      result.characterMessages.length > 0
        ? result.characterMessages[result.characterMessages.length - 1]
        : result.userMessage;
    state.lastPolledId = lastOfExchange.id;

    await revealCharacterMessages(result.characterMessages);
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
  const newOnes = messages.filter((m) => !hasMessage(m.id));
  if (newOnes.length === 0) return;

  state.revealing = true;
  try {
    for (const msg of newOnes) {
      if (hasMessage(msg.id)) continue; // could've arrived via another path mid-loop
      const typingMs = Math.min(3200, 450 + msg.content.length * 28);
      el("typing-indicator").hidden = false;
      scrollToBottom();
      await sleep(typingMs);
      el("typing-indicator").hidden = true;

      if (hasMessage(msg.id)) continue;
      state.messages.push(msg);
      renderAllMessages();
      scrollToBottom();
    }
  } finally {
    state.revealing = false;
    el("typing-indicator").hidden = true;
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

/* ===================== Reactions & reply (unified long-press menu) ===================== */

let pressTimer = null;

function attachRowInteractions(row, msg) {
  const start = (e) => {
    // Ignore multi-touch (pinch-zoom gestures) and non-primary buttons.
    if (e.button != null && e.button !== 0) return;
    pressTimer = setTimeout(() => {
      openMessageActions(row, msg);
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
}

function openMessageActions(row, msg) {
  const picker = el("reaction-picker");
  const replyBtn = el("picker-reply-btn");
  const rect = row.getBoundingClientRect();

  picker.hidden = false;
  picker.style.left = `${Math.min(
    Math.max(rect.left, 12),
    window.innerWidth - picker.offsetWidth - 12
  )}px`;
  picker.style.top = `${rect.top - 52}px`;

  function closePicker() {
    picker.hidden = true;
    picker.removeEventListener("click", onPick);
    replyBtn.removeEventListener("click", onReply);
    document.removeEventListener("pointerdown", dismiss, true);
  }

  const onPick = async (e) => {
    const btn = e.target.closest("button[data-emoji]");
    if (!btn) return;
    closePicker();
    try {
      const result = await api("/api/react", {
        method: "POST",
        body: JSON.stringify({ conversationId: state.conversationId, messageId: msg.id, emoji: btn.dataset.emoji }),
      });
      msg.userReaction = result.emoji;
      renderAllMessages();
    } catch (err) {
      console.error(err);
    }
  };

  const onReply = () => {
    closePicker();
    setReplyTarget(msg);
  };

  const dismiss = (e) => {
    if (!picker.contains(e.target)) closePicker();
  };

  picker.addEventListener("click", onPick);
  replyBtn.addEventListener("click", onReply);
  setTimeout(() => document.addEventListener("pointerdown", dismiss, true), 0);
}

/* ===================== Polling for spontaneous messages ===================== */

function startPolling() {
  stopPolling();
  state.lastPolledId = latestMessageId();
  state.pollTimer = setInterval(pollForNewMessages, 7000);
  state.headerTimer = setInterval(refreshHeader, 60000);
  document.addEventListener("visibilitychange", handleVisibility);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.headerTimer) clearInterval(state.headerTimer);
  state.pollTimer = null;
  state.headerTimer = null;
  document.removeEventListener("visibilitychange", handleVisibility);
}

function handleVisibility() {
  if (document.hidden) {
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.headerTimer) clearInterval(state.headerTimer);
    state.pollTimer = null;
    state.headerTimer = null;
  } else if (!state.pollTimer && state.view === "chat") {
    pollForNewMessages();
    refreshHeader();
    state.pollTimer = setInterval(pollForNewMessages, 7000);
    state.headerTimer = setInterval(refreshHeader, 60000);
  }
}

async function refreshHeader() {
  if (!state.conversationId) return;
  try {
    const me = await api(`/api/me?conversationId=${encodeURIComponent(state.conversationId)}`);
    state.character = me.character;
    renderHeader(me.character);
  } catch (err) {
    if (err.status === 401) {
      stopPolling();
      showAuth();
    }
  }
}

async function pollForNewMessages() {
  if (!state.lastPolledId || !state.conversationId) return;
  try {
    const data = await api(
      `/api/messages?conversationId=${encodeURIComponent(state.conversationId)}&after_id=${encodeURIComponent(state.lastPolledId)}`
    );
    if (data.messages.length === 0) return;

    // Always advance the cursor to the tail of what the server returned,
    // even for messages we filter out below, so we don't re-fetch them.
    state.lastPolledId = data.messages[data.messages.length - 1].id;

    const newMessages = data.messages.filter((m) => !hasMessage(m.id));
    if (newMessages.length === 0) return;

    const characterOnly = newMessages.filter((m) => m.sender === "character");
    const userEchoes = newMessages.filter((m) => m.sender === "user");
    for (const m of userEchoes) {
      if (!hasMessage(m.id)) state.messages.push(m); // rare: sent from another tab/device
    }

    if (characterOnly.length > 0) {
      await revealCharacterMessages(characterOnly);
    } else if (userEchoes.length > 0) {
      renderAllMessages();
      scrollToBottom();
    }
  } catch (err) {
    if (err.status === 401) {
      stopPolling();
      showAuth();
    }
  }
}

boot();
