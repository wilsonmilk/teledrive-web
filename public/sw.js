/* ------------------------------------------------------------------ *
 * Service worker de streaming.
 *
 * O player de vídeo precisa de uma URL que aceite pedidos de faixa
 * ("me dê os bytes 5.000.000 a 5.500.000"). Um blob: só existe depois
 * que o arquivo inteiro está na memória — inviável para 1 GB.
 *
 * Então aqui a gente inventa uma URL. Este worker intercepta
 * /_tdstream/<id>, traduz o cabeçalho Range num pedido à página, e a
 * página busca só aquele trecho no Telegram.
 *
 * Arquivo sem bundler de propósito: service worker roda sozinho.
 * ------------------------------------------------------------------ */

const ROTA = '/_tdstream/';
const MAX_PEDACO = 4 * 1024 * 1024;   // teto por resposta
const TEMPO_LIMITE = 90_000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!url.pathname.includes(ROTA)) return;
  event.respondWith(responder(event).catch((err) =>
    new Response(String(err && err.message || err), { status: 500 })));
});

async function responder(event) {
  const url = new URL(event.request.url);
  const streamId = url.pathname.split(ROTA)[1];
  const size = Number(url.searchParams.get('size') || 0);
  const mime = url.searchParams.get('mime') || 'application/octet-stream';
  if (!streamId || !size) return new Response('stream desconhecido', { status: 404 });

  const range = event.request.headers.get('Range');
  let inicio = 0;
  let fim = size - 1;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      if (m[1] !== '') inicio = Number(m[1]);
      if (m[2] !== '') fim = Number(m[2]);
      else fim = Math.min(inicio + MAX_PEDACO - 1, size - 1);
    }
  } else {
    // Sem Range, devolve só o começo: o player pede o resto conforme precisa.
    fim = Math.min(MAX_PEDACO - 1, size - 1);
  }

  if (fim >= size) fim = size - 1;
  if (fim - inicio + 1 > MAX_PEDACO) fim = inicio + MAX_PEDACO - 1;
  if (inicio > fim) return new Response(null, { status: 416 });

  const bytes = await pedirAPagina(event.clientId, { streamId, inicio, fim });

  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Content-Length': String(bytes.byteLength),
    'Cache-Control': 'no-store',
    'Content-Range': `bytes ${inicio}-${fim}/${size}`,
  };
  // 206 sempre: é o que faz o player entender que pode pular no tempo.
  return new Response(bytes, { status: 206, headers });
}

async function pedirAPagina(clientId, payload) {
  let cliente = clientId ? await self.clients.get(clientId) : null;
  if (!cliente) {
    // Requisição de mídia costuma vir sem clientId; usa qualquer aba aberta.
    const todas = await self.clients.matchAll({ type: 'window' });
    cliente = todas[0];
  }
  if (!cliente) throw new Error('nenhuma aba do TeleDrive aberta');

  return new Promise((resolve, reject) => {
    const canal = new MessageChannel();
    const relogio = setTimeout(() => reject(new Error('tempo esgotado buscando o trecho')), TEMPO_LIMITE);
    canal.port1.onmessage = (e) => {
      clearTimeout(relogio);
      if (e.data && e.data.error) reject(new Error(e.data.error));
      else resolve(e.data.chunk);
    };
    cliente.postMessage({ type: 'td-range', ...payload }, [canal.port2]);
  });
}
