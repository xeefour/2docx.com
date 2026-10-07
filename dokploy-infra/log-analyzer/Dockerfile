# ─────────────────────────────────────────────────────────────
#  Log Analyzer — หน้าเว็บอ่าน log ทุก container แล้วให้ AI สรุป
#
#  รันเป็น service ใน stack เดียวกับ Loki/Alloy เพื่อให้เข้าได้ที่เดียวคือ gateway
#  (เดิมต้องรัน start.cmd บน host — ทำให้ไม่มีตอนอยู่ในระบบทั้งหมด)
#
#  ⚠️ หน้านี้**ไม่มี auth** เลย
#     ใครเข้ามาก็อ่าน log ทั้งหมดและใช้โควตา AI ได้
#     → compose จึง**ไม่ publish พอร์ต** ให้แต่ gateway ที่เรียกเข้ามาใน Docker network
#     → และ gateway ผูก 127.0.0.1 จึงเข้าจาก LAN/Tailscale ไม่ได้
#     ถ้าวันหลัง map โดเมนจริง ต้องเพิ่ม auth ก่อน (ดู gateway/README.md)
# ─────────────────────────────────────────────────────────────

FROM node:22-alpine

WORKDIR /app

# ไม่มี dependency นอกจากของมาตรฐาน (ใช้แค่ node:http + fetch)
# จึงไม่ต้อง npm install — COPY ไฟล์เดียวก็รันได้
#
# ⚠️ คัดลอกเฉพาะ 2 ไฟล์ที่รันจริง ไม่เอา .env / *.log / เทสต์เข้ามา
#    (เคยเป็นแนวโน้มคัดลอกทั้งโฟลเดอร์ ซึ่งเสี่ยงพาคีย์หลุดเข้า image)
COPY tools/log-analyzer/server.mjs  ./server.mjs
COPY tools/log-analyzer/index.html  ./index.html

# ใน container ต้อง bind 0.0.0.0 ไม่งั้น gateway เรียกเข้ามาไม่ได้
# (ค่านี้มีผลเฉพาะภายใน Docker network — host เข้าโดยตรงยังไม่ได้ เพราะไม่ publish พอร์ต)
ENV LOG_UI_HOST=0.0.0.0 \
    LOG_UI_PORT=3110 \
    NODE_ENV=production

EXPOSE 3110

# ใช้ผู้ใช้ที่ไม่มีสิทธิ์ (image นี้ไม่ต้องเขียนอะไรลงดิสก์)
USER node

# healthcheck ด้วยตัว node เอง ไม่พึ่ง curl/wget
# (เกณฑ์เดียวกันที่ใช้กับ docserver — ภาพ distroless ไม่มี curl)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3110/api/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
