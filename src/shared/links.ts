/**
 * Web links in a document (decisions §81). A PDF can point anywhere, so a link opens only after
 * the person says yes (or has said "always" for that site), and only these kinds: a web page
 * (http, https) or an email (mailto). Everything else — files, javascript:, programs — never opens.
 * Checked in the window (to ask) and again in main (to open), so a document cannot get around it.
 */

export interface SafeLink {
  /** The address as it will be opened. */
  url: string
  /** What the person is asked about and what "always allow" remembers: the site's name in plain
   *  ASCII (look-alike letters show as xn--…), or the email's domain. */
  host: string
  kind: 'web' | 'email'
}

const MAX = 2048

export function safeLink(raw: string): SafeLink | null {
  const text = raw.trim()
  if (!text || text.length > MAX) return null
  let u: URL
  try {
    u = new URL(text)
  } catch {
    // Many PDFs write "www.example.com" with no scheme; Acrobat opens those as web pages.
    if (!/^www\.[^\s/]+\.[^\s/]+/i.test(text)) return null
    try {
      u = new URL(`https://${text}`)
    } catch {
      return null
    }
  }
  // MuPDF reads a link written "www.example.org/page" as file://www.example.org/page: that is the
  // web page the author meant (found on Android, 2026-10-09). Any other file: address stays refused.
  if (u.protocol === 'file:' && /^www\.[^.]+\./i.test(u.hostname)) {
    try {
      u = new URL(`https://${u.hostname}${u.pathname}${u.search}${u.hash}`)
    } catch {
      return null
    }
  }
  if (u.protocol === 'mailto:') {
    const to = decodeURIComponent(u.pathname.split(',')[0] ?? '')
    const domain = /@([^@\s]+)$/.exec(to)?.[1]?.toLowerCase()
    if (!domain) return null
    // Some mail apps take ?attach=C:\… and attach that file: a document must not pick files to send.
    for (const key of u.searchParams.keys()) if (/^attach/i.test(key)) return null
    return { url: u.href, host: domain, kind: 'email' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  // "https://bank.example@evil.example" shows one site and opens another: refused.
  if (u.username || u.password) return null
  if (!u.hostname) return null
  return { url: u.href, host: u.hostname.toLowerCase(), kind: 'web' }
}

/** Sites the person allowed to open without asking. */
export const MAX_TRUSTED_HOSTS = 200
