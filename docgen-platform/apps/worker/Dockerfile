FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
RUN npm install --workspaces --include-workspace-root

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
# ⚠️ ห้ามใช้ `npm run build` (สคริปต์ที่ราก) ที่นี่ — เหตุผลเดียวกับ apps/api/Dockerfile
#    สคริปต์รากสั่ง build `@docgen/web` ด้วย แต่ image นี้ไม่ได้ copy โฟลเดอร์เว็บมา
#    → "No workspaces found: --workspace=@docgen/web"
RUN npm run build -w @docgen/shared && npm run build -w @docgen/worker

FROM base AS prod-deps
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/worker/package.json ./apps/worker/
RUN npm install --omit=dev --workspaces --include-workspace-root

FROM base AS runtime
ENV NODE_ENV=production
USER node

COPY --from=prod-deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build       --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build       --chown=node:node /app/packages/shared/package.json ./packages/shared/
COPY --from=build       --chown=node:node /app/apps/worker/dist ./apps/worker/dist
COPY --from=build       --chown=node:node /app/apps/worker/package.json ./apps/worker/

WORKDIR /app/apps/worker
# worker ไม่เปิด port — คุยผ่าน NATS อย่างเดียว
CMD ["node", "dist/index.js"]
