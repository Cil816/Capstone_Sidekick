const OPENAI_MODEL = "gpt-4o-mini";
const OPENAI_KEY_STORAGE_KEY = "sidekick.openai.key.v1";
const COMPANION_MEMORY_KEY = "sidekick.aiCompanionByEmail.v2";

const TRAINING_CONTEXT = [
  "You are Sidekick Companion, trained to help users plan Philippines travel inside the Sidekick app.",
  "App modules: dashboard (discover), itinerary (view/edit generated plan), alerts (reminders), settings (cleanup and preferences).",
  "When user asks to generate itinerary, produce practical plan and trigger in-app itinerary generation flow.",
  "Keep tone friendly, practical, and concise.",
  "Ask missing essentials only: destination and number of days.",
  "Optional details to improve output: budget, start date, must-see places, avoid list, pace.",
  "Never claim to perform external bookings or payments.",
].join(" ");

function getOpenAIApiKey() {
  const fromWindow = String(window.SIDEKICK_OPENAI_KEY || "").trim();
  if (fromWindow) return fromWindow;
  return String(localStorage.getItem(OPENAI_KEY_STORAGE_KEY) || "").trim();
}

function getChatForEmail(email) {
  const map = window.SidekickCore.getChatByEmail();
  return map[email] ?? [];
}

function setChatForEmail(email, messages) {
  const map = window.SidekickCore.getChatByEmail();
  map[email] = messages;
  window.SidekickCore.setChatByEmail(map);
}

function getCompanionMap() {
  try {
    return JSON.parse(localStorage.getItem(COMPANION_MEMORY_KEY) || "{}") || {};
  } catch (e) {
    return {};
  }
}

function getCompanionState(email) {
  const map = getCompanionMap();
  const raw = map[email] || {};
  return {
    destination: raw.destination || "",
    dayCount: Number(raw.dayCount || 0) || null,
    budget: raw.budget || "",
    startDate: raw.startDate || "",
    pace: raw.pace || "",
    mustSee: Array.isArray(raw.mustSee) ? raw.mustSee.slice(0, 8) : [],
    avoid: Array.isArray(raw.avoid) ? raw.avoid.slice(0, 8) : [],
    notes: Array.isArray(raw.notes) ? raw.notes.slice(0, 12) : [],
    updatedAt: raw.updatedAt || Date.now(),
  };
}

function setCompanionState(email, state) {
  const map = getCompanionMap();
  map[email] = {
    destination: state.destination || "",
    dayCount: Number(state.dayCount || 0) || null,
    budget: state.budget || "",
    startDate: state.startDate || "",
    pace: state.pace || "",
    mustSee: Array.isArray(state.mustSee) ? state.mustSee.slice(0, 8) : [],
    avoid: Array.isArray(state.avoid) ? state.avoid.slice(0, 8) : [],
    notes: Array.isArray(state.notes) ? state.notes.slice(0, 12) : [],
    updatedAt: Date.now(),
  };
  localStorage.setItem(COMPANION_MEMORY_KEY, JSON.stringify(map));
}

function normalizeBudget(value) {
  const t = String(value || "").toLowerCase();
  if (!t) return "";
  if (/(budget|cheap|tipid|affordable|low)/.test(t)) return "Budget-Friendly";
  if (/(ultra\s*luxury|very\s*luxury|premium\s*luxury)/.test(t)) return "Ultra Luxury";
  if (/(luxury|premium|high)/.test(t)) return "Luxury";
  if (/(mid|balanced|standard)/.test(t)) return "Mid-Range";
  return "";
}

function uniqueList(list, limit = 8) {
  return Array.from(new Set((list || []).map((x) => String(x || "").trim()).filter(Boolean))).slice(0, limit);
}

