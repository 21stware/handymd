/**
 * Writing prefs — theme / type / measure. Persisted in localStorage.
 * Applied as CSS variables on <html> so the shell + SDK (.handymd vars) stay in sync.
 */

export type ThemeId = 'paper' | 'sepia' | 'light' | 'dark'
export type FontId = 'sans' | 'serif' | 'mono' | 'song'

export type AppSettings = {
  theme: ThemeId
  font: FontId
  fontSize: number
  lineHeight: number
  /** Content column max-width in px */
  contentWidth: number
}

const STORAGE_KEY = 'handymd-app-settings-v1'

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'paper',
  font: 'sans',
  fontSize: 17,
  lineHeight: 1.8,
  contentWidth: 720,
}

const FONT_STACKS: Record<FontId, string> = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", sans-serif',
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", Georgia, serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, "Cascadia Code", monospace',
  song: '"Songti SC", "STSong", "Noto Serif CJK SC", "Source Han Serif SC", serif',
}

type ThemeTokens = {
  paper: string
  paperDeep: string
  ink: string
  inkSoft: string
  accent: string
  line: string
  card: string
  statusBg: string
  /** SDK tokens */
  hmFg: string
  hmFgDim: string
  hmMarker: string
  hmAccent: string
  hmCodeFg: string
  hmCodeBg: string
  hmCodeblockBg: string
  hmQuoteBorder: string
  hmQuoteFg: string
  hmTagBg: string
  hmTagFg: string
  hmHr: string
  hmTableBorder: string
  hmTableHeaderBg: string
  hmSelection: string
  colorScheme: 'light' | 'dark'
}

const THEMES: Record<ThemeId, ThemeTokens> = {
  paper: {
    paper: '#f4f1ea',
    paperDeep: '#eae5da',
    ink: '#181715',
    inkSoft: '#6f6960',
    accent: '#c65335',
    line: '#d8d2c7',
    card: '#fbfaf6',
    statusBg: 'rgba(251, 250, 246, 0.9)',
    hmFg: '#34312d',
    hmFgDim: '#969087',
    hmMarker: '#bbb3a7',
    hmAccent: '#c65335',
    hmCodeFg: '#a8402a',
    hmCodeBg: 'rgba(135, 131, 120, 0.13)',
    hmCodeblockBg: '#f6f3ee',
    hmQuoteBorder: '#ddd6ca',
    hmQuoteFg: '#6f6a60',
    hmTagBg: '#efe9df',
    hmTagFg: '#8a7d68',
    hmHr: '#e2dccf',
    hmTableBorder: '#e2dccf',
    hmTableHeaderBg: 'rgba(135, 131, 120, 0.08)',
    hmSelection: 'rgba(201, 96, 60, 0.18)',
    colorScheme: 'light',
  },
  sepia: {
    paper: '#f4ecd8',
    paperDeep: '#e8dcc2',
    ink: '#3b2f2f',
    inkSoft: '#8b7355',
    accent: '#a65b3a',
    line: '#e0d2b8',
    card: '#faf3e3',
    statusBg: 'rgba(250, 243, 227, 0.9)',
    hmFg: '#3b2f2f',
    hmFgDim: '#9a8568',
    hmMarker: '#c4b08a',
    hmAccent: '#a65b3a',
    hmCodeFg: '#9c3d2e',
    hmCodeBg: 'rgba(140, 110, 70, 0.12)',
    hmCodeblockBg: '#ebe1c8',
    hmQuoteBorder: '#d4c4a4',
    hmQuoteFg: '#6b5844',
    hmTagBg: '#e8dcc4',
    hmTagFg: '#7a6548',
    hmHr: '#d9cbb0',
    hmTableBorder: '#d9cbb0',
    hmTableHeaderBg: 'rgba(140, 110, 70, 0.1)',
    hmSelection: 'rgba(166, 91, 58, 0.2)',
    colorScheme: 'light',
  },
  light: {
    paper: '#ffffff',
    paperDeep: '#f0f0ee',
    ink: '#1a1a1a',
    inkSoft: '#6b6b6b',
    accent: '#c9603c',
    line: '#e8e8e8',
    card: '#f7f7f7',
    statusBg: 'rgba(255, 255, 255, 0.92)',
    hmFg: '#1a1a1a',
    hmFgDim: '#8a8a8a',
    hmMarker: '#b0b0b0',
    hmAccent: '#c9603c',
    hmCodeFg: '#b8433c',
    hmCodeBg: 'rgba(0, 0, 0, 0.06)',
    hmCodeblockBg: '#f4f4f4',
    hmQuoteBorder: '#ddd',
    hmQuoteFg: '#555',
    hmTagBg: '#eee',
    hmTagFg: '#666',
    hmHr: '#e5e5e5',
    hmTableBorder: '#e5e5e5',
    hmTableHeaderBg: 'rgba(0, 0, 0, 0.04)',
    hmSelection: 'rgba(201, 96, 60, 0.18)',
    colorScheme: 'light',
  },
  dark: {
    paper: '#181715',
    paperDeep: '#24221f',
    ink: '#e8e4dc',
    inkSoft: '#9a948a',
    accent: '#e07a55',
    line: '#33302c',
    card: '#252320',
    statusBg: 'rgba(37, 35, 32, 0.92)',
    hmFg: '#e8e4dc',
    hmFgDim: '#8a847a',
    hmMarker: '#6a645c',
    hmAccent: '#e07a55',
    hmCodeFg: '#f0a090',
    hmCodeBg: 'rgba(255, 255, 255, 0.08)',
    hmCodeblockBg: '#252320',
    hmQuoteBorder: '#4a4540',
    hmQuoteFg: '#b0a89c',
    hmTagBg: '#33302c',
    hmTagFg: '#b0a89c',
    hmHr: '#3a3632',
    hmTableBorder: '#3a3632',
    hmTableHeaderBg: 'rgba(255, 255, 255, 0.05)',
    hmSelection: 'rgba(224, 122, 85, 0.28)',
    colorScheme: 'dark',
  },
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<AppSettings>
    return normalize({ ...DEFAULT_SETTINGS, ...parsed })
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalize(s)))
  } catch {
    /* quota */
  }
}

