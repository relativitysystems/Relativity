(async function () {
  // 1. Fetch Supabase public config from server (never hardcode keys in frontend)
  const configRes = await fetch('/auth/config');
  const { supabaseUrl, supabaseAnonKey } = await configRes.json();
  const supabase = window.supabase.createClient(supabaseUrl, supabaseAnonKey);

  // 2. Guard: redirect to login if there is no active session
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = '/login.html';
    return;
  }

  const accessToken = session.access_token;

  // 3. Identify client from server-side JWT resolution
  const meRes = await fetch('/auth/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const me = await meRes.json();

  if (!me.authenticated) {
    window.location.href = '/login.html';
    return;
  }

  const { clientId, clientName, email, dropboxConnected, slackConnected, googleDriveConnected } = me;

  // 4. Show initial connection state
  if (dropboxConnected) markConnected('dropbox');
  if (slackConnected) markConnected('slack');
  if (googleDriveConnected) markConnected('google_drive');

  // 5. Handle post-OAuth redirect params (no clientId in URL)
  const params = new URLSearchParams(window.location.search);
  const connected = params.get('connected');
  const error = params.get('error');

  if (connected) {
    const serviceNames = { dropbox: 'Dropbox', google_drive: 'Google Drive', slack: 'Slack' };
    const name = serviceNames[connected] || connected;
    showBanner('success', `${name} connected successfully. Your automations are ready.`);
    markConnected(connected);
    window.history.replaceState({}, '', '/portal.html');
  }

  if (error) {
    const messages = {
      dropbox_denied: 'Dropbox authorization was cancelled. Click "Connect" to try again.',
      dropbox_failed: 'Something went wrong connecting Dropbox. Please try again or contact support.',
      slack_denied: 'Slack authorization was cancelled. Click "Connect" to try again.',
      slack_failed: 'Something went wrong connecting Slack. Please try again or contact support.',
      google_drive_denied: 'Google Drive authorization was cancelled. Click "Connect" to try again.',
      google_drive_failed: 'Something went wrong connecting Google Drive. Please try again or contact support.',
    };
    showBanner('error', messages[error] || 'Connection failed. Please try again.');
    window.history.replaceState({}, '', '/portal.html');
  }

  // 6. Wire Dropbox connect button — uses fetch + bearer token instead of a plain link
  const dropboxBtn = document.getElementById('btn-dropbox');
  if (dropboxBtn && !dropboxConnected) {
    dropboxBtn.removeAttribute('href');
    dropboxBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const res = await fetch('/auth/dropbox/start', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) throw new Error('Failed to start Dropbox auth');
        const { url } = await res.json();
        window.location.href = url;
      } catch (err) {
        showBanner('error', 'Could not start Dropbox connection. Please try again.');
        console.error('Dropbox start error:', err.message);
      }
    });
  }

  // 7. Wire Slack connect button
  const slackBtn = document.getElementById('btn-slack');
  if (slackBtn && !slackConnected) {
    slackBtn.removeAttribute('href');
    slackBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const res = await fetch('/auth/slack/start', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) throw new Error('Failed to start Slack auth');
        const { url } = await res.json();
        window.location.href = url;
      } catch (err) {
        showBanner('error', 'Could not start Slack connection. Please try again.');
        console.error('Slack start error:', err.message);
      }
    });
  }

  // 8. Wire Google Drive connect button
  const googleDriveBtn = document.getElementById('btn-google_drive');
  if (googleDriveBtn && !googleDriveConnected) {
    googleDriveBtn.removeAttribute('href');
    googleDriveBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      try {
        const res = await fetch('/auth/google/start', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) throw new Error('Failed to start Google Drive auth');
        const { url } = await res.json();
        window.location.href = url;
      } catch (err) {
        showBanner('error', 'Could not start Google Drive connection. Please try again.');
        console.error('Google Drive start error:', err.message);
      }
    });
  }

  // 9. Logout button
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await supabase.auth.signOut();
      window.location.href = '/login.html';
    });
  }

  // 10. Request handler (uses client name + email instead of clientId)
  window.openRequest = function (type) {
    const subjects = {
      'new-automation': 'New Automation Request',
      'report-issue': 'Issue Report',
      'kb-update': 'Knowledge Base Update Request',
      'workflow-change': 'Workflow Change Request',
    };
    const subject = subjects[type] || 'Portal Request';
    const body = `Client: ${clientName}\nEmail: ${email}\n\n`;
    window.location.href = `mailto:info@relativitysystems.ai?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  // --- Helpers ---

  function markConnected(provider) {
    const btn = document.getElementById(`btn-${provider}`);
    const card = document.getElementById(`card-${provider}`);
    const statusDot = card && card.querySelector('.status-dot');
    const statusText = card && card.querySelector('.status-text');

    if (btn) {
      btn.textContent = 'Connected';
      btn.className = 'btn-integration btn-integration--connected';
      btn.removeAttribute('href');
    }
    if (statusDot) statusDot.className = 'status-dot status-dot--connected';
    if (statusText) statusText.textContent = 'Connected';
  }

  function showBanner(type, message) {
    const banner = document.getElementById(type === 'success' ? 'bannerSuccess' : 'bannerError');
    const text = document.getElementById(type === 'success' ? 'bannerSuccessText' : 'bannerErrorText');
    if (banner && text) {
      text.textContent = message;
      banner.hidden = false;
    }
  }

})();
