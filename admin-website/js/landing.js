// Landing page: the User Manual pop-up. It shows the PDF inside the page where the browser
// can (computers); phones, which can't show a PDF inside a page, open it directly instead.
(function () {
  'use strict';
  var dialog = document.getElementById('lp-manual');
  var frame = document.getElementById('lp-manual-frame');
  if (!dialog || !frame || typeof dialog.showModal !== 'function') return;
  var canShowPdf = navigator.pdfViewerEnabled === true && !window.matchMedia('(max-width: 700px)').matches;
  document.querySelectorAll('[data-manual-open]').forEach(function (link) {
    link.addEventListener('click', function (event) {
      if (!canShowPdf) return; // the link opens the PDF in a new tab
      event.preventDefault();
      // Loaded only when first opened: the file is several megabytes.
      if (!frame.getAttribute('src')) frame.setAttribute('src', link.getAttribute('href'));
      dialog.showModal();
    });
  });
  dialog.querySelectorAll('[data-manual-close]').forEach(function (button) {
    button.addEventListener('click', function () { dialog.close(); });
  });
  dialog.addEventListener('click', function (event) {
    if (event.target === dialog) dialog.close();
  });
})();

// Landing page: the Contact pop-up. The footer's Contact link opens it (without
// JavaScript the link still opens the visitor's email app), and the form sends the
// message through POST /api/contact.
(function () {
  'use strict';

  var dialog = document.getElementById('lp-contact');
  var form = document.getElementById('lp-contact-form');
  if (!dialog || !form || typeof dialog.showModal !== 'function') return;

  var email = document.getElementById('lp-contact-email');
  var message = document.getElementById('lp-contact-message');
  var count = document.getElementById('lp-contact-count');
  var status = document.getElementById('lp-contact-status');
  var send = document.getElementById('lp-contact-send');
  var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  // True while a message is on its way: closing and reopening the pop-up must not
  // make the Send button usable again, or the same message could be sent twice.
  var sending = false;

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = 'lp-contact-status' + (kind ? ' is-' + kind : '');
  }

  function updateCount() {
    count.textContent = message.value.length.toLocaleString('en-US') + ' / 2,000';
  }

  function open(event) {
    event.preventDefault();
    if (!sending) {
      setStatus('');
      send.disabled = false;
    }
    dialog.showModal();
    email.focus();
  }

  document.querySelectorAll('[data-contact-open]').forEach(function (link) {
    link.addEventListener('click', open);
  });
  dialog.querySelectorAll('[data-contact-close]').forEach(function (button) {
    button.addEventListener('click', function () { dialog.close(); });
  });
  // A click on the dimmed area outside the box closes it.
  dialog.addEventListener('click', function (event) {
    if (event.target === dialog) dialog.close();
  });
  message.addEventListener('input', updateCount);

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (sending) return;
    var from = email.value.trim();
    var text = message.value.trim();
    if (!EMAIL_PATTERN.test(from)) {
      setStatus('Enter a valid email address so we can reply to you.', 'error');
      email.focus();
      return;
    }
    if (text.length < 10) {
      setStatus('Write a message of at least 10 characters.', 'error');
      message.focus();
      return;
    }

    sending = true;
    send.disabled = true;
    setStatus('Sending…');
    fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: from, message: text, website: document.getElementById('lp-contact-website').value }),
    })
      .then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (data) {
          if (!response.ok) throw new Error(data.error || 'Your message couldn’t be sent right now. Please try again later.');
        });
      })
      .then(function () {
        sending = false;
        form.reset();
        updateCount();
        setStatus('Thanks! Your message was sent. We’ll reply to your email.', 'success');
      })
      .catch(function (error) {
        sending = false;
        send.disabled = false;
        // fetch itself fails (TypeError) only when the request never reached the server.
        setStatus(error instanceof TypeError || !error.message
          ? 'Your message couldn’t be sent. Please check your connection and try again.'
          : error.message, 'error');
      });
  });
})();
