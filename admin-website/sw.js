// Sidekick admin website: offline copy of the website's own pages and files.
// - Network first: online visitors always get the newest version, and the copy is updated.
// - Without internet, the saved copy opens instead, so the page can show its
//   "No internet connection" pop-up and finish loading when the connection is back.
// - API requests (account data) are never stored or answered from the copy.
const CACHE = 'sidekick-admin-v1';
const FILES = [
  'css/admin.css', 'css/admin-v3.css', 'css/admin-dark.css',
  'js/admin.js', 'js/theme.js', 'js/auth-guard.js', 'js/config.js',
  'assets/sidekick-logo-64.png', 'assets/sidekick-logo-192.png', 'assets/sidekick-logo-512.png',
];

self.addEventListener('install', (event) => {
  // Each file on its own: one missing file must not stop the others from being saved.
  event.waitUntil(caches.open(CACHE)
    .then((cache) => Promise.allSettled(FILES.map((file) => cache.add(new Request(file, { cache: 'reload' })))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key.startsWith('sidekick-admin-') && key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>No internet connection · Sidekick Admin</title>
<style>
  html, body { margin: 0; height: 100%; font-family: Arial, Helvetica, sans-serif; background: #f4f9fb; color: #163457; }
  body { display: grid; place-items: center; padding: 16px; box-sizing: border-box; }
  .box { max-width: 360px; padding: 28px 26px; border-radius: 22px; background: #fff; box-shadow: 0 20px 50px rgba(13, 32, 54, .14); text-align: center; }
  h1 { margin: 12px 0 8px; font-size: 1.3rem; }
  p { margin: 0 0 18px; color: #56708a; line-height: 1.5; }
  button { border: 0; border-radius: 12px; padding: 11px 22px; font: inherit; font-weight: 700; color: #fff; background: #2c91b0; cursor: pointer; }
  svg { width: 40px; height: 40px; color: #2c91b0; }
  @media (prefers-color-scheme: dark) { html, body { background: #0c1722; color: #e2edf5; } .box { background: #122130; } p { color: #9db3c5; } }
</style></head><body><div class="box" role="alert">
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 2l20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 4.17-2.65"/><path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"/><path d="M16.85 11.25a10 10 0 0 1 2.22 1.68"/><path d="M5 13a10 10 0 0 1 5.24-2.76"/><path d="M12 20h.01"/></svg>
<h1>No internet connection</h1>
<p>Check your Wi-Fi or network cable. This page will open as soon as you’re back online.</p>
<button type="button" onclick="location.reload()">Try again</button>
</div><script>window.addEventListener('online', function () { location.reload(); });</script></body></html>`;

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/api/') || url.pathname === '/health' || url.pathname.endsWith('/sw.js')) return;

  event.respondWith(fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
  }).catch(async () => {
    const saved = await caches.match(request, { ignoreSearch: true });
    if (saved) return saved;
    if (request.mode === 'navigate') {
      return new Response(OFFLINE_PAGE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return Response.error();
  }));
});
