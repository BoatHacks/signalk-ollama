// signalk-ollama webapp: status dashboard + LLM playground. Vanilla JS, no
// build step — served as a static Signal K webapp (keyword "signalk-webapp"),
// distinct from the plugin config panel (a separate Module Federation
// remote also served from this same public/ directory).

const BASE = "/plugins/signalk-ollama";
const STATUS_POLL_MS = 5000;

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------

const tabs = document.querySelectorAll(".tab");
const panels = {
  status: document.getElementById("panel-status"),
  playground: document.getElementById("panel-playground"),
};

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => {
      t.classList.toggle("active", t === tab);
      t.setAttribute("aria-selected", t === tab ? "true" : "false");
    });
    Object.entries(panels).forEach(([name, panel]) => {
      panel.classList.toggle("hidden", name !== tab.dataset.tab);
    });
    if (tab.dataset.tab === "playground") {
      refreshInteractions();
    }
  });
});

// ---------------------------------------------------------------------
// Status polling
// ---------------------------------------------------------------------

const connDot = document.getElementById("conn-dot");
const connLabel = document.getElementById("conn-label");
const cStatus = document.getElementById("c-status");
const cImage = document.getElementById("c-image");
const cUri = document.getElementById("c-uri");
const cRuntime = document.getElementById("c-runtime");
const modelList = document.getElementById("model-list");
const modelSelect = document.getElementById("model-select");
const pullPrompt = document.getElementById("pull-prompt");

let lastReadyModels = [];

function statusBadgeClass(status) {
  return ["ready", "pulling", "error", "pending"].includes(status)
    ? status
    : "pending";
}

function renderStatus(data) {
  const st = data.status || "not_running";
  connLabel.textContent = st;
  connDot.className =
    "conn-dot " +
    (st === "ready" ? "ok" : st === "starting" ? "warn" : "error");

  cStatus.textContent = st;
  cImage.textContent = data.tag ? `ollama/ollama:${data.tag}` : "—";
  cUri.textContent = data.uri || "—";
  cRuntime.textContent = data.containerState || "—";

  const models = data.models || {};
  const names = Object.keys(models);
  modelList.innerHTML = "";
  if (names.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No models configured.";
    modelList.appendChild(li);
  } else {
    for (const name of names) {
      const state = models[name] || {};
      const li = document.createElement("li");
      li.className = "model-row";
      const pct = typeof state.percent === "number" ? ` ${state.percent}%` : "";
      li.innerHTML = `
        <span class="name">${escapeHtml(name)}</span>
        <span class="badge ${statusBadgeClass(state.status)}">${escapeHtml(state.status || "pending")}${pct}</span>
      `;
      if (state.status === "pulling" && typeof state.percent === "number") {
        const progress = document.createElement("div");
        progress.className = "progress";
        progress.innerHTML = `<span style="width:${state.percent}%"></span>`;
        li.appendChild(progress);
      }
      modelList.appendChild(li);
    }
  }

  const ready = names.filter((n) => models[n]?.status === "ready");
  pullPrompt.classList.toggle("hidden", ready.length > 0);
  if (JSON.stringify(ready) !== JSON.stringify(lastReadyModels)) {
    lastReadyModels = ready;
    const current = modelSelect.value;
    modelSelect.innerHTML = "";
    if (ready.length === 0) {
      const opt = document.createElement("option");
      opt.textContent = "No ready models — pull one first";
      opt.disabled = true;
      opt.selected = true;
      modelSelect.appendChild(opt);
    } else {
      for (const name of ready) {
        const opt = document.createElement("option");
        opt.value = name;
        opt.textContent = name;
        modelSelect.appendChild(opt);
      }
      if (ready.includes(current)) modelSelect.value = current;
    }
  }
}

