import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Files HonoKit opens get their own icons, not the app's (decisions §91). These checks keep
// electron-builder.yml, build/installer.nsh and build/file-icons in step.

const root = join(__dirname, '..')
const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
const nsh = readFileSync(join(root, 'build', 'installer.nsh'), 'utf8')

interface Association {
  ext: string[]
  name: string
  icon: string
}

/** The Windows associations: the `- ext:` items of win.fileAssociations. */
function windowsAssociations(): Association[] {
  const win = yml.slice(yml.indexOf('\nwin:'), yml.indexOf('\nnsis:'))
  const list = win.slice(win.indexOf('  fileAssociations:'), win.indexOf('  signtoolOptions:'))
  return list
    .split(/\n {4}- /)
    .slice(1)
    .map((item) => {
      const field = (key: string): string => item.match(new RegExp(`(?:^|\\n\\s*)${key}: (.+)`))?.[1]?.trim() ?? ''
      return { ext: field('ext').replace(/[[\]]/g, '').split(',').map((e) => e.trim()), name: field('name'), icon: field('icon') }
    })
}

describe('file icons (decisions §91)', () => {
  const associations = windowsAssociations()

  it('every Windows association has its own HonoKit ProgID and its own icon file', () => {
    expect(associations.length).toBeGreaterThan(10)
    expect(new Set(associations.map((a) => a.name)).size).toBe(associations.length)
    expect(new Set(associations.map((a) => a.icon)).size).toBe(associations.length)
    for (const a of associations) {
      expect(a.name, a.ext.join()).toMatch(/^HonoKit\.[A-Z]+$/)
      expect(a.icon, a.name).toMatch(/^file-icons\/[a-z]+$/)
      expect(existsSync(join(root, 'build', `${a.icon}.ico`)), a.icon).toBe(true)
    }
  })

  it('the installer handles exactly the picture types the associations list', () => {
    const listed = associations.filter((a) => a.name !== 'HonoKit.PDF').flatMap((a) => a.ext)
    const handled = [...nsh.matchAll(/!insertmacro \$\{MACRO\} "(\w+)"/g)].map((m) => m[1])
    expect(handled.sort()).toEqual(listed.sort())
    // Defaults are recognised as ours by the "HonoKit." prefix, so a new ProgID needs no new check.
    expect(nsh).not.toMatch(/StrCmp \$0 "HonoKit\.Image"/)
  })

  it('each icon holds every size Windows asks for, as PNG images', () => {
    for (const a of associations) {
      const ico = readFileSync(join(root, 'build', `${a.icon}.ico`))
      expect(ico.readUInt16LE(2), a.icon).toBe(1)
      const count = ico.readUInt16LE(4)
      const sizes = Array.from({ length: count }, (_, i) => ico.readUInt8(6 + 16 * i) || 256)
      expect(sizes, a.icon).toEqual([16, 20, 24, 32, 40, 48, 64, 96, 128, 256])
      for (let i = 0; i < count; i++) {
        const at = ico.readUInt32LE(6 + 16 * i + 12)
        expect(ico.subarray(at + 1, at + 4).toString('latin1'), `${a.icon} entry ${i}`).toBe('PNG')
      }
    }
  })
})
