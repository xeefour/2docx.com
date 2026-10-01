import { createHash, randomBytes } from 'node:crypto'

/** endpoint ของ Casdoor ดึงจาก discovery document — ไม่ hardcode path เอง */
export interface OidcDiscovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint: string
  jwks_uri: string
  code_challenge_methods_supported?: string[]
}

export interface SessionUser {
  /** subject id จาก Casdoor (เปลี่ยนไม่ได้) */
  sub: string
  name: string
  email: string
  avatar: string
  /** organization / affiliation ถ้ามี */
  affiliation?: string
}

let cached: { url: string; value: OidcDiscovery } | null = null

/** ดึง discovery document แล้ว cache ไว้ (ไม่ต้องยิงซ้ำทุกครั้ง) */
export async function discovery(issuer: string): Promise<OidcDiscovery> {
  if (cached?.url === issuer) return cached.value

  const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`)
  if (!res.ok) {
    throw new Error(`Casdoor discovery ล้มเหลว: HTTP ${res.status}`)
  }

  const value = (await res.json()) as OidcDiscovery
  cached = { url: issuer, value }
  return value
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** PKCE: verifier สุ่ม → challenge = base64url(sha256(verifier)) */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export interface AuthorizeParams {
  authorizationEndpoint: string
  clientId: string
  redirectUri: string
  scopes: string
  state: string
  codeChallenge: string
}

/** URL ที่จะ redirect ผู้ใช้ไปหน้า login ของ Casdoor */
export function authorizeUrl(p: AuthorizeParams): string {
  const q = new URLSearchParams({
    client_id: p.clientId,
    response_type: 'code',
    redirect_uri: p.redirectUri,
    scope: p.scopes,
    state: p.state,
    code_challenge: p.codeChallenge,
    code_challenge_method: 'S256',
  })
  return `${p.authorizationEndpoint}?${q.toString()}`
}

interface TokenResponse {
  access_token: string
  id_token?: string
  refresh_token?: string
  token_type: string
  expires_in: number
}

/**
 * แลก authorization code เป็น token
 *
 * ⚠️ Casdoor ทำให้ access_token กับ id_token เป็น JWT ตัวเดียวกัน
 *    (payload เดียวกันเปล่า ๆ) เราเอา access_token ไป verify พอ
 */
export async function exchangeCode(opts: {
  tokenEndpoint: string
  clientId: string
  clientSecret: string
  redirectUri: string
  code: string
  codeVerifier: string
}): Promise<TokenResponse> {
  const res = await fetch(opts.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      redirect_uri: opts.redirectUri,
      code: opts.code,
      code_verifier: opts.codeVerifier,
    }),
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Casdoor แลก token ไม่สำเร็จ: HTTP ${res.status} ${body.slice(0, 300)}`)
  }

  return (await res.json()) as TokenResponse
}
