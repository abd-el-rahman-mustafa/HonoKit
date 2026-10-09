/**
 * Seals the macOS bundle with an ad-hoc signature, at build time.
 *
 * Without this, a Mac that *downloads* a build refuses to open it: the browser
 * attaches `com.apple.quarantine`, Gatekeeper then looks for a signature, finds
 * that the bundle has no `_CodeSignature` at all, and reports **"HonoPDF
 * is damaged and can't be opened. You should move it to the Bin."** Nothing is
 * damaged — the words are simply wrong. The same file copied off a share opens
 * perfectly, because a file copy carries no quarantine and Gatekeeper never
 * runs. That difference is the whole bug, and it cost an afternoon.
 *
 * `mac.identity` cannot do this. It is a *lookup key* into the build machine's
 * keychain — electron-builder runs `security find-identity -v` and matches the
 * string against real certificates — so `'-'` finds nothing and silently skips
 * signing, exactly as `null` does. Ad-hoc signing has to be its own step.
 *
 * **Why afterPack and not afterSign.** `afterSign` runs only when signing
 * actually happened, and here it never does. `afterPack` runs after the bundle
 * is assembled and *before* the dmg and zip targets are built, which is the one
 * window where signing reaches both artifacts. Moving this to any later hook
 * ships a signed .app inside two unsigned containers.
 *
 * What it does and does not buy:
 *
 *  - It does **not** make the app trusted. A downloaded copy still warns, and
 *    still needs Control-click → Open (or *Open Anyway* in Privacy & Security)
 *    once per machine. Only a Developer ID and notarisation remove that.
 *  - It **does** turn a refusal nobody can answer into a prompt anybody can:
 *    two clicks instead of a Terminal command on every Mac in the company.
 *
 * Ad-hoc means the signature carries no identity, so it changes with every
 * build. macOS occasionally treats the new build as a different application and
 * resets its Local Network permission — see docs/release-and-updates.md.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param {{ appOutDir: string, electronPlatformName: string, packager: { appInfo: { productFilename: string } } }} context
 */
export default async function signAdHoc(context) {
  if (context.electronPlatformName !== 'darwin') return

  // `codesign` exists only on macOS. A Windows or Linux machine cross-building
  // a mac target is a rehearsal, not a release, and should say so rather than
  // fail — the artifacts it produces must not be handed out.
  if (process.platform !== 'darwin') {
    console.warn(
      '  • not signing the mac bundle: codesign needs macOS. ' +
        'Anything built here will be refused as "damaged" on a Mac that downloads it.'
    )
    return
  }

  const bundle = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!existsSync(bundle)) {
    throw new Error(`afterPack: expected an app bundle at ${bundle}`)
  }

  // --deep signs the nested helpers and frameworks inside-out. Apple discourage
  // it for real certificates, where each nested binary wants its own
  // entitlements; for an ad-hoc seal with no entitlements it is the whole job
  // in one call.
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle], {
    stdio: 'inherit'
  })

  // Verified here rather than trusted. A signature that did not take is
  // invisible until somebody downloads the build a week later.
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], {
    stdio: 'inherit'
  })

  console.log(`  • ad-hoc signed  ${bundle}`)
}
