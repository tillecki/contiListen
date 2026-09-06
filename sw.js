/* ContiListen service worker.
   Network-first for the page so updates land as soon as you're online, with a
   cached copy behind it so a flaky train connection still opens the app. */

const CACHE = 'contilisten-v1';
const SHELL = ['./', './index.html'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache API traffic — a stale playback position is worse than none.
  if (url.hostname.endsWith('spotify.com') || url.hostname.endsWith('github.com')) return;

  // Album art: cache-first, it never changes.
  if (url.hostname.includes('scdn.co')) {
    event.respondWith(
      caches.match(request).then(hit => hit || fetch(request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(request, copy));
        return res;
      }).catch(() => hit))
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(request, copy));
        return res;
      })
      .catch(() => caches.match(request).then(hit => hit || caches.match('./index.html')))
  );
});
