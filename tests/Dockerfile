# ============================================================
#  Carbone 5.15.2 + ฟอนต์ราชการไทย + ตั้งค่าประสิทธิภาพ
# ============================================================
#  สร้างจาก Carbone Community Edition (ฟรี ไม่ต้องซื้อ license)
#  tag full-5.15.2 = เวอร์ชันเต็มที่มี LibreOffice 26.2
#  (tag slim จะไม่มี LibreOffice จึงแปลงเป็น PDF ไม่ได้)
# ============================================================
FROM carbone/carbone-ee:full-5.15.2

USER root

# ------------------------------------------------------------
# 1) แพ็กเกจระบบ
#
#    ฟอนต์ไทยมาตรฐาน (SIL Open Font License) ใช้เป็นฟอนต์สำรอง
#    curl ใช้เป็น healthcheck และตรวจปัญหาได้ง่าย
# ------------------------------------------------------------
RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
         fonts-thai-tlwg \
         fonts-noto-core \
         fontconfig \
         curl \
    && rm -rf /var/lib/apt/lists/*

# ------------------------------------------------------------
# 2) ฟอนต์ราชการไทยจาก SIPA / กรมทรัพย์สิทธิ์ทางปัญญา
#
#    ที่ติดตั้ง (ชื่อที่ประกาศในไฟล์ฟอนต์):
#      - TH Sarabun New      รุ่นปัจจุบัน  (4 สไตล์)
#      - TH Sarabun PSK      รุ่นเดิม       (4 สไตล์)
#      - TH SarabunPSK       รุ่นซีดีการาชการ รองรับทั้งชื่อ
#                            "TH SarabunPSK" และ "TH SarabunIT๙"
#                            จึงใช้กับเอกสารราชการรุ่นเก่าได้โดยไม่ต้องแก้ชื่อ
#      - TH Niramit AS       ฟอนต์ราชการอีกตัว
#
#    สัญญาอนุญาต: GPL 2.0 + Font Exception
#    ใช้ได้ทั้งงานราชการและเชิงพาณิชย์
# ------------------------------------------------------------
COPY lib/fonts/*.ttf /usr/local/share/fonts/thai/

# ------------------------------------------------------------
# 3) สร้าง font cache ใหม่ ให้ LibreOffice เห็นฟอนต์ทันที
# ------------------------------------------------------------
RUN fc-cache -f -v > /dev/null 2>&1 || true

# ------------------------------------------------------------
# 4) ตรวจสอบว่าฟอนต์หลักติดตั้งครบ (fail ถ้าไม่ครบ)
# ------------------------------------------------------------
RUN set -e; \
    for f in "TH Sarabun New" "TH Sarabun PSK" "TH SarabunPSK"; do \
      if fc-list | grep -q "$f"; then \
        echo "  [ติดตั้งแล้ว] $f"; \
      else \
        echo "  [ไม่พบ] $f" >&2; exit 1; \
      fi; \
    done; \
    echo "  จำนวนฟอนต์ไทยทั้งหมด: $(fc-list :lang=th | wc -l)"

# ------------------------------------------------------------
# 5) ตั้งค่า Carbone
#
#    ค่าสำคัญ 2 ตัวที่ปรับได้ (แก้ใน config/carbone-config.json):
#
#      converterFactoryTimeout : เวลาสูงสุดที่รอแปลงไฟล์ 1 ชิ้น
#                              ค่าเริ่มต้น 60000 (60 วิ) → เอกสารยาวจะหมดเวลา
#                              ตั้งเป็น 300000 (5 นาที) รองรับเอกสารราชการยาว
#
#      factories              : จำนวนงานที่ประมวลผลพร้อมกันได้
#                              ค่าเริ่มต้น 1 → ทีละงาน งานถัดไปต้องรอคิว
#                              ตั้งเป็น 3 → รับได้ 3 งานพร้อมกัน
#
#    ดูค่าที่ใช้จริงได้จาก:  docker logs carbone-thai | head -20
# ------------------------------------------------------------
COPY config/carbone-config.json /app/config/config.json
RUN chown -R carbone:carbone /app/config \
    && echo "  เวลาสูงสุด/ชิ้น: $(grep -o '\"converterFactoryTimeout\": *[0-9]*' /app/config/config.json | grep -o '[0-9]*$') ms" \
    && echo "  งานพร้อมกัน  : $(grep -o '\"factories\": *[0-9]*' /app/config/config.json | grep -o '[0-9]*$') งาน"

# ------------------------------------------------------------
# 6) ตรวจสอบสถาปัตยกรรม
# ------------------------------------------------------------
RUN set -e; \
    echo "  สถาปัตยกรรม: $(dpkg --print-architecture)"

ENV CARBONE_EE_API_KEY=carbon-ce
ENV TZ=Asia/Bangkok

EXPOSE 4000

# ------------------------------------------------------------
# 7) Healthcheck — ตรวจว่า API ตอบกลับจริง (ไม่ใช่แค่พอร์ตเปิด)
#
#    ใช้ curl เพราะ container ไม่มี node/python
#    Carbone เป็น binary คอมไพล์แล้ว (/app/carbone-ee-linux)
# ------------------------------------------------------------
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD curl --fail --silent --max-time 4 http://127.0.0.1:4000/status || exit 1

USER carbone
