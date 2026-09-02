FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY control-plane/*.mjs ./
COPY control-plane/public ./public

EXPOSE 3000
CMD ["node", "/app/server.mjs"]
