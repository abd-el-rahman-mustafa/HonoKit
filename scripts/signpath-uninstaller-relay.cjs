// electron-builder custom sign hook used only by CI (passed with -c.win.signtoolOptions.sign).
// It signs nothing. It relays the NSIS uninstaller, which exists only while electron-builder
// builds the installer (NsisTarget.computeScriptAndSignUninstaller -> signIf -> embed -> delete):
//   capture: copy the unsigned uninstaller out so CI can send it to SignPath (request 1)
//   inject:  replace the regenerated unsigned uninstaller with the SignPath-signed copy
// Every other file (HonoPDF.exe, the installer, the portable exe) is ignored here and signed by
// SignPath between the electron-builder runs.
'use strict'
const { copyFileSync, existsSync, mkdirSync } = require('node:fs')
const path = require('node:path')

module.exports = async function sign(configuration) {
  const file = configuration.path
  if (!file.endsWith('__uninstaller.exe')) return

  const mode = process.env.POWERPDF_UNINSTALLER_MODE
  const relayFile = process.env.POWERPDF_UNINSTALLER_FILE
  if (!mode || !relayFile) {
    throw new Error('POWERPDF_UNINSTALLER_MODE and POWERPDF_UNINSTALLER_FILE must be set')
  }
  if (mode === 'capture') {
    mkdirSync(path.dirname(relayFile), { recursive: true })
    copyFileSync(file, relayFile)
    console.log(`[uninstaller-relay] captured ${file} -> ${relayFile}`)
  } else if (mode === 'inject') {
    if (!existsSync(relayFile)) throw new Error(`signed uninstaller missing: ${relayFile}`)
    copyFileSync(relayFile, file)
    console.log(`[uninstaller-relay] injected signed uninstaller ${relayFile}`)
  } else {
    throw new Error(`unknown POWERPDF_UNINSTALLER_MODE: ${mode}`)
  }
}
