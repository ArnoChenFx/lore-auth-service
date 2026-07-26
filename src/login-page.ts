/**
 * login-page.ts — Lore 系统浏览器认证页面
 *
 * 页面不保存 Token、不设置登录 Cookie，也不向桌面应用做自定义协议回调。提交成功后
 * 只批准一次短期会话，Lore Client 会通过 gRPC 轮询领取 JWT。
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

interface LocalizedText {
  en: string;
  zh: string;
}

function pageShell(title: LocalizedText, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(title.en)} · Lore Auth</title>
  <script>
    // 首次访问跟随系统主题；用户手动选择后优先恢复本地偏好。
    (function restoreTheme() {
      const savedTheme = localStorage.getItem('lore_auth_theme');
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
      document.documentElement.dataset.theme =
        savedTheme === 'light' || savedTheme === 'dark' ? savedTheme : systemTheme;
    })();
  </script>
  <style>
    :root {
      color-scheme: light;
      --ink: #1c1c1c;
      --muted: #686868;
      --line: #d7d7d7;
      --line-strong: #b8b8b8;
      --panel: #ffffff;
      --panel-muted: #f2f2f2;
      --input-focus: #f7f7f7;
      --accent: #252525;
      --accent-strong: #000000;
      --button-ink: #ffffff;
      --focus-accent: #245edb;
      --green: #247249;
      --red: #b42318;
      --bg: #f3f3f3;
      --focus: rgba(36, 94, 219, .22);
      --intro: #505050;
      --label: #3c3c3c;
      --input-hover: #7a7a7a;
      --message-bg: #fdf0ee;
      --message-text: #8f1d16;
      --footer: #767676;
      --shadow: 0 24px 64px rgba(25,25,25,.12);
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --ink: #f0f0f0;
      --muted: #a3a3a3;
      --line: #333333;
      --line-strong: #505050;
      --panel: #1b1b1b;
      --panel-muted: #131313;
      --input-focus: #202020;
      --accent: #dadde1;
      --accent-strong: #ffffff;
      --button-ink: #141414;
      --focus-accent: #7da2f8;
      --green: #81c6a0;
      --red: #f29a92;
      --bg: #101010;
      --focus: rgba(125, 162, 248, .28);
      --intro: #bfc2c6;
      --label: #d0d0d0;
      --input-hover: #707070;
      --message-bg: #2b1e1d;
      --message-text: #f5b4ae;
      --footer: #7d7d7d;
      --shadow: 0 24px 64px rgba(0,0,0,.3);
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Bahnschrift, "Aptos Narrow", "Segoe UI", sans-serif;
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .frame {
      width: min(100%, 470px);
      border: 1px solid var(--line);
      border-radius: 14px;
      overflow: hidden;
      background: var(--panel);
      box-shadow: var(--shadow);
      animation: arrive .32s ease-out both;
    }
    header {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 13px;
      padding: 18px 20px;
      border-bottom: 1px solid var(--line);
    }
    .eyebrow {
      margin: 0 0 3px;
      color: var(--muted);
      font: 600 10px/1.2 Consolas, monospace;
      letter-spacing: .18em;
      text-transform: uppercase;
    }
    h1 { margin: 0; font-size: 18px; font-weight: 560; letter-spacing: .01em; }
    .live {
      color: var(--green);
      font: 600 10px/1 Consolas, monospace;
      letter-spacing: .08em;
    }
    .header-status { display: flex; align-items: center; gap: 10px; }
    .language-toggle, .theme-toggle {
      width: 30px;
      height: 30px;
      padding: 0;
      border: 1px solid var(--line-strong);
      border-radius: 6px;
      background: transparent;
      color: var(--muted);
      display: grid;
      place-items: center;
      font: 600 10px/1 Bahnschrift, "Segoe UI", sans-serif;
      letter-spacing: .04em;
    }
    .language-toggle svg {
      width: 15px;
      height: 15px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.6;
    }
    .theme-toggle__icon {
      width: 16px;
      height: 16px;
      display: grid;
      place-items: center;
    }
    .theme-toggle__icon svg {
      grid-area: 1 / 1;
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.7;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .theme-toggle__sun { display: none; }
    :root[data-theme="dark"] .theme-toggle__moon { display: none; }
    :root[data-theme="dark"] .theme-toggle__sun { display: block; }
    .language-toggle:hover, .theme-toggle:hover { background: var(--panel-muted); color: var(--ink); }
    main { padding: 26px 20px 24px; }
    .intro {
      margin: 0 0 22px;
      color: var(--intro);
      font-size: 13px;
      line-height: 1.7;
    }
    .intro small { color: var(--muted); }
    label {
      display: block;
      margin: 0 0 7px;
      color: var(--label);
      font-size: 12px;
      letter-spacing: .02em;
    }
    input {
      width: 100%;
      height: 44px;
      margin: 0 0 16px;
      border: 1px solid var(--line-strong);
      border-radius: 8px;
      outline: 0;
      background: var(--panel-muted);
      color: var(--ink);
      padding: 0 12px;
      font: 14px/1.2 Bahnschrift, "Segoe UI", sans-serif;
      transition: border-color .14s, background .14s;
    }
    input:hover { border-color: var(--input-hover); }
    input:focus {
      border-color: var(--focus-accent);
      outline: 3px solid var(--focus);
      outline-offset: 1px;
      background: var(--input-focus);
    }
    /*
     * 浏览器自动填充会自行覆盖输入框背景；使用大尺寸内阴影强制保持中性灰，
     * 同时保留账号文字和光标的可读性。
     */
    input:-webkit-autofill,
    input:-webkit-autofill:hover {
      -webkit-text-fill-color: var(--ink);
      -webkit-box-shadow: 0 0 0 1000px var(--panel-muted) inset;
      caret-color: var(--ink);
    }
    input:-webkit-autofill:focus {
      -webkit-text-fill-color: var(--ink);
      -webkit-box-shadow: 0 0 0 1000px var(--input-focus) inset;
      caret-color: var(--ink);
    }
    button {
      width: 100%;
      height: 44px;
      border: 1px solid var(--accent);
      border-radius: 8px;
      background: var(--accent);
      color: var(--button-ink);
      font: 650 13px/1 Bahnschrift, "Segoe UI", sans-serif;
      letter-spacing: .03em;
      cursor: pointer;
      transition: background .14s, transform .08s;
    }
    button:hover { background: var(--accent-strong); }
    button:active { transform: translateY(1px); }
    button:focus-visible { outline: 2px solid var(--focus-accent); outline-offset: 2px; }
    .message {
      margin: 0 0 18px;
      padding: 11px 12px;
      border: 1px solid var(--red);
      border-radius: 8px;
      background: var(--message-bg);
      color: var(--message-text);
      font-size: 12px;
      line-height: 1.55;
    }
    .success {
      padding: 8px 0 2px;
      text-align: center;
    }
    .success-icon {
      width: 58px;
      height: 58px;
      margin: 0 auto 18px;
      border: 1px solid var(--green);
      border-radius: 50%;
      color: var(--green);
      display: grid;
      place-items: center;
      font: 700 25px/1 Consolas, monospace;
    }
    .success h2 { margin: 0 0 9px; font-size: 19px; font-weight: 560; }
    .success p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.7; }
    footer {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 20px;
      border-top: 1px solid var(--line);
      color: var(--footer);
      font: 10px/1.3 Consolas, monospace;
      letter-spacing: .04em;
    }
    @keyframes arrive {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .frame { animation: none; }
      * { transition: none !important; }
    }
    @media (max-width: 420px) {
      body { padding: 14px; }
      header { grid-template-columns: 1fr auto; padding-inline: 16px; }
      .live { display: none; }
      main { padding-inline: 16px; }
      footer { padding-inline: 16px; }
    }
  </style>
