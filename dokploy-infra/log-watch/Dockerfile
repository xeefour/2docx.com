# ─────────────────────────────────────────────────────────────
#  Log Watch — ตรวจระบบอัตโนมัติทุกชั่วโมง แล้วเขียนรายงานเมื่อพบปัญหา
#
#  ⚠️ ไม่ publish พอร์ต — ไม่ต้องเข้าจากภายนอก (เป็นงานเบื้องหลัง)
#     ผลลัพธ์อยู่ที่ ../log-watch/findings/ บน host (bind mount)
# ─────────────────────────────────────────────────────────────

FROM node:22-alpine

WORKDIR /app

# context ของ build คือ **ราก repo** (ดู build.context ใน docker-compose.yml)
# จึงต้องเขียน path เต็มตั้งแต่ราก — ไม่ใช่ log-watch/...
# (เขียนสั้นแล้ว build จะ fail ด้วย "not found" ตอน checksum)
COPY dokploy-infra/log-watch/watcher.mjs  ./watcher.mjs

ENV NODE_ENV=production \
    GATEWAY_URL=http://docgen-gateway \
    LOKI_URL=http://loki:3100 \
    ANALYZER_URL=http://log-analyzer:3110 \
    ALLOY_METRICS=http://alloy:12345/metrics \
    FINDINGS_DIR=/findings \
    CHECK_INTERVAL_MIN=60 \
    HOST_IP=host.docker.internal

# สร้างโฟลเดอร์ก่อน เพราะ volume จะ mount ทับตอนบูต
RUN mkdir -p /findings && chown node:node /findings

USER node

HEALTHCHECK --interval=10m --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const fs=require('fs');const d='/findings';const f=d+'/runs.jsonl';if(!fs.existsSync(f))process.exit(1);const l=fs.readFileSync(f,'utf8').trim().split('\n');if(!l.length)process.exit(1);const t=Date.parse(JSON.parse(l[l.length-1]).ts);process.exit(Date.now()-t<3*3600e3?0:1)"

CMD ["node", "watcher.mjs"]