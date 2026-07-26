# Lore Auth Service

Lore Auth Service 是基于 TypeScript 与 Bun 实现的 Lore 原生浏览器认证及仓库授权服务。它提供 `ucs.auth.UrcAuthApi`、`ucs.auth.RebacApi` gRPC 服务，签发 Lore 兼容的 RS256 JWT，发布 JWKS，并附带轻量浏览器管理后台。

[English](README.md) · [集成交付说明](AUTH_INTEGRATION.md)

## 已实现能力

- Lore 原生浏览器登录：创建会话、打开登录页、轮询并取得 AuthN Token
- 含 Lore 必需 Claims 的 AuthN JWT 与仓库范围 AuthZ JWT
- 通过 `LookupUserPermissions` 浏览有权访问的仓库
- 通过 Lore ReBAC 创建和删除仓库资源
- 按用户配置仓库 `read`、`write`、`admin` 权限
- 使用 scrypt 哈希密码的本地账号
- 供 Lore Server 验签的 JWKS
- 面向管理后台和 API 客户端的 REST Access/Refresh Token
- 使用 SQLite 持久化用户、Refresh Token 哈希、浏览器会话哈希、资源和权限

## 认证流程

```mermaid
sequenceDiagram
    participant C as Lore Client
    participant A as Lore Auth gRPC :50051
    participant B as 系统浏览器
    participant H as Lore Auth HTTPS :8080
    participant S as Lore Server

    C->>A: StartAuthSession(client_state)
    A-->>C: session_code + login_url
    C->>B: 打开 login_url
    B->>H: 提交用户名和密码
    H-->>B: 会话批准成功
    loop 每 5 秒
      C->>A: GetAuthSession(client_state, session_code)
    end
    A-->>C: AuthN JWT
    C->>A: 查询权限 / 交换仓库资源
    A-->>C: 仓库范围 AuthZ JWT
    C->>S: 携带 Bearer AuthZ JWT 的 Lore 请求
    S->>H: 按需读取 JWKS
```

用户名和密码只会提交到认证服务的浏览器页面，不进入 Lore Client。JWT 不会写入浏览器 URL 或页面内容。

## 本地开发快速开始

前置条件：Bun 1.3 或更高版本。

```bash
bun install
cp .env.example .env
bun run start
```

第一次启动时，空数据库会创建配置中的管理员。开发默认账号为 `admin / changeme`；服务对外开放前必须修改 `ADMIN_PASSWORD`。

常用端点：

```bash
curl http://localhost:8080/health_check
curl http://localhost:8080/.well-known/jwks.json
```

打开 `http://localhost:8080/admin` 可管理用户、登记启用认证前已经存在的仓库，并分配仓库权限。

默认 gRPC 是明文端点，仅用于自动化测试和本地 API 开发。当前 Lore 客户端会把认证端点转换为 HTTPS，因此真实桌面登录必须使用下面的生产 TLS 配置。

## 生产环境配置

准备 `auth.example.com` 一类 DNS 名称，以及 Lore Client 和 Lore Server 所在机器都信任的证书。服务可在 HTTP 与 gRPC 端口复用同一张证书。

环境变量示例：

```dotenv
HOST=0.0.0.0
PORT=8080
GRPC_HOST=0.0.0.0
GRPC_PORT=50051

PUBLIC_BASE_URL=https://auth.example.com:8080
JWT_ISSUER=https://auth.example.com:8080
JWT_AUDIENCE=lore.example.com
LORE_ENVIRONMENT=production

TLS_CERT_FILE=/run/secrets/lore-auth/fullchain.pem
TLS_KEY_FILE=/run/secrets/lore-auth/privkey.pem

ADMIN_USERNAME=admin
ADMIN_PASSWORD=替换为足够长的随机密码
```

关键点：

