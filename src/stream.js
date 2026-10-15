import bigInt from 'big-integer';

/* ------------------------------------------------------------------ *
 * Lado da página do streaming.
 *
 * Registra o service worker, atende os pedidos de faixa que ele manda,
 * e busca no Telegram só o trecho pedido — nunca o arquivo inteiro.
 * ------------------------------------------------------------------ */

const ROTA = '_tdstream';
const ALINHAMENTO = 4096;          // o Telegram exige offset múltiplo disso
const TAMANHO_PEDIDO = 512 * 1024; // teto por requisição da API

const streams = new Map();   // id -> { client, msg, size }
let pronto = null;

/**
 * Pasta onde o app está publicado, com barra no fim. Sai da própria URL em
 * vez da variável do Vite: com `base: ''` ela vem vazia, e o escopo do
 * service worker ficaria errado numa subpasta do GitHub Pages.
 */
function caminhoBase() {
  return new URL('.', location.href).pathname;
}

/** Registra o worker. Devolve false quando o navegador não suporta. */
export function iniciarStreaming(onError) {
  if (!('serviceWorker' in navigator)) return Promise.resolve(false);
  if (pronto) return pronto;

  const base = caminhoBase();
  pronto = navigator.serviceWorker
    .register(`${base}sw.js`, { scope: base })
    .then(() => navigator.serviceWorker.ready)
    .then(async () => {
      // `ready` só garante que o worker está ativo, não que esta aba já é
      // controlada por ele. Sem esperar o controle, a primeira requisição
      // de streaming escapa para a rede e volta o HTML da página.
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          const relogio = setTimeout(resolve, 4000);
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            clearTimeout(relogio);
            resolve();
          }, { once: true });
        });
      }
      navigator.serviceWorker.addEventListener('message', atender);
      return !!navigator.serviceWorker.controller;
    })
    .catch((err) => {
      onError?.(err);
      return false;
    });
  return pronto;
}

async function atender(event) {
  const dados = event.data;
  if (!dados || dados.type !== 'td-range') return;
  const porta = event.ports[0];
  if (!porta) return;

  try {
    const entrada = streams.get(dados.streamId);
    if (!entrada) throw new Error('este stream não está mais aberto');
    const bytes = await lerFaixa(entrada, dados.inicio, dados.fim);
    // transfere o buffer em vez de copiar
    porta.postMessage({ chunk: bytes }, [bytes.buffer]);
  } catch (err) {
    porta.postMessage({ error: err?.message || String(err) });
  }
}

/**
 * Busca os bytes [inicio, fim] do arquivo.
 *
 * Dois detalhes do protocolo que, se ignorados, falham em silêncio:
 * o offset precisa ser múltiplo de 4096, e o `limit` do iterDownload
 * conta BLOCOS, não bytes.
 */
async function lerFaixa({ client, msg }, inicio, fim) {
  const alinhado = Math.floor(inicio / ALINHAMENTO) * ALINHAMENTO;
  const sobra = inicio - alinhado;
  const precisa = fim - inicio + 1;
  const total = sobra + precisa;
  const blocos = Math.ceil(total / TAMANHO_PEDIDO);

  const partes = [];
  let obtido = 0;

  for await (const parte of client.iterDownload({
    file: msg.media,
    offset: bigInt(alinhado),
    limit: blocos,
    requestSize: TAMANHO_PEDIDO,
  })) {
    partes.push(parte);
    obtido += parte.length;
    if (obtido >= total) break;
  }

  const tudo = new Uint8Array(obtido);
  let at = 0;
  for (const p of partes) { tudo.set(p, at); at += p.length; }
  return tudo.slice(sobra, sobra + precisa);
}

/** Abre um endereço que o player pode consumir por faixas. */
export function abrirStream(client, it) {
  const id = crypto.randomUUID();
  const size = Number(it.man.s || 0);
  streams.set(id, { client, msg: it.msg, size });

  const params = new URLSearchParams({
    size: String(size),
    mime: it.man.m || 'application/octet-stream',
  });
  return { id, url: `${caminhoBase()}${ROTA}/${id}?${params}` };
}

export function fecharStream(id) { streams.delete(id); }

/** Streaming só vale para arquivo em claro: cifrado teria de decifrar antes. */
export function podeStreamar(it) {
  return !it.man.e && !it.man.locked && Number(it.man.s || 0) > 0;
}
