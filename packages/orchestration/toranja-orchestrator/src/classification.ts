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
  // Stems, matched at the start of a word: `delet` also catches `deleted` and `delete_user`.
  riskTerms: [
    'migra', 'delet', 'drop', 'truncat', 'credenc', 'credential', 'secret', 'segred', 'password', 'senha', 'token',
    'auth', 'autentic', 'autoriz', 'deploy', 'releas', 'production', 'produç', 'produc', 'force', 'rm -r', 'rm -f',
    'chmod', 'chown', 'sudo',
  ],
  protectedPaths: ['.github/', '**/.env*', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/migrations/'],
}

// Windows opens a reserved device name, with or without an extension, instead of a file.
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/iu

/**
 * Normalize one project-relative path: NFC, `/` separators, no leading `./`
 * and no duplicate slashes. A trailing `/` is kept (a directory) and an empty
 * path after `./` is `./` (the whole project). The same rules hold on every
 * platform, since one repository can be checked out on Windows.
 * @param raw - Path as written.
 * @returns The normalized path.
 * @throws When the path is empty or absolute, or has a `.` or `..` segment, or has a segment Windows reads as
 * another name: it ends in a dot or space, starts with a space, holds `:` or a control character, is a `~` plus
 * digit short name, or is a reserved device name.
 */
export function normalizeRelativePath(raw: string): string {
  const quoted = JSON.stringify(raw)
  if (raw.length === 0) throw new Error('path must not be empty')
  const slashed = raw.normalize('NFC').replaceAll('\\', '/')
  if (/^(?:[a-zA-Z]:|\/)/u.test(slashed)) throw new Error(`path ${quoted} must be relative to the project, not absolute`)
  const rest = slashed.replace(/^(?:\.\/+)+/u, '').replace(/\/{2,}/gu, '/')
  const segments = rest.split('/')
  const directory = rest === '' || rest.endsWith('/')
  if (directory) segments.pop()
  if (segments.some(segment => segment === '..' || segment === '.')) {
    throw new Error(`path ${quoted} must not contain a "." or ".." segment`)
  }
  if (segments.some(segment => /[. ]$|^ |[:\p{Cc}]|~\d/u.test(segment) || RESERVED_NAME.test(segment.split('.')[0] ?? ''))) {
    throw new Error(`path ${quoted} has a segment that Windows reads as another name`)
  }
  return segments.length === 0 ? './' : segments.join('/') + (directory ? '/' : '')
}

/**
 * Normalize a write scope. An entry ending in `/` (or `/**`) is a directory,
 * any other entry is a file, and `./` is the whole project.
 * @param entries - Project-relative paths.
 * @returns Deduplicated entries in NFC with `/` separators, sorted.
 * @throws When the list is empty, an entry fails {@link normalizeRelativePath}, or has a wildcard other than the `/**` suffix.
 */
