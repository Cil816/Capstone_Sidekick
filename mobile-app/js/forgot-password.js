// "Forgot password?" on the login screen: email a 6-digit code, confirm it,
// then set a new password.
(function () {
  const $ = (id) => document.getElementById(id);
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function init() {
    const link = document.querySelector(".forgot-link");
    const flow = $("reset-flow");
    const loginForm = $("login-form");
    if (!link || !flow || !loginForm || flow.dataset.bound === "1") return;
    flow.dataset.bound = "1";

    const title = document.querySelector(".screen-title");
    const subtitle = document.querySelector(".screen-subtitle");
    const footer = document.querySelector(".footer-text");
    const original = { title: title?.textContent || "", subtitle: subtitle?.textContent || "" };
    const errorEl = $("auth-error");
    const statusEl = $("auth-status");
    const emailInput = $("reset-email");
    const otpInput = $("reset-otp");
    const passwordInput = $("reset-password");
    const confirmInput = $("reset-password-confirm");
    const sendButton = $("reset-send-code");
    const verifyButton = $("reset-verify-code");
    const resendButton = $("reset-resend-code");
    const saveButton = $("reset-save-password");
    const steps = { email: $("reset-step-email"), code: $("reset-step-code"), password: $("reset-step-password") };
    const state = { email: "", otp: "", busy: false };

    function setError(message) {
      if (!errorEl) return;
      errorEl.textContent = message || "";
      errorEl.hidden = !message;
    }

    function setStatus(message) {
      if (!statusEl) return;
      statusEl.textContent = message || "";
      statusEl.hidden = !message;
    }

    function busy(button, isBusy, busyText, idleText) {
      state.busy = isBusy;
      if (!button) return;
      button.disabled = isBusy;
      button.textContent = isBusy ? busyText : idleText;
    }

    function showStep(name) {
      Object.entries(steps).forEach(([key, el]) => { if (el) el.hidden = key !== name; });
      setError("");
    }

    function open() {
      loginForm.hidden = true;
      if (footer) footer.hidden = true;
      flow.hidden = false;
      if (title) title.textContent = "Reset password";
      if (subtitle) subtitle.textContent = "We'll email you a 6-digit code to confirm it's you.";
      emailInput.value = window.SidekickCore.normalizeEmail($("login-email")?.value || "");
      state.email = "";
      state.otp = "";
      otpInput.value = "";
      passwordInput.value = "";
      confirmInput.value = "";
      setStatus("");
      showStep("email");
      emailInput.focus();
    }

    function close(message = "") {
      flow.hidden = true;
      loginForm.hidden = false;
      if (footer) footer.hidden = false;
      if (title) title.textContent = original.title;
      if (subtitle) subtitle.textContent = original.subtitle;
      passwordInput.value = "";
      confirmInput.value = "";
      otpInput.value = "";
      state.otp = "";
      setError("");
      setStatus(message);
    }

    async function sendCode(button, idleText) {
      const email = window.SidekickCore.normalizeEmail(button === resendButton ? state.email : emailInput.value);
      if (!EMAIL_PATTERN.test(email)) {
        setError("Please enter a valid email address.");
        emailInput.focus();
        return;
      }
      setError("");
      setStatus("");
      busy(button, true, "Sending…", idleText);
      try {
        await window.SidekickCore.apiRequest("/api/password/forgot", {
          method: "POST",
          body: JSON.stringify({ email }),
        });
        state.email = email;
        $("reset-code-email").textContent = email;
        otpInput.value = "";
        showStep("code");
        setStatus("If an account exists for this email, a 6-digit code is on its way. Check your inbox and spam folder.");
        otpInput.focus();
      } catch (error) {
        setError(error.message || "Unable to send a reset code right now.");
      } finally {
        busy(button, false, "Sending…", idleText);
      }
    }

    async function verifyCode() {
      if (state.busy) return;
      const otp = String(otpInput.value || "").trim();
      if (!state.email || !/^\d{6}$/.test(otp)) {
        setError("Enter the 6-digit code from your email.");
        otpInput.focus();
        return;
      }
      setError("");
      busy(verifyButton, true, "Checking code…", "Confirm code");
      try {
        await window.SidekickCore.apiRequest("/api/password/verify-code", {
          method: "POST",
          body: JSON.stringify({ email: state.email, otp }),
        });
        state.otp = otp;
        setStatus("");
        showStep("password");
        passwordInput.focus();
      } catch (error) {
        setError(error.message || "Invalid or expired code. Please try again.");
        otpInput.value = "";
        otpInput.focus();
      } finally {
        busy(verifyButton, false, "Checking code…", "Confirm code");
      }
    }

    async function savePassword() {
      const password = String(passwordInput.value || "");
      const confirmation = String(confirmInput.value || "");
      if (password.length < 8) {
        setError("Password must be at least 8 characters.");
        passwordInput.focus();
        return;
      }
      if (password !== confirmation) {
        setError("Passwords do not match. Please type the same password twice.");
        confirmInput.focus();
        return;
      }
      if (!state.email || !state.otp) {
        showStep("code");
        setError("Confirm your code first.");
        return;
      }
      setError("");
      busy(saveButton, true, "Saving…", "Change password");
      try {
        await window.SidekickCore.apiRequest("/api/password/reset", {
          method: "POST",
          body: JSON.stringify({ email: state.email, otp: state.otp, password }),
        });
        const email = state.email;
        close("Your password was changed. Log in with your new password.");
        const loginEmail = $("login-email");
        if (loginEmail) loginEmail.value = email;
        $("login-password")?.focus();
      } catch (error) {
        const message = error.message || "Unable to change the password right now.";
        if (/code|expired/i.test(message)) {
          state.otp = "";
          otpInput.value = "";
          showStep("code");
        }
        setError(message);
      } finally {
        busy(saveButton, false, "Saving…", "Change password");
      }
    }

    link.addEventListener("click", (event) => {
      event.preventDefault();
      open();
    });
    sendButton.addEventListener("click", () => { void sendCode(sendButton, "Send code"); });
    resendButton.addEventListener("click", () => { void sendCode(resendButton, "Resend code"); });
    verifyButton.addEventListener("click", () => { void verifyCode(); });
    otpInput.addEventListener("otp-complete", () => { void verifyCode(); });
    saveButton.addEventListener("click", () => { void savePassword(); });
    $("reset-change-email").addEventListener("click", () => {
      state.email = "";
      setStatus("");
      showStep("email");
      emailInput.focus();
    });
    $("reset-back-to-login").addEventListener("click", () => close());
    emailInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); void sendCode(sendButton, "Send code"); }
    });
    confirmInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); void savePassword(); }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
