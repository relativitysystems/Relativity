(async function () {
  const configRes = await fetch('/auth/config');
  const { supabaseUrl, supabaseAnonKey } = await configRes.json();
  const supabase = window.supabase.createClient(supabaseUrl, supabaseAnonKey);

  const states = ['loadingState', 'invalidState', 'formContainer', 'successState'];
  function show(id) {
    states.forEach(s => { document.getElementById(s).hidden = s !== id; });
  }

  const form      = document.getElementById('resetForm');
  const errorEl   = document.getElementById('resetError');
  const btn       = document.getElementById('resetBtn');

  let resolved = false;

  // Supabase processes the recovery hash on page load and fires PASSWORD_RECOVERY
  supabase.auth.onAuthStateChange((event, session) => {
    if (resolved) return;
    if (event === 'PASSWORD_RECOVERY' && session) {
      resolved = true;
      show('formContainer');
    }
  });

  // Fallback: if already in a session (edge case / page refresh after recovery)
  const { data: { session } } = await supabase.auth.getSession();
  if (!resolved && session) {
    resolved = true;
    show('formContainer');
  }

  // If nothing fires within 4s, the link is invalid or expired
  setTimeout(() => {
    if (!resolved) {
      resolved = true;
      show('invalidState');
    }
  }, 4000);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Updating…';

    const password = document.getElementById('newPassword').value;
    const confirm  = document.getElementById('confirmPassword').value;

    if (password.length < 8) {
      errorEl.textContent = 'Password must be at least 8 characters.';
      errorEl.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Set New Password';
      return;
    }

    if (password !== confirm) {
      errorEl.textContent = 'Passwords do not match.';
      errorEl.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Set New Password';
      return;
    }

    const { error } = await supabase.auth.updateUser({ password });

    if (error) {
      errorEl.textContent = error.message || 'Failed to update password. Please try again.';
      errorEl.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Set New Password';
      return;
    }

    show('successState');
    setTimeout(() => { window.location.href = '/login.html'; }, 2500);
  });
})();
