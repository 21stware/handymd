/* handymd app — cache-first shell for installability & offline editing.
 *
 * BUILD_ID and PRECACHE are rewritten by scripts/build.ts: the bundle name and
 * chunk hashes are only known after bundling, and precaching the shell without
 * the JS entry means "offline" silently depends on the browser HTTP cache.
 * BUILD_ID changes whenever any precached file changes, which both busts the
 * old cache and makes `activate` drop it. The literals below are the dev
 * fallbacks so this file stays runnable unbuilt.
 */
const BUILD_ID = 'dev'
const PRECACHE = ['./', './index.html', './styles.css', './manifest.webmanifest', './favicon.svg']

const CACHE = `handymd-app-shell-${BUILD_ID}`

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

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return

  // Navigation: network-first, fall back to cached shell
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            void caches.open(CACHE).then((c) => c.put('./index.html', copy))
          }
          return res
        })
        // Single-page app: every navigation (including file-handler launches
        // with a query string) resolves to the same shell.
        .catch(async () => (await caches.match('./index.html')) ?? Response.error()),
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
