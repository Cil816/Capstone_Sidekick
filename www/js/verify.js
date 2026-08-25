const params = new URLSearchParams(window.location.search);
const email = window.SidekickCore.normalizeEmail(params.get("email"));
const emailEl = document.getElementById("verify-email");
const form = document.getElementById("verify-form");
const otpEl = document.getElementById("verify-otp");
const errorEl = document.getElementById("auth-error");
const resendButton = document.getElementById("resend-otp");

emailEl.textContent = email || "your email";

function showMessage(message) {
  errorEl.textContent = message;
  errorEl.removeAttribute("hidden");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorEl.setAttribute("hidden", "hidden");
  const otp = otpEl.value.trim();
  if (!email || !/^\d{6}$/.test(otp)) {
    showMessage("Invalid or expired code. Please try again.");
    return;
  }

  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  button.textContent = "Verifying...";
  try {
    const result = await window.SidekickCore.apiRequest("/api/verify-otp", {
      method: "POST",
      body: JSON.stringify({ email, otp }),
    });
    window.SidekickCore.setAuthSession({
      email: result.user.email,
      name: result.user.name,
      loggedInAt: Date.now(),
    });
    const destination = window.SidekickCore.getPreferences() ? "dashboard.html" : "onboarding.html";
    window.location.href = destination;
  } catch (error) {
    showMessage(error.message || "Invalid or expired code. Please try again.");
  } finally {
    button.disabled = false;
    button.textContent = "Verify email";
  }
});

resendButton.addEventListener("click", async () => {
  errorEl.setAttribute("hidden", "hidden");
  resendButton.disabled = true;
  try {
    await window.SidekickCore.apiRequest("/api/resend-otp", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    showMessage("A new verification code has been sent.");
  } catch (error) {
    showMessage(error.message || "Unable to resend the code.");
  } finally {
    resendButton.disabled = false;
  }
});
