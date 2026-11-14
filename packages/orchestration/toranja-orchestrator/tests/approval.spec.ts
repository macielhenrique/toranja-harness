import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync, type PathLike } from 'node:fs'
import fsPromises from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { ROUTING, cleanup, delegate, gitRepo, mount, repos, runGate, settled, type Harness } from './harness.ts'

afterEach(cleanup)

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], { cwd }).toString().trim()

/** The settled task of the only delegation of a harness. */
const outcome = async (harness: Harness): Promise<Record<string, unknown>> =>
  (await settled(harness))[0] as unknown as Record<string, unknown>

interface Question {
  readonly id: string
  readonly header: string
  readonly question: string
  readonly detail?: string
  readonly options: readonly { readonly label: string }[]
  readonly intent?: { readonly kind: string; readonly approve: string; readonly callId?: string }
}
interface Ask {
  readonly questions: readonly Question[]
  readonly agent: unknown
  readonly signal: AbortSignal
}

/** A simulated `userQuestions` service that records each request and answers with `reply`. */
function questions(reply: (request: Ask) => unknown): {
  readonly asked: Ask[]
  readonly service: { ask: (request: Ask) => Promise<unknown> }
} {
  const asked: Ask[] = []
  return { asked, service: { ask: async (request) => { asked.push(request); return await Promise.resolve().then(() => reply(request)) } } }
}
/** The user's answer that picks the approving option. */
const approving = (request: Ask): unknown => {
  const [question] = request.questions
  return { answers: [{ id: question?.id, selected: [question?.intent?.approve] }] }
}

const PLAN = '# Fix the typo\n\nChange tracked.txt.'

function submit(
  harness: Harness,
  args: Record<string, unknown> = {},
  signal = new AbortController().signal,
): Promise<Record<string, unknown>> {
  return harness.tool('submit_project_plan').execute({
    project: 'demo',
    plan: PLAN,
    writeScope: ['tracked.txt'],
    ...args,
  }, { agent: {}, signal, callId: 'call-plan' }).then(text => JSON.parse(text) as Record<string, unknown>)
}

/** Run a completed reader in a project and return its task id. */
async function investigate(harness: Harness, project = 'demo'): Promise<string> {
  const result = await delegate(harness, { role: 'reader', project })
  await settled(harness)
  return (result.activations as { taskId: string }[])[0]?.taskId ?? ''
}

describe('Toranja approval policy', () => {
  it('is off unless configured, and the status reports it with the classification limits and no plans', async () => {
    const harness = await mount({ routing: ROUTING })
    expect(harness.status()).toMatchObject({
      approvalPolicy: 'off',
      classification: { maxDirectFiles: 3, maxInvestigatedFiles: 10 },
      plans: [],
    })
    expect((await mount({ routing: ROUTING, approvalPolicy: 'auto' })).status().approvalPolicy).toBe('auto')
  })

  it('stores a policy the user changes, keeps it after a restart, and rejects an unknown one', async () => {
    const disk = new MemoryMediaPool()
    const harness = await mount({ routing: ROUTING }, ['codex', 'antigravity'], disk)
    // A state stored before the field existed still loads.
    await harness.setMode({ mode: 'codex' })
    const older = await mount({ routing: ROUTING, approvalPolicy: 'auto' }, ['codex', 'antigravity'], disk)
    expect(older.status()).toMatchObject({ mode: 'codex', approvalPolicy: 'auto' })
    await older.update({ approvalPolicy: 'always' })
    await expect(older.update({ approvalPolicy: 'sometimes' })).rejects.toThrow('approvalPolicy')
    expect(older.status().approvalPolicy).toBe('always')
    const restarted = await mount({ routing: ROUTING, approvalPolicy: 'auto' }, ['codex', 'antigravity'], disk)
    expect(restarted.status().approvalPolicy).toBe('always')
  })

  it('leaves the implementer unchanged while the policy is off', async () => {
    const harness = await mount({ routing: ROUTING })
    await delegate(harness, { role: 'implementer', task: 'delete the production database' })
    expect((await settled(harness))[0]).toMatchObject({ role: 'implementer', state: 'completed' })
  })

  it('requires a write scope for the implementer while the policy is on', async () => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
    await expect(delegate(harness, { role: 'implementer' })).rejects.toThrow('writeScope is required for implementer while the approval policy is auto')
    expect(harness.started).toEqual([])
    expect(harness.status().tasks).toEqual([])
  })

  it('runs a simple implementer task directly and records its scope', async () => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
    harness.agentSideEffect = (cwd) => { writeFileSync(join(cwd, 'tracked.txt'), 'implemented\n') }
    await delegate(harness, { role: 'implementer', writeScope: ['./tracked.txt'] })
    expect(await outcome(harness)).toMatchObject({ state: 'completed', writeScope: ['tracked.txt'] })
  })
})

