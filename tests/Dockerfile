# Carbone + ฟอนต์ภาษาไทย สำหรับทดสอบภาษาไทย
# full-5.15.2 = เวอร์ชันเต็มที่มี LibreOffice 26.2 (จำเป็นสำหรับแปลงเป็น PDF)
# slim = ไม่มี LibreOffice แปลงเป็น PDF ไม่ได้
FROM carbone/carbone-ee:full-5.15.2

USER root

# 1) ฟอนต์ไทยมาตรฐานราชการจากแพ็กเกจ Debian (ครอบคลุมภาษาไทยทั่วไป)
#    เผยแพร่ภายใต้ SIL Open Font License - ใช้ได้ทั้งงานราชการและเชิงพาณิชย์
RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
         fonts-thai-tlwg \
         fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*

# 2) ฟอนต์ TH Sarabun New (4 สไตล์) จาก SIPA/กรมทรัพย์สิทธิ์ทางปัญญา
#    สัญญาอนุญาต GPL 2.0 + Font Exception - ใช้เชิงพาณิชย์ได้
COPY fonts/ /usr/local/share/fonts/thai/

# 3) สร้าง font cache ใหม่ให้ LibreOffice มองเห็นฟอนต์ใหม่ทันที
RUN fc-cache -f -v > /dev/null 2>&1 || true

USER carbone
