import { normalizeThaiAlignment } from '../packages/shared/src/normalize.ts'
import { readFileSync } from 'node:fs'
const dir='D:/2docx.com/data/docserver-backup-20260930/template'
const files=[
  ['555288e5fc99572e131039402d4d79c09ee06fedf7d232f0363b4f88439780f8','หนังสือรับรอง เนินมะปราง สำเนา 1'],
  ['9aa9bbcdca69b2a2b7ea28702b9bc4d6f736872f1b0f17f587957ad4e98e8172','หนังสือรับรอง เนินมะปราง สำเนา 2'],
  ['9caa0c73d29b473cb6d2585dd3cb6719125d5694e94da7f4410ac313b4f9afcc','หนังสือรับรอง เนินมะปราง สำเนา 3'],
  ['c7b138d52c776cfb69f9e845b87f0e525b95bbd27eb51bf93f4b49ff047849a7','หนังสือรับรองให้อัยการ'],
]
for(const [sha,label] of files){
  const orig = readFileSync(`${dir}/${sha}`)
  const {buf,result} = normalizeThaiAlignment(orig)
  console.log(`${label}`)
  console.log(`   ${result.changed?'✓ แก้':'— ไม่ต้องแก้'} · ตรวจ ${result.scanned} ย่อหน้า · ${JSON.stringify(result.replaced)} · ${orig.length}→${buf.length} bytes`)
}

