/**
 * Deterministic task classification and write-scope validation. Pure functions
 * with no I/O: the Host decides how much planning a task needs from its own
 * rules, never from the agent's claim.
 *
 * @module @deepseek-ai/dsh-toranja-orchestrator/classification
 */

/** Limits and term lists that drive {@link classifyTask}. */
export interface ClassificationRules {
  /** Most file entries a task may write and still be `simple`. */
  maxDirectFiles: number
  /** Most file entries a task may write without becoming `complex`. */
  maxInvestigatedFiles: number
  /** Terms that make a task `complex` when its text contains them. */
  riskTerms: readonly string[]
  /** Protected path patterns; a write scope that touches one makes the task `complex`. */
  protectedPaths: readonly string[]
}

/** How much preparation a task needs before an implementer starts. */
export type TaskLevel = 'simple' | 'moderate' | 'complex'

/** Route of a task: delegate directly, investigate first, or submit a plan for approval. */
export type TaskPath = 'direct' | 'investigate' | 'approve'

/** Outcome of {@link classifyTask}. */
export interface TaskClassification {
  /** Level the rules assign, after any caller raise. */
  level: TaskLevel
  /** Route of the level. */
  path: TaskPath
  /** Each rule that fired, in a stable order; empty for `simple`. */
  reasons: string[]
}

const LEVELS: readonly TaskLevel[] = ['simple', 'moderate', 'complex']
const PATH_OF_LEVEL: Record<TaskLevel, TaskPath> = { simple: 'direct', moderate: 'investigate', complex: 'approve' }

