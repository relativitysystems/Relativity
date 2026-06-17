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

  const { clientId, clientName, email } = me;

  const identityName = document.getElementById('clientIdentityName');
  const identityId   = document.getElementById('clientIdentityId');
  if (identityName) identityName.textContent = clientName || 'Client';
  if (identityId)   identityId.textContent   = clientId ? `Client ID: ${shortId(clientId)}` : '';

  // 4. Handle post-OAuth redirect params
  const params = new URLSearchParams(window.location.search);
  const connected = params.get('connected');
  const error = params.get('error');

  if (connected) {
    showBanner('success', 'Connection updated successfully.');
    window.history.replaceState({}, '', '/portal.html');
  }

  if (error) {
    showBanner('error', 'Connection failed. Please try again or contact support.');
    window.history.replaceState({}, '', '/portal.html');
  }

  // 5. Knowledge Base
  const kbFileInput       = document.getElementById('kb-file-input');
  const kbUploadBtn       = document.getElementById('kb-upload-btn');
  const kbUploadStatus    = document.getElementById('kb-upload-status');
  const kbDocsList        = document.getElementById('kb-docs-list');
  const kbDocsCount       = document.getElementById('kb-docs-count');
  const kbQueryInput      = document.getElementById('kb-query-input');
  const kbAskBtn          = document.getElementById('kb-ask-btn');
  const kbMessages        = document.getElementById('kb-messages');
  const kbSessionsList    = document.getElementById('kb-sessions-list');
  const kbNewChatBtn      = document.getElementById('kb-new-chat-btn');
  const kbClearHistoryBtn = document.getElementById('kb-clear-history-btn');

  let currentSessionId = null;
  let chatSessions     = [];
  const pendingDeletes = new Set();
  const pendingUploads = new Map();

  // Shared state for onboarding progress — updated as docs and sessions load
  let loadedDocs     = null;
  let loadedSessions = null;

  const MAX_QUERY_HEIGHT = 120;

  function adjustQueryHeight() {
    kbQueryInput.style.height = 'auto';
    const nextHeight = Math.min(kbQueryInput.scrollHeight, MAX_QUERY_HEIGHT);
    kbQueryInput.style.height = `${nextHeight}px`;
    kbQueryInput.style.overflowY = kbQueryInput.scrollHeight > MAX_QUERY_HEIGHT ? 'auto' : 'hidden';
  }

  loadDocuments();
  loadSessions();
  loadJobs();

  kbUploadBtn.addEventListener('click', () => kbFileInput.click());
  kbFileInput.addEventListener('change', () => {
    if (kbFileInput.files[0]) uploadDocument(kbFileInput.files[0]);
  });

  kbAskBtn.addEventListener('click', askQuestion);
  kbQueryInput.addEventListener('input', adjustQueryHeight);
  kbQueryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      askQuestion();
    }
  });

  kbNewChatBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    currentSessionId = null;
    kbMessages.innerHTML = '';
    renderSessions(chatSessions);
    kbQueryInput.focus();
  });

  kbClearHistoryBtn.addEventListener('click', async () => {
    if (!confirm('Clear all chat history? This cannot be undone.')) return;
    try {
      const res = await fetch('/api/knowledge/chat/history', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        chatSessions = [];
        loadedSessions = [];
        currentSessionId = null;
        kbMessages.innerHTML = '';
        renderSessions([]);
        maybeUpdateProgress();
      } else {
        const body = await res.json().catch(() => ({}));
        showBanner('error', body.error || 'Failed to clear history.');
      }
    } catch {
      showBanner('error', 'Network error. Please try again.');
    }
  });

  kbDocsList.addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-kb-delete');
    if (!btn) return;

    const sourceFileId = btn.dataset.sourceId;
    const name = btn.dataset.name;
    if (!confirm(`Delete "${name}" from your knowledge base? This cannot be undone.`)) return;

    // Optimistically hide the document immediately
    pendingDeletes.add(sourceFileId);
    refreshDocuments();

    try {
      const res = await fetch(`/api/knowledge/document/${encodeURIComponent(sourceFileId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (res.ok) {
        // Poll until the document is confirmed gone from the server
        const settled = await pollUntilSettled(async () => {
          const docs = await fetchDocuments();
          if (docs) renderDocuments(docs);
          if (!docs) return false;
          return !docs.find(d => (d.sourceFileId || d.source_file_id) === sourceFileId);
        });
        pendingDeletes.delete(sourceFileId);
        if (!settled) {
          showBanner('error', 'Delete is still processing. Refresh again in a moment.');
        }
        refreshDocuments();
      } else {
        pendingDeletes.delete(sourceFileId);
        const body = await res.json().catch(() => ({}));
        showBanner('error', body.error || 'Failed to delete document.');
        refreshDocuments();
      }
    } catch {
      pendingDeletes.delete(sourceFileId);
      showBanner('error', 'Network error. Please try again.');
      refreshDocuments();
    }
  });

  kbSessionsList.addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('.btn-kb-session-delete');
    if (deleteBtn) {
      const sessionId = deleteBtn.dataset.sessionId;
      if (!confirm('Delete this chat session?')) return;
      try {
        const res = await fetch(`/api/knowledge/chat/sessions/${encodeURIComponent(sessionId)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (res.ok) {
          chatSessions = chatSessions.filter(s => (s.id || s.session_id) !== sessionId);
          loadedSessions = chatSessions;
          if (currentSessionId === sessionId) {
            currentSessionId = null;
            kbMessages.innerHTML = '';
          }
          renderSessions(chatSessions);
          maybeUpdateProgress();
        } else {
          const body = await res.json().catch(() => ({}));
          showBanner('error', body.error || 'Failed to delete session.');
        }
      } catch {
        showBanner('error', 'Network error. Please try again.');
      }
      return;
    }

    const item = e.target.closest('.kb-session-item');
    if (item) {
      const sessionId = item.dataset.sessionId;
      await loadSessionMessages(sessionId);
    }
  });

  async function fetchDocuments() {
    try {
      const res = await fetch('/api/knowledge/documents', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return data.documents || (Array.isArray(data) ? data : []);
    } catch {
      return null;
    }
  }

  function renderDocuments(documents) {
    if (documents === null) {
      kbDocsList.innerHTML = `<div class="empty-state"><span>Failed to load documents.</span></div>`;
      return;
    }

    const visible = documents.filter(d => {
      const id = d.sourceFileId || d.source_file_id || '';
      return !pendingDeletes.has(id);
    });

    const placeholders = [];
    for (const [fileName] of pendingUploads) {
      const alreadySettled = documents.find(d =>
        (d.fileName || d.file_name || d.name) === fileName &&
        (d.status === 'indexed' || d.status === 'failed')
      );
      if (!alreadySettled) {
        placeholders.push({ fileName, status: 'indexing', _isPending: true });
      }
    }

    const rows = [...placeholders, ...visible];

    if (!rows.length) {
      kbDocsCount.textContent = '';
      kbDocsList.innerHTML = `<div class="empty-state"><span>No documents indexed yet. Upload your first document above.</span></div>`;
      return;
    }

    kbDocsCount.textContent = `${rows.length} document${rows.length === 1 ? '' : 's'}`;
    kbDocsList.innerHTML = rows.map(renderDocRow).join('');
  }

  async function refreshDocuments() {
    const docs = await fetchDocuments();
    renderDocuments(docs);
    return docs;
  }

  function pollUntilSettled(predicate, intervalMs = 1500, timeoutMs = 45000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = async () => {
        if (Date.now() - start >= timeoutMs) { resolve(false); return; }
        const done = await predicate().catch(() => false);
        if (done) { resolve(true); return; }
        setTimeout(tick, intervalMs);
      };
      setTimeout(tick, intervalMs);
    });
  }

  async function loadDocuments() {
    kbDocsList.innerHTML = `<div class="empty-state"><span>Loading…</span></div>`;
    const docs = await fetchDocuments();
    loadedDocs = docs || [];
    renderDocuments(docs);
    maybeUpdateProgress();
  }

  async function loadSessions() {
    try {
      const res = await fetch('/api/knowledge/chat/sessions', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) { loadedSessions = []; renderSessions([]); maybeUpdateProgress(); return; }
      const data = await res.json();
      chatSessions = data.sessions || (Array.isArray(data) ? data : []);
      loadedSessions = chatSessions;
      renderSessions(chatSessions);
      maybeUpdateProgress();
    } catch {
      loadedSessions = [];
      renderSessions([]);
      maybeUpdateProgress();
    }
  }

  // ---- Onboarding Progress ----

  function maybeUpdateProgress() {
    if (loadedDocs !== null) {
      renderOnboardingProgress(loadedDocs, loadedSessions || []);
    }
  }

  function renderOnboardingProgress(docs, sessions) {
    const el = document.getElementById('progress-checklist');
    if (!el) return;

    const hasUploaded = docs.length > 0;
    const hasIndexed  = docs.some(d => d.status === 'indexed');
    const hasAsked    = sessions.length > 0;
    const isReady     = hasUploaded && hasIndexed && hasAsked;

    const steps = [
      { label: 'Account created',           done: true },
      { label: 'First document uploaded',   done: hasUploaded },
      { label: 'Documents indexed',         done: hasIndexed },
      { label: 'First test question asked', done: hasAsked },
      { label: 'Ready for review',          done: isReady },
    ];

    const doneCount = steps.filter(s => s.done).length;

    el.innerHTML = `
      <div class="progress-bar-wrap">
        <div class="progress-bar" style="width:${Math.round((doneCount / steps.length) * 100)}%"></div>
      </div>
      <ul class="progress-steps">
        ${steps.map(s => `
          <li class="progress-step ${s.done ? 'progress-step--done' : 'progress-step--pending'}">
            <span class="progress-icon">${s.done ? '✓' : '○'}</span>
            <span>${escHtml(s.label)}</span>
          </li>
        `).join('')}
      </ul>
    `;
  }

  // ---- Ingestion Jobs ----

  async function loadJobs() {
    const jobsList = document.getElementById('kb-jobs-list');
    if (!jobsList) return;
    jobsList.innerHTML = `<div class="empty-state"><span>Loading…</span></div>`;

    try {
      const res = await fetch('/api/knowledge/jobs', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) { renderJobs([]); return; }
      const data = await res.json();
      const jobs = data.jobs || (Array.isArray(data) ? data : []);
      renderJobs(jobs);
    } catch {
      renderJobs([]);
    }
  }

  function renderJobs(jobs) {
    const jobsList = document.getElementById('kb-jobs-list');
    if (!jobsList) return;

    if (!jobs.length) {
      jobsList.innerHTML = `<div class="empty-state"><span>No ingestion jobs yet.</span></div>`;
      return;
    }

    const recent = jobs.slice(0, 5);
    jobsList.innerHTML = recent.map(job => {
      const status = job.status || 'unknown';
      const statusClass = {
        completed: 'badge--indexed',
        running:   'badge--indexing',
        queued:    'badge--indexing',
        failed:    'badge--failed',
      }[status] || 'badge--indexing';

      const name = job.fileName || job.file_name || job.sourceFileId || job.source_file_id || 'Unknown file';
      const date = job.created_at
        ? new Date(job.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
      const errorHtml = status === 'failed' && job.error_message
        ? `<span class="kb-doc-meta kb-job-error">${escHtml(job.error_message)}</span>`
        : '';

      return `
        <div class="kb-doc-row">
          <div class="kb-doc-info">
            <span class="kb-doc-name">${escHtml(name)}</span>
            ${date ? `<span class="kb-doc-meta">${date}</span>` : ''}
            ${errorHtml}
          </div>
          <span class="badge ${statusClass}">${escHtml(status)}</span>
        </div>
      `;
    }).join('');
  }

  function renderSessions(sessions) {
    if (!sessions.length) {
      kbSessionsList.innerHTML = `<div class="empty-state kb-sessions-empty"><span>No previous chats yet.</span></div>`;
      return;
    }
    kbSessionsList.innerHTML = sessions.map(s => {
      const id = s.id || s.session_id || '';
      const title = s.title || 'Chat session';
      const rawDate = s.updated_at || s.created_at || null;
      const dateStr = rawDate
        ? new Date(rawDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
      const isActive = id === currentSessionId ? ' kb-session-item--active' : '';
      return `
        <div class="kb-session-item${isActive}" data-session-id="${escHtml(id)}">
          <span class="kb-session-title" title="${escHtml(title)}">${escHtml(title)}</span>
          ${dateStr ? `<span class="kb-session-date">${escHtml(dateStr)}</span>` : ''}
          <button class="btn-kb-session-delete" data-session-id="${escHtml(id)}" title="Delete session">&times;</button>
        </div>
      `;
    }).join('');
  }

  async function loadSessionMessages(sessionId) {
    currentSessionId = sessionId;
    kbMessages.innerHTML = `<div class="empty-state"><span>Loading messages…</span></div>`;
    renderSessions(chatSessions);

    try {
      const res = await fetch(`/api/knowledge/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        kbMessages.innerHTML = `<div class="empty-state"><span>Failed to load messages.</span></div>`;
        return;
      }
      const data = await res.json();
      const messages = data.messages || (Array.isArray(data) ? data : []);
      kbMessages.innerHTML = '';
      messages.forEach(m => {
        const role    = m.role === 'user' ? 'user' : 'assistant';
        const content = m.content || '';
        const sources = role === 'assistant' ? (m.sources || []) : [];
        appendMessage(role, content, sources);
      });
    } catch {
      kbMessages.innerHTML = `<div class="empty-state"><span>Failed to load messages.</span></div>`;
    }
  }

  function appendMessage(role, content, sources) {
    const wrap = document.createElement('div');
    wrap.className = `kb-message kb-message--${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'kb-message-bubble';
    bubble.textContent = content;
    wrap.appendChild(bubble);

    if (role === 'assistant' && shouldShowSourcesBox(content, sources)) {
      const srcBox = document.createElement('div');
      srcBox.className = 'kb-message-sources';
      const label = document.createElement('span');
      label.className = 'kb-message-sources-label';
      label.textContent = 'Sources';
      srcBox.appendChild(label);
      const ul = document.createElement('ul');
      sources.forEach(s => {
        const name = typeof s === 'string' ? s : (s.fileName || s.file_name || s.name || String(s));
        let display = name;
        if (s && s.pages && s.pages.length > 0) {
          const prefix = s.pages.length === 1 ? 'p.' : 'pp.';
          display = `${name} — ${prefix} ${s.pages.join(', ')}`;
        }
        const li = document.createElement('li');
        li.textContent = display;
        ul.appendChild(li);
      });
      srcBox.appendChild(ul);
      wrap.appendChild(srcBox);
    }

    kbMessages.appendChild(wrap);
    kbMessages.scrollTop = kbMessages.scrollHeight;
  }

  function shouldShowSourcesBox(answerText, sources) {
    if (!sources || sources.length === 0) return false;
    if (/Source:/i.test(answerText)) return false;
    return true;
  }

  function renderDocRow(doc) {
    const status = doc.status || 'indexing';
    const badgeClass = { indexed: 'badge--indexed', indexing: 'badge--indexing', failed: 'badge--failed' }[status] || 'badge--indexing';
    const badge = `<span class="badge ${badgeClass}">${escHtml(status)}</span>`;

    const fileName = doc.fileName || doc.file_name || doc.name || 'Untitled';
    const sourceFileId = doc.sourceFileId || doc.source_file_id || '';
    const date = doc.created_at
      ? new Date(doc.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';

    let deleteBtn = '';
    if (!doc._isPending) {
      if (sourceFileId) {
        deleteBtn = `<button class="btn-kb-delete" data-source-id="${escHtml(sourceFileId)}" data-name="${escHtml(fileName)}">Delete</button>`;
      } else {
        console.warn('[portal] renderDocRow: missing sourceFileId for document', fileName, doc);
        deleteBtn = `<button class="btn-kb-delete" disabled title="Cannot delete: document identifier is missing">Delete</button>`;
      }
    }

    return `
      <div class="kb-doc-row">
        <div class="kb-doc-info">
          <span class="kb-doc-name" title="${escHtml(fileName)}">${escHtml(fileName)}</span>
          ${date ? `<span class="kb-doc-meta">${date}</span>` : ''}
        </div>
        ${badge}
        ${deleteBtn}
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

      const body = await res.json().catch(() => ({}));

      if (res.status === 429) {
        kbUploadStatus.textContent = body.error || 'Document limit reached.';
        kbUploadStatus.className = 'kb-upload-status kb-upload-status--error';
        kbUploadBtn.disabled = false;
        return;
      }

      if (res.ok) {
        kbUploadStatus.textContent = `"${file.name}" uploaded. Indexing in progress…`;
        kbUploadStatus.className = 'kb-upload-status kb-upload-status--success';

        // Show placeholder row immediately while indexing is in progress
        pendingUploads.set(file.name, { fileName: file.name });
        refreshDocuments();

        // Poll until the document appears as indexed or failed
        const settled = await pollUntilSettled(async () => {
          const docs = await fetchDocuments();
          if (docs) {
            loadedDocs = docs;
            renderDocuments(docs);
            maybeUpdateProgress();
          }
          if (!docs) return false;
          const found = docs.find(d => (d.fileName || d.file_name || d.name) === file.name);
          return !!(found && (found.status === 'indexed' || found.status === 'failed'));
        });

        pendingUploads.delete(file.name);
        if (!settled) {
          showBanner('error', 'Indexing is still processing. Refresh again in a moment.');
        }
        const finalDocs = await refreshDocuments();
        if (finalDocs) { loadedDocs = finalDocs; maybeUpdateProgress(); }
        loadJobs();
      } else {
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

    kbQueryInput.value = '';
    adjustQueryHeight();
    kbAskBtn.disabled = true;
    kbAskBtn.textContent = '…';

    appendMessage('user', query, []);

    try {
      const res = await fetch('/api/knowledge/query', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, sessionId: currentSessionId }),
      });

      const body = await res.json().catch(() => ({}));

      if (res.ok) {
        const answer  = body.answer || 'No answer returned.';
        const sources = body.sources || [];
        appendMessage('assistant', answer, sources);
        if (!currentSessionId && body.sessionId) {
          currentSessionId = body.sessionId;
        }
        await loadSessions();
      } else {
        appendMessage('assistant', body.error || 'Failed to get an answer.', []);
      }
    } catch {
      appendMessage('assistant', 'Network error. Please try again.', []);
    }

    kbAskBtn.disabled = false;
    kbAskBtn.textContent = 'Ask';
  }

  function shortId(id) {
    const value = String(id || '');
    if (value.length <= 12) return value;
    return `${value.slice(0, 8)}...${value.slice(-4)}`;
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

  // 10. Issue report form
  const issueForm = document.getElementById('issue-form');
  if (issueForm) {
    issueForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const subject   = document.getElementById('issue-subject').value.trim();
      const issueType = document.getElementById('issue-type').value;
      const message   = document.getElementById('issue-message').value.trim();
      const errorEl   = document.getElementById('issue-error');
      const successEl = document.getElementById('issue-success');
      const submitBtn = document.getElementById('issue-submit');

      errorEl.hidden   = true;
      successEl.hidden = true;

      if (!subject || !issueType || !message) {
        errorEl.textContent = 'Please fill in all fields.';
        errorEl.hidden = false;
        return;
      }

      submitBtn.disabled    = true;
      submitBtn.textContent = 'Submitting…';

      try {
        const res = await fetch('/api/portal/issues', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ subject, issueType, message }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Submission failed. Please try again.');
        }

        successEl.textContent = "Issue submitted. We'll be in touch within one business day.";
        successEl.hidden = false;
        issueForm.reset();
      } catch (err) {
        errorEl.textContent = err.message;
        errorEl.hidden = false;
      } finally {
        submitBtn.disabled    = false;
        submitBtn.textContent = 'Submit Issue';
      }
    });
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
