// Chat page: sends a question to /api/chat and shows the live answer.
/* global marked, DOMPurify */

const chat = document.getElementById("chat");
const empty = document.getElementById("empty");
const form = document.getElementById("ask");
const input = document.getElementById("question");
const sendBtn = document.getElementById("send");
const stopBtn = document.getElementById("stop");

const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Kept for follow-ups. (Phase 2 moves this into the database.)
let history = []; // [{ role: "user" | "assistant", text }]
let note = null; // { things, topic }: what we're talking about, from the last answer
let controller = null;
let msgCount = 0;

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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function scrollDown() {
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 160;
  if (nearBottom) chat.scrollTop = chat.scrollHeight;
}

function setBusy(busy) {
  sendBtn.hidden = busy;
  stopBtn.hidden = !busy;
  input.disabled = busy;
  if (!busy) input.focus();
}

function addUserMessage(text) {
  const msg = el("div", "msg user");
  msg.append(el("div", "bubble", text));
  chat.append(msg);
}

function addAssistantMessage() {
  const id = ++msgCount;
  const msg = el("div", "msg assistant");
  const progress = el("ul", "progress");
  const answer = el("div", "answer");
  answer.append(el("span", "thinking", "Thinking"));
  msg.append(progress, answer);
  chat.append(msg);
  return { id, msg, progress, answer };
}

function showSources(view, sources) {
  if (!sources.length) return;
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
  empty?.remove();
  addUserMessage(question);
  const view = addAssistantMessage();
  scrollDown();
  setBusy(true);

  controller = new AbortController();
  let text = "";
  let finished = false;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history, timezone, ...(note ? { note } : {}) }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showError(view, body.error || `Something went wrong (HTTP ${res.status}).`);
      return;
    }

    for await (const { event, data } of readEvents(res)) {
      if (event === "search") {
        view.progress.append(el("li", null, `Searching: ${data.query}`));
      } else if (event === "search_failed") {
        view.progress.append(el("li", "warn", `Search failed: ${data.query}`));
      } else if (event === "text") {
        text += data.text;
        view.answer.innerHTML = renderMarkdown(text, view.id);
      } else if (event === "note") {
        note = data.note;
      } else if (event === "sources") {
        showSources(view, data.sources);
      } else if (event === "error") {
        showError(view, data.message);
      } else if (event === "done") {
        finished = true;
      }
      scrollDown();
    }
  } catch (err) {
    if (err.name === "AbortError") view.msg.append(el("div", "stopped", "Stopped."));
    else showError(view, "Lost connection to the server. Is it still running?");
  } finally {
    view.answer.querySelector(".thinking")?.remove();
    if (text) {
      history.push({ role: "user", text: question }, { role: "assistant", text: finished ? text : `${text}\n\n(stopped early)` });
      history = history.slice(-20);
    }
    controller = null;
    setBusy(false);
    scrollDown();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const question = input.value.trim();
  if (!question || controller) return;
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

document.getElementById("new-chat").addEventListener("click", () => {
  controller?.abort();
  history = [];
  note = null;
  location.reload();
});

for (const button of document.querySelectorAll(".example")) {
  button.addEventListener("click", () => {
    if (!controller) ask(button.textContent);
  });
}
