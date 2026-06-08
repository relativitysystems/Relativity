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

  function renderTable(clients) {
    const rows = clients.map(renderRow).join('');
    return `
      <table class="admin-table">
        <thead>
          <tr>
            <th>Client</th>
            <th>Status</th>
            <th>Integrations</th>
            <th>Joined</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  function renderRow(c) {
    const badge = c.invite_accepted
      ? `<span class="badge badge--active">Active</span>`
      : `<span class="badge badge--pending">Invite Sent</span>`;

    const integrations = [
      { key: 'dropbox', label: 'Dropbox' },
      { key: 'slack', label: 'Slack' },
      { key: 'google_drive', label: 'Drive' },
    ].map(({ key, label }) =>
      `<span class="integration-tag ${c[key] ? 'integration-tag--on' : ''}">${label}</span>`
    ).join('');

    const joined = new Date(c.created_at).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
    });

    return `
      <tr>
        <td>
          <div class="client-name">${esc(c.name)}</div>
          <div class="client-email">${esc(c.email)}</div>
        </td>
        <td>${badge}</td>
        <td><div class="integration-list">${integrations}</div></td>
        <td class="client-date">${joined}</td>
        <td><button class="btn-delete" data-id="${esc(c.id)}" data-name="${esc(c.name)}">Delete</button></td>
      </tr>
    `;
  }

  // Delete handler — attached via event delegation since rows are re-rendered
  document.getElementById('clientsTable').addEventListener('click', async (e) => {
    const btn = e.target.closest('.btn-delete');
    if (!btn) return;

    const clientId = btn.dataset.id;
    const clientName = btn.dataset.name;
    if (!confirm(`Delete "${clientName}"? This removes their account and all data.`)) return;

    btn.disabled = true;
    btn.textContent = 'Deleting…';

    try {
      const res = await adminFetch(`/admin/clients/${clientId}`, { method: 'DELETE' });
      if (res.ok) {
        loadClients();
      } else {
        const body = await res.json().catch(() => ({}));
        alert(body.error || 'Failed to delete client.');
        btn.disabled = false;
        btn.textContent = 'Delete';
      }
    } catch {
      btn.disabled = false;
      btn.textContent = 'Delete';
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
