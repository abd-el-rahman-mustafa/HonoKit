import { execFile } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Result } from '@shared/ipc'

/**
 * Scanning from a scanner (docs/decisions.md §61) through Windows Image Acquisition: Windows' own
 * scanner window (pick the scanner, preview, colour, resolution) opens, and the scanned page is
 * saved as a JPEG in a temporary folder, ready for the Scan board. Nothing leaves the PC.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $dialog = New-Object -ComObject WIA.CommonDialog
  # Scanner, colour, best quality, JPEG; let Windows show its own window; no error on cancel.
  $image = $dialog.ShowAcquireImage(1, 1, 131072, '{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}', $false, $true, $false)
  if ($null -eq $image) { 'CANCELLED'; exit 0 }
  if (Test-Path $env:HONO_SCAN_OUT) { Remove-Item $env:HONO_SCAN_OUT }
  $image.SaveFile($env:HONO_SCAN_OUT)
  'OK'
} catch {
  'ERROR ' + $_.Exception.HResult + ' ' + $_.Exception.Message
}
`

/**
 * One folder for scanned pages and the pictures of PDFs' pages (Scan book); what earlier runs of
 * the app left there is removed the first time it is used.
 */
const FOLDER = join(tmpdir(), 'hono-scan')
let cleaned = false

export async function scanFolder(): Promise<string> {
  if (!cleaned) {
    cleaned = true
    await rm(FOLDER, { recursive: true, force: true }).catch(() => undefined)
  }
  await mkdir(FOLDER, { recursive: true })
  return FOLDER
}

export async function acquireFromScanner(): Promise<Result<string | null>> {
  const out = join(await scanFolder(), `scan-${Date.now()}.jpg`)
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64')
  const text = await new Promise<string>((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { env: { ...process.env, HONO_SCAN_OUT: out }, windowsHide: true, timeout: 15 * 60_000 }, (error, stdout) =>
      resolve(error && !stdout ? `ERROR ${error.message}` : String(stdout ?? '').trim())
    )
  })
  if (text.endsWith('CANCELLED')) return { ok: true, value: null }
  if (text.endsWith('OK')) {
    try {
      if ((await stat(out)).size > 0) return { ok: true, value: out }
    } catch {
      // fall through to the error below
    }
  }
  // WIA_S_NO_DEVICE_AVAILABLE (0x80210015): no scanner is connected or installed.
  if (/-2145320939|80210015|no.*device/i.test(text)) return { ok: false, error: { code: 'unsupported', message: 'No scanner was found. Connect it, or install it in Windows Settings → Printers & scanners.' } }
  return { ok: false, error: { code: 'io', message: `The scanner did not scan: ${text.replace(/^ERROR\s*/, '')}` } }
}
