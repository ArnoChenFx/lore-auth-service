/**
 * admin-panel.ts — A simple browser-based admin panel
 *
 * Served at GET /admin. It uses the existing admin API endpoints:
 *   POST /auth/login        — admin login (returns access + refresh tokens)
 *   POST /auth/refresh      — refresh access token
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
  <meta name="color-scheme" content="light dark">
  <title>Lore Auth — Administration</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f5f7;
      --surface: #ffffff;
      --surface-raised: #ffffff;
      --surface-muted: #eef0f3;
      --text: #171a1f;
      --muted: #68707c;
      --subtle: #949ba5;
      --border: #dfe2e7;
      --border-strong: #c9cdd4;
      --accent: #245edb;
      --accent-hover: #1949b4;
      --accent-soft: #e9effc;
      --danger: #b42318;
      --danger-soft: #fdf0ee;
      --success: #247249;
      --success-soft: #edf7f1;
      --shadow: 0 14px 34px rgba(20, 24, 31, 0.07);
      --focus: rgba(36, 94, 219, 0.22);
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --bg: #111111;
      --surface: #181818;
      --surface-raised: #1c1c1c;
      --surface-muted: #242424;
      --text: #f0f0f0;
      --muted: #aaaaaa;
      --subtle: #7d7d7d;
      --border: #303030;
      --border-strong: #474747;
      --accent: #7da2f8;
      --accent-hover: #9ab7fa;
      --accent-soft: #202d4d;
      --danger: #ff8b82;
      --danger-soft: #3a211f;
      --success: #77c69a;
      --success-soft: #1d3428;
      --shadow: 0 18px 44px rgba(0, 0, 0, 0.24);
      --focus: rgba(125, 162, 248, 0.26);
    }
    * { box-sizing: border-box; }
    html { min-width: 320px; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: Bahnschrift, Aptos, "Segoe UI", sans-serif;
      line-height: 1.5;
      transition: background-color 0.2s ease, color 0.2s ease;
    }
    button, input, select { font: inherit; }
    button:focus-visible, input:focus-visible, select:focus-visible {
      outline: 3px solid var(--focus);
      outline-offset: 1px;
    }
    .app-header {
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }
    .app-header__inner {
      width: min(1120px, calc(100% - 40px));
      min-height: 72px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }
    .brand { display: flex; align-items: center; }
    .brand-name { margin: 0; font-size: 15px; font-weight: 680; letter-spacing: 0.01em; }
    .brand-context {
      margin: 1px 0 0;
      color: var(--muted);
      font: 10px/1.4 Consolas, monospace;
      letter-spacing: 0.09em;
      text-transform: uppercase;
    }
    .header-actions { display: flex; align-items: center; gap: 8px; }
    .theme-toggle, .language-toggle {
      width: 38px;
      min-width: 38px;
      height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      color: var(--muted);
      cursor: pointer;
      transition: border-color 0.15s ease, color 0.15s ease, background-color 0.15s ease;
    }
    .theme-toggle:hover, .language-toggle:hover {
      border-color: var(--border-strong);
      background: var(--surface-muted);
      color: var(--text);
    }
    .theme-toggle__icon { font-size: 15px; line-height: 1; }
    .language-toggle__icon {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.6;
    }
    .container {
      width: min(1120px, calc(100% - 40px));
      margin: 0 auto;
      padding: 36px 0 48px;
    }
    .page-heading {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 22px;
    }
    .kicker {
      margin: 0 0 8px;
      color: var(--accent);
      font: 700 11px/1 Consolas, monospace;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    h1 { margin: 0; font-size: clamp(26px, 4vw, 38px); line-height: 1.12; letter-spacing: -0.03em; }
    .subtitle { margin: 9px 0 0; color: var(--muted); font-size: 14px; }
    .card {
      background: var(--surface-raised);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 14px;
      box-shadow: var(--shadow);
    }
    .login-card { width: min(100%, 460px); padding: 28px; }
    .login-actions {
      display: flex;
      justify-content: flex-end;
      margin-top: 4px;
    }
    /* 登录态隐藏控制台标题，并让登录卡片占据视口的视觉中心。 */
    body[data-view="login"] .container {
      min-height: calc(100vh - 73px);
      padding-block: 32px;
      display: grid;
      place-items: center;
    }
    body[data-view="login"] .page-heading { display: none; }
    body[data-view="login"] .login-card { margin: 0; }
    .card-heading { margin-bottom: 16px; }
    .card-heading h2, .card-heading h3 { margin: 0; font-size: 17px; letter-spacing: -0.01em; }
    .card-heading p { margin: 5px 0 0; color: var(--muted); font-size: 13px; }
    label {
      display: block;
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
    }
    input[type="text"], input[type="password"], select {
      width: 100%;
      height: 42px;
      padding: 0 12px;
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      color: var(--text);
      font-size: 14px;
      transition: border-color 0.15s ease, background-color 0.15s ease;
    }
    input[type="text"]:hover, input[type="password"]:hover, select:hover { border-color: var(--muted); }
    input[type="text"]:focus, input[type="password"]:focus, select:focus { border-color: var(--accent); }
    input::placeholder { color: var(--subtle); }
    select { appearance: none; }
    input[type="checkbox"] {
      width: 16px;
      height: 16px;
      margin: 0;
      accent-color: var(--accent);
    }
    .field { margin-bottom: 16px; }
    .row { display: flex; gap: 12px; align-items: center; }
    .row input { flex: 1; min-width: 0; }
    .dashboard-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(320px, 0.72fr); gap: 14px; }
    .dashboard-grid .card { margin-bottom: 0; }
    .span-full { grid-column: 1 / -1; }
    .access-config-row {
      display: grid;
      grid-template-columns: minmax(160px, 1fr) minmax(160px, 1fr) auto;
      align-items: end;
      gap: 12px;
    }
    .access-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      margin: 0;
    }
    .permissions { display: flex; gap: 8px; flex-wrap: nowrap; margin: 0; }
    .permissions label, .check-label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin: 0;
      padding: 8px 10px;
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--surface);
      color: var(--text);
      font-weight: 500;
      cursor: pointer;
    }
    code {
      color: var(--accent);
      font-family: Consolas, "SFMono-Regular", monospace;
      font-size: 11px;
      word-break: break-all;
    }
    button {
      min-height: 38px;
      padding: 0 14px;
      border: 1px solid transparent;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 650;
      cursor: pointer;
      transition: background-color 0.15s ease, border-color 0.15s ease, transform 0.08s ease;
    }
    button:active { transform: translateY(1px); }
    .btn-primary { background: var(--accent); color: #ffffff; }
    :root[data-theme="dark"] .btn-primary { color: #0d1628; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-danger {
      min-height: 32px;
      padding-inline: 10px;
      background: transparent;
      border-color: var(--border);
      color: var(--danger);
    }
    .btn-danger:hover { background: var(--danger-soft); border-color: var(--danger); }
    .btn-secondary { background: var(--surface); border-color: var(--border); color: var(--text); }
    .btn-secondary:hover { background: var(--surface-muted); border-color: var(--border-strong); }
    .button-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .table-wrap { width: 100%; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; margin-top: 8px; }
    th, td {
      text-align: left;
      padding: 11px 10px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
      vertical-align: middle;
    }
    th {
      color: var(--muted);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: var(--surface-muted); }
    .badge {
      display: inline-block;
      padding: 3px 7px;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .hidden { display: none !important; }
    .message {
      position: fixed;
      z-index: 10;
      right: 24px;
      bottom: 24px;
      max-width: min(380px, calc(100% - 32px));
      padding: 13px 16px;
      border: 1px solid currentColor;
      border-radius: 9px;
      box-shadow: var(--shadow);
      font-size: 13px;
      animation: message-in 0.18s ease-out both;
    }
    .message.error { background: var(--danger-soft); color: var(--danger); }
    .message.success { background: var(--success-soft); color: var(--success); }
    .toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 14px;
      padding: 9px 10px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--surface);
    }
    .toolbar span { color: var(--muted); font-size: 12px; }
    @keyframes message-in {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (max-width: 980px) {
      .access-config-row { grid-template-columns: 1fr 1fr; }
      .access-actions { grid-column: 1 / -1; }
    }
    @media (max-width: 820px) {
      .dashboard-grid { grid-template-columns: 1fr; }
      .span-full { grid-column: auto; }
      .row { align-items: stretch; flex-direction: column; }
      .row .check-label { width: 100%; }
      .row button { width: 100%; }
    }
    @media (max-width: 560px) {
      .app-header__inner, .container { width: min(100% - 28px, 1120px); }
      .container { padding-top: 32px; }
      .page-heading { align-items: flex-start; flex-direction: column; }
      .access-config-row { grid-template-columns: 1fr; }
      .access-actions { grid-column: auto; }
      .card { padding: 20px 16px; }
      .toolbar { align-items: flex-start; flex-direction: column; }
      .access-actions { flex-wrap: wrap; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
    }
  </style>
  <script>
    // 在页面绘制前恢复主题与语言，避免刷新时出现状态跳变。
    (function restorePreferences() {
      const savedTheme = localStorage.getItem('lore_auth_admin_theme');
      const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = savedTheme || (systemPrefersDark ? 'dark' : 'light');
      const savedLanguage = localStorage.getItem('lore_auth_admin_language');
      const language = savedLanguage === 'zh' ? 'zh' : 'en';
      document.documentElement.dataset.language = language;
      document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    })();
  </script>
</head>
<body data-view="login">
  <header class="app-header">
    <div class="app-header__inner">
      <div class="brand">
        <div>
          <p class="brand-name">Lore Auth</p>
          <p class="brand-context">Identity control plane</p>
        </div>
      </div>
      <div class="header-actions">
        <button id="languageToggle" class="language-toggle" type="button" aria-label="切换为中文">
          <svg class="language-toggle__icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9"></circle>
            <path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z"></path>
          </svg>
        </button>
        <button id="themeToggle" class="theme-toggle" type="button" aria-label="Switch to dark mode" aria-pressed="false">
          <span class="theme-toggle__icon" aria-hidden="true">☾</span>
        </button>
      </div>
    </div>
  </header>
  <main class="container">
    <div class="page-heading">
      <div>
        <p class="kicker">Administration</p>
        <h1 data-i18n="pageTitle">Authentication administration</h1>
        <p class="subtitle" data-i18n="pageSubtitle">Manage users, repositories, and access permissions.</p>
      </div>
    </div>

    <div id="message" class="message hidden"></div>

    <!-- 登录区：管理员会话建立后自动切换至控制台。 -->
    <div id="loginCard" class="card login-card">
      <div class="card-heading">
        <h2 data-i18n="loginTitle">Administrator sign in</h2>
        <p data-i18n="loginDescription">Use an administrator account to continue.</p>
      </div>
      <form onsubmit="login(); return false">
        <div class="field">
          <label for="username" data-i18n="username">Username</label>
          <input id="username" type="text" placeholder="Enter your username" data-i18n-placeholder="usernamePlaceholder" autocomplete="username">
        </div>
        <div class="field">
          <label for="password" data-i18n="password">Password</label>
          <input id="password" type="password" placeholder="Enter your password" data-i18n-placeholder="passwordPlaceholder" autocomplete="current-password">
        </div>
        <div class="login-actions">
          <button class="btn-primary" type="submit" data-i18n="signIn">Sign in</button>
        </div>
      </form>
    </div>

    <!-- 管理控制台：采用自适应网格，在窄屏下自动切换为单列。 -->
    <div id="dashboard" class="hidden">
      <div class="toolbar">
        <span id="currentUser"></span>
        <div class="button-row">
          <button class="btn-secondary" onclick="refreshDashboard()" data-i18n="refresh">Refresh</button>
          <button class="btn-secondary" onclick="logout()" data-i18n="signOut">Sign out</button>
        </div>
      </div>

      <div class="dashboard-grid">
        <section class="card">
          <div class="card-heading">
            <h3 data-i18n="createUserTitle">Create user</h3>
            <p data-i18n="createUserDescription">Add a new account that can access Lore services.</p>
          </div>
          <form class="row" onsubmit="createUser(); return false">
            <input id="newUsername" type="text" placeholder="Username" data-i18n-placeholder="newUsernamePlaceholder" data-i18n-aria-label="newUsernameLabel" aria-label="New username" autocomplete="off">
            <input id="newPassword" type="password" placeholder="Initial password" data-i18n-placeholder="newPasswordPlaceholder" data-i18n-aria-label="newPasswordLabel" aria-label="New user password" autocomplete="new-password">
            <label class="check-label">
              <input id="newIsAdmin" type="checkbox"> <span data-i18n="administrator">Administrator</span>
            </label>
            <button class="btn-primary" type="submit" data-i18n="create">Create</button>
          </form>
        </section>

        <section class="card">
          <div class="card-heading">
            <h3 data-i18n="registerRepositoryTitle">Register existing repository</h3>
            <p data-i18n="registerRepositoryDescription">Only for repositories created before authentication was enabled.</p>
          </div>
          <form class="row" onsubmit="registerResource(); return false">
            <input id="resourceId" type="text" placeholder="urc-… repository ID" data-i18n-placeholder="repositoryIdPlaceholder" data-i18n-aria-label="repositoryIdLabel" aria-label="Repository ID">
            <input id="resourceName" type="text" placeholder="Repository name" data-i18n-placeholder="repositoryName" data-i18n-aria-label="repositoryName" aria-label="Repository name">
            <button class="btn-primary" type="submit" data-i18n="register">Register</button>
          </form>
        </section>

        <section class="card span-full">
          <div class="card-heading">
            <h3 data-i18n="usersTitle">Users</h3>
            <p data-i18n="usersDescription">Review account roles and creation dates.</p>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>ID</th><th data-i18n="username">Username</th><th data-i18n="role">Role</th><th data-i18n="created">Created</th><th data-i18n="actions">Actions</th></tr>
              </thead>
              <tbody id="usersTable"></tbody>
            </table>
          </div>
        </section>

        <section class="card span-full">
          <div class="card-heading">
            <h3 data-i18n="repositoryAccessTitle">Repository access</h3>
            <p data-i18n="repositoryAccessDescription">Select a repository and user to configure explicit permissions.</p>
          </div>
          <!-- 桌面端把仓库、用户、权限和保存操作压缩在同一配置行。 -->
          <div class="access-config-row">
            <div class="access-field">
              <label for="accessResource" data-i18n="repository">Repository</label>
              <select id="accessResource"></select>
            </div>
            <div class="access-field">
              <label for="accessUser" data-i18n="user">User</label>
              <select id="accessUser"></select>
            </div>
            <div class="access-actions">
              <div class="permissions">
                <label><input id="permissionRead" type="checkbox"> <span data-i18n="read">Read</span></label>
                <label><input id="permissionWrite" type="checkbox"> <span data-i18n="write">Write</span></label>
                <label><input id="permissionAdmin" type="checkbox"> <span data-i18n="admin">Admin</span></label>
              </div>
              <button class="btn-primary" onclick="saveAccess()" data-i18n="saveAccess">Save access</button>
            </div>
          </div>

          <div class="table-wrap">
            <table>
              <thead>
                <tr><th data-i18n="repository">Repository</th><th data-i18n="user">User</th><th data-i18n="permissions">Permissions</th></tr>
              </thead>
              <tbody id="resourcesTable"></tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  </main>

  <script>
    const tokenKey = 'lore_auth_admin_token';
    const refreshKey = 'lore_auth_admin_refresh';
    const usernameKey = 'lore_auth_admin_user';
    const themeKey = 'lore_auth_admin_theme';
    const languageKey = 'lore_auth_admin_language';
    const translations = {
      en: {
        documentTitle: 'Lore Auth — Administration',
        pageTitle: 'Authentication administration',
        pageSubtitle: 'Manage users, repositories, and access permissions.',
        loginTitle: 'Administrator sign in',
        loginDescription: 'Use an administrator account to continue.',
        username: 'Username',
        usernamePlaceholder: 'Enter your username',
        password: 'Password',
        passwordPlaceholder: 'Enter your password',
        signIn: 'Sign in',
        refresh: 'Refresh',
        signOut: 'Sign out',
        createUserTitle: 'Create user',
        createUserDescription: 'Add a new account that can access Lore services.',
        newUsernamePlaceholder: 'Username',
        newUsernameLabel: 'New username',
        newPasswordPlaceholder: 'Initial password',
        newPasswordLabel: 'New user password',
        administrator: 'Administrator',
        create: 'Create',
        registerRepositoryTitle: 'Register existing repository',
        registerRepositoryDescription: 'Only for repositories created before authentication was enabled.',
        repositoryIdPlaceholder: 'urc-… repository ID',
        repositoryIdLabel: 'Repository ID',
        repositoryName: 'Repository name',
        register: 'Register',
        usersTitle: 'Users',
        usersDescription: 'Review account roles and creation dates.',
        role: 'Role',
        created: 'Created',
        actions: 'Actions',
        repositoryAccessTitle: 'Repository access',
        repositoryAccessDescription: 'Select a repository and user to configure explicit permissions.',
        repository: 'Repository',
        user: 'User',
        read: 'Read',
        write: 'Write',
        admin: 'Admin',
        saveAccess: 'Save access',
        permissions: 'Permissions',
        switchToDark: 'Switch to dark mode',
        switchToLight: 'Switch to light mode',
        switchLanguage: '切换为中文',
        currentAdministrator: 'Current administrator: {username}',
        ordinaryUser: 'User',
        delete: 'Delete',
        noAccess: 'No explicit repository access has been configured.',
        refreshTokenMissing: 'Refresh token is missing.',
        refreshFailed: 'Could not refresh the session.',
        sessionExpired: 'Your session has expired. Please sign in again.',
        requestFailed: 'Request failed.',
        credentialsRequired: 'Enter your username and password.',
        loginFailed: 'Sign in failed.',
        repositoryRequired: 'Enter a repository ID and name.',
        repositoryRegistered: 'Repository registered.',
        selectionRequired: 'Select a repository and user first.',
        accessUpdated: 'Repository access updated.',
        userRequired: 'Enter a username and password.',
        userCreated: 'User created.',
        deleteConfirm: 'Delete user “{username}”?',
        userDeleted: 'User deleted.'
      },
      zh: {
        documentTitle: 'Lore Auth — 认证服务管理',
        pageTitle: '认证服务管理',
        pageSubtitle: '管理用户、仓库与访问权限。',
        loginTitle: '管理员登录',
        loginDescription: '使用管理员账号继续访问控制台。',
        username: '用户名',
        usernamePlaceholder: '请输入用户名',
        password: '密码',
        passwordPlaceholder: '请输入密码',
        signIn: '登录控制台',
        refresh: '刷新数据',
        signOut: '退出登录',
        createUserTitle: '创建用户',
        createUserDescription: '添加可访问 Lore 服务的新账号。',
        newUsernamePlaceholder: '用户名',
        newUsernameLabel: '新用户名称',
        newPasswordPlaceholder: '初始密码',
        newPasswordLabel: '新用户密码',
        administrator: '管理员',
        create: '创建',
        registerRepositoryTitle: '登记现有仓库',
        registerRepositoryDescription: '仅用于启用认证前已创建的仓库。',
        repositoryIdPlaceholder: 'urc-… 仓库 ID',
        repositoryIdLabel: '仓库 ID',
        repositoryName: '仓库名称',
        register: '登记',
        usersTitle: '用户列表',
        usersDescription: '查看账号角色与创建时间。',
        role: '角色',
        created: '创建时间',
        actions: '操作',
        repositoryAccessTitle: '仓库访问权限',
        repositoryAccessDescription: '选择仓库与用户，配置明确的访问能力。',
        repository: '仓库',
        user: '用户',
        read: '读取',
        write: '写入',
        admin: '管理',
        saveAccess: '保存访问权限',
        permissions: '权限',
        switchToDark: '切换为暗色模式',
        switchToLight: '切换为亮色模式',
        switchLanguage: 'Switch to English',
        currentAdministrator: '当前管理员：{username}',
        ordinaryUser: '普通用户',
        delete: '删除',
        noAccess: '暂无明确配置的仓库访问权限。',
        refreshTokenMissing: '缺少刷新令牌。',
        refreshFailed: '刷新登录状态失败。',
        sessionExpired: '登录状态已过期，请重新登录。',
        requestFailed: '请求失败。',
        credentialsRequired: '请输入用户名和密码。',
        loginFailed: '登录失败。',
        repositoryRequired: '请填写仓库 ID 和仓库名称。',
        repositoryRegistered: '仓库登记成功。',
        selectionRequired: '请先选择仓库和用户。',
        accessUpdated: '仓库访问权限已更新。',
        userRequired: '请填写用户名和密码。',
        userCreated: '用户创建成功。',
        deleteConfirm: '确定删除用户“{username}”吗？',
        userDeleted: '用户已删除。'
      }
    };
    let isRefreshing = false;
    let refreshPromise = null;
    let usersCache = [];
    let resourcesCache = [];
    let assignmentsCache = [];

    // 管理 Token 仅保留在当前标签页会话中，关闭标签页后自动清除。
    let currentUsername = sessionStorage.getItem(usernameKey) || '';

    // 统一从当前语言字典取值，并支持少量命名占位符替换。
    function t(key, values = {}) {
      const language = document.documentElement.dataset.language === 'zh' ? 'zh' : 'en';
      let value = translations[language][key] || translations.en[key] || key;
      Object.entries(values).forEach(([name, replacement]) => {
        value = value.replace('{' + name + '}', String(replacement));
      });
      return value;
    }

    /**
     * 将当前语言应用到静态节点、输入提示和无障碍标签。
     * 动态表格使用缓存重新渲染，不发起额外网络请求。
     */
    function applyLanguage() {
      const language = document.documentElement.dataset.language === 'zh' ? 'zh' : 'en';
      document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
      document.title = t('documentTitle');
      document.querySelectorAll('[data-i18n]').forEach(element => {
        element.textContent = t(element.dataset.i18n);
      });
      document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
        element.placeholder = t(element.dataset.i18nPlaceholder);
      });
      document.querySelectorAll('[data-i18n-aria-label]').forEach(element => {
        element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel));
      });

      const languageButton = document.getElementById('languageToggle');
      languageButton.setAttribute('aria-label', t('switchLanguage'));
      languageButton.setAttribute('title', t('switchLanguage'));
      syncThemeToggle();
      updateCurrentUserLabel();
      renderUsersTable();
      renderResourcesTable();
      updateAccessOptions();
    }

    function updateCurrentUserLabel() {
      if (!currentUsername) return;
      document.getElementById('currentUser').textContent = t('currentAdministrator', {
        username: currentUsername
      });
    }

    /**
     * 同步主题切换按钮的可读文本和无障碍状态。
     * 按钮文本描述的是下一步动作，而不是当前主题，降低理解成本。
     */
    function syncThemeToggle() {
      const isDark = document.documentElement.dataset.theme === 'dark';
      const button = document.getElementById('themeToggle');
      button.setAttribute('aria-pressed', String(isDark));
      button.setAttribute('aria-label', isDark ? t('switchToLight') : t('switchToDark'));
      button.setAttribute('title', isDark ? t('switchToLight') : t('switchToDark'));
      button.querySelector('.theme-toggle__icon').textContent = isDark ? '☀' : '☾';
    }

    // 用户主动选择的主题保存在本机，下次访问管理页面时继续沿用。
    document.getElementById('themeToggle').addEventListener('click', function() {
      const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = nextTheme;
      localStorage.setItem(themeKey, nextTheme);
      syncThemeToggle();
    });

    // 语言切换后持久化选择，并立即更新静态和动态内容。
    document.getElementById('languageToggle').addEventListener('click', function() {
      const nextLanguage = document.documentElement.dataset.language === 'zh' ? 'en' : 'zh';
      document.documentElement.dataset.language = nextLanguage;
      localStorage.setItem(languageKey, nextLanguage);
      applyLanguage();
    });

    function showMessage(text, type = 'error') {
      const el = document.getElementById('message');
      el.textContent = text;
      el.className = 'message ' + type;
      el.classList.remove('hidden');
      setTimeout(() => el.classList.add('hidden'), 4000);
    }

    function getAccessToken() {
      return sessionStorage.getItem(tokenKey);
    }

    function setTokens(accessToken, refreshToken) {
      if (accessToken) sessionStorage.setItem(tokenKey, accessToken);
      if (refreshToken) sessionStorage.setItem(refreshKey, refreshToken);
    }

    async function refreshAccessToken() {
      if (isRefreshing) return refreshPromise;
      isRefreshing = true;
      refreshPromise = (async function() {
        const refreshToken = sessionStorage.getItem(refreshKey);
        if (!refreshToken) throw new Error(t('refreshTokenMissing'));
        const res = await fetch('/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || t('refreshFailed'));
        setTokens(data.token, data.refresh_token);
        return data.token;
      })();
      try {
        return await refreshPromise;
      } finally {
        isRefreshing = false;
        refreshPromise = null;
      }
    }

    async function request(url, options = {}, retry = true) {
      const res = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + getAccessToken()
        },
        ...options
      });
      const data = await res.json().catch(() => ({}));

      if (res.status === 401 && retry && sessionStorage.getItem(refreshKey)) {
        try {
          const newToken = await refreshAccessToken();
          return request(url, options, false);
        } catch (refreshErr) {
          logout();
          throw new Error(t('sessionExpired'));
        }
      }

      if (!res.ok) throw new Error(data.error || t('requestFailed'));
      return data;
    }

    async function login() {
      const username = document.getElementById('username').value.trim();
      const password = document.getElementById('password').value;
      if (!username || !password) return showMessage(t('credentialsRequired'));

      try {
        const res = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || t('loginFailed'));

        setTokens(data.token, data.refresh_token);
        sessionStorage.setItem(usernameKey, data.user.username);
        currentUsername = data.user.username;
        enterDashboard();
      } catch (err) {
        showMessage(err.message);
      }
    }

    function logout() {
      sessionStorage.removeItem(tokenKey);
      sessionStorage.removeItem(refreshKey);
      sessionStorage.removeItem(usernameKey);
      currentUsername = '';
      document.body.dataset.view = 'login';
      document.getElementById('loginCard').classList.remove('hidden');
      document.getElementById('dashboard').classList.add('hidden');
    }

    function enterDashboard() {
      document.body.dataset.view = 'dashboard';
      document.getElementById('loginCard').classList.add('hidden');
      document.getElementById('dashboard').classList.remove('hidden');
      updateCurrentUserLabel();
      refreshDashboard();
    }

    async function refreshDashboard() {
      await Promise.all([loadUsers(), loadResources()]);
    }

    async function loadUsers() {
      try {
        const data = await request('/admin/users');
        usersCache = data.users;
        renderUsersTable();
        updateAccessOptions();
      } catch (err) {
        showMessage(err.message);
        if (err.message.includes('invalid') || err.message.includes('expired')) logout();
      }
    }

    // 用户表格从缓存生成，语言切换时无需重新请求接口。
    function renderUsersTable() {
      const tbody = document.getElementById('usersTable');
      tbody.innerHTML = '';
      usersCache.forEach(user => {
        const tr = document.createElement('tr');
        const actionCell = user.username === currentUsername ? '' :
          '<button class="btn-danger" data-username="' + escapeHtml(user.username) + '">' + t('delete') + '</button>';
        tr.innerHTML = '<td>' + user.id + '</td>' +
          '<td>' + escapeHtml(user.username) + '</td>' +
          '<td>' + (user.is_admin ? '<span class="badge">' + t('administrator') + '</span>' : t('ordinaryUser')) + '</td>' +
          '<td>' + formatDate(user.created_at) + '</td>' +
          '<td>' + actionCell + '</td>';
        tbody.appendChild(tr);
      });
    }

    async function loadResources() {
      try {
        const data = await request('/admin/resources');
        resourcesCache = data.resources || [];
        assignmentsCache = data.assignments || [];
        renderResourcesTable();
        updateAccessOptions();
        syncPermissionCheckboxes();
      } catch (err) {
        showMessage(err.message);
      }
    }

    // 权限表格保留权限标识原值，避免翻译展示值影响后端协议字段。
    function renderResourcesTable() {
      const tbody = document.getElementById('resourcesTable');
      tbody.innerHTML = '';
      if (!assignmentsCache.length) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="3" style="color:var(--muted)">' + t('noAccess') + '</td>';
        tbody.appendChild(tr);
        return;
      }
      assignmentsCache.forEach(assignment => {
        const resource = resourcesCache.find(item => item.resource_id === assignment.resource_id);
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td><div>' + escapeHtml(resource ? resource.resource_name : assignment.resource_id) + '</div>' +
          '<code>' + escapeHtml(assignment.resource_id) + '</code></td>' +
          '<td>' + escapeHtml(assignment.username) + '</td>' +
          '<td>' + assignment.permission.map(item => '<span class="badge">' + escapeHtml(item) + '</span>').join(' ') + '</td>';
        tbody.appendChild(tr);
      });
    }

    function updateAccessOptions() {
      const resourceSelect = document.getElementById('accessResource');
      const userSelect = document.getElementById('accessUser');
      const previousResource = resourceSelect.value;
      const previousUser = userSelect.value;

      resourceSelect.innerHTML = '';
      resourcesCache.forEach(resource => {
        resourceSelect.add(new Option(resource.resource_name + ' · ' + resource.resource_id, resource.resource_id));
      });
      userSelect.innerHTML = '';
      usersCache.forEach(user => {
        userSelect.add(new Option(user.username + (user.is_admin ? ' · ' + t('administrator') : ''), user.username));
      });
      if (resourcesCache.some(item => item.resource_id === previousResource)) {
        resourceSelect.value = previousResource;
      }
      if (usersCache.some(item => item.username === previousUser)) {
        userSelect.value = previousUser;
      }
    }

    function syncPermissionCheckboxes() {
      const resourceId = document.getElementById('accessResource').value;
      const username = document.getElementById('accessUser').value;
      const assignment = assignmentsCache.find(
        item => item.resource_id === resourceId && item.username === username
      );
      const permissions = new Set(assignment ? assignment.permission : []);
      document.getElementById('permissionRead').checked = permissions.has('read');
      document.getElementById('permissionWrite').checked = permissions.has('write');
      document.getElementById('permissionAdmin').checked = permissions.has('admin');
    }

    document.getElementById('accessResource').addEventListener('change', syncPermissionCheckboxes);
    document.getElementById('accessUser').addEventListener('change', syncPermissionCheckboxes);

    async function registerResource() {
      const resourceId = document.getElementById('resourceId').value.trim();
      const resourceName = document.getElementById('resourceName').value.trim();
      if (!resourceId || !resourceName) {
        return showMessage(t('repositoryRequired'));
      }
      try {
        await request('/admin/resources', {
          method: 'POST',
          body: JSON.stringify({ resource_id: resourceId, resource_name: resourceName })
        });
        document.getElementById('resourceId').value = '';
        document.getElementById('resourceName').value = '';
        showMessage(t('repositoryRegistered'), 'success');
        await loadResources();
      } catch (err) {
        showMessage(err.message);
      }
    }

    async function saveAccess() {
      const resourceId = document.getElementById('accessResource').value;
      const username = document.getElementById('accessUser').value;
      if (!resourceId || !username) {
        return showMessage(t('selectionRequired'));
      }
      const permissions = [];
      if (document.getElementById('permissionRead').checked) permissions.push('read');
      if (document.getElementById('permissionWrite').checked) permissions.push('write');
      if (document.getElementById('permissionAdmin').checked) permissions.push('admin');
      try {
        await request(
          '/admin/resources/' + encodeURIComponent(resourceId) + '/users/' + encodeURIComponent(username),
          { method: 'PUT', body: JSON.stringify({ permissions }) }
        );
        showMessage(t('accessUpdated'), 'success');
        await loadResources();
      } catch (err) {
        showMessage(err.message);
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
      if (!username || !password) return showMessage(t('userRequired'));

      try {
        await request('/admin/users', {
          method: 'POST',
          body: JSON.stringify({ username, password, is_admin: isAdmin })
        });
        document.getElementById('newUsername').value = '';
        document.getElementById('newPassword').value = '';
        document.getElementById('newIsAdmin').checked = false;
        showMessage(t('userCreated'), 'success');
        loadUsers();
      } catch (err) {
        showMessage(err.message);
      }
    }

    async function deleteUser(username) {
      if (!confirm(t('deleteConfirm', { username }))) return;
      try {
        await request('/admin/users/' + encodeURIComponent(username), { method: 'DELETE' });
        showMessage(t('userDeleted'), 'success');
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
      const locale = document.documentElement.dataset.language === 'zh' ? 'zh-CN' : 'en-US';
      return isNaN(d.getTime()) ? iso : d.toLocaleString(locale);
    }

    // 静态 HTML 使用英文兜底，脚本加载后再应用用户持久化的语言选择。
    applyLanguage();

    // 当前标签页仍保留令牌时，直接恢复管理控制台。
    if (sessionStorage.getItem(tokenKey)) {
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
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    },
  });
}
