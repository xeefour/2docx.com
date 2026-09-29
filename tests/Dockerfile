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

# 2) ฟอนต์ TH Sarabun จาก SIPA/กรมทรัพย์สิทธิ์ทางปัญญา
#    - TH Sarabun New  : รุ่นปัจจุบัน (GPL 2.0 + Font Exception)
#    - TH Sarabun PSK  : รุ่นเดิมที่เอกสารราชการส่วนใหญ่ยังอ้างอิงอยู่
#    ทั้งสองรุ่นหน้าตาและขนาดตัวอักษรเท่ากัน ใช้แทนกันได้
#    สัญญาอนุญาต: ใช้ได้ทั้งงานราชการและเชิงพาณิชย์
COPY lib/fonts/ /usr/local/share/fonts/thai/

# 3) สร้าง font cache ใหม่ให้ LibreOffice มองเห็นฟอนต์ใหม่ทันที
RUN fc-cache -f -v > /dev/null 2>&1 || true

USER carbone
