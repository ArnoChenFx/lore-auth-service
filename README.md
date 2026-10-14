# Lore Auth Service

Lore Auth Service is a TypeScript/Bun implementation of <a href="https://github.com/EpicGames/lore">Epic Games Lore</a>'s native browser authentication and repository authorization protocols. It exposes the `ucs.auth.UrcAuthApi` and `ucs.auth.RebacApi` gRPC services, issues Lore-compatible RS256 JWTs, publishes JWKS, and provides a small browser administration panel.

[中文文档](README-zh.md)

## What is implemented

- Native Lore browser login: start session, open login page, poll, and receive an AuthN token
- AuthN and repository-scoped AuthZ JWTs with all claims required by Lore
- Repository discovery through `LookupUserPermissions`
- Resource creation/deletion through Lore ReBAC
- Per-user `read`, `write`, `admin`, `obliterate`, and `migrate` repository permissions
- Username/password users with scrypt password hashing
- JWKS verification for Lore Server
- REST access/refresh tokens for the administration panel and API clients
- SQLite persistence for users, hashed refresh tokens, hashed browser sessions, resources, and permissions

## Authentication flow

```mermaid
sequenceDiagram
    participant C as Lore Client
    participant A as Lore Auth gRPC :50051
    participant B as System Browser
    participant H as Lore Auth HTTPS :8080
    participant S as Lore Server

    C->>A: StartAuthSession(client_state)
    A-->>C: session_code + login_url
    C->>B: Open login_url
    B->>H: Submit username and password
    H-->>B: Session approved
    loop every 5 seconds
      C->>A: GetAuthSession(client_state, session_code)
    end
    A-->>C: AuthN JWT
    C->>A: Lookup permissions / exchange resources
    A-->>C: repository-scoped AuthZ JWT
    C->>S: Lore request with Bearer AuthZ JWT
    S->>H: Fetch JWKS when required
```

The username and password are submitted only to the auth service's browser page. They do not enter Lore Client, and JWTs are never placed in browser URLs or page content.

## Quick start for local development

Prerequisite: Bun 1.4 or newer.

```bash
bun install
cp .env.example .env
bun run start
```

On the first start, an empty database receives the configured administrator. `ADMIN_PASSWORD` has no default: replace the placeholder in `.env` with your own password of at least 8 characters, or the service refuses to start. For a throwaway local instance only, set `ALLOW_INSECURE_DEFAULT_ADMIN_PASSWORD=true` and remove `ADMIN_PASSWORD` from `.env` to create the old development account `admin / changeme`.

On later starts, an administrator that still uses `changeme` or the example placeholder is switched to the current `ADMIN_PASSWORD`, and that user's refresh tokens are revoked. Any other password is never overwritten by startup.

Useful endpoints:

```bash
curl http://localhost:8080/health_check
curl http://localhost:8080/.well-known/jwks.json
```

Open `http://localhost:8080/admin` to manage users, register repositories created before authentication was enabled, and assign repository access.

The default gRPC endpoint is insecure and intended only for automated tests and local API development. The current Lore client converts its auth endpoint to HTTPS, so a real desktop login requires the production TLS setup below.

## Cross-platform executables

The project uses Bun Compile to produce standalone executables that do not require Bun,
Node.js, or `node_modules` on the target machine. Both gRPC Proto files are embedded in
the executable through Bun embedded files, so the `proto/` directory does not need to be
copied during deployment.

Compile for the current platform:

```bash
bun run build:compile
bun run test:compiled dist/windows-x64/lore-auth.exe
dist/windows-x64/lore-auth.exe -v
```

Cross-compile every supported target:

```bash
bun run build:compile:all
```

Compile one explicit target:

```bash
bun run build:compile --target=linux-x64
```

## Repository ID command-line tool

The `.lore/id` or `.urc/id` file under a repository root contains a 16-byte
binary ID. The following command detects the repository format automatically
and prints the `urc-<32-lowercase-hex>` resource ID used by the auth service:

```bash
bun run repository:id /path/to/repository
```

When no repository directory is provided, the tool checks the current working
directory. You can also specify the ID file explicitly:

```bash
bun run repository:id --id-file /path/to/repository/.lore/id
bun run repository:id --help
```