describe('Toranja write-scope check in the project tree', () => {
  const run = async (sideEffect: (cwd: string) => void, writeScope = ['tracked.txt'], before?: (repo: string) => void) => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
    before?.(harness.repo)
    harness.agentSideEffect = sideEffect
    await delegate(harness, { role: 'implementer', writeScope })
    return await outcome(harness)
  }

  it('fails an implementer that wrote outside its scope and lists at most five paths', async () => {
    const task = await run((cwd) => {
      writeFileSync(join(cwd, 'tracked.txt'), 'implemented\n')
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) writeFileSync(join(cwd, `${name}.txt`), name)
    })
    expect(task).toMatchObject({
      state: 'failed',
      error: 'implementer wrote outside the approved scope: a.txt, b.txt, c.txt, d.txt, e.txt (and 2 more)',
    })
  })

  it('accepts a new file in a new directory when the scope names it', async () => {
    const task = await run((cwd) => {
      mkdirSync(join(cwd, 'src'))
      writeFileSync(join(cwd, 'src', 'new.ts'), 'export {}\n')
    }, ['src/new.ts'])
    expect(task).toMatchObject({ state: 'completed' })
  })

  it('catches a file that was already changed before the run and is changed again outside the scope', async () => {
    const task = await run(
      (cwd) => { writeFileSync(join(cwd, 'tracked.txt'), 'changed again by the implementer\n') },
      ['other.txt'],
      (repo) => { writeFileSync(join(repo, 'tracked.txt'), 'work of the user\n') },
    )
    expect(task).toMatchObject({ state: 'failed', error: 'implementer wrote outside the approved scope: tracked.txt' })
  })

  it('does not blame the implementer for changes that were there before it ran', async () => {
    const task = await run(
      (cwd) => { writeFileSync(join(cwd, 'other.txt'), 'implemented\n') },
      ['other.txt'],
      (repo) => {
        writeFileSync(join(repo, 'tracked.txt'), 'work of the user\n')
        writeFileSync(join(repo, 'notes.txt'), 'draft of the user\n')
      },
    )
    expect(task).toMatchObject({ state: 'completed' })
  })

  it('catches a commit the implementer made outside its scope', async () => {
    const task = await run((cwd) => {
      writeFileSync(join(cwd, 'other.txt'), 'committed\n')
      git(cwd, 'add', 'other.txt')
      git(cwd, 'commit', '-q', '-m', 'outside')
    })
    expect(task).toMatchObject({ state: 'failed', error: 'implementer wrote outside the approved scope: other.txt' })
  })

  it('catches a link the implementer put in the index, even inside its scope', async () => {
    const task = await run((cwd) => {
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, input: '/etc/passwd' }).toString().trim()
      git(cwd, 'update-index', '--add', '--cacheinfo', `120000,${blob},inside.txt`)
    }, ['inside.txt'])
    expect(task).toMatchObject({ state: 'failed', error: 'implementer changed a link or submodule: inside.txt' })
  })

  it.each([
    ['a hook', (cwd: string) => { writeFileSync(join(cwd, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho planted\n') }, 'implementer changed Git configuration or hooks: hooks, hooks/pre-commit'],
    ['the configuration', (cwd: string) => { git(cwd, 'config', 'toranja.planted', 'yes') }, 'implementer changed Git configuration or hooks: config'],
    ['the exclude file', (cwd: string) => { writeFileSync(join(cwd, '.git', 'info', 'exclude'), 'other.txt\n') }, 'implementer changed Git configuration or hooks: info/exclude'],
    ['the attributes file', (cwd: string) => { writeFileSync(join(cwd, '.git', 'info', 'attributes'), '* filter=x\n') }, 'implementer changed Git configuration or hooks: info/attributes'],
    ['the per-worktree configuration', (cwd: string) => { writeFileSync(join(cwd, '.git', 'config.worktree'), '[core]\n\tfsmonitor = x\n') }, 'implementer changed Git configuration or hooks: config.worktree'],
    ['another branch', (cwd: string) => { git(cwd, 'branch', 'outro') }, 'implementer changed other branches or refs: refs/heads/outro'],
    ['a tag', (cwd: string) => { git(cwd, 'tag', 'v9') }, 'implementer changed other branches or refs: refs/tags/v9'],
  ])('fails an implementer that changed %s, even inside its scope', async (_name, sideEffect, error) => {
    const task = await run((cwd) => {
      writeFileSync(join(cwd, 'tracked.txt'), 'implemented\n')
      sideEffect(cwd)
    })
    expect(task).toMatchObject({ state: 'failed', error })
  })

  describe('of the hooks directory', () => {
    const hooks = (repo: string): string => join(repo, '.git', 'hooks')
    /** Deny or give back the listing of a directory, keeping its files writable. */
    const listing = (path: string, denied: boolean): void => {
      if (process.platform !== 'win32') chmodSync(path, denied ? 0o300 : 0o755)
      else execFileSync('icacls', [path, denied ? '/deny' : '/remove:d', denied ? '*S-1-1-0:(RD)' : '*S-1-1-0'], { stdio: 'ignore' })
    }

    it('cannot verify the hooks when their directory can no longer be listed', async () => {
      let repo = ''
      try {
        const task = await run((cwd) => {
          writeFileSync(join(hooks(cwd), 'pre-commit'), '#!/bin/sh\necho planted\n')
          listing(hooks(cwd), true)
        }, ['tracked.txt'], (created) => {
          repo = created
          rmSync(hooks(repo), { recursive: true, force: true })
          mkdirSync(hooks(repo))
        })
        expect(task).toMatchObject({ state: 'failed', error: 'write scope could not be verified' })
      } finally {
        if (repo !== '') listing(hooks(repo), false)
      }
    })

    it('cannot verify the hooks when their directory holds more than 256 entries', async () => {
      const task = await run(() => {}, ['tracked.txt'], (repo) => {
        for (let index = 0; index < 257; index++) writeFileSync(join(hooks(repo), `hook-${index}`), '')
      })
      expect(task).toMatchObject({ state: 'failed', error: 'write scope could not be verified' })
    })

    it('fails an implementer that replaced it with a link to a copy holding the same hooks', async () => {
      const copy = mkdtempSync(join(tmpdir(), 'toranja-hooks-'))
      repos.push(copy)
      const task = await run((cwd) => {
        cpSync(hooks(cwd), copy, { recursive: true })
        rmSync(hooks(cwd), { recursive: true })
        symlinkSync(copy, hooks(cwd), 'junction')
      })
      expect(task).toMatchObject({ state: 'failed', error: 'implementer changed Git configuration or hooks: hooks' })
    })

    it('fails an implementer that changed the mode of a hook', async () => {
      const task = await run(
        (cwd) => { chmodSync(join(hooks(cwd), 'pre-push'), 0o444) },
        ['tracked.txt'],
        (repo) => { writeFileSync(join(hooks(repo), 'pre-push'), '#!/bin/sh\n', { mode: 0o644 }) },
      )
      expect(task).toMatchObject({ state: 'failed', error: 'implementer changed Git configuration or hooks: hooks/pre-push' })
    })
  })

  it('fails an implementer that added a replacement object', async () => {
    let replaced = ''
    const task = await run((cwd) => {
      replaced = git(cwd, 'rev-parse', 'HEAD')
      git(cwd, 'update-ref', `refs/replace/${replaced}`, replaced)
    })
    expect(task).toMatchObject({ state: 'failed', error: `implementer changed other branches or refs: refs/replace/${replaced}` })
  })

  it('accepts a commit inside the scope on the branch the tree has checked out', async () => {
    const task = await run((cwd) => {
      writeFileSync(join(cwd, 'tracked.txt'), 'implemented\n')
      git(cwd, 'commit', '-qam', 'inside')
    })
    expect(task).toMatchObject({ state: 'completed' })
  })

  it('fails an implementer that pointed the project at another Git directory', async () => {
    const elsewhere = gitRepo()
    const task = await run((cwd) => {
      renameSync(join(cwd, '.git'), join(cwd, '.git-moved'))
      writeFileSync(join(cwd, '.git'), `gitdir: ${join(elsewhere, '.git')}\n`)
    })
    expect(task).toMatchObject({ state: 'failed', error: 'implementer changed the Git directory' })
  })

  describe('with entries Git ignores', () => {
    const ignoring = (repo: string): void => {
      writeFileSync(join(repo, '.gitignore'), '.env\ndist/\nnode_modules/\n')
      git(repo, 'commit', '-qam', 'ignore build output')
      mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true })
      writeFileSync(join(repo, 'node_modules', 'x', 'i.js'), 'before\n')
      writeFileSync(join(repo, '.env'), 'A=1\n')
    }
    const implementInScope = (cwd: string): void => {
      mkdirSync(join(cwd, 'src'), { recursive: true })
      writeFileSync(join(cwd, 'src', 'a.ts'), 'export {}\n')
    }

    it('does not count what the implementer wrote in them outside its scope', async () => {
      const task = await run((cwd) => {
        implementInScope(cwd)
        mkdirSync(join(cwd, 'dist'))
        writeFileSync(join(cwd, 'dist', 'out.js'), 'built\n')
        writeFileSync(join(cwd, 'node_modules', 'x', 'i.js'), 'after\n')
        writeFileSync(join(cwd, 'node_modules', 'new.js'), 'installed\n')
      }, ['src/a.ts'], ignoring)
      expect(task).toMatchObject({ state: 'completed' })
    })

    it('counts an ignored entry that is protected', async () => {
      const task = await run((cwd) => {
        implementInScope(cwd)
        writeFileSync(join(cwd, '.env'), 'A=2\n')
      }, ['src/a.ts'], ignoring)
      expect(task).toMatchObject({ state: 'failed', error: 'implementer wrote outside the approved scope: .env' })
    })

    const ignoringMore = (repo: string): void => {
      ignoring(repo)
      writeFileSync(join(repo, '.gitignore'), '.env\ndist/\nnode_modules/\n.vscode/\nlinked\n')
      git(repo, 'commit', '-qam', 'ignore editor settings and a link')
    }

    it('counts an ignored editor configuration, protected by default', async () => {
      const task = await run((cwd) => {
        implementInScope(cwd)
        mkdirSync(join(cwd, '.vscode'))
        writeFileSync(join(cwd, '.vscode', 'tasks.json'), '{}\n')
      }, ['src/a.ts'], ignoringMore)
      expect(task).toMatchObject({ state: 'failed', error: 'implementer wrote outside the approved scope: .vscode/' })
    })

    it('counts a link the implementer created under an ignored name', async () => {
      const target = mkdtempSync(join(tmpdir(), 'toranja-link-target-'))
      repos.push(target)
      const task = await run((cwd) => {
        implementInScope(cwd)
        symlinkSync(target, join(cwd, 'linked'), 'junction')
      }, ['src/a.ts'], ignoringMore)
      expect(task).toMatchObject({ state: 'failed', error: expect.stringMatching(/^implementer changed a link or submodule: linked\/?$/u) as unknown })
    })

    it('counts an ignored directory that holds a protected path anchored at the root', async () => {
      const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto', classification: { protectedPaths: ['config/secrets/'] } })
      writeFileSync(join(harness.repo, '.gitignore'), 'config/\n')
      git(harness.repo, 'commit', '-qam', 'ignore the local configuration')
      harness.agentSideEffect = (cwd) => {
        implementInScope(cwd)
        mkdirSync(join(cwd, 'config', 'secrets'), { recursive: true })
        writeFileSync(join(cwd, 'config', 'secrets', 'key'), 'planted\n')
      }
      await delegate(harness, { role: 'implementer', writeScope: ['src/a.ts'] })
      expect(await outcome(harness)).toMatchObject({ state: 'failed', error: 'implementer wrote outside the approved scope: config/' })
    })

    it('counts ignored entries when the implementer changed an ignore file', async () => {
      const task = await run((cwd) => {
        writeFileSync(join(cwd, '.gitignore'), '.env\ndist/\nnode_modules/\nsecret/\n')
        mkdirSync(join(cwd, 'secret'))
        writeFileSync(join(cwd, 'secret', 'x.sh'), 'planted\n')
      }, ['.gitignore'], ignoring)
      expect(task).toMatchObject({ state: 'failed', error: 'implementer wrote outside the approved scope: secret/' })
    })

    it('counts a new directory that ignores itself', async () => {
      const task = await run((cwd) => {
        implementInScope(cwd)
        mkdirSync(join(cwd, 'lib'))
        writeFileSync(join(cwd, 'lib', '.gitignore'), '*\n')
        writeFileSync(join(cwd, 'lib', 'evil.js'), 'planted\n')
      }, ['src/a.ts'], ignoring)
      expect(task).toMatchObject({ state: 'failed', error: expect.stringContaining('implementer wrote outside the approved scope: lib/') as unknown })
    })

    it('does not take ignore rules from a file outside the repository', async () => {
      const outside = mkdtempSync(join(tmpdir(), 'toranja-excludes-'))
      repos.push(outside)
      const excludes = join(outside, 'ignore')
      writeFileSync(excludes, '')
      const task = await run((cwd) => {
        implementInScope(cwd)
        writeFileSync(excludes, 'evil.js\n')
        writeFileSync(join(cwd, 'evil.js'), 'planted\n')
      }, ['src/a.ts'], (repo) => {
        ignoring(repo)
        git(repo, 'config', 'core.excludesFile', excludes.replaceAll('\\', '/'))
      })
      expect(task).toMatchObject({ state: 'failed', error: 'implementer wrote outside the approved scope: evil.js' })
    })
  })

  it('fails the implementer, within the time limit, when a Git command of the check never ends', async () => {
    const realTimeout = AbortSignal.timeout.bind(AbortSignal)
    // The Host stops a Git command after 60 seconds; the test shortens only that wait.
    const timeouts = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => realTimeout(ms === 60_000 ? 200 : ms))
    try {
      const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
      let hung = false
      harness.gitGate = () => hung ? new Promise(() => {}) : undefined
      harness.agentSideEffect = (cwd) => {
        writeFileSync(join(cwd, 'tracked.txt'), 'implemented\n')
        hung = true
      }
      await delegate(harness, { role: 'implementer', writeScope: ['tracked.txt'] })
      await expect.poll(() => harness.status().active, { timeout: 4_000 }).toBe(0)
      expect(harness.status().tasks[0]).toMatchObject({ state: 'failed', error: 'write scope could not be verified' })
    } finally {
      timeouts.mockRestore()
    }
  })

  it('describes a file swapped for a directory right after it was looked at instead of failing to read it', async () => {
    let target = ''
    // Each look at the file finds a file, and it becomes a directory before it can be read.
    const swapAfter = (name: 'stat' | 'lstat') => {
      const real = fsPromises[name]
      return vi.spyOn(fsPromises, name).mockImplementation(async (path: PathLike, options?: unknown) => {
        if (path !== target) return await real(path, options as never)
        rmSync(target, { recursive: true, force: true })
        writeFileSync(target, 'a file again\n')
        const facts = await real(path, options as never)
        rmSync(target)
        mkdirSync(target)
        return facts
      })
    }
    const spies = [swapAfter('stat'), swapAfter('lstat')]
    syncBuiltinESMExports()
    try {
      const task = await run((cwd) => {
        writeFileSync(join(cwd, 'tracked.txt'), 'implemented\n')
        target = join(cwd, 'swapped.txt')
        writeFileSync(target, 'outside\n')
      })
      expect(task).toMatchObject({ state: 'failed', error: 'implementer wrote outside the approved scope: swapped.txt' })
    } finally {
      for (const spy of spies) spy.mockRestore()
      syncBuiltinESMExports()
    }
  })

  it('catches a link the implementer created on disk, even inside its scope', async () => {
    // A junction needs no privilege on Windows; elsewhere the type is ignored and a symbolic link is made.
    const target = mkdtempSync(join(tmpdir(), 'toranja-link-target-'))
    repos.push(target)
    writeFileSync(join(target, 'file.txt'), 'outside the project\n')
    const task = await run((cwd) => { symlinkSync(target, join(cwd, 'inside'), 'junction') }, ['inside', 'inside/file.txt'])
    expect(task).toMatchObject({ state: 'failed', error: 'implementer changed a link or submodule: inside' })
  })
})