- `PUBLIC_BASE_URL` 是返回给浏览器的 `login_url` 所使用的 HTTPS Origin。
- Lore 认证端点是 `https://auth.example.com:50051`。
- `JWT_ISSUER` 必须与 Lore Server 的 `server.auth.jwt_issuer` 完全一致。
- `JWT_AUDIENCE` 是逗号分隔列表，必须包含 Lore Server 远端 URL 使用的真实主机名，例如 `lore.example.com`；不能再使用 `lore-service` 这类抽象名称。
- 证书必须覆盖认证端点主机名。如果使用内部 CA，需要把 CA 安装到每台 Lore Client 和 Lore Server 机器的信任库。

### Lore Server 配置

在 Lore Server 覆盖 TOML 中加入：

```toml
[environment.endpoint]
auth_url = "https://auth.example.com:50051"

[server.auth]
jwt_issuer = "https://auth.example.com:8080"
jwt_audience = ["lore.example.com"]

[server.auth.jwk]
endpoint = "https://auth.example.com:8080/.well-known/jwks.json"
```

修改后重启 Lore Server。服务端会向客户端发布 `environment.endpoint.auth_url`，校验 JWT 的签发者和受众，并从 JWKS 获取签名公钥。

### Lore Client

服务端重启后，在远端仓库弹窗点击刷新。若没有有效且已绑定的账号，Lore Client 应自动打开浏览器认证页。完成登录后返回客户端，再在账号管理器中把该账号绑定到相应仓库。

此前服务端日志里的 `MissingToken` 表示客户端已经连接到 Lore Server，但还没有携带已保存且已绑定的授权 Token。在浏览器认证尚未完成、认证地址缺失或账号未绑定时，这是预期现象。

## Docker

仓库中的 compose 默认启动本地开发实例：

```bash
docker compose up -d --build
docker compose logs -f lore-auth
```

它会暴露 HTTP `8080` 与 gRPC `50051`，并持久化 `/app/keys` 和 `/app/data`。

生产环境需要只读挂载证书并覆盖公网配置：

```yaml
services:
  lore-auth:
    ports:
      - "8080:8080"
      - "50051:50051"
    environment:
      PUBLIC_BASE_URL: "https://auth.example.com:8080"
      JWT_ISSUER: "https://auth.example.com:8080"
      JWT_AUDIENCE: "lore.example.com"
      LORE_ENVIRONMENT: "production"
      TLS_CERT_FILE: "/app/certs/fullchain.pem"
      TLS_KEY_FILE: "/app/certs/privkey.pem"
      ADMIN_PASSWORD: "替换为足够长的随机密码"
    volumes:
      - ./certs:/app/certs:ro
```

也可以由反向代理终止 HTTPS 与 gRPC TLS，但公开的 gRPC 路由必须保留 HTTP/2 gRPC 语义，普通 HTTP/1 代理无法工作。

## 管理与仓库权限

管理后台位于 `/admin`。Access Token 与 Refresh Token 只保存在当前标签页的 `sessionStorage` 中，关闭标签页或退出登录后会被清除。

通过 Lore ReBAC 创建的新仓库会自动登记，创建者取得 `read`、`write` 和 `admin`。对启用认证前已经存在的仓库：

1. 找到 32 位十六进制 Lore Repository ID。
2. 在管理后台登记 `urc-<repository-id>`。
3. 为每个用户分配所需权限。

管理员隐式拥有所有已登记仓库的权限；普通用户只能看到并交换显式授权仓库的 Token。

## HTTP API

