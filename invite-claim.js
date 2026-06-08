(async function () {
  const configRes = await fetch('/auth/config');
  const { supabaseUrl, supabaseAnonKey } = await configRes.json();
  const supabase = window.supabase.createClient(supabaseUrl, supabaseAnonKey);

  const loadingEl = document.getElementById('loadingState');
  const invalidEl = document.getElementById('invalidState');
  const formContainer = document.getElementById('formContainer');
  const form = document.getElementById('setPasswordForm');
  const errorEl = document.getElementById('inviteError');
  const btn = document.getElementById('setPasswordBtn');

  function showForm() {
    loadingEl.hidden = true;
    formContainer.hidden = false;
  }

  function showInvalid() {
    loadingEl.hidden = true;
    invalidEl.hidden = false;
  }

  // Supabase processes the invite hash async — listen for the auth state change
  let resolved = false;

  supabase.auth.onAuthStateChange((event, session) => {
    if (resolved) return;
    resolved = true;
    if (session) {
      showForm();
    } else {
      showInvalid();
    }
  });

  // Also try immediately (covers cases where session already exists in storage)
  const { data: { session } } = await supabase.auth.getSession();
  if (!resolved) {
    resolved = true;
    if (session) {
      showForm();
    } else {
      // Give the hash-processing listener a moment before giving up
      setTimeout(() => {
        if (loadingEl && !loadingEl.hidden) showInvalid();
      }, 3000);
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Setting up account…';
    errorEl.hidden = true;

    const password = document.getElementById('password').value;
    const confirm = document.getElementById('confirmPassword').value;

    if (password !== confirm) {
      errorEl.textContent = 'Passwords do not match.';
      errorEl.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Create Account';
      return;
    }

    if (password.length < 8) {
      errorEl.textContent = 'Password must be at least 8 characters.';
      errorEl.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Create Account';
      return;
    }

    // Set the password on the Supabase auth user
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      errorEl.textContent = updateError.message;
      errorEl.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Create Account';
      return;
    }

    // Get fresh session token after password update
    const { data: { session: freshSession } } = await supabase.auth.getSession();
    if (!freshSession) {
      errorEl.textContent = 'Session expired. Please use the invite link again.';
      errorEl.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Create Account';
      return;
    }

    // Link the auth user to the client record on the server
    const res = await fetch('/auth/complete-invite', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${freshSession.access_token}` },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      errorEl.textContent = body.error || 'Failed to complete account setup.';
      errorEl.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Create Account';
      return;
    }

    window.location.href = '/portal.html';
  });
})();
