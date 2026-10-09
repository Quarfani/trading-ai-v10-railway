FROM node:22-slim AS build

WORKDIR /app

# Railway build-time variable for Vite
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL

COPY package*.json ./

RUN test -f package-lock.json
RUN npm ci --no-audit --no-fund

COPY . .

RUN echo "Building dashboard with VITE_API_URL=$VITE_API_URL" && npm run build


FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

ENV PORT=3000

EXPOSE 3000

CMD ["sh", "-c", "npm run preview -- --host 0.0.0.0 --port ${PORT:-3000}"]