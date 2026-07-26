#!/bin/sh
# ── Docker entrypoint for Lore Auth Service ──
# Ensures the data/keys directories are writable by the non-root "lore" user
# before dropping privileges and starting the service.
set -e

# Make sure the runtime directories are owned by the lore user.
# Named volumes may be mounted with root ownership on first creation,
# so this fixes permissions before the application starts.
chown -R lore:lore /app/keys /app/data 2>/dev/null || true

# Run the actual command as the lore user.
exec su-exec lore "$@"
