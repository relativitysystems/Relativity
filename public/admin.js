(function () {
  const loginView = document.getElementById('loginView');
  const dashboardView = document.getElementById('dashboardView');
  const logoutBtn = document.getElementById('logoutBtn');

  // ---- Auth helpers ----

  function getToken() { return localStorage.getItem('adminToken'); }
  function saveToken(t) { localStorage.setItem('adminToken', t); }
  function clearToken() { localStorage.removeItem('adminToken'); }

  async function adminFetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Token': getToken() || '',
        ...(options.headers || {}),
      },
    });
    if (res.status === 401) {
      clearToken();
      showLogin();
      throw new Error('Session expired');
    }
    return res;
  }

  // ---- View switching ----

  function showLogin() {
    loginView.hidden = false;
    dashboardView.hidden = true;
    logoutBtn.hidden = true;
  }

  function showDashboard() {
    loginView.hidden = true;
    dashboardView.hidden = false;
    logoutBtn.hidden = false;
    loadClients();
    loadLeads();
    loadIssues();
  }

  // ---- Login form ----

  const loginForm = document.getElementById('adminLoginForm');
  const loginError = document.getElementById('loginError');
  const loginBtn = document.getElementById('loginBtn');

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginBtn.disabled = true;
    loginBtn.textContent = 'Signing in…';
    loginError.hidden = true;

    const password = document.getElementById('adminPassword').value;

    const res = await fetch('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    const body = await res.json();

    if (!res.ok) {
      loginError.textContent = body.error || 'Invalid password.';
      loginError.hidden = false;
      loginBtn.disabled = false;
      loginBtn.textContent = 'Sign In';
      return;
    }

    saveToken(body.token);
    showDashboard();
  });

  // ---- Logout ----

  logoutBtn.addEventListener('click', () => {
    clearToken();
    showLogin();
  });

  // ---- Invite form ----

  const inviteForm = document.getElementById('inviteForm');
  const inviteError = document.getElementById('inviteError');
  const inviteSuccess = document.getElementById('inviteSuccess');
  const inviteBtn = document.getElementById('inviteBtn');

  inviteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    inviteBtn.disabled = true;
    inviteBtn.textContent = 'Sending…';
    inviteError.hidden = true;
    inviteSuccess.hidden = true;

    const name = document.getElementById('clientName').value.trim();
    const email = document.getElementById('clientEmail').value.trim();

    let res;
    try {
      res = await adminFetch('/admin/invite', {
        method: 'POST',
        body: JSON.stringify({ name, email }),
      });
    } catch {
      inviteBtn.disabled = false;
      inviteBtn.textContent = 'Send Invite';
      return;
    }

    const body = await res.json();

    if (!res.ok) {
      inviteError.textContent = body.error || 'Failed to send invite.';
      inviteError.hidden = false;
      inviteBtn.disabled = false;
      inviteBtn.textContent = 'Send Invite';
      return;
    }

    inviteSuccess.textContent = `Invite sent to ${email}.`;
    inviteSuccess.hidden = false;
    inviteBtn.disabled = false;
    inviteBtn.textContent = 'Send Invite';
    document.getElementById('clientName').value = '';
    document.getElementById('clientEmail').value = '';

    loadClients();
  });

  // ---- Client list ----

  const clientsLoading = document.getElementById('clientsLoading');
  const clientsEmpty = document.getElementById('clientsEmpty');
  const clientsError = document.getElementById('clientsError');
  const clientsTable = document.getElementById('clientsTable');

  async function loadClients() {
    clientsLoading.hidden = false;
    clientsEmpty.hidden = true;
    clientsError.hidden = true;
    clientsTable.hidden = true;

    let res;
    try {
      res = await adminFetch('/admin/clients');
    } catch {
      return;
    }

    const clients = await res.json();
    clientsLoading.hidden = true;

    if (!Array.isArray(clients) || clients.length === 0) {
      clientsEmpty.hidden = false;
      return;
    }

    clientsTable.innerHTML = renderTable(clients);
    clientsTable.hidden = false;
  }

  function fmtDate(val) {
    return val
      ? new Date(val).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '—';
  }

  function renderTable(clients) {
    const rows = clients.map(renderRow).join('');
    return `
      <div class="table-wrap">
        <table class="admin-table clients-table">
          <thead>
            <tr>
              <th></th>
              <th>Client</th>
              <th>Status</th>
              <th>Team</th>
              <th>Docs</th>
              <th>Indexed</th>
              <th>Failed</th>
              <th>Questions</th>
              <th>Gaps</th>
              <th>Issues</th>
              <th>Integrations</th>
              <th>Last Active</th>
              <th>Joined</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function renderRow(c) {
    const h = c.aikbHealth || {};

    const statusBadge = c.invite_accepted
      ? `<span class="badge badge--active">Active</span>`
      : c.is_active
        ? `<span class="badge badge--pending">Invite Sent</span>`
        : `<span class="badge badge--closed_lost">Inactive</span>`;

    const integrations = [
      { key: 'dropbox',      label: 'Dropbox' },
      { key: 'slack',        label: 'Slack'   },
      { key: 'google_drive', label: 'Drive'   },
    ].map(({ key, label }) =>
      `<span class="integration-tag ${c[key] ? 'integration-tag--on' : ''}">${label}</span>`
    ).join('');

    const lastActiveTimestamp = [
      h.lastQuestionAt,
      h.latestIngestionJob?.created_at,
      h.lastIndexedAt,
    ].filter(Boolean).sort().at(-1) || null;

    const teamCell = [
      `<span class="team-count">${c.teamCount || 0}</span>`,
      c.activeMemberCount  ? `<span class="badge badge--active badge--sm">${c.activeMemberCount} active</span>`   : '',
      c.pendingMemberCount ? `<span class="badge badge--pending badge--sm">${c.pendingMemberCount} pending</span>` : '',
    ].filter(Boolean).join(' ');

    const membersRowId = `members-${c.id}`;

    return `
      <tr class="client-row">
        <td class="expand-cell">
          <button class="btn-expand" data-target="${membersRowId}" aria-expanded="false" title="Show team members">▶</button>
        </td>
        <td>
          <div class="client-name">${esc(c.name)}</div>
          <div class="client-email">${esc(c.email)}</div>
        </td>
        <td>${statusBadge}</td>
        <td class="team-cell">${teamCell}</td>
        <td class="num-cell">${h.totalDocuments     ?? '—'}</td>
        <td class="num-cell">${h.indexedDocuments   ?? '—'}</td>
        <td class="num-cell">${h.failedDocuments    ?? '—'}</td>
        <td class="num-cell">${h.totalQuestions     ?? '—'}</td>
        <td class="num-cell">${h.totalKnowledgeGaps ?? '—'}</td>
        <td class="num-cell">${h.issueCount         ?? '—'}</td>
        <td><div class="integration-list">${integrations}</div></td>
        <td class="client-date">${fmtDate(lastActiveTimestamp)}</td>
        <td class="client-date">${fmtDate(c.created_at)}</td>
        <td><button class="btn-delete" data-id="${esc(c.id)}" data-name="${esc(c.name)}">Delete</button></td>
      </tr>
      <tr id="${membersRowId}" class="members-row" hidden>
        <td colspan="14">${renderMembersPanel(c.teamMembers || [])}</td>
      </tr>
    `;
  }

  function renderMembersPanel(members) {
    if (!members.length) {
      return `<div class="members-panel"><p class="members-empty">No team members yet.</p></div>`;
    }

    const memberStatusBadge = (status) => {
      const cls = { active: 'badge--active', pending: 'badge--pending' }[status] || 'badge--closed_lost';
      return `<span class="badge ${cls}">${esc(status)}</span>`;
    };

    const rows = members.map(m => `
      <tr>
        <td class="client-name">${esc(m.full_name || '—')}</td>
        <td class="client-email">${esc(m.email)}</td>
        <td><span class="badge badge--role-${esc(m.role)}">${esc(m.role)}</span></td>
        <td>${memberStatusBadge(m.status)}</td>
        <td class="client-date">${fmtDate(m.invited_at)}</td>
        <td class="client-date">${fmtDate(m.accepted_at)}</td>
        <td class="client-date">${fmtDate(m.last_active_at)}</td>
      </tr>
    `).join('');

    return `
      <div class="members-panel">
        <table class="members-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Invited</th>
              <th>Accepted</th>
              <th>Last Active</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  // Delete + expand handler via event delegation (delete checked first)
  clientsTable.addEventListener('click', async (e) => {
    const deleteBtn = e.target.closest('.btn-delete');
    if (deleteBtn) {
      const clientId = deleteBtn.dataset.id;
      const clientName = deleteBtn.dataset.name;
      if (!confirm(`Delete "${clientName}"? This removes their account and all data.`)) return;

      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Deleting…';

      try {
        const res = await adminFetch(`/admin/clients/${clientId}`, { method: 'DELETE' });
        if (res.ok) {
          loadClients();
        } else {
          const body = await res.json().catch(() => ({}));
          alert(body.error || 'Failed to delete client.');
          deleteBtn.disabled = false;
          deleteBtn.textContent = 'Delete';
        }
      } catch {
        deleteBtn.disabled = false;
        deleteBtn.textContent = 'Delete';
      }
      return;
    }

    const expandBtn = e.target.closest('.btn-expand');
    if (expandBtn) {
      const targetId = expandBtn.dataset.target;
      const targetRow = document.getElementById(targetId);
      if (targetRow) {
        const nowOpen = targetRow.hidden;
        targetRow.hidden = !nowOpen;
        expandBtn.textContent = nowOpen ? '▼' : '▶';
        expandBtn.setAttribute('aria-expanded', String(nowOpen));
      }
    }
  });

  // ---- Leads list ----

  const leadsLoading = document.getElementById('leadsLoading');
  const leadsEmpty   = document.getElementById('leadsEmpty');
  const leadsError   = document.getElementById('leadsError');
  const leadsTable   = document.getElementById('leadsTable');

  async function loadLeads() {
    leadsLoading.hidden = false;
    leadsEmpty.hidden   = true;
    leadsError.hidden   = true;
    leadsTable.hidden   = true;

    let res;
    try {
      res = await adminFetch('/admin/leads');
    } catch {
      return;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      leadsError.textContent = body.error || 'Failed to load leads.';
      leadsError.hidden = false;
      leadsLoading.hidden = true;
      return;
    }

    const leads = await res.json();
    leadsLoading.hidden = true;

    if (!Array.isArray(leads) || leads.length === 0) {
      leadsEmpty.hidden = false;
      return;
    }

    leadsTable.innerHTML = renderLeadsTable(leads);
    leadsTable.hidden = false;
  }

  function renderLeadsTable(leads) {
    const rows = leads.map(renderLeadRow).join('');
    return `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Contact</th>
            <th>Message</th>
            <th>Notes</th>
            <th>Phone / Company</th>
            <th>Status</th>
            <th>Date</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderLeadRow(lead) {
    const statusMap = {
      new:           'badge--new',
      contacted:     'badge--contacted',
      proposal_sent: 'badge--proposal_sent',
      booked:        'badge--booked',
      closed_won:    'badge--closed_won',
      closed_lost:   'badge--closed_lost',
    };
    const badgeClass = statusMap[lead.status] || 'badge--new';
    const statusLabel = lead.status.replace('_', ' ');
    const badge = `<span class="badge ${badgeClass}">${esc(statusLabel)}</span>`;

    const msgPreview = lead.message.length > 80 ? lead.message.slice(0, 80) + '…' : lead.message;
    const notesPreview = lead.notes ? (lead.notes.length > 60 ? lead.notes.slice(0, 60) + '…' : lead.notes) : '—';

    const date = new Date(lead.created_at).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });

    const statusActions = [
      { label: 'Contacted',     payload: { status: 'contacted' } },
      { label: 'Proposal Sent', payload: { status: 'proposal_sent' } },
      { label: 'Booked',        payload: { status: 'booked' } },
      { label: 'Won',           payload: { status: 'closed_won' } },
      { label: 'Lost',          payload: { status: 'closed_lost' } },
    ].map(({ label, payload }) =>
      `<button class="btn-action" data-lead-id="${esc(lead.id)}" data-payload="${esc(JSON.stringify(payload))}">${label}</button>`
    ).join('');

    const notesBtn = `<button class="btn-action btn-notes" data-lead-id="${esc(lead.id)}" data-current-notes="${esc(lead.notes || '')}">Edit Notes</button>`;
    const archiveBtn = `<button class="btn-action" data-lead-id="${esc(lead.id)}" data-payload="${esc(JSON.stringify({ archived: true }))}">Archive</button>`;
    const deleteBtn = `<button class="btn-delete btn-lead-delete" data-lead-id="${esc(lead.id)}" data-lead-name="${esc(lead.name)}">Delete</button>`;

    return `
      <tr>
        <td>
          <div class="client-name">${esc(lead.name)}</div>
          <div class="client-email">${esc(lead.email)}</div>
        </td>
        <td><div class="lead-message" title="${esc(lead.message)}">${esc(msgPreview)}</div></td>
        <td><div class="lead-notes" title="${esc(lead.notes || '')}">${esc(notesPreview)}</div></td>
        <td>
          <div class="client-name">${esc(lead.phone || '—')}</div>
          <div class="client-email">${esc(lead.company || '—')}</div>
        </td>
        <td>${badge}</td>
        <td class="client-date">${date}</td>
        <td>
          <div class="lead-actions">
            ${statusActions}
            ${notesBtn}
            ${archiveBtn}
            ${deleteBtn}
          </div>
        </td>
      </tr>
    `;
  }

  leadsTable.addEventListener('click', async (e) => {
    // Hard delete
    const deleteBtn = e.target.closest('.btn-lead-delete');
    if (deleteBtn) {
      const leadId = deleteBtn.dataset.leadId;
      const leadName = deleteBtn.dataset.leadName;
      if (!confirm(`Permanently delete lead from "${leadName}"? This cannot be undone.`)) return;

      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Deleting…';

      try {
        const res = await adminFetch(`/admin/leads/${leadId}`, { method: 'DELETE' });
        if (res.ok) {
          loadLeads();
        } else {
          const body = await res.json().catch(() => ({}));
          alert(body.error || 'Failed to delete lead.');
          deleteBtn.disabled = false;
          deleteBtn.textContent = 'Delete';
        }
      } catch {
        deleteBtn.disabled = false;
        deleteBtn.textContent = 'Delete';
      }
      return;
    }

    const btn = e.target.closest('.btn-action');
    if (!btn) return;

    const leadId = btn.dataset.leadId;

    // Notes edit uses a prompt instead of a pre-serialized payload
    if (btn.classList.contains('btn-notes')) {
      const current = btn.dataset.currentNotes || '';
      const updated = prompt('Notes:', current);
      if (updated === null) return; // cancelled
      btn.disabled = true;
      try {
        const res = await adminFetch(`/admin/leads/${leadId}`, {
          method: 'PATCH',
          body: JSON.stringify({ notes: updated }),
        });
        if (res.ok) {
          loadLeads();
        } else {
          const body = await res.json().catch(() => ({}));
          alert(body.error || 'Failed to save notes.');
          btn.disabled = false;
        }
      } catch {
        btn.disabled = false;
      }
      return;
    }

    const payload = btn.dataset.payload;
    if (!payload) return;

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';

    try {
      const res = await adminFetch(`/admin/leads/${leadId}`, {
        method: 'PATCH',
        body: payload,
      });
      if (res.ok) {
        loadLeads();
      } else {
        const body = await res.json().catch(() => ({}));
        alert(body.error || 'Action failed.');
        btn.disabled = false;
        btn.textContent = originalText;
      }
    } catch {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  // ---- Issues list ----

  const issuesLoading = document.getElementById('issuesLoading');
  const issuesEmpty   = document.getElementById('issuesEmpty');
  const issuesError   = document.getElementById('issuesError');
  const issuesTable   = document.getElementById('issuesTable');

  async function loadIssues() {
    issuesLoading.hidden = false;
    issuesEmpty.hidden   = true;
    issuesError.hidden   = true;
    issuesTable.hidden   = true;

    let res;
    try {
      res = await adminFetch('/admin/issues');
    } catch {
      return;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      issuesError.textContent = body.error || 'Failed to load issues.';
      issuesError.hidden = false;
      issuesLoading.hidden = true;
      return;
    }

    const issues = await res.json();
    issuesLoading.hidden = true;

    if (!Array.isArray(issues) || issues.length === 0) {
      issuesEmpty.hidden = false;
      return;
    }

    issuesTable.innerHTML = renderIssuesTable(issues);
    issuesTable.hidden = false;
  }

  function renderIssuesTable(issues) {
    const rows = issues.map(renderIssueRow).join('');
    return `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Subject</th>
            <th>Client</th>
            <th>Type</th>
            <th>Message</th>
            <th>Date</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderIssueRow(issue) {
    const typeLabel = (issue.issue_type || 'other').replace(/_/g, ' ');
    const msgPreview = issue.message.length > 80 ? issue.message.slice(0, 80) + '…' : issue.message;
    const date = new Date(issue.created_at).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });

    const statusSelect = `
      <select class="issue-status-select" data-issue-id="${esc(issue.id)}">
        <option value="open"      ${issue.status === 'open'      ? 'selected' : ''}>Open</option>
        <option value="in_review" ${issue.status === 'in_review' ? 'selected' : ''}>In Review</option>
        <option value="resolved"  ${issue.status === 'resolved'  ? 'selected' : ''}>Resolved</option>
      </select>
    `;

    return `
      <tr>
        <td><div class="client-name">${esc(issue.subject)}</div></td>
        <td><div class="client-email">${esc(issue.client_name || issue.client_id)}</div></td>
        <td><div class="client-email">${esc(typeLabel)}</div></td>
        <td><div class="lead-message" title="${esc(issue.message)}">${esc(msgPreview)}</div></td>
        <td class="client-date">${date}</td>
        <td>${statusSelect}</td>
      </tr>
    `;
  }

  issuesTable.addEventListener('change', async (e) => {
    const select = e.target.closest('.issue-status-select');
    if (!select) return;

    const issueId = select.dataset.issueId;
    const status  = select.value;
    select.disabled = true;

    try {
      const res = await adminFetch(`/admin/issues/${issueId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || 'Failed to update status.');
        loadIssues();
      }
    } catch {
      loadIssues();
    } finally {
      select.disabled = false;
    }
  });

  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---- Init ----

  if (getToken()) {
    showDashboard();
  } else {
    showLogin();
  }
})();
