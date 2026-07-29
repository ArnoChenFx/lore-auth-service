# Prepare certificates and Lore Server settings in shared storage, then exit immediately.
FROM alpine:3.22

RUN apk add --no-cache openssl

COPY deploy/lore-stack/init.sh /usr/local/bin/lore-stack-init
RUN chmod +x /usr/local/bin/lore-stack-init

ENTRYPOINT ["/usr/local/bin/lore-stack-init"]