If both ID files exist, the tool requires `--id-file` to select one explicitly.
All command output and error messages are in English. Errors return exit code
`1`.

## Production setup

Use a DNS name such as `auth.example.com` and a certificate trusted by the machines running Lore Client and Lore Server. The same certificate can be used by this service on its HTTP and gRPC ports.

Example environment:

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
ADMIN_PASSWORD=replace-with-a-long-random-password
```

Important:

- `PUBLIC_BASE_URL` is the browser-visible HTTPS origin used in `login_url`.
- The Lore auth endpoint is `https://auth.example.com:50051`.
- `JWT_ISSUER` must exactly match Lore Server's `server.auth.jwt_issuer`.
- `JWT_AUDIENCE` is a comma-separated list and must contain the actual hostname used by the Lore Server remote URL, for example `lore.example.com`. Do not use an abstract value such as `lore-service`.
- The certificate must cover the auth endpoint hostname. For an internal CA, install that CA in the trust store of every Lore Client and Lore Server machine.
- **If a reverse proxy sits in front of this service, set `TRUSTED_PROXY_COUNT`** to the number of proxies. The default `0` makes every client look like the proxy, so one client's failed logins can lock a username for everyone behind it. See [Login throttling](#login-throttling).

### Lore Server configuration

Add these values to the Lore Server override TOML:

```toml
[environment.endpoint]
auth_url = "https://auth.example.com:50051"

[server.auth]
jwt_issuer = "https://auth.example.com:8080"
jwt_audience = ["lore.example.com"]

[server.auth.jwk]
endpoint = "https://auth.example.com:8080/.well-known/jwks.json"
```

Restart Lore Server after changing authentication settings. The server advertises `environment.endpoint.auth_url` to Lore clients, verifies JWT issuer/audience, and fetches signing keys from JWKS.

### Lore Client

Refresh the remote repository dialog after the server restarts. When no valid account is bound, Lore Client should launch the browser login automatically. Sign in on the Lore Auth page, return to the client, then bind the resulting account to the relevant repositories in the client's account manager.

The previous `MissingToken` server log means the client reached Lore Server without a stored/bound authorization token. It is expected before the browser flow completes or when the auth URL/account binding is missing.

## Migrating an unauthenticated Lore Server

Existing repository data does not need to be rebuilt or uploaded again. Before JWT authentication is enabled, however, every existing repository must be registered as an auth resource and ordinary users must receive explicit permissions. The migration has an important bootstrap dependency:

> After Lore Server is configured with `auth_url`, `lore repository list` also calls the auth service's `LookupUserPermissions` first. It can therefore return only resources that are already registered and visible to the current user. Running the command on the server does not bypass authentication and cannot discover an unregistered legacy repository.

### Preparation

- Back up the Lore Server configuration and storage, plus Lore Auth Service's `DB_PATH` and `KEY_DIR`.
- Use a `lore` CLI build that matches the Lore Server protocol version.
- Schedule a short maintenance window. Never run two Lore Server processes against the same storage.
- While authentication is temporarily disabled for discovery, bind only to loopback or restrict access to the local machine with a firewall. Never expose unauthenticated ports `41337` or `41339` to a LAN or the Internet.
- Record the repository names, Repository IDs, users, and intended permissions before the change so that they can be checked after migration.

### Step 1: Inventory legacy Repository IDs

A Repository ID is the 32-lowercase-hex representation of a 16-byte identifier. The administration panel uses the same value with an additional `urc-` prefix.

