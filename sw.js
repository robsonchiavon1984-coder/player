/* Auris — service worker
 * Guarda os arquivos do próprio app para abrir sem internet.
 * Os áudios são guardados pela página no cache "auris-audio-v1", que este arquivo não apaga.
 * Ao publicar uma versão nova, altere VERSAO para que os aparelhos baixem os arquivos novos.
 */
const VERSAO = 'auris-app-1.0.0';
const CACHE_AUDIO = 'auris-audio-v1';
const ARQUIVOS = [
  './',
  'index.html',
  'estilos.css',
  'app.js',
  'config.js',
  'manifest.webmanifest',
  'icone.svg',
  'icone-192.png',
  'icone-512.png',
];

self.addEventListener('install', evento => {
  evento.waitUntil(
    caches.open(VERSAO)
      .then(c => c.addAll(ARQUIVOS.map(a => new Request(a, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', evento => {
  evento.waitUntil(
    caches.keys()
      .then(nomes => Promise.all(nomes.filter(n => n !== VERSAO && n !== CACHE_AUDIO && n.startsWith('auris-')).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

// Rede primeiro (para receber atualizações), com o cache como reserva quando estiver offline.
self.addEventListener('fetch', evento => {
  const req = evento.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // Google e Drive: sempre direto
  if (url.pathname.includes('/__audio__/')) return;      // áudios: tratados pela página

  evento.respondWith((async () => {
    const cache = await caches.open(VERSAO);
    try {
      const controle = new AbortController();
      const limite = setTimeout(() => controle.abort(), 4000);
      const resp = await fetch(req, { signal: controle.signal });
      clearTimeout(limite);
      if (resp.ok && resp.type === 'basic') cache.put(req, resp.clone());
      return resp;
    } catch {
      const guardado = await cache.match(req, { ignoreSearch: true })
        || (req.mode === 'navigate' ? await cache.match('index.html') : null);
      return guardado || new Response('Sem conexão.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  })());
});