/** Delegate a simple implementer, wait for it, and return its task id. */
async function implementDirect(harness: Harness, writeScope: string[]): Promise<string> {
  const result = await delegate(harness, { role: 'implementer', writeScope })
  await settled(harness)
  return (result.activations as { taskId: string }[])[0]?.taskId ?? ''
}

/** The classification `classify_project_task` predicts for a task writing `writeScope`. */
async function classify(harness: Harness, writeScope: string[]): Promise<Record<string, unknown>> {
  return JSON.parse(await harness.tool('classify_project_task').execute(
    { project: 'demo', task: 'add files', writeScope },
    { agent: {}, signal: new AbortController().signal },
  )) as Record<string, unknown>
}

describe('Toranja direct budget', () => {
  it('asks for a plan once simple tasks together wrote more files than the direct limit, until a delivery gate passes', async () => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
    const first = await implementDirect(harness, ['a.txt', 'b.txt'])
    expect(await classify(harness, ['c.txt', 'd.txt'])).toMatchObject({ level: 'moderate', path: 'investigate', reasons: ['direct budget of 3 files exceeded'] })
    await expect(delegate(harness, { role: 'implementer', writeScope: ['c.txt', 'd.txt'] }))
      .rejects.toThrow('implementer needs an approved plan for this task (moderate: direct budget of 3 files exceeded)')
    // The same files again do not spend the budget twice.
    const implementation = await implementDirect(harness, ['A.txt', 'b.txt'].map(path => process.platform === 'linux' ? path.toLowerCase() : path))
    expect(await runGate(harness, { implementationTaskId: first })).toMatchObject({ passed: true, budgetReset: false })
    expect(await runGate(harness, { implementationTaskId: implementation })).toMatchObject({ passed: true, budgetReset: true })
    await implementDirect(harness, ['c.txt', 'd.txt'])
  })

  it('keeps the budget when the passing gate names no implementer', async () => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
    await implementDirect(harness, ['a.txt', 'b.txt'])
    expect(await runGate(harness)).toMatchObject({ passed: true, budgetReset: false })
    expect(await classify(harness, ['c.txt', 'd.txt'])).toMatchObject({ level: 'moderate' })
  })

  it('keeps the budget when the named implementer started before the last reset', async () => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
    const first = await implementDirect(harness, ['a.txt'])
    expect(await runGate(harness, { implementationTaskId: first })).toMatchObject({ passed: true, budgetReset: true })
    await implementDirect(harness, ['b.txt', 'c.txt'])
    expect(await runGate(harness, { implementationTaskId: first })).toMatchObject({ passed: true, budgetReset: false })
    expect(await classify(harness, ['d.txt', 'e.txt'])).toMatchObject({ level: 'moderate' })
  })

  /** Mount with implementer worktrees, so implementers do not hold the project's tree. */
  const withWorktrees = async (): Promise<Harness> => {
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'toranja-worktrees-'))
    repos.push(worktreeRoot)
    return await mount({ routing: ROUTING, approvalPolicy: 'auto', implementerWorktrees: true, worktreeRoot })
  }

  it('resets only after a gate passed for every implementer started since the last reset', async () => {
    const harness = await withWorktrees()
    const spender = await implementDirect(harness, ['a.txt', 'b.txt'])
    const trivial = await implementDirect(harness, ['c.txt'])
    expect(await runGate(harness, { implementationTaskId: trivial })).toMatchObject({ passed: true, budgetReset: false })
    expect(await classify(harness, ['d.txt'])).toMatchObject({ level: 'moderate' })
    expect(await runGate(harness, { implementationTaskId: spender })).toMatchObject({ passed: true, budgetReset: true })
    expect(await classify(harness, ['d.txt'])).toMatchObject({ level: 'simple' })
  })

  it('keeps the budgets when an implementer starts while the gate runs', async () => {
    const harness = await withWorktrees()
    // Every role on one provider, so the hold below also reaches the gate's agents.
    await harness.setMode({ mode: 'codex' })
    await harness.update({ teamSize: 3 })
    const first = await implementDirect(harness, ['a.txt'])
    const release = Promise.withResolvers<undefined>()
    harness.hold = release.promise
    const gate = runGate(harness, { implementationTaskId: first })
    await expect.poll(() => harness.status().active).toBe(2)
    await delegate(harness, { role: 'implementer', writeScope: ['b.txt'] })
    release.resolve(undefined)
    expect(await gate).toMatchObject({ passed: true, budgetReset: false })
  })
})

