const COMPANION_MEMORY_KEY = "sidekick.aiCompanionByEmail.v2";
const SELECTED_DESTINATION_KEY = "sidekick.selectedDestination.v1";
const PENDING_ITINERARY_KEY = "sidekick.pendingItineraryByEmail.v1";

const TRAINING_CONTEXT = [
  "You are Sidekick Companion, trained to help users plan Philippines travel inside the Sidekick app.",
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
  const categories = budget?.categories || [];
  const mealPerDay = categories.find((item) => item.key === "meals")?.perDay;
  const localTransportPerDay = categories.find((item) => item.key === "localTransport")?.perDay;
  const lodgingPerNight = categories.find((item) => item.key === "lodging")?.perNight;
  const activityCosts = new Map((draft.meta?.liveActivityCosts || []).map((item) => [String(item.placeId), item]));
  const lines = [`I’ve prepared a ${days.length}-day itinerary for **${draft.meta?.destination || "your trip"}**. Take a look at the schedule and estimates below; it isn’t saved yet.`];

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
    const costParts = [];
    if (knownTickets) costParts.push(`known admission ${formatPhpBand(knownTickets)}`);
    if (hasPriceBand(mealPerDay)) costParts.push(`meals ${formatPhpBand(mealPerDay)}/day`);
    if (hasPriceBand(localTransportPerDay)) costParts.push(`local transport ${formatPhpBand(localTransportPerDay)}/day`);
    const dailyBands = missingTicketCount === 0 && knownTickets && hasPriceBand(mealPerDay)
      && hasPriceBand(localTransportPerDay) && (index === days.length - 1 || hasPriceBand(lodgingPerNight))
      ? [knownTickets, mealPerDay, localTransportPerDay, ...(index < days.length - 1 && lodgingPerNight ? [lodgingPerNight] : [])]
      : [];
    const dailyEstimate = sumPriceBands(dailyBands);
    if (index < days.length - 1) costParts.push(`lodging ${formatPhpBand(lodgingPerNight)}/night`);
    const dayCost = dailyEstimate
      ? `Estimated day total: **${formatPhpBand(dailyEstimate)}**${index === days.length - 1 ? " (no lodging night included)" : " (includes one lodging night)"}.`
      : `Estimated costs: ${costParts.length ? costParts.join("; ") : "unavailable"}${missingTicketCount ? `; ${missingTicketCount} admission price(s) unverified` : ""}. A complete day total could not be verified.`;
    if (dailyEstimate) {
      day.estimatedDayCostPhp = Math.round((dailyEstimate.lowPhp + dailyEstimate.highPhp) / 2);
      day.estimatedDayCostLowPhp = dailyEstimate.lowPhp;
      day.estimatedDayCostHighPhp = dailyEstimate.highPhp;
    }
    lines.push(`\n**Day ${day.dayNumber || index + 1}${day.dateLabel ? ` — ${day.dateLabel}` : ""}**`);
    lines.push("");
    lines.push(...dayItems);
    lines.push("");
    lines.push(`Planned time: about ${Math.floor(visitMinutes / 60)} hr ${visitMinutes % 60} min at stops, plus about ${travelMinutes} min between stops. ${dayCost}`);
  }

  const totalBudget = hasPriceBand(budget && { lowPhp: budget.totalLowPhp, highPhp: budget.totalHighPhp })
    ? `\n\nResearch-based full-trip estimate for one adult: **${formatPhpBand({ lowPhp: budget.totalLowPhp, highPhp: budget.totalHighPhp })}**.`
    : "\n\nI couldn’t verify a complete full-trip cost range. Any listed prices are partial estimates; check current prices before booking.";
  const lodgingNote = hasPriceBand(lodgingPerNight) ? ` Lodging is estimated separately at ${formatPhpBand(lodgingPerNight)} per night.` : " Lodging prices could not be verified.";
  const sourcesNote = draft.meta?.isDevelopmentMock
    ? " This is development sample data, not a live verified estimate."
    : budget?.sources?.length ? " These ranges use current web sources; prices can change. Route durations are estimates and traffic can change."
      : " Live price sources were unavailable, so I have not filled in unsupported prices.";
  return `${lines.join("\n")}${totalBudget}${lodgingNote}${sourcesNote}\n\nWould you like me to save this itinerary? Reply **Save itinerary** or **Discard**.`;
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

