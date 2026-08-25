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
  const termsEl = document.getElementById("terms-accepted");
  const submitBtn = event?.target?.querySelector?.('button[type="submit"]');

  if (!nameEl || !emailEl || !passwordEl || !termsEl) {
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

  if (!emailEl.validity.valid || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    if (errEl) {
      errEl.textContent = "Please enter a valid email address.";
      errEl.removeAttribute("hidden");
    }
    return;
  }

  if (!termsEl.checked) {
    if (errEl) {
      errEl.textContent = "You must agree to the Terms and Conditions to register.";
      errEl.removeAttribute("hidden");
    }
    return;
  }

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
      body: JSON.stringify({ name, email, password, termsAccepted: true }),
    });

    logRegisterDebug("Registration success, redirecting to verification", { email });
    window.location.href = `verify.html?email=${encodeURIComponent(user.email || email)}`;
  } catch (e) {
    console.error(e);
    if (errEl) {
      errEl.textContent = e.message || "Registration failed. Please try again.";
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

  const dialog = document.getElementById("terms-dialog");
  document.getElementById("terms-link")?.addEventListener("click", () => dialog?.showModal());
  document.getElementById("terms-close")?.addEventListener("click", () => dialog?.close());
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
