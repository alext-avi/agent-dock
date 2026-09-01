FROM node:22-bookworm-slim

WORKDIR /app
COPY server.mjs auth.mjs workload-token.mjs docker-runtime.mjs mcp-service.mjs scheduler.mjs ./
COPY public ./public

EXPOSE 3000
CMD ["node", "/app/server.mjs"]