</head>
<body>
  <section class="frame" aria-labelledby="page-title">
    <header>
      <div>
        <p class="eyebrow">Lore Remote Identity</p>
        <h1 id="page-title" data-en="${escapeHtml(title.en)}" data-zh="${escapeHtml(title.zh)}">${escapeHtml(title.en)}</h1>
      </div>
      <div class="header-status">
        <button id="languageToggle" class="language-toggle" type="button" aria-label="切换为中文">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9"></circle>
            <path d="M3 12h18M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3z"></path>
          </svg>
        </button>
        <button id="themeToggle" class="theme-toggle" type="button" aria-label="Switch to dark mode" aria-pressed="false">
          <span class="theme-toggle__icon" aria-hidden="true">
            <svg class="theme-toggle__moon" viewBox="0 0 24 24">
              <path d="M20 15.2A8.5 8.5 0 0 1 8.8 4a8.5 8.5 0 1 0 11.2 11.2z"></path>
            </svg>
            <svg class="theme-toggle__sun" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="3.5"></circle>
              <path d="M12 2.5v2M12 19.5v2M4.8 4.8l1.4 1.4M17.8 17.8l1.4 1.4M2.5 12h2M19.5 12h2M4.8 19.2l1.4-1.4M17.8 6.2l1.4-1.4"></path>
            </svg>
          </span>
        </button>
        <span class="live">● SECURE</span>
      </div>
    </header>
    <main>${body}</main>
    <footer><span>AUTHN / BROWSER SESSION</span><span>JWT · RS256</span></footer>
  </section>
  <script>
    // 认证页默认使用英文，仅在用户主动切换后恢复中文偏好。
    const languageKey = 'lore_auth_language';
    const themeKey = 'lore_auth_theme';
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
    const savedLanguage = localStorage.getItem(languageKey);
    let currentLanguage = savedLanguage === 'zh' ? 'zh' : 'en';

    // 同步主题按钮图标和无障碍文本；按钮描述下一步将执行的动作。
    function syncThemeToggle() {
      const isDark = document.documentElement.dataset.theme === 'dark';
      const label = currentLanguage === 'zh'
        ? (isDark ? '切换为亮色模式' : '切换为暗色模式')
        : (isDark ? 'Switch to light mode' : 'Switch to dark mode');
      const toggle = document.getElementById('themeToggle');
      toggle.setAttribute('aria-label', label);
      toggle.setAttribute('title', label);
      toggle.setAttribute('aria-pressed', String(isDark));
    }

    /**
     * 文案直接存放在受服务端转义的数据属性中，不执行任何动态 HTML，
     * 从而在支持即时切换的同时避免把错误信息或用户名解释为标记。
     */
    function applyLanguage() {
      document.documentElement.lang = currentLanguage === 'zh' ? 'zh-CN' : 'en';
      document.querySelectorAll('[data-en][data-zh]').forEach(element => {
        element.textContent = element.dataset[currentLanguage];
      });
      const pageTitle = document.getElementById('page-title').dataset[currentLanguage];
      document.title = pageTitle + ' · Lore Auth';
      const toggle = document.getElementById('languageToggle');
      const label = currentLanguage === 'zh' ? 'Switch to English' : '切换为中文';
      toggle.setAttribute('aria-label', label);
      toggle.setAttribute('title', label);
      syncThemeToggle();
    }

    document.getElementById('languageToggle').addEventListener('click', function() {
      currentLanguage = currentLanguage === 'zh' ? 'en' : 'zh';
      localStorage.setItem(languageKey, currentLanguage);
      applyLanguage();
    });

    // 手动切换后保存偏好；未手动选择时继续响应操作系统主题变化。
    document.getElementById('themeToggle').addEventListener('click', function() {
      const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = nextTheme;
      localStorage.setItem(themeKey, nextTheme);
      syncThemeToggle();
    });
    systemTheme.addEventListener('change', function(event) {
      if (localStorage.getItem(themeKey)) return;
      document.documentElement.dataset.theme = event.matches ? 'dark' : 'light';
      syncThemeToggle();
    });
    applyLanguage();
  </script>
