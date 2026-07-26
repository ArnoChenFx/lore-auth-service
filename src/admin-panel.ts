/**
 * admin-panel.ts — A simple browser-based admin panel
 *
 * Served at GET /admin. It uses the existing admin API endpoints:
 *   POST /auth/login        — admin login
 *   GET  /admin/users       — list users
 *   POST /admin/users       — create user
 *   DEL  /admin/users/:name — delete user
 *
 * All HTML, CSS and JS are embedded so the service stays dependency-free.
 */

export const ADMIN_PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lore Auth — Admin Panel</title>
  <style>
    :root {
      --bg: #0f1115;
      --card: #181b21;
      --text: #e4e6eb;
      --muted: #9ca3af;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --danger: #ef4444;
      --danger-hover: #dc2626;
      --border: #2d333b;
      --input-bg: #21262d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    .container {
      max-width: 720px;
      margin: 0 auto;
      padding: 2rem 1rem;
    }
    h1 { margin: 0 0 0.5rem; font-size: 1.5rem; }
    .subtitle { color: var(--muted); margin-bottom: 1.5rem; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 0.75rem;
      padding: 1.25rem;
      margin-bottom: 1rem;
    }
    label {
      display: block;
      margin-bottom: 0.25rem;
      font-size: 0.875rem;
      color: var(--muted);
    }
    input[type="text"], input[type="password"] {
      width: 100%;
      padding: 0.6rem 0.75rem;
      background: var(--input-bg);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      color: var(--text);
      font-size: 0.95rem;
      margin-bottom: 0.75rem;
    }
    input[type="checkbox"] { margin-right: 0.5rem; }
    .row { display: flex; gap: 0.75rem; align-items: center; }
    .row input { flex: 1; margin-bottom: 0; }
    button {
      padding: 0.6rem 1rem;
      border: none;
      border-radius: 0.5rem;
      font-size: 0.95rem;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn-primary {
      background: var(--accent);
      color: white;
    }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-danger {
      background: var(--danger);
      color: white;
    }
    .btn-danger:hover { background: var(--danger-hover); }
    .btn-secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
    }
    .btn-secondary:hover { background: rgba(255,255,255,0.05); }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 0.75rem;
    }
    th, td {
      text-align: left;
      padding: 0.75rem 0.5rem;
      border-bottom: 1px solid var(--border);
    }
    th { color: var(--muted); font-weight: 500; font-size: 0.875rem; }
    .badge {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 999px;
      font-size: 0.75rem;
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
    }
    .hidden { display: none !important; }
    .message {
      padding: 0.75rem 1rem;
      border-radius: 0.5rem;
      margin-bottom: 1rem;
      font-size: 0.9rem;
    }
    .message.error { background: rgba(239, 68, 68, 0.12); color: #fca5a5; }
    .message.success { background: rgba(34, 197, 94, 0.12); color: #86efac; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
    .toolbar span { color: var(--muted); font-size: 0.9rem; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Lore Auth Admin Panel</h1>
    <p class="subtitle">Manage users for the Lore Auth service.</p>

    <div id="message" class="message hidden"></div>

    <!-- Login -->
    <div id="loginCard" class="card">
      <label for="username">Username</label>
      <input id="username" type="text" placeholder="admin" autocomplete="username">
      <label for="password">Password</label>
      <input id="password" type="password" placeholder="••••••" autocomplete="current-password">
      <button class="btn-primary" onclick="login()">Sign in</button>
    </div>

    <!-- Dashboard -->
    <div id="dashboard" class="hidden">
      <div class="toolbar">
        <span id="currentUser"></span>
        <div>
          <button class="btn-secondary" onclick="loadUsers()">Refresh</button>
          <button class="btn-secondary" onclick="logout()">Sign out</button>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-top:0">Create user</h3>
        <div class="row">
          <input id="newUsername" type="text" placeholder="Username">
          <input id="newPassword" type="password" placeholder="Password">
          <label style="display:flex;align-items:center;white-space:nowrap;margin:0">
            <input id="newIsAdmin" type="checkbox"> Admin
          </label>
          <button class="btn-primary" onclick="createUser()">Create</button>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-top:0">Users</h3>
        <table>
          <thead>
            <tr><th>ID</th><th>Username</th><th>Role</th><th>Created</th><th></th></tr>
          </thead>
          <tbody id="usersTable"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    const tokenKey = 'lore_auth_admin_token';
    const usernameKey = 'lore_auth_admin_user';

    let currentUsername = localStorage.getItem(usernameKey) || '';

    function showMessage(text, type = 'error') {
      const el = document.getElementById('message');
      el.textContent = text;
      el.className = 'message ' + type;
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('hidden'), 4000);
    }

    async function request(url, options = {}) {
      const res = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + localStorage.getItem(tokenKey)
        },
        ...options
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Request failed');
      return data;
    }

    async function login() {
      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;
      if (!username || !password) return showMessage('Please enter username and password.');

      try {
        const res = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');

        localStorage.setItem(tokenKey, data.token);
        localStorage.setItem(usernameKey, data.user.username);
        currentUsername = data.user.username;
        enterDashboard();
      } catch (err) {
        showMessage(err.message);
      }
    }

    function logout() {
      localStorage.removeItem(tokenKey);
      localStorage.removeItem(usernameKey);
      currentUsername = '';
      document.getElementById('loginCard').classList.remove('hidden');
      document.getElementById('dashboard').classList.add('hidden');
    }

    function enterDashboard() {
      document.getElementById('loginCard').classList.add('hidden');
      document.getElementById('dashboard').classList.remove('hidden');
      document.getElementById('currentUser').textContent = 'Signed in as ' + currentUsername;
      loadUsers();
    }

    async function loadUsers() {
      try {
        const data = await request('/admin/users');
        const tbody = document.getElementById('usersTable');
        tbody.innerHTML = '';
        data.users.forEach(u => {
          const tr = document.createElement('tr');
          const actionCell = u.username === currentUsername ? '' :
            '<button class="btn-danger" data-username="' + escapeHtml(u.username) + '">Delete</button>';
          tr.innerHTML = '<td>' + u.id + '</td>' +
            '<td>' + escapeHtml(u.username) + '</td>' +
            '<td>' + (u.is_admin ? '<span class="badge">Admin</span>' : 'User') + '</td>' +
            '<td>' + formatDate(u.created_at) + '</td>' +
            '<td>' + actionCell + '</td>';
          tbody.appendChild(tr);
        });
      } catch (err) {
        showMessage(err.message);
        if (err.message.includes('invalid') || err.message.includes('expired')) logout();
      }
    }

    document.getElementById('usersTable').addEventListener('click', function(e) {
      const btn = e.target.closest('button[data-username]');
      if (!btn) return;
      const username = btn.getAttribute('data-username');
      if (username) deleteUser(username);
    });

    async function createUser() {
      const username = document.getElementById('newUsername').value.trim();
      const password = document.getElementById('newPassword').value;
      const isAdmin = document.getElementById('newIsAdmin').checked;
      if (!username || !password) return showMessage('Username and password are required.');

      try {
        await request('/admin/users', {
          method: 'POST',
          body: JSON.stringify({ username, password, is_admin: isAdmin })
        });
        document.getElementById('newUsername').value = '';
        document.getElementById('newPassword').value = '';
        document.getElementById('newIsAdmin').checked = false;
        showMessage('User created.', 'success');
        loadUsers();
      } catch (err) {
        showMessage(err.message);
      }
    }

    async function deleteUser(username) {
      if (!confirm('Delete user "' + username + '"?')) return;
      try {
        await request('/admin/users/' + encodeURIComponent(username), { method: 'DELETE' });
        showMessage('User deleted.', 'success');
        loadUsers();
      } catch (err) {
        showMessage(err.message);
      }
    }

    function escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function formatDate(iso) {
      if (!iso) return '-';
      const d = new Date(iso);
      return isNaN(d.getTime()) ? iso : d.toLocaleString();
    }

    // Auto-enter dashboard if a token is already stored
    if (localStorage.getItem(tokenKey)) {
      enterDashboard();
    }
  </script>
</body>
</html>`;

/**
 * Serve the admin panel HTML page.
 */
export function handleAdminPanel(): Response {
  return new Response(ADMIN_PANEL_HTML, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