function parseSignals(text) {
  const raw = String(text || "").trim();
  const lower = raw.toLowerCase();

  const dayCountMatch = lower.match(/\b(\d{1,2})\s*(day|days)\b/);
  const dayCount = dayCountMatch ? Math.max(1, Math.min(14, Number(dayCountMatch[1]))) : null;

  const dateMatch = raw.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  const startDate = dateMatch ? dateMatch[1] : "";

  const destinationMatch = raw.match(/\b(?:to|in|visit|for|destination)\s+([A-Za-z][A-Za-z\s.-]{2,40})/i);
  const destination = destinationMatch ? String(destinationMatch[1]).trim() : "";

  const budget = normalizeBudget(raw);
  const wantsGenerate = /(generate|create|build|make)\s+(an?\s+)?(itinerary|plan)|\bplan\s+my\s+trip\b|\bgenerate\s+itinerary\b/.test(lower);
  const wantsReset = /\b(reset|clear)\s+(ai\s+)?(memory|planner|plan)\b/.test(lower);

  const rememberMatch = raw.match(/^(?:remember|note)\s+(?:that\s+)?(.+)/i);
  const mustSeeMatch = raw.match(/(?:must\s*see|include)\s*:\s*(.+)$/i);
  const avoidMatch = raw.match(/(?:avoid|skip|exclude)\s*:\s*(.+)$/i);

  const pace = /slow\s*pace|relaxed/.test(lower)
    ? "relaxed"
    : /fast\s*pace|packed|maximize/.test(lower)
      ? "packed"
      : "";

  return {
    dayCount,
    startDate,
    destination,
    budget,
    wantsGenerate,
    wantsReset,
    rememberNote: rememberMatch ? String(rememberMatch[1]).trim() : "",
    mustSee: mustSeeMatch ? mustSeeMatch[1].split(",").map((x) => x.trim()) : [],
    avoid: avoidMatch ? avoidMatch[1].split(",").map((x) => x.trim()) : [],
    pace,
  };
}

function applySignals(email, text) {
  const prev = getCompanionState(email);
  const s = parseSignals(text);

  if (s.wantsReset) {
    const cleared = {
      destination: "",
      dayCount: null,
      budget: "",
      startDate: "",
      pace: "",
      mustSee: [],
      avoid: [],
      notes: [],
    };
    setCompanionState(email, cleared);
    return { state: getCompanionState(email), signals: s, reset: true };
  }

  const next = {
    destination: s.destination || prev.destination,
    dayCount: s.dayCount || prev.dayCount,
    budget: s.budget || prev.budget,
    startDate: s.startDate || prev.startDate,
    pace: s.pace || prev.pace,
    mustSee: uniqueList([...(prev.mustSee || []), ...(s.mustSee || [])]),
    avoid: uniqueList([...(prev.avoid || []), ...(s.avoid || [])]),
    notes: prev.notes || [],
  };

  if (s.rememberNote) {
    next.notes = uniqueList([s.rememberNote, ...(prev.notes || [])], 12);
  }

  setCompanionState(email, next);
  return { state: getCompanionState(email), signals: s, reset: false };
}

function companionNeedsEssentials(state) {
  return !state.destination || !state.dayCount;
}

function buildSystemPrompt(prefs, state) {
  const profileInterests = (prefs?.interests || []).join(", ") || "not set";
  const profileTravelStyle = (prefs?.travelTypes || []).join(", ") || "not set";
  const profilePreferredPlaces = (prefs?.preferredPlaces || []).join(", ") || "none";

  return `${TRAINING_CONTEXT}

User profile:
- interests: ${profileInterests}
- travel style: ${profileTravelStyle}
- preferred places: ${profilePreferredPlaces}

Companion memory:
- destination: ${state.destination || "not set"}
- days: ${state.dayCount || "not set"}
- budget: ${state.budget || "not set"}
- start date: ${state.startDate || "not set"}
- pace: ${state.pace || "not set"}
- must-see: ${(state.mustSee || []).join(", ") || "none"}
- avoid: ${(state.avoid || []).join(", ") || "none"}
- notes: ${(state.notes || []).join(" | ") || "none"}

Output rules:
- Keep answer concise and actionable.
- If essentials are missing, ask for only missing fields.
- If user asks for itinerary generation and essentials are ready, confirm and summarize plan.
- If user gives preference updates, acknowledge and continue planning.
- Mention app actions naturally (Itinerary tab, Alerts tab) when useful.`;
}

