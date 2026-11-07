import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import { defaultCodexAuthPath, readCodexGrant } from './import.ts'

export const name = 'credentials-codex-import'
export const inject = ['credentials']

/** Configuration for the local Codex credential importer plugin. */
export interface Config {
  /** Optional override path to the Codex `auth.json` file. */
  authPath?: string
}

/** Schema for {@link Config}. */
export const Config: z<Config> = z.object({
  authPath: z.string(),
})

const TARGET = credentialKey('llm-pi-ai', 'openai-codex')

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * Seed the Harness grant once from the already authenticated Codex installation.
 * @param ctx - Cordis plugin context.
 * @param config - Importer configuration.
 * @returns Completion promise once the credential check finishes.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (await ctx.credentials.readRecord(TARGET) !== undefined) return

  const filename = resolveAuthPath(config.authPath)
  let imported
  try {
    imported = await readCodexGrant(filename)
  } catch (error) {
    if (isMissingFile(error)) {
      ctx.logger.info('credentials-codex-import: no local Codex login found')
      return
    }
    ctx.logger.warn('credentials-codex-import: local Codex login could not be read')
    ctx.logger.debug(error)
    return
  }

  if (imported === undefined) {
    ctx.logger.warn('credentials-codex-import: local Codex login has no reusable OAuth grant')
    return
  }

  await ctx.credentials.modifyRecord(TARGET, (current) => {
    if (current !== undefined) return Promise.resolve(undefined)
    return Promise.resolve(imported)
  })
  ctx.logger.info('credentials-codex-import: reused the existing local Codex subscription')
}

function resolveAuthPath(configured: string | undefined): string {
  return configured === undefined || configured.length === 0 ? defaultCodexAuthPath() : configured
}
