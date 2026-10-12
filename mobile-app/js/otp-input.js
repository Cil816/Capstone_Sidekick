// Turns a code <input data-otp-boxes> into six single-digit boxes.
// The original input stays in the page (as a hidden field) and always holds the
// full code, so existing scripts can keep reading and setting input.value and
// calling input.focus() as before.
(function () {
  const LENGTH = 6;
  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");

  function attach(input) {
    if (!input || input.dataset.otpAttached === "1") return null;
    input.dataset.otpAttached = "1";

    const labels = Array.from(input.labels || []);
    const labelText = labels[0]?.textContent?.trim() || "Verification code";
    const group = document.createElement("div");
    group.className = "otp-boxes";
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", `${labelText}, ${LENGTH} digits`);

    const boxes = [];
    for (let index = 0; index < LENGTH; index += 1) {
      const box = document.createElement("input");
      box.type = "text";
      box.className = "otp-box";
      box.inputMode = "numeric";
      box.pattern = "[0-9]*";
      box.maxLength = LENGTH; // lets a pasted/autofilled code arrive whole, then it is spread out
      box.autocomplete = index === 0 ? "one-time-code" : "off";
      box.id = `${input.id || "otp"}-digit-${index + 1}`;
      box.setAttribute("aria-label", `Digit ${index + 1} of ${LENGTH}`);
      boxes.push(box);
      group.appendChild(box);
    }

    function currentCode() {
      return boxes.map((box) => box.value).join("");
    }

    function sync() {
      const code = currentCode();
      valueDescriptor.set.call(input, code);
      group.classList.toggle("complete", code.length === LENGTH);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (code.length === LENGTH) input.dispatchEvent(new CustomEvent("otp-complete", { bubbles: true, detail: { code } }));
    }

    // Writes digits starting at `start`; returns the index of the box to focus next.
    function fill(digits, start) {
      let index = start;
      for (const digit of digits) {
        if (index >= LENGTH) break;
        boxes[index].value = digit;
        index += 1;
      }
      return Math.min(index, LENGTH - 1);
    }

    boxes.forEach((box, index) => {
      let previous = "";
      box.addEventListener("focus", () => {
        previous = box.value;
        box.select();
      });
      box.addEventListener("input", () => {
        const digits = box.value.replace(/\D/g, "");
        if (!digits) {
          box.value = "";
          previous = "";
          sync();
          return;
        }
        if (digits.length === 1) {
          box.value = digits;
        } else if (digits.length >= LENGTH) {
          // A whole code (autofill or paste) – spread it from the first box.
          boxes.forEach((item) => { item.value = ""; });
          const next = fill(digits.slice(0, LENGTH), 0);
          previous = boxes[index].value;
          sync();
          boxes[next].focus();
          return;
        } else {
          // Typed over an existing digit: keep the newly typed one.
          const typed = digits.startsWith(previous) && previous ? digits.slice(previous.length) : digits;
          box.value = typed.slice(-1);
        }
        previous = box.value;
        sync();
        if (index < LENGTH - 1) boxes[index + 1].focus();
      });
      box.addEventListener("keydown", (event) => {
        if (event.key === "Backspace" && !box.value && index > 0) {
          event.preventDefault();
          boxes[index - 1].value = "";
          sync();
          boxes[index - 1].focus();
        } else if (event.key === "ArrowLeft" && index > 0) {
          event.preventDefault();
          boxes[index - 1].focus();
        } else if (event.key === "ArrowRight" && index < LENGTH - 1) {
          event.preventDefault();
          boxes[index + 1].focus();
        }
      });
      box.addEventListener("paste", (event) => {
        const text = event.clipboardData?.getData("text") || "";
        const digits = text.replace(/\D/g, "");
        if (!digits) return;
        event.preventDefault();
        const start = digits.length >= LENGTH ? 0 : index;
        if (start === 0) boxes.forEach((item) => { item.value = ""; });
        const next = fill(digits.slice(0, LENGTH), start);
        sync();
        boxes[next].focus();
      });
    });

    // Point the field's label at the first box.
    labels.forEach((label) => { label.htmlFor = boxes[0].id; });

    // Keep the original field as the hidden source of truth.
    const initial = String(valueDescriptor.get.call(input) || "").replace(/\D/g, "").slice(0, LENGTH);
    input.removeAttribute("required");
    input.removeAttribute("pattern");
    input.type = "hidden";
    input.insertAdjacentElement("beforebegin", group);

    Object.defineProperty(input, "value", {
      configurable: true,
      get() {
        return valueDescriptor.get.call(input);
      },
      set(next) {
        const digits = String(next ?? "").replace(/\D/g, "").slice(0, LENGTH);
        boxes.forEach((box, index) => { box.value = digits[index] || ""; });
        valueDescriptor.set.call(input, digits);
        group.classList.toggle("complete", digits.length === LENGTH);
      },
    });
    input.focus = () => {
      (boxes.find((box) => !box.value) || boxes[LENGTH - 1]).focus();
    };
    input.value = initial;

    return { group, boxes };
  }

  window.SidekickOtp = { attach };
  // Scripts load at the end of <body>, so the fields already exist.
  document.querySelectorAll("input[data-otp-boxes]").forEach(attach);
})();
