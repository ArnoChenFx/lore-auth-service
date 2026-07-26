# Lore Auth Service

A JWT authentication service built with TypeScript + Bun.js, providing JWT issuance and a JWKS endpoint for Epic Games' [Lore VCS](https://github.com/EpicGames/lore).

[中文文档](README-zh.md)

## How It Works

```
┌────────┐    1. login (user/pass)    ┌──────────────┐
│ Client │ ──────────────────────────► │  Lore Auth   │
│  (CLI) │ ◄────────────────────────── │  (this svc)  │
│        │    2. JWT (signed by RSA)   │  port :8080  │
└───┬────┘                             └──────┬───────┘
    │                                         │
    │ 3. push/clone (Bearer JWT)              │ 4. JWKS fetch (startup + on unknown kid)
    ▼                                         ▼
┌──────────────┐                      ┌──────────────┐
│  Lore Server │ ────────────────────►│  Lore Auth   │
│  port :41337 │   verify JWT via JWKS │  /.well-known/jwks.json
└──────────────┘                      └──────────────┘
```

1. The client logs in to Lore Auth with username/password and receives a JWT.
2. The client presents the JWT as a Bearer token when pushing to or cloning from the Lore Server.
3. On startup, the Lore Server fetches the public key from the Lore Auth JWKS endpoint and uses it to verify JWT signatures.
4. The Lore Server derives the partition (repository isolation boundary) from the authenticated session — a client cannot cross tenant boundaries by naming a different partition.

## Quick Start

### Prerequisites

