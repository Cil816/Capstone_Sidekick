// Sidekick themed dialogs: used instead of the phone's grey alert/confirm/prompt
// boxes so pop-ups match the app. Every function returns a Promise:
//   SidekickUI.confirm(message, options)  -> true / false
//   SidekickUI.alert(message, options)    -> undefined (after OK)
//   SidekickUI.form(options)              -> { field values } / null (cancelled)
//   SidekickUI.toast(message)             -> undefined (shows a short bubble)
(function () {
  const ICONS = {
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
    question: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>',
    danger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  };

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  let openCount = 0;

  // Builds the dialog, wires buttons/keys, and resolves with onClose's value.
  function open({ tone = "info", icon, title, message, details, fieldsHtml = "", confirmText = "OK", cancelText = null, readValue, validate }) {
    return new Promise((resolve) => {
      const previousFocus = document.activeElement;
      const root = document.createElement("div");
      root.className = `sk-dialog${tone === "danger" ? " is-danger" : ""}`;
      const titleId = `sk-dialog-title-${Date.now()}`;
      const detailsHtml = Array.isArray(details) && details.length
        ? `<ul class="sk-dialog-details">${details.map(([label, value]) => `<li><span>${esc(label)}</span><strong>${esc(value)}</strong></li>`).join("")}</ul>`
        : "";
      root.innerHTML = `
        <div class="sk-dialog-backdrop" data-sk-cancel="1"></div>
        <div class="sk-dialog-panel" role="${cancelText ? "alertdialog" : "dialog"}" aria-modal="true" aria-labelledby="${titleId}">
          <div class="sk-dialog-icon" aria-hidden="true">${ICONS[icon || (tone === "danger" ? "danger" : "info")] || ICONS.info}</div>
          <h2 class="sk-dialog-title" id="${titleId}">${esc(title || "Sidekick")}</h2>
          ${message ? `<p class="sk-dialog-message">${esc(message)}</p>` : ""}
          ${detailsHtml}
          ${fieldsHtml ? `<form class="sk-dialog-form" novalidate>${fieldsHtml}</form>` : ""}
          <p class="sk-dialog-error" role="alert" hidden></p>
          <div class="sk-dialog-actions">
            ${cancelText ? `<button type="button" class="btn btn-outline" data-sk-cancel="1">${esc(cancelText)}</button>` : ""}
            <button type="button" class="btn ${tone === "danger" ? "btn-danger" : "btn-primary"}" data-sk-ok="1">${esc(confirmText)}</button>
          </div>
        </div>`;

      const errorEl = root.querySelector(".sk-dialog-error");
      const okBtn = root.querySelector("[data-sk-ok]");
      let done = false;

      function close(value) {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", onKey, true);
        root.remove();
        openCount = Math.max(0, openCount - 1);
        if (!openCount) document.documentElement.style.removeProperty("overflow");
        try { previousFocus?.focus?.({ preventScroll: true }); } catch (error) {}
        resolve(value);
      }

      function submit() {
        const value = readValue ? readValue(root) : true;
        const problem = validate ? validate(value) : "";
        if (problem) {
          errorEl.textContent = problem;
          errorEl.hidden = false;
          return;
        }
        close(value);
      }

      function onKey(event) {
        if (event.key === "Escape") {
          event.preventDefault();
          close(cancelText ? (readValue ? null : false) : undefined);
        } else if (event.key === "Enter" && event.target?.tagName !== "BUTTON" && root.contains(event.target)) {
          event.preventDefault();
          submit();
        } else if (event.key === "Tab") {
          // Keep keyboard focus inside the dialog.
          const focusable = [...root.querySelectorAll("button, input, select")].filter((el) => !el.disabled);
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }

      root.addEventListener("click", (event) => {
        if (event.target.closest("[data-sk-ok]")) submit();
        else if (event.target.closest("[data-sk-cancel]")) close(cancelText ? (readValue ? null : false) : undefined);
      });
      root.querySelector("form")?.addEventListener("submit", (event) => { event.preventDefault(); submit(); });
      document.addEventListener("keydown", onKey, true);

      document.body.appendChild(root);
      openCount += 1;
      document.documentElement.style.overflow = "hidden";
      const firstField = root.querySelector("input, select");
      (firstField || okBtn).focus({ preventScroll: true });
    });
  }

  function confirmDialog(message, options = {}) {
    return open({
      tone: options.tone || "info",
      icon: options.icon || (options.tone === "danger" ? "danger" : "question"),
      title: options.title || "Are you sure?",
      message,
      details: options.details,
      confirmText: options.confirmText || "Continue",
      cancelText: options.cancelText || "Cancel",
    });
  }

  function alertDialog(message, options = {}) {
    return open({
      tone: options.tone || "info",
      icon: options.icon || "info",
      title: options.title || "Heads up",
      message,
      details: options.details,
      confirmText: options.confirmText || "OK",
    });
  }

  // fields: [{ name, label, type: "text"|"number"|"time"|"select", value, placeholder, min, max, hint, options: [[value, label]] }]
  function formDialog(options = {}) {
    const fields = Array.isArray(options.fields) ? options.fields : [];
    const fieldsHtml = fields.map((field, index) => {
      const id = `sk-field-${Date.now()}-${index}`;
      const attrs = [
        `id="${id}"`, `name="${esc(field.name)}"`,
        field.placeholder ? `placeholder="${esc(field.placeholder)}"` : "",
        field.min !== undefined ? `min="${esc(field.min)}"` : "",
        field.max !== undefined ? `max="${esc(field.max)}"` : "",
        field.maxLength ? `maxlength="${esc(field.maxLength)}"` : "",
        field.type === "number" ? 'inputmode="numeric"' : "",
      ].filter(Boolean).join(" ");
      const control = field.type === "select"
        ? `<select ${attrs}>${(field.options || []).map(([value, label]) => `<option value="${esc(value)}"${String(value) === String(field.value ?? "") ? " selected" : ""}>${esc(label)}</option>`).join("")}</select>`
        : `<input type="${esc(field.type || "text")}" value="${esc(field.value ?? "")}" ${attrs} />`;
      return `<div class="sk-dialog-field"><label for="${id}">${esc(field.label)}</label>${control}${field.hint ? `<small>${esc(field.hint)}</small>` : ""}</div>`;
    }).join("");
    return open({
      tone: options.tone || "info",
      icon: options.icon || "edit",
      title: options.title || "Details",
      message: options.message,
      fieldsHtml,
      confirmText: options.confirmText || "Save",
      cancelText: options.cancelText || "Cancel",
      readValue: (root) => Object.fromEntries(fields.map((field) => [field.name, String(root.querySelector(`[name="${CSS.escape(field.name)}"]`)?.value ?? "").trim()])),
      validate: options.validate,
    });
  }

  let toastTimer = null;
  function toast(message, ms = 2200) {
    document.querySelector(".sk-toast")?.remove();
    clearTimeout(toastTimer);
    const el = document.createElement("div");
    el.className = "sk-toast";
    el.setAttribute("role", "status");
    el.textContent = String(message || "");
    document.body.appendChild(el);
    toastTimer = setTimeout(() => el.remove(), ms);
  }

  // ---- Loading screen with the Sidekick logo ------------------------------------
  // Shown while the user waits on an action (logging in, signing up, building a
  // trip...). It is a <dialog> opened with showModal(), so it sits above everything,
  // including other open dialogs. Calls can nest: it closes after the last hide().
  let loaderEl = null;
  let loaderCount = 0;

  function loaderNode() {
    if (loaderEl && loaderEl.isConnected) return loaderEl;
    loaderEl = document.createElement("dialog");
    loaderEl.className = "sk-loader";
    loaderEl.setAttribute("aria-label", "Loading");
    loaderEl.innerHTML = `
      <div class="sk-loader-box" role="status" aria-live="polite">
        <div class="sk-loader-mark" aria-hidden="true">
          <span class="sk-loader-ring"></span>
          <img class="sk-loader-logo" src="assets/sidekick-logo-192.png" alt="" width="60" height="60">
        </div>
        <p class="sk-loader-percent" hidden></p>
        <div class="sk-loader-bar" hidden><span></span></div>
        <p class="sk-loader-text" hidden></p>
        <span class="sr-only">Loading, please wait.</span>
      </div>`;
    // Back / Escape cannot close it while a request is still running.
    loaderEl.addEventListener("cancel", (event) => event.preventDefault());
    document.body.appendChild(loaderEl);
    return loaderEl;
  }

  function setLoadingText(text) {
    const node = loaderNode().querySelector(".sk-loader-text");
    node.textContent = String(text || "");
    node.hidden = !node.textContent;
  }

  // Progress mode (building an itinerary): a percentage, a filling ring and bar, and a
  // line saying what is happening, instead of the spinning ring.
  function setLoadingProgress(percent, label) {
    const el = loaderNode();
    const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    el.classList.add("is-progress");
    el.style.setProperty("--sk-progress", String(value));
    const pct = el.querySelector(".sk-loader-percent");
    pct.textContent = `${value}%`;
    pct.hidden = false;
    el.querySelector(".sk-loader-bar").hidden = false;
    el.querySelector(".sk-loader-box").setAttribute("aria-valuenow", String(value));
    if (label) setLoadingText(label);
  }

  function clearLoadingProgress() {
    if (!loaderEl) return;
    loaderEl.classList.remove("is-progress");
    loaderEl.querySelector(".sk-loader-percent").hidden = true;
    loaderEl.querySelector(".sk-loader-bar").hidden = true;
  }

  function showLoading(text = "") {
    const el = loaderNode();
    loaderCount += 1;
    setLoadingText(text);
    if (!el.open) {
      try { el.showModal(); } catch (error) { el.setAttribute("open", ""); }
    }
  }

  // A page restored with the Back button (back/forward cache) must not come back
  // still showing the loading screen it had while opening the next page.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) hideLoading(true);
  });

  // hide() undoes one show(); hide(true) closes it no matter how many are open.
  function hideLoading(all = false) {
    loaderCount = all ? 0 : Math.max(0, loaderCount - 1);
    if (loaderCount > 0 || !loaderEl) return;
    clearLoadingProgress();
    if (loaderEl.open) {
      try { loaderEl.close(); } catch (error) { loaderEl.removeAttribute("open"); }
    }
  }

  // ---- Skeleton placeholders ------------------------------------------------------
  // Grey shapes shown where content is still loading (instead of "Loading..." text).
  const SR_LOADING = '<span class="sr-only">Loading…</span>';
  const skeleton = {
    // Picture cards like the Home screen's destination cards.
    cards(count = 2, kind = "row") {
      const card = `<div class="sk-skel-card sk-skel-card-${kind}" aria-hidden="true"><div class="sk-skel sk-skel-media"></div><div class="sk-skel-body"><span class="sk-skel sk-skel-line" style="width:70%"></span><span class="sk-skel sk-skel-line sk-skel-line-sm" style="width:45%"></span></div></div>`;
      return SR_LOADING + Array.from({ length: count }, () => card).join("");
    },
    // Rows with a small square and two lines, like hotel and restaurant results.
    list(count = 3) {
      const row = `<div class="sk-skel-row" aria-hidden="true"><span class="sk-skel sk-skel-thumb"></span><span class="sk-skel-row-text"><span class="sk-skel sk-skel-line" style="width:75%"></span><span class="sk-skel sk-skel-line sk-skel-line-sm" style="width:50%"></span></span></div>`;
      return SR_LOADING + Array.from({ length: count }, () => row).join("");
    },
    // A few lines of text.
    lines(count = 2) {
      const widths = ["92%", "78%", "64%", "84%"];
      return SR_LOADING + Array.from({ length: count }, (_, i) => `<span class="sk-skel sk-skel-line" aria-hidden="true" style="width:${widths[i % widths.length]}"></span>`).join("");
    },
  };

  window.SidekickUI = {
    confirm: confirmDialog,
    alert: alertDialog,
    form: formDialog,
    toast,
    loading: { show: showLoading, hide: hideLoading, setText: setLoadingText, progress: setLoadingProgress },
    skeleton,
  };

  // ---- No internet connection ------------------------------------------------------
  // Without internet the whole screen is covered by a "No internet connection"
  // message (instead of half-loaded screens). It closes by itself when the connection
  // is back; screens then finish loading (SidekickCore.apiRequest waits for it).
  const OFFLINE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2l20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 4.17-2.65"/><path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"/><path d="M16.85 11.25a10 10 0 0 1 2.22 1.68"/><path d="M5 13a10 10 0 0 1 5.24-2.76"/><path d="M12 20h.01"/></svg>';
  const isOffline = () => navigator.onLine === false;
  let offlineEl = null;
  let wasOffline = false;

  function showOfflineNotice() {
    if (!isOffline() || !document.body) return;
    wasOffline = true;
    if (offlineEl?.open) return;
    if (!offlineEl || !offlineEl.isConnected) {
      offlineEl = document.createElement("dialog");
      offlineEl.className = "sk-offline";
      offlineEl.setAttribute("aria-labelledby", "sk-offline-title");
      offlineEl.setAttribute("aria-describedby", "sk-offline-message");
      offlineEl.innerHTML = `
        <div class="sk-offline-screen" role="alert">
          <img class="sk-offline-logo" src="assets/sidekick-logo-192.png" alt="" width="64" height="64">
          <div class="sk-offline-icon" aria-hidden="true">${OFFLINE_ICON}</div>
          <h2 class="sk-offline-title" id="sk-offline-title">No internet connection</h2>
          <p class="sk-offline-message" id="sk-offline-message">Sidekick needs the internet to work. Connect to Wi-Fi or turn on mobile data, then try again.</p>
          <button type="button" class="btn btn-primary sk-offline-retry" data-sk-offline-ok>Try again</button>
          <p class="sk-offline-status" aria-live="polite"></p>
        </div>`;
      offlineEl.querySelector("[data-sk-offline-ok]").addEventListener("click", () => {
        if (!isOffline()) { closeOfflineNotice(); return; }
        const status = offlineEl.querySelector(".sk-offline-status");
        status.textContent = "";
        // Re-set on the next frame so a screen reader announces it again.
        requestAnimationFrame(() => { status.textContent = "Still offline. Check your Wi-Fi or mobile data."; });
      });
      // The phone's Back key and Escape can't hide it while there is no connection.
      offlineEl.addEventListener("cancel", (event) => { if (isOffline()) event.preventDefault(); });
      document.body.appendChild(offlineEl);
    }
    offlineEl.querySelector(".sk-offline-status").textContent = "";
    try { offlineEl.showModal(); } catch (error) { offlineEl.setAttribute("open", ""); }
  }

  function closeOfflineNotice() {
    if (!offlineEl?.open) return;
    try { offlineEl.close(); } catch (error) { offlineEl.removeAttribute("open"); }
  }

  window.addEventListener("offline", showOfflineNotice);
  window.addEventListener("online", () => {
    closeOfflineNotice();
    if (wasOffline) toast("You’re back online.");
    wasOffline = false;
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", showOfflineNotice);
  else showOfflineNotice();

  // Pictures that can't load while offline are hidden (the card's placeholder shows
  // instead of a broken image) and load again once the connection is back.
  document.addEventListener("error", (event) => {
    const img = event.target;
    if (!(img instanceof HTMLImageElement) || !isOffline() || img.dataset.skWaiting) return;
    img.dataset.skWaiting = "1";
    img.classList.add("sk-img-waiting");
    window.addEventListener("online", () => {
      delete img.dataset.skWaiting;
      img.classList.remove("sk-img-waiting");
      const src = img.getAttribute("src");
      if (src) { img.removeAttribute("src"); img.setAttribute("src", src); }
    }, { once: true });
  }, true);

  // Pop-ups written inside a screen are moved to the top level of the page, so
  // nothing in the screen's layout can pin them to the bottom of a long page:
  // they always open in front of the user without scrolling.
  function liftPopups() {
    document.querySelectorAll("#destination-modal").forEach((el) => {
      if (el.parentElement !== document.body) document.body.appendChild(el);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", liftPopups);
  else liftPopups();

  // ---- Show / hide password ----------------------------------------------------------
  // Every password box gets an eye button that shows or hides what was typed.
  const EYE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-2.16 3.19"/><path d="M6.61 6.61A17.5 17.5 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.39-1.61"/><path d="M2 2l20 20"/></svg>';

  function addPasswordToggle(input) {
    if (!input || input.dataset.skReveal) return;
    input.dataset.skReveal = "1";
    const wrap = document.createElement("span");
    wrap.className = "sk-pw";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sk-pw-toggle";
    const sync = () => {
      const shown = input.type === "text";
      button.innerHTML = shown ? EYE_OFF_ICON : EYE_ICON;
      button.setAttribute("aria-label", shown ? "Hide password" : "Show password");
      button.setAttribute("aria-pressed", String(shown));
    };
    // Keep the typing position and the keyboard open while switching.
    button.addEventListener("pointerdown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      const start = input.selectionStart;
      const end = input.selectionEnd;
      input.type = input.type === "password" ? "text" : "password";
      sync();
      if (document.activeElement === input && start !== null) {
        try { input.setSelectionRange(start, end); } catch (error) {}
      }
    });
    // Forms that are reset or submitted hide the password again.
    input.form?.addEventListener("reset", () => { input.type = "password"; sync(); });
    input.form?.addEventListener("submit", () => { input.type = "password"; sync(); });
    sync();
    wrap.appendChild(button);
  }

  function enhancePasswords(root = document) {
    root.querySelectorAll('input[type="password"]').forEach(addPasswordToggle);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => enhancePasswords());
  else enhancePasswords();

  // ---- Dark mode button on the sign-in screens ---------------------------------------
  // Pages mark where it goes with data-theme-toggle (Settings keeps its own switch).
  const MOON_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  const SUN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';

  function addThemeToggles() {
    if (!window.SidekickTheme) return;
    document.querySelectorAll("[data-theme-toggle]").forEach((slot) => {
      if (slot.querySelector(".sk-theme-toggle")) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sk-theme-toggle";
      const sync = () => {
        const dark = window.SidekickTheme.get() === "dark";
        button.innerHTML = (dark ? SUN_ICON : MOON_ICON) + `<span>${dark ? "Light" : "Dark"}</span>`;
        button.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
      };
      button.addEventListener("click", () => {
        window.SidekickTheme.set(window.SidekickTheme.get() === "dark" ? "light" : "dark");
        document.querySelectorAll(".sk-theme-toggle").forEach((other) => other.dispatchEvent(new Event("sk-theme-sync")));
      });
      button.addEventListener("sk-theme-sync", sync);
      sync();
      slot.appendChild(button);
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addThemeToggles);
  else addThemeToggles();

  window.SidekickUI.enhancePasswords = enhancePasswords;
})();
