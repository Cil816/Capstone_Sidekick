// "Continue with Google" (login and register pages).
//  - In the Android app, Google's sign-in opens in the phone's browser (Google doesn't
//    allow it inside an app's web view). When it finishes, the browser opens the app
//    again with a link (com.sidekick.app://auth?ticket=...), caught here with the
//    Capacitor App plugin, even if the app had been closed.
//  - In a web browser (local preview), the same page comes back with #ticket=...
// The one-time ticket is exchanged for a normal Sidekick session (POST
// /api/auth/google/exchange), then the person continues like after a normal login.
(function () {
  const APP_LINK = "com.sidekick.app://auth";
  const core = () => window.SidekickCore;
  const isNative = () => Boolean(window.Capacitor?.isNativePlatform?.());

  function showError(message) {
    const el = document.getElementById("auth-error");
    if (!el) { window.SidekickUI?.alert(message, { title: "Google sign-in" }); return; }
    el.textContent = message;
    el.hidden = false;
    el.removeAttribute("hidden");
    el.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }

  function startGoogleSignIn() {
    let base = "";
    try { base = core().getApiBaseUrl() || ""; } catch (error) { base = ""; }
    const url = isNative()
      ? `${base}/api/auth/google/start?client=app`
      : `${base}/api/auth/google/start?client=web&return=${encodeURIComponent(window.location.origin)}`;
    window.SidekickUI?.loading.show("Opening Google…");
    // In the app, a page on another site opens in the phone's browser.
    window.location.href = url;
    if (isNative()) window.setTimeout(() => window.SidekickUI?.loading.hide(true), 2500);
  }

  let exchanging = false;
  async function finishGoogleSignIn({ ticket, error }) {
    if (error) { window.SidekickUI?.loading.hide(true); showError(error); return; }
    if (!ticket || exchanging) return;
    exchanging = true;
    window.SidekickUI?.loading.show("Signing you in…");
    try {
      const result = await core().apiRequest("/api/auth/google/exchange", {
        method: "POST",
        body: JSON.stringify({ ticket }),
      });
      if (!result?.session?.token || !result.user?.email) throw new Error("We couldn’t sign you in right now. Please try again.");
      const email = core().normalizeEmail(result.user.email);
      core().setAuthSession({
        email,
        name: result.user.name || "",
        apiToken: result.session.token,
        loggedInAt: Date.now(),
        ...(result.passwordless ? { passwordless: true } : {}),
      });
      core().recordAccountForEmail(email, result.user.user_id, result.newAccount ? { newAccount: true } : undefined);
      const destination = (await core().restorePreferencesFromAccount()) ? "dashboard.html" : "onboarding.html";
      window.location.href = destination;
    } catch (err) {
      exchanging = false;
      window.SidekickUI?.loading.hide(true);
      showError(core().friendlyError(err, "Google sign-in didn’t finish. Please try again."));
    }
  }

  // com.sidekick.app://auth?ticket=... (app) or #ticket=... (web page).
  function readResult(text) {
    const params = new URLSearchParams(text);
    const ticket = params.get("ticket") || "";
    const error = params.get("error") || "";
    return ticket || error ? { ticket, error } : null;
  }

  function handleAppLink(url) {
    const link = String(url || "");
    if (!link.startsWith(APP_LINK)) return;
    const result = readResult(link.slice(link.indexOf("?") + 1));
    if (result) void finishGoogleSignIn(result);
  }

  function init() {
    document.querySelectorAll("[data-google-signin]").forEach((button) => {
      button.addEventListener("click", startGoogleSignIn);
    });

    // Web: the result comes back in the page address (then removed from it).
    if (window.location.hash.length > 1) {
      const result = readResult(window.location.hash.slice(1));
      if (result) {
        history.replaceState(null, "", window.location.pathname + window.location.search);
        void finishGoogleSignIn(result);
      }
    }

    // App: the link that opened (or reopened) the app.
    const App = window.Capacitor?.Plugins?.App;
    if (isNative() && App) {
      App.addListener("appUrlOpen", (event) => handleAppLink(event?.url));
      App.getLaunchUrl?.().then((launch) => handleAppLink(launch?.url)).catch(() => {});
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
