const COMPANION_MEMORY_KEY = "sidekick.aiCompanionByEmail.v2";
const SELECTED_DESTINATION_KEY = "sidekick.selectedDestination.v1";
const PENDING_ITINERARY_KEY = "sidekick.pendingItineraryByEmail.v1";
const PENDING_CHAT_MESSAGE_KEY = "sidekick.pendingChatMessage.v1";
const CHAT_SCROLL_POSITION_KEY = "sidekick.chatScrollPosition.v1";

const TRAINING_CONTEXT = [
  "You are Sidekick Companion, trained to help users plan trips in the province of Batangas, Philippines inside the Sidekick app. Sidekick covers Batangas only.",
  "App modules: dashboard (discover), itinerary (view/edit generated plan), alerts (reminders), settings (cleanup and preferences).",
  "When user asks to generate itinerary, produce practical plan and trigger in-app itinerary generation flow.",
  "Sound like a helpful local travel companion: warm, direct, and natural. Avoid canned greetings, repeated 'How can I help?' questions, stiff phrases, and unnecessary summaries. If a destination is already known, respond to it with a useful next step instead of asking what the user wants to do.",
  "Use readable formatting: separate ideas with blank lines, keep paragraphs short, and use **bold** sparingly for key places, times, or decisions. Use simple bullet lists when listing options or steps. Avoid headings for short replies and never use decorative symbols.",
  "Ask missing essentials only: destination and number of days.",
  "Optional details to improve output: budget, start date, must-see places, avoid list, pace.",
  "Never claim to perform external bookings or payments.",
].join(" ");

// The place the traveler just opened (Home or Hotels & restaurants, then "Ask AI").
// Only a place opened in the last 30 minutes is given to the AI, so an old one isn't
// brought up when the traveler starts a new conversation (for example, just "hey").
const SELECTED_DESTINATION_MAX_AGE_MS = 30 * 60 * 1000;
function getSelectedDestination() {
  try {
    const raw = localStorage.getItem(SELECTED_DESTINATION_KEY);
    const place = raw ? JSON.parse(raw) : null;
    const age = Date.now() - Number(place?.selectedAt || 0);
    return place && age >= 0 && age < SELECTED_DESTINATION_MAX_AGE_MS ? place : null;
  } catch (error) {
    return null;
  }
}

function setSelectedDestination(destination) {
  if (!destination) return;
  localStorage.setItem(SELECTED_DESTINATION_KEY, JSON.stringify(destination));
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
    budgetAmountPhp: Number(raw.budgetAmountPhp || 0) || null,
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
    budgetAmountPhp: Number(state.budgetAmountPhp || 0) || null,
    startDate: state.startDate || "",
    pace: state.pace || "",
    mustSee: Array.isArray(state.mustSee) ? state.mustSee.slice(0, 8) : [],
    avoid: Array.isArray(state.avoid) ? state.avoid.slice(0, 8) : [],
    notes: Array.isArray(state.notes) ? state.notes.slice(0, 12) : [],
    updatedAt: Date.now(),
  };
  localStorage.setItem(COMPANION_MEMORY_KEY, JSON.stringify(map));
}

function getPendingItinerary(email) {
  try {
    const pendingByEmail = JSON.parse(localStorage.getItem(PENDING_ITINERARY_KEY) || "{}");
    return pendingByEmail[email] || null;
  } catch (error) {
    return null;
  }
}

function setPendingItinerary(email, draft) {
  let pendingByEmail = {};
  try {
    pendingByEmail = JSON.parse(localStorage.getItem(PENDING_ITINERARY_KEY) || "{}");
  } catch (error) {}
  if (draft) pendingByEmail[email] = draft;
  else delete pendingByEmail[email];
  localStorage.setItem(PENDING_ITINERARY_KEY, JSON.stringify(pendingByEmail));
}

