// Chat page: pick a user, see your saved chats, ask questions and watch the live answer.
/* global marked, DOMPurify */

const $ = (id) => document.getElementById(id);
const chat = $("chat");
const form = $("ask");
const input = $("question");
const sendBtn = $("send");
const stopBtn = $("stop");
const chatList = $("chat-list");
const titleEl = $("title");

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const USER_KEY = "minimi.user";

let user = null; // { id, name }
let currentChatId = null; // the open chat; null = a new chat
let controller = null;
let msgCount = 0;

// --- Small helpers -------------------------------------------------------------

// Browser storage can be blocked (private windows); the page still works without it.
const store = {
  get() { try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { return null; } },
  set(v) { try { localStorage.setItem(USER_KEY, JSON.stringify(v)); } catch { /* ignore */ } },
  clear() { try { localStorage.removeItem(USER_KEY); } catch { /* ignore */ } },
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(user ? { "X-User-Id": String(user.id) } : {}), ...(options.headers || {}) },
  });
}

// Links in answers open in a new tab, safely.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && /^https?:/i.test(node.getAttribute("href") || "")) {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// [1] or [2, 3] in the answer → small links to that message's source list.
function linkCitations(text, id) {
  return text.replace(/\[((?:n:)?\d+(?:\s*,\s*(?:n:)?\d+)*)\]/g, (_, nums) => {
    const links = nums.split(",").map((n) => {
      const k = n.trim().replace("n:", "");
      return `<a href="#src-${id}-${k}">${k}</a>`;
    });
    return `<sup class="cite">[${links.join(", ")}]</sup>`;
  });
}

// Answer text comes from the AI and websites: format it, then clean it before showing.
function renderMarkdown(text, id) {
  return DOMPurify.sanitize(marked.parse(linkCitations(text, id), { gfm: true, breaks: false }));
}

// "Today", "Yesterday", "Mon 9 Nov", "Tue 3 Nov 2025"
function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  const opts = { weekday: "short", day: "numeric", month: "short", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) };
  return d.toLocaleDateString(undefined, opts);
}

function timeLabel(iso) {
  const d = new Date(iso);
  return `${dayLabel(iso)}, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function scrollDown(force = false) {
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160;
  if (force || nearBottom) chat.scrollTop = chat.scrollHeight;
}

function setBusy(busy) {
  sendBtn.hidden = busy;
  stopBtn.hidden = !busy;
  input.disabled = busy;
  if (!busy) input.focus();
}

// --- Who are you? --------------------------------------------------------------

// keepName: after a bad name, keep what was typed so it can be fixed instead of retyped.
function showPicker(message, keepName = false) {
  $("picker").hidden = false;
  $("picker-error").hidden = !message;
  $("picker-error").textContent = message || "";
  if (!keepName) $("picker-name").value = "";
  $("picker-name").focus();
}

async function pickUser(name) {
  const res = await api("/api/users", { method: "POST", body: JSON.stringify({ name }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return showPicker(body.error || "Something went wrong. Try again.", true);
  user = body.user;
  store.set(user);
  $("picker").hidden = true;
  await start();
}

// Called when the server says the remembered user is gone.
function forgetUser(message) {
  user = null;
  currentChatId = null;
  store.clear();
  if (location.hash) history.replaceState(null, "", location.pathname); // the old chat link belongs to the old user
  showPicker(message);
}

// --- Sidebar: your chats ------------------------------------------------------

async function loadChatList() {
  const res = await api("/api/chats");
  if (res.status === 401) return forgetUser("Please pick your name again.");
  const { chats = [] } = await res.json().catch(() => ({}));
  chatList.replaceChildren();
  if (!chats.length) {
    chatList.append(el("div", "none", "No chats yet."));
    return;
  }
  let lastDay = "";
  for (const c of chats) {
    const day = dayLabel(c.updatedAt);
    if (day !== lastDay) {
      chatList.append(el("h3", null, day));
      lastDay = day;
    }
    const a = el("a", c.id === currentChatId ? "active" : "", c.title);
    a.href = `#chat-${c.id}`;
    a.title = c.title;
    chatList.append(a);
  }
}

