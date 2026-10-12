function setRegisterError(message) {
  const error = document.getElementById("auth-error");
  if (!error) return;
  error.textContent = message;
  error.hidden = !message;
}

function setRegisterStatus(message) {
  const status = document.getElementById("registration-status");
  if (!status) return;
  status.textContent = message;
  status.hidden = !message;
}

function setButtonBusy(button, busy, busyText, idleText) {
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? busyText : idleText;
}

function bindRegisterForm() {
  const form = document.getElementById("register-form");
  if (!form || form.dataset.sidekickBound === "1") return;

  const emailStep = document.getElementById("registration-email-step");
  const codeStep = document.getElementById("registration-code-step");
  const detailsStep = document.getElementById("registration-details-step");
  const emailInput = document.getElementById("register-email");
  const otpInput = document.getElementById("registration-otp");
  const nameInput = document.getElementById("register-name");
  const passwordInput = document.getElementById("register-password");
  const confirmPasswordInput = document.getElementById("register-password-confirm");
  const termsInput = document.getElementById("terms-accepted");
  const ageInput = document.getElementById("age-confirmed");
  const requestCodeButton = document.getElementById("send-registration-code");
  const confirmCodeButton = document.getElementById("confirm-registration-code");
  const resendCodeButton = document.getElementById("resend-registration-code");
  const editEmailButton = document.getElementById("edit-registration-email");
  const completeButton = document.getElementById("complete-registration");
  let verifiedEmail = "";

  function showStep(step) {
    emailStep.hidden = step !== "email";
    codeStep.hidden = step !== "code";
    detailsStep.hidden = step !== "details";
    setRegisterError("");
    setRegisterStatus("");
  }

  async function requestCode() {
    const email = window.SidekickCore.normalizeEmail(emailInput.value);
    if (!emailInput.validity.valid || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setRegisterError("Please enter a valid email address.");
      emailInput.focus();
      return;
    }

    setRegisterError("");
    setRegisterStatus("");
    setButtonBusy(requestCodeButton, true, "Checking email…", "Verify email");
    try {
      const result = await window.SidekickCore.apiRequest("/api/register/start", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      verifiedEmail = result.email || email;
      document.getElementById("registration-code-email").textContent = verifiedEmail;
      otpInput.value = "";
      showStep("code");
      setRegisterStatus("Verification code sent. Check your inbox and spam folder.");
      otpInput.focus();
    } catch (error) {
      setRegisterError(error.message || "Unable to send a verification code. Check the email and try again.");
    } finally {
      setButtonBusy(requestCodeButton, false, "Checking email…", "Verify email");
    }
  }

  requestCodeButton.addEventListener("click", () => { void requestCode(); });

  confirmCodeButton.addEventListener("click", async () => {
    const otp = String(otpInput.value || "").trim();
    if (!verifiedEmail || !/^\d{6}$/.test(otp)) {
      setRegisterError("Enter the 6-digit verification code.");
      otpInput.focus();
      return;
    }

    setRegisterError("");
    setRegisterStatus("");
    setButtonBusy(confirmCodeButton, true, "Checking code…", "Confirm email");
    try {
      await window.SidekickCore.apiRequest("/api/register/verify-code", {
        method: "POST",
        body: JSON.stringify({ email: verifiedEmail, otp }),
      });
      document.getElementById("registration-verified-email").textContent = verifiedEmail;
      showStep("details");
      nameInput.focus();
    } catch (error) {
      setRegisterError(error.message || "Invalid or expired code. Please try again.");
    } finally {
      setButtonBusy(confirmCodeButton, false, "Checking code…", "Confirm email");
    }
  });

  resendCodeButton.addEventListener("click", async () => {
    setRegisterError("");
    setRegisterStatus("");
    setButtonBusy(resendCodeButton, true, "Sending…", "Resend code");
    try {
      await window.SidekickCore.apiRequest("/api/resend-otp", {
        method: "POST",
        body: JSON.stringify({ email: verifiedEmail }),
      });
      otpInput.value = "";
      setRegisterStatus("A new verification code has been sent.");
    } catch (error) {
      setRegisterError(error.message || "Unable to resend the code.");
    } finally {
      setButtonBusy(resendCodeButton, false, "Sending…", "Resend code");
    }
  });

  editEmailButton.addEventListener("click", () => {
    verifiedEmail = "";
    showStep("email");
    emailInput.focus();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (detailsStep.hidden) return;

    const name = String(nameInput.value || "").trim();
    const password = String(passwordInput.value || "");
    const otp = String(otpInput.value || "").trim();
    if (!verifiedEmail || !/^\d{6}$/.test(otp)) {
      showStep("code");
      setRegisterError("Verify your email before continuing.");
      otpInput.focus();
      return;
    }
    if (!name || !password) {
      setRegisterError("Please complete all fields.");
      (!name ? nameInput : passwordInput).focus();
      return;
    }
    if (password.length < 8) {
      setRegisterError("Password must be at least 8 characters.");
      passwordInput.focus();
      return;
    }
    if (confirmPasswordInput && String(confirmPasswordInput.value || "") !== password) {
      setRegisterError("Passwords do not match. Please type the same password twice.");
      confirmPasswordInput.focus();
      return;
    }
    if (ageInput && !ageInput.checked) {
      setRegisterError("You must be 18 or older to use Sidekick. Please confirm your age.");
      ageInput.focus();
      return;
    }
    if (!termsInput.checked) {
      setRegisterError("You must agree to the Terms and Conditions and the Privacy Policy to register.");
      termsInput.focus();
      return;
    }

    setRegisterError("");
    setRegisterStatus("");
    setButtonBusy(completeButton, true, "Creating account…", "Create account");
    try {
      const result = await window.SidekickCore.apiRequest("/api/register/complete", {
        method: "POST",
        body: JSON.stringify({
          email: verifiedEmail,
          otp,
          name,
          password,
          termsAccepted: true,
          ageConfirmed: true,
        }),
      });
      window.SidekickCore.setAuthSession({
        email: result.user.email,
        name: result.user.name,
        apiToken: result.session?.token || "",
        loggedInAt: Date.now(),
      });
      window.location.href = "onboarding.html";
    } catch (error) {
      setRegisterError(error.message || "Registration failed. Please try again.");
      if (/code|verify|expired/i.test(error.message || "")) {
        showStep("code");
        setRegisterError(error.message || "Invalid or expired code. Please request another code.");
        otpInput.focus();
      }
    } finally {
      setButtonBusy(completeButton, false, "Creating account…", "Create account");
    }
  });

  form.dataset.sidekickBound = "1";
  // Show the full Terms or Privacy Policy inside the dialog, so the user keeps
  // their place in the registration steps.
  const openPolicy = (page, title) => {
    const dialog = document.getElementById("terms-dialog");
    const frame = document.getElementById("terms-frame");
    const heading = document.getElementById("terms-dialog-title");
    if (!dialog) return;
    if (heading) heading.textContent = title;
    if (frame) {
      frame.title = title;
      frame.src = `${page}?embed=1`;
    }
    dialog.showModal();
  };
  document.getElementById("terms-link")?.addEventListener("click", () => openPolicy("terms.html", "Terms and Conditions"));
  document.getElementById("privacy-link")?.addEventListener("click", () => openPolicy("privacy.html", "Privacy Policy"));
  document.getElementById("terms-close")?.addEventListener("click", () => {
    document.getElementById("terms-dialog")?.close();
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bindRegisterForm, { once: true });
} else {
  bindRegisterForm();
}