If any local working copy exists, use the
[Repository ID command-line tool](#repository-id-command-line-tool). It detects
the current `.lore/id` or legacy `.urc/id` format automatically, verifies that
the binary ID is exactly 16 bytes, and prints the resource ID with its `urc-`
prefix:

```bash
bun run repository:id /path/to/repository
```

There is no need to select the ID file manually, read it as text, or hash it
again. For a non-standard directory layout, use
`bun run repository:id --id-file <path>` to select the ID file explicitly.

To use the Lore Server's authoritative storage inventory before authentication has been enabled, run this on the server or from a matching CLI with network access:

```bash
lore repository list lore://127.0.0.1:41337
```

The output format is:

```text
repository-name (0194b726b34e72b0b45550b88a967076)
```

If Lore Server already has authentication configured, enumerate the complete inventory in this order:

1. Stop the production Lore Server.
2. Back up the configuration and temporarily remove or comment out `auth_url` under `[environment.endpoint]`.
3. Keep the original storage configuration and start exactly one Lore Server instance bound only to loopback.
4. Run `lore repository list lore://127.0.0.1:41337` and save the complete output.
5. Stop the temporary instance. Do not start any other instance before restoring the production authentication configuration.

If the server container does not include the `lore` CLI, use a matching CLI on the host to access the temporary loopback endpoint, or mount the CLI binary read-only into the container. Do not edit the Lore storage database directly.

### Step 2: Register resources and assign permissions

1. Start Lore Auth Service and confirm that `DB_PATH` and `KEY_DIR` use persistent storage.
2. Check the HTTP health endpoint and JWKS:

   ```bash
   curl --fail --show-error https://auth.example.com:8080/health_check
   curl --fail --show-error https://auth.example.com:8080/.well-known/jwks.json
   ```

3. Sign in to `https://auth.example.com:8080/admin`.
4. Register `urc-<32-hex-character Repository ID>` for each legacy repository. The repository name is display-only and does not participate in Lore addressing.
5. Assign each ordinary user the required permissions:
   - `read`: browse, clone, and read repository content.
   - `write`: push and other repository writes; normally grant it together with `read`.
   - `admin`: repository-level administration; grant it only to users who manage the resource.
   - `obliterate`: required by `lore file obliterate`; without it the server answers permission denied.
   - `migrate`: required by Lore `LockService.AdminLock` to apply admin locks; no CLI entry point today, but internal management tooling uses it.

Auth service administrators implicitly receive all five permissions for every **registered** resource, but they still cannot access an unregistered resource. Validate the migration with at least one ordinary user so that administrator privileges do not hide missing assignments.

### Step 3: Enable JWT verification

Confirm the auth service's public values:

```dotenv
PUBLIC_BASE_URL=https://auth.example.com:8080
JWT_ISSUER=https://auth.example.com:8080
JWT_AUDIENCE=lore.example.com
LORE_ENVIRONMENT=production
```

Then restore or add the Lore Server configuration:

```toml
[environment.endpoint]
auth_url = "https://auth.example.com:50051"

[server.auth]
jwt_issuer = "https://auth.example.com:8080"
jwt_audience = ["lore.example.com"]

[server.auth.jwk]
endpoint = "https://auth.example.com:8080/.well-known/jwks.json"
```

The following invariants must hold:

- `JWT_ISSUER` and `jwt_issuer` must match byte-for-byte, including scheme, hostname, and port.
- `JWT_AUDIENCE` must contain the hostname actually used in the Lore Server URL. If clients connect by IP address, include that IP address.
- Lore Server must be able to reach Auth gRPC on `50051` and JWKS HTTPS on `8080`.
- The gRPC TLS certificate must cover the `auth_url` hostname, and a reverse proxy must preserve HTTP/2 gRPC semantics.
- `KEY_DIR` must remain stable across restarts and deployments. Removing it rotates the signing key and invalidates issued JWTs.

### Step 4: Sign in again and validate

1. Restart Lore Server.
2. Complete a fresh browser login from Lore Client or the CLI:

   ```bash
   lore auth login lores://lore.example.com:41337
   ```

3. List repositories as an ordinary user:

   ```bash
   lore repository list lores://lore.example.com:41337
   ```

4. Confirm that the output contains only repositories granted to that user, with the expected names and Repository IDs.
5. Refresh the server directory in Lore Client, apply the signed-in account to the target repositories, then verify clone, read, and any required push operations.
6. Inspect Lore Server logs and confirm that persistent `MissingToken`, `authorization header required`, or `Failed to connect to lore auth service` errors no longer appear after login.

Common migration failures:

| Symptom | Check first |
|---|---|
| Login succeeds but the repository list is empty | The resource is registered as `urc-<32-hex-ID>` and the ordinary user has at least `read` |
| `Failed to connect to lore auth service` | DNS, IPv4/IPv6, TLS, SNI, and HTTP/2 from Lore Server to Auth gRPC `50051` |
| `MissingToken` / `authorization header required` | Browser login completed and the account is applied to the current server or repository |
| JWT issuer validation fails | `JWT_ISSUER` exactly matches `server.auth.jwt_issuer` |
| JWT audience validation fails | `JWT_AUDIENCE` contains the hostname or IP actually used by the Lore URL |
| JWKS fetch fails or `kid` is unknown | Lore Server can access `/.well-known/jwks.json` and `KEY_DIR` was not replaced |
| Lore Server exits with `EndpointUnresolvable` | Whether `[server.auth.jwk].endpoint` was removed. Since Lore 0.10.0 a missing endpoint triggers OIDC discovery (`<iss>/.well-known/openid-configuration`), which this service does not serve |
| Lore Server exits with `auth_url ... but [server.auth] is not` | `auth_url` must be set together with `[server.auth]`. Since Lore 0.10.0 this pairing refuses to start, so a rollback must comment out `auth_url` as well |

See [docs/note/lore-0.10.0-impact.md](docs/note/lore-0.10.0-impact.md) for the full assessment of the Lore 0.10.0 authorization changes.

To roll back, stop Lore Server, restore the previous unauthenticated configuration, and start it again. Resources and permissions added to the auth service do not modify Lore repository data and may remain in place for the next migration attempt.

## Docker

The checked-in compose file starts a local development instance. Set `ADMIN_PASSWORD` first, either in the shell or in a `.env` file copied from `.env.example`; Compose stops with an error when it is missing.

```bash
docker compose up -d --build
docker compose logs -f lore-auth
```

It exposes HTTP on `8080` and gRPC on `50051`, and persists `/app/keys` and `/app/data`.

### One-command Lore Server + Lore Auth stack

`docker-compose.lore-stack.yml` starts Lore Server, Lore Auth, and a one-shot configuration initializer. A single `LORE_EXTERNAL_HOST` value drives certificate SANs, the browser URL, JWT issuer/audience, Auth gRPC URL, and the Lore Server JWKS configuration. This supports LAN deployments addressed by an IP such as `192.168.1.2`.

```bash
cp .env.lore-stack.example .env.lore-stack
# Edit LORE_EXTERNAL_HOST, ADMIN_PASSWORD, and other values.
docker compose --env-file .env.lore-stack -f docker-compose.lore-stack.yml up -d --build
```

The default `LORE_TLS_MODE=auto` creates a persistent local CA and a certificate covering the external host plus the internal Compose service names. Lore Server trusts that CA automatically. The default Lore Server image is `ghcr.io/arnochenfx/lore-server:latest`, built manually by this repository's GitHub Actions workflow from Epic Games' official source. The workflow also publishes `nightly` (daily build of upstream `main`), `stable` (latest stable release), synced version tags such as `v0.8.6` / `0.8.6` / `0.8` / `0`, and immutable `sha-<short>` tags. Each Lore Client machine must still import the exported `ca.pem` into its operating-system trust store; Compose intentionally does not perform this privileged host operation. See [README-zh.md](README-zh.md) for addresses, CA export steps, custom certificate mode, and operational notes.

The initializer only creates or replaces `stack.toml` in `LORE_SERVER_CONFIG_DIR`; it never reads, copies, modifies, migrates, or deletes `local.toml`. Place an optional user-maintained `local.toml` in that directory to add telemetry or other Lore Server overrides. Lore loads it after `stack.toml`. Avoid overriding the generated authentication, JWT, JWKS, storage, and certificate tables.

For production, mount certificates read-only and override the public values:

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
      ADMIN_PASSWORD: "replace-with-a-long-random-password"
    volumes:
      - ./certs:/app/certs:ro
```

Alternatively, terminate HTTPS and gRPC TLS at a reverse proxy. The public gRPC route must preserve HTTP/2 gRPC semantics; a normal HTTP/1 proxy is not sufficient.

## Administration

![Admin Panel](docs/assets/admin-panel.png)

The administration panel is available at `/admin`. The administrator sign-in card is centered on the page, and a compact administration layout is restored after sign-in. The repository, user, permission controls, and save button share one configuration row on desktop screens. The administration and browser authentication pages display English by default and provide a language switch at the top of the page; the selected language is saved in `localStorage`. The administration page also supports light and dark themes, uses neutral dark-gray backgrounds in dark mode, and follows the system theme on the first visit. Access and refresh tokens live only in the current tab's `sessionStorage` and are removed when the tab closes or the operator signs out.

New repositories created through Lore ReBAC are registered automatically and their creator receives `read`, `write`, `admin`, `obliterate`, and `migrate`. For repositories that existed before auth was enabled:

1. Find the 32-hex-character Lore Repository ID.
2. Register `urc-<repository-id>` in the administration panel.
3. Assign the required permissions to each user.

See “Migrating an unauthenticated Lore Server” for the complete downtime inventory, JWT configuration, permission migration, and validation procedure.

Administrators have implicit access to all registered repositories. Ordinary users only see and exchange tokens for explicitly assigned repositories.

## HTTP API

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| `GET` | `/.well-known/jwks.json` | none | RS256 public keys for Lore Server |
| `GET` | `/health_check` | none | HTTP service health |
| `GET` | `/login` | session query | Lore browser session page |
| `POST` | `/auth/session/approve` | session form | Approve a Lore browser session |
| `POST` | `/auth/login` | none | REST username/password login |
| `POST` | `/auth/refresh` | refresh token | Rotate a REST refresh token |
| `GET` | `/auth/me` | Bearer | Validate and inspect a JWT |
| `GET` | `/admin` | none | Administration panel |
| `GET/POST` | `/admin/users` | admin Bearer | List/create users |
| `DELETE` | `/admin/users/:username` | admin Bearer | Delete a user |
| `GET/POST` | `/admin/resources` | admin Bearer | List/register repositories |
| `PUT` | `/admin/resources/:id/users/:username` | admin Bearer | Replace repository permissions |

## gRPC API

Both services use the definitions in `proto/`:

- `ucs.auth.UrcAuthApi`: browser sessions, token exchange, permission lookup, and user lookup
- `ucs.auth.RebacApi`: Lore repository resource creation and deletion

`RefreshAuthSession` and API-key exchange return `UNIMPLEMENTED`. The fixed Lore client used by this project does not send refresh tokens during browser login; users authenticate again after the AuthN token expires. REST refresh-token rotation remains supported for the administration API.

## Configuration

| Variable | Default | Description |
|---|---:|---|
| `HOST` | `0.0.0.0` | HTTP bind address |
| `PORT` | `8080` | HTTP/HTTPS port |
| `GRPC_HOST` | `0.0.0.0` | gRPC bind address |
| `GRPC_PORT` | `50051` | gRPC Auth/ReBAC port |
| `PUBLIC_BASE_URL` | `JWT_ISSUER` | Browser-visible login origin |
| `JWT_ISSUER` | `http://localhost:8080` | JWT `iss` |
| `JWT_AUDIENCE` | `localhost` | Comma-separated JWT audiences |
| `LORE_ENVIRONMENT` | `local` | JWT `env` claim |
| `TOKEN_TTL` | `864000` | JWT lifetime in seconds, 10 days by default; see [Token lifetime](#token-lifetime) |
| `REFRESH_TOKEN_TTL` | `604800` | REST refresh-token lifetime |
| `AUTH_SESSION_TTL` | `300` | Browser session lifetime |
| `AUTH_SESSION_MAX_ATTEMPTS` | `5` | Failed approvals in one browser session before that session locks |
| `AUTH_SESSION_LOCK_SECONDS` | `60` | Lock duration for one browser session |
| `LOGIN_MAX_FAILURES_PER_USER_IP` | `5` | Failed password checks for one username from one address before a lock; `0` disables |
| `LOGIN_MAX_FAILURES_PER_IP` | `100` | Failed password checks from one address across usernames before a lock; `0` disables |
| `LOGIN_MAX_FAILING_IPS_PER_ACCOUNT` | `50` | Distinct addresses that failed against one account within 15 minutes before it locks for everyone; `0` disables, `1` is refused |
| `LOGIN_LOCK_BASE_SECONDS` | `60` | First login lock; doubles with each further failure |
| `LOGIN_LOCK_MAX_SECONDS` | `900` | Upper bound for a login lock |
| `LOGIN_RECENT_SUCCESS_SECONDS` | `2592000` | Sources with a successful login to an account within this many seconds are not blocked by that account's lock; `0` disables this exemption |
| `TRUSTED_PROXY_COUNT` | `0` | Number of trusted reverse proxies in front of the service. **Set it when a proxy is in front**, or every client shares the proxy's throttling counters; see [Login throttling](#login-throttling) |
| `KEY_DIR` | `./keys` | persisted RS256 key directory |
| `DB_PATH` | `./lore-auth.db` | SQLite database |
| `ADMIN_USERNAME` | `admin` | bootstrap administrator |
| `ADMIN_PASSWORD` | required | bootstrap password, at least 8 characters; startup is refused for `changeme` and the example placeholder |
| `ALLOW_INSECURE_DEFAULT_ADMIN_PASSWORD` | `false` | local development only: permits the built-in `changeme` password |
| `TLS_CERT_FILE` | unset | PEM certificate chain for HTTP and gRPC |
| `TLS_KEY_FILE` | unset | PEM private key for HTTP and gRPC |

### Token lifetime

`TOKEN_TTL` defaults to `864000` seconds (10 days), so a signed-in Lore Client keeps working without a daily browser login. The fixed Lore client does not refresh browser sessions (`RefreshAuthSession` returns `UNIMPLEMENTED`), so an expired token always requires signing in again.

Revoking an account reaches different components at different times:

- Deleting a user takes effect immediately in this service. Its access tokens are rejected by `/auth/me`, the administration API, and the gRPC calls that check the token against the user table, such as permission lookups and token exchange. Its refresh tokens stop working. There is no disabled state, so deleting the user is the only way to revoke an account's access.
- Lore Server checks the signature and expiry of every token offline, with the keys from `/.well-known/jwks.json`. For identity tokens it then asks this service whether the user still exists and has access, so a deleted user's identity token is refused at once. Repository-scoped tokens carry their grants in a `resources` claim that Lore Server evaluates without calling this service, so a repository-scoped token issued before the deletion keeps working until it expires at `TOKEN_TTL`.
- Rotating or deleting `KEY_DIR` invalidates every token at once, because the signing key changes.

A shorter lifetime limits how long a removed or stolen token stays usable, at the cost of more frequent browser sign-ins. For sensitive deployments, set `TOKEN_TTL` to `28800` (eight hours) or less. Keep the default only when long sessions are acceptable.

### Login throttling

Password checks made through `/auth/login` and browser approval are counted in three scopes:

| Scope | Setting | Default | Effect when exceeded |
|---|---|---:|---|
| Username and address | `LOGIN_MAX_FAILURES_PER_USER_IP` | `5` | Locks that username for that address. The lock doubles with each further failure, from `LOGIN_LOCK_BASE_SECONDS` up to `LOGIN_LOCK_MAX_SECONDS`. |
| Address | `LOGIN_MAX_FAILURES_PER_IP` | `100` | Locks all logins from that address across usernames. An IPv6 address counts as its /64 prefix. Successful logins do not reset this count. |
| Account | `LOGIN_MAX_FAILING_IPS_PER_ACCOUNT` | `50` | Locks the account for every address while that many different addresses have failed against it within 15 minutes. Sources with a recent successful login for the account are exempt (see below). |

A rejected attempt returns `429 Too Many Requests` with a `Retry-After` header. It is not checked against the password and is not counted as a failure, so continued guessing cannot extend the lock. A limit of `0` disables its scope. Each address counts once per account, and an IPv6 address counts as its /64 prefix, so one address (or one /64) cannot lock another user's account by itself. Failures from enough distinct addresses can still lock an account for everyone, until those failures are 15 minutes old. For this reason `LOGIN_MAX_FAILING_IPS_PER_ACCOUNT=1` is refused at startup.

A counter restarts after one hour without a failure, or after `LOGIN_LOCK_MAX_SECONDS` if that is longer. Counters are stored in the `login_throttles` table of `DB_PATH`.

**Recently signed-in sources are not blocked by the account lock.** A source (an IPv4 address or an IPv6 /64 prefix) that logged in to an account successfully within `LOGIN_RECENT_SUCCESS_SECONDS` (30 days by default) can keep signing in while that account is locked for everyone. This keeps a user's usual device working during a distributed attack on the account. The exemption covers only the account-wide lock: the source's own username and address counters still apply, so it does not add guesses. It requires the correct password to have been accepted from that source, and it is removed when the user is deleted or the password is changed. The table `login_successes` stores a hash of each source, not the address. Sources that signed in before this version are not exempt until they sign in again. An attacker who can reach 50 distinct IPv4 addresses or /64 prefixes, and who has no recently successful source, still locks the account for 15 minutes at a time. Raise `LOGIN_MAX_FAILING_IPS_PER_ACCOUNT` to make that harder, or set `LOGIN_RECENT_SUCCESS_SECONDS=0` to remove the exemption.

> **Behind a reverse proxy, set `TRUSTED_PROXY_COUNT`** to the number of proxies in front of this service. Left at `0`, every client appears to come from the proxy's address, so one client's failed logins can lock a username for everyone who uses that proxy. While `TRUSTED_PROXY_COUNT=0`, the service logs a `[proxy]` warning on the first request from a private, loopback, or other non-public address. Startup cannot make this check, because the client address is known only for each request.
>
> With the value set, the service reads the address that the nearest trusted proxy appended to `X-Forwarded-For`. Those proxies must overwrite or append that header on every request, and the service must be reachable only through them, because a client that connects directly can set the header itself. A value higher than the real number of proxies also lets clients forge their address.

**Address-based limits are not identity.** IPv6 addresses are counted by their /64 prefix, so a client cannot escape a limit by changing addresses inside its /64. Many users can still share one NAT address or /64 prefix. Clients that share an address are throttled together, so one client can lock a username for the others behind that address. For shared egress addresses, raise `LOGIN_MAX_FAILURES_PER_USER_IP` and `LOGIN_MAX_FAILURES_PER_IP` rather than disabling those scopes. If the service sees one address for every client, the address scopes apply to all of them at once. Before exposing the service to users, make it see real client addresses through a reverse proxy that forwards them, with `TRUSTED_PROXY_COUNT` set.

### Upgrading from earlier versions

- Set `ADMIN_PASSWORD` before starting this version. The service refuses to start unless it is set to a password of at least 8 characters, and it refuses the publicly documented values `changeme` and the example placeholder unless `ALLOW_INSECURE_DEFAULT_ADMIN_PASSWORD=true`.
- If the stored administrator still uses `changeme` or the placeholder, the first start replaces that password with `ADMIN_PASSWORD` and revokes the administrator's refresh tokens. Startup never changes any other password.
- The `login_throttles` and `login_successes` tables are created automatically. No manual migration is needed. Sources that signed in before this version are exempt from an account lock only after they sign in again.
- Set `TRUSTED_PROXY_COUNT` if the service sits behind a reverse proxy.

## Verification

```bash
bun run typecheck
bun test
```

The integration suite starts a real gRPC server and verifies:

- browser session creation and approval
- AuthN JWT issuance and required Lore claims
- permission lookup
- repository-scoped AuthZ exchange
- invalid browser-session rejection
- hashed session persistence and creator permissions

## Security

- Passwords use salted scrypt hashes; unknown users perform an equivalent hash operation.
- Browser session secrets and refresh tokens are stored only as SHA-256 hashes.
- Browser session URLs are short-lived and bound to both `client_state` and `session_code`.
- Password checks are throttled per username and address, per address, and per account, across browser sessions and the JSON login endpoint (see [Login throttling](#login-throttling)).
- Request bodies are limited to 64 KiB for JSON and 16 KiB for browser forms. Limits count the bytes actually received, so chunked bodies are capped too, and larger bodies receive `413`.
- JWTs and passwords are not written to application logs, browser URLs, or browser login HTML.
- Browser and administration pages set restrictive CSP, anti-framing, no-cache, and no-referrer headers.
- Removing `KEY_DIR` rotates the signing key and invalidates all issued JWTs.
- A deleted user's identity token is refused by this service and by Lore Server at once. A repository-scoped token issued before the deletion stays valid on Lore Server until `TOKEN_TTL` expires (see [Token lifetime](#token-lifetime)).

## License

MIT.