function markActive() {
  for (const a of chatList.querySelectorAll("a")) a.classList.toggle("active", a.getAttribute("href") === `#chat-${currentChatId}`);
  $("open-memory").classList.remove("active");
}

function closeSidebar() {
  document.body.classList.remove("sidebar-open");
  $("backdrop").hidden = true;
}

// --- Showing messages ------------------------------------------------------------

function showEmpty() {
  chat.replaceChildren($("empty-template").content.cloneNode(true));
  for (const button of chat.querySelectorAll(".example")) {
    button.addEventListener("click", () => { if (!controller) ask(button.textContent); });
  }
  showOpenLoops();
}

// "Still open": choices you started but haven't made. Shown only here, on the New chat screen.
async function showOpenLoops() {
  const res = await api("/api/loops").catch(() => null);
  if (!res || !res.ok) return;
  const { loops = [] } = await res.json().catch(() => ({}));
  const empty = chat.querySelector(".empty");
  if (!loops.length || !empty || currentChatId) return;

  const box = el("div", "loops");
  box.append(el("h2", null, "Still open"));
  for (const l of loops) {
    const card = el("div", "loop");
    card.append(el("div", "loop-text", l.text));
    const meta = el("div", "loop-meta", `since ${dayLabel(l.openedAt)} · from `);
    const link = el("a", null, `"${l.chat.title}"`);
    link.href = `#chat-${l.chat.id}`;
    meta.append(link);
    const buttons = el("div", "loop-buttons");
    const check = el("button", "loop-check", "Check now");
    check.type = "button";
    check.addEventListener("click", () => {
      if (controller) return;
      ask(`Since ${dayLabel(l.openedAt)} I've been choosing between ${l.things.join(", ")}. Has anything changed with them, and which would you pick?`);
    });
    const done = el("button", "loop-done", "Done");
    done.type = "button";
    done.title = "I've decided (or I don't need this any more)";
    done.addEventListener("click", async () => {
      const r = await api(`/api/loops/${l.id}/close`, { method: "POST", body: "{}" }).catch(() => null);
      if (r && r.ok) {
        card.remove();
        if (!box.querySelector(".loop")) box.remove();
      }
    });
    buttons.append(check, done);
    card.append(meta, buttons);
    box.append(card);
  }
  empty.insertBefore(box, empty.querySelector(".examples"));
}

function addUserMessage(text, createdAt) {
  chat.querySelector(".empty")?.remove();
  const msg = el("div", "msg user");
  msg.append(el("div", "bubble", text));
  chat.append(msg);
  if (createdAt) chat.append(el("div", "when", timeLabel(createdAt)));
}

function addAssistantMessage() {
  const id = ++msgCount;
  const msg = el("div", "msg assistant");
  const progress = el("ul", "progress");
  const answer = el("div", "answer");
  msg.append(progress, answer);
  chat.append(msg);
  return { id, msg, progress, answer };
}

function showSources(view, sources) {
  if (!sources || !sources.length) return;
  const box = el("div", "sources");
  box.append(el("h4", null, "Sources"));
  const list = el("ol");
  for (const s of sources) {
    const li = el("li");
    li.id = `src-${view.id}-${s.n}`;
    let host = "";
    try { host = new URL(s.url).hostname.replace(/^www\./, ""); } catch { /* keep empty */ }
    const a = el("a", null, `[${s.n}] ${s.title}`);
    a.href = s.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    li.append(a);
    if (host) li.append(el("span", "host", ` – ${host}`));
    list.append(li);
  }
  box.append(list);
  view.msg.append(box);
}

function showError(view, message) {
  view.answer.querySelector(".thinking")?.remove();
  view.msg.append(el("div", "error", message));
}

