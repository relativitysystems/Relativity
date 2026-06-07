(async function () {
  const configRes = await fetch('/auth/config');
  const { supabaseUrl, supabaseAnonKey } = await configRes.json();
  const supabase = window.supabase.createClient(supabaseUrl, supabaseAnonKey);

  // If already logged in, skip straight to portal
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    window.location.href = '/portal.html';
    return;
  }

  const form = document.getElementById('loginForm');
  const errorEl = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');

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
