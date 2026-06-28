(async () => {
  let supabase = null;
  let inviteToken = null;
  let inviteEmail = null;
  let inviteRole = null;
  let inviteClientName = null;

  // ── DOM refs ──────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  function showState(id) {
    ['loadingState', 'invalidState', 'signupContainer', 'loginContainer']
      .forEach(s => { $(s).hidden = s !== id; });
  }

  function showError(elementId, msg) {
    const el = $(elementId);
    el.textContent = msg;
    el.hidden = false;
  }

  function clearError(elementId) {
    const el = $(elementId);
    el.textContent = '';
    el.hidden = true;
  }

  function roleLabel(role) {
    return { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' }[role] || role;
  }

  // ── Init Supabase ─────────────────────────────────────────
  const configRes = await fetch('/auth/config');
  const { supabaseUrl, supabaseAnonKey } = await configRes.json();
  supabase = window.supabase.createClient(supabaseUrl, supabaseAnonKey);

  // ── Get invite token from URL ─────────────────────────────
  inviteToken = new URLSearchParams(window.location.search).get('token');
  if (!inviteToken) {
    showState('invalidState');
    $('invalidMessage').textContent = 'No invite token found in the link. Please check your email and try again.';
    return;
  }

  // ── Verify the invite ─────────────────────────────────────
  let verifyData;
  try {
    const res = await fetch(`/api/team/invites/verify?token=${encodeURIComponent(inviteToken)}`);
    verifyData = await res.json();
  } catch {
    showState('invalidState');
    $('invalidMessage').textContent = 'Could not verify the invite. Please try again later.';
    return;
  }

  if (!verifyData.valid) {
    showState('invalidState');
    const messages = {
      revoked: 'This invitation has been revoked. Contact the team admin for a new invite.',
      already_accepted: 'This invitation has already been accepted. Try logging in.',
      expired: 'This invitation has expired. Ask the team admin to resend it.',
      not_found: 'Invite not found. Please check your email for the correct link.',
    };
    $('invalidMessage').textContent = messages[verifyData.reason] || 'This invite link is invalid.';
    return;
  }

  inviteEmail = verifyData.email;
  inviteRole = verifyData.role;
  inviteClientName = verifyData.clientName;

  // ── Check if already logged in ────────────────────────────
  const { data: { session } } = await supabase.auth.getSession();

  if (session?.user) {
    // User is already authenticated
    showState('loginContainer');
    $('companyNameLogin').textContent = inviteClientName;
    $('loginSubtext').textContent = `You've been invited as a ${roleLabel(inviteRole)}.`;
    $('loginEmail').value = inviteEmail;
    $('loggedInEmail').textContent = session.user.email;
    $('alreadyLoggedIn').hidden = false;
    $('loginForm').hidden = true;

    if (session.user.email.toLowerCase() !== inviteEmail.toLowerCase()) {
      $('alreadyLoggedIn').hidden = true;
      $('loginForm').hidden = false;
    }
  } else {
    // New user — show signup form by default
    showState('signupContainer');
    $('companyNameSignup').textContent = inviteClientName;
    $('signupSubtext').textContent = `You've been invited as a ${roleLabel(inviteRole)}. Create an account to get started.`;
    $('signupEmail').value = inviteEmail;
  }

  // ── Accept invite via backend ─────────────────────────────
  async function acceptInvite(accessToken) {
    const res = await fetch('/auth/accept-team-invite', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ inviteToken }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to accept invite');
    }
    return res.json();
  }

  // ── Sign up form ──────────────────────────────────────────
  $('signupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError('signupError');
    const name = $('signupName').value.trim();
    const password = $('signupPassword').value;

    if (!name) return showError('signupError', 'Please enter your full name.');
    if (password.length < 8) return showError('signupError', 'Password must be at least 8 characters.');

    $('signupBtn').disabled = true;
    $('signupBtn').textContent = 'Creating account…';

    try {
      const { data, error } = await supabase.auth.signUp({
        email: inviteEmail,
        password,
        options: { data: { full_name: name } },
      });

      if (error) throw error;
      if (!data.session) {
        // Email confirmation required
        showError('signupError', 'Check your email to confirm your account, then come back and sign in.');
        $('signupBtn').disabled = false;
        $('signupBtn').textContent = 'Create Account & Accept';
        return;
      }

      await acceptInvite(data.session.access_token);
      window.location.href = '/portal.html';
    } catch (err) {
      showError('signupError', err.message || 'Sign-up failed. Please try again.');
      $('signupBtn').disabled = false;
      $('signupBtn').textContent = 'Create Account & Accept';
    }
  });

  // ── Accept button (already logged in) ────────────────────
  $('acceptBtn').addEventListener('click', async () => {
    clearError('loginError');
    $('acceptBtn').disabled = true;
    $('acceptBtn').textContent = 'Accepting…';

    try {
      const { data: { session: s } } = await supabase.auth.getSession();
      await acceptInvite(s.access_token);
      window.location.href = '/portal.html';
    } catch (err) {
      showError('loginError', err.message || 'Could not accept invite. Please try again.');
      $('acceptBtn').disabled = false;
      $('acceptBtn').textContent = 'Accept Invitation';
    }
  });

  // ── Sign in form (existing user on wrong account) ─────────
  $('loginEmail').value = inviteEmail;

  $('signinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError('signinError');
    const password = $('loginPassword').value;
    if (!password) return showError('signinError', 'Password is required.');

    $('signinBtn').disabled = true;
    $('signinBtn').textContent = 'Signing in…';

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: inviteEmail,
        password,
      });
      if (error) throw error;

      await acceptInvite(data.session.access_token);
      window.location.href = '/portal.html';
    } catch (err) {
      showError('signinError', err.message || 'Sign-in failed. Please try again.');
      $('signinBtn').disabled = false;
      $('signinBtn').textContent = 'Sign In & Accept';
    }
  });

  // ── Toggle between signup/login ───────────────────────────
  $('switchToLoginLink').addEventListener('click', (e) => {
    e.preventDefault();
    showState('loginContainer');
    $('companyNameLogin').textContent = inviteClientName;
    $('loginSubtext').textContent = `You've been invited as a ${roleLabel(inviteRole)}.`;
    $('loginEmail').value = inviteEmail;
    $('alreadyLoggedIn').hidden = true;
    $('loginForm').hidden = false;
  });

  $('switchToSignupLink').addEventListener('click', (e) => {
    e.preventDefault();
    showState('signupContainer');
    $('signupEmail').value = inviteEmail;
  });
})();
