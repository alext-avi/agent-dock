FROM node:22-bookworm-slim

ENV NPM_CONFIG_PREFIX=/opt/codex \
    PATH=/opt/codex/bin:$PATH \
    CODEX_HOME=/codex-home

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspace /codex-home /opt/codex
# Every module, not a list that has to be remembered. An omission here is not
# a build error: the image starts and dies on its first import at runtime.
COPY *.mjs entrypoint.sh ./
COPY adapters ./adapters
COPY mcp ./mcp
RUN chmod 0755 /app/entrypoint.sh

WORKDIR /workspace
EXPOSE 7777
ENTRYPOINT ["/app/entrypoint.sh"]
