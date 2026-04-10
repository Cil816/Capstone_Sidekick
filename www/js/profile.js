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

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', function () {
            window.SidekickCore?.clearAuthSession?.();
            sessionStorage.clear();
            localStorage.removeItem('userName');
            localStorage.removeItem('name');
            localStorage.removeItem('userEmail');
            localStorage.removeItem('email');
            window.location.href = 'login.html';
        });
    }
});
