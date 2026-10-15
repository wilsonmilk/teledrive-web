/* ------------------------------------------------------------------ *
 * Criptografia compatível com o TeleDrive (formato TDE1)
 *
 * Layout do arquivo cifrado:
 *   MAGIC(4) = "TDE1" | VERSION(1) | SALT(8)
 *   por bloco: tamanho(4, bit mais alto marca o último) | bytes selados
 *
 *   nonce do bloco = SALT(8) || índice(4)      → 12 bytes, nunca repete
 *   AAD do bloco   = versão(4) || índice(4) || último(1)
 *
 * O AAD amarrar índice e marca de último é o que impede remover,
 * reordenar ou truncar blocos sem a adulteração ser detectada.
 * ------------------------------------------------------------------ */

const MAGIC = new Uint8Array([0x54, 0x44, 0x45, 0x31]); // "TDE1"
const VERSION = 1;
const SALT_LENGTH = 8;
const NONCE_LENGTH = 12;
const TAG_BITS = 128;
const CHUNK_SIZE = 1024 * 1024;
const FINAL_FLAG = 0x80000000;

// Mesmos parâmetros do TeleDrive, que seguem a recomendação da OWASP.
const KDF_ITERATIONS = 310_000;
const KDF_SALT_LENGTH = 16;

const te = new TextEncoder();

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function u32(value) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, value >>> 0, false); // big-endian, como no Java
  return b;
}

function nonceFor(salt, chunkIndex) {
  return concat(salt, u32(chunkIndex));
}

function aadFor(chunkIndex, isFinal) {
  return concat(u32(VERSION), u32(chunkIndex), new Uint8Array([isFinal ? 1 : 0]));
}

/** getRandomValues recusa pedidos acima de 64 KB, então preenche em fatias. */
export function randomBytes(n) {
  const out = new Uint8Array(n);
  const MAX = 65536;
  for (let at = 0; at < n; at += MAX) {
    crypto.getRandomValues(out.subarray(at, Math.min(at + MAX, n)));
  }
  return out;
}

async function importAesKey(raw) {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/* ----------------------- chave e senha ----------------------- */

/** Deriva a chave que protege a chave de conteúdo, a partir da senha. */
async function deriveKek(passphrase, salt, iterations = KDF_ITERATIONS) {
  const base = await crypto.subtle.importKey(
    'raw', te.encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/* --------------- backup de chave, formato TDKB ---------------- *
 *
 * É o mesmo arquivo `teledrive.keybackup` que o TeleDrive exporta e lê:
 *
 *   MAGIC(4) = "TDKB" | VERSION(1) | iterações(4) | salt(16)
 *   | tamanho da dica(2) | dica(utf-8) | chave de conteúdo selada em TDE1
 *
 * A dica fica em texto claro de propósito — por isso a interface precisa
 * avisar para não escrever a senha nela.
 *
 * É esse arquivo que torna um mesmo drive cifrado legível em vários
 * aparelhos: a chave de conteúdo viaja dentro dele, protegida pela senha.
 * ------------------------------------------------------------- */

const BACKUP_MAGIC = new Uint8Array([0x54, 0x44, 0x4b, 0x42]); // "TDKB"
const BACKUP_VERSION = 1;
const MAX_HINT_LENGTH = 128;
export const BACKUP_FILE_NAME = 'teledrive.keybackup';

function u16(value) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, value & 0xffff, false);
  return b;
}

/** Gera uma chave de conteúdo nova e o backup que a carrega. */
export async function createKeyBackup(passphrase, hint = '') {
  const contentKey = randomBytes(32);
  return { contentKey, backup: await encodeKeyBackup(contentKey, passphrase, hint) };
}

export async function encodeKeyBackup(contentKey, passphrase, hint = '') {
  const salt = randomBytes(KDF_SALT_LENGTH);
  const kek = await deriveKek(passphrase, salt);
  const sealed = await sealWithKey(kek, contentKey);
  const hintBytes = te.encode(String(hint || '').slice(0, MAX_HINT_LENGTH));

  return concat(
    BACKUP_MAGIC,
    new Uint8Array([BACKUP_VERSION]),
    u32(KDF_ITERATIONS),
    salt,
    u16(hintBytes.length),
    hintBytes,
    sealed,
  );
}

/** Lê só a dica, sem precisar da senha. */
export function readKeyBackupHint(blob) {
  try {
    for (let i = 0; i < BACKUP_MAGIC.length; i++) {
      if (blob[i] !== BACKUP_MAGIC[i]) return null;
    }
    const at = BACKUP_MAGIC.length + 1 + 4 + KDF_SALT_LENGTH;
    const hintLength = new DataView(blob.buffer, blob.byteOffset + at, 2).getUint16(0, false);
    if (!hintLength) return '';
    return new TextDecoder().decode(blob.slice(at + 2, at + 2 + hintLength));
  } catch {
    return null;
  }
}

export async function decodeKeyBackup(blob, passphrase) {
  for (let i = 0; i < BACKUP_MAGIC.length; i++) {
    if (blob[i] !== BACKUP_MAGIC[i]) {
      throw new Error('Este arquivo não é um backup de chave do TeleDrive.');
    }
  }
  let at = BACKUP_MAGIC.length;
  const version = blob[at]; at += 1;
  if (version !== BACKUP_VERSION) {
    throw new Error(`Versão de backup não suportada: ${version}`);
  }

  const iterations = new DataView(blob.buffer, blob.byteOffset + at, 4).getUint32(0, false);
  at += 4;
  if (iterations < 10_000 || iterations > 10_000_000) {
    throw new Error('Contagem de iterações implausível: o arquivo pode estar adulterado.');
  }

  const salt = blob.slice(at, at + KDF_SALT_LENGTH); at += KDF_SALT_LENGTH;
  const hintLength = new DataView(blob.buffer, blob.byteOffset + at, 2).getUint16(0, false);
  at += 2 + hintLength;

  const sealed = blob.slice(at);
  const kek = await deriveKek(passphrase, salt, iterations);
  try {
    return await openWithKey(kek, sealed);
  } catch {
    throw new Error('Senha incorreta para este backup.');
  }
}

/* --------------------- arquivos (stream) --------------------- */

/** Cifra os bytes inteiros no formato TDE1. */
export async function encryptBytes(contentKey, plain, onProgress) {
  return encryptBytesWithKey(await importAesKey(contentKey), plain, onProgress);
}

/** Mesma coisa, com a chave já importada — usado pelo backup de chave. */
async function encryptBytesWithKey(key, plain, onProgress) {
  const salt = randomBytes(SALT_LENGTH);
  const parts = [MAGIC, new Uint8Array([VERSION]), salt];

  const total = plain.length;
  const chunks = Math.max(1, Math.ceil(total / CHUNK_SIZE));

  for (let i = 0; i < chunks; i++) {
    const start = i * CHUNK_SIZE;
    const slice = plain.subarray(start, Math.min(start + CHUNK_SIZE, total));
    const isFinal = i === chunks - 1;
    const sealed = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: nonceFor(salt, i), additionalData: aadFor(i, isFinal), tagLength: TAG_BITS },
        key,
        slice,
      ),
    );
    parts.push(u32(isFinal ? (sealed.length | FINAL_FLAG) : sealed.length), sealed);
    onProgress?.(Math.min(start + CHUNK_SIZE, total), total);
  }
  return concat(...parts);
}

