#!/bin/sh
# 为 Lore Server 与 Lore Auth 准备同一套 TLS 材料，并生成两端严格匹配的配置。
set -eu

output_dir=/output
input_dir=/input
external_host=${LORE_EXTERNAL_HOST:?必须设置 LORE_EXTERNAL_HOST}
tls_mode=${LORE_TLS_MODE:-auto}
valid_days=${LORE_TLS_VALID_DAYS:-825}
auth_https_port=${LORE_AUTH_HTTPS_PORT:-8080}
auth_grpc_port=${LORE_AUTH_GRPC_PORT:-50051}

# 防止主机名被插入 OpenSSL 配置或 TOML。当前公开 URL 采用 host:port 形式，
# 因此明确支持 DNS 与 IPv4；IPv6 字面量需要额外的方括号规范化，暂不接受。
case "$external_host" in
  *[!A-Za-z0-9._-]*|*:*|'')
    echo "LORE_EXTERNAL_HOST 含有不支持的字符: $external_host" >&2
    exit 1
    ;;
esac

case "$valid_days" in
  *[!0-9]*|'0'|'')
    echo "LORE_TLS_VALID_DAYS 必须是正整数" >&2
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
      echo "自定义证书文件不存在: $input_dir/$source_name" >&2
      exit 1
    fi
  done
  cp "$input_dir/$cert_name" "$output_dir/fullchain.pem"
  cp "$input_dir/$key_name" "$output_dir/privkey.pem"
  cp "$input_dir/$ca_name" "$output_dir/ca.pem"
elif [ "$tls_mode" = "auto" ]; then
  # 主机变化时重新签发；主机不变则复用证书，避免重启后客户端突然失去信任。
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

    # IP 地址必须写入 IP SAN，DNS 名称则写入 DNS SAN，否则现代 TLS 客户端会拒绝证书。
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
    # CA 私钥在完成签发后立即删除，减少共享运行卷中长期保存的高权限秘密。
    rm -f "$output_dir/server.csr" "$output_dir/openssl-san.cnf" \
      "$output_dir/ca.srl" "$output_dir/ca-key.pem"
  fi
else
  echo "LORE_TLS_MODE 只能是 auto 或 custom" >&2
  exit 1
fi

# 确认证书与私钥匹配，尽早阻止错误的自定义证书进入两个服务。
cert_pubkey=$(openssl x509 -in "$output_dir/fullchain.pem" -pubkey -noout | openssl sha256)
key_pubkey=$(openssl pkey -in "$output_dir/privkey.pem" -pubout | openssl sha256)
if [ "$cert_pubkey" != "$key_pubkey" ]; then
  echo "证书与私钥不匹配" >&2
  exit 1
fi

# 自定义证书也必须覆盖对外 IP/DNS；否则 Compose 虽能启动，客户端 TLS 一定会失败。
case "$external_host" in
  *[!0-9.]*) openssl x509 -in "$output_dir/fullchain.pem" -noout -checkhost "$external_host" >/dev/null ;;
  *) openssl x509 -in "$output_dir/fullchain.pem" -noout -checkip "$external_host" >/dev/null ;;
esac

# Lore Server 与健康检查都通过用户填写的外部地址访问 Auth，因此自定义公网或内网
# 证书不需要额外包含 Compose 的内部服务名。
cat > "$output_dir/config/local.toml" <<EOF
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

# Auth 镜像会降权到 UID 1001，Lore Server 则保持 root；私钥只授权给前者，后者仍可读取。
chown 1001:1001 "$output_dir/privkey.pem"
chmod 600 "$output_dir/privkey.pem"
chmod 644 "$output_dir/ca.pem" "$output_dir/fullchain.pem"
chmod 644 "$output_dir/config/local.toml"

echo "Lore Stack 配置已生成，外部主机: $external_host，TLS 模式: $tls_mode"