function isSaveConfirmation(text) {
  const value = String(text || "").trim().toLowerCase();
  if (/\b(?:don't|do not|not|never)\s+(?:save|keep|confirm)\b/.test(value)) return false;
  return /^(?:yes|yeah|yep|sure|okay|ok|confirm|go ahead|do it|save it|save this|looks good|keep it)(?:[.! ,]|$)/.test(value)
    || /\b(?:save|keep|confirm)\b.*\b(?:itinerary|plan|draft|it)\b/.test(value);
}

function isDraftRejection(text) {
  const value = String(text || "").trim();
  return /^(?:no|nope|cancel|discard|delete|not now|never mind|nevermind)(?:[.! ,]|$)/i.test(value)
    || /\b(?:don't|do not|never)\s+(?:save|keep)\b/i.test(value);
}

function hasPriceBand(band) {
  return band && band.lowPhp !== null && band.lowPhp !== undefined
    && band.highPhp !== null && band.highPhp !== undefined
    && Number.isFinite(Number(band.lowPhp)) && Number.isFinite(Number(band.highPhp));
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

  const destinationMatch = raw.match(/\b(?:to|in|visit|destination)\s+([A-Za-z][A-Za-z\s.-]{2,40}?)(?=\s+(?:for|with|wiht|and|my|i|on|budget)\b|\s+\d|[,.!?]|$)/i);
  const destination = destinationMatch ? String(destinationMatch[1]).trim() : "";

  const budget = normalizeBudget(raw);
  const budgetAmountMatch = raw.match(/(?:₱|php\s*)\s*([\d,]+(?:\.\d+)?)\s*(k|thousand)?|\b([\d,]+(?:\.\d+)?)\s*(k|thousand)\s*(?:php|pesos?)?|\b([\d,]+(?:\.\d+)?)\s*(?:php|pesos?)\b/i);
  const budgetAmountValue = budgetAmountMatch
    ? Number(String(budgetAmountMatch[1] || budgetAmountMatch[3] || budgetAmountMatch[5] || "").replaceAll(",", ""))
      * (/^(?:k|thousand)$/i.test(budgetAmountMatch[2] || budgetAmountMatch[4] || "") ? 1000 : 1)
    : null;
  const budgetAmountPhp = Number.isFinite(budgetAmountValue) && budgetAmountValue > 0 && budgetAmountValue <= 100000000 ? budgetAmountValue : null;
  const wantsGenerate = /(generate|create|build|make)\s+(an?\s+)?(itinerary|plan)|\bplan\s+my\s+trip\b|\bgenerate\s+itinerary\b/.test(lower)
    || (Boolean(dayCount && destination) && /\b(?:visit|travel|trip|go|spend|stay|plan|explore|want|wanna)\b|\biwanna\b/.test(lower));
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
    budgetAmountPhp,
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
      budgetAmountPhp: null,
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
    budgetAmountPhp: s.budgetAmountPhp || prev.budgetAmountPhp,
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
- Match answer detail to the user's request: brief for simple questions, detailed when they need planning, costs, comparisons, or explanations.
- If essentials are missing, ask for only missing fields.
- Prepare itinerary requests as drafts and ask before saving them.
- If user gives preference updates, acknowledge and continue planning.
- Mention app actions naturally (Itinerary tab, Alerts tab) when useful.`;
}

// kind "continuation" marks the app's automatic follow-up request, so the
// server doesn't count it as a message the user sent.
async function askSidekickBackend(history, prefs, state, userText, kind = "message") {
  const selectedDestination = getSelectedDestination();
  const payload = {
    email: window.SidekickCore.getAuthSession()?.email || "",
    message: userText,
    kind,
    selectedDestination,
    history: (history || []).slice(-12).map((item) => ({ role: item.role, content: item.content, ts: item.ts })),
    profile: {
      interests: prefs?.interests || [],
      travelTypes: prefs?.travelTypes || [],
      preferredPlaces: prefs?.preferredPlaces || [],
      budget: state?.budget || prefs?.budget || "Mid-Range",
      budgetAmountPhp: state?.budgetAmountPhp || prefs?.budgetAmountPhp || null,
    },
  };

  // The main reply can finish in the background if the traveler leaves this tab.
  if (kind === "message" && currentRequestId) {
    payload.requestId = currentRequestId;
    window.SidekickCore.chatPending?.set({ email: payload.email, requestId: currentRequestId, at: Date.now() });
  }
  const data = await window.SidekickCore.apiRequest("/api/chat", {
    method: "POST",
    body: JSON.stringify(payload),
    signal: activeReply?.signal,
  });
  if (data?.misuseWarning) showMisuseWarning(payload.email);

  return data;
}

// The message was flagged as abusive (insults, threats, profanity). The first time is a
// warning; after that the popup says the account can be suspended.
function showMisuseWarning(email) {
  const key = `sidekick.misuseWarnings.${String(email || "").toLowerCase()}`;
  let count = 0;
  try { count = Number(localStorage.getItem(key)) || 0; localStorage.setItem(key, String(count + 1)); } catch (error) { /* still warn */ }
  const first = count === 0;
  void window.SidekickUI?.alert(
    first
      ? "Abusive language, insults and threats aren't tolerated on Sidekick. This message was flagged and our team can review it. Please keep the chat respectful."
      : "This is another flagged message. Repeated abuse can get your account suspended. Please keep the chat respectful.",
    { title: first ? "Please keep it respectful" : "Final warning", tone: "danger", icon: "info", confirmText: "I understand" },
  );
}

async function continueIncompleteReply(reply, prefs, state, email) {
  const initial = String(reply || "").trim();
  const comparable = initial.replace(/[*_`]+$/g, "").trim();
  const appearsIncomplete = /\bI was interrupted before I could finish\b/i.test(initial)
    || (comparable.length >= 100 && /[\p{L}\p{N}]$/u.test(comparable) && !/[.!?…][\]})"'’”]*$/u.test(comparable));
  if (!appearsIncomplete) return initial;

  try {
    const history = getChatForEmail(email).concat([{ role: "ai", content: initial, ts: Date.now() }]);
    const continuation = await askSidekickBackend(
      history,
      prefs,
      state,
      "Continue your immediately previous answer from its last words. Do not repeat anything already written; finish the incomplete thought and any remaining points.",
      "continuation"
    );
    const continuationText = String(continuation?.reply || "").trim();
    if (continuationText) return `${initial} ${continuationText}`;
  } catch (error) {}

  return `${initial}\n\nIt looks like my answer was cut off. Reply “continue” and I’ll finish it.`;
}