/** Decifra um arquivo TDE1 e devolve os bytes originais. */
export async function decryptBytes(contentKey, data, onProgress) {
  return decryptBytesWithKey(await importAesKey(contentKey), data, onProgress);
}

async function decryptBytesWithKey(key, data, onProgress) {
  if (data.length < MAGIC.length + 1 + SALT_LENGTH) {
    throw new Error('Arquivo cifrado truncado.');
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (data[i] !== MAGIC[i]) throw new Error('Este arquivo não está no formato TeleDrive.');
  }
  const version = data[MAGIC.length];
  if (version !== VERSION) throw new Error(`Versão de criptografia não suportada: ${version}`);

  const salt = data.slice(MAGIC.length + 1, MAGIC.length + 1 + SALT_LENGTH);
  let at = MAGIC.length + 1 + SALT_LENGTH;

  const out = [];
  let index = 0;
  let sawFinal = false;

  while (at < data.length) {
    if (at + 4 > data.length) throw new Error('Cabeçalho de bloco truncado.');
    const header = new DataView(data.buffer, data.byteOffset + at, 4).getUint32(0, false);
    at += 4;
    const isFinal = (header & FINAL_FLAG) !== 0;
    const length = header & ~FINAL_FLAG;
    if (at + length > data.length) throw new Error('Bloco truncado.');

    const sealed = data.slice(at, at + length);
    at += length;

    let plain;
    try {
      plain = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: nonceFor(salt, index), additionalData: aadFor(index, isFinal), tagLength: TAG_BITS },
          key,
          sealed,
        ),
      );
    } catch {
      throw new Error('Falha ao decifrar: senha errada ou arquivo adulterado.');
    }
    out.push(plain);
    onProgress?.(at, data.length);
    index++;
    if (isFinal) { sawFinal = true; break; }
  }

  // Sem o bloco final, alguém pode ter cortado o fim do arquivo.
  if (!sawFinal) throw new Error('Arquivo incompleto: o bloco final não foi encontrado.');
  return concat(...out);
}

/* ---------------- blobs pequenos (seal / open) ----------------- *
 *
 * ATENÇÃO: este NÃO é o formato TDE1 em blocos acima.
 *
 * O TeleDrive usa dois esquemas diferentes, e misturá-los quebra a
 * compatibilidade em silêncio:
 *
 *   - conteúdo de arquivo  → TDE1 em blocos (encryptBytes/decryptBytes)
 *   - legenda e backup     → nonce(12) + AES-GCM, sem cabeçalho
 *
 * O segundo é o `StreamCrypto.encryptBytes` do Kotlin, apesar do nome
 * parecido. Nonce aleatório por blob, concatenado na frente.
 * -------------------------------------------------------------- */

async function sealWithKey(key, plain) {
  const nonce = randomBytes(NONCE_LENGTH);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: TAG_BITS }, key, plain),
  );
  return concat(nonce, sealed);
}

async function openWithKey(key, blob) {
  if (blob.length <= NONCE_LENGTH + TAG_BITS / 8) throw new Error('Blob curto demais.');
  const nonce = blob.slice(0, NONCE_LENGTH);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: TAG_BITS }, key, blob.slice(NONCE_LENGTH),
    ),
  );
}

export async function seal(contentKey, plain) {
  return sealWithKey(await importAesKey(contentKey), plain);
}

export async function open(contentKey, blob) {
  return openWithKey(await importAesKey(contentKey), blob);
}

/* ------------------ legendas (manifesto) ------------------- */

/** Cifra o manifesto que vai na legenda, no formato simples. */
export async function encryptManifest(contentKey, text) {
  return btoa(String.fromCharCode(...(await seal(contentKey, te.encode(text)))));
}

export async function decryptManifest(contentKey, b64) {
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(await open(contentKey, raw));
}
