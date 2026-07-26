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

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${escapeHtml(title)} · Lore Auth</title>
  <style>
    :root {
      --ink: #e9edf4;
      --muted: #8e99aa;
      --line: #2a3340;
      --panel: #111820;
      --panel-strong: #17212b;
      --blue: #78a4ff;
      --blue-strong: #9bbcff;
      --green: #6dd6a8;
      --red: #ff8f8f;
      --bg: #091016;
    }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body {
      margin: 0;
      background:
        linear-gradient(rgba(120,164,255,.035) 1px, transparent 1px),
        linear-gradient(90deg, rgba(120,164,255,.035) 1px, transparent 1px),
        radial-gradient(circle at 18% 12%, rgba(120,164,255,.12), transparent 32rem),
        var(--bg);
      background-size: 28px 28px, 28px 28px, auto, auto;
      color: var(--ink);
      font-family: Bahnschrift, "Aptos Narrow", "Segoe UI", sans-serif;
      display: grid;
      place-items: center;
      padding: 28px;
    }
    .frame {
      width: min(100%, 470px);
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--panel) 94%, transparent);
      box-shadow: 0 24px 70px rgba(0,0,0,.38);
      animation: arrive .32s ease-out both;
    }
    .rail {
      height: 4px;
      background: linear-gradient(90deg, var(--blue) 0 42%, #35465b 42% 68%, var(--green) 68%);
    }
    header {
      display: grid;
      grid-template-columns: 42px 1fr auto;
      align-items: center;
      gap: 13px;
      padding: 18px 20px;
      border-bottom: 1px solid var(--line);
    }
    .mark {
      width: 42px;
      height: 42px;
      border: 1px solid #415064;
      display: grid;
      place-items: center;
      color: var(--blue-strong);
      font: 700 18px/1 Consolas, monospace;
      background: #0d141b;
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
    main { padding: 24px 20px 22px; }
    .intro {
      margin: 0 0 22px;
      color: #bdc6d3;
      font-size: 13px;
      line-height: 1.7;
    }
    .intro small { color: var(--muted); }
    label {
      display: block;
      margin: 0 0 7px;
      color: #cbd3de;
      font-size: 12px;
      letter-spacing: .02em;
    }
    input {
      width: 100%;
      height: 42px;
      margin: 0 0 16px;
      border: 1px solid #354152;
      border-radius: 0;
      outline: 0;
      background: #0b1218;
      color: var(--ink);
      padding: 0 12px;
      font: 14px/1.2 Bahnschrift, "Segoe UI", sans-serif;
      transition: border-color .14s, background .14s;
    }
    input:hover { border-color: #52647c; }
    input:focus {
      border-color: var(--blue);
      outline: 2px solid rgba(120,164,255,.2);
      outline-offset: 1px;
      background: #0e161e;
    }
    button {
      width: 100%;
      height: 43px;
      border: 1px solid #98b7f8;
      border-radius: 0;
      background: var(--blue);
      color: #07111d;
      font: 650 13px/1 Bahnschrift, "Segoe UI", sans-serif;
      letter-spacing: .03em;
      cursor: pointer;
      transition: background .14s, transform .08s;
    }
    button:hover { background: var(--blue-strong); }
    button:active { transform: translateY(1px); }
    button:focus-visible { outline: 2px solid #dce8ff; outline-offset: 2px; }
    .message {
      margin: 0 0 18px;
      padding: 11px 12px;
      border-left: 3px solid var(--red);
      background: rgba(255,143,143,.08);
      color: #ffc1c1;
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
      border: 1px solid rgba(109,214,168,.62);
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
      color: #6f7b8b;
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
  </style>
</head>
<body>
  <section class="frame" aria-labelledby="page-title">
    <div class="rail"></div>
    <header>
      <div class="mark" aria-hidden="true">L/</div>
      <div>
        <p class="eyebrow">Lore Remote Identity</p>
        <h1 id="page-title">${escapeHtml(title)}</h1>
      </div>
      <span class="live">● SECURE</span>
    </header>
    <main>${body}</main>
    <footer><span>AUTHN / BROWSER SESSION</span><span>JWT · RS256</span></footer>
  </section>
</body>
</html>`;
}

export interface LoginPageOptions {
  sessionCode: string;
  clientState: string;
  error?: string;
}

export function renderLoginPage(options: LoginPageOptions): string {
  const error = options.error
    ? `<div class="message" role="alert">${escapeHtml(options.error)}</div>`
    : "";
  return pageShell(
    "授权 Lore Client",
    `<p class="intro">
      使用已注册的 Lore 账号批准本次桌面登录。凭据只会提交给认证服务。
      <br><small>Sign in to approve this Lore desktop session.</small>
    </p>
    ${error}
    <form method="post" action="/auth/session/approve">
      <input type="hidden" name="session_code" value="${escapeHtml(options.sessionCode)}">
      <input type="hidden" name="client_state" value="${escapeHtml(options.clientState)}">
      <label for="username">用户名 / Username</label>
      <input id="username" name="username" type="text" required maxlength="128"
             autocomplete="username" autofocus>
      <label for="password">密码 / Password</label>
      <input id="password" name="password" type="password" required maxlength="1024"
             autocomplete="current-password">
      <button type="submit">批准并登录 / APPROVE SESSION</button>
    </form>`,
  );
}

export function renderLoginSuccess(username: string): string {
  return pageShell(
    "认证完成",
    `<div class="success">
      <div class="success-icon" aria-hidden="true">✓</div>
      <h2>账号 ${escapeHtml(username)} 已授权</h2>
      <p>Lore Client 正在领取安全凭据，现在可以关闭此页面。<br>
         Lore Client is receiving the credential. You may close this page.</p>
    </div>`,
  );
}

export function renderInvalidSession(message = "登录会话无效或已经过期，请返回 Lore Client 重试。"): string {
  return pageShell(
    "会话不可用",
    `<div class="success">
      <div class="success-icon" style="color:var(--red);border-color:rgba(255,143,143,.55)" aria-hidden="true">!</div>
      <h2>无法继续认证</h2>
      <p>${escapeHtml(message)}<br>The authentication session cannot be used.</p>
    </div>`,
  );
}