| 方法 | 路径 | 认证 | 作用 |
|---|---|---|---|
| `GET` | `/.well-known/jwks.json` | 无 | 供 Lore Server 使用的 RS256 公钥 |
| `GET` | `/health_check` | 无 | HTTP 服务健康检查 |
| `GET` | `/login` | 会话查询参数 | Lore 浏览器认证页 |
| `POST` | `/auth/session/approve` | 会话表单 | 批准 Lore 浏览器会话 |
| `POST` | `/auth/login` | 无 | REST 用户名密码登录 |
| `POST` | `/auth/refresh` | Refresh Token | 轮换 REST Refresh Token |
| `GET` | `/auth/me` | Bearer | 校验并查看 JWT |
| `GET` | `/admin` | 无 | 管理后台 |
| `GET/POST` | `/admin/users` | 管理员 Bearer | 列出或创建用户 |
| `DELETE` | `/admin/users/:username` | 管理员 Bearer | 删除用户 |
| `GET/POST` | `/admin/resources` | 管理员 Bearer | 列出或登记仓库 |
| `PUT` | `/admin/resources/:id/users/:username` | 管理员 Bearer | 覆盖仓库权限 |

## gRPC API

两个服务使用 `proto/` 中的定义：

- `ucs.auth.UrcAuthApi`：浏览器会话、Token 交换、权限查询和用户查询
- `ucs.auth.RebacApi`：Lore 仓库资源创建与删除

`RefreshAuthSession` 和 API Key 交换当前返回 `UNIMPLEMENTED`。本项目固定的 Lore 客户端不会在浏览器登录中发送 Refresh Token；AuthN Token 过期后需要重新认证。管理 API 使用的 REST Refresh Token 轮换不受影响。

## 配置参数

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `HOST` | `0.0.0.0` | HTTP 绑定地址 |
| `PORT` | `8080` | HTTP/HTTPS 端口 |
| `GRPC_HOST` | `0.0.0.0` | gRPC 绑定地址 |
| `GRPC_PORT` | `50051` | gRPC Auth/ReBAC 端口 |
| `PUBLIC_BASE_URL` | `JWT_ISSUER` | 浏览器可访问的登录 Origin |
| `JWT_ISSUER` | `http://localhost:8080` | JWT `iss` |
| `JWT_AUDIENCE` | `localhost` | 逗号分隔的 JWT 受众 |
| `LORE_ENVIRONMENT` | `local` | JWT `env` Claim |
| `TOKEN_TTL` | `43200` | JWT 有效期（秒） |
| `REFRESH_TOKEN_TTL` | `604800` | REST Refresh Token 有效期 |
| `AUTH_SESSION_TTL` | `300` | 浏览器会话有效期 |
| `AUTH_SESSION_MAX_ATTEMPTS` | `5` | 临时锁定前的失败次数 |
| `AUTH_SESSION_LOCK_SECONDS` | `60` | 临时锁定时长 |
| `KEY_DIR` | `./keys` | 持久化 RS256 密钥目录 |
| `DB_PATH` | `./lore-auth.db` | SQLite 数据库 |
| `ADMIN_USERNAME` | `admin` | 初始管理员 |
| `ADMIN_PASSWORD` | `changeme` | 初始管理员密码 |
| `TLS_CERT_FILE` | 未配置 | HTTP 与 gRPC 使用的 PEM 证书链 |
| `TLS_KEY_FILE` | 未配置 | HTTP 与 gRPC 使用的 PEM 私钥 |

## 验证

```bash
bun run typecheck
bun test
```

集成测试会启动真实 gRPC Server，并验证：

- 浏览器会话创建与批准
- AuthN JWT 及 Lore 必需 Claims
- 权限查询
- 仓库范围 AuthZ 交换
- 无效浏览器会话拒绝
- 会话哈希持久化与创建者权限

## 安全说明

- 密码使用带盐 scrypt；用户名不存在时也执行等价哈希计算。
- 浏览器会话秘密值与 Refresh Token 只保存 SHA-256 哈希。
- 浏览器会话短期有效，并同时绑定 `client_state` 与 `session_code`。
- 登录失败按浏览器会话进行次数限制和临时锁定。
- JWT 与密码不会写入应用日志、浏览器 URL 或浏览器登录 HTML。
- 浏览器页与管理页设置严格 CSP、防嵌入、禁止缓存和禁止 Referrer 响应头。
- 删除 `KEY_DIR` 会轮换签名密钥，并使全部已签发 JWT 失效。

## 开源协议

MIT。
