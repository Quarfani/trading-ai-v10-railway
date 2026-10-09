# Railway-ready production image for the Trading Core.
# A committed npm lockfile is mandatory; builds fail closed if it is missing.
FROM node:22-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN test -f package-lock.json
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

RUN npm run build
RUN npm prune --omit=dev
RUN node -e "require('./node_modules/better-sqlite3'); console.log('better-sqlite3 native module OK')"

FROM node:22-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=384

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data /app/backups \
    && node -e "require('./node_modules/better-sqlite3'); console.log('runtime native module OK')"

# Railway injects PORT; the app listens on it. Local default is only a fallback.
ENV PORT=4000
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4000)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