// Shown when the AI can't answer. An honest "try again" beats a canned reply
// that ignores what the user actually asked.
// When the AI can't answer: it has run out (turned off, paused by the budget, its quota
// used up, or too many messages) and "needs to sleep", or something else went wrong.
const CHAT_AI_RESTING_REPLY = "Sorry but i need to sleep, please lets do this again after rest.";
const CHAT_ERROR_REPLY = "Sorry for the inconvenience, please check again later.";
function fallbackReply(userText, state, prefs, error) {
  const status = Number(error?.statusCode);
  if (status === 503 || status === 429 || /too many|rate limit|need to sleep/i.test(String(error?.message || ""))) return CHAT_AI_RESTING_REPLY;
  return CHAT_ERROR_REPLY;
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

// Saves a chat itinerary as a planned trip (its dates must not overlap another planned
// trip). Only now is it recorded on the server, with reminders for its activities.
async function saveGeneratedItinerary(email, generated) {
  const meta = {
    ...(generated.meta || {}),
    source: "sidekick-companion",
    startDate: generated.meta?.startDate || window.SidekickCore.localDateValue?.() || new Date().toISOString().slice(0, 10),
  };
  delete meta.serverTripId;
  delete meta.isDraft;
  delete meta.planId;
  await window.SidekickCore.savePlannedTrip(email, { itinerary: generated.itinerary, meta });

  try {
    if (window.SidekickCore.syncRemindersFromItinerary) window.SidekickCore.syncRemindersFromItinerary(email);
    if (window.SidekickCore.scheduleAllFor) window.SidekickCore.scheduleAllFor(email);
  } catch (e) {}
}

function applyAgentActions(email, actions) {
  const summaries = [];
  const map = window.SidekickCore.getItineraryByEmail();
  const itineraryData = map[email];
  for (const action of Array.isArray(actions) ? actions : []) {
    if (action?.type === "SHOW_PLACES" && Array.isArray(action.places)) {
      localStorage.setItem("sidekick.aiPlaces.v1", JSON.stringify(action.places.slice(0, 8)));
      // Places are shown as photo cards under the reply.
      continue;
    }

    if (action?.type === "SHOW_ROUTE") {
      localStorage.setItem("sidekick.aiRoute.v1", JSON.stringify({ origin: action.origin, destination: action.destination }));
      summaries.push(`Route ready from ${action.origin} to ${action.destination}.`);
      continue;
    }

    if (action?.type === "ADD_ITINERARY_ACTIVITY" && action.activity) {
      const dayNumber = Math.max(1, Number(action.activity.dayNumber) || 1);
      const day = itineraryData?.itinerary?.find((entry) => Number(entry.dayNumber) === dayNumber);
      if (!day) {
        summaries.push(`I could not find Day ${dayNumber} in your current itinerary.`);
        continue;
      }
      day.activities = Array.isArray(day.activities) ? day.activities : [];
      day.activities.push({
        id: `agent-${Date.now()}-${day.activities.length + 1}`,
        timeLabel: "Flexible",
        title: String(action.activity.title || "New activity"),
        location: String(action.activity.location || ""),
        note: String(action.activity.note || "Added by Sidekick AI."),
        transportMode: "To be planned",
        travelMinutes: 0,
        travelDistanceKm: 0,
        estimatedActivityCostPhp: 0,
        estimatedTransportCostPhp: 0,
        estimatedTotalCostPhp: 0,
        placeId: String(action.activity.placeId || ""),
        photoResource: String(action.activity.photoResource || ""),
        dueAt: Date.now(),
        iso: new Date().toISOString(),
      });
      window.SidekickCore.setItineraryByEmail(map);
      if (window.SidekickCore.syncRemindersFromItinerary) window.SidekickCore.syncRemindersFromItinerary(email);
      summaries.push(`Added ${action.activity.title} to Day ${dayNumber}.`);
      continue;
    }

    if (action?.type === "REMOVE_ITINERARY_ACTIVITY" && itineraryData?.itinerary) {
      const pattern = new RegExp(String(action.match || "museum"), "i");
      let removed = false;
      for (const day of itineraryData.itinerary) {
        const index = (day.activities || []).findIndex((activity) => pattern.test(`${activity.title} ${activity.location}`));
        if (index >= 0) {
          day.activities.splice(index, 1);
          removed = true;
          break;
        }
      }
      if (removed) {
        window.SidekickCore.setItineraryByEmail(map);
        summaries.push("Removed the requested activity from your itinerary.");
      }
      continue;
    }

    if (action?.type === "REPLACE_ITINERARY_ACTIVITY" && itineraryData?.itinerary && action.activity) {
      const pattern = new RegExp(String(action.match || "museum"), "i");
      for (const day of itineraryData.itinerary) {
        const index = (day.activities || []).findIndex((activity) => pattern.test(`${activity.title} ${activity.location}`));
        if (index >= 0) {
          day.activities[index] = {
            ...day.activities[index],
            title: String(action.activity.title || "Replacement activity"),
            location: String(action.activity.location || ""),
            locationAddress: String(action.activity.location || ""),
            placeId: String(action.activity.placeId || ""),
            photoResource: String(action.activity.photoResource || ""),
            note: String(action.activity.note || "Replacement activity."),
          };
          window.SidekickCore.setItineraryByEmail(map);
          summaries.push(`Replaced the activity with ${day.activities[index].title}.`);
          break;
        }
      }
      continue;
    }

    if (action?.type === "MOVE_ITINERARY_ACTIVITY" && itineraryData?.itinerary) {
      const pattern = new RegExp(String(action.match || "museum|ramen"), "i");
      let moved = null;
      for (const day of itineraryData.itinerary) {
        const index = (day.activities || []).findIndex((activity) => pattern.test(`${activity.title} ${activity.location}`));
        if (index >= 0) {
          moved = day.activities.splice(index, 1)[0];
          break;
        }
      }
      const target = itineraryData.itinerary.find((day) => Number(day.dayNumber) === Number(action.dayNumber || 3));
      if (moved && target) {
        target.activities = Array.isArray(target.activities) ? target.activities : [];
        target.activities.push(moved);
        window.SidekickCore.setItineraryByEmail(map);
        summaries.push(`Moved ${moved.title} to Day ${target.dayNumber}.`);
      }
      continue;
    }

    if (action?.type === "RELAX_ITINERARY_DAY" && itineraryData?.itinerary) {
      const target = itineraryData.itinerary.find((day) => Number(day.dayNumber) === Number(action.dayNumber || 2));
      if (target && target.activities.length > 1) {
        target.activities = target.activities.filter((_, index) => index % 2 === 0);
        window.SidekickCore.setItineraryByEmail(map);
        summaries.push(`Made Day ${target.dayNumber} less tiring.`);
      }
    }
  }
  if (itineraryData && summaries.length) {
    window.SidekickCore.setItineraryByEmail(map);
    document.dispatchEvent(new CustomEvent("sidekick:itinerary-updated", { detail: { email } }));
  }
  return summaries;
}

async function generateItineraryFromCompanion(email, prefs, state) {
  const generatorPrefs = buildPrefsForGenerator(prefs, state);
  const generated = window.SidekickCore.generateItinerary(generatorPrefs, {
    startDate: state.startDate ? new Date(state.startDate) : new Date(),
  });

  if (state.dayCount && Array.isArray(generated?.itinerary)) {
    generated.itinerary = generated.itinerary.slice(0, state.dayCount);
  }

  await saveGeneratedItinerary(email, generated);

  return `Your ${state.dayCount || generated.itinerary.length}-day plan for ${state.destination} is ready. Open the Itinerary tab to view and edit it.\n\nWant changes? Try \"make day 2 more relaxed\" or \"adjust budget to luxury\".`;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
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

function getChatScrollPositionKey(email) {
  return `${CHAT_SCROLL_POSITION_KEY}:${String(email || "").trim().toLowerCase()}`;
}

function saveChatScrollPosition() {
  const el = getMessagesEl();
  const session = window.SidekickCore.getAuthSession();
  if (!el || !session?.email) return;
  try {
    sessionStorage.setItem(getChatScrollPositionKey(session.email), String(el.scrollTop));
  } catch (error) {}
}

function restoreChatScrollPosition(email) {
  const el = getMessagesEl();
  if (!el || !email) return;
  try {
    const savedPosition = Number(sessionStorage.getItem(getChatScrollPositionKey(email)));
    if (Number.isFinite(savedPosition) && savedPosition >= 0) el.scrollTop = savedPosition;
  } catch (error) {}
}

function scrollToBottom() {
  const el = getMessagesEl();
  if (!el) return;
  // Scroll only when an actual chat message was added.
  el.scrollTop = el.scrollHeight;
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

// A short label for a web address in a reply ("Open in Google Maps" for map links).
function chatLinkLabel(url) {
  const text = String(url || "").replace(/&amp;/g, "&");
  if (/^https:\/\/(?:www\.google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)/i.test(text)) return "Open in Google Maps";
  try { return new URL(text).hostname.replace(/^www\./, ""); } catch (error) { return "Open link"; }
}

function formatAssistantMessage(content) {
  const inlineFormat = (text) => {
    let normalized = String(text);
    if ((normalized.match(/\*\*/g) || []).length % 2) normalized = normalized.replace(/\*\*/g, "");
    if ((normalized.match(/(?<!\*)\*(?!\*)/g) || []).length % 2) normalized = normalized.replace(/(?<!\*)\*(?!\*)/g, "");
    return window.SidekickCore.escapeHtml(normalized)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1<em>$2</em>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      // Links: any https address, as [text](address) or written out, opens in the browser.
      .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https:\/\/[^\s<]+?)(?=[.,!?;:)]*(?:\s|$|<))/g, (match, before, url) => `${before}<a href="${url}" target="_blank" rel="noopener noreferrer">${chatLinkLabel(url)}</a>`);
  };
  const blocks = String(content || "").trim().split(/\n\s*\n/).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split(/\r?\n/);
    const isList = lines.every((line) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(line));
    if (isList) {
      return `<ul>${lines.map((line) => `<li>${inlineFormat(line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""))}</li>`).join("")}</ul>`;
    }
    return `<p>${lines.map(inlineFormat).join("<br>")}</p>`;
  }).join("");
}

