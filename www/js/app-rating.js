(function () {
  const COOLDOWN_MS = 10 * 60 * 60 * 1000;
  const PENDING_TTL_MS = 10 * 60 * 1000;
  const PENDING_ITINERARY_KEY = "sidekick.appReviewItineraryOpportunity.v1";
  let promptPromise = null;
  let modalReady = false;

  function getSession() {
    return window.SidekickCore?.getAuthSession?.() || null;
  }

  function keyFor(base, email) {
    return `${base}:${String(email || "").toLowerCase()}`;
  }

  function ensureModal() {
    let modal = document.getElementById("app-rating-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "app-rating-modal";
    modal.className = "app-rating-modal";
    modal.setAttribute("aria-hidden", "true");
    modal.hidden = true;
    modal.innerHTML = `
      <div class="app-rating-backdrop"></div>
      <section class="app-rating-panel" role="dialog" aria-modal="true" aria-labelledby="app-rating-heading">
        <button id="app-rating-close" class="app-rating-close" type="button" aria-label="Close rating prompt">×</button>
        <div id="app-rating-step-stars" class="app-rating-step">
          <h2 id="app-rating-heading">Enjoying Sidekick?</h2>
          <p>Tap a star to rate the app.</p>
          <div class="app-rating-stars" role="group" aria-label="Choose a rating from 1 to 5 stars">
            <button type="button" data-rating="1" aria-label="1 star">★</button>
            <button type="button" data-rating="2" aria-label="2 stars">★</button>
            <button type="button" data-rating="3" aria-label="3 stars">★</button>
            <button type="button" data-rating="4" aria-label="4 stars">★</button>
            <button type="button" data-rating="5" aria-label="5 stars">★</button>
          </div>
          <button id="app-rating-later" class="app-rating-not-now" type="button">Not now</button>
        </div>
        <div id="app-rating-step-review" class="app-rating-step" hidden>
          <h2 id="app-rating-review-heading" tabindex="-1">Thanks for rating us!</h2>
          <p>Want to tell us what you think?</p>
          <label for="app-rating-review">Your review (optional)</label>
          <textarea id="app-rating-review" maxlength="2000" rows="4" placeholder="Write a few words…"></textarea>
          <div class="app-rating-review-actions">
            <button id="app-review-not-now" class="btn btn-outline" type="button">Not now</button>
            <button id="app-review-submit" class="btn btn-primary" type="button" disabled>Submit review</button>
          </div>
        </div>
        <p id="app-rating-status" class="app-rating-status" role="status" aria-live="polite" hidden></p>
      </section>`;
    document.body.appendChild(modal);
    return modal;
  }

  function initModal(session) {
    if (modalReady) return ensureModal();
    const modal = ensureModal();
    const starStep = modal.querySelector("#app-rating-step-stars");
    const reviewStep = modal.querySelector("#app-rating-step-review");
    const closeBtn = modal.querySelector("#app-rating-close");
    const laterBtn = modal.querySelector("#app-rating-later");
    const skipReviewBtn = modal.querySelector("#app-review-not-now");
    const submitBtn = modal.querySelector("#app-review-submit");
    const reviewInput = modal.querySelector("#app-rating-review");
    const statusEl = modal.querySelector("#app-rating-status");
    const stars = Array.from(modal.querySelectorAll("[data-rating]"));
    let selectedRating = 0;
    let isSaving = false;

    function hideModal() {
      modal.hidden = true;
      modal.setAttribute("aria-hidden", "true");
    }

    function deferRating() {
      hideModal();
    }

    function setSavingState(value) {
      isSaving = value;
      closeBtn.disabled = value;
      skipReviewBtn.disabled = value;
      submitBtn.disabled = value || !String(reviewInput.value || "").trim();
    }

    async function saveRating(reviewText) {
      if (!selectedRating || isSaving) return;
      setSavingState(true);
      statusEl.textContent = "Saving your rating…";
      statusEl.hidden = false;
      try {
        await window.SidekickCore.apiRequest("/api/app-reviews", {
          method: "POST",
          body: JSON.stringify({ email: session.email, rating: selectedRating, review: reviewText }),
        });
        statusEl.textContent = "Thank you for your feedback!";
        window.setTimeout(hideModal, 900);
      } catch (error) {
        statusEl.textContent = error.message || "Could not save your rating. Please try again.";
        setSavingState(false);
      }
    }

    function closeOrSkipReview() {
      if (reviewStep.hidden) deferRating();
      else void saveRating(null);
    }

    stars.forEach((star) => star.addEventListener("click", () => {
      if (isSaving) return;
      selectedRating = Number(star.dataset.rating);
      stars.forEach((item) => {
        const selected = Number(item.dataset.rating) <= selectedRating;
        item.classList.toggle("selected", selected);
        item.setAttribute("aria-pressed", String(selected));
      });
      starStep.hidden = true;
      reviewStep.hidden = false;
      modal.querySelector("[aria-labelledby]")?.setAttribute("aria-labelledby", "app-rating-review-heading");
      submitBtn.disabled = true;
      reviewInput.focus();
    }));
    reviewInput.addEventListener("input", () => {
      submitBtn.disabled = isSaving || !String(reviewInput.value || "").trim();
    });
    closeBtn.addEventListener("click", closeOrSkipReview);
    laterBtn.addEventListener("click", deferRating);
    skipReviewBtn.addEventListener("click", () => { void saveRating(null); });
    submitBtn.addEventListener("click", () => { void saveRating(String(reviewInput.value || "").trim()); });
    modal.querySelector(".app-rating-backdrop")?.addEventListener("click", closeOrSkipReview);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !modal.hidden) closeOrSkipReview();
    });
    modalReady = true;
    return modal;
  }

  async function attemptPrompt() {
    const session = getSession();
    if (!session?.email || !window.SidekickCore?.apiRequest) return false;
    const cooldownKey = keyFor("sidekick.appReviewLastPromptAt.v1", session.email);
    try {
      if (Date.now() - Number(localStorage.getItem(cooldownKey) || 0) < COOLDOWN_MS) return false;
      localStorage.removeItem(keyFor("sidekick.appReviewSnoozedUntil.v1", session.email));
    } catch (error) {}

    if (promptPromise) return promptPromise;
    promptPromise = (async () => {
      try {
        const result = await window.SidekickCore.apiRequest(`/api/app-reviews/status/${encodeURIComponent(session.email)}`);
        if (result.submitted) return false;
        const modal = initModal(session);
        if (document.querySelector(".destination-modal.open")) return false;
        modal.hidden = false;
        modal.setAttribute("aria-hidden", "false");
        try { localStorage.setItem(cooldownKey, String(Date.now())); } catch (error) {}
        modal.querySelector("#app-rating-close")?.focus();
        return true;
      } catch (error) {
        console.warn("App rating prompt is unavailable:", error.message);
        return false;
      } finally {
        promptPromise = null;
      }
    })();
    return promptPromise;
  }

  function afterItineraryGenerated(options = {}) {
    if (options.deferUntilItineraryPage) {
      try { localStorage.setItem(PENDING_ITINERARY_KEY, String(Date.now())); } catch (error) {}
      return;
    }
    window.setTimeout(() => { void attemptPrompt(); }, 1200);
  }

  function consumeItineraryOpportunity() {
    if (!/itinerary\.html$/i.test(window.location.pathname)) return;
    let createdAt = 0;
    try {
      createdAt = Number(localStorage.getItem(PENDING_ITINERARY_KEY) || 0);
      localStorage.removeItem(PENDING_ITINERARY_KEY);
    } catch (error) {}
    if (createdAt && Date.now() - createdAt <= PENDING_TTL_MS) {
      window.setTimeout(() => { void attemptPrompt(); }, 1400);
    }
  }

  window.SidekickAppRating = { afterItineraryGenerated };
  document.addEventListener("DOMContentLoaded", consumeItineraryOpportunity, { once: true });
})();
