import Studio from './Studio'

// ไม่มี metadata เพราะเป็นเครื่องมือภายใน — ไม่ต้องการให้ index
export const metadata = {
  title: 'Studio · 2docx.com',
  robots: { index: false, follow: false },
}

export default function Page() {
  return <Studio />
}
