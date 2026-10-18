// BlockHunt service worker — makes the game installable and lets free play load offline.
// Network-first: when online the player always gets the newest deploy; the cache is only a
// fallback for when there's no connection. Blockchain RPC and the score server are never cached.
const CACHE = 'blockhunt-v1'
const CORE = [
  './',
  'index.html',
  'manifest.json',
  'js/puzzle.js',
  'js/tournament.js',
  'js/share.js',
  'assets/logo.webp',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'assets/chars/owl.webp'
]

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).catch(() => {}))
  self.skipWaiting()
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', e => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // wallets, RPC, score server, fonts: straight to network

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {})
        }
        return res
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined))
      )
  )
})

self.addEventListener('notificationclick', e => {
  e.notification.close()
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const open = list.find(c => c.url.startsWith(self.registration.scope))
      return open ? open.focus() : self.clients.openWindow(self.registration.scope)
    })
  )
})
