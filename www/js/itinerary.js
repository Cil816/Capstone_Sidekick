// Google Maps selected place storage
let _selectedPlace = null;


  // Remove All button handler (inside DOMContentLoaded so `email` is available)
  const removeAllBtn = document.getElementById('remove-all-itinerary');
  if (removeAllBtn) {
    removeAllBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!confirm('Remove your entire itinerary? This cannot be undone.')) return;
      try {
        const map = window.SidekickCore.getItineraryByEmail();
        delete map[email];
        window.SidekickCore.setItineraryByEmail(map);
        // also remove itinerary-derived reminders for this email
        try {
          const rem = window.SidekickCore.getRemindersFor(email) || [];
          const kept = rem.filter(r => !(r.type === 'Itinerary' || typeof r.parentDueAt !== 'undefined'));
          window.SidekickCore && window.SidekickCore.addReminderFor; // noop to avoid linter
          // overwrite reminders storage directly via internal setter
          const all = JSON.parse(localStorage.getItem('sidekick.remindersByEmail.v1') || '{}');
          all[email] = kept;
          localStorage.setItem('sidekick.remindersByEmail.v1', JSON.stringify(all));
          document.dispatchEvent(new CustomEvent('sidekick:reminders-updated', { detail: { email } }));
        } catch (err2) {}
      } catch (err) {}
      // update UI to show builder and empty state
      const container = document.getElementById('itinerary-content');
      if (container) {
        container.innerHTML = `<div id="no-itinerary-message" style="padding:24px;color:#6B7280">You don't have an itinerary yet. Use the builder above to create one.</div><button class="add-activity-btn" id="add-activity-btn" type="button" style="display:none">+ Add Activity</button>`;
      }
      showBuilder(true);
    });
  }


// Called by Google Maps callback or invoked if google.maps already present
window.initMap = function(){
  try{
    const mapEl = document.getElementById('map');
    if (!mapEl) return;
    const center = { lat: 14.5995, lng: 120.9842 };
    const map = new google.maps.Map(mapEl, { center, zoom: 6, disableDefaultUI: true });
    const input = document.getElementById('place-search');
    if (!input) return;
    const autocomplete = new google.maps.places.Autocomplete(input, { fields: ['name','geometry','formatted_address'] });
    const marker = new google.maps.Marker({ map });
    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      if (!place || !place.geometry) return;
      const loc = place.geometry.location;
      _selectedPlace = {
        name: place.name || input.value,
        address: place.formatted_address || '',
        lat: loc.lat(),
        lng: loc.lng()
      };
      marker.setPosition(loc);
      map.setCenter(loc);
      map.setZoom(13);
      document.dispatchEvent(new CustomEvent('sidekick:selected-place', { detail: _selectedPlace }));
    });
  }catch(e){
    console.warn('initMap error', e);
  }
};

// initialize maps if script already loaded
setTimeout(initMapIfAvailable, 300);
function svgClock() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="10"></circle>
      <polyline points="12 6 12 12 16 14"></polyline>
    </svg>
  `;
}

function svgPin() {
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
      <circle cx="12" cy="10" r="3"></circle>
    </svg>
  `;
}

