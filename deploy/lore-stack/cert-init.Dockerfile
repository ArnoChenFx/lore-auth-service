# 仅用于在共享卷中准备证书和 Lore Server 配置，完成后容器立即退出。
FROM alpine:3.22

RUN apk add --no-cache openssl

COPY deploy/lore-stack/init.sh /usr/local/bin/lore-stack-init
RUN chmod +x /usr/local/bin/lore-stack-init

ENTRYPOINT ["/usr/local/bin/lore-stack-init"]
