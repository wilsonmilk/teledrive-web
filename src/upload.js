import { Buffer } from 'buffer';
import { Api } from 'telegram';
import { readBigIntFromBuffer, generateRandomBytes, sleep } from 'telegram/Helpers.js';
import { encryptBlobStream, encryptedSizeOf } from './crypto.js';

/* ------------------------------------------------------------------ *
 * Envio em pedaços.
 *
 * O `uploadFile` do GramJS monta o arquivo inteiro num Buffer antes de
 * enviar a primeira parte. Num vídeo de algumas centenas de MB isso
 * aloca o arquivo duas vezes e bloqueia a thread principal — o Chrome
 * declara a aba travada (RESULT_CODE_HUNG) e oferece matá-la.
 *
 * Aqui cada parte é lida do disco só no momento de subir, direto do
 * Blob. A memória usada fica no tamanho de uma parte vezes o número de
 * envios simultâneos, independentemente do tamanho do arquivo.
 * ------------------------------------------------------------------ */

const KB = 1024;
const LIMITE_ARQUIVO_GRANDE = 10 * 1024 * 1024;  // acima disso, SaveBigFilePart
const PARALELOS = 4;
const ESPERA_RECONEXAO = 1000;
const MAX_TENTATIVAS = 6;

/** Mesma escala do GramJS: parte maior para arquivo maior. */
function tamanhoDaParte(size) {
  if (size < 100 * 1024 * 1024) return 128 * KB;
  if (size < 750 * 1024 * 1024) return 256 * KB;
  return 512 * KB;
}

/* --------------------------- fontes de bytes --------------------------- */

/** Lê o arquivo como está, fatia por fatia, sem cópia intermediária. */
export function fonteEmClaro(blob) {
  let pos = 0;
  return {
    size: blob.size,
    async proximo(quantos) {
      const fim = Math.min(pos + quantos, blob.size);
      if (fim <= pos) return new Uint8Array(0);
      const pedaco = new Uint8Array(await blob.slice(pos, fim).arrayBuffer());
      pos = fim;
      return pedaco;
    },
  };
}

/**
 * Cifra enquanto envia. O gerador entrega os pedaços TDE1 na ordem, e
 * aqui eles são reagrupados no tamanho de parte que o Telegram espera —
 * os dois tamanhos não coincidem, então sobra um resto entre as leituras.
 */
export function fonteCifrada(blob, contentKey, onCifrando) {
  const gen = encryptBlobStream(contentKey, blob, onCifrando);
  let resto = new Uint8Array(0);
  let acabou = false;

  return {
    size: encryptedSizeOf(blob.size),
    async proximo(quantos) {
      while (resto.length < quantos && !acabou) {
        const { value, done } = await gen.next();
        if (done) { acabou = true; break; }
        const juntos = new Uint8Array(resto.length + value.length);
        juntos.set(resto, 0);
        juntos.set(value, resto.length);
        resto = juntos;
      }
      const n = Math.min(quantos, resto.length);
      const saida = resto.slice(0, n);
      resto = resto.subarray(n);
      return saida;
    },
  };
}

/* ----------------------------- o envio ----------------------------- */

/**
 * Sobe o conteúdo da fonte e devolve o identificador do arquivo pronto
 * para virar mensagem. Não envia a mensagem — isso fica a cargo de quem
 * chamou, que é quem conhece a legenda.
 */
export async function enviarEmPedacos(client, { fonte, name, onProgress, cancelado }) {
  const size = fonte.size;
  const parte = tamanhoDaParte(size);
  // Sem Math.max aqui de propósito: um arquivo vazio tem zero partes, e
  // declarar uma parte que nunca é enviada faz o Telegram recusar o envio
  // com um erro que não diz nada.
  const partes = Math.ceil(size / parte);
  const grande = size > LIMITE_ARQUIVO_GRANDE;
  const fileId = readBigIntFromBuffer(generateRandomBytes(8), true, true);

  let enviados = 0;
  let indice = 0;

  while (indice < partes) {
    if (cancelado?.()) throw new Error('cancelado');

    // Lê alguns pedaços na frente para poder enviá-los em paralelo. A
    // leitura segue sequencial; só o envio é simultâneo.
    const lote = [];
    for (let k = 0; k < PARALELOS && indice + k < partes; k++) {
      const bytes = await fonte.proximo(parte);
      if (!bytes.length) break;
      lote.push({ numero: indice + k, bytes });
    }
    if (!lote.length) break;

    await Promise.all(lote.map(async ({ numero, bytes }) => {
      const payload = Buffer.from(bytes);
      for (let tentativa = 0; ; tentativa++) {
        let sender;
        try {
          sender = await client.getSender(client.session.dcId);
          await sender.send(grande
            ? new Api.upload.SaveBigFilePart({
                fileId, filePart: numero, fileTotalParts: partes, bytes: payload,
              })
            : new Api.upload.SaveFilePart({ fileId, filePart: numero, bytes: payload }));
          break;
        } catch (err) {
          // Queda de conexão e limite de velocidade são esperados num envio
          // longo; só desiste quando insiste demais.
          const reconectando = sender && !sender.isConnected();
          const espera = err?.seconds ? err.seconds * 1000 : ESPERA_RECONEXAO;
          if ((reconectando || err?.seconds) && tentativa < MAX_TENTATIVAS) {
            await sleep(espera);
            continue;
          }
          throw err;
        }
      }
      enviados += bytes.length;
      onProgress?.(Math.min(enviados, size), size);
    }));

    indice += lote.length;
  }

  return grande
    ? new Api.InputFileBig({ id: fileId, parts: partes, name })
    : new Api.InputFile({ id: fileId, parts: partes, name, md5Checksum: '' });
}
