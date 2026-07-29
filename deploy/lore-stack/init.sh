#!/bin/sh
# Prepare shared TLS material and matching integration settings for Lore Server and Lore Auth.
set -eu

output_dir=/output
input_dir=/input
external_host=${LORE_EXTERNAL_HOST:?LORE_EXTERNAL_HOST is required}
tls_mode=${LORE_TLS_MODE:-auto}
valid_days=${LORE_TLS_VALID_DAYS:-825}
auth_https_port=${LORE_AUTH_HTTPS_PORT:-8080}
auth_grpc_port=${LORE_AUTH_GRPC_PORT:-50051}

# Prevent host values from injecting OpenSSL or TOML syntax. Public URLs use host:port,
# so DNS names and IPv4 are supported; IPv6 literals require bracket normalization and are rejected.
case "$external_host" in
  *[!A-Za-z0-9._-]*|*:*|'')
    echo "LORE_EXTERNAL_HOST contains unsupported characters: $external_host" >&2
    exit 1
    ;;
esac

case "$valid_days" in
  *[!0-9]*|'0'|'')
    echo "LORE_TLS_VALID_DAYS must be a positive integer" >&2
    exit 1
    ;;
esac

mkdir -p "$output_dir/config"

if [ "$tls_mode" = "custom" ]; then
  cert_name=${LORE_TLS_CERT_FILE:-fullchain.pem}
  key_name=${LORE_TLS_KEY_FILE:-privkey.pem}
  ca_name=${LORE_TLS_CA_FILE:-ca.pem}
  for source_name in "$cert_name" "$key_name" "$ca_name"; do
    if [ ! -f "$input_dir/$source_name" ]; then
      echo "Custom certificate file does not exist: $input_dir/$source_name" >&2
      exit 1
    fi
  done
  cp "$input_dir/$cert_name" "$output_dir/fullchain.pem"
  cp "$input_dir/$key_name" "$output_dir/privkey.pem"
  cp "$input_dir/$ca_name" "$output_dir/ca.pem"
elif [ "$tls_mode" = "auto" ]; then
  # Reissue certificates when the host changes; otherwise reuse them to preserve client trust.
  if [ ! -s "$output_dir/ca.pem" ] || [ ! -s "$output_dir/privkey.pem" ] || \
     [ ! -s "$output_dir/fullchain.pem" ] || [ ! -f "$output_dir/.certificate-host" ] || \
     [ "$(cat "$output_dir/.certificate-host")" != "$external_host" ]; then
    rm -f "$output_dir/ca.pem" "$output_dir/ca-key.pem" \
      "$output_dir/fullchain.pem" "$output_dir/privkey.pem" "$output_dir/server.pem"

    openssl req -x509 -newkey rsa:3072 -sha256 -nodes \
      -keyout "$output_dir/ca-key.pem" -out "$output_dir/ca.pem" \
      -days "$valid_days" -subj "/CN=Lore Stack Local CA" \
      -addext "basicConstraints=critical,CA:TRUE" \
      -addext "keyUsage=critical,keyCertSign,cRLSign"

    # Encode IP addresses as IP SANs and hostnames as DNS SANs for modern TLS verification.
    case "$external_host" in
      *:*) external_san="IP.1 = $external_host" ;;
      *[!0-9.]*) external_san="DNS.1 = $external_host" ;;
      *) external_san="IP.1 = $external_host" ;;
    esac

    cat > "$output_dir/openssl-san.cnf" <<EOF
[req]
distinguished_name = dn
req_extensions = req_ext
prompt = no

[dn]
CN = $external_host

[req_ext]
subjectAltName = @alt_names
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
$external_san
DNS.2 = lore-auth
DNS.3 = lore-server
DNS.4 = localhost
IP.2 = 127.0.0.1
EOF

    openssl req -new -newkey rsa:3072 -sha256 -nodes \
      -keyout "$output_dir/privkey.pem" -out "$output_dir/server.csr" \
      -config "$output_dir/openssl-san.cnf"
    openssl x509 -req -sha256 -in "$output_dir/server.csr" \
      -CA "$output_dir/ca.pem" -CAkey "$output_dir/ca-key.pem" -CAcreateserial \
      -out "$output_dir/server.pem" -days "$valid_days" \
      -extensions req_ext -extfile "$output_dir/openssl-san.cnf"
    cat "$output_dir/server.pem" "$output_dir/ca.pem" > "$output_dir/fullchain.pem"
    printf '%s' "$external_host" > "$output_dir/.certificate-host"
    # Delete the CA private key immediately after signing to avoid retaining a high-value secret.
    rm -f "$output_dir/server.csr" "$output_dir/openssl-san.cnf" \
      "$output_dir/ca.srl" "$output_dir/ca-key.pem"
  fi
else
  echo "LORE_TLS_MODE must be either auto or custom" >&2
  exit 1
fi

# Verify the certificate and private key match before either service starts.
cert_pubkey=$(openssl x509 -in "$output_dir/fullchain.pem" -pubkey -noout | openssl sha256)
key_pubkey=$(openssl pkey -in "$output_dir/privkey.pem" -pubout | openssl sha256)
if [ "$cert_pubkey" != "$key_pubkey" ]; then
  echo "The certificate and private key do not match" >&2
  exit 1
fi

# Custom certificates must cover the public IP or DNS name used by clients.
case "$external_host" in
  *[!0-9.]*) openssl x509 -in "$output_dir/fullchain.pem" -noout -checkhost "$external_host" >/dev/null ;;
  *) openssl x509 -in "$output_dir/fullchain.pem" -noout -checkip "$external_host" >/dev/null ;;
esac

# Lore Server and health checks reach Auth through the configured public address, so custom
# certificates do not need Compose-internal service names. Only stack.toml is managed here;
# local.toml in the same directory remains entirely user-maintained.
cat > "$output_dir/config/stack.toml" <<EOF
[server.quic.certificate]
cert_file = "/run/lore-stack/fullchain.pem"
pkey_file = "/run/lore-stack/privkey.pem"

[server.grpc.certificate]
cert_file = "/run/lore-stack/fullchain.pem"
pkey_file = "/run/lore-stack/privkey.pem"

[environment.endpoint]
auth_url = "https://$external_host:$auth_grpc_port"

[server.auth]
jwt_issuer = "https://$external_host:$auth_https_port"
jwt_audience = ["$external_host"]

[server.auth.jwk]
endpoint = "https://$external_host:$auth_https_port/.well-known/jwks.json"

[immutable_store.local]
path = "/data"

[mutable_store.local]
path = "/data"
EOF

# Lore Auth drops to UID 1001 while Lore Server remains root; grant the key only to that UID.
chown 1001:1001 "$output_dir/privkey.pem"
chmod 600 "$output_dir/privkey.pem"
chmod 644 "$output_dir/ca.pem" "$output_dir/fullchain.pem"
chmod 644 "$output_dir/config/stack.toml"

echo "Lore Stack settings generated; external host: $external_host; TLS mode: $tls_mode"
