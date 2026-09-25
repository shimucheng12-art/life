// 碎碎念 PWA Service Worker：网络优先 + 离线兜底（API 跨域不缓存）
const CACHE = 'suinian-v1.5.4';
const SHELL = ['./life.html', './manifest.webmanifest', './pwa/icon-192.png', './pwa/icon-512.png', './pwa/apple-touch-icon.png', './pwa/icon-maskable-512.png'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);
    if (url.origin !== location.origin || e.request.method !== 'GET') return; // 云端API不经过SW
    e.respondWith(
        fetch(e.request).then(r => {
            const copy = r.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
            return r;
        }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(m => m || caches.match('./life.html')))
    );
});
