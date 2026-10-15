/* ------------------------------------------------------------------ *
 * Manifesto na legenda da mensagem — formato do TeleDrive.
 *
 *   "td1:"  + JSON             → manifesto em texto claro
 *   "tde1:" + base64(AES-GCM)  → manifesto cifrado
 *
 * As chaves do JSON são abreviadas porque a legenda do Telegram tem
 * limite de tamanho. Os nomes vêm do TeleDrive original, para que os
 * dois clientes leiam o mesmo drive.
 * ------------------------------------------------------------------ */

import { encryptManifest, decryptManifest } from './crypto.js';

export const PREFIX_PLAIN = 'td1:';
export const PREFIX_ENCRYPTED = 'tde1:';

/** Cria um manifesto novo a partir dos dados de um arquivo. */
export function newManifest({ id, name, folderPath, mime, size, encrypted = false, now = Date.now() }) {
  return {
    v: 1,
    id,
    n: name,
    p: folderPath || '/',
    m: mime || 'application/octet-stream',
    s: size,
    e: encrypted,
    ct: now,
    mt: now,
  };
}

export async function encode(manifest, contentKey) {
  const json = JSON.stringify(manifest);
  if (!contentKey) return PREFIX_PLAIN + json;
  return PREFIX_ENCRYPTED + (await encryptManifest(contentKey, json));
}

/**
 * Lê a legenda. Devolve null quando a mensagem não é do drive — assim
 * mensagens avulsas no canal são simplesmente ignoradas.
 */
export async function decode(caption, contentKey) {
  if (typeof caption !== 'string') return null;
  try {
    if (caption.startsWith(PREFIX_PLAIN)) {
      return JSON.parse(caption.slice(PREFIX_PLAIN.length));
    }
    if (caption.startsWith(PREFIX_ENCRYPTED)) {
      if (!contentKey) return { locked: true };
      return JSON.parse(await decryptManifest(contentKey, caption.slice(PREFIX_ENCRYPTED.length)));
    }
  } catch {
    return null;
  }
  return null;
}

export function isEncryptedCaption(caption) {
  return typeof caption === 'string' && caption.startsWith(PREFIX_ENCRYPTED);
}

/* ------------------------- caminhos ------------------------- */

/**
 * Normaliza o caminho resolvendo "." e "..".
 *
 * O caminho vem da legenda da mensagem, que é dado externo. Sem resolver o
 * "..", uma legenda com "/a/../../b" produziria uma pasta fora da árvore —
 * impossível de navegar e invisível na listagem. Nada escapa para o disco,
 * já que as pastas aqui são virtuais, mas o estado fica inconsistente.
 */
export function normalizePath(path) {
  if (!path || path === '/') return '/';
  const out = [];
  for (const part of String(path).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.length ? '/' + out.join('/') : '/';
}

export function joinPath(base, name) {
  return normalizePath(normalizePath(base) === '/' ? `/${name}` : `${normalizePath(base)}/${name}`);
}

export function parentOf(path) {
  const p = normalizePath(path);
  if (p === '/') return '/';
  return normalizePath(p.slice(0, p.lastIndexOf('/')));
}

export function baseName(path) {
  const p = normalizePath(path);
  return p === '/' ? '/' : p.slice(p.lastIndexOf('/') + 1);
}

/** Pastas que aparecem logo abaixo de `base`, deduzidas dos caminhos dos arquivos. */
export function childFolders(allPaths, base) {
  const root = normalizePath(base);
  const prefix = root === '/' ? '/' : root + '/';
  const names = new Set();
  for (const raw of allPaths) {
    const p = normalizePath(raw);
    if (p === root || !p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const head = rest.split('/')[0];
    if (head) names.add(head);
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}
