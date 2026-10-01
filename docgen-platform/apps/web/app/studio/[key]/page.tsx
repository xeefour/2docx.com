import Studio from '../Studio'

/**
 * เปิดแม่แบบตัวเดียวจาก URL — /studio/<key>
 *
 * ไฟล์นี้มีแค่เพื่อให้**รีเฟรชแล้วยังอยู่หน้าเดิม** และคัดลอก URL ให้คนอื่นเปิดได้
 * ตัวแสดงผลทั้งหมดยังอยู่ที่ `Studio.tsx` เหมือนกัน
 *
 * ⚠️ Next 15 ส่ง `params` มาเป็น Promise → ต้อง await
 */
export const metadata = {
  title: 'Studio · 2docx.com',
  robots: { index: false, follow: false },
}

export default async function Page({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  return <Studio initialKey={decodeURIComponent(key)} />
}
