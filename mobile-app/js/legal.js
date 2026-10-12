// Shared behaviour for the legal pages.
(function () {
  const params = new URLSearchParams(window.location.search);
  // Shown inside the registration dialog: hide the back link and page links.
  if (params.get("embed") === "1") document.documentElement.classList.add("legal-embedded");

  const back = document.querySelector(".legal-back");
  if (back) {
    back.addEventListener("click", (event) => {
      // Return to the page the user came from when there is one in this app.
      if (window.history.length > 1 && document.referrer && new URL(document.referrer, window.location.href).origin === window.location.origin) {
        event.preventDefault();
        window.history.back();
      }
    });
  }
})();
