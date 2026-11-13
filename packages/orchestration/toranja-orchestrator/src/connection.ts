/** Detection of installed provider CLIs and of their sign-in state. */

import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { ToranjaProviderConnection } from './types.ts'

/** Providers whose connection is read from a locally installed CLI. */
export const CLI_PROVIDERS = ['codex', 'antigravity', 'claude-code'] as const
/** Provider whose connection is read from a locally installed CLI. */
export type CliProvider = typeof CLI_PROVIDERS[number]

/** Executable looked up for each CLI provider when the deployment names none. */
export const DEFAULT_EXECUTABLES: Readonly<Record<CliProvider, string>> = {
  codex: 'codex',
  antigravity: 'agy',
  'claude-code': 'claude',
}

/**
 * Official status command of each CLI and how its outcome maps to a sign-in
 * state. Antigravity has no status command; listing models succeeds only for a
 * signed-in account.
 */
export const STATUS_COMMANDS: Readonly<Record<CliProvider, {
  readonly args: readonly string[]
  readonly connected: (exitCode: number | null, stdout: string) => boolean
}>> = {
  codex: { args: ['login', 'status'], connected: exitCode => exitCode === 0 },
  antigravity: { args: ['models'], connected: (exitCode, stdout) => exitCode === 0 && stdout.trim().length > 0 },
  'claude-code': {
    args: ['auth', 'status'],
    connected: (exitCode, stdout) => {
      if (exitCode !== 0) return false
      try {
        const status: unknown = JSON.parse(stdout)
        return typeof status === 'object' && status !== null && 'loggedIn' in status && status.loggedIn === true
      } catch {
        // `claude auth status` prints JSON; any other output is not a signed-in report.
        return false
      }
    },
  },
}

/**
 * Resolve an executable the way the shell would: an absolute path must exist,
 * and a bare name is searched in `PATH` with the Windows `PATHEXT` suffixes.
 * @param name - Absolute path or bare command name.
 * @param env - Environment supplying `PATH` and `PATHEXT`.
 * @param platform - Platform whose lookup rules apply.
 * @returns Absolute path of the executable, or `undefined` when it is not installed.
 */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (isAbsolute(name)) return existsSync(name) ? name : undefined
  const suffixes = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Build the argv that runs an executable without a shell. Windows batch shims,
 * such as the ones npm installs, only run through `cmd.exe`.
 * @param executable - Absolute path of the executable.
 * @param args - Arguments for it.
 * @param platform - Platform whose launch rules apply.
 * @returns Argv for a shell-less spawn.
 */
export function commandArgv(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  return platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)
    ? ['cmd.exe', '/d', '/s', '/c', executable, ...args]
    : [executable, ...args]
}

/** Sign-in state of one provider and the evidence it rests on. */
export interface ProviderConnection {
  readonly connection: ToranjaProviderConnection
  /** Executable the state was read from, when one is installed. */
  readonly executable?: string
}

/**
 * Official sign-in command of each CLI. Antigravity has no sign-in subcommand:
 * starting the CLI interactively begins its own sign-in.
 */
export const LOGIN_COMMANDS: Readonly<Record<CliProvider, readonly string[]>> = {
  codex: ['login'],
  antigravity: [],
  'claude-code': ['auth', 'login'],
}

/**
 * Build the argv that opens a command in a visible terminal window, where the
 * user completes an interactive sign-in with the provider's own CLI.
 * @param command - Executable and arguments to run in the terminal.
 * @param platform - Platform whose terminal is used.
 * @returns Argv for a shell-less spawn.
 */
export function terminalArgv(command: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  switch (platform) {
    case 'win32':
      return ['cmd.exe', '/d', '/c', 'start', 'Toranja Harness', 'cmd.exe', '/d', '/k', ...command]
    case 'darwin': {
      const script = command.map(part => `'${part.replaceAll("'", String.raw`'\''`)}'`).join(' ')
      return [
        'osascript',
        '-e', `tell application "Terminal" to do script "${script.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
        '-e', 'tell application "Terminal" to activate',
      ]
    }
    default:
      return ['x-terminal-emulator', '-e', ...command]
  }
}
