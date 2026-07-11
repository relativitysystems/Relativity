(async () => {
  let supabase = null;
  let inviteToken = null;
  let inviteEmail = null;
  let inviteRole = null;
  let inviteClientName = null;
  let acceptingInvite = false;

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

  // ── Shared accept-and-redirect flow, used by the manual button,
  //    the auto-accept-after-confirmation path, and the "already
  //    accepted, session still valid" recovery path. Guarded by
  //    acceptingInvite so an auto-trigger and a manual click can't
  //    both fire a request at once. ─────────────────────────────
  async function tryAcceptAndRedirect(session, { auto = false } = {}) {
    if (acceptingInvite) return;
    acceptingInvite = true;

    const btn = $('acceptBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = auto ? 'Finishing setup…' : 'Accepting…';
    }
    clearError('loginError');

    try {
      await acceptInvite(session.access_token);
      window.location.href = '/portal.html';
    } catch (err) {
      showError('loginError', err.message || 'Could not accept invite. Please try again.');
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Accept Invitation';
      }
      acceptingInvite = false;
    }
  }

  // ── If a session already resolves this invite's email, try to finish
  //    silently (used for the "already accepted" verify response, where a
  //    prior tab/attempt may have already linked this same browser). ────
  async function tryResumeAlreadyAccepted(candidateEmail) {
    const { data: { session: existingSession } } = await supabase.auth.getSession();
    if (!existingSession?.user) return false;
    if (existingSession.user.email.toLowerCase() !== candidateEmail.toLowerCase()) return false;
    if (acceptingInvite) return true;

    acceptingInvite = true;
    try {
      await acceptInvite(existingSession.access_token);
      window.location.href = '/portal.html';
      return true;
    } catch {
      acceptingInvite = false;
      return false;
    }
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
    // An "already accepted" invite might just mean this same browser
    // already finished the flow (e.g. the confirmation link was opened
    // twice) — if the current session matches, resume straight to the
    // portal instead of dead-ending on an error screen.
    if (verifyData.reason === 'already_accepted' && verifyData.email) {
      const resumed = await tryResumeAlreadyAccepted(verifyData.email);
      if (resumed) return;
    }

    showState('invalidState');
    const messages = {
      revoked: 'This invitation has been revoked. Contact the team admin for a new invite.',
      already_accepted: 'This invitation has already been accepted. Try logging in.',
      expired: 'This invitation has expired. Ask the team admin to resend it.',
      not_found: 'Invite not found. Please check your email for the correct link.',
    };
    $('invalidMessage').textContent = messages[verifyData.reason] || 'This invite link is invalid.';
    const signInLink = $('invalidSignInLink');
    if (signInLink) signInLink.hidden = verifyData.reason !== 'already_accepted';
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
    } else {
      // Matching account already signed in — finish automatically rather
      // than making the user click "Accept Invitation" again.
      tryAcceptAndRedirect(session, { auto: true });
    }
  } else {
    // New user — show signup form by default
    showState('signupContainer');
    $('companyNameSignup').textContent = inviteClientName;
    $('signupSubtext').textContent = `You've been invited as a ${roleLabel(inviteRole)}. Create an account to get started.`;
    $('signupEmail').value = inviteEmail;
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
      const confirmationRedirectUrl =
        `${window.location.origin}/invite-team.html?token=${encodeURIComponent(inviteToken)}`;

      const { data, error } = await supabase.auth.signUp({
        email: inviteEmail,
        password,
        options: {
          emailRedirectTo: confirmationRedirectUrl,
          data: {
            full_name: name,
          },
        },
      });

      if (error) throw error;
      if (!data.session) {
        // Email confirmation required
        showError('signupError', 'Check your email to confirm your account. Clicking the confirmation link will bring you back here and finish joining automatically.');
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
    const { data: { session: s } } = await supabase.auth.getSession();
    await tryAcceptAndRedirect(s);
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
