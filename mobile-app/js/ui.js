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

  window.SidekickUI = { confirm: confirmDialog, alert: alertDialog, form: formDialog, toast };

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
})();