export function normalizeWriteScope(entries: readonly string[]): string[] {
  if (entries.length === 0) throw new Error('write scope needs at least one entry')
  const normalized = entries.map((raw) => {
    const entry = raw.trim()
    if (entry.length === 0) throw new Error('write scope entry must not be empty')
    const path = normalizeRelativePath(entry.replace(/[\\/]\*\*$/u, '/'))
    if (/[*?[{]/u.test(path)) {
      throw new Error(`write scope entry ${JSON.stringify(entry)} must not contain wildcards; list files or end a directory with "/"`)
    }
    return path
  })
  return [...new Set(normalized)].sort()
}

/** Normalize a path to compare, or `undefined` when it does not normalize. */
function tryNormalize(path: string): string | undefined {
  try {
    return normalizeRelativePath(path)
  } catch {
    return undefined
  }
}

const fold = (value: string, caseInsensitive: boolean): string => caseInsensitive ? value.toLowerCase() : value

/**
 * Whether a write scope covers a path.
 * @param scope - Normalized write scope.
 * @param path - Project-relative path; a trailing `/` marks a directory. A path that does not normalize is not covered.
 * @param caseInsensitive - Compare without regard to case.
 * @returns True when a file entry equals the path or a directory entry is a segment prefix of it.
 */
export function scopeContains(scope: readonly string[], path: string, caseInsensitive: boolean): boolean {
  const normalized = tryNormalize(path)
  if (normalized === undefined) return false
  const target = fold(normalized, caseInsensitive)
  return scope.some((entry) => {
    const folded = fold(entry.normalize('NFC'), caseInsensitive)
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
 * Whether a path is protected by any pattern, ignoring case on every platform
 * (the safe side for a file system that ignores it). A pattern without a
 * `**\/` prefix is anchored at the project root; with it, the pattern matches
 * at any depth. A final `/` marks a directory pattern (the path must be it or
 * inside it), and a final `*` on the last segment matches a name prefix.
 * @param path - Project-relative file path, or directory entry with a trailing `/`. A path that does not normalize counts as protected.
 * @param patterns - Protected path patterns.
 * @returns True when a pattern matches or the path does not normalize.
 */
export function isProtectedPath(path: string, patterns: readonly string[]): boolean {
  const normalized = tryNormalize(path)
  if (normalized === undefined) return true
  const target = normalized.toLowerCase().split('/')
  const isDirectory = target.at(-1) === ''
  const segments = normalized === './' ? [] : isDirectory ? target.slice(0, -1) : target
  return patterns.some((raw) => {
    const anywhere = raw.startsWith('**/')
    const body = (anywhere ? raw.slice(3) : raw).normalize('NFC').toLowerCase()
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

/**
 * The one written form of a protected path pattern: its `**\/` prefix and
 * final `*` kept, the rest in the form of {@link normalizeRelativePath}.
 * @param pattern - Pattern as configured.
 * @returns The canonical pattern.
 * @throws When the rest of the pattern fails {@link normalizeRelativePath} or has a wildcard.
 */
export function canonicalProtectedPattern(pattern: string): string {
  const trimmed = pattern.trim()
  const prefix = trimmed.startsWith('**/') ? '**/' : ''
  const suffix = trimmed.endsWith('*') ? '*' : ''
  const core = trimmed.slice(prefix.length, trimmed.length - suffix.length)
  const [path] = normalizeWriteScope([core])
  return `${prefix}${path}${suffix}`
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')

/** NFKC, no invisible format characters, camelCase split, lower case. */
const normalizeText = (value: string): string =>
  value.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').toLowerCase()

/** A term matches as the start of a word: nothing but a non-letter before it, anything after. */
function mentionsTerm(text: string, term: string): boolean {
  const words = term.normalize('NFKC').toLowerCase().trim().split(/\s+/u).map(escapeRegExp)
  return new RegExp(`(?<!\\p{L})${words.join('\\s+')}`, 'u').test(text)
}

/**
 * Classify a task from its text and normalized write scope. The level is the
 * highest one any rule reaches, and `raise` can only increase it.
 * @param input - Task text, normalized write scope, and an optional minimum level.
 * @param rules - Limits, risk terms, and protected paths.
 * @returns Level, route, and the rules that fired.
 */
export function classifyTask(
  input: { task: string; writeScope: readonly string[]; raise?: TaskLevel },
  rules: ClassificationRules,
): TaskClassification {
  const { writeScope } = input
  const fileCount = writeScope.filter(entry => !entry.endsWith('/')).length
  const text = normalizeText(input.task)
  const complex = [
    ...rules.riskTerms.filter(term => mentionsTerm(text, term)).map(term => `risk term ${JSON.stringify(term)}`),
    ...writeScope.filter(entry => isProtectedPath(entry, rules.protectedPaths)).map(entry => `protected path ${entry}`),
    // A directory can hold protected paths the patterns never see, so it always needs approval.
    ...writeScope.filter(entry => entry.endsWith('/')).map(entry => `directory scope ${entry} needs approval`),
    ...fileCount > rules.maxInvestigatedFiles ? [`${fileCount} files exceed the investigated limit of ${rules.maxInvestigatedFiles}`] : [],
  ]
  const moderate = fileCount > rules.maxDirectFiles ? [`${fileCount} files exceed the direct limit of ${rules.maxDirectFiles}`] : []
  const computed: TaskLevel = complex.length > 0 ? 'complex' : moderate.length > 0 ? 'moderate' : 'simple'
  const raise = input.raise ?? 'simple'
  const level = LEVELS[Math.max(LEVELS.indexOf(computed), LEVELS.indexOf(raise))] ?? computed
  const reasons = [...complex, ...moderate, ...level !== computed ? [`raised to ${level} by the caller`] : []]
  return { level, path: PATH_OF_LEVEL[level], reasons }
}