// ---- place photo cards ---------------------------------------------------------
function sanitizeChatPlaces(places) {
  return (Array.isArray(places) ? places : [])
    .filter((place) => place && place.name)
    .slice(0, 4)
    .map((place) => ({
      placeId: String(place.placeId || ""),
      name: String(place.name || ""),
      address: String(place.address || ""),
      lat: Number.isFinite(Number(place.lat)) && place.lat !== null ? Number(place.lat) : null,
      lng: Number.isFinite(Number(place.lng)) && place.lng !== null ? Number(place.lng) : null,
      rating: Number.isFinite(Number(place.rating)) ? Number(place.rating) : null,
      ratingCount: Number.isFinite(Number(place.ratingCount)) ? Number(place.ratingCount) : null,
      priceLevel: String(place.priceLevel || ""),
      types: Array.isArray(place.types) ? place.types.map(String).slice(0, 6) : [],
      openingHours: Array.isArray(place.openingHours) ? place.openingHours.map(String).slice(0, 7) : [],
      photoResource: String(place.photoResource || ""),
      photoAttribution: place.photoAttribution && place.photoAttribution.name
        ? { name: String(place.photoAttribution.name), uri: String(place.photoAttribution.uri || "") }
        : null,
    }));
}

function chatPlacePhotoUrl(place) {
  const resource = String(place?.photoResource || "");
  if (!/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(resource)) return "";
  let base = "";
  try { base = window.SidekickCore.getApiBaseUrl() || ""; } catch (error) { return ""; }
  if (!base && !window.location.protocol.startsWith("http")) return "";
  return `${base}/api/maps/photo?name=${encodeURIComponent(resource)}`;
}

function chatPinIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>';
}

function chatRatingText(place) {
  if (!Number.isFinite(place.rating) || place.rating <= 0) return "";
  return `\u2605 ${place.rating.toFixed(1)}${Number.isFinite(place.ratingCount) && place.ratingCount > 0 ? ` (${place.ratingCount.toLocaleString()})` : ""}`;
}

function buildPlaceCards(places) {
  const wrapper = document.createElement("div");
  const row = document.createElement("div");
  row.className = "chat-place-cards";
  const credit = document.createElement("p");
  credit.className = "data-attribution";
  credit.textContent = "Place info and photos from Google Maps.";
  wrapper.append(row, credit);
  places.forEach((place) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "chat-place-card";
    card.setAttribute("aria-label", `See details about ${place.name}`);
    const media = document.createElement("span");
    media.className = "chat-place-media";
    const url = chatPlacePhotoUrl(place);
    if (url) {
      const img = document.createElement("img");
      img.alt = place.name;
      img.loading = "lazy";
      img.addEventListener("error", () => { media.innerHTML = chatPinIcon(); }, { once: true });
      img.src = url;
      media.appendChild(img);
    } else {
      media.innerHTML = chatPinIcon();
    }
    const name = document.createElement("strong");
    name.textContent = place.name;
    const meta = document.createElement("small");
    meta.textContent = chatRatingText(place) || "Tap for details";
    card.append(media, name, meta);
    card.addEventListener("click", () => openChatPlaceDetails(place));
    row.appendChild(card);
  });
  return wrapper;
}

