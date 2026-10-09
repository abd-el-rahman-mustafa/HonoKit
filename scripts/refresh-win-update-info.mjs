// Signing changes the Setup exe's bytes after electron-builder wrote latest.yml and the
// blockmap, so both are rebuilt from the signed file (electron-updater checks the sha512).
import { createRequire } from 'node:module'
import { readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire(import.meta.url)
// Same function electron-builder 26 uses for NSIS blockmaps (app-builder-lib internal path).
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap')
const yaml = require('js-yaml') // dependency of app-builder-lib; add as devDependency if not hoisted

const dir = process.argv[2] ?? 'release'
const latestPath = path.join(dir, 'latest.yml')
const info = yaml.load(await readFile(latestPath, 'utf8'))

for (const entry of info.files) {
  const file = path.join(dir, entry.url)
  await rm(`${file}.blockmap`, { force: true })
  const { sha512, size } = await buildBlockMap(file, 'gzip', `${file}.blockmap`)
  entry.sha512 = sha512
  entry.size = size
  if (info.path === entry.url) info.sha512 = sha512
}
await writeFile(latestPath, yaml.dump(info, { lineWidth: -1 }))
console.log(`refreshed ${latestPath} and blockmaps from the signed installer`)
