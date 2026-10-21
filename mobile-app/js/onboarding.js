// Onboarding State
let currentStep = 1;
let selectedTravel = [];
let selectedInterests = [];
let selectedPlaces = [];
// Free-form destinations the user searched for: { name, placeId, lat, lng, region }
let selectedDestinations = [];
const MAX_DESTINATIONS = 5;
let destSearchTimer = null;
let destSearchRequestId = 0;
let destSessionToken = null;

const ONBOARDING_STATE_KEY = 'sidekick.onboarding.v1';
const TOTAL_ONBOARDING_STEPS = 3;

// Data
const travelTypes = [
    'Adventure',
    'Beach & Relaxation',
    'Cultural',
    'Food Tour',
    'Nature & Wildlife',
    'City Exploration'
];

const interests = [
    'Beaches',
    'Mountains',
    'Historical Sites',
    'Local Cuisine',
    'Nightlife',
    'Shopping',
    'Photography',
    'Water Sports',
    'Hiking',
    'Island Hopping'
];

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    // Gate onboarding behind login.
    const session = window.SidekickCore?.requireAuth?.();
    if (!session) return;

    // If preferences already exist, skip to dashboard.
    const existingPrefs = window.SidekickCore?.getPreferences?.();
    if (existingPrefs) {
        window.location.href = 'dashboard.html';
        return;
    }

    // Restore in-progress onboarding state if present.
    try {
        const raw = sessionStorage.getItem(ONBOARDING_STATE_KEY);
        const saved = raw ? JSON.parse(raw) : null;
        if (saved) {
            currentStep = saved.currentStep || currentStep;
            selectedTravel = Array.isArray(saved.selectedTravel) ? saved.selectedTravel : selectedTravel;
            selectedInterests = Array.isArray(saved.selectedInterests) ? saved.selectedInterests : selectedInterests;
            selectedPlaces = Array.isArray(saved.selectedPlaces) ? saved.selectedPlaces : selectedPlaces;
            selectedDestinations = Array.isArray(saved.selectedDestinations) ? saved.selectedDestinations.slice(0, MAX_DESTINATIONS) : selectedDestinations;
        }
    } catch (e) {
        // ignore parsing errors
    }

    renderStep();

    // Ensure page content isn't hidden behind the fixed footer on small screens.
    const app = document.querySelector('.app-container');
    if (app) app.classList.add('onboarding-active');

    function adjustForFooter() {
        const footer = document.querySelector('.onboarding-footer');
        const content = document.getElementById('onboarding-content');
        if (!footer || !content) return;
        const footerHeight = footer.offsetHeight || 0;
        // Add a comfortable gap so the continue button doesn't sit flush to content
        content.style.paddingBottom = (footerHeight + 24) + 'px';
    }

    // Run once and on resize to handle orientation/keyboard changes.
    adjustForFooter();
    window.addEventListener('resize', adjustForFooter);
    // Persist state before unload so users don't lose progress on refresh/back.
    window.addEventListener('beforeunload', () => {
        try {
            sessionStorage.setItem(ONBOARDING_STATE_KEY, JSON.stringify({ currentStep, selectedTravel, selectedInterests, selectedPlaces, selectedDestinations }));
        } catch (e) {}
    });
});

