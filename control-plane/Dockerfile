FROM node:22-bookworm-slim

WORKDIR /app
# Every module, not a list that has to be remembered. An omission here is not a
# build error: the image starts and dies on the first import at runtime.
COPY *.mjs ./
COPY public ./public

EXPOSE 3000
CMD ["node", "/app/server.mjs"]
