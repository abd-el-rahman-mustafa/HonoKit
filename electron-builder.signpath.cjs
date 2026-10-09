// The build configuration used by CI when signing through SignPath (docs/research-signpath.md
// §3.5): the normal electron-builder.yml plus the uninstaller relay hook. Passed with
// `--config electron-builder.signpath.cjs`; local `npm run dist:win` never uses it.
// (Command-line -c flags cannot express signingHashAlgorithms, which must be a list.)
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const yaml = require('js-yaml')

const base = yaml.load(readFileSync(join(__dirname, 'electron-builder.yml'), 'utf8'))

module.exports = {
  ...base,
  win: {
    ...base.win,
    signtoolOptions: {
      ...(base.win.signtoolOptions ?? {}),
      // Called for every file electron-builder would sign; it only relays the NSIS uninstaller.
      sign: './scripts/signpath-uninstaller-relay.cjs',
      // One call per file (not one per hash algorithm).
      signingHashAlgorithms: ['sha256']
    }
  }
}
