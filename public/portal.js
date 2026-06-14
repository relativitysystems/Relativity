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

  loadDocuments();
  loadSessions();

  kbUploadBtn.addEventListener('click', () => kbFileInput.click());
  kbFileInput.addEventListener('change', () => {
    if (kbFileInput.files[0]) uploadDocument(kbFileInput.files[0]);
  });

  kbAskBtn.addEventListener('click', askQuestion);
  kbQueryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') askQuestion();
  });

  kbNewChatBtn.addEventListener('click', () => {
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
        currentSessionId = null;
        kbMessages.innerHTML = '';
        renderSessions([]);
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
          if (currentSessionId === sessionId) {
            currentSessionId = null;
            kbMessages.innerHTML = '';
          }
          renderSessions(chatSessions);
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

  async function loadSessions() {
    try {
      const res = await fetch('/api/knowledge/chat/sessions', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) { renderSessions([]); return; }
      const data = await res.json();
      chatSessions = data.sessions || (Array.isArray(data) ? data : []);
      renderSessions(chatSessions);
    } catch {
      renderSessions([]);
    }
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
        const li = document.createElement('li');
        li.textContent = name;
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

    kbQueryInput.value = '';
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

  function showBanner(type, message) {
    const banner = document.getElementById(type === 'success' ? 'bannerSuccess' : 'bannerError');
    const text = document.getElementById(type === 'success' ? 'bannerSuccessText' : 'bannerErrorText');
    if (banner && text) {
      text.textContent = message;
      banner.hidden = false;
    }
  }

})();
