import { homedir } from 'node:os'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'

interface CodexTokens {
  access_token?: unknown
  refresh_token?: unknown
  account_id?: unknown
}

interface CodexAuthDocument {
  tokens?: unknown
}

interface JwtPayload {
  exp?: unknown
  [key: string]: unknown
}

const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth'

/**
 * Resolve the default path to the local Codex CLI `auth.json` file.
 * @returns Absolute path to `auth.json`.
 */
export function defaultCodexAuthPath(): string {
  const explicit = process.env.CODEX_AUTH_JSON_PATH
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit)
  const codexHome = process.env.CODEX_HOME
  return resolve(codexHome === undefined || codexHome.length === 0
    ? join(homedir(), '.codex', 'auth.json')
    : join(codexHome, 'auth.json'))
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function decodeJwtPayload(token: string): JwtPayload | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined) return undefined
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof decoded === 'object' && decoded !== null ? decoded as JwtPayload : undefined
  } catch {
    return undefined
  }
}

function accountIdFrom(payload: JwtPayload | undefined): string | undefined {
  const auth = payload?.[OPENAI_AUTH_CLAIM]
  if (typeof auth !== 'object' || auth === null) return undefined
  return nonEmptyString((auth as Record<string, unknown>).chatgpt_account_id)
}

/**
 * Parse the Codex CLI document without retaining unrelated account metadata.
 * @param source - Parsed JSON document from `auth.json`.
 * @returns OAuth grant credential record, or `undefined` when required fields are absent.
 */
export function codexGrantRecord(source: unknown): CredentialRecord | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const document = source as CodexAuthDocument
  if (typeof document.tokens !== 'object' || document.tokens === null) return undefined
  const tokens = document.tokens as CodexTokens
  const access = nonEmptyString(tokens.access_token)
  const refresh = nonEmptyString(tokens.refresh_token)
  if (access === undefined || refresh === undefined) return undefined

  const jwt = decodeJwtPayload(access)
  const accountId = nonEmptyString(tokens.account_id) ?? accountIdFrom(jwt)
  const expiresSeconds = typeof jwt?.exp === 'number' && Number.isFinite(jwt.exp) ? jwt.exp : undefined
  if (accountId === undefined || expiresSeconds === undefined) return undefined

  return {
    kind: 'grant',
    payload: {
      type: 'oauth',
      access,
      refresh,
      expires: expiresSeconds * 1000,
      accountId,
    },
  }
}

/**
 * Read and parse a Codex OAuth grant record from disk.
 * @param filename - Path to the Codex `auth.json` file.
 * @returns OAuth grant credential record, or `undefined` when invalid.
 */
export async function readCodexGrant(filename: string): Promise<CredentialRecord | undefined> {
  const raw = await readFile(filename, 'utf8')
  const parsed: unknown = JSON.parse(raw)
  return codexGrantRecord(parsed)
}
