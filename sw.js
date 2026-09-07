/* ContiListen service worker.
   Network-first for the page so updates land as soon as you're online, with a
   cached copy behind it so a flaky train connection still opens the app. */

const CACHE = 'contilisten-v1';
const SHELL = ['./', './index.html'];

self.addEventListener('install', event => {
  // addAll rejects the whole install if any URL 404s, which would leave the
  // worker stuck. Cache what we can and move on.
  event.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
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

  // Never cache API traffic â€” a stale playback position is worse than none.
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
        // Never cache an error page â€” that is how a blank screen becomes permanent.
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request).then(hit => hit || caches.match('./index.html')))
  );
});
