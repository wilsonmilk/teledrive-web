/* ------------------------------------------------------------------ *
 * Camada Telegram: sessão, canal do drive e operações de arquivo.
 *
 * O canal é um broadcast privado chamado "TeleDrive" com a marca
 * #teledrive-storage na descrição — exatamente como o app original
 * cria e reencontra o dele, para que os dois leiam o mesmo drive.
 * ------------------------------------------------------------------ */

import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { enviarEmPedacos } from './upload.js';

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
 * Envia um arquivo a partir de uma fonte de bytes (ver upload.js).
 *
 * `forceDocument` é obrigatório: o TeleDrive só indexa mensagens enviadas
 * como documento; foto ou áudio recomprimido pelo Telegram seria ignorado,
 * além de estragar os bytes de um arquivo cifrado.
 */
export async function uploadFile(client, entity, { fonte, name, caption, onProgress, cancelado }) {
  // O envio é feito em duas etapas de propósito.
  //
  // O `uploadFile` do GramJS exige o arquivo inteiro em memória: acima de
  // 20 MB ele tenta ler de um `filePath`, que no navegador não existe, e
  // forçá-lo ao caminho em memória aloca o arquivo duas vezes e trava a
  // aba. Então subimos parte por parte, lendo cada fatia do disco na hora
  // (ver upload.js), e só depois mandamos a mensagem com o identificador
  // pronto — nesse formato o nome precisa vir explícito nos atributos.
  const handle = await enviarEmPedacos(client, { fonte, name, onProgress, cancelado });

  return client.sendFile(entity, {
    file: handle,
    caption,
    forceDocument: true,
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
