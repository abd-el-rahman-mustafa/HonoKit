// The build configuration for releases made on this PC while there is no signing certificate
// (decisions §73): the normal electron-builder.yml without `publisherName`. With it, an installed
// copy refuses any update not signed by SignPath Foundation, so unsigned updates would never
// install. Used by scripts/release-desktop.mjs; CI's signed builds keep the check.
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const yaml = require('js-yaml')

const base = yaml.load(readFileSync(join(__dirname, 'electron-builder.yml'), 'utf8'))
const { publisherName, ...signtoolOptions } = base.win.signtoolOptions ?? {}

module.exports = {
  ...base,
  win: { ...base.win, signtoolOptions }
}
