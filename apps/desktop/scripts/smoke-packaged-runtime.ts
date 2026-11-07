/** Validate the assembled application, including native Office conversion outside ASAR. */
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { desktopArtifactOutput, resolveDesktopBuildTarget, resolveDesktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { readDesktopRuntime, verifyDesktopRuntime } from '../src/runtime-tree.ts'
import { verifyWindowsCode } from './windows-runtime-signature.mjs'
import { smokePreparedRuntime } from './smoke-prepared-runtime.ts'
import { resolveDesktopPackageTarget } from './package-target.ts'

const paths = resolveDesktopTargetBuildPaths()
const { values } = parseArgs({ options: { unsigned: { type: 'boolean', default: false }, 'skip-notarization': { type: 'boolean', default: false } }, allowPositionals: false })
const target = resolveDesktopBuildTarget()
const windows = target === 'win-x64'
const artifacts = desktopArtifactOutput(paths, { unsigned: values.unsigned, skipNotarization: values['skip-notarization'] }).directory
const assembledApplication = windows ? join(artifacts, 'win-unpacked')
  : join(artifacts, target === 'mac-arm64' ? 'mac-arm64' : 'mac', 'Toranja Harness.app', 'Contents')
// Native Windows loaders still impose MAX_PATH on dependent DLL lookup. Build roots can be much
// deeper than the real AppData installation. A junction is insufficient because Electron resolves
// it before loading native modules, so copy the assembled tree to a short temporary installation.
const smokeRoot = windows ? await mkdtemp(join(tmpdir(), 'dsh-app-')) : undefined
const application = smokeRoot === undefined ? assembledApplication : join(smokeRoot, 'app')
try {
  if (smokeRoot !== undefined) await cp(assembledApplication, application, { recursive: true })
  const resources = join(application, windows ? 'resources' : 'Resources')
  const executable = windows ? join(application, 'Toranja Harness.exe') : join(application, 'MacOS', 'Toranja Harness')
  const descriptor = await verifyDesktopRuntime(paths.dsh, readDesktopRuntime(paths.dsh).release.version,
    resolveDesktopPackageTarget(target))
  if (windows && !values.unsigned) await verifyWindowsCode(assembledApplication)
  await smokePreparedRuntime(join(resources, 'app.asar', 'dsh'), executable, join(resources, 'runtime'), descriptor)
} finally {
  if (smokeRoot !== undefined) await rm(smokeRoot, { recursive: true, force: true })
}