function renderActivity(activity) {
  const timeText = activity?.dueAt ? new Date(Number(activity.dueAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : window.SidekickCore.escapeHtml(activity.timeLabel || '');
  const hasRouteMeta = typeof activity?.travelMinutes === 'number' || typeof activity?.estimatedTotalCostPhp === 'number';
  const mode = window.SidekickCore.escapeHtml(activity?.transportMode || 'Suggested transport');
  const distance = typeof activity?.travelDistanceKm === 'number' ? `${Math.round(activity.travelDistanceKm)} km` : 'distance n/a';
  const mins = typeof activity?.travelMinutes === 'number' ? `${Math.round(activity.travelMinutes)} min` : 'time n/a';
  const cost = typeof activity?.estimatedTotalCostPhp === 'number' ? `PHP ${Number(activity.estimatedTotalCostPhp).toLocaleString()}` : 'cost n/a';
  return `
    <div class="activity-card">
      <div class="activity-time">
        ${svgClock()}
        <span>${timeText}</span>
      </div>
      <h3>${window.SidekickCore.escapeHtml(activity.title)}</h3>
      <div class="activity-location">
        ${svgPin()}
        <span>${window.SidekickCore.escapeHtml(activity.location)}</span>
      </div>
      ${hasRouteMeta ? `<div class="activity-route-meta">${mode} • ${distance} • ${mins} • ~${cost}</div>` : ''}
      ${activity.note ? `<div class="activity-note">${window.SidekickCore.escapeHtml(activity.note)}</div>` : ""}
    </div>
  `;
}

function lookupPlaceByActivity(activity) {
  if (!activity) return null;
  if (activity.locationCoords && typeof activity.locationCoords.lat === 'number' && typeof activity.locationCoords.lng === 'number') {
    return { lat: activity.locationCoords.lat, lng: activity.locationCoords.lng };
  }
  const name = String(activity.location || '').split(',')[0].trim().toLowerCase();
  if (!name) return null;
  const places = window.SidekickCore?.PLACES || [];
  const match = places.find((p) => String(p.name || '').toLowerCase() === name);
  if (!match || typeof match.lat !== 'number' || typeof match.lng !== 'number') return null;
  return { lat: match.lat, lng: match.lng };
}

function modeFromDistanceKm(km) {
  if (km <= 8) return 'Walk / Tricycle';
  if (km <= 35) return 'Jeepney / Grab';
  if (km <= 180) return 'Bus / Van';
  if (km <= 480) return 'Bus + Ferry';
  return 'Flight + Local Transfer';
}

function transportCostFromDistanceKm(km) {
  if (km <= 8) return 80;
  if (km <= 35) return Math.round(90 + km * 25);
  if (km <= 180) return Math.round(120 + km * 4.8);
  if (km <= 480) return Math.round(350 + km * 3.9);
  return Math.round(1800 + km * 5.2);
}

async function fetchRouteFromOSRM(fromCoord, toCoord) {
  if (!fromCoord || !toCoord) return null;
  const url = `https://router.project-osrm.org/route/v1/driving/${fromCoord.lng},${fromCoord.lat};${toCoord.lng},${toCoord.lat}?overview=false`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const route = data?.routes?.[0];
  if (!route) return null;
  return {
    distanceKm: route.distance / 1000,
    minutes: route.duration / 60,
  };
}

async function enrichItineraryWithLiveRoutes(itineraryData, email) {
  if (!itineraryData?.itinerary?.length) return;
  let changed = false;

  for (const day of itineraryData.itinerary) {
    const activities = day.activities || [];
    let dayTotal = 0;

    for (let i = 0; i < activities.length; i++) {
      const current = activities[i];
      const prev = i > 0 ? activities[i - 1] : null;
      const fromCoord = lookupPlaceByActivity(prev);
      const toCoord = lookupPlaceByActivity(current);

      if (prev && fromCoord && toCoord) {
        try {
          const route = await fetchRouteFromOSRM(fromCoord, toCoord);
          if (route) {
            const km = Math.max(1, Math.round(route.distanceKm));
            const mins = Math.max(5, Math.round(route.minutes));
            const mode = modeFromDistanceKm(km);
            const transportCost = transportCostFromDistanceKm(km);
            const activityCost = Number(current.estimatedActivityCostPhp || 0);
            current.travelDistanceKm = km;
            current.travelMinutes = mins;
            current.transportMode = mode;
            current.estimatedTransportCostPhp = transportCost;
            current.estimatedTotalCostPhp = transportCost + activityCost;
            changed = true;
          }
        } catch (e) {
          // ignore single-route failures and keep generated estimates
        }
      }

      dayTotal += Number(current.estimatedTotalCostPhp || 0);
    }

    if (dayTotal > 0) {
      day.estimatedDayCostPhp = dayTotal;
      day.estimatedDayCostLowPhp = Math.round(dayTotal * 0.9);
      day.estimatedDayCostHighPhp = Math.round(dayTotal * 1.15);
      changed = true;
    }
  }

  if (changed) {
    setItineraryForEmail(email, itineraryData);
    renderItinerary(itineraryData.itinerary);
  }
}

function renderItinerary(itinerary) {
  const container = document.getElementById("itinerary-content");
  if (!container) return;

  container.innerHTML = "";

  for (const day of itinerary) {
    const activitiesHtml = (day.activities || []).map(renderActivity).join("");

    const dayHtml = `
      <div class="day-section">
        <div class="day-header">
          <div class="day-number">${day.dayNumber}</div>
          <div class="day-info">
            <h2>Day ${day.dayNumber}</h2>
            <p>${window.SidekickCore.escapeHtml(day.dateLabel)}</p>
            ${typeof day.estimatedDayCostPhp === 'number' ? `<p style="font-size:12px;color:#0f766e;margin-top:4px;">Estimated daily budget: PHP ${Number(day.estimatedDayCostLowPhp || day.estimatedDayCostPhp).toLocaleString()} - PHP ${Number(day.estimatedDayCostHighPhp || day.estimatedDayCostPhp).toLocaleString()}</p>` : ''}
          </div>
        </div>
        <div class="activities-list">
          ${activitiesHtml}
        </div>
      </div>
    `;

    container.insertAdjacentHTML("beforeend", dayHtml);
  }

  // Animate after layout is updated.
  [...container.querySelectorAll(".day-section")].forEach((el, idx) => {
    el.style.animation = "cardIn 460ms ease both";
    el.style.animationDelay = `${idx * 40}ms`;
  });
}

function getItineraryForEmail(email) {
  const map = window.SidekickCore.getItineraryByEmail();
  return map[email] ?? null;
}

function setItineraryForEmail(email, itineraryData) {
  const map = window.SidekickCore.getItineraryByEmail();
  map[email] = itineraryData;
  window.SidekickCore.setItineraryByEmail(map);
}

function updateHeaderDate(prefs, itineraryData) {
  const dateEl = document.getElementById("itinerary-date");
  if (!dateEl) return;

  const startDate = new Date(itineraryData?.meta?.startDate || Date.now());
  const dayCount = Math.max(1, Number(itineraryData?.itinerary?.length || 1));
  const range = window.SidekickCore.formatDateRange(startDate, dayCount);
  const extra = dayCount === 1 ? "Day" : "Days";
  dateEl.textContent = `${range} • ${dayCount} ${extra}`;
}

function attachAddActivityHandler(itineraryData, prefs, email, startDate) {
  const addBtn = document.getElementById("add-activity-btn");
  if (!addBtn) return;

  addBtn.addEventListener("click", () => {
    const dayStr = window.prompt("Add activity for which day? (1-3)", "1");
    const dayNumber = Math.max(1, Math.min(3, Number(dayStr || 1)));
    const title = String(window.prompt("Activity title", "New experience") || "").trim();
    const location = String(window.prompt("Where is it?", "Near your travel area") || "").trim();
    if (!title || !location) return;

    const dayIdx = dayNumber - 1;
    if (!itineraryData.itinerary?.[dayIdx]) return;

    // Put it into the next available slot label.
    const nextTime = ["Morning", "Afternoon", "Evening", "Night"][itineraryData.itinerary[dayIdx].activities.length % 4];

    // Ask user for specific time (optional) in HH:MM 24h format, otherwise derive from slot
    const timeInput = String(window.prompt("Time (HH:MM) optional — leave empty to use slot time:", "")).trim();
    const timeMap = { Morning: 9, Afternoon: 14, Evening: 18, Night: 21 };
    const dayDate = new Date(startDate);
    dayDate.setDate(dayDate.getDate() + dayIdx);
    let dueAt = null;
    if (timeInput && /^\d{1,2}:\d{2}$/.test(timeInput)) {
      const [hh, mm] = timeInput.split(":").map((v) => Number(v));
      dayDate.setHours(hh % 24, Math.min(59, Math.max(0, mm)), 0, 0);
      dueAt = dayDate.getTime();
    } else {
      const hour = timeMap[nextTime] ?? 12;
      dayDate.setHours(hour, 0, 0, 0);
      dueAt = dayDate.getTime();
    }

    const activityObj = {
      timeLabel: nextTime,
      title,
      location,
      note: "",
      dueAt,
      iso: new Date(dueAt).toISOString(),
    };
    // Offer to attach coordinates from selected place (if available)
    try{
      if (typeof _selectedPlace === 'object' && _selectedPlace) {
        const attach = confirm('Attach coordinates from the selected place to this activity?');
        if (attach) {
          activityObj.location = _selectedPlace.name || activityObj.location;
          activityObj.locationCoords = { lat: _selectedPlace.lat, lng: _selectedPlace.lng };
          activityObj.locationAddress = _selectedPlace.address || '';
        }
      }
    }catch(e){}

    itineraryData.itinerary[dayIdx].activities.push(activityObj);

    setItineraryForEmail(email, itineraryData);
    updateHeaderDate(prefs, itineraryData);
    renderItinerary(itineraryData.itinerary);
    try {
      if (window.SidekickCore && window.SidekickCore.syncRemindersFromItinerary) {
        window.SidekickCore.syncRemindersFromItinerary(email);
        if (window.SidekickCore.scheduleAllFor) window.SidekickCore.scheduleAllFor(email);
      }
    } catch (e) {}
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const session = window.SidekickCore.requireAuth();
  if (!session?.email) return;

  const prefs = window.SidekickCore.requirePreferences();
  if (!prefs) return;

  const email = session.email;
  const existing = getItineraryForEmail(email);
  const builderEl = document.getElementById('itinerary-builder');
  const preferredPlacesEl = document.getElementById('preferred-places');
  const startInput = document.getElementById('itinerary-start');
  const budgetSelect = document.getElementById('itinerary-budget');
  const buildBtn = document.getElementById('build-itinerary');
  const showBuilderBtn = document.getElementById('show-builder');

  function populatePlaces() {
    try {
      const places = window.SidekickCore?.PLACES || [];
      preferredPlacesEl.innerHTML = '';
      places.forEach((p) => {
        const id = `place-${p.name.replace(/[^a-z0-9]/gi, '')}`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chip';
        btn.textContent = `${p.name} — ${p.region}`;
        btn.dataset.place = p.name;
        btn.onclick = () => btn.classList.toggle('selected');
        preferredPlacesEl.appendChild(btn);
      });
    } catch (e) {}
  }

  function showBuilder(show = true) {
    if (!builderEl) return;
    builderEl.style.display = show ? 'block' : 'none';
  }

  // If user already has an itinerary, show it; otherwise show the builder so user opts in.
  if (existing?.itinerary) {
    const startDate = existing?.meta?.startDate ? new Date(existing.meta.startDate) : new Date();
    updateHeaderDate(prefs, existing);
    renderItinerary(existing.itinerary);
    enrichItineraryWithLiveRoutes(existing, email);
    // show add activity button for existing itineraries
    const addBtn = document.getElementById('add-activity-btn');
    if (addBtn) addBtn.style.display = 'block';
    attachAddActivityHandler(existing, prefs, email, startDate);
    showBuilder(false);
  } else {
    // show builder UI so user explicitly builds the itinerary
    populatePlaces();
    // prefill start date to today
    const today = new Date();
    if (startInput) startInput.value = today.toISOString().slice(0,10);
    if (budgetSelect) budgetSelect.value = prefs?.budget || 'Mid-Range';
    showBuilder(true);

    if (showBuilderBtn) {
      showBuilderBtn.addEventListener('click', () => showBuilder(true));
    }

    if (buildBtn) {
      buildBtn.addEventListener('click', (e) => {
        e.preventDefault();
        const selected = Array.from(preferredPlacesEl.querySelectorAll('.chip.selected')).map((b) => b.dataset.place);
        const startVal = startInput?.value ? new Date(startInput.value) : new Date();
        const budgetVal = budgetSelect?.value || prefs?.budget || 'Mid-Range';

        // merge into a temporary prefs object for itinerary generation
        const tempPrefs = Object.assign({}, prefs, { preferredPlaces: selected, budget: budgetVal });

        // Confirm with user before building
        const summary = `Build itinerary starting ${startVal.toDateString()}\nBudget: ${budgetVal}\nPreferred places: ${selected.length ? selected.join(', ') : 'None'}\n\nProceed?`;
        if (!window.confirm(summary)) return;

        const generated = window.SidekickCore.generateItinerary(tempPrefs, { startDate: startVal });
        const itineraryData = { itinerary: generated.itinerary, meta: { ...generated.meta, startDate: startVal.toISOString() } };

        setItineraryForEmail(email, itineraryData);
        updateHeaderDate(tempPrefs, itineraryData);
        renderItinerary(itineraryData.itinerary);
        enrichItineraryWithLiveRoutes(itineraryData, email);
        // show add activity button and attach handler
        const addBtn = document.getElementById('add-activity-btn');
        if (addBtn) addBtn.style.display = 'block';
        attachAddActivityHandler(itineraryData, tempPrefs, email, startVal);
        // hide builder after building
        showBuilder(false);
        // sync reminders and schedule
        try { if (window.SidekickCore?.syncRemindersFromItinerary) window.SidekickCore.syncRemindersFromItinerary(email); } catch (e) {}
        try { if (window.SidekickCore?.scheduleAllFor) window.SidekickCore.scheduleAllFor(email); } catch (e) {}
      });
    }
  }
});

