function logLoginDebug(message, details) {
  if (details === undefined) {
    console.log(`[Login] ${message}`);
    return;
  }
  console.log(`[Login] ${message}`, details);
}

function checkStorageAvailability() {
  try {
    const testKey = "sidekick.storage.test";
    localStorage.setItem(testKey, "1");
    localStorage.removeItem(testKey);
    sessionStorage.setItem(testKey, "1");
    sessionStorage.removeItem(testKey);
    return true;
  } catch (error) {
    console.error("[Login] Storage unavailable", error);
    return false;
  }
}

async function handleLogin(event) {
  if (!window.SidekickCore) {
    console.error("SidekickCore is not loaded");
    return false;
  }

  try {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
  } catch (e) {
    console.error("Error preventing default form submission:", e);
    return false;
  }

  const errEl = document.getElementById("auth-error");
  const emailEl = document.getElementById("login-email");
  const passwordEl = document.getElementById("login-password");
  const submitBtn = event?.target?.querySelector?.('button[type="submit"]');

  if (!emailEl || !passwordEl) {
    console.error("Missing form elements");
    return false;
  }

  logLoginDebug("Submit captured", {
    hasCore: Boolean(window.SidekickCore),
    storageAvailable: checkStorageAvailability(),
    userAgent: navigator.userAgent,
  });

  errEl?.setAttribute("hidden", "hidden");
  const email = window.SidekickCore.normalizeEmail(emailEl.value);
  const password = String(passwordEl.value || "");

  if (!email || !password) {
    if (errEl) {
      errEl.textContent = "Please enter your email and password.";
      errEl.removeAttribute("hidden");
    }
    return;
  }

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Logging in...";
    }

    const result = await window.SidekickCore.apiRequest("/api/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    const user = result.user;
    if (!result.session?.token) {
      throw new Error("The Sidekick server did not issue an app session. Restart the updated backend, then try signing in again.");
    }

    window.SidekickCore.setAuthSession({
      email,
      name: user?.name || "",
      apiToken: result.session.token,
      loggedInAt: Date.now(),
    });

    const prefs = window.SidekickCore.getPreferences();
    logLoginDebug("Login success, redirecting", {
      email,
      destination: prefs ? "dashboard.html" : "onboarding.html",
    });
    window.location.href = prefs ? "dashboard.html" : "onboarding.html";
  } catch (e) {
    console.error(e);
    if (errEl) {
      errEl.textContent = e.message || "Login failed. Please try again.";
      errEl.removeAttribute("hidden");
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Login";
    }
  }

  return false;
}

function bindLoginForm() {
  const form = document.getElementById("login-form");
  if (!form || form.dataset.sidekickBound === "1") {
    return;
  }

  if (new URLSearchParams(window.location.search).get("account") === "deleted") {
    const statusEl = document.getElementById("auth-status");
    if (statusEl) {
      statusEl.textContent = "Your account and its data were deleted.";
      statusEl.removeAttribute("hidden");
    }
  }

  const sessionMessage = new URLSearchParams(window.location.search).get("session");
  if (sessionMessage === "expired") {
    const errEl = document.getElementById("auth-error");
    if (errEl) {
      errEl.textContent = "Your session expired. Please sign in again. Your saved Sidekick data is unchanged.";
      errEl.removeAttribute("hidden");
    }
  }

  form.dataset.sidekickBound = "1";
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    event.stopPropagation();
    void handleLogin(event);
  });

  logLoginDebug("Form listener bound");
}

window.addEventListener("error", function (event) {
  console.error("[Login] Unhandled page error:", event.message, event.error);
});

window.addEventListener("unhandledrejection", function (event) {
  console.error("[Login] Unhandled promise rejection:", event.reason);
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bindLoginForm);
} else {
  bindLoginForm();
}

window.addEventListener("pageshow", bindLoginForm);
