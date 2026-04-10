(() => {
  const $ = (id) => document.getElementById(id);

  const messagesEl = $("messages");
  const promptInput = $("promptInput");
  const chatForm = $("chatForm");
  const sendBtn = $("sendBtn");
  const statusEl = $("status");
  const clearBtn = $("clearBtn");

  const STORAGE_KEY = "sidekick.messages.v1";

  /**
   * @typedef {{ role: "user" | "bot", content: string, ts: number }} Message
   */

  /** @type {Message[]} */
  let messages = [];

  function now() {
    return Date.now();
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function setStatus(text) {
    statusEl.textContent = text || "";
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function escapeHtml(str) {
    return str
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function render() {
    messagesEl.innerHTML = messages
      .map((m) => {
        const role = m.role === "user" ? "You" : "Sidekick";
        const bubbleClass = m.role === "user" ? "bubble user" : "bubble bot";
        return `
          <div class="${bubbleClass}">
            <div class="bubble-meta">${role} · ${formatTime(m.ts)}</div>
            <div class="bubble-content">${escapeHtml(m.content)}</div>
          </div>
        `;
      })
      .join("");

    scrollToBottom();
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
    } catch {
      // Ignore storage errors (private mode, quota, etc).
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      messages = parsed
        .filter((x) => x && (x.role === "user" || x.role === "bot") && typeof x.content === "string")
        .map((x) => ({ role: x.role, content: x.content, ts: typeof x.ts === "number" ? x.ts : now() }));
    } catch {
      // Ignore JSON/storage errors.
    }
  }

  function addMessage(role, content) {
    messages.push({ role, content, ts: now() });
    render();
    persist();
  }

  function setBusy(isBusy) {
    sendBtn.disabled = isBusy;
    promptInput.disabled = isBusy;
    clearBtn.disabled = isBusy;
  }

  async function simulateReply(userText) {
    // Replace this function with your real API call.
    await new Promise((r) => setTimeout(r, 700));

    const hint =
      "This is a frontend starter. Wire up your backend in `script.js` where the simulated reply is.";
    return `${hint}\n\nYou said:\n${userText}`;
  }

  async function handleSend() {
    const text = (promptInput.value || "").trim();
    if (!text) return;

    promptInput.value = "";
    setStatus("");

    setBusy(true);
    addMessage("user", text);

    setStatus("Sidekick is thinking...");
    try {
      const reply = await simulateReply(text);
      setStatus("");
      addMessage("bot", reply);
    } catch (err) {
      console.error(err);
      setStatus("Failed to generate a reply. (See console.)");
      addMessage("bot", "Sorry, something went wrong while generating a reply.");
    } finally {
      setBusy(false);
      promptInput.focus();
    }
  }

  function clearConversation() {
    messages = [];
    persist();
    setStatus("Cleared local conversation.");
    render();
    setTimeout(() => setStatus(""), 900);
    promptInput.focus();
  }

  // Events
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    void handleSend();
  });

  clearBtn.addEventListener("click", () => clearConversation());

  // Init
  load();
  if (messages.length === 0) {
    messages = [
      {
        role: "bot",
        content:
          "Hi! I'm your Sidekick UI starter.\n\nType a message and press `Send`.\n\nWhen you're ready, connect an API in `script.js` to get real responses.",
        ts: now(),
      },
    ];
    persist();
  }
  render();
  setStatus("Ready.");
  promptInput.focus();
})();