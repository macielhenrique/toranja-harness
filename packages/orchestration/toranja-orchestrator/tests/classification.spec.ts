import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CLASSIFICATION_RULES,
  classifyTask,
  isProtectedPath,
  normalizeWriteScope,
  scopeContains,
  scopeWithin,
} from '../src/classification.ts'

const files = (count: number): string[] => Array.from({ length: count }, (_, index) => `src/f${String(index).padStart(2, '0')}.ts`)

describe('normalizeWriteScope', () => {
  it('normalizes separators, leading ./, duplicate slashes, duplicates, and the /** suffix, sorted', () => {
    expect(normalizeWriteScope(['src\\app\\x.ts', './a//b.ts', 'a/b.ts', 'src/**', 'src/'])).toEqual(['a/b.ts', 'src/', 'src/app/x.ts'])
  })

  it('writes the whole project as ./', () => {
    expect(normalizeWriteScope(['./'])).toEqual(['./'])
    expect(normalizeWriteScope(['./**'])).toEqual(['./'])
  })

  it('rejects an empty list and an empty entry', () => {
    expect(() => normalizeWriteScope([])).toThrow('at least one entry')
    expect(() => normalizeWriteScope(['a.ts', ' '])).toThrow('must not be empty')
  })

  it.each(['/x', 'C:\\x', 'c:/x', '\\\\server\\share'])('rejects the absolute path %s', (entry) => {
    expect(() => normalizeWriteScope([entry])).toThrow(JSON.stringify(entry))
  })

  it.each(['..', 'a/../b', '..\\b'])('rejects the parent segment in %s', (entry) => {
    expect(() => normalizeWriteScope([entry])).toThrow(JSON.stringify(entry))
  })

  it.each(['src/*.ts', 'a?', 'a[1]', '{a,b}', '**', 'a/**/b'])('rejects the wildcard in %s', (entry) => {
    expect(() => normalizeWriteScope([entry])).toThrow(JSON.stringify(entry))
  })
})

describe('scopeContains', () => {
  it('matches a file entry only by equality', () => {
    expect(scopeContains(['src/a.ts'], 'src/a.ts', false)).toBe(true)
    expect(scopeContains(['src/a.ts'], 'src/a.tsx', false)).toBe(false)
    expect(scopeContains(['src/a.ts'], 'src/a.ts/b', false)).toBe(false)
  })

  it('matches a directory entry by segment prefix', () => {
    expect(scopeContains(['src/app/'], 'src/app/x.ts', false)).toBe(true)
    expect(scopeContains(['src/app/'], 'src/app/', false)).toBe(true)
    expect(scopeContains(['src/app/'], 'src/application/x.ts', false)).toBe(false)
  })

  it('lets ./ contain everything', () => {
    expect(scopeContains(['./'], 'any/where/x.ts', false)).toBe(true)
  })

  it('honors case sensitivity', () => {
    expect(scopeContains(['Src/'], 'src/a.ts', true)).toBe(true)
    expect(scopeContains(['Src/'], 'src/a.ts', false)).toBe(false)
  })
})

describe('scopeWithin', () => {
  it('requires every inner entry inside the outer scope', () => {
    expect(scopeWithin(['src/app/x.ts', 'src/lib/'], ['src/'], false)).toBe(true)
    expect(scopeWithin(['src/app/x.ts', 'docs/y.md'], ['src/'], false)).toBe(false)
    expect(scopeWithin(['a.ts'], ['./'], false)).toBe(true)
  })

  it('keeps a directory out of a narrower directory or a file', () => {
    expect(scopeWithin(['src/'], ['src/app/'], false)).toBe(false)
    expect(scopeWithin(['src/app/'], ['src/app/x.ts'], false)).toBe(false)
    expect(scopeWithin(['src/app/'], ['src/app/'], false)).toBe(true)
  })

  it('honors case sensitivity', () => {
    expect(scopeWithin(['src/a.ts'], ['SRC/'], true)).toBe(true)
    expect(scopeWithin(['src/a.ts'], ['SRC/'], false)).toBe(false)
  })
})

describe('isProtectedPath', () => {
  it('anchors a pattern without **/ at the project root', () => {
    expect(isProtectedPath('.github/workflows/ci.yml', ['.github/'], false)).toBe(true)
    expect(isProtectedPath('sub/.github/ci.yml', ['.github/'], false)).toBe(false)
    expect(isProtectedPath('Makefile', ['Makefile'], false)).toBe(true)
    expect(isProtectedPath('sub/Makefile', ['Makefile'], false)).toBe(false)
  })

  it('matches at any depth with **/', () => {
    expect(isProtectedPath('a/b/package-lock.json', ['**/package-lock.json'], false)).toBe(true)
    expect(isProtectedPath('package-lock.json', ['**/package-lock.json'], false)).toBe(true)
    expect(isProtectedPath('package-lock.json.bak', ['**/package-lock.json'], false)).toBe(false)
    expect(isProtectedPath('db/migrations/001.sql', ['**/migrations/'], false)).toBe(true)
    expect(isProtectedPath('db/migrationsx/001.sql', ['**/migrations/'], false)).toBe(false)
  })

  it('treats a trailing * on the last segment as a name prefix', () => {
    const patterns = ['**/.env*']
    expect(isProtectedPath('.env', patterns, false)).toBe(true)
    expect(isProtectedPath('.env.local', patterns, false)).toBe(true)
    expect(isProtectedPath('apps/x/.env.prod', patterns, false)).toBe(true)
    expect(isProtectedPath('apps/x/env.prod', patterns, false)).toBe(false)
  })

  it('protects a directory entry equal to or inside a protected directory, not one that merely holds a protected file', () => {
    expect(isProtectedPath('.github/', ['.github/'], false)).toBe(true)
    expect(isProtectedPath('.github/workflows/', ['.github/'], false)).toBe(true)
    expect(isProtectedPath('src/', ['**/.env*'], false)).toBe(false)
  })

  it('does not treat a file named like a protected directory as inside it', () => {
    expect(isProtectedPath('db/migrations', ['**/migrations/'], false)).toBe(false)
  })

  it('honors case sensitivity', () => {
    expect(isProtectedPath('.GitHub/ci.yml', ['.github/'], true)).toBe(true)
    expect(isProtectedPath('.GitHub/ci.yml', ['.github/'], false)).toBe(false)
  })
})

