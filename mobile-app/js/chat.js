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

function getSelectedDestination() {
  try {
    const raw = localStorage.getItem(SELECTED_DESTINATION_KEY);
    return raw ? JSON.parse(raw) : null;
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

function formatPhpBand(band) {
  if (!hasPriceBand(band)) return "unavailable";
  const low = Number(band?.lowPhp);
  const high = Number(band?.highPhp);
  const format = (value) => `PHP ${Math.round(value).toLocaleString()}`;
  return low === high ? format(low) : `${format(low)}–${format(high)}`;
}

function sumPriceBands(bands) {
  if (!bands.length || bands.some((band) => !hasPriceBand(band))) return null;
  return {
    lowPhp: bands.reduce((sum, band) => sum + Number(band.lowPhp), 0),
    highPhp: bands.reduce((sum, band) => sum + Number(band.highPhp), 0),
  };
}

function buildItineraryDraftReply(draft) {
  const days = Array.isArray(draft.itinerary) ? draft.itinerary : [];
  const budget = draft.meta?.liveTripBudget || null;
  const activityCosts = new Map((draft.meta?.liveActivityCosts || []).map((item) => [String(item.placeId), item]));
  const lines = [`I’ve prepared a ${days.length}-day itinerary for **${draft.meta?.destination || "your trip"}**. Take a look at the schedule and estimates below.`];

  for (const [index, day] of days.entries()) {
    const activities = Array.isArray(day.activities) ? day.activities : [];
    const visitMinutes = activities.reduce((sum, activity) => sum + (Number(activity.durationMinutes) || 0), 0);
    const travelMinutes = activities.reduce((sum, activity) => sum + (Number(activity.travelMinutes) || 0), 0);
    const ticketBands = activities.map((activity) => activityCosts.get(String(activity.placeId)))
      .filter(hasPriceBand);
    const knownTickets = sumPriceBands(ticketBands);
    const missingTicketCount = Math.max(0, activities.length - ticketBands.length);
    const dayItems = activities.map((activity) => {
      const ticket = activityCosts.get(String(activity.placeId));
      const visit = Number(activity.durationMinutes) > 0 ? `about ${activity.durationMinutes} min on site` : "visit duration unavailable";
      const transfer = Number(activity.travelMinutes) > 0 ? `; about ${activity.travelMinutes} min travel from the previous stop` : "";
      const ticketText = ticket ? `; admission ${formatPhpBand(ticket)}` : "";
      return `- **${activity.timeLabel || "Flexible"}: ${activity.title}** (${visit}${transfer}${ticketText})`;
    });
    const dayCost = knownTickets
      ? `Estimated activity costs: **${formatPhpBand(knownTickets)}** for ${ticketBands.length}/${activities.length} priced stops${missingTicketCount ? `; ${missingTicketCount} stop(s) have no verified price` : ""}.`
      : `Activity cost estimates are unavailable for these stops (${ticketBands.length}/${activities.length} priced).`;
    if (knownTickets) {
      day.estimatedDayCostPhp = Math.round((knownTickets.lowPhp + knownTickets.highPhp) / 2);
      day.estimatedDayCostLowPhp = knownTickets.lowPhp;
      day.estimatedDayCostHighPhp = knownTickets.highPhp;
    }
    lines.push(`\n**Day ${day.dayNumber || index + 1}${day.dateLabel ? ` — ${day.dateLabel}` : ""}**`);
    lines.push("");
    lines.push(...dayItems);
    lines.push("");
    lines.push(`Planned time: about ${Math.floor(visitMinutes / 60)} hr ${visitMinutes % 60} min at stops, plus about ${travelMinutes} min between stops. ${dayCost}`);
  }

  const totalBudget = hasPriceBand(budget && { lowPhp: budget.totalLowPhp, highPhp: budget.totalHighPhp })
    ? `\n\nEstimated activity costs: **${formatPhpBand({ lowPhp: budget.totalLowPhp, highPhp: budget.totalHighPhp })}** for ${budget.pricedActivityCount || 0}/${budget.totalActivityCount || days.reduce((count, day) => count + (day.activities || []).length, 0)} priced stops.`
    : "\n\nI couldn’t verify a total for the activity costs; any unavailable prices are left out rather than guessed.";
  const enteredBudget = Number(draft.meta?.budgetAmountPhp) > 0
    ? ` I used your whole-trip budget of PHP ${Number(draft.meta.budgetAmountPhp).toLocaleString()} to choose value-focused stops, with about PHP ${Number(draft.meta.activityBudgetTargetPhp || Math.floor(Number(draft.meta.budgetAmountPhp) * 0.25)).toLocaleString()} planned for activity admission. The rest is reserved for travel, lodging, meals, local transport, and a buffer; the activity prices above are estimates, not a complete trip quote.`
    : '';
  const sourcesNote = draft.meta?.isDevelopmentMock
    ? " This is development sample data, not a live verified estimate."
    : budget?.sources?.length ? " These ranges use current web sources; prices can change. Route durations are estimates and traffic can change."
      : " Live price sources were unavailable, so I have not filled in unsupported prices.";
  return `${lines.join("\n")}${totalBudget}${enteredBudget}${sourcesNote}\n\nWould you like to keep this plan? Reply **Save itinerary** to add it to your planned trips on the Itinerary tab, or **Discard**.`;
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

  const data = await window.SidekickCore.apiRequest("/api/chat", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  return data;
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

async function generateItineraryWithBackend(prefs, state, userText) {
  const session = window.SidekickCore.getAuthSession();
  // "Today" on this phone (the UTC date was a day behind in the early morning).
  const startDate = state.startDate || window.SidekickCore.localDateValue?.() || new Date().toISOString().slice(0, 10);
  // A trip starting today begins about half an hour from now; late in the day the
  // first day becomes an evening plan instead of a full day that has already passed.
  const firstDayStart = window.SidekickCore.firstDayStartMinute?.(startDate) ?? null;
  const lateStyle = Number.isFinite(firstDayStart) && firstDayStart > 19 * 60 + 30 ? { tripStyle: { timeOfDay: "night", pace: "packed" } } : {};
  const end = new Date(`${startDate}T00:00:00`);
  end.setDate(end.getDate() + Math.max(1, Number(state.dayCount) || 3) - 1);
  const localEnd = new Date(end.getTime() - end.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return window.SidekickCore.apiRequest("/api/itinerary/generate", {
    method: "POST",
    body: JSON.stringify({
      email: session?.email || "",
      message: userText,
      // Lets the server count this as a chatbot message (other screens also generate itineraries).
      source: "chat",
      selectedDestination: state.destination ? { name: state.destination } : null,
      profile: {
        ...prefs,
        budget: state.budget || prefs?.budget || "",
        budgetAmountPhp: state.budgetAmountPhp || prefs?.budgetAmountPhp || null,
        startDate,
        endDate: localEnd,
        durationDays: Math.max(1, Number(state.dayCount) || 3),
        pace: state.pace || "",
        mustSee: state.mustSee || [],
        avoid: state.avoid || [],
        ...(Number.isFinite(firstDayStart) ? { firstDayStartMinute: firstDayStart } : {}),
        ...lateStyle,
        clientToday: window.SidekickCore.localDateValue?.() || "",
      },
    }),
  });
}

async function researchDraftBudget(email, draft, state) {
  if (draft.meta?.liveTripBudget && Array.isArray(draft.meta.liveActivityCosts)) {
    draft.meta.liveTripBudgetCacheKey = getDraftBudgetCacheKey(draft);
    draft.meta.liveTripBudgetCachedAt = Date.now();
    return draft;
  }
  if (draft.meta?.isDevelopmentMock) {
    draft.meta.liveTripBudget = null;
    draft.meta.liveActivityCosts = [];
    draft.meta.budgetEstimateError = "Live estimates are disabled in development sample mode.";
    return draft;
  }
  try {
    const meta = draft.meta || {};
    const response = await window.SidekickCore.apiRequest("/api/itinerary/estimate-budget", {
      method: "POST",
      body: JSON.stringify({
        email,
        itinerary: draft.itinerary,
        destination: meta.destination || state.destination,
        startDate: meta.startDate || state.startDate,
        endDate: meta.endDate,
        budgetTier: state.budget || "User-entered budget",
        budgetAmountPhp: Number(state.budgetAmountPhp || 0) > 0 ? Number(state.budgetAmountPhp) : null,
        origin: meta.origin || null,
        travelMode: meta.travelMode || "DRIVE",
      }),
    });
    draft.meta.liveTripBudget = response.tripBudget || null;
    draft.meta.liveActivityCosts = Array.isArray(response.activityCosts) ? response.activityCosts : [];
    return draft;
  } catch (error) {
    draft.meta.liveTripBudget = null;
    draft.meta.liveActivityCosts = [];
    draft.meta.budgetEstimateError = window.SidekickCore.friendlyError(error, "Price research is unavailable.");
    return draft;
  }
}

function getDraftBudgetCacheKey(itineraryData) {
  const meta = itineraryData?.meta || {};
  const input = JSON.stringify({
    destination: String(meta.destination || meta.focusedPlace || ''),
    startDate: String(meta.startDate || ''),
    endDate: String(meta.endDate || ''),
    itinerary: (itineraryData?.itinerary || []).map((day) => ({
      activities: (day.activities || []).map((activity) => ({
        placeId: String(activity.placeId || ''),
        title: String(activity.title || ''),
        location: String(activity.location || ''),
        category: String(activity.category || 'activity'),
      })),
    })),
  });
  let firstHash = 0x811c9dc5;
  let secondHash = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    firstHash = Math.imul(firstHash ^ code, 0x01000193);
    secondHash = Math.imul(secondHash ^ code, 0x85ebca6b);
  }
  return `trip-budget-v3-${(firstHash >>> 0).toString(16)}-${(secondHash >>> 0).toString(16)}`;
}

// Shown when the AI can't answer. An honest "try again" beats a canned reply
// that ignores what the user actually asked.
function fallbackReply(userText, state, prefs, error) {
  const message = String(error?.message || "");
  if (/too many/i.test(message)) return message;
  return "I couldn’t reach Sidekick AI just now. Please send your message again in a moment.";
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

function formatAssistantMessage(content) {
  const inlineFormat = (text) => {
    let normalized = String(text);
    if ((normalized.match(/\*\*/g) || []).length % 2) normalized = normalized.replace(/\*\*/g, "");
    if ((normalized.match(/(?<!\*)\*(?!\*)/g) || []).length % 2) normalized = normalized.replace(/(?<!\*)\*(?!\*)/g, "");
    return window.SidekickCore.escapeHtml(normalized)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1<em>$2</em>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https:\/\/(?:www\.google\.com\/maps\/|maps\.google\.com\/)[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
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

async function clearChat() {
  const ok = await window.SidekickUI.confirm("Your messages with Sidekick on this phone will be deleted.", {
    title: "Clear chat history?", confirmText: "Clear chat", tone: "danger",
  });
  if (!ok) return;
  const session = window.SidekickCore.getAuthSession();
  if (!session?.email) return;

  setChatForEmail(session.email, []);
  try { sessionStorage.removeItem(getChatScrollPositionKey(session.email)); } catch (error) {}
  const prefs = window.SidekickCore.getPreferences() || {};
  const opening = window.SidekickCore.getInitialAssistantMessage(prefs);
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
  const selectedDestination = getSelectedDestination();
  const asksDestinationReviews = Boolean(selectedDestination?.name)
    && /\b(?:reviews?|reviewed|ratings?|visitor feedback|worth visiting|what do (?:visitors|people) think)\b/i.test(userText);

  isSending = true;
  const sendBtn = getSendBtn();
  if (sendBtn) sendBtn.disabled = true;

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
    let generatedItineraryThisReply = false;

    if (merged.reset) {
      reply = "Companion memory reset. Tell me destination and number of days, then I can build your travel plan again.";
    } else {
      const pendingDraft = getPendingItinerary(session.email);
      if (asksDestinationReviews) {
        try {
          const backendReply = await askSidekickBackend(history, prefs, companionState, userText);
          reply = await continueIncompleteReply(backendReply.reply || "I couldn’t retrieve review information for this place.", prefs, companionState, session.email);
        } catch (error) {
          reply = "I couldn’t retrieve current Google review details for this place. Please try again in a moment.";
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
      } else if (merged.signals.wantsGenerate && !companionNeedsEssentials(companionState)) {
        try {
          const generated = await generateItineraryWithBackend(prefs, companionState, userText);
          if (!generated?.itinerary || !Array.isArray(generated.itinerary)) {
            throw new Error("The itinerary service returned no itinerary.");
          }
          const draftStartDate = companionState.startDate || generated.meta?.startDate || new Date().toISOString().slice(0, 10);
          const draft = {
            itinerary: window.SidekickCore.applyLocalScheduleTimes(generated.itinerary, draftStartDate),
            meta: {
              ...(generated.meta || {}),
              startDate: draftStartDate,
              source: generated.meta?.source || "sidekick-chat-ai",
              serverTripId: generated.tripId,
            },
          };
          await researchDraftBudget(session.email, draft, companionState);
          setPendingItinerary(session.email, draft);
          reply = buildItineraryDraftReply(draft);
          generatedItineraryThisReply = true;
        } catch (error) {
          reply = `I couldn’t prepare a verified itinerary right now. ${window.SidekickCore.friendlyError(error, "Please check the destination and try again.")}`;
        }
      } else if (merged.signals.wantsGenerate && companionNeedsEssentials(companionState)) {
        const missing = [!companionState.destination ? "destination" : "", !companionState.dayCount ? "number of days" : ""].filter(Boolean).join(" and ");
        reply = `I can prepare a detailed itinerary. What ${missing} would you like?`;
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

    removeTypingIndicator();
    appendMessageToDom("ai", reply, Date.now(), true, replyPlaces);
    scrollToBottom();
    if (generatedItineraryThisReply) window.SidekickAppRating?.afterItineraryGenerated();
  } catch (e) {
    removeTypingIndicator();
    appendMessageToDom("ai", "I hit an issue while planning. Please try again.", Date.now(), false);
    scrollToBottom();
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
    const opening = window.SidekickCore.getInitialAssistantMessage(prefs);
    setChatForEmail(session.email, [{ role: "ai", content: opening, ts: Date.now() }]);
  }

  renderMessages(getChatForEmail(session.email));
  restoreChatScrollPosition(session.email);
  getMessagesEl()?.addEventListener("scroll", saveChatScrollPosition, { passive: true });
  let pendingMessage = "";
  try {
    pendingMessage = String(sessionStorage.getItem(PENDING_CHAT_MESSAGE_KEY) || "").trim();
    sessionStorage.removeItem(PENDING_CHAT_MESSAGE_KEY);
  } catch (error) {}
  if (pendingMessage) {
    const input = getInputEl();
    if (input) input.value = pendingMessage;
    window.setTimeout(() => sendMessage(), 0);
  }
});

window.sendMessage = sendMessage;
window.handleKeyPress = handleKeyPress;
window.clearChat = clearChat;