describe('Toranja plan submission', () => {
  it('approves a simple plan by policy and lists it in the status', async () => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
    const result = await submit(harness)
    expect(result).toEqual({
      planId: expect.any(String) as unknown,
      state: 'approved',
      decidedBy: 'policy',
      level: 'simple',
      path: 'direct',
      reasons: [],
      writeScope: ['tracked.txt'],
    })
    expect(harness.status().plans).toEqual([expect.objectContaining({
      id: result.planId,
      project: 'demo',
      title: 'Fix the typo',
      state: 'approved',
      decidedBy: 'policy',
      evidenceTaskIds: [],
      createdAt: expect.any(String) as unknown,
    })])
  })

  it('refuses a plan without a heading and one for an unknown project', async () => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
    await expect(submit(harness, { plan: 'just do it' })).rejects.toThrow('starting with a # heading')
    await expect(submit(harness, { project: 'nowhere' })).rejects.toThrow('unknown Toranja project lane "nowhere"')
    expect(harness.status().plans).toEqual([])
  })

  it('rejects a moderate plan without investigation and approves it with a completed reader of the project', async () => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
    const writeScope = ['a.txt', 'b.txt', 'c.txt', 'd.txt']
    await expect(submit(harness, { writeScope })).rejects.toThrow('delegate a reader in this project first and pass its taskId')
    expect(harness.status().plans[0]).toMatchObject({ state: 'rejected', decidedBy: 'policy', level: 'moderate', error: expect.stringContaining('evidenceTaskIds') as unknown })
    const reader = await investigate(harness)
    expect(await submit(harness, { writeScope, evidenceTaskIds: [reader] })).toMatchObject({ state: 'approved', decidedBy: 'policy', level: 'moderate', path: 'investigate' })
    expect(harness.status().plans[0]).toMatchObject({ state: 'approved', evidenceTaskIds: [reader] })
  })

  it('takes as evidence only a completed reading task of the same project', async () => {
    const [demo, other] = [gitRepo(), gitRepo()]
    const harness = await mount({
      routing: ROUTING,
      approvalPolicy: 'auto',
      projects: [{ id: 'demo', title: 'Demo', path: demo }, { id: 'other', title: 'Other', path: other }],
    })
    const writeScope = ['a.txt', 'b.txt', 'c.txt', 'd.txt']
    const elsewhere = await investigate(harness, 'other')
    await delegate(harness, { role: 'implementer', writeScope: ['tracked.txt'] })
    const writer = (await settled(harness)).find(task => task.role === 'implementer')?.id ?? ''
    harness.agentSideEffect = (cwd) => { writeFileSync(join(cwd, 'proof.txt'), 'written by a reader') }
    const failed = await investigate(harness)
    expect(harness.status().tasks.find(task => task.id === failed)).toMatchObject({ state: 'failed' })
    for (const id of [elsewhere, writer, failed, 'toranja-missing']) {
      await expect(submit(harness, { writeScope, evidenceTaskIds: [id] })).rejects.toThrow(`evidence task ${id} is not a completed reading task of project demo`)
    }
    expect(harness.status().plans.map(plan => plan.state)).toEqual(['rejected', 'rejected', 'rejected', 'rejected'])
  })

  it('puts a complex plan to the user and approves it only with the approving option', async () => {
    const asker = questions(approving)
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' }, ['codex', 'antigravity'], new MemoryMediaPool(), asker.service)
    const reader = await investigate(harness)
    const plan = '# Rotate the token\n\nReplace the token.'
    const writeScope = ['tracked.txt', 'docs/token.md', 'src/']
    const result = await submit(harness, { plan, writeScope, evidenceTaskIds: [reader] })
    expect(result).toMatchObject({ state: 'approved', decidedBy: 'user', level: 'complex', path: 'approve' })
    expect(asker.asked).toHaveLength(1)
    const [question] = asker.asked[0]?.questions ?? []
    expect(question).toMatchObject({
      header: 'Aprovação do plano',
      question: 'Aprovar este plano complexo que escreve em 1 diretório inteiro e 2 arquivos no projeto Demo?',
      intent: { kind: 'plan-review', callId: 'call-plan' },
    })
    // The decision comes first, so a long plan cannot push it out of view; the plan follows it.
    const detail = question?.detail ?? ''
    const planAt = detail.indexOf(plan)
    expect(planAt).toBeGreaterThan(0)
    for (const fact of ['Nível: complex', 'risk term "token"', 'directory scope src/ needs approval', 'docs/token.md, src/, tracked.txt', reader]) {
      expect(detail.indexOf(fact), fact).toBeGreaterThanOrEqual(0)
      expect(detail.indexOf(fact), fact).toBeLessThan(planAt)
    }
    expect(question?.options.map(option => option.label)).toContain(question?.intent?.approve)
  })

  it.each([
    [['./', 'tracked.txt'], 'Aprovar este plano complexo que escreve no projeto Demo inteiro?'],
    [['docs/', 'src/'], 'Aprovar este plano complexo que escreve em 2 diretórios inteiros no projeto Demo?'],
    [['tracked.txt'], 'Aprovar este plano complexo que escreve em 1 arquivo no projeto Demo?'],
  ])('names what a scope of %j writes in the question', async (writeScope, text) => {
    const asker = questions(approving)
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' }, ['codex', 'antigravity'], new MemoryMediaPool(), asker.service)
    await submit(harness, { writeScope, level: 'complex', evidenceTaskIds: [await investigate(harness)] })
    expect(asker.asked[0]?.questions[0]?.question).toBe(text)
  })

  it.each([
    ['another option', (request: Ask) => ({ answers: [{ id: request.questions[0]?.id, selected: ['Revisar o plano'] }] }), 'the user did not approve the plan'],
    ['the approving option with words of their own', (request: Ask) => ({ answers: [{ id: request.questions[0]?.id, selected: [request.questions[0]?.intent?.approve], custom: 'only after the backup' }] }), 'the user did not approve the plan; their feedback: only after the backup'],
    ['an answer to another question', () => ({ answers: [{ id: 'other', selected: ['Aprovar e executar'] }] }), 'the user did not approve the plan'],
  ])('rejects a complex plan when the user answers with %s', async (_name, reply, message) => {
    const asker = questions(reply)
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' }, ['codex', 'antigravity'], new MemoryMediaPool(), asker.service)
    const reader = await investigate(harness)
    await expect(submit(harness, { level: 'complex', evidenceTaskIds: [reader] })).rejects.toThrow(message)
    expect(harness.status().plans[0]).toMatchObject({ state: 'rejected', decidedBy: 'user' })
  })

  it.each([
    ['the user dismisses the review', () => { throw new UserQuestionError('cancelled', 'ASK_CANCELLED') }, 'the user dismissed the plan review'],
    ['no answerer is connected', () => { throw new UserQuestionError('no answerer', 'NO_PROVIDER') }, 'the plan could not be put to the user (NO_PROVIDER)'],
    ['the question fails', () => { throw new Error('the window closed') }, 'the plan could not be put to the user (the window closed)'],
  ])('rejects a complex plan when %s', async (_name, reply, message) => {
    const asker = questions(reply)
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' }, ['codex', 'antigravity'], new MemoryMediaPool(), asker.service)
    const reader = await investigate(harness)
    await expect(submit(harness, { level: 'complex', evidenceTaskIds: [reader] })).rejects.toThrow(message)
    expect(harness.status().plans[0]).toMatchObject({ state: 'rejected', error: expect.stringContaining(message) as unknown })
  })

  it('rejects a complex plan when no user-questions channel is available', async () => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
    const reader = await investigate(harness)
    await expect(submit(harness, { level: 'complex', evidenceTaskIds: [reader] })).rejects.toThrow('no user-questions channel is available to approve the plan')
    expect(harness.status().plans[0]).toMatchObject({ state: 'rejected', decidedBy: 'policy' })
  })

  it('passes on the abort of the turn without deciding the plan', async () => {
    const turn = new AbortController()
    const asker = questions(() => {
      turn.abort()
      throw new UserQuestionError('aborted', 'ASK_ABORTED')
    })
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'always' }, ['codex', 'antigravity'], new MemoryMediaPool(), asker.service)
    await expect(submit(harness, {}, turn.signal)).rejects.toThrow('aborted')
    expect(harness.status().plans).toEqual([])
  })

  it('puts even a simple plan to the user when the policy is always', async () => {
    const asker = questions(approving)
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'always' }, ['codex', 'antigravity'], new MemoryMediaPool(), asker.service)
    expect(await submit(harness)).toMatchObject({ state: 'approved', decidedBy: 'user', level: 'simple' })
    expect(asker.asked).toHaveLength(1)
  })

  it('puts a moderate plan to the user once plans the policy approved would pass the investigated limit', async () => {
    const asker = questions(approving)
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' }, ['codex', 'antigravity'], new MemoryMediaPool(), asker.service)
    const six = (prefix: string) => Array.from({ length: 6 }, (_, index) => `${prefix}${index}.txt`)
    expect(await submit(harness, { writeScope: six('a'), evidenceTaskIds: [await investigate(harness)] }))
      .toMatchObject({ state: 'approved', decidedBy: 'policy', level: 'moderate' })
    expect(await submit(harness, { writeScope: six('b'), evidenceTaskIds: [await investigate(harness)] })).toMatchObject({
      state: 'approved',
      decidedBy: 'user',
      level: 'complex',
      reasons: expect.arrayContaining(['investigated budget of 10 files exceeded']) as unknown,
    })
    expect(asker.asked).toHaveLength(1)
    // A plan the user approved spends nothing: four more files still fit beside the first six.
    expect(await submit(harness, { writeScope: six('c').slice(0, 4), evidenceTaskIds: [await investigate(harness)] }))
      .toMatchObject({ state: 'approved', decidedBy: 'policy', level: 'moderate' })
  })

  it('spends the direct budget on simple plans the policy approves', async () => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
    expect(await submit(harness, { writeScope: ['a.txt', 'b.txt'] })).toMatchObject({ state: 'approved', level: 'simple' })
    await expect(submit(harness, { writeScope: ['c.txt', 'd.txt'] })).rejects.toThrow('a moderate plan needs investigation')
    expect(harness.status().plans[0]).toMatchObject({ state: 'rejected', level: 'moderate', reasons: ['direct budget of 3 files exceeded'] })
  })

  it('takes each investigation as evidence for one plan only', async () => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
    const writeScope = ['a.txt', 'b.txt', 'c.txt', 'd.txt']
    const reader = await investigate(harness)
    const { planId } = await submit(harness, { writeScope, evidenceTaskIds: [reader] })
    await expect(submit(harness, { writeScope, evidenceTaskIds: [reader] }))
      .rejects.toThrow(`evidence task ${reader} already supports plan ${String(planId)}`)
    expect(harness.status().plans[0]).toMatchObject({ state: 'rejected' })
  })

  it('forgets which plan an investigation backs once the investigation left the task history', async () => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
    const writeScope = ['a.txt', 'b.txt', 'c.txt', 'd.txt']
    const reader = await investigate(harness)
    await submit(harness, { writeScope, evidenceTaskIds: [reader] })
    for (let index = 0; index < 24; index++) await investigate(harness)
    await expect(submit(harness, { writeScope, evidenceTaskIds: [reader] }))
      .rejects.toThrow(`evidence task ${reader} is not a completed reading task of project demo`)
  }, 30_000)

  it('keeps a bounded list of plans without dropping an approved one', async () => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
    const { planId } = await submit(harness)
    for (let index = 0; index < 30; index++) {
      await expect(submit(harness, { writeScope: ['a.txt', 'b.txt', 'c.txt', 'd.txt'] })).rejects.toThrow('needs investigation')
    }
    const { plans } = harness.status()
    expect(plans).toHaveLength(24)
    expect(plans.at(-1)).toMatchObject({ id: planId, state: 'approved' })
  })
})

