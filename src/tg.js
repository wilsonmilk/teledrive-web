/* ------------------------------------------------------------------ *
 * Camada Telegram: sessão, canal do drive e operações de arquivo.
 *
 * O canal é um broadcast privado chamado "TeleDrive" com a marca
 * #teledrive-storage na descrição — exatamente como o app original
 * cria e reencontra o dele, para que os dois leiam o mesmo drive.
 * ------------------------------------------------------------------ */

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { CustomFile } from 'telegram/client/uploads.js';

export const DRIVE_TITLE = 'TeleDrive';
export const DRIVE_MARKER = '#teledrive-storage';

export function buildClient(apiId, apiHash, sessionStr) {
  return new TelegramClient(new StringSession(sessionStr || ''), Number(apiId), apiHash, {
    connectionRetries: 5,
    useWSS: true,
    deviceModel: 'TeleDrive Web',
    systemVersion: 'browser',
    appVersion: '0.2.0',
  });
}

/* --------------------------- o canal --------------------------- */

async function aboutOf(client, channel) {
  try {
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel }));
    return full?.fullChat?.about || '';
  } catch {
    return '';
  }
}

/**
 * Procura o canal do drive entre as conversas. Prioriza a marca na
 * descrição; o título sozinho não basta, porque qualquer canal pode
 * se chamar TeleDrive.
 */
export async function findDrive(client) {
  const dialogs = await client.getDialogs({ limit: 200 });
  const candidates = dialogs.filter((d) => d.isChannel);

  // Primeiro os que têm o nome certo, para não pedir detalhes de tudo.
  candidates.sort((a, b) => {
    const an = (a.title || '').toLowerCase() === DRIVE_TITLE.toLowerCase() ? 0 : 1;
    const bn = (b.title || '').toLowerCase() === DRIVE_TITLE.toLowerCase() ? 0 : 1;
    return an - bn;
  });

  for (const d of candidates.slice(0, 25)) {
    const about = await aboutOf(client, d.entity);
    if (about.includes(DRIVE_MARKER)) {
      return { entity: d.entity, title: d.title, created: false };
    }
  }
  return null;
}

/** Cria o canal privado do drive. */
export async function createDrive(client, title = DRIVE_TITLE) {
  const res = await client.invoke(new Api.channels.CreateChannel({
    title,
    about: DRIVE_MARKER,
    broadcast: true,
    megagroup: false,
  }));
  const chat = res.chats?.[0];
  if (!chat) throw new Error('O Telegram não devolveu o canal criado.');
  return { entity: chat, title, created: true };
}

export async function findOrCreateDrive(client) {
  return (await findDrive(client)) || (await createDrive(client));
}

/* ------------------------- os arquivos ------------------------- */

export function fileNameOf(doc) {
  const attr = (doc?.attributes || []).find((a) => a.className === 'DocumentAttributeFilename');
  return attr?.fileName || 'sem-nome';
}

/** Puxa as mensagens com documento do canal, da mais nova para a mais antiga. */
export async function fetchDocuments(client, entity, { limit = 500 } = {}) {
  const out = [];
  let offsetId = 0;

  while (out.length < limit) {
    const batch = await client.getMessages(entity, {
      limit: Math.min(100, limit - out.length),
      offsetId,
      filter: new Api.InputMessagesFilterDocument(),
    });
    if (!batch.length) break;
    out.push(...batch.filter((m) => m.document));
    offsetId = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
  return out;
}

/**
 * Envia um arquivo.
 *
 * Duas sutilezas:
 *
 * 1. O GramJS recusa um `File` do navegador: na validação ele cai num ramo
 *    que tenta tratá-lo como objeto da API do Telegram, falha, e devolve
 *    "Cannot use [object File] as file." Embrulhar em `CustomFile` — um tipo
 *    que a validação reconhece — é o caminho que funciona.
 *
 * 2. `forceDocument` é obrigatório: o TeleDrive só indexa mensagens enviadas
 *    como documento; foto ou áudio comprimido pelo Telegram seria ignorado,
 *    além de estragar os bytes de um arquivo cifrado.
 */
export async function uploadFile(client, entity, { data, name, caption, onProgress }) {
  const bytes = data instanceof Uint8Array
    ? data
    : new Uint8Array(await data.arrayBuffer());

  // Um Uint8Array basta: o próprio GramJS faz Buffer.from() em cima dele.
  // Evita depender de `Buffer` global, que não existe no navegador.
  const file = new CustomFile(name, bytes.length, '', bytes);

  // 3. O envio é feito em duas etapas de propósito.
  //
  //    Pelo sendFile, arquivos acima de 20 MB quebram: o GramJS decide ler
  //    do disco quando `fileSize > maxBufferSize`, e usa o `path` do
  //    CustomFile — que no navegador é vazio, porque não existe caminho de
  //    disco. O erro que aparece é "Either one of `buffer` or `filePath`
  //    should be specified".
  //
  //    O `maxBufferSize` conserta isso, mas o sendFile não repassa esse
  //    parâmetro. Então subimos o arquivo direto pelo uploadFile, onde ele
  //    é aceito, e mandamos a mensagem depois com o identificador pronto.
  const handle = await client.uploadFile({
    file,
    workers: 1,
    maxBufferSize: bytes.length + 1,   // garante o caminho em memória
    onProgress: (p) => onProgress?.(Math.round(p * bytes.length), bytes.length),
  });

  return client.sendFile(entity, {
    file: handle,
    caption,
    forceDocument: true,
    // Com o arquivo já enviado, o nome precisa vir explícito.
    attributes: [new Api.DocumentAttributeFilename({ fileName: name })],
  });
}

export async function downloadFile(client, message, onProgress) {
  const buf = await client.downloadMedia(message, {
    progressCallback: (received, total) => onProgress?.(Number(received), Number(total)),
  });
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}

/** Reescreve a legenda — é assim que renomear, mover e mandar pra lixeira funcionam. */
export async function editCaption(client, entity, messageId, caption) {
  return client.invoke(new Api.messages.EditMessage({
    peer: entity,
    id: messageId,
    message: caption,
  }));
}

export async function deleteMessages(client, entity, ids) {
  return client.invoke(new Api.channels.DeleteMessages({ channel: entity, id: ids }));
}
