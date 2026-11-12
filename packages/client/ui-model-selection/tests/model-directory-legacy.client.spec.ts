import type { ModelCatalog, ModelSelection, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { describe, expect, it, vi } from 'vitest'
import { ModelCatalogDirectory } from '../src/client/catalog.ts'
import { ModelDirectory } from '../src/client/directory.ts'

const levels = {
  efforts: [{ id: 'low', name: 'Baixo' }, { id: 'medium', name: 'Médio' }, { id: 'high', name: 'Alto' }],
  defaultEffort: 'medium',
}

/** Antigravity catalog after per-level model ids were folded into families. */
const catalog = (defaultModel = 'default'): ModelCatalog => ({
  default: { provider: 'antigravity-local', model: defaultModel },
  routableProviders: ['antigravity-local'],
  groups: [{
    id: 'antigravity-local',
    name: 'Antigravity',
    models: [
      { id: 'default', name: 'Automático' },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', reasoning: levels },
      { id: 'gpt-oss-120b', name: 'GPT-OSS 120B', reasoning: { efforts: [{ id: 'medium', name: 'Médio' }], defaultEffort: 'medium' } },
      // A listed id that also reads as `<model>-<level>` stays a model of its own.
      { id: 'gemini-4-argon-low', name: 'Gemini 4 Argon Low Edition' },
    ],
  }],
  failures: [],
})

async function directoryFor(saved: ModelSelection | null, value = catalog()): Promise<ModelDirectory> {
  const models = new ModelCatalogDirectory({ remote: { session: { modelCatalog: () => Promise.resolve({ ok: true, value }) } } } as never)
  const projected = createSnapshotStore<unknown>({ lastUsed: saved, next: saved })
  const directory = new ModelDirectory({ selectModel: vi.fn() }, 's1' as SessionId, () => true, models, projected, () => false)
  await directory.load()
  return directory
}

describe('ModelDirectory with a selection saved under a per-level model id', () => {
  it('shows a session saved on a retired `<model>-<level>` id as that model and level', async () => {
    const directory = await directoryFor({ provider: 'antigravity-local', model: 'gemini-4-argon-high' })
    expect(directory.store.getSnapshot()).toMatchObject({
      current: { provider: 'antigravity-local', model: 'gemini-4-argon', reasoningEffort: 'high' },
      retainedEffort: 'Alto',
      routable: true,
    })
  })

  it('does the same for a deployment default saved on a retired id', async () => {
    const directory = await directoryFor(null, catalog('gpt-oss-120b-medium'))
    expect(directory.store.getSnapshot()).toMatchObject({
      current: { provider: 'antigravity-local', model: 'gpt-oss-120b', reasoningEffort: 'medium' },
      routable: true,
    })
  })

  it('keeps a listed id, and an id that names no listed model and level, exactly as saved', async () => {
    const listed = await directoryFor({ provider: 'antigravity-local', model: 'gemini-4-argon-low' })
    expect(listed.store.getSnapshot()).toMatchObject({
      current: { provider: 'antigravity-local', model: 'gemini-4-argon-low' },
      routable: true,
    })
    const unknownLevel = await directoryFor({ provider: 'antigravity-local', model: 'gemini-4-argon-max' })
    expect(unknownLevel.store.getSnapshot()).toMatchObject({
      current: { provider: 'antigravity-local', model: 'gemini-4-argon-max' },
      routable: false,
    })
    const otherProvider = await directoryFor({ provider: 'codex-local', model: 'gemini-4-argon-high' })
    expect(otherProvider.store.getSnapshot()).toMatchObject({
      current: { provider: 'codex-local', model: 'gemini-4-argon-high' },
      routable: false,
    })
  })
})
