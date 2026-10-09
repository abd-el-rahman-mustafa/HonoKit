import { describe, expect, it } from 'vitest'
import { BRAND, isProjectUrl, problemReportUrl, systemLabel } from '@shared/brand'
import { safeLink } from '@shared/links'

/** Which links a document may open, after asking (§81). */
describe('links from a document', () => {
  it('opens web pages and email addresses, named by their site', () => {
    expect(safeLink('https://www.news.example/news?id=1')).toEqual({ url: 'https://www.news.example/news?id=1', host: 'www.news.example', kind: 'web' })
    expect(safeLink('http://Example.COM/a b')?.host).toBe('example.com')
    expect(safeLink('  www.example.com/page  ')).toEqual({ url: 'https://www.example.com/page', host: 'www.example.com', kind: 'web' })
    expect(safeLink('mailto:Editor@News.Example?subject=Hi')).toMatchObject({ host: 'news.example', kind: 'email' })
    // How MuPDF reads a link written "www.example.org/page".
    expect(safeLink('file://www.example.org/page?x=1')).toEqual({ url: 'https://www.example.org/page?x=1', host: 'www.example.org', kind: 'web' })
  })

  it('shows a look-alike site by its real name', () => {
    // Cyrillic "а" in "аpple.com" is a different site: shown as xn--…, not as apple.com.
    expect(safeLink('https://\u0430pple.com/login')?.host).toMatch(/^xn--/)
  })

  it('never opens files, programs, scripts or disguised addresses', () => {
    for (const bad of [
      'file:///C:/Windows/System32/calc.exe',
      'javascript:alert(1)',
      'C:\\Windows\\notepad.exe',
      'ms-settings:privacy',
      'smb://server/share',
      'data:text/html,<script>1</script>',
      'https://bank.example@evil.example/login',
      'https://user:pass@example.com/',
      'mailto:',
      'mailto:a@example.com?attach=C:\\Users\\me\\Documents\\passwords.txt',
      'mailto:a@example.com?subject=x&Attachment=file:///etc/passwd',
      'notes.pdf',
      `https://example.com/${'a'.repeat(3000)}`,
      ''
    ])
      expect(safeLink(bad), bad).toBeNull()
  })
})

/** The project's own pages, which the app opens itself (About; decisions §84). */
describe('project links', () => {
  it('allows the source and releases repositories only', () => {
    for (const ok of [
      BRAND.sourceUrl,
      BRAND.issuesUrl,
      BRAND.releasesUrl,
      'https://github.com/abd-el-rahman-mustafa/HonoKit-Releases/releases/latest',
      'https://github.com/abd-el-rahman-mustafa/HonoKit/issues/new?template=bug_report.yml&version=1.0.0'
    ])
      expect(isProjectUrl(ok), ok).toBe(true)
    for (const bad of [
      'https://github.com/abd-el-rahman-mustafa/HonoKit-Android',
      'https://github.com/abd-el-rahman-mustafa/HonoKitEvil',
      'https://github.com/abd-el-rahman-mustafa/HonoKit-ReleasesX/releases',
      'https://github.com/abd-el-rahman-mustafa',
      'http://github.com/abd-el-rahman-mustafa/HonoKit',
      'https://github.com.evil.example/abd-el-rahman-mustafa/HonoKit',
      'https://evil.example@github.com/abd-el-rahman-mustafa/HonoKit',
      'https://github.com:8443/abd-el-rahman-mustafa/HonoKit',
      'file:///C:/Windows/System32/calc.exe',
      'not a url'
    ])
      expect(isProjectUrl(bad), bad).toBe(false)
  })

  it('names the system', () => {
    expect(systemLabel('win32', '10.0.26100')).toBe('Windows 11 (10.0.26100)')
    expect(systemLabel('win32', '10.0.19045')).toBe('Windows 10 (10.0.19045)')
    expect(systemLabel('darwin', '15.1.0')).toBe('macOS 15.1.0')
    expect(systemLabel('linux', '6.8.0')).toBe('Linux 6.8.0')
  })

  it('fills the bug form with version, system and language, encoded', () => {
    const url = problemReportUrl({ version: '0.18.0', system: 'Windows 11 (10.0.26100)', language: 'ar' })
    expect(url).toBe('https://github.com/abd-el-rahman-mustafa/HonoKit/issues/new?template=bug_report.yml&version=0.18.0&os=Windows%2011%20(10.0.26100)&language=Arabic')
    expect(isProjectUrl(url)).toBe(true)
    const q = new URL(url).searchParams
    expect([q.get('template'), q.get('version'), q.get('os'), q.get('language')]).toEqual(['bug_report.yml', '0.18.0', 'Windows 11 (10.0.26100)', 'Arabic'])
    expect(new URL(problemReportUrl({ version: '1.0.0', system: 'x', language: 'en' })).searchParams.get('language')).toBe('English')
  })
})
