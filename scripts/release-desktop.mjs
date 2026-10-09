// Builds the Windows installers on this PC and publishes them to the releases of this repository,
// HonoKit (decisions §85; docs/release-and-updates.md). RELEASE_REPO=owner/name publishes elsewhere
// (0.19.0 was also put in the old shared HonoKit-Releases so copies up to 0.18.0 move over).
//
//   node scripts/release-desktop.mjs              build, check, and show what would be published
//   node scripts/release-desktop.mjs --publish    the same, then create the GitHub release
//   --skip-build                                  check and publish what is already in release/
//
// Desktop tags are `vX.Y.Z` and the release is always marked "Latest", because electron-updater
// reads only the release marked "Latest".
//
// The build drops `publisherName` (electron-builder.unsigned.cjs): these builds are unsigned, and
// a copy that demands SignPath's signature would refuse them.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const REPO = process.env.RELEASE_REPO || 'abd-el-rahman-mustafa/HonoKit'
const root = join(import.meta.dirname, '..')
const args = new Set(process.argv.slice(2))
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const tag = `v${version}`
const rel = (f) => join(root, 'release', f)

function fail(message) {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

function run(command, commandArgs) {
  console.log(`\n> ${command} ${commandArgs.join(' ')}`)
  const r = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', shell: true })
  if (r.status !== 0) fail(`${command} failed (electron-builder's "spawn UNKNOWN" on this PC: run again).`)
}

if (!args.has('--skip-build')) {
  run('npm', ['run', 'build'])
  run('npx', ['electron-builder', '--win', 'nsis', 'portable', '--x64', '--publish', 'never', '--config', 'electron-builder.unsigned.cjs'])
}

// Every file an installed copy needs, from this version's build.
const files = [`HonoKit-Setup-${version}.exe`, `HonoKit-Setup-${version}.exe.blockmap`, `HonoKit-${version}-portable.exe`, 'latest.yml']
for (const f of files) if (!existsSync(rel(f))) fail(`release/${f} is missing. Build first (without --skip-build).`)

const feed = readFileSync(rel('latest.yml'), 'utf8')
if (!new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm').test(feed)) fail(`release/latest.yml is not for ${version}.`)
const sha512 = createHash('sha512').update(readFileSync(rel(`HonoKit-Setup-${version}.exe`))).digest('base64')
if (!feed.includes(`sha512: ${sha512}`)) fail('release/latest.yml does not match the installer (rebuild).')

// What the installed copy will read: this repository, and no signature demand.
const appUpdate = readFileSync(rel('win-unpacked/resources/app-update.yml'), 'utf8')
if (!/^repo: HonoKit$/m.test(appUpdate)) fail('The build reads updates from another repository (rebuild after the §85 change).')
if (/publisherName/.test(appUpdate)) fail('The build demands a signature it does not have; build with electron-builder.unsigned.cjs.')

console.log(`\n✓ HonoKit ${version}: ${files.join(', ')}`)
console.log(`  installer sha512 ${sha512.slice(0, 16)}… matches latest.yml; updates read ${REPO}`)

if (!args.has('--publish')) {
  console.log(`\nNot published. To publish ${tag} to ${REPO} as "Latest": node scripts/release-desktop.mjs --skip-build --publish`)
  process.exit(0)
}

const gh = (...a) => execFileSync('gh', a, { cwd: root, encoding: 'utf8' }).trim()
let exists = true
try {
  gh('release', 'view', tag, '--repo', REPO)
} catch {
  exists = false
}
if (exists) fail(`${REPO} already has ${tag}. Raise the version in package.json first.`)

const notes = join(tmpdir(), `honokit-${version}-notes.md`)
writeFileSync(
  notes,
  `## HonoKit ${version} for Windows

| File | |
| --- | --- |
| \`HonoKit-Setup-${version}.exe\` | **Recommended.** Installs for your user only and updates itself |
| \`HonoKit-${version}-portable.exe\` | Runs without installing; does not update itself |

\`latest.yml\` and the \`.blockmap\` are what installed copies use to update; you do not need them.

Not yet signed with a Windows certificate: on "Windows protected your PC", click **More info**, then **Run anyway**.

Your files never leave your computer. The only connection HonoKit makes is the update check, which can be turned off in Settings.

**Android:** [HonoKit for Android](https://github.com/abd-el-rahman-mustafa/HonoKit-Android/releases/latest).
`
)
console.log(`\nPublishing ${tag} to ${REPO}…`)
gh('release', 'create', tag, ...files.map(rel), '--repo', REPO, '--title', `HonoKit ${version}`, '--notes-file', notes, '--latest')
const latest = gh('api', `repos/${REPO}/releases/latest`, '--jq', '.tag_name')
if (latest !== tag) fail(`Published, but "Latest" is ${latest}, not ${tag}: installed copies would not see it. Fix it on GitHub (Edit release → Set as the latest release).`)
console.log(`✓ Published: https://github.com/${REPO}/releases/tag/${tag} (marked Latest)`)