async function pollStatus() {
  try {
    const res = await fetch(`${BASE}/api/status`);
    if (res.status === 503) {
      connLabel.textContent = "plugin not running";
      connDot.className = "conn-dot error";
      cStatus.textContent = "not running";
      cImage.textContent = "—";
      cUri.textContent = "—";
      cRuntime.textContent = "—";
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderStatus(await res.json());
  } catch (err) {
    connLabel.textContent = "unreachable";
    connDot.className = "conn-dot error";
  }
}

pollStatus();
setInterval(pollStatus, STATUS_POLL_MS);

// ---------------------------------------------------------------------
// Playground
// ---------------------------------------------------------------------

const chatLog = document.getElementById("chat-log");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");
const chatStop = document.getElementById("chat-stop");
const systemPrompt = document.getElementById("system-prompt");
const clearChatBtn = document.getElementById("clear-chat");

let conversation = [];
let activeAbort = null;

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function addBubble(role, text) {
  if (chatLog.querySelector(".chat-hint")) chatLog.innerHTML = "";
  const bubble = document.createElement("div");
  bubble.className = `bubble ${role}`;
  bubble.textContent = text;
  chatLog.appendChild(bubble);
  chatLog.scrollTop = chatLog.scrollHeight;
  return bubble;
}

clearChatBtn.addEventListener("click", () => {
  conversation = [];
  chatLog.innerHTML = '<p class="chat-hint">Conversation cleared.</p>';
});

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const model = modelSelect.value;
  const text = chatInput.value.trim();
  if (!model || !text) return;

  const system = systemPrompt.value.trim();
  if (system && conversation.length === 0) {
    conversation.push({ role: "system", content: system });
  }
  conversation.push({ role: "user", content: text });
  addBubble("user", text);
  chatInput.value = "";

  const assistantBubble = addBubble("assistant", "");
  assistantBubble.classList.add("streaming");

  chatSend.disabled = true;
  chatStop.classList.remove("hidden");
  const abort = new AbortController();
  activeAbort = abort;

  let assistantText = "";
  try {
    const res = await fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, messages: conversation }),
      signal: abort.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        const chunk = JSON.parse(line);
        if (chunk.error) throw new Error(chunk.error);
        if (chunk.message?.content) {
          assistantText += chunk.message.content;
          assistantBubble.textContent = assistantText;
          chatLog.scrollTop = chatLog.scrollHeight;
        }
      }
    }
    conversation.push({ role: "assistant", content: assistantText });
  } catch (err) {
    if (err.name === "AbortError") {
      assistantBubble.textContent = assistantText || "(stopped)";
    } else {
      assistantBubble.classList.add("error");
      assistantBubble.textContent = assistantText
        ? `${assistantText}\n\n[error: ${err.message}]`
        : `Error: ${err.message}`;
    }
    // Roll back the unanswered user turn so a retry doesn't duplicate it
    // oddly — the failed exchange is still visible in the transcript above.
    if (!assistantText) conversation.pop();
  } finally {
    assistantBubble.classList.remove("streaming");
    chatSend.disabled = false;
    chatStop.classList.add("hidden");
    activeAbort = null;
    refreshInteractions();
  }
});

chatStop.addEventListener("click", () => {
  activeAbort?.abort();
});

// ---------------------------------------------------------------------
// Recent interactions
// ---------------------------------------------------------------------

const interactionsList = document.getElementById("interactions-list");

function formatRelativeTime(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.round(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleString();
}

async function refreshInteractions() {
  try {
    const res = await fetch(`${BASE}/api/interactions`);
    if (!res.ok) return;
    const { interactions } = await res.json();
    renderInteractions(interactions || []);
  } catch {
    // best-effort — the panel just keeps showing the last known list
  }
}

function renderInteractions(interactions) {
  interactionsList.innerHTML = "";
  if (interactions.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No interactions yet.";
    interactionsList.appendChild(li);
    return;
  }
  for (const item of interactions) {
    const li = document.createElement("li");
    const details = document.createElement("details");
    details.className = "interaction" + (item.error ? " error" : "");
    const summary = document.createElement("summary");
    summary.innerHTML = `
      <span>${escapeHtml(item.model)}</span>
      <span class="meta">${formatRelativeTime(item.startedAt)} · ${Math.round(item.durationMs / 1000)}s${item.error ? " · failed" : ""}</span>
    `;
    const body = document.createElement("div");
    body.className = "body";
    body.innerHTML = `
      <div>
        <div class="label">Prompt</div>
        <div class="text">${escapeHtml(item.prompt || "(empty)")}</div>
      </div>
      <div>
        <div class="label">${item.error ? "Error" : "Response"}</div>
        <div class="text">${escapeHtml(item.error || item.response || "(empty)")}</div>
      </div>
    `;
    details.appendChild(summary);
    details.appendChild(body);
    li.appendChild(details);
    interactionsList.appendChild(li);
  }
}

refreshInteractions();