describe('Toranja implementer under an approved plan', () => {
  /** Mount with a user who approves every plan, and a completed reader to offer as evidence. */
  const approvedBy = async (config: Record<string, unknown> = {}) => {
    const asker = questions(approving)
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto', ...config }, ['codex', 'antigravity'], new MemoryMediaPool(), asker.service)
    const reader = await investigate(harness)
    return { harness, asker, reader }
  }

  it('runs the implementer under an approved plan, inside a directory of its scope', async () => {
    const { harness, reader } = await approvedBy()
    const { planId } = await submit(harness, { writeScope: ['src/'], evidenceTaskIds: [reader] })
    harness.agentSideEffect = (cwd) => {
      mkdirSync(join(cwd, 'src', 'app'), { recursive: true })
      writeFileSync(join(cwd, 'src', 'app', 'new.ts'), 'export {}\n')
    }
    const result = await delegate(harness, { role: 'implementer', writeScope: ['src/app/'], planId })
    expect(result.activations).toHaveLength(1)
    const tasks = await settled(harness)
    expect(tasks.find(task => task.role === 'implementer')).toMatchObject({ state: 'completed', planId, writeScope: ['src/app/'] })
  })

  it('refuses a plan that does not exist, was rejected, or belongs to another project', async () => {
    const [demo, other] = [gitRepo(), gitRepo()]
    const asker = questions(request => ({ answers: [{ id: request.questions[0]?.id, selected: ['Revisar o plano'] }] }))
    const harness = await mount({
      routing: ROUTING,
      approvalPolicy: 'auto',
      projects: [{ id: 'demo', title: 'Demo', path: demo }, { id: 'other', title: 'Other', path: other }],
    }, ['codex', 'antigravity'], new MemoryMediaPool(), asker.service)
    const reader = await investigate(harness)
    await expect(submit(harness, { level: 'complex', evidenceTaskIds: [reader] })).rejects.toThrow('the user did not approve the plan')
    const rejected = harness.status().plans[0]?.id
    const { planId: elsewhere } = await submit(harness, { project: 'other' })
    await expect(delegate(harness, { role: 'implementer', writeScope: ['tracked.txt'], planId: 'no-such-plan' })).rejects.toThrow('plan "no-such-plan" does not exist')
    await expect(delegate(harness, { role: 'implementer', writeScope: ['tracked.txt'], planId: rejected })).rejects.toThrow(`plan ${rejected} was not approved: the user did not approve the plan`)
    await expect(delegate(harness, { role: 'implementer', writeScope: ['tracked.txt'], planId: elsewhere })).rejects.toThrow(`plan ${String(elsewhere)} belongs to project other, not demo`)
    expect(harness.status().tasks.filter(task => task.role === 'implementer')).toEqual([])
  })

  it('refuses a scope wider than the plan and a task above the plan level', async () => {
    const { harness, reader } = await approvedBy()
    const { planId } = await submit(harness, { writeScope: ['a.txt', 'b.txt', 'c.txt', 'd.txt'], evidenceTaskIds: [reader] })
    await expect(delegate(harness, { role: 'implementer', writeScope: ['a.txt', 'e.txt'], planId })).rejects.toThrow('goes beyond plan')
    await expect(delegate(harness, { role: 'implementer', task: 'rotate the token', writeScope: ['a.txt'], planId }))
      .rejects.toThrow(`the task is complex: risk term "token", above plan ${String(planId)} approved as moderate`)
    expect(harness.started.filter(name => name.includes('~rw~'))).toEqual([])
  })

  it('refuses a plan approved before the policy changed', async () => {
    const { harness } = await approvedBy()
    const { planId } = await submit(harness)
    await harness.update({ approvalPolicy: 'always' })
    await expect(delegate(harness, { role: 'implementer', writeScope: ['tracked.txt'], planId })).rejects.toThrow('was approved under other rules; submit it again')
  })

  it('closes the approved plans of a project when its delivery gate passes for an implementer of the project', async () => {
    const { harness, reader } = await approvedBy()
    const { planId } = await submit(harness, { level: 'complex', evidenceTaskIds: [reader] })
    const result = await delegate(harness, { role: 'implementer', writeScope: ['tracked.txt'], planId })
    await settled(harness)
    expect(await runGate(harness)).toMatchObject({ passed: true, budgetReset: false })
    expect(harness.status().plans[0]).toMatchObject({ id: planId, state: 'approved' })
    const implementationTaskId = (result.activations as { taskId: string }[])[0]?.taskId
    expect(await runGate(harness, { implementationTaskId })).toMatchObject({ passed: true, budgetReset: true })
    expect(harness.status().plans[0]).toMatchObject({ id: planId, state: 'closed', decidedAt: expect.any(String) as unknown })
    await expect(delegate(harness, { role: 'implementer', writeScope: ['tracked.txt'], planId })).rejects.toThrow('was closed by a delivery gate that passed')
  })

  it('keeps the plans open when the delivery gate does not pass', async () => {
    const { harness, reader } = await approvedBy({ replanOnGateFailure: false })
    const { planId } = await submit(harness, { level: 'complex', evidenceTaskIds: [reader] })
    harness.answer = 'TORANJA_GATE: FAIL\nmissing tests'
    expect(await runGate(harness)).toMatchObject({ passed: false })
    expect(harness.status().plans[0]).toMatchObject({ id: planId, state: 'approved' })
  })
})