// A saved chat: draw all its messages.
function drawSavedMessages(messages) {
  chat.replaceChildren();
  if (!messages.length) return showEmpty();
  for (const m of messages) {
    if (m.role === "user") {
      addUserMessage(m.text, m.createdAt);
    } else {
      const view = addAssistantMessage();
      if (m.searches?.length) view.progress.append(el("li", null, `Searched: ${m.searches.join(" · ")}`));
      view.answer.innerHTML = renderMarkdown(m.text, view.id);
      showSources(view, m.sources);
      if (m.stopped) view.msg.append(el("div", "stopped", "Stopped early."));
    }
  }
  scrollDown(true);
}

// --- Opening chats ----------------------------------------------------------------

async function openChat(id) {
  if (controller) return;
  const res = await api(`/api/chats/${id}`);
  if (res.status === 401) return forgetUser("Please pick your name again.");
  if (!res.ok) return newChat(); // not yours or gone: start fresh
  const { chat: info, messages } = await res.json();
  currentChatId = info.id;
  titleEl.textContent = info.title;
  drawSavedMessages(messages);
  markActive();
  closeSidebar();
}

// --- What I remember ---------------------------------------------------------------

function shortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

async function openMemory() {
  if (controller) return;
  const res = await api("/api/memory");
  if (res.status === 401) return forgetUser("Please pick your name again.");
  const { things = [] } = await res.json().catch(() => ({}));
  currentChatId = null;
  history.replaceState(null, "", "#memory");
  titleEl.textContent = "What I remember";
  markActive();
  $("open-memory").classList.add("active");
  closeSidebar();

  const page = el("section", "memory");
  page.append(el("h1", null, "What I remember"));
  page.append(el("p", null, things.length
    ? "Facts from your chats, newest value first. Older values are kept too, so I can tell you what changed."
    : "Nothing yet. Ask about products, prices or plans, and I'll remember the facts here."));

  for (const t of things) {
    const card = el("div", "thing");
    card.append(el("h2", null, t.name));
    const meta = [t.type, t.website, t.aliases?.length ? `also: ${t.aliases.join(", ")}` : ""].filter(Boolean).join(" · ");
    if (meta) card.append(el("div", "meta", meta));
    if (t.facts.length) {
      const table = el("table");
      for (const f of t.facts) {
        const row = el("tr");
        row.append(el("td", "field", f.field));
        const value = el("td");
        value.append(document.createTextNode(`${f.value} `));
        if (f.sourceUrl) {
          const a = el("a", null, "[source]");
          a.href = f.sourceUrl;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          value.append(a);
        }
        row.append(value, el("td", "when", `checked ${shortDate(f.checkedAt)}`));
        table.append(row);
      }
      card.append(table);
    }
    if (t.chats.length) {
      const seen = el("div", "seen", "Talked about in: ");
      t.chats.forEach((c, i) => {
        if (i) seen.append(document.createTextNode(", "));
        const a = el("a", null, `"${c.title}" (${shortDate(c.at)})`);
        a.href = `#chat-${c.id}`;
        seen.append(a);
      });
      card.append(seen);
    }
    page.append(card);
  }
  chat.replaceChildren(page);
  chat.scrollTop = 0;
}

function newChat() {
  controller?.abort();
  currentChatId = null;
  titleEl.innerHTML = "minimi <span>agent</span>";
  if (location.hash) history.replaceState(null, "", location.pathname);
  showEmpty();
  markActive();
  closeSidebar();
  input.focus();
}

// --- Asking -------------------------------------------------------------------

// Reads the server's live updates (SSE): blocks of "event: x\ndata: {...}" separated by a blank line.
async function* readEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event) yield { event, data: data ? JSON.parse(data) : {} };
    }
  }
}

