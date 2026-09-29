# -*- coding: utf-8 -*-
"""
เซิร์ฟเวอร์จำลองสำหรับรับ webhook จาก Carbone
ใช้ทดสอบโหมด async (ได้เวลา 5 นาที แทน 60 วินาที)

วิธีใช้:
    python webhook_server.py            # ฟังที่ port 4001
    python webhook_server.py 5000       # ฟังที่ port อื่น
"""
import sys
import json
import time
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 4001
RECEIVED = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""

        # บันทึกผลลัพธ์ลงไฟล์ เพื่อให้สคริปต์หลักอ่านได้
        try:
            payload = json.loads(body.decode("utf-8"))
        except Exception:
            payload = {"raw": body.decode("utf-8", errors="replace")}

        payload["_received_at"] = time.time()
        payload["_path"] = self.path
        payload["_headers"] = {k: v for k, v in self.headers.items()
                               if k.lower().startswith("carbone") or
                                  k.lower() == "content-type"}
        RECEIVED.append(payload)

        out = sys.argv[2] if len(sys.argv) > 2 else None
        if out:
            with open(out, "a", encoding="utf-8") as f:
                f.write(json.dumps(payload, ensure_ascii=False) + "\n")

        print(f"[webhook] รับแล้ว renderId="
              f"{payload.get('data', {}).get('renderId', '?')}",
              flush=True)

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"success":true}')

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    srv = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"webhook server ฟังที่ port {PORT}", flush=True)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    # รอถูกเรียกจนกว่าจะกด Ctrl+C
    try:
        while True:
            time.sleep(1)
            if len(RECEIVED) >= 3:
                break
    except KeyboardInterrupt:
        pass
    finally:
        srv.shutdown()
    print(f"ได้รับทั้งหมด {len(RECEIVED)} คำขอ", flush=True)
