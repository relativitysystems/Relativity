/**
 * portal.js — Client Integration Portal
 *
 * On load:
 *   1. Reads clientId from ?clientId= URL param
 *   2. Injects clientId into OAuth connect links
 *   3. Calls /api/status/:clientId to show real persistent connection state
 *   4. Handles success/error banners after OAuth redirects
 */

(function () {
  const params = new URLSearchParams(window.location.search);
  const clientId = params.get('clientId');
  const connected = params.get('connected');
  const error = params.get('error');

  // --- 1. Guard: no clientId means this link wasn't personalized ---
  if (!clientId) {
    showBanner('error', 'No client ID found in this link. Please contact Relativity for your personalized portal URL.');
    disableAllButtons();
    return;
  }

  // --- 2. Inject clientId into OAuth links ---
  const dropboxBtn = document.getElementById('btn-dropbox');
  if (dropboxBtn) {
    dropboxBtn.href = `/auth/dropbox/start?clientId=${encodeURIComponent(clientId)}`;
  }

  // --- 3. Handle post-OAuth redirect banners ---
  if (connected) {
    const serviceNames = { dropbox: 'Dropbox', google_drive: 'Google Drive', slack: 'Slack' };
    const name = serviceNames[connected] || connected;
    showBanner('success', `${name} connected successfully. Your automations are ready.`);
    markConnected(connected);
    window.history.replaceState({}, '', `/portal.html?clientId=${clientId}`);
  }

  if (error) {
    const messages = {
      dropbox_denied: 'Dropbox authorization was cancelled. Click "Connect Dropbox" to try again.',
      dropbox_failed: 'Something went wrong connecting Dropbox. Please try again or contact support.',
    };
    showBanner('error', messages[error] || 'Connection failed. Please try again.');
    window.history.replaceState({}, '', `/portal.html?clientId=${clientId}`);
  }

  // --- 4. Check real connection status from backend ---
  // WHY: without this, refreshing the page after connecting Dropbox resets the UI
  // to "Not connected" even though the token is stored in Supabase.
  fetch(`/auth/status/${encodeURIComponent(clientId)}`)
    .then(res => {
      if (!res.ok) throw new Error(`Status ${res.status}`);
      return res.json();
    })
    .then(status => {
      Object.entries(status).forEach(([provider, isConnected]) => {
        if (isConnected) markConnected(provider);
      });
    })
    .catch(err => {
      console.warn('Could not fetch connection status:', err.message);
      // Non-fatal — portal still works, just won't show persistent state
    });

  // --- Helpers ---

  function markConnected(provider) {
    const btn = document.getElementById(`btn-${provider}`);
    const card = document.getElementById(`card-${provider}`);
    const statusDot = card && card.querySelector('.status-dot');
    const statusText = card && card.querySelector('.status-text');

    if (btn) {
      btn.textContent = 'Connected';
      btn.className = 'btn btn-connected';
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

  function disableAllButtons() {
    document.querySelectorAll('.btn-connect').forEach(btn => {
      btn.className = 'btn btn-disabled';
      btn.removeAttribute('href');
    });
  }


})();
