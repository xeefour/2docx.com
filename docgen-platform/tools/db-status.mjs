import { MongoClient } from 'mongodb'
const url = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27019'
const c = new MongoClient(url)
await c.connect()
const db = c.db('app')
for (const col of ['documents', 'templates']) {
  const names = (await db.listCollections().toArray()).map(x => x.name)
  if (!names.includes(col)) { console.log(`${col}: ไม่มี collection`); continue }
  const byStatus = await db.collection(col).aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]).toArray()
  console.log(`${col}: ${byStatus.map(s => `${s._id ?? '(ไม่มี status)'} = ${s.n}`).join(' · ') || 'ว่าง'}`)
}
await c.close()