</body>
</html>`;
}

export interface LoginPageOptions {
  sessionCode: string;
  clientState: string;
  error?: LocalizedText;
}

export function renderLoginPage(options: LoginPageOptions): string {
  const error = options.error
    ? `<div class="message" role="alert" data-en="${escapeHtml(options.error.en)}" data-zh="${escapeHtml(options.error.zh)}">${escapeHtml(options.error.en)}</div>`
    : "";
  return pageShell(
    { en: "Authorize Lore Client", zh: "授权 Lore Client" },
    `<p class="intro" data-en="Sign in with your registered Lore account to approve this desktop session. Your credentials are sent only to the authentication service." data-zh="使用已注册的 Lore 账号批准本次桌面登录。凭据只会提交给认证服务。">Sign in with your registered Lore account to approve this desktop session. Your credentials are sent only to the authentication service.</p>
    ${error}
    <form method="post" action="/auth/session/approve">
      <input type="hidden" name="session_code" value="${escapeHtml(options.sessionCode)}">
      <input type="hidden" name="client_state" value="${escapeHtml(options.clientState)}">
      <label for="username" data-en="Username" data-zh="用户名">Username</label>
      <input id="username" name="username" type="text" required maxlength="128"
             autocomplete="username" autofocus>
      <label for="password" data-en="Password" data-zh="密码">Password</label>
      <input id="password" name="password" type="password" required maxlength="1024"
             autocomplete="current-password">
      <button type="submit" data-en="Approve and sign in" data-zh="批准并登录">Approve and sign in</button>
    </form>`,
  );
}

export function renderLoginSuccess(username: string): string {
  return pageShell(
    { en: "Authentication complete", zh: "认证完成" },
    `<div class="success">
      <div class="success-icon" aria-hidden="true">✓</div>
      <h2 data-en="Account ${escapeHtml(username)} authorized" data-zh="账号 ${escapeHtml(username)} 已授权">Account ${escapeHtml(username)} authorized</h2>
      <p data-en="Lore Client is receiving the secure credential. You may close this page." data-zh="Lore Client 正在领取安全凭据，现在可以关闭此页面。">Lore Client is receiving the secure credential. You may close this page.</p>
    </div>`,
  );
}

export function renderInvalidSession(
  message: LocalizedText = {
    en: "The authentication session is invalid or has expired. Return to Lore Client and try again.",
    zh: "登录会话无效或已经过期，请返回 Lore Client 重试。",
  },
): string {
  return pageShell(
    { en: "Session unavailable", zh: "会话不可用" },
    `<div class="success">
      <div class="success-icon" style="color:var(--red);border-color:var(--red)" aria-hidden="true">!</div>
      <h2 data-en="Authentication cannot continue" data-zh="无法继续认证">Authentication cannot continue</h2>
      <p data-en="${escapeHtml(message.en)}" data-zh="${escapeHtml(message.zh)}">${escapeHtml(message.en)}</p>
    </div>`,
  );
}
