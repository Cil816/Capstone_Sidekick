document.addEventListener("DOMContentLoaded", () => {
  const session = window.SidekickCore?.getAuthSession?.();
  if (session?.email) {
    window.location.href = "dashboard.html";
  }
});

