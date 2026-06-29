(function () {
  const form      = document.getElementById('forgotForm');
  const emailInput = document.getElementById('email');
  const btn       = document.getElementById('submitBtn');
  const errorEl   = document.getElementById('formError');
  const successEl = document.getElementById('successMsg');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Sending…';

    const email = emailInput.value.trim();

    try {
      await fetch('/auth/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
    } catch {
      // Network error — still show generic message to avoid leaking information
    }

    // Always show the generic success message regardless of outcome
    form.hidden = true;
    successEl.hidden = false;
  });
})();
