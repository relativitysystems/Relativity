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

  const { clientId, clientName, email, memberId, memberRole } = me;

  const identityName = document.getElementById('clientIdentityName');
  const identityId   = document.getElementById('clientIdentityId');
  if (identityName) identityName.textContent = email || 'User';
  if (identityId) {
  const roleLabel = memberRole ? memberRole.charAt(0).toUpperCase() + memberRole.slice(1) : 'Member';
  identityId.textContent = `${clientName || 'Client'} • ${roleLabel}`;
}

  // Show team section for owner and admin roles
  if (memberRole === 'owner' || memberRole === 'admin') {
    const teamSection = document.getElementById('section-team');
    if (teamSection) teamSection.style.display = '';
    initTeamSection();
    loadMembers();
  }

  // 4. Handle post-OAuth redirect params
  const params = new URLSearchParams(window.location.search);
  const connected = params.get('connected');
  const error = params.get('error');

  if (connected) {
    showBanner('success', 'Connection updated successfully.');
    window.history.replaceState({}, '', '/portal/portal.html');
  }

  if (error) {
    showBanner('error', 'Connection failed. Please try again or contact support.');
    window.history.replaceState({}, '', '/portal/portal.html');
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
  const kbGdriveBtn       = document.getElementById('kb-gdrive-btn');

  let _pickerConfig       = null;
  let _gapiPickerLoaded   = false;
  let _gisInited          = false;
  let _tokenClient        = null;

  let currentSessionId = null;
  let chatSessions     = [];
  const pendingDeletes = new Set();
  const pendingUploads = new Map();

  // Shared state for onboarding progress — updated as docs and sessions load
  let loadedDocs      = null;
  let loadedSessions  = null;
  let loadedAnalytics = null;
  let loadedMembers   = null; // null = not yet fetched; [] = no other members

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
  loadAnalytics();
  loadPickerConfig();

  kbUploadBtn.addEventListener('click', () => kbFileInput.click());
  kbFileInput.addEventListener('change', () => {
    if (kbFileInput.files[0]) {
      kbUploadStatus.hidden = true;
      kbUploadStatus.textContent = '';
      uploadDocument(kbFileInput.files[0]);
    }
  });

  kbGdriveBtn.addEventListener('click', () => {
    if (!_pickerConfig?.clientId) {
      showBanner('error', 'Google Drive import is not configured.');
      return;
    }
    if (!_gisInited || !_gapiPickerLoaded) {
      initPicker(() => _tokenClient.requestAccessToken({ prompt: 'select_account' }));
    } else {
      _tokenClient.requestAccessToken({ prompt: '' });
    }
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
    updateChatWelcome();
    renderSessions(chatSessions);
    kbQueryInput.focus();
  });

  // Chat welcome chips — fill textarea on click, no auto-submit
  document.querySelectorAll('.chat-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      kbQueryInput.value = chip.textContent.trim();
      adjustQueryHeight();
      kbQueryInput.focus();
    });
  });
  updateChatWelcome();

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
        updateChatWelcome();
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
      return !pendingDeletes.has(id) && d.status !== 'deleted';
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
      kbDocsList.innerHTML = `
        <div class="empty-state-card">
          <span class="empty-state-icon">📄</span>
          <span class="empty-state-title">No documents uploaded yet</span>
          <span class="empty-state-desc">Upload SOPs, FAQs, pricing sheets, or training docs to build your knowledge base.</span>
        </div>`;
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
    kbDocsList.innerHTML = `
      <div class="kb-doc-row loading-row">
        <div class="kb-doc-info">
          <div class="skeleton skeleton-line" style="width:52%"></div>
          <div class="skeleton skeleton-line skeleton-line--sm" style="width:28%"></div>
        </div>
        <div class="skeleton" style="width:58px;height:20px;border-radius:99px"></div>
      </div>
      <div class="kb-doc-row loading-row">
        <div class="kb-doc-info">
          <div class="skeleton skeleton-line" style="width:41%"></div>
          <div class="skeleton skeleton-line skeleton-line--sm" style="width:22%"></div>
        </div>
        <div class="skeleton" style="width:58px;height:20px;border-radius:99px"></div>
      </div>`;
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
      chatSessions = (data.sessions || (Array.isArray(data) ? data : [])).filter(s => !s.deleted_at);
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
      renderOnboardingProgress(loadedDocs, loadedSessions || [], loadedAnalytics, loadedMembers);
    }
  }

  function renderOnboardingProgress(docs, sessions, analytics, members) {
    const el = document.getElementById('progress-checklist');
    if (!el) return;

    const hasDoc     = docs.length > 0;
    const hasIndexed = docs.some(d => d.status === 'indexed') ||
                       (analytics ? (analytics.indexedDocuments ?? analytics.indexed_documents ?? 0) > 0 : false);
    const hasSession = sessions.length > 0;
    const hasCitation = analytics
      ? (analytics.totalQuestions ?? analytics.total_questions ?? 0) > 0
      : false;

    const isOwnerAdmin = memberRole === 'owner' || memberRole === 'admin';

    const lastStep = isOwnerAdmin
      ? { label: 'Invite team member',   done: Array.isArray(members) && members.some(m => m.role !== 'owner') }
      : { label: 'Explore chat history', done: hasSession };

    const steps = [
      { label: 'Account created',               done: true },
      { label: 'Upload first document',         done: hasDoc },
      { label: 'Document indexed successfully', done: hasIndexed },
      { label: 'Ask first test question',       done: hasSession },
      { label: 'Verify answer source citation', done: hasCitation },
      lastStep,
    ];

    el.innerHTML = `
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
    jobsList.innerHTML = `
      <div class="kb-doc-row loading-row">
        <div class="kb-doc-info">
          <div class="skeleton skeleton-line" style="width:48%"></div>
          <div class="skeleton skeleton-line skeleton-line--sm" style="width:20%"></div>
        </div>
        <div class="skeleton" style="width:58px;height:20px;border-radius:99px"></div>
      </div>
      <div class="kb-doc-row loading-row">
        <div class="kb-doc-info">
          <div class="skeleton skeleton-line" style="width:60%"></div>
        </div>
        <div class="skeleton" style="width:58px;height:20px;border-radius:99px"></div>
      </div>`;

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

  async function loadAnalytics() {
    try {
      const res = await fetch('/api/knowledge/analytics', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) { loadedAnalytics = null; maybeUpdateProgress(); return; }
      loadedAnalytics = await res.json();
      maybeUpdateProgress();
    } catch {
      loadedAnalytics = null;
      maybeUpdateProgress();
    }
  }

  async function loadMembers() {
    try {
      const res = await fetch('/api/team/members', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) { loadedMembers = []; maybeUpdateProgress(); return; }
      loadedMembers = await res.json();
      maybeUpdateProgress();
    } catch {
      loadedMembers = [];
      maybeUpdateProgress();
    }
  }

  function renderJobs(jobs) {
    const jobsList = document.getElementById('kb-jobs-list');

    if (!jobs.length) {
      if (jobsList) jobsList.innerHTML = `
        <div class="empty-state-card">
          <span class="empty-state-icon">⏱</span>
          <span class="empty-state-title">No processing history yet</span>
          <span class="empty-state-desc">Your recent uploads and indexing status will appear here.</span>
        </div>`;
      return;
    }

    const recent = jobs.slice(0, 5);
    const html = recent.map(job => {
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

    if (jobsList) jobsList.innerHTML = html;
  }

  function renderSessions(sessions) {
    if (!sessions.length) {
      kbSessionsList.innerHTML = `
        <div class="empty-state-card empty-state-card--compact">
          <span class="empty-state-title">No chats yet</span>
          <span class="empty-state-desc">Ask your first question after uploading a document.</span>
        </div>`;
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
    kbMessages.innerHTML = `<div class="empty-state"><span>Loading…</span></div>`;
    updateChatWelcome();
    renderSessions(chatSessions);

    try {
      const res = await fetch(`/api/knowledge/chat/sessions/${encodeURIComponent(sessionId)}/messages`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        kbMessages.innerHTML = `<div class="empty-state"><span>Failed to load messages.</span></div>`;
        updateChatWelcome();
        return;
      }
      const data = await res.json();
      const messages = (data.messages || (Array.isArray(data) ? data : [])).filter(m => !m.deleted_at);
      kbMessages.innerHTML = '';
      messages.forEach(m => {
        const role    = m.role === 'user' ? 'user' : 'assistant';
        const content = m.content || '';
        const sources = role === 'assistant' ? (m.sources || []) : [];
        appendMessage(role, content, sources);
      });
      updateChatWelcome();
    } catch {
      kbMessages.innerHTML = `<div class="empty-state"><span>Failed to load messages.</span></div>`;
      updateChatWelcome();
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
    updateChatWelcome();
  }

  function showGapCard(body, originalQuery) {
    const card = document.createElement('div');
    card.className = 'kb-gap-card';

    const label = document.createElement('span');
    label.className = 'kb-gap-card__label';
    label.textContent = 'Knowledge gap detected';
    card.appendChild(label);

    const desc = document.createElement('p');
    desc.className = 'kb-gap-card__text';
    desc.textContent = 'No approved documentation was found for this question. Save it for review?';
    card.appendChild(desc);

    const actions = document.createElement('div');
    actions.className = 'kb-gap-card__actions';

    const saveBtn = document.createElement('button');
    saveBtn.className = 'kb-gap-card__btn kb-gap-card__btn--save';
    saveBtn.textContent = 'Save gap';

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'kb-gap-card__btn kb-gap-card__btn--dismiss';
    dismissBtn.textContent = 'Dismiss';

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const r = await fetch('/api/knowledge/gaps', {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: body.sessionId,
            messageId: body.userMessageId || null,
            question: originalQuery,
            reason: body.gapReason,
          }),
        });
        if (r.ok) {
          card.innerHTML = '';
          const saved = document.createElement('span');
          saved.className = 'kb-gap-card__saved';
          saved.textContent = 'Saved for review.';
          card.appendChild(saved);
        } else {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save gap';
          let errEl = card.querySelector('.kb-gap-card__error');
          if (!errEl) {
            errEl = document.createElement('span');
            errEl.className = 'kb-gap-card__error';
            card.appendChild(errEl);
          }
          errEl.textContent = 'Failed to save. Try again.';
        }
      } catch {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save gap';
      }
    });

    dismissBtn.addEventListener('click', () => card.remove());

    actions.appendChild(saveBtn);
    actions.appendChild(dismissBtn);
    card.appendChild(actions);

    kbMessages.appendChild(card);
    kbMessages.scrollTop = kbMessages.scrollHeight;
  }

  function shouldShowSourcesBox(answerText, sources) {
    if (!sources || sources.length === 0) return false;
    if (/Source:/i.test(answerText)) return false;
    return true;
  }

  function renderDocRow(doc) {
    const status = doc.status || 'indexing';
    const badgeClass = { indexing: 'badge--indexing', failed: 'badge--failed' }[status];
    const badge = badgeClass ? `<span class="badge ${badgeClass}">${escHtml(status)}</span>` : '';

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
    kbUploadStatus.hidden = true;
    kbUploadStatus.textContent = '';
    kbUploadStatus.className = 'kb-upload-status';
    kbUploadBtn.disabled = true;
    kbFileInput.value = '';

    showUploadPhase('Preparing upload…', 0, file.name);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.min(Math.round((e.loaded / e.total) * 100), 99);
            showUploadPhase('Uploading…', pct, file.name);
          }
        };

        xhr.onload = () => {
          try {
            resolve({ status: xhr.status, body: JSON.parse(xhr.responseText) });
          } catch {
            resolve({ status: xhr.status, body: {} });
          }
        };

        xhr.onerror = () => reject(new Error('Network error. Please try again.'));

        xhr.open('POST', '/api/knowledge/upload');
        xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
        xhr.send(formData);
      });

      if (result.status === 429) {
        kbUploadStatus.textContent = result.body.error || 'Document limit reached.';
        kbUploadStatus.className   = 'kb-upload-status kb-upload-status--error';
        kbUploadStatus.hidden      = false;
        return;
      }

      if (result.status >= 200 && result.status < 300) {
        showUploadPhase('Processing document…', 100, file.name);

        // Show placeholder row immediately while indexing is in progress
        pendingUploads.set(file.name, { fileName: file.name });
        refreshDocuments();

        showUploadPhase('Indexing in knowledge base…', 100, file.name);

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
          showBanner('error', 'Indexing is taking longer than expected. Refresh in a moment.');
        } else {
          kbUploadStatus.textContent = `"${file.name}" is ready in your knowledge base.`;
          kbUploadStatus.className   = 'kb-upload-status kb-upload-status--success';
          kbUploadStatus.hidden      = false;
        }

        const finalDocs = await refreshDocuments();
        if (finalDocs) { loadedDocs = finalDocs; maybeUpdateProgress(); }
        loadJobs();
      } else {
        kbUploadStatus.textContent = result.body.error || 'Upload failed. Please try again.';
        kbUploadStatus.className   = 'kb-upload-status kb-upload-status--error';
        kbUploadStatus.hidden      = false;
      }
    } catch (err) {
      kbUploadStatus.textContent = err.message || 'Network error. Please try again.';
      kbUploadStatus.className   = 'kb-upload-status kb-upload-status--error';
      kbUploadStatus.hidden      = false;
    } finally {
      hideUploadPanel();
      kbUploadBtn.disabled = false;
    }
  }

  function showUploadPhase(phase, pct, fileName) {
    const panel   = document.getElementById('upload-progress-panel');
    const bar     = document.getElementById('upload-progress-bar');
    const pctEl   = document.getElementById('upload-percent-text');
    const phaseEl = document.getElementById('upload-phase-text');
    const nameEl  = document.getElementById('upload-file-name');
    if (!panel) return;
    if (nameEl)  nameEl.textContent  = fileName;
    if (bar)     bar.style.width     = `${pct}%`;
    if (pctEl)   pctEl.textContent   = `${pct}%`;
    if (phaseEl) phaseEl.textContent = phase;
    panel.hidden = false;
  }

  function hideUploadPanel() {
    const panel = document.getElementById('upload-progress-panel');
    if (panel) panel.hidden = true;
  }

  // ---- Google Drive one-shot import ----

  async function loadPickerConfig() {
    try {
      const res = await fetch('/api/google-drive/picker-config', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) _pickerConfig = await res.json();
    } catch { /* non-fatal — button will show a banner if config missing */ }
  }

  function initPicker(callback) {
    gapi.load('picker', () => {
      _gapiPickerLoaded = true;
      if (_gisInited) callback();
    });
    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: _pickerConfig.clientId,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      callback: (response) => {
        if (response.access_token) openPicker(response.access_token);
      },
    });
    _gisInited = true;
    if (_gapiPickerLoaded) callback();
  }

  function openPicker(tempToken) {
    const docsView = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes([
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
        'text/markdown',
      ].join(','));

    new google.picker.PickerBuilder()
      .addView(docsView)
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(tempToken)
      .setDeveloperKey(_pickerConfig.apiKey)
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) {
          importFromGoogleDrive(data.docs, tempToken);
        }
      })
      .build()
      .setVisible(true);
  }

  async function importFromGoogleDrive(docs, tempToken) {
    kbGdriveBtn.disabled = true;
    kbUploadStatus.hidden = true;
    kbUploadStatus.className = 'kb-upload-status';

    const files = docs.map(d => ({ id: d.id, name: d.name, mimeType: d.mimeType }));
    const total = files.length;

    showImportStatus(`Importing ${total} file${total > 1 ? 's' : ''} from Google Drive…`);

    try {
      let completed = 0;
      for (const file of files) {
        showImportStatus(`Importing file ${completed + 1} of ${total}: “${file.name}”…`);

        const res = await fetch('/api/google-drive/import', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'X-Google-Access-Token': tempToken,
          },
          body: JSON.stringify({ files: [file] }),
        });
        const body = await res.json();

        if (!res.ok) {
          kbUploadStatus.textContent = body.error || 'Import failed. Please try again.';
          kbUploadStatus.className = 'kb-upload-status kb-upload-status--error';
          kbUploadStatus.hidden = false;
          return;
        }
        completed++;
      }

      kbUploadStatus.textContent = `${total} file${total > 1 ? 's' : ''} imported from Google Drive.`;
      kbUploadStatus.className = 'kb-upload-status kb-upload-status--success';
      kbUploadStatus.hidden = false;
      await refreshDocuments();
      loadJobs();

    } catch (err) {
      kbUploadStatus.textContent = err.message || 'Network error. Please try again.';
      kbUploadStatus.className = 'kb-upload-status kb-upload-status--error';
      kbUploadStatus.hidden = false;
    } finally {
      hideImportStatus();
      kbGdriveBtn.disabled = false;
    }
  }

  function showImportStatus(message) {
    const panel   = document.getElementById('upload-progress-panel');
    const phaseEl = document.getElementById('upload-phase-text');
    const nameEl  = document.getElementById('upload-file-name');
    const barEl   = document.getElementById('upload-progress-bar');
    const pctEl   = document.getElementById('upload-percent-text');
    if (panel)   panel.hidden        = false;
    if (phaseEl) phaseEl.textContent = message;
    if (nameEl)  nameEl.textContent  = '';
    if (barEl)   barEl.style.width   = '100%';
    if (pctEl)   pctEl.textContent   = '';
  }

  function hideImportStatus() {
    const panel = document.getElementById('upload-progress-panel');
    if (panel) panel.hidden = true;
  }

  async function askQuestion() {
    const query = kbQueryInput.value.trim();
    if (!query) return;

    kbQueryInput.value = '';
    adjustQueryHeight();
    kbAskBtn.disabled = true;
    kbAskBtn.textContent = '…';

    appendMessage('user', query, []);
    const loadingBubble = appendLoadingBubble();

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
      loadingBubble.remove();

      if (res.ok) {
        const answer  = body.answer || 'No answer returned.';
        const sources = body.sources || [];
        appendMessage('assistant', answer, sources);
        if (body.isKnowledgeGap === true) {
          showGapCard(body, query);
        }
        if (!currentSessionId && body.sessionId) {
          currentSessionId = body.sessionId;
        }
        await loadSessions();
      } else {
        appendMessage('assistant', body.error || 'Failed to get an answer.', []);
      }
    } catch {
      loadingBubble.remove();
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
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.innerHTML = `<span class="toast-icon">${type === 'success' ? '✓' : '✕'}</span><span class="toast-text">${escHtml(message)}</span>`;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast--visible'));
    setTimeout(() => {
      toast.classList.remove('toast--visible');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    }, 4000);
  }

  function appendLoadingBubble() {
    const wrap = document.createElement('div');
    wrap.className = 'kb-message kb-message--assistant';
    const bubble = document.createElement('div');
    bubble.className = 'kb-message-bubble';
    bubble.innerHTML = '<span class="loading-dots"><span></span><span></span><span></span></span>';
    wrap.appendChild(bubble);
    kbMessages.appendChild(wrap);
    kbMessages.scrollTop = kbMessages.scrollHeight;
    updateChatWelcome();
    return wrap;
  }

  function updateChatWelcome() {
    const welcome = document.getElementById('chat-welcome');
    if (!welcome) return;
    welcome.hidden = kbMessages.children.length > 0;
  }

  // ── Team Section ────────────────────────────────────────────────────────────

  function initTeamSection() {
    const tbody       = document.getElementById('team-members-tbody');
    const modal       = document.getElementById('team-invite-modal');
    const inviteBtn   = document.getElementById('btn-team-invite');
    const cancelBtn   = document.getElementById('team-invite-cancel');
    const inviteForm  = document.getElementById('team-invite-form');
    const emailInput  = document.getElementById('team-invite-email');
    const roleSelect  = document.getElementById('team-invite-role');
    const inviteError = document.getElementById('team-invite-error');
    const submitBtn   = document.getElementById('team-invite-submit');

    if (!tbody) return;

    function statusBadge(status) {
      const labels = { invited: 'Invited', active: 'Active', disabled: 'Disabled', revoked: 'Revoked' };
      const cls    = { invited: 'invited', active: 'active', disabled: 'disabled', revoked: 'disabled' };
      return `<span class="team-status-badge team-status-badge--${cls[status] || 'disabled'}">${labels[status] || status}</span>`;
    }

    function fmtDate(iso) {
      if (!iso) return '—';
      return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }

    async function loadTeamMembers() {
      tbody.innerHTML = `
        <tr class="loading-row">
          <td><div class="skeleton skeleton-line" style="width:70%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:50%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:40%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:55%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:45%"></div></td>
          <td></td>
        </tr>
        <tr class="loading-row">
          <td><div class="skeleton skeleton-line" style="width:60%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:45%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:35%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:50%"></div></td>
          <td><div class="skeleton skeleton-line" style="width:40%"></div></td>
          <td></td>
        </tr>`;
      try {
        const res = await fetch('/api/team/members', {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) throw new Error('Failed to load members');
        const members = await res.json();
        renderMembers(members);
      } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" class="team-empty-state">Could not load team members.</td></tr>`;
      }
    }

    function renderMembers(members) {
      if (!members.length) {
        tbody.innerHTML = `<tr><td colspan="6">
          <div class="empty-state-card">
            <span class="empty-state-icon">👥</span>
            <span class="empty-state-title">No team members yet</span>
            <span class="empty-state-desc">Invite your first teammate so they can access the company knowledge base.</span>
          </div>
        </td></tr>`;
        return;
      }

      tbody.innerHTML = members.map(m => {
        const isCurrentUser = m.id === memberId;
        const isOwner       = m.role === 'owner';
        const isPending     = m.status === 'invited';
        const isDisabled    = m.status === 'disabled' || m.status === 'revoked';
        const nameOrEmail   = m.full_name
          ? `<span class="team-member-name">${esc(m.full_name)}</span><br><span class="team-member-email">${esc(m.email)}</span>`
          : `<span class="team-member-email">${esc(m.email)}</span>`;

        const roleOptions = ['owner','admin','member','viewer']
          .map(r => `<option value="${r}"${r === m.role ? ' selected' : ''}>${r.charAt(0).toUpperCase()+r.slice(1)}</option>`)
          .join('');

        let actions = '';
        if (!isCurrentUser) {
          if (isPending) {
            actions += `<button class="btn-team-action" data-action="resend" data-id="${m.id}">Resend</button>`;
            actions += `<button class="btn-team-action btn-team-action--danger" data-action="revoke" data-id="${m.id}">Revoke</button>`;
          } else if (!isDisabled) {
            actions += `<button class="btn-team-action btn-team-action--danger" data-action="disable" data-id="${m.id}">Disable</button>`;
          }
        }
        if (isCurrentUser) {
          actions = '<span class="team-you-label">You</span>';
        }

        const roleCell = isCurrentUser || isOwner
          ? `<span class="team-role-label">${m.role.charAt(0).toUpperCase()+m.role.slice(1)}</span>`
          : `<select class="team-role-select" data-id="${m.id}">${roleOptions}</select>`;

        return `<tr>
          <td>${nameOrEmail}</td>
          <td>${roleCell}</td>
          <td>${statusBadge(m.status)}</td>
          <td>${fmtDate(m.invited_at)}</td>
          <td>${fmtDate(m.last_active_at)}</td>
          <td class="team-actions-cell">${actions}</td>
        </tr>`;
      }).join('');

      // Role change handlers
      tbody.querySelectorAll('.team-role-select').forEach(sel => {
        sel.addEventListener('change', async () => {
          const mid  = sel.dataset.id;
          const role = sel.value;
          sel.disabled = true;
          try {
            const res = await fetch(`/api/team/members/${mid}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
              body: JSON.stringify({ role }),
            });
            if (!res.ok) {
              const d = await res.json().catch(() => ({}));
              alert(d.error || 'Could not update role');
              await loadTeamMembers();
            }
          } catch { alert('Could not update role'); await loadTeamMembers(); }
          sel.disabled = false;
        });
      });

      // Action button handlers
      tbody.querySelectorAll('.btn-team-action').forEach(btn => {
        btn.addEventListener('click', async () => {
          const action = btn.dataset.action;
          const mid    = btn.dataset.id;
          btn.disabled = true;

          try {
            if (action === 'resend') {
              const res = await fetch('/api/team/invites/resend', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
                body: JSON.stringify({ memberId: mid }),
              });
              if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed');
              alert('Invite resent.');
            } else if (action === 'revoke') {
              if (!confirm('Revoke this invitation?')) { btn.disabled = false; return; }
              const res = await fetch('/api/team/invites/revoke', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
                body: JSON.stringify({ memberId: mid }),
              });
              if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed');
            } else if (action === 'disable') {
              if (!confirm('Disable this member? They will no longer be able to access the portal.')) { btn.disabled = false; return; }
              const res = await fetch(`/api/team/members/${mid}/disable`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}` },
              });
              if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed');
            }
            await loadTeamMembers();
          } catch (err) {
            alert(err.message || 'Action failed');
            btn.disabled = false;
          }
        });
      });
    }

    function esc(s) {
      return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Modal open/close
    inviteBtn.addEventListener('click', () => {
      inviteError.hidden = true;
      inviteForm.reset();
      modal.hidden = false;
    });
    cancelBtn.addEventListener('click', () => { modal.hidden = true; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });

    // Invite form submit
    inviteForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      inviteError.hidden = true;
      const email = emailInput.value.trim();
      const role  = roleSelect.value;

      if (!email) {
        inviteError.textContent = 'Email is required.';
        inviteError.hidden = false;
        return;
      }

      submitBtn.disabled    = true;
      submitBtn.textContent = 'Sending…';

      try {
        const res = await fetch('/api/team/invite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ email, role }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not send invite');

        modal.hidden = true;
        await loadTeamMembers();
      } catch (err) {
        inviteError.textContent = err.message;
        inviteError.hidden = false;
      } finally {
        submitBtn.disabled    = false;
        submitBtn.textContent = 'Send Invite';
      }
    });

    loadTeamMembers();
  }

})();