async function askOpenAI(history, prefs, state) {
  const key = getOpenAIApiKey();
  if (!key) throw new Error("NO_KEY");

  const system = buildSystemPrompt(prefs, state);
  const messages = [
    { role: "system", content: system },
    ...history.slice(-12).map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    })),
  ];

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages,
      temperature: 0.6,
      max_tokens: 500,
    }),
  });

  if (res.status === 401) throw new Error("API_401");
  if (res.status === 429) throw new Error("API_429");
  if (!res.ok) throw new Error(`API_${res.status}`);

  const data = await res.json();
  return String(data?.choices?.[0]?.message?.content || "").trim();
}

function fallbackReply(userText, state, prefs) {
  const base = window.SidekickCore.buildAssistantReply(userText, {
    interests: prefs?.interests || [],
    travelTypes: prefs?.travelTypes || [],
    budget: state.budget || "Mid-Range",
  });

  if (companionNeedsEssentials(state)) {
    return `${base}\n\nTo generate your itinerary, tell me destination and number of days. Example: \"Bohol for 3 days\".`;
  }

  return `${base}\n\nI already captured your trip basics. Say \"generate itinerary now\" to create and save your plan.`;
}

function buildPrefsForGenerator(prefs, state) {
  const mergedPreferred = uniqueList([
    ...(Array.isArray(prefs?.preferredPlaces) ? prefs.preferredPlaces : []),
    ...(state.destination ? [state.destination] : []),
    ...(state.mustSee || []),
  ], 12);

  return {
    ...prefs,
    budget: state.budget || prefs?.budget || "Mid-Range",
    preferredPlaces: mergedPreferred,
  };
}

function saveGeneratedItinerary(email, generated) {
  const byEmail = window.SidekickCore.getItineraryByEmail();
  byEmail[email] = {
    itinerary: generated.itinerary,
    meta: {
      ...generated.meta,
      source: "sidekick-companion",
      startDate: new Date().toISOString(),
    },
  };
  window.SidekickCore.setItineraryByEmail(byEmail);

  try {
    if (window.SidekickCore.syncRemindersFromItinerary) window.SidekickCore.syncRemindersFromItinerary(email);
    if (window.SidekickCore.scheduleAllFor) window.SidekickCore.scheduleAllFor(email);
  } catch (e) {}
}

