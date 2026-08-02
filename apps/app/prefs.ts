/**
 * Minimal prefs — only font size is user-tunable (⌘+/⌘−).
 * Theme follows the system light / dark preference.
 */

const STORAGE_KEY = 'handymd-app-fontsize-v1'
const DEFAULT_SIZE = 17
const MIN_SIZE = 13
const MAX_SIZE = 28

export function loadFontSize(): number {
  try {
    const n = Number(localStorage.getItem(STORAGE_KEY))
    if (Number.isFinite(n)) return clamp(n, MIN_SIZE, MAX_SIZE)
  } catch {
    /* private mode */
  }
  return DEFAULT_SIZE
}

export function saveFontSize(size: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(clamp(size, MIN_SIZE, MAX_SIZE)))
  } catch {
    /* quota */
  }
}

export function applyFontSize(size: number): number {
  const next = clamp(size, MIN_SIZE, MAX_SIZE)
  document.documentElement.style.setProperty('--font-size', `${next}px`)
  return next
}

export function bumpFontSize(delta: number): number {
  const current =
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--font-size')) ||
    loadFontSize()
  const next = applyFontSize(current + delta)
  saveFontSize(next)
  return next
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

/** Sync theme-color meta to the active system scheme. */
export function syncThemeColor(): void {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', dark ? '#141312' : '#f3f1ec')
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
  document.documentElement.dataset.scheme = dark ? 'dark' : 'light'
}
