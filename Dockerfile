FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend ./frontend
COPY shared ./shared
COPY vite.config.mjs ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8098
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# The pinned Vercel CLI for the deploy worker (same version and lockfile as pos-builder).
# Installed at build time, never fetched at runtime; the app container never runs it.
COPY tools/vercel-cli/package*.json /opt/vercel-cli/
RUN npm ci --prefix /opt/vercel-cli --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY backend ./backend
COPY shared ./shared
COPY scripts ./scripts
RUN mkdir -p /app/.local /app/backups && chown node:node /app/.local /app/backups
# Work volume of the deploy worker: a fresh named volume mounted here inherits this ownership.
RUN mkdir -p /work && chown node:node /work
USER node
EXPOSE 8098
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/server.js"]
