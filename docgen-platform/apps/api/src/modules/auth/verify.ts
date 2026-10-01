import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'
import { env } from '@docgen/shared'
import {
  discovery,
  exchangeCode,
  type SessionUser,
} from './oidc.js'

/**
 * key cache ของ jose — จะโหลด JWKS ครั้งแรกแล้วใช้ซ้ำ
 * ถ้า Casdoor หมุน key (kid ใหม่) jose จะ refetch ให้เองอัตโนมัติ
 */
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null

async function getJwks() {
  if (!jwks) {
    const d = await discovery(env.CASDOOR_ISSUER)
    jwks = createRemoteJWKSet(new URL(d.jwks_uri), {
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    })
  }
  return jwks
}

/**
 * verify JWT ที่ Casdoor ออกมา
 *
 * ตรวจ signature (RS256), issuer, audience และ exp ครบ
 * ไม่เชื่อ payload ที่ยังไม่ผ่านการ verify — เช็ค type ด้วยเพราะ
 * payload มาจากภายนอก อย่าเชื่อว่ามี field ครบ
 */
export async function verifyToken(token: string): Promise<SessionUser> {
  const d = await discovery(env.CASDOOR_ISSUER)
  const key = await getJwks()

  const { payload } = await jwtVerify(token, key, {
    issuer: d.issuer,
    audience: env.CASDOOR_CLIENT_ID,
    algorithms: ['RS256'],
  })

  return toSessionUser(payload)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** แปลง claim ของ Casdoor เป็นข้อมูลผู้ใช้ที่เก็บใน session */
function toSessionUser(p: JWTPayload): SessionUser {
  const sub = str(p.sub)
  if (!sub) throw new Error('token ไม่มี sub — ใช้ไม่ได้')

  return {
    sub,
    name: str(p.name) || str(p.displayName) || str(p.preferred_username) || sub,
    email: str(p.email),
    avatar: str(p.avatar) || str(p.permanentAvatar),
    affiliation: str(p.affiliation) || undefined,
  }
}

/** ขั้นตอน callback: code → token → user */
export async function loginWithCode(
  code: string,
  codeVerifier: string,
): Promise<SessionUser> {
  const d = await discovery(env.CASDOOR_ISSUER)

  const token = await exchangeCode({
    tokenEndpoint: d.token_endpoint,
    clientId: env.CASDOOR_CLIENT_ID,
    clientSecret: env.CASDOOR_CLIENT_SECRET,
    redirectUri: env.CASDOOR_REDIRECT_URI,
    code,
    codeVerifier,
  })

  // Casdoor: access_token === id_token → ใช้ตัวเดียวได้
  return verifyToken(token.access_token)
}