function ensureChatPlaceModal() {
  let modal = document.getElementById("chat-place-modal");
  if (modal) return modal;
  modal = document.createElement("div");
  modal.id = "chat-place-modal";
  modal.className = "chat-place-modal";
  modal.setAttribute("aria-hidden", "true");
  modal.innerHTML = `
    <div class="chat-place-backdrop" data-close="1"></div>
    <div class="chat-place-panel" role="dialog" aria-modal="true" aria-labelledby="chat-place-title">
      <div class="chat-place-head">
        <h3 id="chat-place-title"></h3>
        <button type="button" class="chat-place-x" data-close="1" aria-label="Close">\u00d7</button>
      </div>
      <div id="chat-place-photo" class="chat-place-photo"></div>
      <p id="chat-place-address" class="chat-place-address"></p>
      <div id="chat-place-facts" class="chat-place-facts"></div>
      <div id="chat-place-tags" class="chat-place-tags"></div>
      <details id="chat-place-hours" class="chat-place-hours"><summary>Opening hours</summary><ul id="chat-place-hours-list"></ul></details>
      <div class="chat-place-actions">
        <a id="chat-place-maps" class="btn btn-primary" target="_blank" rel="noopener noreferrer">Open in Google Maps</a>
        <button type="button" id="chat-place-ask" class="btn btn-outline">Ask Sidekick about this place</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener("click", (event) => {
    if (event.target?.dataset?.close === "1") closeChatPlaceDetails();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("open")) closeChatPlaceDetails();
  });
  return modal;
}

function closeChatPlaceDetails() {
  const modal = document.getElementById("chat-place-modal");
  if (!modal) return;
  if (modal.contains(document.activeElement)) document.activeElement.blur();
  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
}

function openChatPlaceDetails(place) {
  const modal = ensureChatPlaceModal();
  document.getElementById("chat-place-title").textContent = place.name;
  document.getElementById("chat-place-address").textContent = place.address || "Address unavailable";

  const photo = document.getElementById("chat-place-photo");
  photo.replaceChildren();
  const url = chatPlacePhotoUrl(place);
  photo.hidden = !url;
  if (url) {
    const img = document.createElement("img");
    img.alt = `Photo of ${place.name}`;
    img.addEventListener("error", () => { photo.hidden = true; }, { once: true });
    img.src = url;
    photo.appendChild(img);
    if (place.photoAttribution?.name) {
      const credit = document.createElement("small");
      credit.className = "chat-place-credit";
      if (/^https:\/\//i.test(place.photoAttribution.uri)) {
        const link = document.createElement("a");
        link.href = place.photoAttribution.uri;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = `Photo: ${place.photoAttribution.name}`;
        credit.appendChild(link);
      } else {
        credit.textContent = `Photo: ${place.photoAttribution.name}`;
      }
      photo.appendChild(credit);
    }
  }

  const priceLabels = {
    PRICE_LEVEL_FREE: "Free",
    PRICE_LEVEL_INEXPENSIVE: "\u20b1",
    PRICE_LEVEL_MODERATE: "\u20b1\u20b1",
    PRICE_LEVEL_EXPENSIVE: "\u20b1\u20b1\u20b1",
    PRICE_LEVEL_VERY_EXPENSIVE: "\u20b1\u20b1\u20b1\u20b1",
  };
  const facts = document.getElementById("chat-place-facts");
  facts.replaceChildren();
  [["Rating", chatRatingText(place)], ["Price", priceLabels[place.priceLevel] || ""]]
    .filter(([, value]) => value)
    .forEach(([label, value]) => {
      const fact = document.createElement("div");
      fact.className = "chat-place-fact";
      const l = document.createElement("span");
      l.textContent = label;
      const v = document.createElement("strong");
      v.textContent = value;
      fact.append(l, v);
      facts.appendChild(fact);
    });

  const tags = document.getElementById("chat-place-tags");
  tags.replaceChildren();
  place.types.filter((type) => !["point_of_interest", "establishment"].includes(type)).slice(0, 4).forEach((type) => {
    const tag = document.createElement("span");
    tag.className = "chat-place-tag";
    tag.textContent = type.replace(/_/g, " ");
    tags.appendChild(tag);
  });

  const hours = document.getElementById("chat-place-hours");
  const hoursList = document.getElementById("chat-place-hours-list");
  hoursList.replaceChildren();
  place.openingHours.forEach((line) => {
    const item = document.createElement("li");
    item.textContent = line;
    hoursList.appendChild(item);
  });
  hours.hidden = !place.openingHours.length;
  hours.open = false;

  const query = place.lat !== null && place.lng !== null ? `${place.lat},${place.lng}` : `${place.name} ${place.address}`.trim();
  document.getElementById("chat-place-maps").href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}${place.placeId ? `&query_place_id=${encodeURIComponent(place.placeId)}` : ""}`;
  document.getElementById("chat-place-ask").onclick = () => {
    closeChatPlaceDetails();
    const input = getInputEl();
    if (input) {
      input.value = `Tell me more about ${place.name}`;
      input.focus();
    }
  };

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  modal.querySelector(".chat-place-panel").scrollTop = 0;
}

function appendMessageToDom(role, content, ts, persist = true, places = []) {
  const el = getMessagesEl();
  if (!el) return;
  const placeCards = role === "user" ? [] : sanitizeChatPlaces(places);

  const wrapper = document.createElement("div");
  wrapper.className = `message ${role === "user" ? "user-message" : "ai-message"}`;
  const safe = role === "user"
    ? `<p>${window.SidekickCore.escapeHtml(content).replaceAll("\n", "<br>")}</p>`
    : formatAssistantMessage(content);

  wrapper.innerHTML = `
    <div class="message-bubble">
      <div class="message-content">${safe}</div>
      <span class="message-time">${formatTime(ts || Date.now())}</span>
    </div>
  `;

  if (placeCards.length) {
    wrapper.querySelector(".message-bubble")?.insertBefore(buildPlaceCards(placeCards), wrapper.querySelector(".message-time"));
  }

  wrapper.style.animation = "messageIn 280ms ease both";
  el.appendChild(wrapper);

  if (persist) {
    const session = window.SidekickCore.getAuthSession();
    if (session?.email) {
      const next = getChatForEmail(session.email).concat([{ role, content, ts: ts || Date.now(), ...(placeCards.length ? { places: placeCards } : {}) }]);
      setChatForEmail(session.email, next);
    }
  }
}

function renderMessages(messages) {
  const el = getMessagesEl();
  if (!el) return;
  el.innerHTML = "";
  messages.forEach((m) => appendMessageToDom(m.role, m.content, m.ts, false, m.places));
}

