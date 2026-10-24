/* Trip planning in the Sidekick chat. When the traveler asks Sidekick to plan a trip,
   the chat asks for what it still needs, one short question at a time (destination,
   dates, number of travelers, budget, and an optional starting point), understanding
   everyday answers ("this weekend", "Nov 7 to 9", "4 pax", "10k"). It then hands the
   trip to the Itinerary tab, which runs the same steps as its own Build Itinerary button:
   the summary, the budget check, trip style, the hotel choice and building the plan.
   The handoff uses the same session key as Home's "Generate itinerary". */
(function () {
  'use strict';

  var STATE_KEY = 'sidekick.chatTripPlan.v1';
  var HANDOFF_KEY = 'sidekick.itinerary.pendingBuild';
  var EXPIRES_MS = 30 * 60 * 1000; // an unfinished plan is forgotten after 30 minutes
  var MAX_DAYS = 14;
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  var WORD_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

  function core() { return window.SidekickCore; }
  function maxTravelers() { return core()?.MAX_TRAVELERS || 10; }

  // ---- Saved progress (per account) ---------------------------------------------------
  function readAll() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {}; } catch (error) { return {}; }
  }
  function load(email) {
    var plan = readAll()[email];
    if (!plan || Date.now() - Number(plan.updatedAt || 0) > EXPIRES_MS) return null;
    return plan;
  }
  function save(email, plan) {
    var all = readAll();
    if (plan) all[email] = Object.assign({}, plan, { updatedAt: Date.now() }); else delete all[email];
    try { localStorage.setItem(STATE_KEY, JSON.stringify(all)); } catch (error) { /* this message still works */ }
  }

  // ---- Dates ----------------------------------------------------------------------------
  function today() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function iso(date) { return core()?.localDateValue ? core().localDateValue(date) : date.toISOString().slice(0, 10); }
  function addDays(date, days) { var d = new Date(date); d.setDate(d.getDate() + days); return d; }
  function fromIso(text) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  // A month and day with no year: this year, or next year if that date has passed.
  function monthDay(monthIndex, day) {
    var base = today();
    var date = new Date(base.getFullYear(), monthIndex, day);
    if (date.getMonth() !== monthIndex) return null;
    if (date < base) date = new Date(base.getFullYear() + 1, monthIndex, day);
    return date;
  }
  // The coming day of that name (today counts, unless it must be a later one).
  function nextWeekday(index, notToday) {
    var base = today();
    var diff = (index - base.getDay() + 7) % 7;
    if (diff === 0 && notToday) diff = 7;
    return addDays(base, diff);
  }

  // { start: Date, end: Date|null, days: number|null } from a message, or null.
  function parseDates(text) {
    var lower = String(text || '').toLowerCase();
    var result = { start: null, end: null, days: null };

    var dayCount = lower.match(/\b(\d{1,2})\s*-?\s*(?:days?|d)\b/) || lower.match(/\b(\d{1,2})d\s*\d{1,2}n\b/);
    if (dayCount) result.days = Number(dayCount[1]);
    var wordDays = lower.match(/\b(one|two|three|four|five|six|seven)\s*-?\s*days?\b/);
    if (!result.days && wordDays) result.days = WORD_NUMBERS[wordDays[1]];
    var nights = lower.match(/\b(\d{1,2})\s*-?\s*nights?\b/);
    if (!result.days && nights) result.days = Number(nights[1]) + 1;
    if (!result.days && /\bday ?trip\b/.test(lower)) result.days = 1;
    if (!result.days && /\bovernight\b/.test(lower)) result.days = 2;

    var isoMatch = lower.match(/\b(\d{4}-\d{2}-\d{2})\b(?:\s*(?:to|until|-|–)\s*(\d{4}-\d{2}-\d{2}))?/);
    if (isoMatch) {
      result.start = fromIso(isoMatch[1]);
      if (isoMatch[2]) result.end = fromIso(isoMatch[2]);
    }
    // "Nov 7", "November 7 to 9", "Nov 7 - Nov 9", "7 Nov", "7-9 Nov"
    var monthFirst = lower.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*(?:to|until|-|–)\s*(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+)?(\d{1,2})(?:st|nd|rd|th)?)?\b/);
    var dayFirst = lower.match(/\b(\d{1,2})(?:st|nd|rd|th)?(?:\s*(?:to|until|-|–)\s*(\d{1,2})(?:st|nd|rd|th)?)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
    if (!result.start && monthFirst) {
      var month = MONTHS.indexOf(monthFirst[1]);
      result.start = monthDay(month, Number(monthFirst[2]));
      if (monthFirst[4]) result.end = monthDay(monthFirst[3] ? MONTHS.indexOf(monthFirst[3]) : month, Number(monthFirst[4]));
    } else if (!result.start && dayFirst) {
      var month2 = MONTHS.indexOf(dayFirst[3]);
      result.start = monthDay(month2, Number(dayFirst[1]));
      if (dayFirst[2]) result.end = monthDay(month2, Number(dayFirst[2]));
    }
    if (!result.start) {
      if (/\btoday\b/.test(lower)) result.start = today();
      else if (/\btomorrow\b/.test(lower)) result.start = addDays(today(), 1);
      else if (/\b(this|next)\s+weekend\b|\bweekend\b/.test(lower)) {
        var saturday = nextWeekday(6, false);
        if (/\bnext\s+weekend\b/.test(lower)) saturday = addDays(saturday, 7);
        result.start = saturday;
        if (!result.days) result.days = 2;
      } else {
        var weekday = lower.match(/\b(next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
        // "Saturday" or "next Saturday": the coming one.
        if (weekday) result.start = nextWeekday(WEEKDAYS.indexOf(weekday[2]), Boolean(weekday[1]));
      }
    }
    if (result.start && result.end && result.end < result.start) result.end = null;
    return result.start || result.days ? result : null;
  }

  // ---- Travelers, budget, destination ----------------------------------------------------
  function parseTravelers(text, asked) {
    var lower = String(text || '').toLowerCase();
    if (/\b(solo|alone|just me|only me|by myself|myself)\b/.test(lower)) return 1;
    if (/\b(couple|my (partner|girlfriend|boyfriend|wife|husband|gf|bf)|the two of us|two of us)\b/.test(lower)) return 2;
    var count = lower.match(/\b(\d{1,2})\s*(?:people|persons?|pax|travell?ers?|friends|adults|of us|heads?|katao)\b/)
      || lower.match(/\b(?:family|group|barkada|team|party) of (\d{1,2})\b/)
      || lower.match(/\bwe(?:'re| are)\s+(\d{1,2})\b/)
      || lower.match(/\bfor (\d{1,2})\b(?!\s*(?:days?|nights?|d\b|k\b|thousand|pesos?|php))/);
    var words = lower.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:people|persons?|pax|travell?ers?|friends|of us)\b/);
    var value = count ? Number(count[1]) : words ? WORD_NUMBERS[words[1]] : null;
    if (!value && asked) {
      var bare = lower.match(/^\s*(\d{1,2})\s*$/) || lower.match(/^\s*(one|two|three|four|five|six|seven|eight|nine|ten)\s*$/);
      if (bare) value = Number(bare[1]) || WORD_NUMBERS[bare[1]];
    }
    return value && value >= 1 ? Math.min(maxTravelers(), value) : null;
  }

  function parseBudget(text, asked) {
    var raw = String(text || '');
    var m = raw.match(/(?:₱|php\s*)\s*([\d,]+(?:\.\d+)?)\s*(k|thousand)?/i)
      || raw.match(/\b([\d,]+(?:\.\d+)?)\s*(k|thousand)\b/i)
      || raw.match(/\b([\d,]+(?:\.\d+)?)\s*(?:pesos?|php)\b/i)
      || raw.match(/\bbudget(?:\s+(?:is|of))?\s*(?:about|around)?\s*([\d,]{3,}(?:\.\d+)?)/i)
      || (asked ? raw.match(/^\s*([\d,]{3,}(?:\.\d+)?)\s*(k|thousand)?\s*$/i) : null);
    if (!m) return null;
    var value = Number(String(m[1]).replace(/,/g, '')) * (/^(k|thousand)$/i.test(m[2] || '') ? 1000 : 1);
    return Number.isFinite(value) && value >= 100 && value <= 100000000 ? Math.round(value) : null;
  }

  function parseDestination(text, asked) {
    var raw = String(text || '').trim();
    var m = raw.match(/\b(?:to|in|visit|at|around|explore|for)\s+([A-Za-zÑñ][A-Za-zÑñ .'-]{1,50}?)(?=\s+(?:for|with|on|this|next|from|tomorrow|today|and|budget)\b|\s+\d|[,.!?]|$)/i);
    var name = m ? m[1].trim() : '';
    // An answer that is really a date, a group size or a budget is not a place.
    var other = parseDates(raw) || parseTravelers(raw, false) || parseBudget(raw, false);
    if (!name && asked && !other && raw.length <= 60 && !/\d/.test(raw) && !/^(yes|no|ok|okay|sure|skip|none|idk|not sure)$/i.test(raw)) name = raw;
    // "to visit Taal" -> "Taal"; "the Masasa Beach" -> "Masasa Beach".
    name = name.replace(/^(?:visit|go to|travel to|explore|see|the)\s+/i, '').replace(/^(?:the)\s+/i, '');
    if (/^(me|us|my|our|a|an|the|go|travel|trip|myself|ourselves|everyone|you)\b/i.test(name)) return '';
    return name;
  }

  function parseOrigin(text) {
    var m = String(text || '').match(/\bfrom\s+([A-Za-zÑñ][A-Za-zÑñ .,'-]{1,60}?)(?=\s+(?:to|for|on|with|this|next)\b|[.!?]|$)/i);
    return m ? m[1].trim().replace(/[,.]$/, '') : '';
  }

  // ---- Conversation ----------------------------------------------------------------------
  function wantsTripPlan(text) {
    var lower = String(text || '').toLowerCase();
    return /\b(plan|build|make|create|generate|prepare)\b[^.?!]{0,40}\b(trip|itinerary|itineraries|vacation|getaway|outing|travel plan|tour)\b/.test(lower)
      || /\bitinerary (for|to|in)\b/.test(lower)
      || /\b(plan|schedule) (my|our|a|an) (day|weekend)\b/.test(lower);
  }
  function wantsStop(text) {
    return /^(cancel|stop|never ?mind|nevermind|forget it|no thanks|not now|quit)\b/i.test(String(text || '').trim());
  }

  function fmt(date) {
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function peso(value) { return '₱' + Number(value).toLocaleString('en-US'); }

  // Fills the plan from the message; `asked` is the question the traveler is answering.
  function absorb(plan, text) {
    var asked = plan.asked || '';
    var destination = parseDestination(text, asked === 'destination');
    if (destination && (asked === 'destination' || !plan.destination)) plan.destination = destination;

    var dates = parseDates(text);
    if (dates) {
      if (dates.start) plan.startDate = iso(dates.start);
      if (dates.end) plan.days = Math.round((dates.end - dates.start) / 86400000) + 1;
      else if (dates.days) plan.days = dates.days;
    } else if (asked === 'days') {
      var bareDays = String(text).match(/^\s*(\d{1,2})\s*$/);
      if (bareDays) plan.days = Number(bareDays[1]);
    }
    var travelers = parseTravelers(text, asked === 'travelers');
    if (travelers) plan.travelers = travelers;
    var budget = parseBudget(text, asked === 'budget');
    if (budget) plan.budget = budget;
    var origin = parseOrigin(text);
    if (origin) { plan.origin = origin; plan.originAsked = true; }
    if (asked === 'origin' && !origin) {
      var answer = String(text).trim();
      plan.originAsked = true;
      if (!/^(skip|no|none|nope|not sure|idk|wala|later|n\/a)$/i.test(answer) && answer.length <= 80) plan.origin = answer;
    }
  }

  // The next question, or null when the plan is complete.
  function nextQuestion(plan) {
    if (!plan.destination) return { key: 'destination', text: 'Sure! Where in Batangas would you like to go? (for example Nasugbu, Anilao or Laiya)' };
    if (!plan.startDate) return { key: 'dates', text: 'When is the trip, and for how many days? (for example "this weekend", "Nov 7 to 9" or "tomorrow for 2 days")' };
    if (!plan.days) return { key: 'days', text: 'How many days will you stay?' };
    if (!plan.travelers) return { key: 'travelers', text: 'How many travelers, including you?' };
    if (!plan.budget) return { key: 'budget', text: 'What is your total budget for the whole group? (for example ₱10,000)' };
    if (!plan.originAsked) return { key: 'origin', text: 'Where will you start from, for travel times? (a town or address, or say "skip")' };
    return null;
  }

  function problem(plan) {
    var start = fromIso(plan.startDate);
    if (start && start < today()) { plan.startDate = ''; return 'That date has already passed. When is the trip?'; }
    if (plan.days && (plan.days < 1 || plan.days > MAX_DAYS)) { plan.days = null; return 'Trips can be 1 to ' + MAX_DAYS + ' days. How many days?'; }
    return '';
  }

  function handoff(email, plan) {
    var start = fromIso(plan.startDate);
    var end = addDays(start, plan.days - 1);
    try {
      sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({
        destination: plan.destination,
        startDate: iso(start),
        endDate: iso(end),
        budgetAmountPhp: plan.budget,
        travelers: plan.travelers,
        origin: plan.origin || '',
        createdAt: Date.now(),
      }));
    } catch (error) { return false; }
    save(email, null);
    return true;
  }

  // Handles a chat message. Returns { reply, openPlanner } when the planner answers it,
  // or null when the message is for the normal chat.
  // start: the chat already knows this message asks for a trip plan.
  function handle(email, text, start) {
    var plan = load(email);
    if (!plan && !start && !wantsTripPlan(text)) return null;
    if (plan && wantsStop(text)) {
      save(email, null);
      return { reply: 'Okay, I stopped planning that trip. Ask me any time.' };
    }
    plan = plan || { destination: '', startDate: '', days: null, travelers: null, budget: null, origin: '', originAsked: false, asked: '' };
    absorb(plan, text);
    var issue = problem(plan);
    var question = nextQuestion(plan);
    if (issue || question) {
      plan.asked = question ? question.key : plan.asked;
      save(email, plan);
      return { reply: issue || question.text };
    }
    var start = fromIso(plan.startDate);
    var end = addDays(start, plan.days - 1);
    if (!handoff(email, plan)) return { reply: 'I couldn’t open the planner right now. Please use the Itinerary tab.' };
    var when = plan.days === 1 ? fmt(start) : fmt(start) + ' – ' + fmt(end);
    return {
      reply: 'Got it: **' + plan.destination + '**, ' + when + ' (' + plan.days + ' day' + (plan.days === 1 ? '' : 's') + '), '
        + plan.travelers + ' traveler' + (plan.travelers === 1 ? '' : 's') + ', ' + peso(plan.budget) + ' total'
        + (plan.origin ? ', starting from ' + plan.origin : '') + '.\n\nOpening the planner so you can choose your trip style and hotel…',
      openPlanner: true,
    };
  }

  window.SidekickChatPlanner = { handle: handle, isActive: function (email) { return Boolean(load(email)); } };
})();
