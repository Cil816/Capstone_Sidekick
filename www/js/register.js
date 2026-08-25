function logRegisterDebug(message, details) {
  if (details === undefined) {
    console.log(`[Register] ${message}`);
    return;
  }
  console.log(`[Register] ${message}`, details);
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
    console.error("[Register] Storage unavailable", error);
    return false;
  }
}

async function handleRegister(event) {
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
  const nameEl = document.getElementById("register-name");
  const emailEl = document.getElementById("register-email");
  const passwordEl = document.getElementById("register-password");
  const submitBtn = event?.target?.querySelector?.('button[type="submit"]');

  if (!nameEl || !emailEl || !passwordEl) {
    console.error("Missing form elements");
    return false;
  }

  logRegisterDebug("Submit captured", {
    hasCore: Boolean(window.SidekickCore),
    storageAvailable: checkStorageAvailability(),
    userAgent: navigator.userAgent,
  });

  errEl?.setAttribute("hidden", "hidden");

  const name = String(nameEl.value || "").trim();
  const email = window.SidekickCore.normalizeEmail(emailEl.value);
  const password = String(passwordEl.value || "");

  if (!name || !email || !password) {
    if (errEl) {
      errEl.textContent = "Please complete all fields.";
      errEl.removeAttribute("hidden");
    }
    return;
  }

  if (password.length < 8) {
    if (errEl) {
      errEl.textContent = "Password must be at least 8 characters.";
      errEl.removeAttribute("hidden");
    }
    return;
  }

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Creating account...";
    }

    const user = await window.SidekickCore.apiRequest("/api/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password }),
    });

    // Auto-login after registration.
    window.SidekickCore.setAuthSession({
      email,
      name: user.name || name,
      loggedInAt: Date.now(),
    });

    // After auto-login, send users to onboarding only if they have no saved prefs.
    const prefs = window.SidekickCore.getPreferences();
    logRegisterDebug("Registration success, redirecting", {
      email,
      destination: prefs ? "dashboard.html" : "onboarding.html",
    });
    window.location.href = prefs ? "dashboard.html" : "onboarding.html";
  } catch (e) {
    console.error(e);
    if (errEl) {
      errEl.textContent = "Registration failed. Please try again.";
      errEl.removeAttribute("hidden");
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Register";
    }
  }

  return false;
}

function bindRegisterForm() {
  const form = document.getElementById("register-form");
  if (!form || form.dataset.sidekickBound === "1") {
    return;
  }

  form.dataset.sidekickBound = "1";
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    event.stopPropagation();
    void handleRegister(event);
  });

  logRegisterDebug("Form listener bound");
}

window.addEventListener("error", function (event) {
  console.error("[Register] Unhandled page error:", event.message, event.error);
});

window.addEventListener("unhandledrejection", function (event) {
  console.error("[Register] Unhandled promise rejection:", event.reason);
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bindRegisterForm);
} else {
  bindRegisterForm();
}

window.addEventListener("pageshow", bindRegisterForm);
