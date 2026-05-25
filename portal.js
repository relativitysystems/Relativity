/**
 * portal.js — Client Integration Portal
 *
 * On load, reads URL params to:
 *   - Show success/error banners after OAuth redirects
 *   - Update button states to "Connected" if a service was just linked
 *
 * No secrets live here — this file is served publicly.
 * Token storage and API calls happen entirely on the backend.
 */

(function () {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get('connected'); // e.g. 'dropbox'
  const error = params.get('error');         // e.g. 'dropbox_denied'

  // Show success banner and update card if a service was just connected
  if (connected) {
    const bannerSuccess = document.getElementById('bannerSuccess');
    const bannerText = document.getElementById('bannerSuccessText');
    const serviceNames = { dropbox: 'Dropbox', google_drive: 'Google Drive', slack: 'Slack' };
    const name = serviceNames[connected] || connected;

    bannerText.textContent = `${name} connected successfully. Your automations are ready.`;
    bannerSuccess.hidden = false;

    markConnected(connected);

    // Clean the URL so refreshing doesn't re-show the banner
    window.history.replaceState({}, '', '/portal.html');
  }

  // Show error banner
  if (error) {
    const bannerError = document.getElementById('bannerError');
    const bannerText = document.getElementById('bannerErrorText');
    const messages = {
      dropbox_denied: 'Dropbox authorization was cancelled. Click "Connect Dropbox" to try again.',
      dropbox_failed: 'Something went wrong connecting Dropbox. Please try again or contact support.',
    };
    bannerText.textContent = messages[error] || 'Connection failed. Please try again.';
    bannerError.hidden = false;

    window.history.replaceState({}, '', '/portal.html');
  }

  /**
   * Switch a card's button from "Connect" to "Connected" state.
   * Called after a successful OAuth flow.
   */
  function markConnected(provider) {
    const btn = document.getElementById(`btn-${provider}`);
    const statusDot = document.querySelector(`#card-${provider} .status-dot`);
    const statusText = document.querySelector(`#card-${provider} .status-text`);

    if (btn) {
      btn.textContent = 'Connected';
      btn.className = 'btn btn-connected';
      btn.removeAttribute('href'); // disable further clicks
    }

    if (statusDot) {
      statusDot.className = 'status-dot status-dot--connected';
    }

    if (statusText) {
      statusText.textContent = 'Connected';
    }
  }
})();