function renderStep() {
    const content = document.getElementById('onboarding-content');
    const backBtn = document.getElementById('onboarding-back');
    const continueBtn = document.getElementById('onboarding-continue');
    const stepIndicator = document.getElementById('step-indicator');
    const progressFill = document.getElementById('progress-fill');
    
    // Update progress
    stepIndicator.textContent = `Step ${currentStep} of ${TOTAL_ONBOARDING_STEPS}`;
    progressFill.style.width = `${(currentStep / TOTAL_ONBOARDING_STEPS) * 100}%`;
    
    // Show/hide back button
    backBtn.style.display = currentStep > 1 ? 'block' : 'none';
    
    // Update continue button text
    const continueSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M9 18l6-6-6-6"/>
    </svg>`;
    continueBtn.innerHTML = currentStep === TOTAL_ONBOARDING_STEPS ? 'Get Started' + continueSvg : 'Continue' + continueSvg;
    
    // Render step content
    if (currentStep === 1) {
        content.innerHTML = `
            <h1>What's your travel style?</h1>
            <p>Select all that apply</p>
            <div class="chip-container" id="travel-chips"></div>
        `;
        
        const chipsContainer = document.getElementById('travel-chips');
        travelTypes.forEach(type => {
            const chip = document.createElement('button');
            chip.className = 'chip';
            chip.textContent = type;
            if (selectedTravel.includes(type)) {
                chip.classList.add('selected');
            }
            chip.onclick = () => toggleTravel(type);
            chipsContainer.appendChild(chip);
        });
    } else if (currentStep === 2) {
        content.innerHTML = `
            <h1>What interests you?</h1>
            <p>Select your interests</p>
            <div class="chip-container" id="interest-chips"></div>
        `;
        
        const chipsContainer = document.getElementById('interest-chips');
        interests.forEach(interest => {
            const chip = document.createElement('button');
            chip.className = 'chip';
            chip.textContent = interest;
            if (selectedInterests.includes(interest)) {
                chip.classList.add('selected');
            }
            chip.onclick = () => toggleInterest(interest);
            chipsContainer.appendChild(chip);
        });
    }
    else if (currentStep === 3) {
        renderDestinationStep(content);
    }

    updateContinueButton();
    // Recalculate bottom spacing when the step content changes.
    try { const ev = new Event('resize'); window.dispatchEvent(ev); } catch (e) {}
}

function destinationKey(dest) {
    return String(dest.placeId || dest.name || '').toLowerCase();
}

function isDestinationSelected(dest) {
    const key = destinationKey(dest);
    const nameKey = String(dest.name || '').toLowerCase();
    return selectedDestinations.some((d) => destinationKey(d) === key || String(d.name || '').toLowerCase() === nameKey);
}

function setDestinationStatus(text) {
    const el = document.getElementById('dest-status');
    if (el) el.textContent = text || '';
}

function addDestination(dest) {
    if (!dest || !dest.name || isDestinationSelected(dest)) return false;
    if (selectedDestinations.length >= MAX_DESTINATIONS) {
        setDestinationStatus('You can choose up to ' + MAX_DESTINATIONS + ' destinations. Remove one to add another.');
        return false;
    }
    selectedDestinations.push(dest);
    return true;
}

function removeDestination(index) {
    selectedDestinations.splice(index, 1);
    setDestinationStatus('');
    refreshDestinationStep();
}

function closeDestinationSuggestions() {
    const list = document.getElementById('dest-suggestions');
    if (list) {
        list.replaceChildren();
        list.hidden = true;
    }
}

function refreshDestinationStep() {
    const selectedWrap = document.getElementById('dest-selected');
    const counter = document.getElementById('dest-counter');
    const input = document.getElementById('dest-search');
    const popularWrap = document.getElementById('dest-popular');
    if (!selectedWrap) return;
    const atLimit = selectedDestinations.length >= MAX_DESTINATIONS;

    if (counter) counter.textContent = selectedDestinations.length + ' of ' + MAX_DESTINATIONS + ' selected';
    if (input) input.disabled = atLimit;

    selectedWrap.replaceChildren();
    selectedDestinations.forEach((dest, index) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip selected dest-chip';
        chip.setAttribute('aria-label', 'Remove ' + dest.name);
        const label = document.createElement('span');
        label.textContent = dest.name;
        const x = document.createElement('span');
        x.className = 'dest-chip-remove';
        x.textContent = '×';
        chip.append(label, x);
        chip.onclick = () => removeDestination(index);
        selectedWrap.appendChild(chip);
    });

    if (popularWrap) {
        popularWrap.querySelectorAll('.chip').forEach((chip) => {
            const selected = isDestinationSelected({ name: chip.dataset.name });
            chip.classList.toggle('selected', selected);
            chip.disabled = atLimit && !selected;
        });
    }
}

async function selectSuggestedDestination(suggestion) {
    if (!suggestion?.placeId || !suggestion?.name) return;
    const sessionToken = destSessionToken;
    destSessionToken = null;
    destSearchRequestId += 1;
    clearTimeout(destSearchTimer);
    closeDestinationSuggestions();
    const input = document.getElementById('dest-search');
    if (input) input.value = '';
    if (isDestinationSelected({ name: suggestion.name, placeId: suggestion.placeId })) {
        setDestinationStatus(suggestion.name + ' is already selected.');
        return;
    }
    if (selectedDestinations.length >= MAX_DESTINATIONS) {
        setDestinationStatus('You can choose up to ' + MAX_DESTINATIONS + ' destinations. Remove one to add another.');
        return;
    }
    setDestinationStatus('Adding ' + suggestion.name + '…');
    const secondary = String(suggestion.secondaryText || '')
        .split(',').map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== 'philippines');
    const dest = {
        name: suggestion.name,
        placeId: suggestion.placeId,
        region: secondary[0] || 'Batangas',
    };
    try {
        const data = await window.SidekickCore.apiRequest('/api/maps/place-details', {
            method: 'POST',
            body: JSON.stringify({ placeId: suggestion.placeId, sessionToken }),
        });
        const lat = Number(data?.place?.lat);
        const lng = Number(data?.place?.lng);
        if (data?.place?.lat != null && data?.place?.lng != null && Number.isFinite(lat) && Number.isFinite(lng)) {
            dest.lat = lat;
            dest.lng = lng;
        }
    } catch (error) {
        // Keep the destination by name; the dashboard can still search for it by text.
    }
    // The user may have navigated away from this step while details were loading.
    if (currentStep !== 3) return;
    addDestination(dest);
    setDestinationStatus('');
    refreshDestinationStep();
}

function runDestinationSearch(query) {
    const list = document.getElementById('dest-suggestions');
    const requestId = ++destSearchRequestId;
    clearTimeout(destSearchTimer);
    closeDestinationSuggestions();
    if (query.length < 2) {
        destSessionToken = null;
        setDestinationStatus('');
        return;
    }
    if (!destSessionToken) {
        destSessionToken = window.crypto?.randomUUID?.()
            || (Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14));
    }
    const sessionToken = destSessionToken;
    setDestinationStatus('Searching destinations…');
    destSearchTimer = setTimeout(async () => {
        try {
            const data = await window.SidekickCore.apiRequest('/api/maps/place-suggestions', {
                method: 'POST',
                body: JSON.stringify({ input: query, sessionToken, scope: 'destination' }),
            });
            const input = document.getElementById('dest-search');
            if (requestId !== destSearchRequestId || !input || input.value.trim() !== query || !list) return;
            const suggestions = (data.suggestions || []).filter((item) => item?.placeId && item?.name).slice(0, 6);
            suggestions.forEach((suggestion) => {
                const option = document.createElement('button');
                option.type = 'button';
                option.className = 'dest-suggestion';
                const title = document.createElement('strong');
                title.textContent = suggestion.name;
                option.appendChild(title);
                if (suggestion.secondaryText) {
                    const sub = document.createElement('span');
                    sub.textContent = suggestion.secondaryText;
                    option.appendChild(sub);
                }
                option.addEventListener('mousedown', (event) => event.preventDefault());
                option.addEventListener('click', () => { void selectSuggestedDestination(suggestion); });
                list.appendChild(option);
            });
            list.hidden = suggestions.length === 0;
            setDestinationStatus(suggestions.length ? '' : 'No destinations found. Try another name.');
        } catch (error) {
            if (requestId !== destSearchRequestId) return;
            closeDestinationSuggestions();
            setDestinationStatus('Search is unavailable right now. You can still pick from the popular places below.');
        }
    }, 320);
}

function renderDestinationStep(content) {
    content.innerHTML = `
        <h1>Where do you want to go?</h1>
        <p>Search any destination in Batangas. Choose up to ${MAX_DESTINATIONS} (optional).</p>
        <div class="dest-search-wrap">
            <input type="text" id="dest-search" class="dest-search-input" placeholder="Search places in Batangas…" autocomplete="off" aria-label="Search destinations" />
            <div class="dest-suggestions" id="dest-suggestions" hidden></div>
        </div>
        <div class="dest-status" id="dest-status" role="status" aria-live="polite"></div>
        <div class="dest-counter" id="dest-counter"></div>
        <div class="chip-container" id="dest-selected"></div>
        <h2 class="dest-subheading">Popular picks</h2>
        <div class="chip-container" id="dest-popular"></div>
    `;

    const popular = window.SidekickCore?.POPULAR_PH_SPOTS || [];
    const popularWrap = document.getElementById('dest-popular');
    popular.forEach((spot) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = spot.name;
        chip.dataset.name = spot.name;
        chip.onclick = () => {
            const existing = selectedDestinations.findIndex((d) => String(d.name).toLowerCase() === spot.name.toLowerCase());
            if (existing > -1) {
                selectedDestinations.splice(existing, 1);
                setDestinationStatus('');
            } else {
                addDestination({ name: spot.name, region: spot.region, lat: spot.lat, lng: spot.lng });
            }
            refreshDestinationStep();
        };
        popularWrap.appendChild(chip);
    });

    const input = document.getElementById('dest-search');
    input.addEventListener('input', () => runDestinationSearch(input.value.trim()));
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeDestinationSuggestions();
    });
    refreshDestinationStep();
}

function toggleTravel(type) {
    const index = selectedTravel.indexOf(type);
    if (index > -1) {
        selectedTravel.splice(index, 1);
    } else {
        selectedTravel.push(type);
    }
    renderStep();
}

function toggleInterest(interest) {
    const index = selectedInterests.indexOf(interest);
    if (index > -1) {
        selectedInterests.splice(index, 1);
    } else {
        selectedInterests.push(interest);
    }
    renderStep();
}

function updateContinueButton() {
    const continueBtn = document.getElementById('onboarding-continue');
    let canProceed = false;
    
    if (currentStep === 1) {
        canProceed = selectedTravel.length > 0;
    } else if (currentStep === 2) {
        canProceed = selectedInterests.length > 0;
    } else if (currentStep === 3) {
        // optional step; allow completion
        canProceed = true;
    }
    
    continueBtn.disabled = !canProceed;
}

function handleBack() {
    if (currentStep > 1) {
        currentStep--;
        renderStep();
    }
}

async function handleNext() {
    if (currentStep < TOTAL_ONBOARDING_STEPS) {
        currentStep++;
        renderStep();
    } else {
        const session = window.SidekickCore?.getAuthSession?.();
        if (!session?.email) {
            window.location.href = 'login.html';
            return;
        }

        const preferredDestinations = selectedDestinations.slice(0, MAX_DESTINATIONS).map((d) => ({ ...d }));
        // preferredPlaces stays a plain list of names for the backend and itinerary logic.
        const preferredPlaceNames = preferredDestinations.map((d) => d.name);

        const prefs = {
            travelTypes: selectedTravel,
            interests: selectedInterests,
            preferredPlaces: preferredPlaceNames,
            preferredDestinations,
        };

        // Save preferences for this user (on the device, then to the account).
        window.SidekickCore.setPreferencesForEmail(session.email, prefs);
        const continueBtn = document.getElementById('onboarding-continue');
        if (continueBtn) continueBtn.disabled = true;
        try {
            await Promise.race([
                window.SidekickCore.syncPreferencesToServer?.(session.email, prefs),
                new Promise((resolve) => setTimeout(resolve, 4000)),
            ]);
        } catch (e) {}

        // Onboarding is preference setup only. Remove any pre-existing itinerary so
        // users decide later when and what itinerary to generate.
        try {
            const itinMap = window.SidekickCore.getItineraryByEmail();
            delete itinMap[session.email];
            window.SidekickCore.setItineraryByEmail(itinMap);
        } catch (e) {}

        // Itinerary reminders are rebuilt from the saved (planned) trips, which stay; with
        // none saved, reminders from earlier generated plans are removed.
        try {
            if (window.SidekickCore.getPlannedTrips?.(session.email)?.length && window.SidekickCore.syncRemindersFromItinerary) {
                window.SidekickCore.syncRemindersFromItinerary(session.email);
            } else {
                const all = JSON.parse(localStorage.getItem('sidekick.remindersByEmail.v1') || '{}');
                const current = Array.isArray(all[session.email]) ? all[session.email] : [];
                all[session.email] = current.filter((r) => !(r.type === 'Itinerary' || typeof r.parentDueAt !== 'undefined'));
                localStorage.setItem('sidekick.remindersByEmail.v1', JSON.stringify(all));
            }
            document.dispatchEvent(new CustomEvent('sidekick:reminders-updated', { detail: { email: session.email } }));
        } catch (e) {}

        // Keep legacy key so older code won't break.
        localStorage.setItem('userPreferences', JSON.stringify(prefs));

        // Clear persisted onboarding state
        try { sessionStorage.removeItem(ONBOARDING_STATE_KEY); } catch (e) {}

        window.location.href = 'dashboard.html';
    }
}
