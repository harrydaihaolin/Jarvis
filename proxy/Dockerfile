FROM node:22-alpine

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

ENV PROXY_PORT=8787
EXPOSE 8787

# Lightweight healthcheck against the /health route.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:8787/health || exit 1

CMD ["node", "src/server.js"]