describe('Toranja write-scope check in an implementer worktree', () => {
  const isolated = async (config: Record<string, unknown> = {}) => {
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'toranja-worktrees-'))
    repos.push(worktreeRoot)
    return await mount({ routing: ROUTING, approvalPolicy: 'auto', implementerWorktrees: true, worktreeRoot, ...config })
  }
  const implementIn = async (
    harness: Harness,
    sideEffect: (cwd: string) => void,
  ): Promise<{ task: Record<string, unknown>; worktree: string }> => {
    harness.agentSideEffect = sideEffect
    const result = await delegate(harness, { role: 'implementer', provider: 'codex', writeScope: ['tracked.txt'] })
    const [run] = result.activations as { worktree: string }[]
    return { task: await outcome(harness), worktree: run?.worktree ?? '' }
  }

  it('accepts a change inside the scope and keeps the worktree for review', async () => {
    const harness = await isolated()
    const { task, worktree } = await implementIn(harness, (cwd) => { writeFileSync(join(cwd, 'tracked.txt'), 'implemented\n') })
    expect(task).toMatchObject({ state: 'completed', worktree })
  })

  it('accepts a commit inside the scope on the worktree\'s own branch', async () => {
    const harness = await isolated()
    const { task } = await implementIn(harness, (cwd) => {
      writeFileSync(join(cwd, 'tracked.txt'), 'implemented\n')
      git(cwd, 'commit', '-qam', 'inside')
    })
    expect(task).toMatchObject({ state: 'completed' })
  })

  it('fails an implementer that moved another branch from its worktree', async () => {
    const harness = await isolated()
    const main = git(harness.repo, 'symbolic-ref', '--short', 'HEAD')
    const { task } = await implementIn(harness, (cwd) => {
      writeFileSync(join(cwd, 'tracked.txt'), 'implemented\n')
      git(cwd, 'commit', '-qam', 'inside')
      git(cwd, 'update-ref', `refs/heads/${main}`, 'HEAD')
    })
    expect(task).toMatchObject({ state: 'failed', error: `implementer changed other branches or refs: refs/heads/${main}` })
  })

  it('fails an implementer that moved the branch of a lane kept from an earlier task', async () => {
    const harness = await isolated()
    const { task: first } = await implementIn(harness, (cwd) => {
      writeFileSync(join(cwd, 'tracked.txt'), 'implemented\n')
      git(cwd, 'commit', '-qam', 'inside')
    })
    const kept = `refs/heads/${String(first.branch)}`
    const { task } = await implementIn(harness, (cwd) => { git(cwd, 'update-ref', kept, 'HEAD') })
    expect(task).toMatchObject({ state: 'failed', error: `implementer changed other branches or refs: ${kept}` })
  })

  it('fails an implementer that changed the configuration of its own worktree', async () => {
    const harness = await isolated()
    const { task } = await implementIn(harness, (cwd) => {
      writeFileSync(join(git(cwd, 'rev-parse', '--absolute-git-dir'), 'config.worktree'), '[core]\n\tfsmonitor = x\n')
    })
    expect(task).toMatchObject({ state: 'failed' })
    expect(task.error).toMatch(/^implementer changed Git configuration or hooks: worktrees\/[^/]+\/config\.worktree$/u)
  })

  it.each([
    ['rewrote', (cwd: string, elsewhere: string) => {
      // Git for Windows hides the entry, and a hidden file cannot be opened for overwriting.
      rmSync(join(cwd, '.git'))
      writeFileSync(join(cwd, '.git'), `gitdir: ${join(elsewhere, '.git')}\n`)
    }],
    ['replaced with a directory', (cwd: string) => {
      rmSync(join(cwd, '.git'))
      mkdirSync(join(cwd, '.git'))
    }],
  ])('fails an implementer that %s the .git entry of its worktree', async (_name, sideEffect) => {
    const harness = await isolated()
    const elsewhere = gitRepo()
    const { task } = await implementIn(harness, (cwd) => {
      writeFileSync(join(cwd, 'tracked.txt'), 'implemented\n')
      sideEffect(cwd, elsewhere)
    })
    expect(task).toMatchObject({ state: 'failed', error: 'implementer changed the Git directory' })
  })

  it.each([
    ['a new file', (cwd: string) => { writeFileSync(join(cwd, 'other.txt'), 'outside\n') }],
    ['a commit', (cwd: string) => {
      writeFileSync(join(cwd, 'other.txt'), 'outside\n')
      git(cwd, 'add', 'other.txt')
      git(cwd, 'commit', '-q', '-m', 'outside')
    }],
    ['a commit left on the branch after stepping back', (cwd: string) => {
      writeFileSync(join(cwd, 'other.txt'), 'outside\n')
      git(cwd, 'add', 'other.txt')
      git(cwd, 'commit', '-q', '-m', 'outside')
      git(cwd, 'checkout', '-q', '--detach', 'HEAD~1')
    }],
  ])('fails %s outside the scope and keeps the worktree', async (_name, sideEffect) => {
    const harness = await isolated()
    const { task, worktree } = await implementIn(harness, sideEffect)
    expect(task).toMatchObject({ state: 'failed', error: 'implementer wrote outside the approved scope: other.txt', worktree })
    expect(existsSync(worktree)).toBe(true)
  })

  it('runs implementers side by side only in worktrees of their own', async () => {
    const harness = await isolated({ allowParallelImplementation: true })
    await harness.update({ teamSize: 3 })
    const result = await delegate(harness, { role: 'implementer', provider: 'both', writeScope: ['tracked.txt'] })
    expect(result.activations).toHaveLength(2)
    expect((await settled(harness)).map(task => task.state)).toEqual(['completed', 'completed'])
  })

  it('does not blame one implementer for the commits another one made on its own branch meanwhile', async () => {
    const harness = await isolated({ allowParallelImplementation: true })
    await harness.update({ teamSize: 3 })
    const release = Promise.withResolvers<undefined>()
    harness.hold = release.promise
    harness.agentSideEffect = (cwd) => {
      writeFileSync(join(cwd, 'tracked.txt'), `implemented in ${cwd}\n`)
      git(cwd, 'commit', '-qam', 'inside')
    }
    // Each run commits as it starts, while the other is already running and is held until both started.
    const result = await delegate(harness, { role: 'implementer', provider: 'both', writeScope: ['tracked.txt'] })
    expect(result.activations).toHaveLength(2)
    release.resolve(undefined)
    expect((await settled(harness)).map(task => task.state)).toEqual(['completed', 'completed'])
  })

  describe('while a lane ends during another implementer\'s run', () => {
    interface Lane { readonly taskId: string; readonly worktree: string; readonly branch: string }
    /** Hold a Codex implementer, then start `others` Antigravity implementers that each commit inside the scope. */
    const alongside = async (others: number) => {
      const harness = await isolated()
      await harness.update({ teamSize: others + 1 })
      const release = Promise.withResolvers<undefined>()
      harness.hold = release.promise
      const held = (await delegate(harness, { role: 'implementer', provider: 'codex', writeScope: ['tracked.txt'] })).activations as Lane[]
      harness.agentSideEffect = (cwd) => {
        writeFileSync(join(cwd, 'tracked.txt'), `implemented in ${cwd}\n`)
        git(cwd, 'commit', '-qam', 'inside')
      }
      const ended: Lane[] = []
      for (let index = 0; index < others; index++) {
        const [lane] = (await delegate(harness, { role: 'implementer', provider: 'antigravity', writeScope: ['tracked.txt'] })).activations as Lane[]
        if (lane === undefined) throw new Error('no lane started')
        await expect.poll(() => harness.status().tasks.find(task => task.id === lane.taskId)?.state).toBe('completed')
        ended.push(lane)
      }
      const outcomeOfHeld = async () => {
        release.resolve(undefined)
        return (await settled(harness)).find(task => task.id === held[0]?.taskId)
      }
      return { harness, ended, outcomeOfHeld }
    }
    /** Move a lane's branch to a commit that adds a protected file, as the held implementer could. */
    const moveOutside = (worktree: string): void => {
      mkdirSync(join(worktree, '.github'))
      writeFileSync(join(worktree, '.github', 'x'), 'outside\n')
      git(worktree, 'add', '.github/x')
      git(worktree, 'commit', '-qm', 'outside')
    }
    /** Move a lane's branch to a commit that adds a protected file, leaving its worktree and index alone, as any implementer could. */
    const moveBranchOutside = (repo: string, branch: string): void => {
      const env = { ...process.env, GIT_INDEX_FILE: join(repo, '.git', 'outside-index') }
      const run = (...args: string[]): string =>
        execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], { cwd: repo, env, input: 'outside\n' }).toString().trim()
      const tip = run('rev-parse', `refs/heads/${branch}`)
      run('read-tree', tip)
      run('update-index', '--add', '--cacheinfo', `100644,${run('hash-object', '-w', '--stdin')},.github/x`)
      run('update-ref', `refs/heads/${branch}`, run('commit-tree', run('write-tree'), '-p', tip, '-m', 'outside'))
    }

    /** A Git hook that calls `then` once the refs of a worktree's run were read the second time, after the run. */
    const afterSecondListing = (worktree: () => string | undefined, then: () => void) => {
      const listed = new Map<string, number>()
      return (args: readonly string[]): undefined => {
        const tree = args.find(arg => arg.startsWith('--work-tree='))
        if (!args.includes('for-each-ref') || tree === undefined) return undefined
        listed.set(tree, (listed.get(tree) ?? 0) + 1)
        if (tree === `--work-tree=${worktree() ?? ''}` && listed.get(tree) === 2) then()
        return undefined
      }
    }

    it('fails the implementer that moved the branch of a lane after that lane ended', async () => {
      const { ended: [lane], outcomeOfHeld } = await alongside(1)
      if (lane === undefined) throw new Error('no lane ended')
      moveOutside(lane.worktree)
      expect(await outcomeOfHeld()).toMatchObject({ state: 'failed', error: `implementer changed other branches or refs: refs/heads/${lane.branch}` })
    })

    it('does not blame it for the commits lanes made on their own branches before they ended, however many end meanwhile', async () => {
      const { ended, outcomeOfHeld } = await alongside(2)
      expect(ended).toHaveLength(2)
      expect(await outcomeOfHeld()).toMatchObject({ state: 'completed' })
    })

    it('does not blame it for the branch the Host removed with a lane that left nothing behind', async () => {
      const harness = await isolated()
      await harness.update({ teamSize: 2 })
      const release = Promise.withResolvers<undefined>()
      harness.hold = release.promise
      // Both worktrees exist before either run starts, so the held run sees the other lane's branch at its start.
      const lanes = (await delegate(harness, { role: 'implementer', provider: 'both', writeScope: ['tracked.txt'] })).activations as (Lane & { provider: string })[]
      const other = lanes.find(lane => lane.provider === 'antigravity')
      await expect.poll(() => harness.status().tasks.find(task => task.id === other?.taskId)?.state).toBe('completed')
      expect(git(harness.repo, 'branch', '--list', other?.branch ?? '')).toBe('')
      release.resolve(undefined)
      expect((await settled(harness)).map(task => task.state)).toEqual(['completed', 'completed'])
    })

    it('fails the implementer that moved the branch of a lane already checked but not yet released', async () => {
      const harness = await isolated()
      await harness.update({ teamSize: 2 })
      const release = Promise.withResolvers<undefined>()
      harness.hold = release.promise
      const [held] = (await delegate(harness, { role: 'implementer', provider: 'codex', writeScope: ['tracked.txt'] })).activations as Lane[]
      harness.agentSideEffect = (cwd) => {
        writeFileSync(join(cwd, 'tracked.txt'), 'implemented\n')
        git(cwd, 'commit', '-qam', 'inside')
      }
      // The release of the other lane, which inspects its worktree after its check, waits until the held run is settled.
      const reached = Promise.withResolvers<undefined>()
      const settledHeld = Promise.withResolvers<undefined>()
      harness.gitGate = (args) => {
        if (!args.includes('status') || args.some(arg => arg.includes(held?.worktree ?? '\0'))) return undefined
        reached.resolve(undefined)
        return settledHeld.promise
      }
      const [lane] = (await delegate(harness, { role: 'implementer', provider: 'antigravity', writeScope: ['tracked.txt'] })).activations as Lane[]
      if (lane === undefined) throw new Error('no lane started')
      await reached.promise
      moveOutside(lane.worktree)
      release.resolve(undefined)
      await expect.poll(() => harness.status().tasks.find(task => task.id === held?.taskId)?.state).not.toBe('active')
      settledHeld.resolve(undefined)
      expect((await settled(harness)).find(task => task.id === held?.taskId))
        .toMatchObject({ state: 'failed', error: `implementer changed other branches or refs: refs/heads/${lane.branch}` })
    })

    it('fails the implementer that moved the branch of a lane the Host was releasing without its check', async () => {
      const harness = await isolated()
      await harness.update({ teamSize: 2 })
      const release = Promise.withResolvers<undefined>()
      harness.hold = release.promise
      const [held] = (await delegate(harness, { role: 'implementer', provider: 'codex', writeScope: ['tracked.txt'] })).activations as Lane[]
      // The other implementer never starts, so its lane is released unchecked; its branch moves as the Host unlocks the worktree.
      let moved: string | undefined
      harness.gitGate = (args) => {
        const path = args.includes('unlock') ? args.at(-1) : undefined
        if (path === undefined || path === held?.worktree || moved !== undefined) return undefined
        moved = `toranja/${basename(path)}`
        moveOutside(path)
        return undefined
      }
      harness.offline.set('antigravity', 'quota exhausted')
      await expect(delegate(harness, { role: 'implementer', provider: 'antigravity', writeScope: ['tracked.txt'] }))
        .rejects.toThrow('no project agent started')
      expect(moved).toBeDefined()
      release.resolve(undefined)
      expect((await settled(harness)).find(task => task.id === held?.taskId))
        .toMatchObject({ state: 'failed', error: `implementer changed other branches or refs: refs/heads/${moved}` })
    })

    it('keeps a lane whose branch moved after the Host read it to release the lane', async () => {
      const harness = await isolated()
      const base = git(harness.repo, 'rev-parse', 'HEAD')
      // A commit that changes nothing, so once its branch is moved back the worktree looks untouched.
      harness.agentSideEffect = (cwd) => { git(cwd, 'commit', '-q', '--allow-empty', '-m', 'empty') }
      let moved = false
      harness.gitAfter = (args) => {
        const ref = args.at(-1) ?? ''
        if (moved || !args.includes('-q') || !args.includes('rev-parse') || !ref.startsWith('refs/heads/toranja/')) return undefined
        moved = true
        git(harness.repo, 'update-ref', ref, base)
        return undefined
      }
      const [lane] = (await delegate(harness, { role: 'implementer', provider: 'codex', writeScope: ['tracked.txt'] })).activations as Lane[]
      await settled(harness)
      expect(moved).toBe(true)
      expect(git(harness.repo, 'branch', '--list', lane?.branch ?? '')).not.toBe('')
    })

    it('keeps a lane another implementer put back where it started after the lane\'s own check, and fails that implementer', async () => {
      const harness = await isolated()
      await harness.update({ teamSize: 2 })
      const release = Promise.withResolvers<undefined>()
      harness.hold = release.promise
      const [held] = (await delegate(harness, { role: 'implementer', provider: 'codex', writeScope: ['tracked.txt'] })).activations as Lane[]
      const base = git(harness.repo, 'rev-parse', 'HEAD')
      let worktree = ''
      harness.agentSideEffect = (cwd) => {
        worktree = cwd
        writeFileSync(join(cwd, 'tracked.txt'), 'implemented\n')
        git(cwd, 'commit', '-qam', 'inside')
      }
      // Right before the Host reads the branch to release the lane, the held implementer resets its branch and worktree to the start.
      let reset = false
      harness.gitGate = (args) => {
        if (reset || !args.includes('-q') || !args.includes('rev-parse') || !(args.at(-1) ?? '').startsWith('refs/heads/toranja/')) return undefined
        reset = true
        git(worktree, 'reset', '-q', '--hard', base)
        return undefined
      }
      const [lane] = (await delegate(harness, { role: 'implementer', provider: 'antigravity', writeScope: ['tracked.txt'] })).activations as Lane[]
      await expect.poll(() => harness.status().tasks.find(task => task.id === lane?.taskId)?.state).toBe('completed')
      expect(reset).toBe(true)
      expect(git(harness.repo, 'branch', '--list', lane?.branch ?? '')).not.toBe('')
      release.resolve(undefined)
      expect((await settled(harness)).find(task => task.id === held?.taskId))
        .toMatchObject({ state: 'failed', error: `implementer changed other branches or refs: refs/heads/${lane?.branch ?? ''}` })
    })

    it('fails the owner whose branch another implementer moved while the owner\'s check was reading it', async () => {
      const harness = await isolated()
      await harness.update({ teamSize: 2 })
      const release = Promise.withResolvers<undefined>()
      harness.hold = release.promise
      const [held] = (await delegate(harness, { role: 'implementer', provider: 'codex', writeScope: ['tracked.txt'] })).activations as Lane[]
      harness.agentSideEffect = (cwd) => {
        writeFileSync(join(cwd, 'tracked.txt'), 'implemented\n')
        git(cwd, 'commit', '-qam', 'inside')
      }
      // The owner's check holds right after its second reading of the refs, while the held implementer moves the branch and is checked.
      const listed = new Map<string, number>()
      const reached = Promise.withResolvers<undefined>()
      const resume = Promise.withResolvers<undefined>()
      harness.gitAfter = (args) => {
        const tree = args.find(arg => arg.startsWith('--work-tree='))
        if (!args.includes('for-each-ref') || tree === undefined || tree === `--work-tree=${held?.worktree ?? ''}`) return undefined
        listed.set(tree, (listed.get(tree) ?? 0) + 1)
        if (listed.get(tree) !== 2) return undefined
        reached.resolve(undefined)
        return resume.promise
      }
      const [lane] = (await delegate(harness, { role: 'implementer', provider: 'antigravity', writeScope: ['tracked.txt'] })).activations as Lane[]
      if (lane === undefined) throw new Error('no lane started')
      await reached.promise
      moveBranchOutside(harness.repo, lane.branch)
      release.resolve(undefined)
      await expect.poll(() => harness.status().tasks.find(task => task.id === held?.taskId)?.state).not.toBe('active')
      resume.resolve(undefined)
      expect((await settled(harness)).find(task => task.id === lane.taskId))
        .toMatchObject({ state: 'failed', error: 'implementer branch changed while it was being checked' })
    })

    it('fails the owner whose branch moved between the reading of its tip and the reading of the refs', async () => {
      const harness = await isolated()
      let branch: string | undefined
      harness.agentSideEffect = (cwd) => {
        branch = git(cwd, 'branch', '--show-current')
        writeFileSync(join(cwd, 'tracked.txt'), 'implemented\n')
        git(cwd, 'commit', '-qam', 'inside')
      }
      // The second listing of the refs waits until the commits of the second reading were read, and the branch moves first.
      let verified = 0
      let listed = 0
      const commitsRead = Promise.withResolvers<undefined>()
      const inLane = (args: readonly string[]): boolean => args.some(arg => arg.startsWith('--work-tree='))
      harness.gitAfter = (args) => {
        if (inLane(args) && args.includes('rev-parse') && args.includes('--verify') && ++verified === 4) commitsRead.resolve(undefined)
        return undefined
      }
      harness.gitGate = args => inLane(args) && args.includes('for-each-ref') && ++listed === 2
        ? commitsRead.promise.then(() => { moveBranchOutside(harness.repo, branch ?? '') })
        : undefined
      const [lane] = (await delegate(harness, { role: 'implementer', provider: 'codex', writeScope: ['tracked.txt'] })).activations as Lane[]
      expect((await settled(harness)).find(task => task.id === lane?.taskId))
        .toMatchObject({ state: 'failed', error: 'implementer branch changed while it was being checked' })
    })

    it('does not blame a run that began after a lane ended for the branch the Host then removed with it', async () => {
      const harness = await isolated()
      await harness.update({ teamSize: 2 })
      // The release of the untouched lane, which inspects its worktree after its check, waits until the other run has started.
      const reached = Promise.withResolvers<undefined>()
      const resume = Promise.withResolvers<undefined>()
      harness.gitGate = (args) => {
        if (!args.includes('status')) return undefined
        reached.resolve(undefined)
        return resume.promise
      }
      const [lane] = (await delegate(harness, { role: 'implementer', provider: 'antigravity', writeScope: ['tracked.txt'] })).activations as Lane[]
      await reached.promise
      harness.gitGate = undefined
      const release = Promise.withResolvers<undefined>()
      harness.hold = release.promise
      await delegate(harness, { role: 'implementer', provider: 'codex', writeScope: ['tracked.txt'] })
      resume.resolve(undefined)
      await expect.poll(() => git(harness.repo, 'branch', '--list', lane?.branch ?? '')).toBe('')
      release.resolve(undefined)
      expect((await settled(harness)).map(task => task.state)).toEqual(['completed', 'completed'])
    })

    it('does not blame a run whose check ends while the Host is deleting the branch of an untouched lane', async () => {
      const harness = await isolated()
      await harness.update({ teamSize: 2 })
      const release = Promise.withResolvers<undefined>()
      harness.hold = release.promise
      // Both worktrees exist before either run starts, so the held run sees the other lane's branch at its start.
      // The other lane's deletion has happened, but the Host does not hear back from it until the held run's refs were read again.
      const deleted = Promise.withResolvers<undefined>()
      const resume = Promise.withResolvers<undefined>()
      const found: { held?: Lane | undefined } = {}
      const listing = afterSecondListing(() => found.held?.worktree, () => { resume.resolve(undefined) })
      let holding = false
      harness.gitAfter = (args) => {
        listing(args)
        if (holding || !args.includes('update-ref') || !args.includes('-d')) return undefined
        holding = true
        deleted.resolve(undefined)
        return resume.promise
      }
      const lanes = (await delegate(harness, { role: 'implementer', provider: 'both', writeScope: ['tracked.txt'] })).activations as (Lane & { provider: string })[]
      found.held = lanes.find(lane => lane.provider === 'codex')
      await deleted.promise
      release.resolve(undefined)
      expect((await settled(harness)).map(task => task.state)).toEqual(['completed', 'completed'])
    })

    it('does not blame a run that begins while the Host is deleting the branch of an untouched lane', async () => {
      const harness = await isolated()
      await harness.update({ teamSize: 2 })
      const reached = Promise.withResolvers<undefined>()
      const resume = Promise.withResolvers<undefined>()
      harness.gitGate = (args) => {
        if (!args.includes('update-ref') || !args.includes('-d')) return undefined
        reached.resolve(undefined)
        return resume.promise
      }
      const [lane] = (await delegate(harness, { role: 'implementer', provider: 'antigravity', writeScope: ['tracked.txt'] })).activations as Lane[]
      await reached.promise
      harness.gitGate = undefined
      const release = Promise.withResolvers<undefined>()
      harness.hold = release.promise
      await delegate(harness, { role: 'implementer', provider: 'codex', writeScope: ['tracked.txt'] })
      resume.resolve(undefined)
      await expect.poll(() => git(harness.repo, 'branch', '--list', lane?.branch ?? '')).toBe('')
      release.resolve(undefined)
      expect((await settled(harness)).map(task => task.state)).toEqual(['completed', 'completed'])
    })

    it('fails the implementer that deleted the branch of an untouched lane after that lane ended', async () => {
      const harness = await isolated()
      await harness.update({ teamSize: 2 })
      const release = Promise.withResolvers<undefined>()
      harness.hold = release.promise
      // The release of the untouched lane waits, so its branch is deleted by the held implementer, not by the Host.
      const reached = Promise.withResolvers<undefined>()
      const resume = Promise.withResolvers<undefined>()
      harness.gitGate = (args) => {
        if (!args.includes('status')) return undefined
        reached.resolve(undefined)
        return resume.promise
      }
      const lanes = (await delegate(harness, { role: 'implementer', provider: 'both', writeScope: ['tracked.txt'] })).activations as (Lane & { provider: string })[]
      const held = lanes.find(lane => lane.provider === 'codex')
      const other = lanes.find(lane => lane.provider === 'antigravity')
      await reached.promise
      harness.gitGate = undefined
      git(harness.repo, 'update-ref', '-d', `refs/heads/${other?.branch ?? ''}`)
      release.resolve(undefined)
      await expect.poll(() => harness.status().tasks.find(task => task.id === held?.taskId)?.state).not.toBe('active')
      resume.resolve(undefined)
      expect((await settled(harness)).find(task => task.id === held?.taskId))
        .toMatchObject({ state: 'failed', error: `implementer changed other branches or refs: refs/heads/${other?.branch ?? ''}` })
    })

    it('fails the implementer that deleted the branch of an untouched lane right before the Host did, and keeps that lane', async () => {
      const harness = await isolated()
      await harness.update({ teamSize: 2 })
      const release = Promise.withResolvers<undefined>()
      harness.hold = release.promise
      // The held implementer deletes the other lane's branch as the Host is about to, and is checked while the Host's deletion is pending.
      const deleted = Promise.withResolvers<undefined>()
      const resume = Promise.withResolvers<undefined>()
      let branch: string | undefined
      harness.gitGate = (args) => {
        const ref = args.at(-2) ?? ''
        if (branch !== undefined || !args.includes('update-ref') || !args.includes('-d')) return undefined
        branch = ref
        git(harness.repo, 'update-ref', '-d', ref)
        deleted.resolve(undefined)
        return resume.promise
      }
      const found: { held?: Lane | undefined } = {}
      harness.gitAfter = afterSecondListing(() => found.held?.worktree, () => { resume.resolve(undefined) })
      const lanes = (await delegate(harness, { role: 'implementer', provider: 'both', writeScope: ['tracked.txt'] })).activations as (Lane & { provider: string })[]
      const held = found.held = lanes.find(lane => lane.provider === 'codex')
      const other = lanes.find(lane => lane.provider === 'antigravity')
      await deleted.promise
      release.resolve(undefined)
      const tasks = await settled(harness)
      expect(branch).toBe(`refs/heads/${other?.branch ?? ''}`)
      expect(tasks.find(task => task.id === held?.taskId))
        .toMatchObject({ state: 'failed', error: `implementer changed other branches or refs: refs/heads/${other?.branch ?? ''}` })
      // The Host removed the worktree before its deletion of the branch failed: the ledger lists the branch only.
      const ended = tasks.find(task => task.id === other?.taskId)
      expect(existsSync(other?.worktree ?? '')).toBe(false)
      expect(ended).not.toHaveProperty('worktree')
      expect(ended).toHaveProperty('branch', other?.branch)
    })
  })
})

