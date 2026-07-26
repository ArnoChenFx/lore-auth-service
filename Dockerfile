# ── Lore Auth Service Dockerfile ──
# Based on the official oven/bun image, using a multi-stage build to reduce the final image size.

# ── Stage 1: Install dependencies ──
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app

# Copy dependency manifests first to leverage Docker layer caching.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ── Stage 2: Runtime ──
FROM oven/bun:1.3-alpine AS runtime

# Install su-exec so the entrypoint can drop to the non-root user after fixing permissions.
RUN apk add --no-cache su-exec

# Run as a non-root user.
RUN addgroup --system --gid 1001 lore \
    && adduser --system --uid 1001 lore --home /app

WORKDIR /app

# Copy node_modules from the deps stage.
COPY --from=deps /app/node_modules ./node_modules

# Copy source code and project configuration.
COPY package.json bun.lock tsconfig.json ./
COPY src/ ./src/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Create data directories and set ownership.
# keys/   Stores RSA key pairs (persisted to a volume).
# data/   Stores the SQLite database (persisted to a volume).
# The entrypoint will re-apply ownership at runtime to handle named volumes.
RUN mkdir -p /app/keys /app/data \
    && chown -R lore:lore /app \
    && chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["docker-entrypoint.sh"]

# Health check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD bun -e "fetch('http://localhost:8080/health_check').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default environment variables (can be overridden by docker-compose or -e).
ENV PORT=8080 \
    KEY_DIR=/app/keys \
    DB_PATH=/app/data/lore-auth.db \
    JWT_ISSUER=http://localhost:8080 \
    JWT_AUDIENCE=lore-service \
    TOKEN_TTL=3600 \
    ADMIN_USERNAME=admin \
    ADMIN_PASSWORD=changeme

CMD ["bun", "run", "src/index.ts"]
