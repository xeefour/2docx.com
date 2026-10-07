/**
 * หน้าแรก — server component เพื่อให้ SEO ได้เนื้อหาเต็มใน HTML
 * (Studio เป็น client component เพราะไม่ต้องการ SEO)
 */
import Link from 'next/link'

export default function HomePage() {
  return (
    <main style={{ maxWidth: 860, margin: '0 auto', padding: '64px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 40 }}>
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 9,
            background: 'var(--brand)',
            color: 'var(--on-brand)',
            display: 'grid',
            placeItems: 'center',
            fontWeight: 700,
          }}
        >
          2
        </div>
        <strong style={{ fontSize: 19 }}>2docx.com</strong>
      </div>

      <h1 style={{ fontSize: 40, lineHeight: 1.25, margin: '0 0 16px', letterSpacing: '-0.02em' }}>
        สร้างเอกสารราชการอัตโนมัติ
        <br />
        จากแม่แบบสำเร็จรูป
      </h1>

      <p style={{ fontSize: 18, color: 'var(--ink-2)', maxWidth: 620, marginBottom: 32 }}>
        กรอกข้อมูลลงในแม่แบบหนังสือรับรอง หนังสือราชการ หรือแบบฟอร์มที่ตั้งไว้
        ระบบสร้างไฟล์ PDF, Word หรือ Excel พร้อมดาวน์โหลดภายในไม่กี่วินาที
      </p>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Link
          href="/studio"
          style={{
            background: 'var(--brand)',
            color: 'var(--on-brand)',
            padding: '12px 22px',
            borderRadius: 8,
            textDecoration: 'none',
            fontWeight: 500,
          }}
        >
          เข้าสู่ระบบ
        </Link>
        <Link
          href="/apis"
          style={{
            border: '1px solid var(--line)',
            padding: '12px 22px',
            borderRadius: 8,
            textDecoration: 'none',
            color: 'var(--ink-2)',
          }}
        >
          เอกสาร API
        </Link>
        {/*
         * คู่มือภาษาไทย
         *
         * ⚠️ ต้องใช้ `<a>` ธรรมดา **ไม่ใช่** `next/link`
         *   เส้นทาง `/docs` ไม่ได้มาจาก Next.js แต่เสิร์ฟโดยตัว gateway (Caddy)
         *   ถ้าใช้ `<Link>` router ของ Next จะพยายามหา route นี้ในตัวเอง
         *   แล้วได้หน้า 404 ของ Next — ผู้ใช้กดแล้วไม่ถึงคู่มือ
         *   `<a>` ธรรมดาเป็นการนำทางเต็มรูปแบบ เบราว์เซอร์จะไปขอ /docs จริง
         *   ใช้รูปแบบนี้กับทุกเส้นทางที่ไม่ได้มาจาก Next.js
         */}
        <a
          href="/docs"
          style={{
            border: '1px solid var(--line)',
            padding: '12px 22px',
            borderRadius: 8,
            textDecoration: 'none',
            color: 'var(--ink-2)',
          }}
        >
          คู่มือใช้งาน
        </a>
        {/*
         * ลิงก์ไปหน้าบัญชี — ไม่ต้องล็อกอินก่อน
         * ถ้ายังไม่มี session หน้า `/account` จะพาไป `/auth/login?returnTo=/account` เอง
         */}
        <Link
          href="/account"
          style={{
            border: '1px solid var(--line)',
            padding: '12px 22px',
            borderRadius: 8,
            textDecoration: 'none',
            color: 'var(--ink-2)',
          }}
        >
          บัญชีของฉัน
        </Link>
      </div>

      <section style={{ marginTop: 72 }}>
        <h2 style={{ fontSize: 21, marginBottom: 20 }}>ทำไมต้องใช้ 2docx</h2>
        <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))' }}>
          {[
            ['เร็ว', 'เรียงงานแล้วเรนเดอร์อัตโนมัติ ไม่ต้องเปิด Word ทีละฉบับ'],
            ['เป็นมาตรฐาน', 'แม่แบบทุกฉบับใช้รูปแบบเดียวกัน ลดความผิดพลาดจากคนพิมพ์เอง'],
            ['ตรวจสอบได้', 'ทุกฉบับผ่านแบรนด์และเวอร์ชันเดียวกัน อ่านย้อนหลังได้'],
          ].map(([t, d]) => (
            <div key={t} className="card" style={{ padding: 18 }}>
              <h3 style={{ margin: '0 0 6px', fontSize: 16 }}>{t}</h3>
              <p style={{ margin: 0, color: 'var(--ink-2)', fontSize: 14 }}>{d}</p>
            </div>
          ))}
        </div>
      </section>

      <footer style={{ marginTop: 72, paddingTop: 24, borderTop: '1px solid var(--line)', color: 'var(--ink-3)', fontSize: 13 }}>
        2docx.com · ระบบสร้างเอกสารราชการอัตโนมัติ
      </footer>
    </main>
  )
}
