import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'

/**
 * Right-click menus, as every desktop editor has (Acrobat: on the page, on selected text,
 * on objects in Edit, on page thumbnails). One menu at a time, opened with `openMenu`.
 * Keyboard: the first item has focus; arrows, Home and End move; Enter chooses; Escape or Tab
 * closes and gives focus back. In Arabic the menu opens towards the start side, mirrored.
 */

export type MenuEntry =
  | {
      label: string
      icon?: ReactNode
      shortcut?: string
      onClick: () => void
      disabled?: boolean
      danger?: boolean
      /** Why the item is unavailable, or more about it: shown as its tooltip. */
      hint?: string
      /** For tests and the smoke run. */
      id?: string
    }
  | 'separator'

interface MenuState {
  at: { x: number; y: number } | null
  items: MenuEntry[]
  label?: string
  /** What had focus before, to give it back on close. */
  back: HTMLElement | null
}

const useMenu = create<MenuState>(() => ({ at: null, items: [], back: null }))

/** True while a menu is open (shortcuts like Escape then belong to the menu). */
export const menuIsOpen = (): boolean => !!useMenu.getState().at
export const useMenuOpen = (): boolean => useMenu((s) => !!s.at)

export function openMenu(e: React.MouseEvent | MouseEvent, items: MenuEntry[], label?: string): void {
  e.preventDefault()
  e.stopPropagation()
  // Drop separators at the ends or next to each other.
  const clean = items.filter((x, i, all) => x !== 'separator' || (i > 0 && i < all.length - 1 && all[i - 1] !== 'separator'))
  if (!clean.length) return
  // Opened from the keyboard (Enter on ⋯, the menu key, Shift+F10): place it at the element.
  let at = { x: e.clientX, y: e.clientY }
  const target = e.currentTarget instanceof HTMLElement ? e.currentTarget : null
  if (target && (e.detail === 0 || (at.x === 0 && at.y === 0))) {
    const r = target.getBoundingClientRect()
    const rtl = document.documentElement.dir === 'rtl'
    at = { x: rtl ? r.right : r.left, y: r.bottom }
  }
  const back = document.activeElement instanceof HTMLElement ? document.activeElement : null
  useMenu.setState({ at, items: clean, label, back })
}

export function closeMenu(): void {
  const { at, back } = useMenu.getState()
  if (!at) return
  useMenu.setState({ at: null, back: null })
  if (back?.isConnected) back.focus({ preventScroll: true })
}

export function ContextMenu() {
  const { at, items, label } = useMenu()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Keep the menu inside the window; in right-to-left it opens towards the left of the pointer.
  useLayoutEffect(() => {
    if (!at || !ref.current) return setPos(null)
    const r = ref.current.getBoundingClientRect()
    const rtl = document.documentElement.dir === 'rtl'
    const left = rtl ? at.x - r.width : at.x
    setPos({ left: Math.max(6, Math.min(left, window.innerWidth - r.width - 6)), top: Math.max(6, Math.min(at.y, window.innerHeight - r.height - 6)) })
  }, [at])

  // The first item takes the focus, so the arrows work at once.
  useEffect(() => {
    if (!pos) return
    const list = buttons()
    ;(list.find((b) => !b.hasAttribute('aria-disabled')) ?? list[0])?.focus({ preventScroll: true })
  }, [pos])

  useEffect(() => {
    if (!at) return
    const down = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) closeMenu()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeMenu()
      }
    }
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', closeMenu)
    window.addEventListener('wheel', closeMenu, { passive: true })
    window.addEventListener('resize', closeMenu)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', closeMenu)
      window.removeEventListener('wheel', closeMenu)
      window.removeEventListener('resize', closeMenu)
    }
  }, [at])

  const buttons = (): HTMLButtonElement[] => [...(ref.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? [])]

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const list = buttons()
    if (!list.length) return
    const i = list.indexOf(document.activeElement as HTMLButtonElement)
    const go = (n: number): void => {
      e.preventDefault()
      list[(n + list.length) % list.length]!.focus()
    }
    if (e.key === 'ArrowDown') go(i + 1)
    else if (e.key === 'ArrowUp') go(i < 0 ? list.length - 1 : i - 1)
    else if (e.key === 'Home' || e.key === 'PageUp') go(0)
    else if (e.key === 'End' || e.key === 'PageDown') go(list.length - 1)
    else if (e.key === 'Tab') {
      e.preventDefault()
      closeMenu()
    } else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      // Typing a letter moves to the next item that starts with it.
      const k = e.key.toLocaleLowerCase()
      const next = [...list.slice(i + 1), ...list.slice(0, i + 1)].find((b) => (b.dataset.label ?? '').toLocaleLowerCase().startsWith(k))
      if (next) {
        e.preventDefault()
        next.focus()
      }
    }
  }

  if (!at) return null
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-context-menu=""
      className="fixed z-50 max-h-[calc(100vh-12px)] max-w-[min(360px,calc(100vw-12px))] min-w-56 overflow-y-auto rounded-lg border border-line bg-surface p-1 text-ink shadow-xl"
      style={pos ?? { left: at.x, top: at.y, visibility: 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
    >
      {items.map((item, i) =>
        item === 'separator' ? (
          <div key={i} role="separator" className="mx-1 my-1 h-px bg-line" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            // aria-disabled, not disabled: the item stays reachable and its tooltip says why (APG).
            aria-disabled={item.disabled || undefined}
            title={item.hint}
            aria-keyshortcuts={item.shortcut}
            data-label={item.label}
            data-menu-item={item.id}
            onClick={() => {
              if (item.disabled) return
              closeMenu()
              item.onClick()
            }}
            className={clsx(
              'flex h-8 w-full items-center gap-2.5 rounded px-2.5 text-start text-[13px] whitespace-nowrap outline-none focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset',
              item.disabled ? 'cursor-default opacity-45' : 'hover:bg-surface-2',
              item.danger && 'text-danger'
            )}
          >
            <span className={clsx('flex w-4 shrink-0 justify-center', item.danger ? 'text-danger' : 'text-muted')}>{item.icon}</span>
            <span className="flex-1">{item.label}</span>
            {item.shortcut && (
              <span className="ps-4 text-[11px] text-faint" dir="ltr">
                {item.shortcut}
              </span>
            )}
          </button>
        )
      )}
    </div>
  )
}
