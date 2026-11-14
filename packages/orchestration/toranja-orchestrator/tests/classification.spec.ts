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

  it.each(['..', 'a/../b', '..\\b', 'a/./b'])('rejects the relative segment in %s', (entry) => {
    expect(() => normalizeWriteScope([entry])).toThrow(JSON.stringify(entry))
  })

  it.each([
    '.github./x', 'a/b ./c', 'a /b', '.env:stream', 'C:', 'GITHUB~1/x', 'nul', 'NUL', 'con.txt', 'src/Aux.tar.gz', 'com1', 'LPT9.log', 'CONIN$', 'conout$.txt', 'a\u0001b', 'a\nb',
    'con .txt', 'src/nul  .tar.gz',
  ])('rejects the segment that Windows reads as another name in %j', (entry) => {
    expect(() => normalizeWriteScope([entry])).toThrow(JSON.stringify(entry))
  })

  it.each(['.git', '.git/config', '.GIT/hooks/pre-commit', 'sub/.Git/x', '.git/'])('rejects the Git directory in %j', (entry) => {
    expect(() => normalizeWriteScope([entry])).toThrow(JSON.stringify(entry))
  })

  it.each(['a​b.ts', 'src/‮evil.ts', 'a﻿b.ts'])('rejects an invisible format character in %j', (entry) => {
    expect(() => normalizeWriteScope([entry])).toThrow(JSON.stringify(entry))
  })

  it('keeps names that only resemble the reserved ones', () => {
    expect(normalizeWriteScope(['console.ts', 'nulls/a', 'com10', 'a~b'])).toEqual(['a~b', 'com10', 'console.ts', 'nulls/a'])
  })

  it('writes the path in NFC', () => {
    expect(normalizeWriteScope(['café/x.ts'])).toEqual(['café/x.ts'])
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

  it('folds case through upper case, so a long s matches s', () => {
    expect(scopeContains(['src/'], 'ſrc/a.ts', true)).toBe(true)
    expect(scopeContains(['src/'], 'ſrc/a.ts', false)).toBe(false)
  })

  it('compares NFC and NFD forms as the same name, in either direction', () => {
    expect(scopeContains(['café/'], 'café/x.ts', false)).toBe(true)
    expect(scopeContains(['café/'], 'café/x.ts', false)).toBe(true)
  })

  it('does not contain a path that does not normalize', () => {
    expect(scopeContains(['src/'], 'src/../.github/x', false)).toBe(false)
    expect(scopeContains(['./'], '/etc/passwd', false)).toBe(false)
    expect(scopeContains(['./'], 'src/a.ts:stream', false)).toBe(false)
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
    expect(isProtectedPath('.github/workflows/ci.yml', ['.github/'])).toBe(true)
    expect(isProtectedPath('sub/.github/ci.yml', ['.github/'])).toBe(false)
    expect(isProtectedPath('Makefile', ['Makefile'])).toBe(true)
    expect(isProtectedPath('sub/Makefile', ['Makefile'])).toBe(false)
  })

  it('matches at any depth with **/', () => {
    expect(isProtectedPath('a/b/package-lock.json', ['**/package-lock.json'])).toBe(true)
    expect(isProtectedPath('package-lock.json', ['**/package-lock.json'])).toBe(true)
    expect(isProtectedPath('package-lock.json.bak', ['**/package-lock.json'])).toBe(false)
    expect(isProtectedPath('db/migrations/001.sql', ['**/migrations/'])).toBe(true)
    expect(isProtectedPath('db/migrationsx/001.sql', ['**/migrations/'])).toBe(false)
  })

  it('treats a trailing * on the last segment as a name prefix', () => {
    const patterns = ['**/.env*']
    expect(isProtectedPath('.env', patterns)).toBe(true)
    expect(isProtectedPath('.env.local', patterns)).toBe(true)
    expect(isProtectedPath('apps/x/.env.prod', patterns)).toBe(true)
    expect(isProtectedPath('apps/x/env.prod', patterns)).toBe(false)
  })

  it('protects a directory entry equal to or inside a protected directory, not one that merely holds a protected file', () => {
    expect(isProtectedPath('.github/', ['.github/'])).toBe(true)
    expect(isProtectedPath('.github/workflows/', ['.github/'])).toBe(true)
    expect(isProtectedPath('src/', ['**/.env*'])).toBe(false)
  })

  it('does not treat a file named like a protected directory as inside it', () => {
    expect(isProtectedPath('db/migrations', ['**/migrations/'])).toBe(false)
  })

  it('ignores case on every platform', () => {
    expect(isProtectedPath('.GitHub/ci.yml', ['.github/'])).toBe(true)
    expect(isProtectedPath('.github/ci.yml', ['.GitHub/'])).toBe(true)
    expect(isProtectedPath('APPS/.ENV', ['**/.env*'])).toBe(true)
  })

  it('folds case through upper case, so a long s matches s', () => {
    expect(isProtectedPath('migrationſ/x.sql', ['**/migrations/'])).toBe(true)
  })

  it('normalizes each pattern as the configuration does', () => {
    expect(isProtectedPath('.github/ci.yml', ['.github\\'])).toBe(true)
    expect(isProtectedPath('.github/ci.yml', ['./.github/'])).toBe(true)
    expect(isProtectedPath('db/migrations/1.sql', ['**/db//migrations/'])).toBe(true)
  })

  it('lets the whole-project pattern protect every path', () => {
    expect(isProtectedPath('src/a.ts', ['./'])).toBe(true)
  })

  it.each(['../x', 'a/../b', '/etc/', 'a*b/c'])('lets the invalid pattern %j protect every path', (pattern) => {
    expect(isProtectedPath('src/a.ts', [pattern])).toBe(true)
  })

  it('compares NFC and NFD forms as the same name', () => {
    expect(isProtectedPath('café/x', ['café/'])).toBe(true)
    expect(isProtectedPath('café/x', ['café/'])).toBe(true)
  })

  it('treats a path that does not normalize as protected', () => {
    expect(isProtectedPath('src/../.github/x', ['.github/'])).toBe(true)
    expect(isProtectedPath('/etc/x', ['.github/'])).toBe(true)
    expect(isProtectedPath('GITHUB~1/x', ['.github/'])).toBe(true)
    expect(isProtectedPath('', ['.github/'])).toBe(true)
  })
})