function generateItineraryFromCompanion(email, prefs, state) {
  const generatorPrefs = buildPrefsForGenerator(prefs, state);
  const generated = window.SidekickCore.generateItinerary(generatorPrefs, {
    startDate: state.startDate ? new Date(state.startDate) : new Date(),
  });

  if (state.dayCount && Array.isArray(generated?.itinerary)) {
    generated.itinerary = generated.itinerary.slice(0, state.dayCount);
  }

  saveGeneratedItinerary(email, generated);

  return `Itinerary ready. I generated a ${state.dayCount || generated.itinerary.length}-day plan for ${state.destination}. Open the Itinerary tab to view and edit it.\n\nIf you want changes, tell me: \"make day 2 more relaxed\" or \"adjust budget to luxury\".`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function getMessagesEl() {
  return document.getElementById("chat-messages");
}

function getInputEl() {
  return document.getElementById("chat-input");
}

function getSendBtn() {
  return document.querySelector(".send-btn");
}

function scrollToBottom() {
  const el = getMessagesEl();
  if (el) el.scrollTop = el.scrollHeight;
}

function appendMessageToDom(role, content, ts, persist = true) {
  const el = getMessagesEl();
  if (!el) return;

  const wrapper = document.createElement("div");
  wrapper.className = `message ${role === "user" ? "user-message" : "ai-message"}`;
  const safe = window.SidekickCore.escapeHtml(content).replaceAll("\n", "<br/>");

  wrapper.innerHTML = `
    <div class="message-bubble">
      <p>${safe}</p>
      <span class="message-time">${formatTime(ts || Date.now())}</span>
    </div>
  `;

  wrapper.style.animation = "messageIn 280ms ease both";
  el.appendChild(wrapper);

  if (persist) {
    const session = window.SidekickCore.getAuthSession();
    if (session?.email) {
      const next = getChatForEmail(session.email).concat([{ role, content, ts: ts || Date.now() }]);
      setChatForEmail(session.email, next);
    }
  }
}

function renderMessages(messages) {
  const el = getMessagesEl();
  if (!el) return;
  el.innerHTML = "";
  messages.forEach((m) => appendMessageToDom(m.role, m.content, m.ts, false));
  scrollToBottom();
}

function showTypingIndicator() {
  const el = getMessagesEl();
  if (!el || document.getElementById("typing-indicator")) return;
  const wrapper = document.createElement("div");
  wrapper.id = "typing-indicator";
  wrapper.className = "message ai-message";
  wrapper.innerHTML = `<div class="message-bubble typing-bubble"><span></span><span></span><span></span></div>`;
  el.appendChild(wrapper);
  scrollToBottom();
}

function removeTypingIndicator() {
  const ind = document.getElementById("typing-indicator");
  if (ind) ind.remove();
}

function getPreferencesOrRedirect() {
  const prefs = window.SidekickCore.getPreferences();
  if (!prefs) {
    window.location.href = "onboarding.html";
    return null;
  }
  return prefs;
}

function handleKeyPress(event) {
  if (event.key === "Enter") sendMessage();
}

function clearChat() {
  if (!confirm("Clear chat history?")) return;
  const session = window.SidekickCore.getAuthSession();
  if (!session?.email) return;

  setChatForEmail(session.email, []);
  const prefs = window.SidekickCore.getPreferences() || {};
  const opening = `${window.SidekickCore.getInitialAssistantMessage(prefs)}\n\nI am trained as your Sidekick planning companion. Tell me your destination and trip length to start.`;
  setChatForEmail(session.email, [{ role: "ai", content: opening, ts: Date.now() }]);
  renderMessages(getChatForEmail(session.email));
}

let isSending = false;

async function sendMessage() {
  if (isSending) return;

  const session = window.SidekickCore.getAuthSession();
  if (!session?.email) {
    window.location.href = "login.html";
    return;
  }

  const prefs = getPreferencesOrRedirect();
  if (!prefs) return;

  const input = getInputEl();
  const userText = String(input?.value || "").trim();
  if (!userText) return;

  isSending = true;
  const sendBtn = getSendBtn();
  if (sendBtn) sendBtn.disabled = true;

  appendMessageToDom("user", userText, Date.now(), true);
  input.value = "";
  showTypingIndicator();

  try {
    const history = getChatForEmail(session.email);
    const merged = applySignals(session.email, userText);
    const companionState = merged.state;

    let reply = "";

    if (merged.reset) {
      reply = "Companion memory reset. Tell me destination and number of days, then I can build your travel plan again.";
    } else if (merged.signals.wantsGenerate) {
      if (companionNeedsEssentials(companionState)) {
        reply = "I can generate your itinerary, but I still need destination and day count. Example: Cebu for 4 days.";
      } else {
        reply = generateItineraryFromCompanion(session.email, prefs, companionState);
      }
    } else if (merged.signals.rememberNote || merged.signals.mustSee.length || merged.signals.avoid.length || merged.signals.budget || merged.signals.pace) {
      reply = "Saved. I updated your planning preferences. Say \"generate itinerary now\" anytime when you are ready.";
    } else {
      try {
        reply = await askOpenAI(history, prefs, companionState);
      } catch (e) {
        reply = fallbackReply(userText, companionState, prefs);
      }
    }

    removeTypingIndicator();
    appendMessageToDom("ai", reply, Date.now(), true);
    scrollToBottom();
  } catch (e) {
    removeTypingIndicator();
    appendMessageToDom("ai", "I hit an issue while planning. Please try again.", Date.now(), false);
  } finally {
    isSending = false;
    if (sendBtn) sendBtn.disabled = false;
    input?.focus?.();
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const session = window.SidekickCore.requireAuth();
  if (!session) return;

  const prefs = getPreferencesOrRedirect();
  if (!prefs) return;

  const existing = getChatForEmail(session.email);
  if (!existing.length) {
    const opening = `${window.SidekickCore.getInitialAssistantMessage(prefs)}\n\nI am trained to be your Sidekick travel companion. Start with: \"Plan a 3-day trip to Palawan\".`;
    setChatForEmail(session.email, [{ role: "ai", content: opening, ts: Date.now() }]);
  }

  renderMessages(getChatForEmail(session.email));
});

window.sendMessage = sendMessage;
window.handleKeyPress = handleKeyPress;
window.clearChat = clearChat;