- Bun >= 1.3 (https://bun.sh)

### Install Dependencies

```bash
cd lore-auth
bun install
```

### First Launch (auto-bootstrap admin)

```bash
# Option A: bootstrap command
bun run bootstrap

# Option B: first regular start detects empty DB and creates admin
bun run start
```

The default admin credentials are `admin / changeme`. Customize them via environment variables or a `.env` file:

```bash
cp .env.example .env
# Edit .env...
```

### Daily Start

```bash
bun run start
# Or development mode (hot reload)
bun run dev
```

### Verify

```bash
# 1. Health check
curl http://localhost:8080/health_check

# 2. JWKS endpoint (this is what Lore Server fetches)
curl http://localhost:8080/.well-known/jwks.json

# 3. Log in to get a token
curl -X POST http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"changeme"}'

# 4. Verify token
curl http://localhost:8080/auth/me \
  -H "Authorization: Bearer <token>"

# 5. Create a new user (requires admin token)
curl -X POST http://localhost:8080/admin/users \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"alice123","is_admin":false}'

# 6. List users
curl http://localhost:8080/admin/users \
  -H "Authorization: Bearer <admin-token>"

# 7. Delete a user
curl -X DELETE http://localhost:8080/admin/users/alice \
  -H "Authorization: Bearer <admin-token>"
```

### Issue a Test Token

```bash
# Prints a JWT to stdout — pipe it to other tools
bun run src/index.ts --token-for=admin
```

## Docker Deployment

### Using docker-compose (recommended)

```bash
# Build and start in background
docker-compose up -d

# View logs
docker-compose logs -f

# Stop and remove container
 docker-compose down
```

#### Use the prebuilt image from GitHub Container Registry

By default `docker-compose.yml` builds the image locally. You can switch to the image published by GitHub Actions instead — see the commented `image:` lines inside `docker-compose.yml`.

```yaml
services:
  lore-auth:
    # image: ghcr.io/arnochenfx/lore-auth-service:latest
    # image: ghcr.io/arnochenfx/lore-auth-service:v1.0.0
```

Images are built automatically when a `vX.X.X` tag is pushed to the `main` branch. Pull it directly:

```bash
docker pull ghcr.io/arnochenfx/lore-auth-service:latest
```

The compose file mounts two named volumes for persistence:

| Volume | Mount point | Contents |
|--------|------------|----------|
| `lore-auth-keys` | `/app/keys` | RSA key pair — deleting this forces key rotation |
| `lore-auth-data` | `/app/data` | SQLite database |

Customize environment variables in `docker-compose.yml` before first start. At minimum, change `ADMIN_PASSWORD`:

```yaml
environment:
  ADMIN_USERNAME: "admin"
  ADMIN_PASSWORD: "your-secure-password"
  JWT_ISSUER: "http://your-host:8080"  # must be reachable from Lore Server
```

### Using docker build + run

```bash
# Build the image
docker build -t lore-auth .

# Run with a named volume for keys and data
docker run -d \
  --name lore-auth \
  -p 8080:8080 \
  -e ADMIN_PASSWORD=your-secure-password \
  -e JWT_ISSUER=http://your-host:8080 \
  -v lore-auth-keys:/app/keys \
  -v lore-auth-data:/app/data \
  --restart unless-stopped \
  lore-auth
```

### Verify the container

```bash
# Health check
curl http://localhost:8080/health_check

# Log in
curl -X POST http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"your-secure-password"}'
```

### Key rotation in Docker

```bash
# Stop the container
docker-compose down

# Delete the keys volume (forces new key pair on next start)
docker volume rm lore-auth-keys

# Start again — new key pair is generated, all previously issued tokens become invalid
docker-compose up -d
```

### Connecting Lore Server to a Dockerized Lore Auth

Point the Lore Server's `jwt_issuer` and JWK endpoint at the host where the container is reachable. If Lore Server also runs in Docker, put both services on the same Docker network and use the container name as the hostname:

```toml
[server.auth]
jwt_issuer = "http://lore-auth:8080"
jwt_audience = ["lore-service"]

[server.auth.jwk]
endpoint = "http://lore-auth:8080/.well-known/jwks.json"
```

## Configure the Lore Server

Add the following to the Lore Server's `local.toml`:

```toml
[server.auth]
jwt_issuer = "http://localhost:8080"
jwt_audience = ["lore-service"]

[server.auth.jwk]
endpoint = "http://localhost:8080/.well-known/jwks.json"
```

Once the Lore Server starts, it fetches the JWKS public key from Lore Auth and verifies the JWT signature on every gRPC request. Requests without a valid JWT are rejected.

Equivalent environment-variable overrides:

```bash
LORE__SERVER__AUTH__JWT_ISSUER=http://localhost:8080
LORE__SERVER__AUTH__JWK__ENDPOINT=http://localhost:8080/.well-known/jwks.json
# jwt_audience is an array — it can only be set in a TOML file, not via env vars
```

## API Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/.well-known/jwks.json` | none | JWKS endpoint for Lore Server signature verification |
| GET | `/health_check` | none | Health check |
| POST | `/auth/login` | none | Username/password login, returns JWT |
| GET | `/auth/me` | Bearer | Verify current token, return user info |
| POST | `/admin/users` | Bearer (admin) | Create a user |
| GET | `/admin/users` | Bearer (admin) | List all users |
| DELETE | `/admin/users/:username` | Bearer (admin) | Delete a user |

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PORT` | `8080` | HTTP listen port |
| `JWT_ISSUER` | `http://localhost:8080` | JWT issuer — must match the Lore Server's `jwt_issuer` |
| `JWT_AUDIENCE` | `lore-service` | JWT audience — must be included in the Lore Server's `jwt_audience` list |
| `TOKEN_TTL` | `3600` | Token lifetime in seconds |
| `KEY_DIR` | `./keys` | RSA key pair storage directory |
| `DB_PATH` | `./lore-auth.db` | SQLite database path |
| `ADMIN_USERNAME` | `admin` | Admin username created on first launch |
| `ADMIN_PASSWORD` | `changeme` | Admin password created on first launch |

## Project Structure

```
lore-auth/
├── package.json
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .env.example
├── src/
│   ├── config.ts    # Environment variable configuration
│   ├── keys.ts      # RSA key pair management + JWKS generation
│   ├── db.ts        # bun:sqlite user storage + scrypt password hashing
│   ├── jwt.ts       # JWT signing/verification (jose)
│   └── index.ts     # Bun.serve HTTP service + routing
└── keys/            # Auto-generated RSA key pair (gitignored)
    ├── private.pem
    ├── public.pem
    └── kid.txt
```

## Security Notes

- Passwords are hashed with scrypt + salt — no plaintext stored
- RSA 2048 key pair is auto-generated on first launch and persisted to `KEY_DIR`
- `kid` uses the RFC 7638 JWK thumbprint — stable and reproducible
- Token TTL is configurable, default 1 hour
- Key rotation: stop the service, delete `KEY_DIR`, restart — a new key pair is generated and all previously issued tokens become invalid

## Current Limitations

The open-source Lore CLI (pre-1.0) does not yet support OAuth/token injection — this is on the roadmap. The value of this auth service today:

1. **Lore Server gRPC API authentication** is already functional — when calling through the SDKs (lore-js / lore-python / lore-csharp / lore-go), JWTs can be injected as gRPC metadata.
2. When Lore CLI OAuth client support lands, this service is ready to go — no modifications needed.
3. Can be deployed as a reverse proxy layer in front of the Lore Server for unified authentication.

## License

MIT — same as Lore itself.