describe('classifyTask', () => {
  const rules = DEFAULT_CLASSIFICATION_RULES
  const classify = (task: string, writeScope: string[], raise?: 'simple' | 'moderate' | 'complex') =>
    classifyTask({ task, writeScope, ...raise === undefined ? {} : { raise } }, rules, false)

  it('ships the documented defaults', () => {
    expect(rules.maxDirectFiles).toBe(3)
    expect(rules.maxInvestigatedFiles).toBe(10)
    expect(rules.riskTerms).toContain('rm -rf')
    expect(rules.protectedPaths).toEqual(['.github/', '**/.env*', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/migrations/'])
  })

  it('is simple for a few files without risk', () => {
    expect(classify('fix a typo', ['src/a.ts', 'src/b.ts', 'src/c.ts'])).toEqual({ level: 'simple', path: 'direct', reasons: [] })
  })

  it('is moderate for a directory entry', () => {
    expect(classify('fix a typo', ['src/app/'])).toEqual({
      level: 'moderate',
      path: 'investigate',
      reasons: ['directory scope src/app/'],
    })
  })

  it('is moderate above the direct file limit', () => {
    expect(classify('fix a typo', files(4))).toEqual({
      level: 'moderate',
      path: 'investigate',
      reasons: ['4 files exceed the direct limit of 3'],
    })
  })

  it('is complex for a risk term, ignoring case', () => {
    expect(classify('Add a MIGRATION for users', ['src/a.ts'])).toEqual({
      level: 'complex',
      path: 'approve',
      reasons: ['risk term "migration"'],
    })
  })

  it('matches a one-word term as a whole word only', () => {
    expect(classify('update the author page', ['src/a.ts']).level).toBe('simple')
    expect(classify('rotate the senha', ['src/a.ts']).reasons).toEqual(['risk term "senha"'])
    expect(classify('trocar a ésenha', ['src/a.ts']).level).toBe('simple')
    expect(classify('Executar a migração agora', ['src/a.ts']).reasons).toEqual(['risk term "migração"'])
  })

  it('matches a term with a space as a substring', () => {
    expect(classify('then rm -rf build', ['src/a.ts']).reasons).toEqual(['risk term "rm -rf"'])
  })

  it('is complex for a protected path', () => {
    expect(classify('fix the pipeline', ['.github/workflows/ci.yml'])).toEqual({
      level: 'complex',
      path: 'approve',
      reasons: ['protected path .github/workflows/ci.yml'],
    })
  })

  it('is complex for the whole project', () => {
    expect(classify('fix a typo', ['./'])).toEqual({
      level: 'complex',
      path: 'approve',
      reasons: ['scope covers the whole project'],
    })
  })

  it('is complex above the investigated file limit and also reports the direct limit', () => {
    expect(classify('fix a typo', files(11))).toEqual({
      level: 'complex',
      path: 'approve',
      reasons: ['11 files exceed the investigated limit of 10', '11 files exceed the direct limit of 3'],
    })
  })

  it('lists risk terms in rule order, then protected paths', () => {
    expect(classify('deploy with the token', ['.github/ci.yml']).reasons).toEqual([
      'risk term "token"',
      'risk term "deploy"',
      'protected path .github/ci.yml',
    ])
  })

  it('uses the limits of the given rules', () => {
    const strict = { ...rules, maxDirectFiles: 1, maxInvestigatedFiles: 2, riskTerms: ['shipit'] }
    expect(classifyTask({ task: 'x', writeScope: ['a.ts', 'b.ts'] }, strict, false).level).toBe('moderate')
    expect(classifyTask({ task: 'x', writeScope: ['a.ts', 'b.ts', 'c.ts'] }, strict, false).level).toBe('complex')
    expect(classifyTask({ task: 'run shipit', writeScope: ['a.ts'] }, strict, false).level).toBe('complex')
    expect(classifyTask({ task: 'run deploy', writeScope: ['a.ts'] }, strict, false).level).toBe('simple')
  })

  it('applies case sensitivity to protected paths', () => {
    const scope = ['.GITHUB/ci.yml']
    expect(classifyTask({ task: 'x', writeScope: scope }, rules, true).level).toBe('complex')
    expect(classifyTask({ task: 'x', writeScope: scope }, rules, false).level).toBe('simple')
  })

  it('lets raise only raise the level', () => {
    expect(classify('fix a typo', ['src/a.ts'], 'complex')).toEqual({
      level: 'complex',
      path: 'approve',
      reasons: ['raised to complex by the caller'],
    })
    expect(classify('fix a typo', ['src/a.ts'], 'moderate')).toEqual({
      level: 'moderate',
      path: 'investigate',
      reasons: ['raised to moderate by the caller'],
    })
    expect(classify('add a migration', ['src/a.ts'], 'simple').level).toBe('complex')
    expect(classify('fix a typo', ['src/app/'], 'moderate').reasons).toEqual(['directory scope src/app/'])
  })
})