describe('Toranja admission of a writer', () => {
  it('refuses a writer whose approval policy changed while its worktree was being made, and starts nothing', async () => {
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'toranja-worktrees-'))
    repos.push(worktreeRoot)
    const harness = await mount({ routing: ROUTING, implementerWorktrees: true, worktreeRoot })
    harness.gitGate = args => args.includes('worktree') && args.includes('add') ? harness.update({ approvalPolicy: 'auto' }) : undefined
    await expect(delegate(harness, { role: 'implementer', provider: 'codex' }))
      .rejects.toThrow('the approval policy changed while the task was starting; delegate it again')
    harness.gitGate = undefined
    expect(harness.started).toEqual([])
    expect(harness.status().tasks).toEqual([])
    // The worktree made for it is given back.
    expect(git(harness.repo, 'branch', '--list', 'toranja/*')).toBe('')
  })

  it('spends nothing from the direct budget when no agent starts', async () => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
    harness.offline.set('codex', 'quota exhausted')
    harness.offline.set('antigravity', 'signed out')
    await expect(delegate(harness, { role: 'implementer', writeScope: ['a.txt', 'b.txt', 'c.txt'] })).rejects.toThrow('no project agent started')
    expect(JSON.parse(await harness.tool('classify_project_task').execute(
      { project: 'demo', task: 'add a file', writeScope: ['d.txt'] },
      { agent: {}, signal: new AbortController().signal },
    ))).toMatchObject({ level: 'simple', reasons: [] })
  })
})

