document.addEventListener('DOMContentLoaded', function () {
    const userNameEl = document.getElementById('user-name');
    const userEmailEl = document.getElementById('user-email');

    const session = window.SidekickCore?.getAuthSession?.();
    const users = window.SidekickCore?.getUsers?.() || [];
    const matchedUser = users.find((user) => user.email === session?.email);

    const storedName = session?.name || matchedUser?.name || localStorage.getItem('userName') || localStorage.getItem('name') || 'Traveler';
    const storedEmail = session?.email || matchedUser?.email || localStorage.getItem('userEmail') || localStorage.getItem('email') || 'you@example.com';

    if (userNameEl) userNameEl.textContent = storedName;
    if (userEmailEl) userEmailEl.textContent = storedEmail;

    const reviewSummary = document.getElementById('app-review-summary');
    const reviewInput = document.getElementById('profile-app-review');
    const reviewStatus = document.getElementById('profile-review-status');
    const reviewSubmit = document.getElementById('profile-review-submit');
    const ratingValue = document.getElementById('profile-rating-value');
    const ratingStars = Array.from(document.querySelectorAll('[data-profile-rating]'));
    let selectedRating = 0;
    let reviewSaving = false;
    const hasApiSession = Boolean(session?.apiToken);

    function updateRatingStars() {
        ratingStars.forEach((star) => {
            const selected = Number(star.dataset.profileRating) <= selectedRating;
            star.classList.toggle('selected', selected);
            star.setAttribute('aria-pressed', String(selected));
            star.disabled = !hasApiSession || reviewSaving;
        });
        if (ratingValue) ratingValue.textContent = selectedRating ? `Your rating: ${selectedRating} out of 5` : 'Select a star rating';
        if (reviewSubmit) {
            reviewSubmit.disabled = !hasApiSession || !selectedRating || reviewSaving;
            reviewSubmit.textContent = 'Submit rating';
        }
        if (reviewInput) reviewInput.disabled = !hasApiSession || reviewSaving;
    }

    ratingStars.forEach((star) => {
        star.addEventListener('click', () => {
            if (reviewSaving) return;
            selectedRating = Number(star.dataset.profileRating);
            updateRatingStars();
        });
    });

    async function loadAppReview() {
        if (!reviewSummary || !reviewInput || !session?.apiToken) {
            if (reviewSummary) reviewSummary.textContent = 'To rate Sidekick, please log out and log in again.';
            updateRatingStars();
            return;
        }
        try {
            const result = await window.SidekickCore.apiRequest('/api/app-reviews/me');
            const review = result.review;
            if (review) {
                selectedRating = Number(review.rating) || 0;
                reviewInput.value = review.review || '';
                if (reviewStatus) reviewStatus.textContent = 'Your saved rating is shown below. You can update it and save again.';
            } else if (reviewStatus) {
                reviewStatus.textContent = 'You haven’t rated Sidekick yet.';
            }
            reviewSummary.textContent = result.totalReviews
                ? `Sidekick average: ${Number(result.averageRating).toFixed(1)} / 5 from ${result.totalReviews} rating${result.totalReviews === 1 ? '' : 's'}.`
                : 'No app ratings yet. Be the first to share yours.';
            updateRatingStars();
        } catch (error) {
            reviewSummary.textContent = window.SidekickCore.friendlyError(error, 'Unable to load app ratings.');
        }
    }

    reviewSubmit?.addEventListener('click', async () => {
        if (!session?.apiToken || !selectedRating || reviewSaving) return;
        reviewSaving = true;
        updateRatingStars();
        if (reviewStatus) reviewStatus.textContent = 'Saving your rating…';
        try {
            await window.SidekickCore.apiRequest('/api/app-reviews/me', {
                method: 'POST',
                body: JSON.stringify({ rating: selectedRating, review: reviewInput.value.trim() }),
            });
            await loadAppReview();
            if (reviewStatus) reviewStatus.textContent = 'Thank You! Your rating has been saved.';
        } catch (error) {
            if (reviewStatus) reviewStatus.textContent = window.SidekickCore.friendlyError(error, 'Could not save your rating. Please try again.');
        } finally {
            reviewSaving = false;
            updateRatingStars();
        }
    });

    void loadAppReview();

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async function () {
            const ok = await window.SidekickUI.confirm('You’ll need to log in again to use Sidekick. Your trips and chats stay on this phone.', { title: 'Log out?', confirmText: 'Log out', cancelText: 'Stay logged in', tone: 'danger', icon: 'logout' });
            if (!ok) return;
            try {
                if (session?.apiToken) {
                    // Logging out also works offline: no waiting for the connection.
                    await window.SidekickCore.apiRequest('/api/app-session/logout', { method: 'POST', waitForConnection: false });
                }
            } catch (error) {
                console.warn('Unable to revoke app session on the server:', error.message);
            } finally {
                window.SidekickCore?.clearAuthSession?.();
                sessionStorage.clear();
                localStorage.removeItem('userName');
                localStorage.removeItem('name');
                localStorage.removeItem('userEmail');
                localStorage.removeItem('email');
                window.location.href = 'login.html';
            }
        });
    }
});
