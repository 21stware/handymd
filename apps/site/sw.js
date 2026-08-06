/* handymd landing — optional offline shell for docs/landing only.
 * The installable Markdown editor PWA lives under ./app/ with its own SW.
 * Do not intercept /app/* — leave those to the editor service worker.
 */
/* BUILD_ID and PRECACHE are rewritten by scripts/build.ts — the entry and chunk
 * hashes only exist after bundling, and a shell-only precache leaves the site
 * depending on the browser HTTP cache for its own JS. Literals are dev fallbacks. */
const BUILD_ID = 'dev'
const PRECACHE = ['./', './index.html', './styles.css', './docs.css', './favicon.png']

const CACHE = `handymd-site-shell-${BUILD_ID}`

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

function isEditorAppPath(url) {
  // scope is typically /handymd/; editor is /handymd/app/
  return /\/app(?:\/|$)/.test(url.pathname)
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (isEditorAppPath(url)) return

  // Navigation: network-first, fall back to the page itself and only then the
  // landing shell. Caching under a fixed './index.html' key would let a docs
  // page overwrite the landing page, so store responses under their own URL.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            void caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        })
        .catch(async () => (await caches.match(req)) ?? (await caches.match('./index.html')) ?? Response.error()),
    )
    return
  }

  // Static assets: stale-while-revalidate
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            void caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        })
        // respondWith(undefined) throws; surface a real network error instead
        .catch(() => cached ?? Response.error())
      return cached || network
    }),
  )
})