function showTypingIndicator() {
  const el = getMessagesEl();
  if (!el || document.getElementById("typing-indicator")) return;
  const wrapper = document.createElement("div");
  wrapper.id = "typing-indicator";
  wrapper.className = "message ai-message";
  wrapper.innerHTML = `<div class="message-bubble typing-bubble"><span></span><span></span><span></span></div>`;
  el.appendChild(wrapper);
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

// A fresh conversation: just Sidekick's opening message.
function startFreshChat(email) {
  try { sessionStorage.removeItem(getChatScrollPositionKey(email)); } catch (error) {}
  const prefs = window.SidekickCore.getPreferences() || {};
  const opening = window.SidekickCore.getInitialAssistantMessage(prefs);
  setChatForEmail(email, [{ role: "ai", content: opening, ts: Date.now() }]);
  renderMessages(getChatForEmail(email));
}

// "Delete this chat" (⋯ menu): deletes the current conversation only.
async function clearChat() {
  if (isSending && activeReply) stopReply();
  const ok = await window.SidekickUI.confirm("This conversation with Sidekick will be deleted from this phone. Your archived chats stay.", {
    title: "Delete this chat?", confirmText: "Delete", cancelText: "Keep it", tone: "danger",
  });
  if (!ok) return;
  const session = window.SidekickCore.getAuthSession();
  if (!session?.email) return;
  setCurrentSessionNumber(session.email, null);
  startFreshChat(session.email);
  window.SidekickUI.toast("Chat deleted");
}

// ---- Chat archive (⋯ menu) ------------------------------------------------------
// Earlier conversations kept on this phone (newest first, up to 30). Archiving keeps
// the current conversation and starts a new one; opening an archived chat makes it the
// current one again (the conversation it replaces is archived first, so nothing is lost).
const CHAT_ARCHIVE_KEY = "sidekick.chatArchiveByEmail.v1";
const CHAT_ARCHIVE_LIMIT = 30;

function readChatArchive() {
  try {
    const all = JSON.parse(localStorage.getItem(CHAT_ARCHIVE_KEY) || "{}");
    return all && typeof all === "object" ? all : {};
  } catch (error) {
    return {};
  }
}

function getChatArchive(email) {
  const all = readChatArchive();
  const list = Array.isArray(all[email]) ? all[email].filter((item) => item && Array.isArray(item.messages)) : [];
  // Chats archived before sessions were numbered get numbers, oldest first.
  if (list.some((item) => !(Number(item.session) > 0))) {
    let next = list.reduce((max, item) => Math.max(max, Number(item.session) || 0), 0);
    [...list].reverse().forEach((item) => { if (!(Number(item.session) > 0)) item.session = ++next; });
  }
  return list;
}

function setChatArchive(email, list) {
  const all = readChatArchive();
  if (list.length) all[email] = list.slice(0, CHAT_ARCHIVE_LIMIT);
  else delete all[email];
  localStorage.setItem(CHAT_ARCHIVE_KEY, JSON.stringify(all));
}

const hasConversation = (messages) => (messages || []).some((message) => message.role === "user");

// The number of the session being chatted in, once it has one (a reopened session keeps
// its number; a new conversation gets the next number when it is archived).
const CHAT_CURRENT_SESSION_KEY = "sidekick.chatCurrentSession.v1";

function getCurrentSessionNumber(email) {
  try {
    const all = JSON.parse(localStorage.getItem(CHAT_CURRENT_SESSION_KEY) || "{}") || {};
    const number = Number(all[email]);
    return Number.isInteger(number) && number > 0 ? number : null;
  } catch (error) {
    return null;
  }
}

function setCurrentSessionNumber(email, number) {
  try {
    const all = JSON.parse(localStorage.getItem(CHAT_CURRENT_SESSION_KEY) || "{}") || {};
    if (number) all[email] = number;
    else delete all[email];
    localStorage.setItem(CHAT_CURRENT_SESSION_KEY, JSON.stringify(all));
  } catch (error) {}
}

// The current session's number: its own, or the next free one.
function sessionNumberForCurrent(email) {
  const own = getCurrentSessionNumber(email);
  if (own) return own;
  return getChatArchive(email).reduce((max, item) => Math.max(max, Number(item.session) || 0), 0) + 1;
}

// Keeps the current conversation in the archive (if the traveler said anything).
function archiveCurrentChat(email) {
  const messages = getChatForEmail(email);
  if (!hasConversation(messages)) return false;
  const first = String(messages.find((message) => message.role === "user")?.content || "Chat").trim();
  const entry = {
    id: `chat_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    session: sessionNumberForCurrent(email),
    title: first.length > 60 ? `${first.slice(0, 57)}…` : first,
    archivedAt: Date.now(),
    messages,
  };
  setChatArchive(email, [entry, ...getChatArchive(email)]);
  setCurrentSessionNumber(email, null);
  return true;
}

function archiveDateText(ts) {
  const date = new Date(Number(ts));
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) + " · " + date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : "";
}

function closeChatArchive() {
  const panel = document.getElementById("chat-archive");
  if (!panel) return;
  panel.remove();
  document.documentElement.style.removeProperty("overflow");
  document.getElementById("chat-menu-btn")?.focus({ preventScroll: true });
}

const sessionMessageCount = (messages) => messages.filter((m) => m.role === "user").length;

// The chat archive: a sidebar with the current session and the archived sessions.
function openChatArchive({ animate = true } = {}) {
  const session = window.SidekickCore.getAuthSession();
  if (!session?.email) return;
  closeChatArchive();
  const email = session.email;
  const esc = (value) => window.SidekickCore.escapeHtml(String(value ?? ""));
  const list = getChatArchive(email);
  const current = getChatForEmail(email);
  const canArchive = hasConversation(current);
  const currentTitle = canArchive ? String(current.find((m) => m.role === "user")?.content || "").trim() : "New chat";
  const count = (messages) => `${sessionMessageCount(messages)} message${sessionMessageCount(messages) === 1 ? "" : "s"}`;
  const panel = document.createElement("div");
  panel.id = "chat-archive";
  panel.className = `chat-archive${animate ? " is-opening" : ""}`;
  panel.innerHTML = `
    <div class="chat-archive-backdrop" data-archive-close></div>
    <aside class="chat-archive-panel" role="dialog" aria-modal="true" aria-labelledby="chat-archive-title">
      <div class="chat-archive-head">
        <h2 id="chat-archive-title">Chat archive</h2>
        <button type="button" class="chat-archive-x" data-archive-close aria-label="Close">×</button>
      </div>
      <button type="button" class="btn btn-primary btn-full chat-archive-new" data-archive-new ${canArchive ? "" : "disabled"}>Start a new session</button>
      <p class="chat-archive-section">Current session</p>
      <div class="chat-archive-current">
        <span class="chat-session-chip is-current">Session ${sessionNumberForCurrent(email)}</span>
        <strong>${esc(currentTitle.length > 60 ? `${currentTitle.slice(0, 57)}…` : currentTitle)}</strong>
        <small>${canArchive ? `${count(current)} · open now` : "Send a message to start this session"}</small>
      </div>
      <p class="chat-archive-section">Archived sessions${list.length ? ` (${list.length})` : ""}</p>
      ${list.length ? `<ul class="chat-archive-list">${list.map((item) => `
        <li>
          <button type="button" class="chat-archive-open" data-archive-open="${esc(item.id)}" aria-label="Open session ${esc(item.session)}: ${esc(item.title)}">
            <span class="chat-session-chip">Session ${esc(item.session)}</span>
            <strong>${esc(item.title)}</strong>
            <small>${esc(archiveDateText(item.archivedAt))} · ${count(item.messages)}</small>
          </button>
          <button type="button" class="chat-archive-delete" data-archive-delete="${esc(item.id)}" aria-label="Delete session ${esc(item.session)}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14H6L5 6"></path><path d="M10 11v6M14 11v6"></path><path d="M9 6V4h6v2"></path></svg>
          </button>
        </li>`).join("")}</ul>` : '<p class="chat-archive-empty">No archived sessions yet. Archive a session to keep it here and open it again later.</p>'}
    </aside>`;
  document.body.appendChild(panel);
  document.documentElement.style.overflow = "hidden";
  panel.querySelector(".chat-archive-x")?.focus({ preventScroll: true });

  panel.addEventListener("click", async (event) => {
    if (event.target.closest("[data-archive-close]")) { closeChatArchive(); return; }
    if (event.target.closest("[data-archive-new]")) {
      if (isSending && activeReply) stopReply();
      const number = sessionNumberForCurrent(email);
      if (archiveCurrentChat(email)) {
        startFreshChat(email);
        closeChatArchive();
        window.SidekickUI.toast(`Session ${number} archived. New session started.`);
      }
      return;
    }
    const openId = event.target.closest("[data-archive-open]")?.dataset.archiveOpen;
    if (openId) {
      const chosen = getChatArchive(email).find((item) => item.id === openId);
      if (!chosen) return;
      if (isSending && activeReply) stopReply();
      // The session being replaced goes into the archive first.
      archiveCurrentChat(email);
      setChatArchive(email, getChatArchive(email).filter((item) => item.id !== openId));
      setChatForEmail(email, chosen.messages);
      setCurrentSessionNumber(email, Number(chosen.session) || null);
      try { sessionStorage.removeItem(getChatScrollPositionKey(email)); } catch (error) {}
      renderMessages(getChatForEmail(email));
      scrollToBottom();
      closeChatArchive();
      window.SidekickUI.toast(`Session ${chosen.session} opened`);
      return;
    }
    const deleteId = event.target.closest("[data-archive-delete]")?.dataset.archiveDelete;
    if (deleteId) {
      const item = getChatArchive(email).find((entry) => entry.id === deleteId);
      if (!item) return;
      const ok = await window.SidekickUI.confirm(`Session ${item.session}, “${item.title}”, will be deleted from this phone.`, {
        title: "Delete this session?", confirmText: "Delete", cancelText: "Keep it", tone: "danger",
      });
      if (!ok) return;
      setChatArchive(email, getChatArchive(email).filter((entry) => entry.id !== deleteId));
      openChatArchive({ animate: false });
      window.SidekickUI.toast(`Session ${item.session} deleted`);
    }
  });
}

// The ⋯ menu in the chat header.
function setChatMenuOpen(open) {
  const button = document.getElementById("chat-menu-btn");
  const list = document.getElementById("chat-menu-list");
  if (!button || !list) return;
  list.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (open) list.querySelector("[role=menuitem]")?.focus({ preventScroll: true });
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("#chat-menu-btn");
  const list = document.getElementById("chat-menu-list");
  if (button) { setChatMenuOpen(Boolean(list?.hidden)); return; }
  const item = event.target.closest("#chat-menu-list [data-chat-menu]");
  if (item) {
    setChatMenuOpen(false);
    if (item.dataset.chatMenu === "archive") openChatArchive();
    else if (item.dataset.chatMenu === "delete") void clearChat();
    return;
  }
  if (list && !list.hidden && !event.target.closest(".chat-menu")) setChatMenuOpen(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (document.getElementById("chat-archive") && !document.querySelector(".sk-dialog")) { closeChatArchive(); return; }
  const list = document.getElementById("chat-menu-list");
  if (list && !list.hidden) { setChatMenuOpen(false); document.getElementById("chat-menu-btn")?.focus(); }
});

let isSending = false;
// The reply being written: its requests stop when the traveler taps Stop.
let activeReply = null;
// The server keeps writing a reply when the traveler leaves this tab (currentRequestId);
// another screen or the next visit here picks it up (SidekickCore.chatPending in core.js).
let currentRequestId = "";
let pageLeaving = false;
window.addEventListener("pagehide", () => { pageLeaving = true; });
function clearOwnPending() {
  const pending = window.SidekickCore.chatPending?.get();
  if (pending && pending.requestId === currentRequestId) window.SidekickCore.chatPending.set(null);
}

// Back on this tab while a reply is still being written: wait for it here.
async function resumeReply(email, waiting) {
  const thisReply = new AbortController();
  activeReply = thisReply;
  isSending = true;
  currentRequestId = waiting.requestId;
  replyStartedAt = Date.now();
  setSendButtonMode(true);
  showTypingIndicator();
  scrollToBottom();
  const data = await window.SidekickCore.chatPending.wait(waiting, () => activeReply === thisReply && !thisReply.signal.aborted);
  if (!data || thisReply.signal.aborted || pageLeaving) return;
  clearOwnPending();
  removeTypingIndicator();
  let reply = data.status === "done" ? String(data.reply || data.error || "").trim() : "";
  if (!reply) reply = "Sorry for the inconvenience, please check again later.";
  const places = data.status === "done" ? sanitizeChatPlaces(data.places) : [];
  if (data.status === "done" && Array.isArray(data.actions)) {
    const actionSummary = applyAgentActions(email, data.actions);
    if (actionSummary.length) reply = `${reply}\n\n${actionSummary.join("\n")}`;
  }
  appendMessageToDom("ai", reply, Date.now(), true, places);
  scrollToBottom();
  activeReply = null;
  isSending = false;
  setSendButtonMode(false);
}

const SEND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
const STOP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor"></rect></svg>';

// While a reply is being written the send button becomes Stop.
function setSendButtonMode(stop) {
  const button = getSendBtn();
  if (!button) return;
  button.disabled = false;
  button.classList.toggle("is-stop", stop);
  button.setAttribute("aria-label", stop ? "Stop the reply" : "Send message");
  button.title = stop ? "Stop" : "";
  button.innerHTML = stop ? STOP_ICON : SEND_ICON;
}

function stopReply() {
  if (!activeReply || activeReply.signal.aborted) return;
  activeReply.abort();
  // The server keeps a reply going when the request closes, so tell it to stop.
  if (currentRequestId) {
    window.SidekickCore.apiRequest("/api/chat/cancel", { method: "POST", body: JSON.stringify({ requestId: currentRequestId }) }).catch(() => {});
    clearOwnPending();
  }
  activeReply = null;
  isSending = false;
  removeTypingIndicator();
  appendMessageToDom("ai", "You stopped this reply.", Date.now(), false);
  scrollToBottom();
  setSendButtonMode(false);
  getInputEl()?.focus?.();
}

// The send button: sends, or stops the reply being written.
// A second tap right after sending (a double tap) doesn't count as Stop.
const STOP_GRACE_MS = 800;
let replyStartedAt = 0;
function onSendButtonClick() {
  if (isSending && activeReply) {
    if (Date.now() - replyStartedAt >= STOP_GRACE_MS) stopReply();
    return;
  }
  void sendMessage();
}

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
  const selectedDestination = getSelectedDestination();
  const asksDestinationReviews = Boolean(selectedDestination?.name)
    && /\b(?:reviews?|reviewed|ratings?|visitor feedback|worth visiting|what do (?:visitors|people) think)\b/i.test(userText);

  isSending = true;
  const thisReply = new AbortController();
  activeReply = thisReply;
  currentRequestId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  replyStartedAt = Date.now();
  setSendButtonMode(true);

  appendMessageToDom("user", userText, Date.now(), true);
  scrollToBottom();
  input.value = "";
  showTypingIndicator();

  try {
    const history = getChatForEmail(session.email);
    const merged = applySignals(session.email, userText);
    const companionState = merged.state;
    let reply = "";
    let replyPlaces = [];
    let tripPlan = null;

    if (merged.reset) {
      reply = "Companion memory reset. Tell me destination and number of days, then I can build your travel plan again.";
    } else {
      const pendingDraft = getPendingItinerary(session.email);
      if (asksDestinationReviews) {
        try {
          const backendReply = await askSidekickBackend(history, prefs, companionState, userText);
          reply = await continueIncompleteReply(backendReply.reply || "I couldn’t retrieve review information for this place.", prefs, companionState, session.email);
          // The place's photo card: from the reply, or the place being asked about.
          replyPlaces = sanitizeChatPlaces(backendReply.places);
          if (!replyPlaces.length) replyPlaces = sanitizeChatPlaces([selectedDestination]);
        } catch (error) {
          reply = fallbackReply(userText, companionState, prefs, error);
        }
      } else if (pendingDraft && isDraftRejection(userText)) {
        // A draft that is never saved isn't recorded anywhere.
        setPendingItinerary(session.email, null);
        reply = "Okay, I discarded that itinerary.";
      } else if (pendingDraft && isSaveConfirmation(userText)) {
        try {
          await saveGeneratedItinerary(session.email, pendingDraft);
          setPendingItinerary(session.email, null);
          reply = `Saved! It’s now in your planned trips on the Itinerary tab, with reminders for each activity.`;
        } catch (error) {
          reply = error?.overlap
            ? `I couldn’t save it: ${error.message} Ask me for the trip on other dates.`
            : `I couldn’t save the itinerary right now, so I kept the draft here. ${window.SidekickCore.friendlyError(error, "Please try again in a moment.")}`;
        }
      } else if ((tripPlan = await window.SidekickChatPlanner?.handle(session.email, userText, Boolean(merged.signals.wantsGenerate)))) {
        // Planning a trip: the chat asks for the trip's details (js/chat-planner.js), then
        // opens the Itinerary tab, which builds it the same way as its own button.
        reply = tripPlan.reply;
      } else if (pendingDraft) {
        reply = `I have an itinerary for **${pendingDraft.meta?.destination || "your trip"}** ready for review. Reply **Save itinerary** to add it to your planned trips, or **Discard** to remove it.`;
      } else {
        try {
        const backendReply = await askSidekickBackend(history, prefs, companionState, userText);
        reply = await continueIncompleteReply(backendReply.reply || fallbackReply(userText, companionState, prefs), prefs, companionState, session.email);
        replyPlaces = sanitizeChatPlaces(backendReply.places);
        const actionSummary = applyAgentActions(session.email, backendReply.actions);
        if (actionSummary.length) reply = `${reply}\n\n${actionSummary.join("\n")}`;
        } catch (error) {
          reply = fallbackReply(userText, companionState, prefs, error);
        }
      }
    }

    // Leaving the tab: the server finishes the reply and another screen shows it.
    if (pageLeaving) return;
    // Stopped: the "You stopped this reply." note is already shown.
    if (thisReply.signal.aborted) return;
    clearOwnPending();
    removeTypingIndicator();
    appendMessageToDom("ai", reply, Date.now(), true, replyPlaces);
    scrollToBottom();
    // The trip's details are complete: give a moment to read the summary, then open the planner.
    if (tripPlan?.openPlanner) window.setTimeout(() => { window.location.href = "itinerary.html"; }, 1800);
  } catch (e) {
    if (pageLeaving || thisReply.signal.aborted) return;
    clearOwnPending();
    removeTypingIndicator();
    appendMessageToDom("ai", "I hit an issue while planning. Please try again.", Date.now(), false);
    scrollToBottom();
  } finally {
    // A stopped reply has already handed the button back.
    if (activeReply === thisReply) {
      activeReply = null;
      isSending = false;
      setSendButtonMode(false);
      input?.focus?.();
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const session = window.SidekickCore.requireAuth();
  if (!session) return;

  const prefs = getPreferencesOrRedirect();
  if (!prefs) return;

  const existing = getChatForEmail(session.email);
  if (!existing.length) {
    const opening = window.SidekickCore.getInitialAssistantMessage(prefs);
    setChatForEmail(session.email, [{ role: "ai", content: opening, ts: Date.now() }]);
  }

  renderMessages(getChatForEmail(session.email));
  restoreChatScrollPosition(session.email);
  // Saved once scrolling settles (writing storage on every scroll event costs frames).
  let scrollSaveTimer = 0;
  getMessagesEl()?.addEventListener("scroll", () => {
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(saveChatScrollPosition, 150);
  }, { passive: true });
  window.addEventListener("pagehide", saveChatScrollPosition);
  // Typing: once the keyboard has opened, keep the latest message in view above the text box.
  getInputEl()?.addEventListener("focus", () => { window.setTimeout(scrollToBottom, 350); });
  let pendingMessage = "";
  try {
    pendingMessage = String(sessionStorage.getItem(PENDING_CHAT_MESSAGE_KEY) || "").trim();
    sessionStorage.removeItem(PENDING_CHAT_MESSAGE_KEY);
  } catch (error) {}
  if (pendingMessage) {
    const input = getInputEl();
    if (input) input.value = pendingMessage;
    window.setTimeout(() => sendMessage(), 0);
  } else {
    // A reply still being written from before the traveler left this tab.
    const waiting = window.SidekickCore.chatPending?.get();
    if (waiting && waiting.email === session.email) void resumeReply(session.email, waiting);
  }
});

window.sendMessage = sendMessage;
window.onSendButtonClick = onSendButtonClick;
window.handleKeyPress = handleKeyPress;
window.clearChat = clearChat;
