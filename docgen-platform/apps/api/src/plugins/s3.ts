import fp from 'fastify-plugin'
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env, UpstreamError } from '@docgen/shared'

declare module 'fastify' {
  interface FastifyInstance {
    s3: {
      put(key: string, body: Buffer, contentType: string): Promise<void>
      getUrl(key: string, expiresIn?: number): Promise<string>
      /**
       * ดึงไฟล์มาทั้งก้อน
       *
       * ใช้ตอนเบราว์เซอร์ต้องอ่านไฟล์เอง (เช่น pdf.js ทำพรีวิว)
       * เพราะ presigned URL ชี้ไปที่ endpoint ภายนอก + RustFS ไม่มี CORS
       * → เบราว์เซอร์อ่านข้ามโดเมนไม่ได้ ต้องให้ API เป็นตัวส่งแทน
       */
      get(key: string): Promise<Buffer>
      /** ลบไฟล์ — คืน false ถ้าไม่พบ (ถือว่าสำเร็จ) */
      del(key: string): Promise<boolean>
      /** เช็คว่า endpoint + bucket ตอบอยู่จริง — ใช้ใน /api/health */
      ping(): Promise<void>
    }
  }
}

export const s3Plugin = fp(async (app) => {
  const credentials = {
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  }

  /** client สำหรับงานที่รันบนเครื่องนี้ (เขียน/ลบ/เช็ค bucket) */
  const client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials,
  })

  /**
   * client สำหรับออก presigned URL
   *
   * ถ้าไม่ตั้ง S3_PUBLIC_ENDPOINT จะใช้ client เดียวกัน — ซึ่งถูกต้องตอน
   * ผู้เรียกอยู่บนเครื่องเดียวกัน แต่พังทันทีถ้าเรียกผ่าน Tailscale/Cloudflare
   * เพราะ URL จะชี้ 127.0.0.1 ซึ่งคือ localhost ของ client ไม่ใช่ของเรา
   */
  const publicEndpoint = env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT
  const signer = new S3Client({
    region: env.S3_REGION,
    endpoint: publicEndpoint,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials,
  })

  if (env.S3_PUBLIC_ENDPOINT && env.S3_PUBLIC_ENDPOINT !== env.S3_ENDPOINT) {
    app.log.info(
      { internal: env.S3_ENDPOINT, public: env.S3_PUBLIC_ENDPOINT },
      'presigned URL จะชี้ที่ endpoint ภายนอก',
    )
  }

  const ensureBucket = async () => {
    const { CreateBucketCommand, HeadBucketCommand } = await import('@aws-sdk/client-s3')
    try {
      await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }))
    } catch {
      app.log.info({ bucket: env.S3_BUCKET }, 'สร้าง bucket ใหม่')
      try {
        await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }))
      } catch (err) {
        // แข่งกับ node อื่นที่สร้างพร้อมกัน = ปกติ
        app.log.debug({ err }, 'สร้าง bucket ไม่สำเร็จ (อาจมีอยู่แล้ว)')
      }
    }
  }

  await ensureBucket()

  app.decorate('s3', {
    async put(key, body, contentType) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: key,
            Body: body,
            ContentType: contentType,
          }),
        )
      } catch (err) {
        throw new UpstreamError('S3', `บันทึก '${key}' ไม่สำเร็จ`, String(err))
      }
    },

    async getUrl(key, expiresIn = 3600) {
      try {
        return await getSignedUrl(
          signer,
          new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
          { expiresIn },
        )
      } catch (err) {
        throw new UpstreamError('S3', `สร้างลิงก์ไม่สำเร็จ`, String(err))
      }
    },

    async get(key) {
      try {
        const { GetObjectCommand } = await import('@aws-sdk/client-s3')
        const res = await client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
        return Buffer.from(await res.Body!.transformToByteArray())
      } catch (err) {
        throw new UpstreamError('S3', `อ่าน '${key}' ไม่สำเร็จ`, String(err))
      }
    },

    async del(key) {
      try {
        const res = await client.send(
          new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
        )
        return res.$metadata?.httpStatusCode === 204
      } catch (err) {
        throw new UpstreamError('S3', `ลบ '${key}' ไม่สำเร็จ`, String(err))
      }
    },

    async ping() {
      const { HeadBucketCommand } = await import('@aws-sdk/client-s3')
      await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }))
    },
  })

  app.log.info({ bucket: env.S3_BUCKET, endpoint: env.S3_ENDPOINT }, 'S3 พร้อม')
})