function normalize(s: AppSettings): AppSettings {
  const theme = (['paper', 'sepia', 'light', 'dark'] as ThemeId[]).includes(s.theme)
    ? s.theme
    : DEFAULT_SETTINGS.theme
  const font = (['sans', 'serif', 'mono', 'song'] as FontId[]).includes(s.font)
    ? s.font
    : DEFAULT_SETTINGS.font
  return {
    theme,
    font,
    fontSize: clamp(Number(s.fontSize) || DEFAULT_SETTINGS.fontSize, 13, 28),
    lineHeight: clamp(Number(s.lineHeight) || DEFAULT_SETTINGS.lineHeight, 1.3, 2.4),
    contentWidth: clamp(Number(s.contentWidth) || DEFAULT_SETTINGS.contentWidth, 480, 1100),
  }
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

/** Paint CSS variables used by shell + SDK. */
export function applySettings(s: AppSettings): void {
  const t = THEMES[s.theme]
  const font = FONT_STACKS[s.font]
  const root = document.documentElement

  root.dataset.theme = s.theme
  root.style.colorScheme = t.colorScheme

  root.style.setProperty('--paper', t.paper)
  root.style.setProperty('--paper-deep', t.paperDeep)
  root.style.setProperty('--ink', t.ink)
  root.style.setProperty('--ink-soft', t.inkSoft)
  root.style.setProperty('--accent', t.accent)
  root.style.setProperty('--line', t.line)
  root.style.setProperty('--card', t.card)
  root.style.setProperty('--status-bg', t.statusBg)
  root.style.setProperty('--font', font)
  root.style.setProperty('--font-size', `${s.fontSize}px`)
  root.style.setProperty('--line-height', String(s.lineHeight))
  root.style.setProperty('--content-width', `${s.contentWidth}px`)

  // Mapped into .handymd via apps/app/styles.css
  root.style.setProperty('--app-hm-fg', t.hmFg)
  root.style.setProperty('--app-hm-fg-dim', t.hmFgDim)
  root.style.setProperty('--app-hm-marker', t.hmMarker)
  root.style.setProperty('--app-hm-accent', t.hmAccent)
  root.style.setProperty('--app-hm-code-fg', t.hmCodeFg)
  root.style.setProperty('--app-hm-code-bg', t.hmCodeBg)
  root.style.setProperty('--app-hm-codeblock-bg', t.hmCodeblockBg)
  root.style.setProperty('--app-hm-quote-border', t.hmQuoteBorder)
  root.style.setProperty('--app-hm-quote-fg', t.hmQuoteFg)
  root.style.setProperty('--app-hm-tag-bg', t.hmTagBg)
  root.style.setProperty('--app-hm-tag-fg', t.hmTagFg)
  root.style.setProperty('--app-hm-hr', t.hmHr)
  root.style.setProperty('--app-hm-table-border', t.hmTableBorder)
  root.style.setProperty('--app-hm-table-header-bg', t.hmTableHeaderBg)
  root.style.setProperty('--app-hm-selection', t.hmSelection)

  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', t.paper)
}
