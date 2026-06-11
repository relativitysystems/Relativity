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

  // 9. Knowledge Base
  const kbFileInput    = document.getElementById('kb-file-input');
  const kbUploadBtn    = document.getElementById('kb-upload-btn');
  const kbUploadStatus = document.getElementById('kb-upload-status');
  const kbDocsList     = document.getElementById('kb-docs-list');
  const kbDocsCount    = document.getElementById('kb-docs-count');
  const kbQueryInput   = document.getElementById('kb-query-input');
  const kbAskBtn       = document.getElementById('kb-ask-btn');
  const kbAnswerArea   = document.getElementById('kb-answer-area');
  const kbAnswerText   = document.getElementById('kb-answer-text');
  const kbSourcesArea  = document.getElementById('kb-sources-area');
  const kbSourcesList  = document.getElementById('kb-sources-list');

  loadDocuments();

  kbUploadBtn.addEventListener('click', () => kbFileInput.click());
  kbFileInput.addEventListener('change', () => {
    if (kbFileInput.files[0]) uploadDocument(kbFileInput.files[0]);
  });

  kbAskBtn.addEventListener('click', askQuestion);
  kbQueryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') askQuestion();
  });

  kbDocsList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-kb-delete');
    if (!btn) return;

    const sourceFileId = btn.dataset.sourceId;
    const name = btn.dataset.name;
    if (!confirm(`Delete "${name}" from your knowledge base? This cannot be undone.`)) return;

    btn.disabled = true;
    btn.textContent = 'Deleting…';

    try {
      const res = await fetch(`/api/knowledge/document/${encodeURIComponent(sourceFileId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        loadDocuments();
      } else {
        const body = await res.json().catch(() => ({}));
        showBanner('error', body.error || 'Failed to delete document.');
        btn.disabled = false;
        btn.textContent = 'Delete';
      }
    } catch {
      showBanner('error', 'Network error. Please try again.');
      btn.disabled = false;
      btn.textContent = 'Delete';
    }
  });

  async function loadDocuments() {
    kbDocsList.innerHTML = `<div class="empty-state"><span>Loading…</span></div>`;

    try {
      const res = await fetch('/api/knowledge/documents', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        kbDocsList.innerHTML = `<div class="empty-state"><span>Failed to load documents.</span></div>`;
        return;
      }

      const data = await res.json();
      const documents = data.documents || data || [];

      if (!documents.length) {
        kbDocsCount.textContent = '';
        kbDocsList.innerHTML = `<div class="empty-state"><span>No documents indexed yet. Upload your first document above.</span></div>`;
        return;
      }

      kbDocsCount.textContent = `${documents.length} document${documents.length === 1 ? '' : 's'}`;
      kbDocsList.innerHTML = documents.map(renderDocRow).join('');
    } catch {
      kbDocsList.innerHTML = `<div class="empty-state"><span>Failed to load documents.</span></div>`;
    }
  }

  function renderDocRow(doc) {
    const status = doc.status || 'indexing';
    const badgeClass = { indexed: 'badge--indexed', indexing: 'badge--indexing', failed: 'badge--failed' }[status] || 'badge--indexing';
    const badge = `<span class="badge ${badgeClass}">${escHtml(status)}</span>`;

    const fileName = doc.fileName || doc.file_name || doc.name || 'Untitled';
    const sourceFileId = doc.sourceFileId || doc.source_file_id || doc.id || '';
    const date = doc.created_at
      ? new Date(doc.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';

    return `
      <div class="kb-doc-row">
        <div class="kb-doc-info">
          <span class="kb-doc-name" title="${escHtml(fileName)}">${escHtml(fileName)}</span>
          ${date ? `<span class="kb-doc-meta">${date}</span>` : ''}
        </div>
        ${badge}
        <button class="btn-kb-delete" data-source-id="${escHtml(sourceFileId)}" data-name="${escHtml(fileName)}">Delete</button>
      </div>
    `;
  }

  async function uploadDocument(file) {
    kbUploadStatus.textContent = `Uploading "${file.name}"…`;
    kbUploadStatus.className = 'kb-upload-status';
    kbUploadStatus.hidden = false;
    kbUploadBtn.disabled = true;
    kbFileInput.value = '';

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/knowledge/upload', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: formData,
      });

      if (res.ok) {
        kbUploadStatus.textContent = `"${file.name}" uploaded. Indexing in progress…`;
        kbUploadStatus.className = 'kb-upload-status kb-upload-status--success';
        loadDocuments();
      } else {
        const body = await res.json().catch(() => ({}));
        kbUploadStatus.textContent = body.error || 'Upload failed. Please try again.';
        kbUploadStatus.className = 'kb-upload-status kb-upload-status--error';
      }
    } catch {
      kbUploadStatus.textContent = 'Network error. Please try again.';
      kbUploadStatus.className = 'kb-upload-status kb-upload-status--error';
    }

    kbUploadBtn.disabled = false;
  }

  async function askQuestion() {
    const query = kbQueryInput.value.trim();
    if (!query) return;

    kbAskBtn.disabled = true;
    kbAskBtn.textContent = '…';
    kbAnswerArea.hidden = true;

    try {
      const res = await fetch('/api/knowledge/query', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query }),
      });

      const body = await res.json().catch(() => ({}));

      kbAnswerText.textContent = res.ok ? (body.answer || 'No answer returned.') : (body.error || 'Failed to get an answer.');
      kbAnswerArea.hidden = false;

      const sources = body.sources || [];
      if (res.ok && sources.length) {
        kbSourcesList.innerHTML = sources.map(s => {
          const name = typeof s === 'string' ? s : (s.fileName || s.file_name || s.name || String(s));
          return `<li class="kb-source-item">${escHtml(name)}</li>`;
        }).join('');
        kbSourcesArea.hidden = false;
      } else {
        kbSourcesArea.hidden = true;
      }
    } catch {
      kbAnswerText.textContent = 'Network error. Please try again.';
      kbAnswerArea.hidden = false;
      kbSourcesArea.hidden = true;
    }

    kbAskBtn.disabled = false;
    kbAskBtn.textContent = 'Ask';
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 10. Logout button
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
