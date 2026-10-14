# ---- Build stage: bundle the game ----
FROM node:22-alpine AS build
WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---- Runtime stage: Node serves the game + the multiplayer WebSocket ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=80 \
    STATIC_DIR=/app/dist
WORKDIR /app

# Only runtime deps (just `ws` — three.js is already bundled into dist/)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY server ./server
COPY shared ./shared
COPY --from=build /app/dist ./dist

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server/index.js"]