describe('Toranja writers while the approval policy is on', () => {
  it('keeps a second implementer out of the project tree even when parallel implementation is allowed', async () => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto', allowParallelImplementation: true, maxConcurrentPerProject: 3 })
    await expect(delegate(harness, { role: 'implementer', provider: 'both', writeScope: ['tracked.txt'] }))
      .rejects.toThrow('write isolation prevents multiple implementers in project demo')
    const release = Promise.withResolvers<undefined>()
    harness.hold = release.promise
    await delegate(harness, { role: 'implementer', provider: 'codex', writeScope: ['tracked.txt'] })
    await expect(delegate(harness, { role: 'implementer', provider: 'antigravity', writeScope: ['tracked.txt'] }))
      .rejects.toThrow('write isolation prevents multiple implementers in project demo')
    release.resolve(undefined)
    await settled(harness)
    expect(harness.status().limits.allowParallelImplementation).toBe(false)
  })

  it('refuses the implementer in a project that is not a Git work tree', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'toranja-plain-'))
    repos.push(plain)
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto', projects: [{ id: 'plain', title: 'Plain', path: plain }] })
    await expect(delegate(harness, { project: 'plain', role: 'implementer', writeScope: ['a.txt'] }))
      .rejects.toThrow('project plain is not the top level of a Git work tree with a commit')
    expect(harness.started).toEqual([])
  })

  it('refuses a writing role through the direct Codex delegation', async () => {
    const harness = await mount({ routing: ROUTING, approvalPolicy: 'auto' })
    await expect(harness.ctx.toranjaOrchestrator.delegateCodex({
      project: 'demo',
      role: 'implementer',
      description: 'implement',
      task: 'do the work',
      parent: {} as never,
      signal: new AbortController().signal,
    })).rejects.toThrow('delegate the implementer with delegate_project_task while the approval policy is auto')
    expect(harness.started).toEqual([])
  })
})
