import { S3Client, PutObjectCommand, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3'
import { env } from '@docgen/shared'

const client = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  },
})

export async function ensureBucket(): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }))
  } catch {
    await client
      .send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }))
      .catch(() => undefined) // มีอยู่แล้ว = ปกติ
  }
}

/** error name ของ S3 ที่แปลว่า bucket ไม่มีอยู่จริง */
function isNoSuchBucket(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === 'NoSuchBucket' || e?.$metadata?.httpStatusCode === 404
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  const send = () =>
    client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    )

  try {
    await send()
  } catch (err) {
    // bucket หายกลางคันได้ (ถูกลบเอง, RustFS เพิ่งขึ้น, restore จาก backup)
    // → สร้างใหม่แล้วลองอีกครั้ง ไม่งั้นทุกงานจะล้มเหลวไปตลอดจนกว่าจะ restart
    if (!isNoSuchBucket(err)) throw err
    await ensureBucket()
    await send()
  }
}