async function ask(question) {
  addUserMessage(question);
  const view = addAssistantMessage();
  view.answer.append(el("span", "thinking", "Thinking"));
  scrollDown(true);
  setBusy(true);
  controller = new AbortController();
  let text = "";

  try {
    const res = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ question, timezone, ...(currentChatId ? { chatId: currentChatId } : {}) }),
      signal: controller.signal,
    });
    if (res.status === 401) return forgetUser("Please pick your name again.");
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showError(view, body.error || `Something went wrong (HTTP ${res.status}).`);
      return;
    }

    for await (const { event, data } of readEvents(res)) {
      if (event === "chat") {
        // The server saved the question in this chat (new or continued).
        const isNew = currentChatId !== data.id;
        currentChatId = data.id;
        titleEl.textContent = data.title;
        history.replaceState(null, "", `#chat-${data.id}`);
        if (isNew) loadChatList();
      } else if (event === "recall") {
        // Memory question: which old chat(s) the answer is based on.
        const li = el("li", "memory");
        if (data.found) {
          li.append(document.createTextNode(`Found your chat${data.chats.length > 1 ? "s" : ""} from ${data.label ?? "earlier"}: `));
          data.chats.forEach((c, i) => {
            if (i) li.append(document.createTextNode(", "));
            const a = el("a", null, `"${c.title}"`);
            a.href = `#chat-${c.id}`;
            li.append(a);
          });
          if (data.note) li.append(document.createTextNode(` (${data.note})`));
        } else {
          li.textContent = data.note || "No saved chat found";
        }
        view.progress.append(li);
      } else if (event === "search") {
        view.progress.append(el("li", null, `Searching: ${data.query}`));
      } else if (event === "search_failed") {
        view.progress.append(el("li", "warn", `Search failed: ${data.query}`));
      } else if (event === "text") {
        text += data.text;
        view.answer.innerHTML = renderMarkdown(text, view.id);
      } else if (event === "sources") {
        showSources(view, data.sources);
      } else if (event === "error") {
        showError(view, data.message);
      }
      scrollDown();
    }
  } catch (err) {
    if (err.name === "AbortError") view.msg.append(el("div", "stopped", "Stopped."));
    else showError(view, "Lost connection to the server. Is it still running?");
  } finally {
    view.answer.querySelector(".thinking")?.remove();
    controller = null;
    setBusy(false);
    scrollDown();
    loadChatList(); // this chat moves to the top
  }
}

// --- Events ---------------------------------------------------------------------

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const question = input.value.trim();
  if (!question || controller || !user) return;
  input.value = "";
  input.style.height = "";
  ask(question);
});

// Enter sends; Shift+Enter adds a new line.
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

// The box grows with the text.
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
});

stopBtn.addEventListener("click", () => controller?.abort());
$("new-chat").addEventListener("click", newChat);
$("open-memory").addEventListener("click", openMemory);
$("switch-user").addEventListener("click", () => {
  if (controller) return;
  forgetUser();
});
$("toggle-sidebar").addEventListener("click", () => {
  document.body.classList.add("sidebar-open");
  $("backdrop").hidden = false;
});
$("backdrop").addEventListener("click", closeSidebar);
$("picker-form").addEventListener("submit", (e) => {
  e.preventDefault();
  pickUser($("picker-name").value);
});

// Clicking a chat in the sidebar (or the back button) changes #chat-N.
window.addEventListener("hashchange", () => {
  const m = /^#chat-(\d+)$/.exec(location.hash);
  if (m && Number(m[1]) !== currentChatId) openChat(Number(m[1]));
  else if (location.hash === "#memory") openMemory();
});

// --- Start ----------------------------------------------------------------------

async function start() {
  $("user-name").textContent = user.name;
  await loadChatList();
  const m = /^#chat-(\d+)$/.exec(location.hash);
  if (m) await openChat(Number(m[1]));
  else if (location.hash === "#memory") await openMemory();
  else newChat();
}

(async function boot() {
  user = store.get();
  if (!user) return showPicker();
  // Check the remembered user still exists (e.g. the database was reset).
  const res = await api("/api/me").catch(() => null);
  if (!res || !res.ok) return forgetUser(res ? "Please pick your name again." : undefined);
  user = (await res.json()).user;
  await start();
})();