describe('classifyTask', () => {
  const rules = DEFAULT_CLASSIFICATION_RULES
  const classify = (task: string, writeScope: string[], raise?: 'simple' | 'moderate' | 'complex') =>
    classifyTask({ task, writeScope, ...raise === undefined ? {} : { raise } }, rules)

  it('ships the documented defaults', () => {
    expect(rules.maxDirectFiles).toBe(3)
    expect(rules.maxInvestigatedFiles).toBe(10)
    expect(rules.riskTerms).toContain('rm -r')
    expect(rules.protectedPaths).toEqual([
      '.github/', '.vscode/', '.idea/', '.husky/', '.claude/', '.cursor/', '**/.env*', '**/.envrc', '**/.npmrc', '**/.gitattributes',
      '**/.gitmodules', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/migrations/',
    ])
  })

  it('is simple for a few files without risk', () => {
    expect(classify('fix a typo', ['src/a.ts', 'src/b.ts', 'src/c.ts'])).toEqual({ level: 'simple', path: 'direct', reasons: [] })
  })

  it.each(['db/', 'apps/web/', 'packages/', 'src/app/', './'])('is complex for the directory entry %s', (entry) => {
    const result = classify('fix a typo', [entry])
    expect(result).toMatchObject({ level: 'complex', path: 'approve' })
    expect(result.reasons).toContain(`directory scope ${entry} needs approval`)
  })

  it('keeps a directory out of the file count', () => {
    expect(classify('fix a typo', ['src/', ...files(3)]).reasons).toEqual(['directory scope src/ needs approval'])
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
      reasons: ['risk term "migra"'],
    })
  })

  it('matches a term as the start of a word, not inside one', () => {
    expect(classify('update the README wording', ['src/a.ts']).level).toBe('simple')
    expect(classify('rotate the senha', ['src/a.ts']).reasons).toEqual(['risk term "senha"'])
    expect(classify('trocar a ésenha', ['src/a.ts']).level).toBe('simple')
    expect(classify('Executar a migração agora', ['src/a.ts']).reasons).toEqual(['risk term "migra"'])
  })

  it('keeps the terms as stems, so a false positive asks for approval', () => {
    expect(classify('update the author page', ['src/a.ts']).reasons).toEqual(['risk term "auth"'])
    expect(classify('fix the dropdown', ['src/a.ts']).reasons).toEqual(['risk term "drop"'])
  })

  it.each([
    'deleted the table',
    'run migrations',
    'rotate tokens',
    'deploying now',
    'fix delete_user',
    'refactor deleteUser',
    'auth_token leak',
    'de​lete rows',
    'rm  -fr /tmp/x',
    'migração',
  ])('is complex when a risk term hides in %j', (task) => {
    expect(classify(task, ['src/a.ts'])).toMatchObject({ level: 'complex', path: 'approve' })
  })

  it('matches a term with a space across any run of spaces', () => {
    expect(classify('then rm   -rf build', ['src/a.ts']).reasons).toEqual(['risk term "rm -r"'])
    expect(classify('then rm\t-fr build', ['src/a.ts']).reasons).toEqual(['risk term "rm -f"'])
  })

  it('normalizes a configured term like the task text', () => {
    const rules = { ...DEFAULT_CLASSIFICATION_RULES, riskTerms: ['deleteUser', 'pur​ge'] }
    const run = (task: string) => classifyTask({ task, writeScope: ['src/a.ts'] }, rules).reasons
    expect(run('deleteUser now')).toEqual(['risk term "deleteUser"'])
    expect(run('purge the cache')).toEqual(['risk term "pur​ge"'])
  })

  it('matches a term with regular expression characters literally', () => {
    const rules = { ...DEFAULT_CLASSIFICATION_RULES, riskTerms: ['a.c', '(x+)+$'] }
    const run = (task: string) => classifyTask({ task, writeScope: ['src/a.ts'] }, rules).level
    expect(run('abc')).toBe('simple')
    expect(run('a.c')).toBe('complex')
    expect(run(`${'x'.repeat(5000)}!`)).toBe('simple')
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
      reasons: ['directory scope ./ needs approval'],
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
    expect(classifyTask({ task: 'x', writeScope: ['a.ts', 'b.ts'] }, strict).level).toBe('moderate')
    expect(classifyTask({ task: 'x', writeScope: ['a.ts', 'b.ts', 'c.ts'] }, strict).level).toBe('complex')
    expect(classifyTask({ task: 'run shipit', writeScope: ['a.ts'] }, strict).level).toBe('complex')
    expect(classifyTask({ task: 'run deploy', writeScope: ['a.ts'] }, strict).level).toBe('simple')
  })

  it('protects a path whatever its case', () => {
    expect(classifyTask({ task: 'x', writeScope: ['.GITHUB/ci.yml'] }, rules).level).toBe('complex')
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
    expect(classify('fix a typo', files(4), 'moderate').reasons).toEqual(['4 files exceed the direct limit of 3'])
  })
})
