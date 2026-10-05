# ── build context คือราก monorepo (.) เพื่อให้เห็นทุก workspace ──
FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

# ── stage 1: ติดตั้ง dependency ทั้ง workspace ───────────────
FROM base AS deps
COPY package.json package-lock.json* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/
COPY apps/worker/package.json ./apps/worker/
# ถ้ายังไม่มี lock file ให้ข้ามบรรทัดล่าง (npm จะสร้างให้)
RUN npm install --workspaces --include-workspace-root

# ── stage 2: build TypeScript ของ shared แล้ว build เว็บ ─────
#
# ⚠️ `API_ORIGIN` ต้องมีตั้งแต่ตอน build ไม่ใช่ตอนรัน
#    เพราะ Next เรียก `rewrites()` **ตอน `next build`** แล้วผลลัพธ์ถูก
#    serialize ไว้ใน build output → แก้ env ตอน runtime ไม่มีผล
#    (ถ้าอยากเปลี่ยนที่หลัง ต้อง build ใหม่)
#
#    ใน production ค่านี้ชี้เข้า network ภายใน Docker ไม่ใช่โดเมนข้างนอก
#    เพราะ gateway เป็นตัวรับคำขอจริง และจะส่งต่อ `/api` เข้า API เอง
ARG API_ORIGIN=http://api:4000
ENV API_ORIGIN=$API_ORIGIN

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
RUN npm run build -w @docgen/shared && npm run build -w @docgen/web

# ── stage 3: เอาเฉพาะที่ขึ้น production ──────────────────────
# ไม่ต้อง `npm install --omit=dev` เพราะ standalone ของ Next
# มาพร้อม node_modules ที่ trace ไว้แล้ว ลดขั้นตอนไปทั้งชั้น
FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# อย่ารันเป็น root
USER node

# ⚠️ โครงสร้างใน standalone ของ monorepo จะเป็น `apps/web/server.js`
#    ไม่ใช่ `server.js` ที่ราก เพราะเก็บ path ตามที่อยู่จริงของไฟล์
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
# ไฟล์ static กับ public ไม่ถูกรวมใน standalone ต้องก๊อปเพิ่ม
#   (ขาดแล้วหน้าจะเปิดได้แต่ CSS/JS ไม่ขึ้น → จอขาว)
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public

WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "server.js"]