async function askSidekickBackend(history, prefs, state, userText) {
  const selectedDestination = getSelectedDestination();
  const payload = {
    email: window.SidekickCore.getAuthSession()?.email || "",
    message: userText,
    selectedDestination,
    history: (history || []).slice(-12),
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
      "Continue your immediately previous answer from its last words. Do not repeat anything already written; finish the incomplete thought and any remaining points."
    );
    const continuationText = String(continuation?.reply || "").trim();
    if (continuationText) return `${initial} ${continuationText}`;
  } catch (error) {}

  return `${initial}\n\nIt looks like my answer was cut off. Reply “continue” and I’ll finish it.`;
}

async function generateItineraryWithBackend(prefs, state, userText) {
  const session = window.SidekickCore.getAuthSession();
  const startDate = state.startDate || new Date().toISOString().slice(0, 10);
  const end = new Date(`${startDate}T00:00:00`);
  end.setDate(end.getDate() + Math.max(1, Number(state.dayCount) || 3) - 1);
  const localEnd = new Date(end.getTime() - end.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  return window.SidekickCore.apiRequest("/api/itinerary/generate", {
    method: "POST",
    body: JSON.stringify({
      email: session?.email || "",
      message: userText,
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
      },
    }),
  });
}

async function researchDraftBudget(email, draft, state) {
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
    draft.meta.budgetEstimateError = error.message || "Price research is unavailable.";
    return draft;
  }
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
      startDate: generated.meta?.startDate || new Date().toISOString(),
    },
  };
  window.SidekickCore.setItineraryByEmail(byEmail);

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
      summaries.push(`Map results: ${action.places.map((place) => place.name).filter(Boolean).join(", ") || "No matching places found."}`);
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

function formatAssistantMessage(content) {
  const inlineFormat = (text) => {
    let normalized = String(text);
    if ((normalized.match(/\*\*/g) || []).length % 2) normalized = normalized.replace(/\*\*/g, "");
    if ((normalized.match(/(?<!\*)\*(?!\*)/g) || []).length % 2) normalized = normalized.replace(/(?<!\*)\*(?!\*)/g, "");
    return window.SidekickCore.escapeHtml(normalized)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, "$1<em>$2</em>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>");
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

function appendMessageToDom(role, content, ts, persist = true) {
  const el = getMessagesEl();
  if (!el) return;

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
    } else {
      const pendingDraft = getPendingItinerary(session.email);
      if (pendingDraft && isDraftRejection(userText)) {
        setPendingItinerary(session.email, null);
        reply = "I discarded that itinerary draft. It wasn’t added to your saved itineraries.";
      } else if (pendingDraft && isSaveConfirmation(userText)) {
        saveGeneratedItinerary(session.email, pendingDraft);
        setPendingItinerary(session.email, null);
        reply = `Saved. Open the **Itinerary** tab to see the full schedule, estimated visit durations, route times, and available cost details for ${pendingDraft.meta?.destination || "your trip"}.`;
      } else if (merged.signals.wantsGenerate && !companionNeedsEssentials(companionState)) {
        try {
          const generated = await generateItineraryWithBackend(prefs, companionState, userText);
          if (!generated?.itinerary || !Array.isArray(generated.itinerary)) {
            throw new Error("The itinerary service returned no itinerary.");
          }
          const draft = {
            itinerary: generated.itinerary,
            meta: {
              ...(generated.meta || {}),
              startDate: companionState.startDate || generated.meta?.startDate || new Date().toISOString().slice(0, 10),
              source: generated.meta?.source || "sidekick-chat-ai",
            },
          };
          await researchDraftBudget(session.email, draft, companionState);
          setPendingItinerary(session.email, draft);
          reply = buildItineraryDraftReply(draft);
        } catch (error) {
          reply = `I couldn’t prepare a verified itinerary right now. ${String(error?.message || "Please check the destination and try again.")}`;
        }
      } else if (merged.signals.wantsGenerate && companionNeedsEssentials(companionState)) {
        const missing = [!companionState.destination ? "destination" : "", !companionState.dayCount ? "number of days" : ""].filter(Boolean).join(" and ");
        reply = `I can prepare a detailed itinerary. What ${missing} would you like?`;
      } else if (pendingDraft) {
        reply = `I have an unsaved itinerary draft for **${pendingDraft.meta?.destination || "your trip"}** ready for review. Reply **Save itinerary** to add it to your saved itineraries, or **Discard** to remove the draft.`;
      } else {
        try {
        const backendReply = await askSidekickBackend(history, prefs, companionState, userText);
        reply = await continueIncompleteReply(backendReply.reply || fallbackReply(userText, companionState, prefs), prefs, companionState, session.email);
        const actionSummary = applyAgentActions(session.email, backendReply.actions);
        if (actionSummary.length) reply = `${reply}\n\n${actionSummary.join("\n")}`;
        } catch (error) {
          reply = fallbackReply(userText, companionState, prefs);
        }
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
