// Onboarding State
let currentStep = 1;
let selectedTravel = [];
let selectedInterests = [];
let selectedPlaces = [];

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
            sessionStorage.setItem(ONBOARDING_STATE_KEY, JSON.stringify({ currentStep, selectedTravel, selectedInterests, selectedPlaces }));
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
        // preferred places
        const places = window.SidekickCore?.PLACES || [];
        content.innerHTML = `
            <h1>Preferred places</h1>
            <p>Pick places or regions you'd like to visit (optional)</p>
            <div class="chip-container" id="places-chips"></div>
        `;
        const container = document.getElementById('places-chips');
        // show a compact list
        places.slice(0, 10).forEach(p => {
            const name = `${p.name}`;
            const btn = document.createElement('button');
            btn.className = 'chip'; btn.textContent = name;
            if (selectedPlaces.includes(name)) btn.classList.add('selected');
            btn.onclick = () => {
                const idx = selectedPlaces.indexOf(name);
                if (idx > -1) selectedPlaces.splice(idx,1); else selectedPlaces.push(name);
                renderStep();
            };
            container.appendChild(btn);
        });
    }
   
    updateContinueButton();
    // Recalculate bottom spacing when the step content changes.
    try { const ev = new Event('resize'); window.dispatchEvent(ev); } catch (e) {}
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

function handleNext() {
    if (currentStep < TOTAL_ONBOARDING_STEPS) {
        currentStep++;
        renderStep();
    } else {
        const session = window.SidekickCore?.getAuthSession?.();
        if (!session?.email) {
            window.location.href = 'login.html';
            return;
        }

        const prefs = {
            travelTypes: selectedTravel,
            interests: selectedInterests,
            preferredPlaces: selectedPlaces,
        };

        // Save preferences for this user.
        window.SidekickCore.setPreferencesForEmail(session.email, prefs);

        // Onboarding is preference setup only. Remove any pre-existing itinerary so
        // users decide later when and what itinerary to generate.
        try {
            const itinMap = window.SidekickCore.getItineraryByEmail();
            delete itinMap[session.email];
            window.SidekickCore.setItineraryByEmail(itinMap);
        } catch (e) {}

        // Remove itinerary-derived reminders tied to prior generated plans.
        try {
            const all = JSON.parse(localStorage.getItem('sidekick.remindersByEmail.v1') || '{}');
            const current = Array.isArray(all[session.email]) ? all[session.email] : [];
            all[session.email] = current.filter((r) => !(r.type === 'Itinerary' || typeof r.parentDueAt !== 'undefined'));
            localStorage.setItem('sidekick.remindersByEmail.v1', JSON.stringify(all));
            document.dispatchEvent(new CustomEvent('sidekick:reminders-updated', { detail: { email: session.email } }));
        } catch (e) {}

        // Keep legacy key so older code won't break.
        localStorage.setItem('userPreferences', JSON.stringify({
            travelTypes: selectedTravel,
            interests: selectedInterests,
            preferredPlaces: selectedPlaces,
        }));

        // Clear persisted onboarding state
        try { sessionStorage.removeItem(ONBOARDING_STATE_KEY); } catch (e) {}

        window.location.href = 'dashboard.html';
    }
}
