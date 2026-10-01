# ── build context คือราก monorepo (.) เพื่อให้เห็นทุก workspace ──
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

# ── stage 1: ติดตั้ง dependency ทั้ง workspace ───────────────
FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
# ถ้ายังไม่มี lock file ให้ข้ามบรรทัดล่าง (npm จะสร้างให้)
RUN npm install --workspaces --include-workspace-root

# ── stage 2: build TypeScript ────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
RUN npm run build

# ── stage 3: เอาเฉพาะที่ขึ้น production ──────────────────────
FROM base AS prod-deps
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
RUN npm install --omit=dev --workspaces --include-workspace-root

FROM base AS runtime
ENV NODE_ENV=production
# อย่ารันเป็น root
USER node

COPY --from=prod-deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build       --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build       --chown=node:node /app/packages/shared/package.json ./packages/shared/
COPY --from=build       --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build       --chown=node:node /app/apps/api/package.json ./apps/api/

WORKDIR /app/apps/api
EXPOSE 4000
CMD ["node", "dist/server.js"]
