import { describe, expect, it } from 'vitest'
import { codexGrantRecord } from '../src/import.ts'

function token(payload: object): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

describe('Codex OAuth import', () => {
  it('maps only the fields required by the pi-ai Codex provider', () => {
    const access = token({ exp: 123, 'https://api.openai.com/auth': { chatgpt_account_id: 'account' } })
    const record = codexGrantRecord({
      tokens: {
        access_token: access,
        refresh_token: 'refresh',
      },
      unrelated: 'ignored',
    })
    expect(record).toEqual({
      kind: 'grant',
      payload: {
        type: 'oauth',
        access,
        refresh: 'refresh',
        expires: 123000,
        accountId: 'account',
      },
    })
  })

  it('refuses incomplete or malformed documents', () => {
    expect(codexGrantRecord({})).toBeUndefined()
    expect(codexGrantRecord({ tokens: { access_token: 'broken', refresh_token: 'refresh' } })).toBeUndefined()
  })
})
