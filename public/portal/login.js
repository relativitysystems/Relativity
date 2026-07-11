(async function () {
  const configRes = await fetch('/auth/config');
  const { supabaseUrl, supabaseAnonKey } = await configRes.json();
  const supabase = window.supabase.createClient(supabaseUrl, supabaseAnonKey);

  const form = document.getElementById('loginForm');
  const errorEl = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');

  const ERROR_MESSAGES = {
    invalid_token: 'Your session expired. Please sign in again.',
    membership_not_found: "Your account is not connected to a client workspace. Please reopen your team invitation link or contact your workspace administrator.",
    membership_disabled: 'This account has been disabled. Please contact your administrator.',
    client_inactive: "This organization's access is currently inactive. Please contact support.",
    session_invalid: 'Your session is no longer valid. Please sign in again.',
  };

  const errorCode = new URLSearchParams(window.location.search).get('error');
  if (errorCode) {
    errorEl.textContent = ERROR_MESSAGES[errorCode] || ERROR_MESSAGES.session_invalid;
    errorEl.hidden = false;
  }

  // If already logged in (and we're not here because of an auth failure), skip straight to portal
  const { data: { session } } = await supabase.auth.getSession();
  if (session && !errorCode) {
    window.location.href = '/portal.html';
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    errorEl.hidden = true;

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
      btn.disabled = false;
      btn.textContent = 'Sign In';
      return;
    }

    window.location.href = '/portal.html';
  });
})();
