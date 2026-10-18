// 트립플립 오프라인 지원: 한 번 열었던 화면 파일(같은 주소의 html·js·css·아이콘)을 저장해 두고,
// 인터넷이 안 되면 저장된 것으로 열어 줌. 인터넷이 되면 항상 새 파일을 먼저 받음 (네트워크 우선)
const CACHE = 'tripflip-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return; // 지도·검색 등 외부 요청은 그대로
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      return (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true })) || Response.error();
    }
  })());
});
