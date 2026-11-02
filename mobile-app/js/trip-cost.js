// Sidekick trip cost: the whole trip's expected cost, by category, for the itinerary's
// cost card. Every line says where its amount comes from:
// - researched: a price found online (entry fees, the chosen stay's room rate)
// - yours: an amount the traveler entered
// - estimate: worked out from stated assumptions (fuel, meals)
// - unknown: not priced; the card names it and the traveler can enter it
// The trip is only called "within budget" when nothing needed is unknown and even the
// higher estimates fit; it is "over" when even the lower estimates don't.
// The budget is the whole trip's, for all travelers (as entered in the trip form).
(function () {
  // Stated assumptions (shown with each estimate).
  const FUEL = { kmPerLiterLow: 8, kmPerLiterHigh: 14, pesoPerLiterLow: 60, pesoPerLiterHigh: 80 };
  const MEAL = { lowPhp: 150, highPhp: 350, perDay: 3 };
  const CONTINGENCY = 0.1;
  // A drive without a Google route: the road is about a third longer than a straight line.
  const ROAD_FACTOR = 1.3;
  // Drives this long to or from Batangas usually use an expressway (SLEX, STAR Tollway).
  const TOLL_LIKELY_KM = 40;

  const toNumber = (value) => (value === null || value === undefined || value === "" ? NaN : Number(value));
  const isAmount = (value) => Number.isFinite(toNumber(value)) && toNumber(value) >= 0;
  const round = (value) => Math.round(value);

  function haversineKm(a, b) {
    if (!a || !b || !Number.isFinite(Number(a.lat)) || !Number.isFinite(Number(b.lat))) return NaN;
    const r = (deg) => (deg * Math.PI) / 180;
    const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
    return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  const isBoatStop = (activity) => activity?.routeSource === "boat-estimate" || /reached by boat/i.test(String(activity?.routeStatus || ""));

  // activityCosts: Map placeId -> { lowPhp, highPhp } per person (the entry-fee research).
  // activityBudget: that research's summary (null while it hasn't run or has failed).
  function breakdown({ meta = {}, itinerary = [], activityBudget = null, activityCosts = new Map(), priceKey = (activity) => String(activity?.placeId || "") } = {}) {
    const days = Math.max(1, Array.isArray(itinerary) ? itinerary.length : 1);
    const nights = days - 1;
    const travelers = Math.min(10, Math.max(1, Math.round(Number(meta.travelers)) || 1));
    const rooms = Math.max(1, Math.round(Number(meta.rooms)) || Math.ceil(travelers / 2));
    const transport = ["car", "commute", "unsure"].includes(meta.tripStyle?.transport) ? meta.tripStyle.transport : "unsure";
    const inputs = meta.costInputs && typeof meta.costInputs === "object" ? meta.costInputs : {};
    const activities = (Array.isArray(itinerary) ? itinerary : []).flatMap((day) => day?.activities || []);
    const items = [];
    // A line; an amount the traveler entered for it replaces the app's figure.
    const add = (item) => {
      if (isAmount(inputs[item.key]) && item.basis !== "not-needed") {
        const amount = round(toNumber(inputs[item.key]));
        items.push({ ...item, lowPhp: amount, highPhp: amount, basis: "yours", note: "The amount you entered." , editable: true });
        return;
      }
      items.push(item);
    };

    // ---- Room ------------------------------------------------------------------
    const stay = meta.stay || {};
    if (!nights) {
      items.push({ key: "lodging", label: "Place to stay", basis: "not-needed", lowPhp: 0, highPhp: 0, shared: true, note: "A day trip: no night's stay." });
    } else if (isAmount(stay.nightlyLowPhp) && toNumber(stay.nightlyLowPhp) > 0) {
      const low = toNumber(stay.nightlyLowPhp);
      const high = isAmount(stay.nightlyHighPhp) && toNumber(stay.nightlyHighPhp) >= low ? toNumber(stay.nightlyHighPhp) : low;
      add({
        key: "lodging", label: `Stay${stay.name ? ` at ${stay.name}` : ""}`, basis: "researched", shared: true, editable: true,
        lowPhp: round(low * nights * rooms), highPhp: round(high * nights * rooms),
        note: `${nights} night${nights === 1 ? "" : "s"} × ${rooms} room${rooms === 1 ? "" : "s"} (two people a room). ${stay.priceCheckedOn ? `Rate checked on ${stay.priceCheckedOn}.` : "Rate from a web search, not checked on the hotel’s page."}`,
      });
    } else {
      add({
        key: "lodging", label: `Stay${stay.name ? ` at ${stay.name}` : ""}`, basis: "unknown", shared: true, editable: true,
        note: `${nights} night${nights === 1 ? "" : "s"} × ${rooms} room${rooms === 1 ? "" : "s"}: no room rate found. Enter what you’ll pay.`,
      });
    }

    // ---- Meals (per person) -------------------------------------------------------
    const meals = MEAL.perDay * days * travelers;
    add({
      key: "meals", label: "Meals", basis: "estimate", shared: false, editable: true,
      lowPhp: MEAL.lowPhp * meals, highPhp: MEAL.highPhp * meals,
      note: `${MEAL.perDay} meals a day × ${days} day${days === 1 ? "" : "s"} × ${travelers} traveler${travelers === 1 ? "" : "s"}, assuming ₱${MEAL.lowPhp}–₱${MEAL.highPhp} a meal (local eateries to resort restaurants). Meals included in your stay or a tour lower this.`,
    });

    // ---- Entry fees (per person) --------------------------------------------------------
    const pricedStops = [];
    const unpricedStops = [];
    activities.forEach((activity) => {
      const cost = activityCosts.get(priceKey(activity));
      if (cost && Number.isFinite(cost.lowPhp) && Number.isFinite(cost.highPhp)) pricedStops.push({ activity, cost });
      else unpricedStops.push(activity);
    });
    if (!activityBudget) {
      add({ key: "entry", label: "Entry fees", basis: "unknown", shared: false, editable: true, note: "Entry fees haven’t been looked up yet." });
    } else {
      if (pricedStops.length) {
        const low = pricedStops.reduce((sum, item) => sum + item.cost.lowPhp, 0) * travelers;
        const high = pricedStops.reduce((sum, item) => sum + item.cost.highPhp, 0) * travelers;
        add({
          key: "entry", label: "Entry fees", basis: "researched", shared: false, editable: true, lowPhp: round(low), highPhp: round(high),
          note: `${pricedStops.length} of ${activities.length} stops, × ${travelers} traveler${travelers === 1 ? "" : "s"}. Prices found online; they may change.`,
        });
      }
      if (unpricedStops.length) {
        const names = unpricedStops.map((activity) => String(activity.title || "a stop")).slice(0, 4).join(", ");
        add({
          key: "entry-missing", label: `Entry fees not found (${unpricedStops.length} stop${unpricedStops.length === 1 ? "" : "s"})`, basis: "unknown", shared: false, editable: true,
          note: `${names}${unpricedStops.length > 4 ? ", …" : ""}: no price found. Some may be free; check before you go.`,
        });
      }
    }

    // ---- Boat transfers --------------------------------------------------------------
    // An island stop's boat is only listed when the stop has no price of its own (an
    // island-hopping price usually includes the boat, so it isn't counted twice).
    const boatStops = activities.filter((activity) => isBoatStop(activity) && !pricedStops.some((item) => item.activity === activity));
    if (boatStops.length) {
      add({
        key: "boat", label: "Boat transfers", basis: "unknown", shared: true, editable: true,
        note: `${boatStops.map((activity) => String(activity.title || "an island")).slice(0, 3).join(", ")} ${boatStops.length === 1 ? "is" : "are"} reached by boat: no verified fare. Ask at the port.`,
      });
    }

    // ---- Getting there and around ------------------------------------------------------
    const legs = Array.isArray(meta.tripLegs) ? meta.tripLegs : [];
    const longLeg = legs.some((leg) => (Number(leg.km) || Number(leg.straightKm) * ROAD_FACTOR || 0) >= TOLL_LIKELY_KM);
    if (transport === "car") {
      // Road distances: Google's where known, otherwise the straight line × 1.3.
      let googleKm = 0;
      let approxKm = 0;
      legs.filter((leg) => leg.source !== "boat-estimate").forEach((leg) => {
        if (Number.isFinite(Number(leg.km)) && leg.km !== null) googleKm += Number(leg.km);
        else if (Number.isFinite(Number(leg.straightKm))) approxKm += Number(leg.straightKm) * ROAD_FACTOR;
      });
      (Array.isArray(itinerary) ? itinerary : []).forEach((day) => (day?.activities || []).forEach((activity, index, list) => {
        if (!index || isBoatStop(activity)) return;
        if (Number.isFinite(activity.travelDistanceKm) && activity.travelDistanceKm !== null) googleKm += activity.travelDistanceKm;
        else {
          const straight = haversineKm(list[index - 1].locationCoords, activity.locationCoords);
          if (Number.isFinite(straight)) approxKm += straight * ROAD_FACTOR;
        }
      }));
      // Each evening's drive back to the stay (not a measured leg): approximated.
      const stayPoint = Number.isFinite(Number(stay.lat)) && Number.isFinite(Number(stay.lng)) && stay.lat !== null ? { lat: Number(stay.lat), lng: Number(stay.lng) } : null;
      (Array.isArray(itinerary) ? itinerary : []).slice(0, -1).forEach((day, dayIndex) => {
        // (Measured already when the trip has that evening's route.)
        if (legs.some((leg) => leg.kind === "return" && leg.day === dayIndex + 1)) return;
        const last = (day?.activities || []).slice(-1)[0];
        const straight = stayPoint && last && !isBoatStop(last) ? haversineKm(last.locationCoords, stayPoint) : NaN;
        if (Number.isFinite(straight)) approxKm += straight * ROAD_FACTOR;
      });
      const km = googleKm + approxKm;
      const hasJourney = legs.some((leg) => leg.kind === "start" && leg.day === 1);
      add({
        key: "fuel", label: "Fuel", basis: "estimate", shared: true, editable: true,
        lowPhp: round((km / FUEL.kmPerLiterHigh) * FUEL.pesoPerLiterLow), highPhp: round((km / FUEL.kmPerLiterLow) * FUEL.pesoPerLiterHigh),
        note: `About ${round(km)} km of driving${approxKm > 0 ? ` (${round(approxKm)} km of it approximated, without a Google route)` : ""}, assuming ${FUEL.kmPerLiterLow}–${FUEL.kmPerLiterHigh} km a liter and ₱${FUEL.pesoPerLiterLow}–₱${FUEL.pesoPerLiterHigh} a liter. Check current pump prices.${hasJourney ? "" : " The drive to and from the destination isn’t included: no starting point was given."}`,
      });
      if (!hasJourney) {
        add({ key: "journey", label: "Fuel to and from the destination", basis: "unknown", shared: true, editable: true, note: "No starting point was given, so the drive there and back can’t be measured." });
      }
      if (longLeg) {
        add({ key: "tolls", label: "Tolls", basis: "unknown", shared: true, editable: true, note: "Long drives to and from Batangas usually use the SLEX or STAR Tollway. Toll fares aren’t looked up; enter yours." });
      }
    } else if (transport === "commute") {
      add({ key: "fares", label: "Bus or van fares there and back", basis: "unknown", shared: false, editable: true, note: `No verified fares. Per person, × ${travelers}.` });
      add({ key: "local-rides", label: "Rides between stops", basis: "unknown", shared: false, editable: true, note: "Tricycle, jeepney or hired-van fares aren’t looked up." });
    } else {
      add({ key: "travel", label: "Getting there and around", basis: "unknown", shared: true, editable: true, note: "Not priced: choose how you’re traveling (own car, or bus/van) next time you build, or enter an amount." });
    }

    // ---- Totals ----------------------------------------------------------------------
    const known = items.filter((item) => item.basis !== "unknown" && item.basis !== "not-needed");
    const unknown = items.filter((item) => item.basis === "unknown");
    const subtotalLowPhp = known.reduce((sum, item) => sum + item.lowPhp, 0);
    const subtotalHighPhp = known.reduce((sum, item) => sum + item.highPhp, 0);
    const contingencyLowPhp = round(subtotalLowPhp * CONTINGENCY);
    const contingencyHighPhp = round(subtotalHighPhp * CONTINGENCY);
    const totalLowPhp = subtotalLowPhp + contingencyLowPhp;
    const totalHighPhp = subtotalHighPhp + contingencyHighPhp;
    const budgetPhp = Number(meta.budgetAmountPhp) > 0 ? Number(meta.budgetAmountPhp) : null;
    let status;
    let reason = "";
    if (!budgetPhp) status = "no-budget";
    else if (totalLowPhp > budgetPhp) status = "over";
    else if (unknown.length) { status = "uncertain"; reason = "unknown"; }
    else if (totalHighPhp <= budgetPhp) status = "within";
    else { status = "uncertain"; reason = "range"; }

    // What to change first when it's over (or may be): the biggest costs the traveler can
    // choose differently. Meals and fuel stay; the stay and the priciest stops come first.
    const suggestions = [];
    if (status === "over" || reason === "range") {
      const lodging = known.find((item) => item.key === "lodging");
      const priciest = pricedStops.slice().sort((a, b) => b.cost.highPhp - a.cost.highPhp).filter((item) => item.cost.lowPhp > 0).slice(0, 2);
      const options = [];
      if (lodging && lodging.lowPhp > 0) options.push({ amount: lodging.lowPhp, text: `Choose a cheaper place to stay (the room is about ₱${lodging.lowPhp.toLocaleString()} of the total).` });
      priciest.forEach((item) => options.push({
        amount: item.cost.lowPhp * travelers,
        text: `Swap “${String(item.activity.title || "a stop")}” for a free or cheaper stop (₱${round(item.cost.lowPhp * travelers).toLocaleString()}${item.cost.highPhp > item.cost.lowPhp ? `–₱${round(item.cost.highPhp * travelers).toLocaleString()}` : ""} for your group).`,
      }));
      options.sort((a, b) => b.amount - a.amount).slice(0, 3).forEach((option) => suggestions.push(option.text));
    }

    return {
      budgetPhp, days, nights, travelers, rooms, transport, items, unknown,
      subtotalLowPhp, subtotalHighPhp, contingencyLowPhp, contingencyHighPhp, totalLowPhp, totalHighPhp,
      perTravelerLowPhp: round(totalLowPhp / travelers), perTravelerHighPhp: round(totalHighPhp / travelers),
      status, reason,
      remainingPhp: status === "within" ? budgetPhp - totalHighPhp : null,
      overrunPhp: status === "over" ? totalLowPhp - budgetPhp : null,
      suggestions,
      assumptions: { fuel: FUEL, meal: MEAL, contingency: CONTINGENCY, roadFactor: ROAD_FACTOR },
    };
  }

  // ---- What to confirm before a stop ----------------------------------------------
  // Each note names something the app couldn't check and what it could change. Places that
  // usually have no published hours (beaches, viewpoints, parks) aren't flagged for hours.
  const HOURS_NAME = /\b(museum|gallery|theme park|water ?park|amusement|zoo|aquarium|spa|restaurant|resto|cafe|café|coffee|eatery|grill|bistro|kitchen|bakery|pasalubong|souvenir|shop|store|market|bar|pub|club|winery|farm tour)\b/i;
  const BOOKING_NAME = /\b(island[- ]hopping|boat tour|dive|diving|scuba|snorkel\w*|kayak\w*|zipline|tour|day tour|day use|spa|massage|workshop|class)\b/i;
  const HOURS_STALE_DAYS = 120;

  // activity: a saved stop. context: { tripHasHours (built when hours were saved with
  // stops), entryResearched (entry fees were looked up), entryPriced (this stop has a
  // price), transport, now }. Returns [{ kind, text }].
  function stopChecks(activity, context = {}) {
    const checks = [];
    const text = `${activity?.title || ""} ${activity?.category || ""}`;
    const hours = Array.isArray(activity?.openPeriods) && activity.openPeriods.length;
    if (HOURS_NAME.test(text)) {
      if (!hours) {
        checks.push({
          kind: "hours",
          text: context.tripHasHours
            ? "Opening hours aren’t listed on Google. Check it’s open before you go."
            : "Opening hours weren’t saved with this trip. Check it’s open before you go.",
        });
      } else if (activity.hoursCheckedAt) {
        const age = ((context.now ?? Date.now()) - Date.parse(activity.hoursCheckedAt)) / 86400000;
        if (age > HOURS_STALE_DAYS) {
          checks.push({ kind: "hours", text: `Opening hours were checked on ${new Date(activity.hoursCheckedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}. Check they haven’t changed.` });
        }
      }
    }
    if (isBoatStop(activity)) {
      checks.push({ kind: "boat", text: "Reached by boat. No verified boat schedule or fare: confirm departure and return times at the port. The time shown is an estimate." });
    } else if (activity?.routeSource === "estimate" || activity?.routeSource === "unavailable") {
      checks.push({ kind: "route", text: "No Google route from the last stop. The travel time is an estimate; check directions before you leave." });
    }
    if (BOOKING_NAME.test(text)) {
      checks.push({ kind: "booking", text: "May need a booking. Confirm with the operator; Sidekick hasn’t booked anything." });
    }
    if (context.entryResearched && !context.entryPriced) {
      checks.push({ kind: "price", text: "No entry fee found. Some places charge at the gate; it isn’t counted as free." });
    }
    return checks;
  }

  // Travel time for someone commuting (bus, van, jeepney, tricycle): the same rule the
  // planner uses. An estimate from the car time, not a timetable.
  const commuteMinutes = (carMinutes) => Math.round(Number(carMinutes) * 1.5) + 10;

  window.SidekickTripCost = { breakdown, stopChecks, commuteMinutes };
})();