/** Rules used for every deployment value `classification` leaves unset. */
export const DEFAULT_CLASSIFICATION_RULES: ClassificationRules = {
  maxDirectFiles: 3,
  maxInvestigatedFiles: 10,
  riskTerms: [
    'migration', 'migração', 'migrate', 'delete', 'drop', 'truncate', 'credential', 'credencial', 'secret', 'segredo',
    'password', 'senha', 'token', 'auth', 'deploy', 'release', 'production', 'produção', 'force', 'rm -rf',
  ],
  protectedPaths: ['.github/', '**/.env*', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/migrations/'],
}

/**
 * Normalize a write scope. An entry ending in `/` (or `/**`) is a directory,
 * any other entry is a file, and `./` is the whole project.
 * @param entries - Project-relative paths.
 * @returns Deduplicated entries with `/` separators, sorted.
 * @throws When the list or an entry is empty, an entry is absolute or has a `..` segment, or has a wildcard other than the `/**` suffix.
 */
export function normalizeWriteScope(entries: readonly string[]): string[] {
  if (entries.length === 0) throw new Error('write scope needs at least one entry')
  const normalized = entries.map((raw) => {
    const entry = raw.trim()
    if (entry.length === 0) throw new Error('write scope entry must not be empty')
    if (/^(?:[a-zA-Z]:|[\\/])/u.test(entry)) {
      throw new Error(`write scope entry ${JSON.stringify(entry)} must be relative to the project, not absolute`)
    }
    const slashed = entry.replaceAll('\\', '/').replace(/\/\*\*$/u, '/')
    const segments = slashed.split('/').filter(segment => segment !== '' && segment !== '.')
    if (segments.includes('..')) throw new Error(`write scope entry ${JSON.stringify(entry)} must not contain a ".." segment`)
    if (/[*?[{]/u.test(slashed)) {
      throw new Error(`write scope entry ${JSON.stringify(entry)} must not contain wildcards; list files or end a directory with "/"`)
    }
    if (segments.length === 0) return './'
    return segments.join('/') + (slashed.endsWith('/') ? '/' : '')
  })
  return [...new Set(normalized)].sort()
}

const fold = (value: string, caseInsensitive: boolean): string => caseInsensitive ? value.toLowerCase() : value

/**
 * Whether a write scope covers a path.
 * @param scope - Normalized write scope.
 * @param path - Project-relative path using `/`; a trailing `/` marks a directory.
 * @param caseInsensitive - Compare without regard to case.
 * @returns True when a file entry equals the path or a directory entry is a segment prefix of it.
 */
export function scopeContains(scope: readonly string[], path: string, caseInsensitive: boolean): boolean {
  const target = fold(path, caseInsensitive)
  return scope.some((entry) => {
    const folded = fold(entry, caseInsensitive)
    return folded === './' || folded === target || (folded.endsWith('/') && target.startsWith(folded))
  })
}

/**
 * Whether every entry of one write scope lies inside another.
 * @param inner - Normalized scope to test.
 * @param outer - Normalized scope that must cover it.
 * @param caseInsensitive - Compare without regard to case.
 * @returns True when `outer` covers each entry of `inner`.
 */
export function scopeWithin(inner: readonly string[], outer: readonly string[], caseInsensitive: boolean): boolean {
  return inner.every(entry => scopeContains(outer, entry, caseInsensitive))
}

/**
 * Whether a path is protected by any pattern. A pattern without a `**\/`
 * prefix is anchored at the project root; with it, the pattern matches at any
 * depth. A final `/` marks a directory pattern (the path must be it or inside
 * it), and a final `*` on the last segment matches a name prefix.
 * @param path - Project-relative file path, or directory entry with a trailing `/`.
 * @param patterns - Protected path patterns.
 * @param caseInsensitive - Compare without regard to case.
 * @returns True when a pattern matches.
 */
export function isProtectedPath(path: string, patterns: readonly string[], caseInsensitive: boolean): boolean {
  const target = fold(path, caseInsensitive).split('/')
  const isDirectory = target.at(-1) === ''
  const segments = isDirectory ? target.slice(0, -1) : target
  return patterns.some((raw) => {
    const anywhere = raw.startsWith('**/')
    const body = fold(anywhere ? raw.slice(3) : raw, caseInsensitive)
    const directoryPattern = body.endsWith('/')
    const wanted = (directoryPattern ? body.slice(0, -1) : body).split('/')
    const last = wanted.length - 1
    const starts = anywhere ? segments.keys() : [0]
    return [...starts].some((start) => {
      const matches = wanted.every((part, index) => {
        const actual = segments[start + index]
        if (actual === undefined) return false
        return index === last && part.endsWith('*') ? actual.startsWith(part.slice(0, -1)) : actual === part
      })
      if (!matches) return false
      const end = start + wanted.length
      return !directoryPattern || end < segments.length || isDirectory
    })
  })
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

function mentionsTerm(task: string, term: string): boolean {
  if (/\s/u.test(term)) return task.toLowerCase().includes(term.toLowerCase())
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(term)}(?![\\p{L}\\p{N}_])`, 'iu').test(task)
}

/**
 * Classify a task from its text and normalized write scope. The level is the
 * highest one any rule reaches, and `raise` can only increase it.
 * @param input - Task text, normalized write scope, and an optional minimum level.
 * @param rules - Limits, risk terms, and protected paths.
 * @param caseInsensitive - Compare paths without regard to case.
 * @returns Level, route, and the rules that fired.
 */
export function classifyTask(
  input: { task: string; writeScope: readonly string[]; raise?: TaskLevel },
  rules: ClassificationRules,
  caseInsensitive: boolean,
): TaskClassification {
  const { writeScope } = input
  const directories = writeScope.filter(entry => entry.endsWith('/') && entry !== './')
  const fileCount = writeScope.filter(entry => !entry.endsWith('/')).length
  const complex = [
    ...rules.riskTerms.filter(term => mentionsTerm(input.task, term)).map(term => `risk term ${JSON.stringify(term)}`),
    ...writeScope.filter(entry => isProtectedPath(entry, rules.protectedPaths, caseInsensitive)).map(entry => `protected path ${entry}`),
    ...writeScope.includes('./') ? ['scope covers the whole project'] : [],
    ...fileCount > rules.maxInvestigatedFiles ? [`${fileCount} files exceed the investigated limit of ${rules.maxInvestigatedFiles}`] : [],
  ]
  const moderate = [
    ...directories.map(entry => `directory scope ${entry}`),
    ...fileCount > rules.maxDirectFiles ? [`${fileCount} files exceed the direct limit of ${rules.maxDirectFiles}`] : [],
  ]
  const computed: TaskLevel = complex.length > 0 ? 'complex' : moderate.length > 0 ? 'moderate' : 'simple'
  const raise = input.raise ?? 'simple'
  const level = LEVELS[Math.max(LEVELS.indexOf(computed), LEVELS.indexOf(raise))] ?? computed
  const reasons = [...complex, ...moderate, ...level !== computed ? [`raised to ${level} by the caller`] : []]
  return { level, path: PATH_OF_LEVEL[level], reasons }
}
