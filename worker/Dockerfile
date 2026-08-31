FROM node:22-bookworm-slim

ENV NPM_CONFIG_PREFIX=/opt/codex \
    PATH=/opt/codex/bin:$PATH \
    CODEX_HOME=/codex-home

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /codex-home /opt/codex
COPY server.mjs protocol.mjs workload-auth.mjs entrypoint.sh ./
COPY adapters ./adapters
COPY mcp ./mcp
RUN chmod 0755 /app/entrypoint.sh

WORKDIR /workspace
EXPOSE 7777
ENTRYPOINT ["/app/entrypoint.sh"]
