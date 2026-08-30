FROM node:22-bookworm-slim

WORKDIR /app
COPY server.mjs docker-runtime.mjs mcp-service.mjs ./
COPY public ./public

EXPOSE 3000
CMD ["node", "/app/server.mjs"]
