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
    // A year: "next year", "this year", or written out ("Nov 7, 2027"). A month on its own
    // ("March next year", "in December") starts on the 1st of that month.
    var nextYear = /\bnext\s+year\b/.test(lower);
    var thisYear = /\bthis\s+year\b/.test(lower);
    var yearMatch = lower.match(/\b(20\d{2})\b/);
    var year = yearMatch ? Number(yearMatch[1]) : nextYear ? today().getFullYear() + 1 : thisYear ? today().getFullYear() : null;
    if (!result.start && (year || /\b(in|on|this|next|by)\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/.test(lower))) {
      var monthOnly = lower.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/);
      if (monthOnly) result.start = monthDay(MONTHS.indexOf(monthOnly[1]), 1) || null;
    }
    if (year && result.start) {
      var setYear = function (date) { return date ? new Date(year, date.getMonth(), date.getDate()) : date; };
      result.start = setYear(result.start);
      result.end = setYear(result.end);
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
    // A date written right after the place ("Anilao Dec 20") is not part of its name.
    name = name.replace(/\s+(?:on|in|this|next|from)?\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?$/i, '')
      .replace(/\s+(?:this|next)\s+(?:year|month|week|weekend)$/i, '').trim();
    if (/^(me|us|my|our|a|an|the|go|travel|trip|myself|ourselves|everyone|you)\b/i.test(name)) return '';
    // "a trip for tomorrow" / "this weekend": a date, not a place.
    if (name && (parseDates(name) || /^(tomorrow|today|tonight|weekend|later|soon|anywhere|somewhere)$/i.test(name)
      || /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?$/i.test(name))) return '';
    return name;
  }

  function parseOrigin(text) {
    var m = String(text || '').match(/\bfrom\s+([A-Za-zÑñ][A-Za-zÑñ .,'-]{1,60}?)(?=\s+(?:to|for|on|with|this|next)\b|[.!?]|$)/i);
    return m ? m[1].trim().replace(/[,.]$/, '') : '';
  }

  // ---- Conversation ----------------------------------------------------------------------
  function wantsTripPlan(text) {
    var lower = String(text || '').toLowerCase();
    // About a trip the traveler already has ("day 1 in my itinerary"): for the assistant.
    if (/\b(my|the|our|this|current|saved)\s+(itinerary|trip|plan)\b|\bday\s*\d+\b/.test(lower)) return false;
    return /\b(plan|build|make|create|generate|prepare)\b[^.?!]{0,40}\b(trip|itinerary|itineraries|vacation|getaway|outing|travel plan|tour)\b/.test(lower)
      || /\bitinerary (for|to|in)\b/.test(lower)
      || /\b(plan|schedule) (my|our|a|an) (day|weekend)\b/.test(lower);
  }
  // A direct request to open the planner screen ("open the planner", "take me to the itinerary
  // builder"). Strict on purpose: questions about it ("how do I open the planner?"), "don't",
  // and messages that only mention the planner stay with the normal chat.
  function wantsOpenPlanner(text) {
    var lower = String(text || '').toLowerCase().replace(/[.!?\s]+$/, '').replace(/\s+/g, ' ').trim();
    if (!lower || lower.length > 80) return false;
    if (/\b(don'?t|do not|never|not|how|why|what|where|when|which|who|later|is|does)\b/.test(lower)) return false;
    return /^(?:(?:hey|hi|ok|okay|yo),? )?(?:sidekick,? )?(?:(?:please|pls|can you|could you|would you|will you|can u|i want to|i wanna|i'd like to|let me|let's|lets) )*(?:open|show|launch|go to|bring me to|take me to|bring up|pull up)(?: me)? (?:the |my |your )?(?:trip |itinerary )?(?:planner|itinerary builder|trip builder|builder|itinerary tab|itinerary page|planner tab|planner page)(?: (?:for me|please|pls|now|again|tab|page|screen|sidekick))*$/.test(lower);
  }
  function wantsStop(text) {
    return /^(cancel|stop|never ?mind|nevermind|forget it|no thanks|not now|quit)\b/i.test(String(text || '').trim());
  }

  function fmt(date) {
    return date.toLocaleDateString("en-US", { weekday: 'short', month: "long", day: 'numeric', year: "numeric" });
  }
  function peso(value) { return '₱' + Number(value).toLocaleString('en-US'); }

  // Fills the plan from the message; `asked` is the question the traveler is answering.
  // Places are only candidates here (destinationInput, originInput); verify() checks them.
  function absorb(plan, text) {
    var asked = plan.asked || '';
    var destination = parseDestination(text, asked === 'destination');
    if (destination && (asked === 'destination' || !plan.destination)) plan.destinationInput = destination;

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
    if (origin) { plan.originInput = origin; plan.originAsked = true; }
    if (asked === 'origin' && !origin) {
      var answer = String(text).trim();
      plan.originAsked = true;
      if (!/^(skip|no|none|nope|not sure|idk|wala|later|n\/a)$/i.test(answer) && answer.length <= 80) plan.originInput = answer;
    }
  }

  // ---- Checking places with Google Maps ----------------------------------------------------
  // The first suggestion for the text, null when there is none, or undefined when the search
  // itself failed (then the text is kept and the traveler checks it in the summary).
  async function lookup(input, scope) {
    try {
      var data = await core().apiRequest('/api/maps/place-suggestions', { method: 'POST', body: JSON.stringify({ input: input, scope: scope }) });
      return (data && data.suggestions && data.suggestions[0]) || null;
    } catch (error) { return undefined; }
  }
  // The suggestion is about the place typed: a meaningful word of the text appears in it.
  function matches(input, hit) {
    var target = String((hit.text || '') + ' ' + (hit.name || '')).toLowerCase();
    var all = String(input).toLowerCase().replace(/[^a-zñ0-9 ]/g, ' ').split(/\s+/).filter(function (w) { return w.length >= 3; });
    var words = all.filter(function (w) { return !/^(the|beach|resort|city|town|batangas|province|island|falls|mount|near|area|philippines)$/.test(w); });
    // "Batangas City": only common words, so all of them must appear.
    if (!words.length) return all.length > 0 && all.every(function (w) { return target.indexOf(w) >= 0; });
    return words.some(function (w) { return target.indexOf(w) >= 0; });
  }
  // A shop or landmark as the starting point (not a town): every word typed must be a whole
  // word of its name and there must be at least two, so "qwerty" or a half-typed word that
  // happens to start a business name is not taken as an address.
  function exactWords(input, hit) {
    var name = ' ' + String((hit.name || '') + ' ' + (hit.text || '')).toLowerCase().replace(/[^a-zñ0-9]+/g, ' ') + ' ';
    var words = String(input).toLowerCase().replace(/[^a-zñ0-9]+/g, ' ').trim().split(' ').filter(Boolean);
    return words.length >= 2 && words.every(function (w) { return name.indexOf(' ' + w + ' ') >= 0; });
  }
  // Checks the destination and starting address the traveler typed. Returns a question to ask
  // again when one is not found, or ''.
  async function verify(plan) {
    if (plan.destinationInput) {
      var input = plan.destinationInput;
      plan.destinationInput = '';
      var hit = await lookup(input, 'destination');
      if (hit === undefined) { plan.destination = input; plan.destinationPlaceId = ''; }
      else if (hit && matches(input, hit)) { plan.destination = hit.name || input; plan.destinationPlaceId = hit.placeId || ''; }
      else {
        plan.destination = '';
        plan.asked = 'destination';
        return 'I couldn’t find “' + input + '” in Batangas. Which town or tourist spot do you mean? For example: Nasugbu, Anilao, Laiya, or Taal.';
      }
    }
    if (plan.originInput) {
      var from = plan.originInput;
      plan.originInput = '';
      var place = await lookup(from, 'origin');
      if (place === undefined) plan.origin = from;
      else if (place && matches(from, place) && (place.kind !== 'place' || exactWords(from, place))) plan.origin = place.text || place.name || from;
      else {
        plan.origin = '';
        plan.originAsked = false;
        plan.asked = 'origin';
        return 'I couldn’t find “' + from + '”. Please type a town, city, or full address (for example, Lipa City), or say **skip**.';
      }
    }
    return '';
  }

  // ---- Confirming the details ----------------------------------------------------------------
  function isYes(text) {
    return /^(yes|y|yep|yeah|yup|oo|opo|sige|correct|confirm(ed)?|tama|ok(ay)?|go|go ahead|sure|right|that'?s right|looks good|build it|proceed)\b/i.test(String(text || '').trim());
  }
  // The assistant's last reply, when it suggested planning a trip ("say "plan a trip to Taal"…"):
  // { destination, mustSee: the places it named in bold, such as "Galleria Taal" }, or null.
  function lastTripOffer(email) {
    var messages = [];
    try { messages = (core()?.getChatByEmail?.() || {})[email] || []; } catch (error) { return null; }
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== 'ai') continue;
      var content = String(messages[i].content || '');
      var m = content.match(/plan a trip to\s+["“]?([A-Za-zÑñ][A-Za-zÑñ .'-]{1,40}?)["”]?(?=[\s"”.,!?]|$)/i);
      if (!m) return null;
      var destination = m[1].trim();
      var named = [];
      content.replace(/\*\*([^*]{2,60})\*\*/g, function (all, name) {
        name = name.trim();
        if (name.toLowerCase() !== destination.toLowerCase() && named.indexOf(name) < 0 && named.length < 3) named.push(name);
        return all;
      });
      return { destination: destination, mustSee: named };
    }
    return null;
  }
  function isQuestion(text) {
    var t = String(text || '').trim().toLowerCase();
    return /\?\s*$/.test(t) || /^(what|whats|what's|how|where|which|who|why|is|are|can|could|do|does|any|ano|saan|paano|magkano|meron|may)\b/.test(t);
  }
  function isNo(text) { return /^(no|nope|nah|hindi|wrong|mali|not quite|not right)\b/i.test(String(text || '').trim()); }
  function summary(plan) {
    var start = fromIso(plan.startDate);
    var end = addDays(start, plan.days - 1);
    var when = plan.days === 1 ? fmt(start) : fmt(start) + ' – ' + fmt(end);
    return 'Here are your trip details:\n\n'
      + '- **Destination:** ' + plan.destination + '\n'
      + '- **Dates:** ' + when + ' (' + plan.days + ' day' + (plan.days === 1 ? '' : 's') + ')\n'
      + '- **Travelers:** ' + plan.travelers + '\n'
      + '- **Budget:** ' + peso(plan.budget) + ' total\n'
      + '- **Starting from:** ' + (plan.origin || 'not set') + '\n'
      + (plan.mustSee && plan.mustSee.length ? '- **Must-see:** ' + plan.mustSee.join(', ') + '\n' : '') + '\n'
      + 'Is this correct? Reply **yes** to open the planner, or tell me what to change (for example, “budget 8000” or “change the dates”).';
  }
  // A date in the past ("yesterday", "last Saturday", "Saturday last week", "2 days ago").
  function saysPastDate(text) {
    return /\b(yesterday|kahapon|ago|last\s+(week|weekend|month|year|night|mon|tue|wed|thu|fri|sat|sun)[a-z]*|(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+last\s+(week|month))\b/i.test(String(text || ''));
  }
  // The same budget check as the Itinerary tab: is the budget enough for meals and rooms for
  // this group and these dates? Resolves to a message to show (the budget is asked again), or ''.
  async function budgetProblem(plan) {
    var start = fromIso(plan.startDate);
    if (!start || !plan.days || !plan.budget) return '';
    var data;
    try {
      data = await core().apiRequest('/api/trip/budget-check', { method: 'POST', body: JSON.stringify({
        destination: plan.destination, startDate: iso(start), endDate: iso(addDays(start, plan.days - 1)),
        budgetAmountPhp: plan.budget, travelers: plan.travelers || 1,
      }) });
    } catch (error) { return ''; } // can't check now: the Itinerary tab checks it again
    if (!data || !data.checked || data.realistic) return '';
    var who = (plan.travelers || 1) + ' traveler' + ((plan.travelers || 1) === 1 ? '' : 's');
    var length = plan.days + ' day' + (plan.days === 1 ? '' : 's');
    if (data.outOfScope) return String(data.message || 'That trip is outside what Sidekick can plan.') + ' What budget would you like to use?';
    if (data.tooHigh) return peso(plan.budget) + ' is far more than a ' + length + ' trip for ' + who + ' would use. What is your actual total budget?';
    var minimum = Number(data.minimumPhp);
    return peso(plan.budget) + ' is not enough for ' + who + ' for ' + length + ': meals' + (plan.days > 1 ? ' and rooms' : '')
      + ' alone come to at least about ' + (Number.isFinite(minimum) ? peso(Math.ceil(minimum / 100) * 100) : 'more than that')
      + '. What total budget would you like to use? (You can also say “change the dates” or a smaller group.)';
  }

  // The traveler's reply to the summary: apply what they changed, or clear the details they
  // named so they are asked again. Returns true when something changed.
  function applyCorrection(plan, text) {
    plan.asked = '';
    var before = JSON.stringify(plan);
    var lower = String(text || '').toLowerCase();
    var budget = parseBudget(text, false);
    if (budget) plan.budget = budget;
    var travelers = parseTravelers(text, false);
    if (travelers) plan.travelers = travelers;
    var dates = parseDates(text);
    if (dates) {
      if (dates.start) plan.startDate = iso(dates.start);
      if (dates.end) plan.days = Math.round((dates.end - dates.start) / 86400000) + 1;
      else if (dates.days) plan.days = dates.days;
    }
    var destination = parseDestination(text, false);
    if (destination) plan.destinationInput = destination;
    var origin = parseOrigin(text);
    if (origin) plan.originInput = origin;
    if (!destination && /\b(destination|place|where|location|spot)\b/.test(lower)) plan.destination = '';
    if (!dates && /\b(date|dates|day|days|when|schedule)\b/.test(lower)) { plan.startDate = ''; plan.days = null; }
    if (!travelers && /\b(travell?ers?|people|pax|persons?|group|companions?)\b/.test(lower)) plan.travelers = null;
    if (!budget && /\b(budget|money|cost|pesos?|php)\b|₱/.test(lower)) plan.budget = null;
    if (!origin && /\b(start|starting|address|origin|from)\b/.test(lower)) { plan.origin = ''; plan.originAsked = false; }
    return JSON.stringify(plan) !== before;
  }

  // What to say when an answer wasn't understood.
  var REASK = {
    dates: 'When is the trip? For example, “Dec 5 to 6” or “next Saturday for 2 days”.',
    days: 'How many days will you stay? Please type a number, for example “2”.',
    travelers: 'How many travelers, including you? Please type a number, for example “2” or “barkada of 4”.',
    budget: 'What is your total budget? Please type an amount in pesos, for example “5000” or “20k”.',
  };

  // The next question, or null when the plan is complete.
  function nextQuestion(plan) {
    if (!plan.destination) return { key: 'destination', text: 'Sure! Where in Batangas would you like to go?' };
    if (!plan.startDate) return { key: 'dates', text: 'When is the trip, and for how many days?' };
    if (!plan.days) return { key: 'days', text: 'How many days will you stay?' };
    if (!plan.travelers) return { key: 'travelers', text: 'How many travelers, including you?' };
    if (!plan.budget) return { key: 'budget', text: 'What is your total budget for the whole group?' };
    if (!plan.originAsked) return { key: 'origin', text: 'What is the address that you will start from?' };
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
        // The exact Google place the traveler confirmed, so the builder uses that one.
        placeId: plan.destinationPlaceId || '',
        mustSee: Array.isArray(plan.mustSee) ? plan.mustSee : [],
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

  // Handles a chat message. Resolves to { reply, openPlanner } when the planner answers it,
  // or null when the message is for the normal chat.
  // start: the chat already knows this message asks for a trip plan.
  async function handle(email, text, start) {
    var plan = load(email);
    // "Yes, let's do it" right after the assistant suggested planning a trip: start planning
    // that trip, keeping the places it was talking about as must-sees.
    if (wantsOpenPlanner(text)) return { reply: 'Sure! Opening the Itinerary planner for you…', openPlanner: true };
    var offer = !plan && isYes(text) ? lastTripOffer(email) : null;
    if (offer) { text = 'plan a trip to ' + offer.destination; start = true; }
    if (!plan && !start && !wantsTripPlan(text)) return null;
    // "No" to a planning question (not to the summary, where it means "change something").
    if (plan && (wantsStop(text) || (plan.asked && plan.asked !== 'confirm' && isNo(text)))) {
      save(email, null);
      return { reply: 'Okay, I stopped planning that trip. Ask me any time.' };
    }
    plan = plan || { destination: '', startDate: '', days: null, travelers: null, budget: null, origin: '', originAsked: false, asked: '', mustSee: offer ? offer.mustSee : [] };

    // A real question in the middle of planning ("what are good restaurants in Lipa?") that
    // answers nothing is for the assistant: let the normal chat reply and keep the details.
    var probe = JSON.parse(JSON.stringify(plan));
    if (plan.asked && isQuestion(text)) {
      // At the summary, a question never changes the details ("is it rainy in December?").
      if (plan.asked === 'confirm' || (absorb(probe, text), JSON.stringify(probe) === JSON.stringify(plan))) return null;
    }

    if (plan.asked === 'confirm') {
      // Answering the summary.
      if (isYes(text)) {
        if (!handoff(email, plan)) return { reply: 'I couldn’t open the planner right now. Please use the Itinerary tab.' };
        return { reply: 'Great! Opening the planner so you can choose your trip style and hotel…', openPlanner: true };
      }
      var changed = applyCorrection(plan, text);
      if (!changed) {
        plan.asked = 'confirm';
        save(email, plan);
        return { reply: (isNo(text) ? 'No problem. ' : '') + 'Which detail should I change: the destination, dates, travelers, budget, or starting point?' };
      }
    } else if (saysPastDate(text) && (plan.asked === 'dates' || plan.asked === 'days' || !plan.startDate)) {
      // "Yesterday", "Saturday last week": not a date that can be planned.
      plan.startDate = '';
      plan.asked = 'dates';
      save(email, plan);
      return { reply: 'That date has already passed. When is the trip? For example, “this Saturday” or “Dec 5 to 6”.' };
    } else {
      absorb(plan, text);
    }

    var notFound = await verify(plan);
    if (notFound) { save(email, plan); return { reply: notFound }; }
    // As soon as the destination, dates, group and budget are known (or change), check the
    // budget the same way as the Itinerary tab, before asking anything else.
    var budgetKey = [plan.destination, plan.startDate, plan.days, plan.travelers, plan.budget].join('|');
    if (plan.destination && plan.startDate && plan.days && plan.travelers && plan.budget && plan.budgetCheckedFor !== budgetKey) {
      var tooLow = await budgetProblem(plan);
      if (tooLow) {
        plan.budget = null;
        plan.asked = 'budget';
        save(email, plan);
        return { reply: tooLow };
      }
      plan.budgetCheckedFor = budgetKey;
    }
    var issue = problem(plan);
    var question = nextQuestion(plan);
    if (issue || question) {
      // The same question again: the answer wasn't understood, so say what is expected.
      var again = !issue && question && question.key === plan.asked && REASK[question.key];
      plan.asked = question ? question.key : plan.asked;
      save(email, plan);
      return { reply: issue || (again ? 'I didn’t quite get that. ' + REASK[question.key] : question.text) };
    }
    // Every detail is in: show them and let the traveler confirm before anything is built.
    plan.asked = 'confirm';
    save(email, plan);
    return { reply: summary(plan) };
  }

  window.SidekickChatPlanner = { handle: handle, isActive: function (email) { return Boolean(load(email)); } };
})();
