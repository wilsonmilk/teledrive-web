import './style.css';
import * as TG from './tg.js';
import * as M from './manifest.js';
import { ICON, iconFor, kindOf, isPreviewable, isStreamable } from './icons.js';
import { iniciarStreaming, abrirStream, fecharStream, podeStreamar } from './stream.js';
import { fonteEmClaro, fonteCifrada } from './upload.js';
import * as Hist from './history.js';
import {
  createKeyBackup, encodeKeyBackup, decodeKeyBackup, readKeyBackupHint,
  decryptBytes, BACKUP_FILE_NAME,
} from './crypto.js';

const $ = (id) => document.getElementById(id);

const KEY = {
  id: 'td_api_id', hash: 'td_api_hash', session: 'td_session',
  drive: 'td_drive_id', folders: 'td_folders',
  backup: 'td_key_backup', remembered: 'td_key_remembered',
  encryptNew: 'td_encrypt_new', confirmDelete: 'td_confirm_delete',
  view: 'td_view', sortBy: 'td_sort_by', sortDir: 'td_sort_dir',
};

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sem persistência */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignora */ } },
};

const b64 = {
  encode: (bytes) => btoa(String.fromCharCode(...bytes)),
  decode: (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0)),
};

/* ----------------------------- estado ----------------------------- */

const state = {
  client: null,
  drive: null,
  me: null,
  items: [],            // { msgId, msg, man }
  cwd: '/',
  scope: 'drive',       // drive | trash | fav
  query: '',
  sel: new Set(),       // msgIds selecionados
  lastClicked: null,    // âncora para seleção com Shift
  view: store.get(KEY.view) === 'grid' ? 'grid' : 'list',
  sort: {
    by: store.get(KEY.sortBy) || 'name',
    dir: store.get(KEY.sortDir) === '-1' ? -1 : 1,
  },
  details: null,
  contentKey: null,
  hasKey: false,
  encryptNew: store.get(KEY.encryptNew) === '1',
  confirmDelete: store.get(KEY.confirmDelete) !== '0',   // perguntar é o padrão
  localFolders: new Set(JSON.parse(store.get(KEY.folders) || '[]')),
};

function saveFolders() { store.set(KEY.folders, JSON.stringify([...state.localFolders])); }

/* ---------------------------- utilidades --------------------------- */

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0).replace('.', ',')} ${u[i]}`;
}

function humanDate(ms, full = false) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '—';
  if (full) return d.toLocaleString('pt-BR');
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString('pt-BR', sameYear
    ? { day: '2-digit', month: 'short' }
    : { day: '2-digit', month: 'short', year: 'numeric' });
}

function msg(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
  el.classList.remove('hide');
}

function onlyPanel(id) {
  ['s-creds', 's-phone', 's-code', 's-pass', 's-boot']
    .forEach((s) => $(s).classList.toggle('hide', s !== id));
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function humanError(err) {
  const name = err?.name || '';
  const text = err?.message || String(err);
  if (name === 'NotFoundError' || text.includes('could not be found')) {
    return 'o arquivo sumiu do disco durante a leitura (foi movido, ou está só na nuvem e não baixado)';
  }
  if (name === 'NotReadableError') return 'sem permissão para ler este arquivo';
  if (name === 'SecurityError') return 'o navegador bloqueou a leitura deste arquivo';
  return text;
}

function saveBlob(bytes, name, mime = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/* ----------------------------- diálogos ---------------------------- */

/**
 * Num <form method="dialog">, o Enter aciona o PRIMEIRO botão de submit do
 * formulário. Com o Cancelar vindo antes na marcação, o Enter cancelava.
 * Agora o Cancelar é type="button" e fecha por aqui, deixando o botão de
 * confirmar como único submit — então Enter confirma e Esc cancela, que é o
 * que todo mundo espera.
 */
document.querySelectorAll('dialog .js-cancel').forEach((b) => {
  b.onclick = () => b.closest('dialog').close('cancel');
});

function ask(title, hint, value = '', okLabel = 'Confirmar') {
  const dlg = $('dlgPrompt');
  $('promptTitle').textContent = title;
  $('promptHint').textContent = hint;
  $('promptOk').textContent = okLabel;
  const input = $('promptInput');
  input.value = value;
  const d = deferred();
  dlg.onclose = () => d.resolve(dlg.returnValue === 'ok' ? input.value.trim() : null);
  dlg.showModal();
  input.focus(); input.select();
  return d.promise;
}

function askPass(title, hint, okLabel = 'Desbloquear') {
  const dlg = $('dlgPass');
  $('passTitle').textContent = title;
  $('passHint').textContent = hint;
  $('passOk').textContent = okLabel;
  $('passErr').classList.add('hide');
  const input = $('passInput');
  const remember = $('passRemember');
  input.value = '';
  remember.checked = !!store.get(KEY.remembered);
  const d = deferred();
  dlg.onclose = () => d.resolve(
    dlg.returnValue === 'ok' ? { pass: input.value, remember: remember.checked } : null,
  );
  dlg.showModal();
  input.focus();
  return d.promise;
}

/* ------------------------- autenticação --------------------------- */

async function doLogin(apiId, apiHash) {
  state.client = TG.buildClient(apiId, apiHash, '');
  const dPhone = deferred(), dCode = deferred(), dPass = deferred();
  onlyPanel('s-phone');

  $('btnPhone').onclick = () => {
    const v = $('phone').value.trim();
    if (!v) return msg('mPhone', 'Digite o número com o código do país.', 'err');
    $('btnPhone').disabled = true;
    msg('mPhone', 'Falando com o Telegram…');
    dPhone.resolve(v);
  };
  $('btnCode').onclick = () => {
    const v = $('code').value.trim();
    if (!v) return msg('mCode', 'Digite o código.', 'err');
    $('btnCode').disabled = true;
    msg('mCode', 'Verificando…');
    dCode.resolve(v);
  };
  $('btnPass').onclick = () => {
    const v = $('pass').value;
    if (!v) return msg('mPass', 'Digite a senha.', 'err');
    $('btnPass').disabled = true;
    msg('mPass', 'Verificando…');
    dPass.resolve(v);
  };

  await state.client.start({
    phoneNumber: async () => dPhone.promise,
    phoneCode: async () => { onlyPanel('s-code'); return dCode.promise; },
    password: async () => { onlyPanel('s-pass'); return dPass.promise; },
    onError: (err) => {
      const text = 'Não deu certo: ' + (err?.message || err);
      for (const [panel, box, btn] of [['s-phone', 'mPhone', 'btnPhone'], ['s-code', 'mCode', 'btnCode'], ['s-pass', 'mPass', 'btnPass']]) {
        if (!$(panel).classList.contains('hide')) { msg(box, text, 'err'); $(btn).disabled = false; }
      }
    },
  });

  store.set(KEY.session, state.client.session.save());
  await enterDrive();
}

/* --------------------------- abrir o drive -------------------------- */

async function enterDrive() {
  onlyPanel('s-boot');
  $('bootHint').textContent = 'Procurando o canal do seu drive…';

  state.me = await state.client.getMe();
  state.drive = await TG.findOrCreateDrive(state.client);
  store.set(KEY.drive, String(state.drive.entity.id));
  state.hasKey = !!store.get(KEY.backup);

  const kept = store.get(KEY.remembered);
  if (kept) {
    try { state.contentKey = b64.decode(kept); } catch { store.del(KEY.remembered); }
  }

  $('gate').classList.add('hide');
  $('app').classList.remove('hide');

  streamingPronto = await iniciarStreaming((err) => {
    console.warn('streaming indisponível:', err);
  });

  atualizarAvisoHistorico();
  $('sortBy').value = state.sort.by;
  syncSortButtons();
  await reload();

  if (state.hasKey && !state.contentKey && hasLockedItems()) await requireKey();
}

async function reload() {
  if (!state.client || !state.drive) return;
  setStatus([{ text: 'Lendo o canal…' }]);
  const msgs = await TG.fetchDocuments(state.client, state.drive.entity);
  const items = [];
  for (const m of msgs) {
    const man = await M.decode(m.message, state.contentKey);
    if (!man) continue;
    items.push({ msgId: m.id, msg: m, man });
  }
  state.items = items;
  state.sel.clear();
  render();
}

function hasLockedItems() { return state.items.some((i) => i.man.locked); }

/* --------------------------- modelo de visão ------------------------ */

function allFolderPaths() {
  const set = new Set(['/']);
  for (const it of state.items) if (!it.man.tr) set.add(M.normalizePath(it.man.p));
  for (const p of state.localFolders) set.add(M.normalizePath(p));
  // toda pasta implica as ancestrais
  for (const p of [...set]) {
    let cur = p;
    while (cur !== '/') { cur = M.parentOf(cur); set.add(cur); }
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function visibleFolders() {
  if (state.scope !== 'drive' || state.query) return [];
  const paths = state.items.filter((i) => !i.man.tr).map((i) => i.man.p);
  const fromFiles = M.childFolders(paths, state.cwd);
  const fromLocal = M.childFolders([...state.localFolders], state.cwd);
  return [...new Set([...fromFiles, ...fromLocal])].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function visibleItems() {
  let list = state.items;

  if (state.scope === 'trash') list = list.filter((i) => i.man.tr);
  else if (state.scope === 'fav') list = list.filter((i) => !i.man.tr && i.man.fv);
  else list = list.filter((i) => !i.man.tr);

  // A busca varre o drive inteiro; sem busca, só a pasta atual.
  if (state.query) {
    const q = state.query.toLowerCase();
    list = list.filter((it) => (it.man.n || '').toLowerCase().includes(q));
  } else if (state.scope === 'drive') {
    list = list.filter((it) => M.normalizePath(it.man.p) === state.cwd);
  }

  const { by, dir } = state.sort;
  return [...list].sort((a, b) => {
    let r = 0;
    if (by === 'size') r = Number(a.man.s || 0) - Number(b.man.s || 0);
    else if (by === 'modified') r = Number(a.man.mt || 0) - Number(b.man.mt || 0);
    else if (by === 'kind') r = kindOf(a.man.n).localeCompare(kindOf(b.man.n)) ||
      (a.man.n || '').localeCompare(b.man.n || '', 'pt-BR');
    else r = (a.man.n || '').localeCompare(b.man.n || '', 'pt-BR');
    return r * dir;
  });
}

function itemById(msgId) { return state.items.find((i) => i.msgId === msgId); }

/* A seleção guarda arquivos e pastas na mesma coleção. Arquivo vira
 * "m:<id da mensagem>" e pasta vira "f:<caminho>", porque pasta aqui é
 * virtual e não tem mensagem própria no canal. */
const fileKey = (it) => `m:${it.msgId}`;
const folderKey = (path) => `f:${M.normalizePath(path)}`;

function selectedItems() {
  return [...state.sel]
    .filter((k) => k.startsWith('m:'))
    .map((k) => itemById(Number(k.slice(2))))
    .filter(Boolean);
}
function selectedFolders() {
  return [...state.sel].filter((k) => k.startsWith('f:')).map((k) => k.slice(2));
}

/** Arquivos vivos dentro de uma pasta, incluindo subpastas. */
function filesUnder(path) {
  const p = M.normalizePath(path);
  return state.items.filter((i) => {
    if (i.man.tr) return false;
    const q = M.normalizePath(i.man.p);
    return q === p || q.startsWith(p + '/');
  });
}

/** Tudo que a seleção representa em arquivos, sem repetir. */
function selectionFiles() {
  const out = new Map();
  for (const it of selectedItems()) out.set(it.msgId, it);
  for (const p of selectedFolders()) for (const it of filesUnder(p)) out.set(it.msgId, it);
  return [...out.values()];
}

/* ------------------------------ render ------------------------------ */

function renderCrumbs() {
  const box = $('crumbs');
  box.innerHTML = '';
  const label = { trash: 'Lixeira', fav: 'Favoritos' }[state.scope];
  if (label) {
    const b = document.createElement('button');
    b.textContent = label;
    box.appendChild(b);
    return;
  }
  if (state.query) {
    const b = document.createElement('button');
    b.textContent = `Resultados para "${state.query}"`;
    box.appendChild(b);
    return;
  }
  const mk = (text, path) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.onclick = () => goTo(path);
    b.ondragover = (e) => { e.preventDefault(); b.classList.add('drop'); };
    b.ondragleave = () => b.classList.remove('drop');
    b.ondrop = (e) => { e.preventDefault(); b.classList.remove('drop'); dropOnFolder(e, path); };
    return b;
  };
  box.appendChild(mk('Meu drive', '/'));
  let acc = '';
  for (const part of state.cwd.split('/').filter(Boolean)) {
    const sep = document.createElement('span');
    sep.className = 'sep'; sep.textContent = '/';
    box.appendChild(sep);
    acc += '/' + part;
    box.appendChild(mk(part, acc));
  }
}

/**
 * As classes de tipo levam o prefixo k- de propósito. Sem ele, "sheet"
 * colide com .sheet (o contêiner do drive) e o ícone herda flex:1,
 * esticando para o tamanho do painel inteiro.
 */
function glyphFor(it) {
  const locked = it.man.locked;
  const enc = locked || it.man.e;
  const name = locked ? '' : (it.man.n || '');
  return {
    cls: enc ? 'locked' : `k-${kindOf(name)}`,
    html: enc ? ICON.lock : iconFor(name),
  };
}

function buildRow(it) {
  const locked = it.man.locked;
  const name = locked ? 'Arquivo cifrado' : (it.man.n || 'sem nome');
  const g = glyphFor(it);
  const li = document.createElement('li');
  const key = fileKey(it);
  li.className = 'row' + (state.sel.has(key) ? ' on' : '');
  li.draggable = !locked && state.scope === 'drive';
  li.innerHTML = `
    <span class="chk"><input type="checkbox" aria-label="Selecionar" /></span>
    <div class="cell-name">
      <span class="glyph ${g.cls}">${g.html}</span>
      <span class="nm"><b></b><small></small></span>
      <span class="fav" title="Favorito"></span>
    </div>
    <span class="num"></span>
    <span class="when"></span>
    <span class="rowmenu"><button class="btn bare" aria-label="Ações">⋯</button></span>`;

  li.querySelector('b').textContent = name;
  const sub = state.query && it.man.p && it.man.p !== '/'
    ? `${humanSize(it.man.s || 0)} · ${it.man.p}`
    : `${humanSize(it.man.s || 0)} · ${humanDate(it.man.mt || it.man.ct)}`;
  li.querySelector('small').textContent = sub;
  li.querySelector('.num').textContent = humanSize(it.man.s || 0);
  li.querySelector('.when').textContent = humanDate(it.man.mt || it.man.ct);
  if (it.man.fv) li.querySelector('.fav').innerHTML = ICON.starFull;

  const box = li.querySelector('input');
  box.checked = state.sel.has(key);
  box.onclick = (e) => { e.stopPropagation(); toggleSel(key, e.shiftKey); };

  li.__item = it;
  li.__key = key;
  li.onclick = (e) => {
    if (e.target.closest('.rowmenu') || e.target.closest('.chk')) return;
    if (e.ctrlKey || e.metaKey) { toggleSel(key, false); return; }
    if (e.shiftKey) { toggleSel(key, true); return; }
    openItem(it);
  };
  li.querySelector('.rowmenu button').onclick = (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.left, r.bottom + 6, rowEntries(it));
  };
  li.ondragstart = (e) => {
    if (!state.sel.has(key)) { state.sel.clear(); state.sel.add(key); render(); }
    e.dataTransfer.setData('text/td-items', JSON.stringify([...state.sel]));
    e.dataTransfer.effectAllowed = 'move';
  };
  return li;
}

function buildFolderRow(name) {
  const path = M.joinPath(state.cwd, name);
  const key = folderKey(path);
  const li = document.createElement('li');
  li.className = 'row folder' + (state.sel.has(key) ? ' on' : '');
  li.draggable = true;
  li.innerHTML = `
    <span class="chk"><input type="checkbox" aria-label="Selecionar pasta" /></span>
    <div class="cell-name">
      <span class="glyph folder">${ICON.folder}</span>
      <span class="nm"><b></b><small></small></span>
    </div>
    <span class="num"></span>
    <span class="when"></span>
    <span class="rowmenu"><button class="btn bare" aria-label="Ações">⋯</button></span>`;
  li.querySelector('b').textContent = name;
  const dentro = filesUnder(path).length;
  li.querySelector('small').textContent = dentro ? `pasta · ${dentro} arquivo${dentro === 1 ? '' : 's'}` : 'pasta';

  const box = li.querySelector('input');
  box.checked = state.sel.has(key);
  box.onclick = (e) => { e.stopPropagation(); toggleSel(key, e.shiftKey); };

  li.__folder = path;
  li.__key = key;
  li.onclick = (e) => {
    if (e.target.closest('.rowmenu') || e.target.closest('.chk')) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) { toggleSel(key, e.shiftKey); return; }
    goTo(path);
  };
  li.ondragstart = (e) => {
    if (!state.sel.has(key)) { state.sel.clear(); state.sel.add(key); render(); }
    e.dataTransfer.setData('text/td-items', JSON.stringify([...state.sel]));
    e.dataTransfer.effectAllowed = 'move';
  };
  li.querySelector('.rowmenu button').onclick = (e) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.left, r.bottom + 6, folderEntries(path, name));
  };
  li.ondragover = (e) => { e.preventDefault(); li.classList.add('drop'); };
  li.ondragleave = () => li.classList.remove('drop');
  li.ondrop = (e) => { e.preventDefault(); li.classList.remove('drop'); dropOnFolder(e, path); };
  return li;
}

function buildTile(it) {
  const locked = it.man.locked;
  const name = locked ? 'Arquivo cifrado' : (it.man.n || 'sem nome');
  const g = glyphFor(it);
  const d = document.createElement('div');
  const key = fileKey(it);
  d.className = 'tile' + (state.sel.has(key) ? ' on' : '');
  d.draggable = !locked && state.scope === 'drive';
  d.innerHTML = `
    <span class="chk"><input type="checkbox" aria-label="Selecionar" /></span>
    <div class="thumb"><span class="glyph ${g.cls}">${g.html}</span></div>
    <div class="tname"></div>
    <div class="tmeta"></div>`;
  d.querySelector('.tname').textContent = name;
  d.querySelector('.tmeta').textContent = humanSize(it.man.s || 0);
  if (it.man.fv) d.querySelector('.thumb').insertAdjacentHTML('beforeend', `<span class="fav">${ICON.starFull}</span>`);

  const box = d.querySelector('input');
  box.checked = state.sel.has(key);
  box.onclick = (e) => { e.stopPropagation(); toggleSel(key, e.shiftKey); };

  d.__item = it;
  d.__key = key;
  d.onclick = (e) => {
    if (e.target.closest('.chk')) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) { toggleSel(key, e.shiftKey); return; }
    openItem(it);
  };
  d.ondragstart = (e) => {
    if (!state.sel.has(key)) { state.sel.clear(); state.sel.add(key); render(); }
    e.dataTransfer.setData('text/td-items', JSON.stringify([...state.sel]));
  };
  if (!locked && kindOf(it.man.n) === 'image' && !it.man.e) queueThumb(d, it);
  return d;
}

function buildFolderTile(name) {
  const path = M.joinPath(state.cwd, name);
  const key = folderKey(path);
  const d = document.createElement('div');
  d.className = 'tile folder' + (state.sel.has(key) ? ' on' : '');
  d.draggable = true;
  d.innerHTML = `<span class="chk"><input type="checkbox" aria-label="Selecionar pasta" /></span>
                 <div class="thumb"><span class="glyph folder">${ICON.folder}</span></div>
                 <div class="tname"></div><div class="tmeta">pasta</div>`;
  d.querySelector('.tname').textContent = name;
  const box = d.querySelector('input');
  box.checked = state.sel.has(key);
  box.onclick = (e) => { e.stopPropagation(); toggleSel(key, e.shiftKey); };
  d.__folder = path;
  d.__key = key;
  d.onclick = (e) => {
    if (e.target.closest('.chk')) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) { toggleSel(key, e.shiftKey); return; }
    goTo(path);
  };
  d.ondragstart = (e) => {
    if (!state.sel.has(key)) { state.sel.clear(); state.sel.add(key); render(); }
    e.dataTransfer.setData('text/td-items', JSON.stringify([...state.sel]));
  };
  d.ondragover = (e) => { e.preventDefault(); d.classList.add('drop'); };
  d.ondragleave = () => d.classList.remove('drop');
  d.ondrop = (e) => { e.preventDefault(); d.classList.remove('drop'); dropOnFolder(e, path); };
  return d;
}

function emptyMessage() {
  if (state.scope === 'trash') return ['A lixeira está vazia', 'Arquivos que você remover ficam aqui até você apagar de vez.'];
  if (state.scope === 'fav') return ['Nenhum favorito ainda', 'Marque um arquivo com estrela para encontrá-lo rápido depois.'];
  if (state.query) return ['Nada encontrado', 'Nenhum arquivo do drive tem esse nome.'];
  return ['Esta pasta está vazia', 'Arraste arquivos para cá, ou use o botão Enviar.'];
}

function render() {
  renderCrumbs();
  const folders = visibleFolders();
  const files = visibleItems();
  const grid = state.view === 'grid';

  $('cols').classList.toggle('hide', grid);
  $('rows').classList.toggle('hide', grid);
  $('grid').classList.toggle('hide', !grid);
  $('btnView').innerHTML = grid ? ICON.list : ICON.grid;
  $('btnView').title = grid ? 'Ver em lista' : 'Ver em grade';
  $('btnEmptyTrash').classList.toggle('hide', state.scope !== 'trash' || !files.length);
  $('btnFav').classList.toggle('on', state.scope === 'fav');
  $('btnTrash').classList.toggle('on', state.scope === 'trash');

  const host = grid ? $('grid') : $('rows');
  host.innerHTML = '';
  for (const name of folders) host.appendChild(grid ? buildFolderTile(name) : buildFolderRow(name));
  for (const it of files) host.appendChild(grid ? buildTile(it) : buildRow(it));

  if (!folders.length && !files.length) {
    const [title, text] = emptyMessage();
    const box = document.createElement(grid ? 'div' : 'li');
    box.className = 'emptybox';
    box.innerHTML = '<div class="empty"><strong></strong><p></p></div>';
    box.querySelector('strong').textContent = title;
    box.querySelector('p').textContent = text;
    host.appendChild(box);
  }

  const all = $('checkAll');
  const keys = visibleKeys();
  all.checked = keys.length > 0 && keys.every((k) => state.sel.has(k));
  all.indeterminate = !all.checked && keys.some((k) => state.sel.has(k));

  renderSelbar();
  renderDetails();
  renderStatus();
}

function renderStatus() {
  const live = state.items.filter((i) => !i.man.tr);
  const bytes = live.reduce((n, i) => n + Number(i.man.s || 0), 0);
  const locked = state.hasKey && !state.contentKey;
  $('btnUnlock').classList.toggle('hide', !locked);
  setStatus([
    { text: `${live.length} arquivo${live.length === 1 ? '' : 's'}` },
    { text: humanSize(bytes) },
    state.hasKey
      ? {
          text: locked ? 'cifrado · trancado' : 'cifrado · aberto',
          cls: locked ? 'keyed locked' : 'keyed',
          onClick: locked ? () => requireKey() : null,
        }
      : { text: 'sem criptografia' },
  ]);
}

function setStatus(parts) {
  const box = $('status');
  box.innerHTML = '';
  for (const p of [].concat(parts)) {
    const s = document.createElement('span');
    s.textContent = typeof p === 'string' ? p : p.text;
    if (p.cls) s.className = p.cls;
    if (p.onClick) { s.onclick = p.onClick; s.setAttribute('role', 'button'); s.tabIndex = 0; }
    box.appendChild(s);
  }
}

/* --------------------------- seleção ------------------------------- */

/** Ordem em que as coisas aparecem na tela — é ela que o Shift percorre. */
function visibleKeys() {
  return [
    ...visibleFolders().map((n) => folderKey(M.joinPath(state.cwd, n))),
    ...visibleItems().map(fileKey),
  ];
}

function toggleSel(key, range) {
  const visible = visibleKeys();
  if (range && state.lastClicked != null) {
    const a = visible.indexOf(state.lastClicked);
    const b = visible.indexOf(key);
    if (a >= 0 && b >= 0) {
      for (const k of visible.slice(Math.min(a, b), Math.max(a, b) + 1)) state.sel.add(k);
      render();
      return;
    }
  }
  if (state.sel.has(key)) state.sel.delete(key);
  else state.sel.add(key);
  state.lastClicked = key;
  render();
}

function renderSelbar() {
  const n = state.sel.size;
  $('selbar').classList.toggle('hide', n === 0);
  if (!n) return;
  const pastas = selectedFolders().length;
  const arquivos = selectedItems().length;
  const partes = [];
  if (arquivos) partes.push(`${arquivos} arquivo${arquivos === 1 ? '' : 's'}`);
  if (pastas) partes.push(`${pastas} pasta${pastas === 1 ? '' : 's'}`);
  $('selCount').textContent = partes.join(' e ') + ' selecionado' + (n === 1 ? '' : 's');
  const inTrash = state.scope === 'trash';
  for (const [id, show] of [
    ['selDownload', !inTrash], ['selMove', !inTrash], ['selFav', !inTrash],
    ['selTrash', !inTrash], ['selRestore', inTrash], ['selDestroy', inTrash],
  ]) $(id).style.display = show ? '' : 'none';
}

/* ---------------------------- navegação ----------------------------- */

function goTo(path) {
  state.cwd = M.normalizePath(path);
  state.scope = 'drive';
  state.query = ''; $('q').value = '';
  state.sel.clear();
  state.details = null;
  render();
}

function openItem(it) {
  if (it.man.locked) { requireKey(); return; }
  if (isPreviewable(it.man.n)) openViewer(it);
  else startDownload(it);
}

/* ---------------------------- menus -------------------------------- */

function showMenu(x, y, entries) {
  document.querySelector('.menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'menu';
  for (const e of entries) {
    if (e === 'sep') { menu.appendChild(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.textContent = e.label;
    if (e.cls) b.className = e.cls;
    b.onclick = () => { menu.remove(); e.run(); };
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  menu.style.left = `${Math.min(x, innerWidth - menu.offsetWidth - 10)}px`;
  menu.style.top = `${Math.min(y, innerHeight - menu.offsetHeight - 10)}px`;
  setTimeout(() => {
    const close = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener('click', close);
        document.removeEventListener('contextmenu', close);
      }
    };
    document.addEventListener('click', close);
    document.addEventListener('contextmenu', close);
  }, 0);
}

function rowEntries(it) {
  if (it.man.tr) {
    return [
      { label: 'Restaurar', run: () => bulkTrash([it], false) },
      { label: 'Apagar definitivamente', run: () => bulkDestroy([it]), cls: 'danger' },
    ];
  }
  return [
    ...(isPreviewable(it.man.n) ? [{ label: 'Abrir', run: () => openViewer(it) }] : []),
    { label: 'Baixar', run: () => startDownload(it) },
    { label: 'Renomear', run: () => beginRename(it) },
    { label: 'Mover para pasta', run: () => bulkMove([it]) },
    { label: it.man.fv ? 'Remover dos favoritos' : 'Favoritar', run: () => bulkFavorite([it], !it.man.fv) },
    { label: 'Detalhes', run: () => { state.details = it.msgId; render(); } },
    'sep',
    { label: 'Mover para a lixeira', run: () => bulkTrash([it], true), cls: 'danger' },
  ];
}

function folderEntries(path, name) {
  return [
    { label: 'Abrir', run: () => goTo(path) },
    { label: 'Renomear', run: () => renameFolder(path, name) },
    'sep',
    { label: 'Mover conteúdo para a lixeira', run: () => trashFolder(path), cls: 'danger' },
  ];
}

function areaEntries() {
  return [
    { label: 'Nova pasta', run: () => newFolder() },
    'sep',
    { label: 'Enviar arquivos', run: () => $('filePicker').click() },
    { label: 'Enviar pasta', run: () => $('folderPicker').click() },
    'sep',
    { label: 'Selecionar tudo', run: () => selectAll() },
    { label: 'Atualizar', run: () => reload() },
  ];
}

/* ------------------------- operações em lote ------------------------ */

let busyDepth = 0;
function busy(on, text = '') {
  busyDepth += on ? 1 : -1;
  document.body.classList.toggle('busy', busyDepth > 0);
  if (on && text) setStatus([{ text }]);
}

/** Reescreve o manifesto de vários itens, um a um, com progresso. */
async function patchItems(items, patchOf, label) {
  if (!items.length) return;
  busy(true);
  let done = 0;
  for (const it of items) {
    setStatus([{ text: `${label} ${++done} de ${items.length}…` }]);
    const man = { ...it.man, ...patchOf(it), mt: Date.now() };
    try {
      const caption = await M.encode(man, man.e ? state.contentKey : null);
      await TG.editCaption(state.client, state.drive.entity, it.msgId, caption);
      it.man = man;
    } catch (err) {
      console.warn('falha ao atualizar', it.msgId, err);
    }
  }
  busy(false);
  state.sel.clear();
  render();
}

/**
 * Move a seleção inteira. Pasta não é uma mensagem no canal: mover uma pasta
 * é reescrever o prefixo do caminho de tudo que está dentro dela.
 */
async function bulkMove(items = null, folders = null) {
  const arquivos = items ?? selectedItems();
  const pastas = folders ?? selectedFolders();
  const total = arquivos.length + pastas.length;
  if (!total) return;

  const dest = await pickFolder(`Mover ${total} item${total === 1 ? '' : 's'}`);
  if (dest === null) return;

  // Mover uma pasta para dentro dela mesma apagaria a árvore.
  for (const p of pastas) {
    if (dest === p || dest.startsWith(p + '/')) {
      alert(`Não dá para mover "${M.baseName(p)}" para dentro dela mesma.`);
      return;
    }
  }

  state.localFolders.add(dest); saveFolders();

  const patches = new Map();
  for (const it of arquivos) patches.set(it.msgId, dest);

  for (const p of pastas) {
    const novoPrefixo = M.joinPath(dest, M.baseName(p));
    for (const it of filesUnder(p)) {
      patches.set(it.msgId, novoPrefixo + M.normalizePath(it.man.p).slice(p.length));
    }
    for (const local of [...state.localFolders]) {
      const n = M.normalizePath(local);
      if (n === p || n.startsWith(p + '/')) {
        state.localFolders.delete(local);
        state.localFolders.add(novoPrefixo + n.slice(p.length));
      }
    }
  }
  saveFolders();

  const alvos = [...patches.keys()].map(itemById).filter(Boolean);
  await patchItems(alvos, (it) => ({ p: patches.get(it.msgId) }), 'Movendo');
}

async function bulkTrash(items, into, folders = []) {
  const alvos = new Map();
  for (const it of items) alvos.set(it.msgId, it);
  for (const p of folders) for (const it of filesUnder(p)) alvos.set(it.msgId, it);
  const lista = [...alvos.values()];
  if (!lista.length) return;

  if (into && state.confirmDelete) {
    const oque = folders.length
      ? `${lista.length} arquivo${lista.length === 1 ? '' : 's'} de ${folders.length} pasta${folders.length === 1 ? '' : 's'}`
      : `${lista.length} arquivo${lista.length === 1 ? '' : 's'}`;
    if (!confirm(`Mover ${oque} para a lixeira?\n\nDá para restaurar depois.`)) return;
  }

  if (into) {
    for (const p of folders) {
      for (const local of [...state.localFolders]) {
        const n = M.normalizePath(local);
        if (n === p || n.startsWith(p + '/')) state.localFolders.delete(local);
      }
    }
    saveFolders();
  }
  await patchItems(lista, () => ({ tr: into ? Date.now() : null }), into ? 'Removendo' : 'Restaurando');
}

async function bulkFavorite(items, on) {
  await patchItems(items, () => ({ fv: on }), on ? 'Favoritando' : 'Desmarcando');
}

async function bulkDestroy(items) {
  if (!confirm(`Apagar ${items.length} arquivo${items.length === 1 ? '' : 's'} para sempre? As mensagens saem do canal e não há como desfazer.`)) return;
  busy(true, 'Apagando…');
  try {
    await TG.deleteMessages(state.client, state.drive.entity, items.map((i) => i.msgId));
    const gone = new Set(items.map((i) => i.msgId));
    state.items = state.items.filter((i) => !gone.has(i.msgId));
  } catch (err) {
    alert('Não deu certo: ' + humanError(err));
  }
  busy(false);
  state.sel.clear();
  render();
}

async function bulkDownload(items) {
  for (const it of items) await startDownload(it);
}

/* --------------------------- pastas -------------------------------- */

async function newFolder() {
  const name = await ask('Nova pasta', 'A pasta aparece no drive assim que receber o primeiro arquivo.', '');
  if (!name) return;
  state.localFolders.add(M.joinPath(state.cwd, name));
  saveFolders();
  render();
}

async function renameFolder(path, name) {
  const novo = await ask('Renomear pasta', 'Todos os arquivos dentro dela passam a apontar para o novo caminho.', name, 'Renomear');
  if (!novo || novo === name) return;
  const destino = M.joinPath(M.parentOf(path), novo);

  const afetados = state.items.filter((i) => {
    const p = M.normalizePath(i.man.p);
    return !i.man.tr && (p === path || p.startsWith(path + '/'));
  });

  // renomeia também as pastas vazias guardadas localmente
  for (const p of [...state.localFolders]) {
    const n = M.normalizePath(p);
    if (n === path || n.startsWith(path + '/')) {
      state.localFolders.delete(p);
      state.localFolders.add(destino + n.slice(path.length));
    }
  }
  saveFolders();

  await patchItems(afetados, (it) => ({
    p: destino + M.normalizePath(it.man.p).slice(path.length),
  }), 'Renomeando');

  if (state.cwd === path || state.cwd.startsWith(path + '/')) goTo(destino);
}

async function trashFolder(path) {
  await bulkTrash([], true, [path]);
}

/** Diálogo com a árvore de pastas. Devolve o caminho ou null. */
function pickFolder(title) {
  const dlg = $('dlgMove');
  $('moveHint').textContent = 'Escolha a pasta de destino.';
  dlg.querySelector('h3').textContent = title;
  let chosen = state.cwd;

  const draw = () => {
    const ul = $('moveTree');
    ul.innerHTML = '';
    for (const path of allFolderPaths()) {
      const depth = path === '/' ? 0 : path.split('/').length - 1;
      const li = document.createElement('li');
      li.className = 'tnode' + (path === chosen ? ' on' : '');
      li.style.paddingLeft = `${10 + depth * 16}px`;
      li.innerHTML = `<span class="glyph folder">${ICON.folder}</span><span></span>`;
      li.querySelector('span:last-child').textContent = path === '/' ? 'Meu drive' : M.baseName(path);
      li.onclick = () => { chosen = path; draw(); };
      ul.appendChild(li);
    }
  };
  draw();

  $('moveNewFolder').onclick = async () => {
    const name = await ask('Nova pasta', `Será criada dentro de ${chosen === '/' ? 'Meu drive' : chosen}.`, '');
    if (!name) return;
    const p = M.joinPath(chosen, name);
    state.localFolders.add(p); saveFolders();
    chosen = p; draw();
  };

  const d = deferred();
  dlg.onclose = () => d.resolve(dlg.returnValue === 'ok' ? chosen : null);
  dlg.showModal();
  return d.promise;
}

function dropOnFolder(e, path) {
  const raw = e.dataTransfer.getData('text/td-items');
  if (!raw) return;   // arquivo vindo do computador cai no handler da área
  let chaves;
  try { chaves = JSON.parse(raw); } catch { return; }

  const arquivos = chaves.filter((k) => k.startsWith('m:'))
    .map((k) => itemById(Number(k.slice(2)))).filter(Boolean);
  const pastas = chaves.filter((k) => k.startsWith('f:')).map((k) => k.slice(2));
  if (!arquivos.length && !pastas.length) return;

  const destino = M.normalizePath(path);
  for (const p of pastas) {
    if (destino === p || destino.startsWith(p + '/')) return;   // dentro de si mesma
  }

  state.localFolders.add(destino); saveFolders();

  const patches = new Map();
  for (const it of arquivos) patches.set(it.msgId, destino);
  for (const p of pastas) {
    const novoPrefixo = M.joinPath(destino, M.baseName(p));
    for (const it of filesUnder(p)) {
      patches.set(it.msgId, novoPrefixo + M.normalizePath(it.man.p).slice(p.length));
    }
    for (const local of [...state.localFolders]) {
      const n = M.normalizePath(local);
      if (n === p || n.startsWith(p + '/')) {
        state.localFolders.delete(local);
        state.localFolders.add(novoPrefixo + n.slice(p.length));
      }
    }
  }
  saveFolders();

  const alvos = [...patches.keys()].map(itemById).filter(Boolean);
  patchItems(alvos, (it) => ({ p: patches.get(it.msgId) }), 'Movendo');
}

/* ------------------------ renomear no lugar ------------------------- */

function beginRename(it) {
  const row = [...document.querySelectorAll('.row, .tile')].find((el) => el.__item === it);
  const target = row?.querySelector('b, .tname');
  if (!target) { renameViaDialog(it); return; }

  const antigo = it.man.n || '';
  const input = document.createElement('input');
  input.className = 'inline-rename';
  input.value = antigo;
  target.replaceWith(input);
  input.focus();
  const dot = antigo.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : antigo.length);

  let fechado = false;
  const finish = async (save) => {
    if (fechado) return;
    fechado = true;
    const novo = input.value.trim();
    if (save && novo && novo !== antigo) await patchItems([it], () => ({ n: novo }), 'Renomeando');
    else render();
  };
  input.onblur = () => finish(true);
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopPropagation();
  };
}

async function renameViaDialog(it) {
  const novo = await ask('Renomear', 'O nome fica guardado na legenda da mensagem.', it.man.n || '', 'Renomear');
  if (novo) await patchItems([it], () => ({ n: novo }), 'Renomeando');
}

/* ---------------------------- detalhes ------------------------------ */

function renderDetails() {
  const panel = $('details');
  const it = state.details ? itemById(state.details) : null;
  panel.classList.toggle('hide', !it);
  if (!it) return;

  const rows = [
    ['Nome', it.man.locked ? 'cifrado' : (it.man.n || '—')],
    ['Pasta', M.normalizePath(it.man.p)],
    ['Tamanho', humanSize(it.man.s || 0)],
    ['Tipo', it.man.m || '—'],
    ['Criado', humanDate(it.man.ct, true)],
    ['Modificado', humanDate(it.man.mt, true)],
    ['Criptografia', it.man.e || it.man.locked ? 'cifrado neste drive' : 'em claro'],
    ['Favorito', it.man.fv ? 'sim' : 'não'],
    ['Mensagem', `#${it.msgId}`],
  ];
  const body = $('detBody');
  body.innerHTML = '';
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    body.append(dt, dd);
  }
}

/* --------------------------- visualizador --------------------------- */

let viewerUrl = null;
let viewerStream = null;
let streamingPronto = false;

/** Limite para o que precisa ir inteiro para a memória antes de abrir. */
const PREVIEW_MEMORIA = 120 * 1024 * 1024;

async function openViewer(it) {
  const name = it.man.n || 'arquivo';
  $('viewerName').textContent = name;
  $('viewerBody').innerHTML = '<div class="vloading">Carregando…</div>';
  $('viewer').classList.remove('hide');
  $('viewerDownload').onclick = () => startDownload(it);

  // Vídeo e áudio tocam por streaming: o player pede faixas de bytes e o
  // service worker busca só aquele trecho. Sem isso um vídeo de 1 GB teria
  // de ser baixado inteiro antes do primeiro quadro aparecer.
  if (isStreamable(name) && streamingPronto && podeStreamar(it)) {
    const { id, url } = abrirStream(state.client, it);
    viewerStream = id;
    const el = document.createElement(kindOf(name) === 'audio' ? 'audio' : 'video');
    el.src = url;
    el.controls = true;
    el.autoplay = true;
    el.preload = 'metadata';
    el.onerror = () => {
      $('viewerBody').innerHTML = '<div class="vloading"></div>';
      $('viewerBody').firstChild.textContent =
        'Este formato não tocou no navegador. Use Baixar para abrir no seu player.';
    };
    $('viewerBody').innerHTML = '';
    $('viewerBody').appendChild(el);
    return;
  }

  if (Number(it.man.s || 0) > PREVIEW_MEMORIA) {
    $('viewerBody').innerHTML = '<div class="vloading"></div>';
    $('viewerBody').firstChild.textContent =
      `${humanSize(it.man.s)} é grande demais para abrir na memória. Use Baixar.`;
    return;
  }

  try {
    const bytes = await fetchDecrypted(it);
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = URL.createObjectURL(new Blob([bytes], { type: it.man.m || 'application/octet-stream' }));

    const body = $('viewerBody');
    body.innerHTML = '';
    if (kindOf(name) === 'image') {
      const img = document.createElement('img');
      img.src = viewerUrl; img.alt = name;
      body.appendChild(img);
    } else {
      // PDF: o visualizador nativo do navegador. No iOS costuma falhar,
      // por isso o link de abrir em nova aba fica sempre à mão.
      const frame = document.createElement('iframe');
      frame.src = viewerUrl;
      body.appendChild(frame);
      const link = document.createElement('a');
      link.className = 'btn quiet vfallback';
      link.href = viewerUrl; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = 'Abrir em nova aba';
      body.appendChild(link);
    }
  } catch (err) {
    $('viewerBody').innerHTML = '<div class="vloading"></div>';
    $('viewerBody').firstChild.textContent = 'Não deu para abrir: ' + humanError(err);
  }
}

function closeViewer() {
  $('viewer').classList.add('hide');
  // parar a mídia antes de soltar a URL evita pedido de faixa órfão
  $('viewerBody').querySelectorAll('video, audio').forEach((el) => { el.pause(); el.removeAttribute('src'); el.load(); });
  $('viewerBody').innerHTML = '';
  if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = null; }
  if (viewerStream) { fecharStream(viewerStream); viewerStream = null; }
}

/* --------------------------- miniaturas ----------------------------- */

const thumbCache = new Map();
let thumbObserver = null;

function queueThumb(tile, it) {
  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        thumbObserver.unobserve(e.target);
        loadThumb(e.target, e.target.__item);
      }
    }, { rootMargin: '150px' });
  }
  thumbObserver.observe(tile);
}

async function loadThumb(tile, it) {
  if (!it || !tile.isConnected) return;
  const cached = thumbCache.get(it.msgId);
  if (cached) return paintThumb(tile, cached);
  if (!it.msg?.document?.thumbs?.length) return;   // sem miniatura no Telegram
  try {
    const bytes = await state.client.downloadMedia(it.msg, { thumb: 0 });
    const url = URL.createObjectURL(new Blob([bytes]));
    thumbCache.set(it.msgId, url);
    paintThumb(tile, url);
  } catch { /* segue com o ícone */ }
}

function paintThumb(tile, url) {
  const box = tile.querySelector('.thumb');
  if (!box || !tile.isConnected) return;
  const img = document.createElement('img');
  img.src = url; img.alt = '';
  box.querySelector('.glyph')?.remove();
  box.prepend(img);
}

/* ------------------------- chave de criptografia ------------------------ */

function rememberKey(bytes, yes) {
  if (yes) store.set(KEY.remembered, b64.encode(bytes));
  else store.del(KEY.remembered);
}

async function requireKey() {
  if (state.contentKey) return state.contentKey;
  const backupB64 = store.get(KEY.backup);
  if (!backupB64) {
    alert('Nenhuma chave configurada neste navegador.\n\nAbra "Conta e drive" para criar uma chave ou importar o backup de outro aparelho.');
    return null;
  }
  const blob = b64.decode(backupB64);
  const hint = readKeyBackupHint(blob);

  for (let tries = 0; tries < 3; tries++) {
    const answer = await askPass('Desbloquear criptografia',
      hint ? `Digite a senha da chave deste drive. Sua dica: ${hint}`
           : 'Digite a senha da chave deste drive. Sem ela, os arquivos cifrados aparecem sem nome.');
    if (!answer?.pass) return null;
    try {
      state.contentKey = await decodeKeyBackup(blob, answer.pass);
      rememberKey(state.contentKey, answer.remember);
      await reload();
      return state.contentKey;
    } catch (err) {
      $('passErr').textContent = err.message;
      $('passErr').classList.remove('hide');
    }
  }
  return null;
}

async function makeKey() {
  if (store.get(KEY.backup) && !confirm(
    'Já existe uma chave neste navegador.\n\nCriar outra torna ilegíveis os arquivos cifrados com a anterior. Continuar?'
  )) return;
  const answer = await askPass('Criar chave de criptografia',
    'Escolha uma senha. Ela protege o backup da chave — é com esse arquivo que você leva a criptografia para os outros aparelhos.',
    'Criar chave');
  if (!answer?.pass) return;
  const hint = await ask('Dica da senha (opcional)',
    'Fica em texto claro dentro do arquivo de backup. Nunca escreva a senha aqui.', '', 'Salvar');

  const { contentKey, backup } = await createKeyBackup(answer.pass, hint || '');
  store.set(KEY.backup, b64.encode(backup));
  rememberKey(contentKey, answer.remember);
  state.contentKey = contentKey;
  state.hasKey = true;
  saveBlob(backup, BACKUP_FILE_NAME);
  alert(`Chave criada e o backup "${BACKUP_FILE_NAME}" foi baixado.\n\nGuarde esse arquivo. É ele que você importa no TeleDrive dos outros aparelhos para eles lerem os arquivos cifrados — e é a única forma de recuperar a chave se perder este navegador.`);
  refreshAccountDialog();
  render();
}

async function importKey(file) {
  const blob = new Uint8Array(await file.arrayBuffer());
  const hint = readKeyBackupHint(blob);
  if (hint === null) { alert('Este arquivo não é um backup de chave do TeleDrive.'); return; }
  const answer = await askPass('Importar chave',
    hint ? `Digite a senha deste backup. Dica guardada nele: ${hint}` : 'Digite a senha deste backup.',
    'Importar');
  if (!answer?.pass) return;
  try {
    const contentKey = await decodeKeyBackup(blob, answer.pass);
    store.set(KEY.backup, b64.encode(blob));
    rememberKey(contentKey, answer.remember);
    state.contentKey = contentKey;
    state.hasKey = true;
    await reload();
    refreshAccountDialog();
    alert('Chave importada. Os arquivos cifrados deste drive agora abrem aqui.');
  } catch (err) {
    alert('Não deu certo: ' + err.message);
  }
}

function exportKey() {
  const backupB64 = store.get(KEY.backup);
  if (backupB64) saveBlob(b64.decode(backupB64), BACKUP_FILE_NAME);
}

/* ----------------------------- fila ------------------------------- */

const queue = [];          // { id, label, status, pct, note, run, el }
let running = false;
let cancelPending = false;

function enqueue(label, run) {
  const job = { id: crypto.randomUUID(), label, status: 'fila', pct: 0, note: 'na fila', run };
  queue.push(job);
  drawQueue();
  pump();
  return job;
}

async function pump() {
  if (running) return;
  running = true;
  while (true) {
    const job = queue.find((j) => j.status === 'fila');
    if (!job) break;
    if (cancelPending) { job.status = 'cancelado'; job.note = 'cancelado'; drawQueue(); continue; }
    job.status = 'ativo';
    drawQueue();
    try {
      await job.run(job);
      if (job.status === 'ativo') { job.status = 'pronto'; job.pct = 100; }
    } catch (err) {
      job.status = 'falhou';
      job.note = 'falhou: ' + humanError(err);
    }
    drawQueue();
  }
  running = false;
  cancelPending = false;
  if (queue.every((j) => j.status === 'pronto')) {
    setTimeout(() => { if (queue.every((j) => j.status === 'pronto')) { queue.length = 0; drawQueue(); } }, 3000);
  }
  await reload();
}

function jobProgress(job, pct, note) {
  job.pct = Math.max(0, Math.min(100, pct));
  if (note) job.note = note;
  drawQueue();
}

function drawQueue() {
  const box = $('xfer');
  box.classList.toggle('hide', queue.length === 0);
  const pend = queue.filter((j) => j.status === 'fila' || j.status === 'ativo').length;
  $('xferTitle').textContent = pend ? `Transferindo (${pend})` : 'Transferências';
  $('xferCancelAll').classList.toggle('hide', pend === 0);

  const list = $('xferList');
  list.innerHTML = '';
  for (const job of queue) {
    const li = document.createElement('li');
    li.className = 'xjob ' + job.status;
    li.innerHTML = `<div class="xname"></div><div class="bar"><i></i></div>
      <div class="xfoot"><span class="xstate"></span><button class="btn bare xact"></button></div>`;
    li.querySelector('.xname').textContent = job.label;
    li.querySelector('i').style.width = `${job.pct}%`;
    li.querySelector('.xstate').textContent = job.note;
    const act = li.querySelector('.xact');
    if (job.status === 'falhou') {
      act.textContent = 'Repetir';
      act.onclick = () => { job.status = 'fila'; job.pct = 0; job.note = 'na fila'; drawQueue(); pump(); };
    } else if (job.status === 'fila') {
      act.textContent = 'Cancelar';
      act.onclick = () => { job.status = 'cancelado'; job.note = 'cancelado'; drawQueue(); };
    } else {
      act.remove();
    }
    list.appendChild(li);
  }
}

/* ------------------------------- envio ---------------------------------- */

const TELEGRAM_FILE_LIMIT = 2 * 1024 * 1024 * 1024;   // 4 GB com Premium

function entriesFromDrop(dataTransfer) {
  const roots = [...(dataTransfer.items || [])]
    .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!roots.length) {
    return Promise.resolve([...(dataTransfer.files || [])].map((file) => ({ file, relPath: '' })));
  }
  const out = [];
  const readFile = (entry) => new Promise((res, rej) => entry.file(res, rej));
  async function walk(entry, prefix) {
    if (entry.isFile) { out.push({ file: await readFile(entry), relPath: prefix + entry.name }); return; }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
    } while (batch.length);
  }
  return (async () => { for (const r of roots) await walk(r, ''); return out; })();
}

/** Arquivo já existente com o mesmo nome na mesma pasta, se houver. */
function acharDuplicado(nome, pasta) {
  const p = M.normalizePath(pasta);
  return state.items.find((it) =>
    !it.man.tr && !it.man.locked
    && (it.man.n || '') === nome
    && M.normalizePath(it.man.p) === p) || null;
}

/**
 * Pergunta o que fazer com um arquivo que já existe. Devolve
 * { acao: 'pular' | 'substituir' | 'manter' | 'cancelar', todos: boolean }.
 */
function perguntarDuplicado(file, existente, restantes) {
  const dlg = $('dlgDup');
  const mesmoTamanho = Number(existente.man.s || 0) === file.size;

  $('dupName').textContent = file.name;
  $('dupWhere').textContent = M.normalizePath(existente.man.p);
  $('dupExisting').textContent =
    `${humanSize(existente.man.s || 0)} · ${humanDate(existente.man.mt || existente.man.ct)}`;
  $('dupIncoming').textContent = humanSize(file.size);
  $('dupSame').textContent = mesmoTamanho
    ? 'Mesmo tamanho — quase certamente é o mesmo arquivo, já copiado.'
    : 'Tamanhos diferentes — o do drive pode ter ficado incompleto.';
  $('dupSame').className = mesmoTamanho ? 'warn ok-note' : 'warn';
  $('dupCount').textContent = restantes > 1
    ? `Este é o 1º de ${restantes} arquivos que já existem no destino.`
    : '';
  $('dupCount').classList.toggle('hide', restantes <= 1);
  $('dupAll').checked = restantes > 1;

  const d = deferred();
  const fechar = (acao) => {
    dlg.returnValue = acao;
    dlg.close(acao);
  };
  dlg.querySelectorAll('[data-dup]').forEach((b) => {
    b.onclick = () => fechar(b.dataset.dup);
  });
  dlg.onclose = () => d.resolve({
    acao: dlg.returnValue && dlg.returnValue !== 'cancel' ? dlg.returnValue : 'cancelar',
    todos: $('dupAll').checked,
  });
  dlg.showModal();
  return d.promise;
}

async function uploadEntries(entries) {
  const files = entries.filter((e) => e.file);
  if (!files.length) return;

  let key = null;
  if (state.encryptNew && state.hasKey) {
    key = await requireKey();
    if (!key) return;
  }
  const destBase = state.cwd;

  // Resolve o destino de cada arquivo antes de qualquer envio, para saber
  // de uma vez quantos já existem e poder decidir em bloco.
  const planejados = files.map(({ file, relPath }) => {
    const rel = relPath || '';
    const relDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    return { file, rel, destFolder: relDir ? M.joinPath(destBase, relDir) : destBase };
  });

  let duplicadosRestantes = planejados.filter((x) => acharDuplicado(x.file.name, x.destFolder)).length;
  let decisaoGeral = null;   // escolha aplicada a todos, quando pedida

  for (const { file, rel, destFolder } of planejados) {
    const existente = acharDuplicado(file.name, destFolder);
    let substituir = null;

    if (existente) {
      let acao = decisaoGeral;
      if (!acao) {
        const r = await perguntarDuplicado(file, existente, duplicadosRestantes);
        acao = r.acao;
        if (r.todos && acao !== 'cancelar') decisaoGeral = acao;
      }
      duplicadosRestantes--;

      if (acao === 'cancelar') return;
      if (acao === 'pular') {
        Hist.registrar({
          nome: file.name, caminho: destFolder, tamanho: file.size,
          estado: Hist.ESTADOS.pulado, motivo: 'já existia no destino',
        });
        continue;
      }
      if (acao === 'substituir') substituir = existente;
      // 'manter' segue adiante e cria um segundo arquivo com o mesmo nome
    }

    enqueue(rel || file.name, async (job) => {
      if (file.size > TELEGRAM_FILE_LIMIT) {
        job.status = 'falhou';
        job.note = `${humanSize(file.size)} passa do limite de 2 GB por arquivo`;
        Hist.registrar({
          nome: file.name, caminho: destFolder, tamanho: file.size,
          estado: Hist.ESTADOS.grande, motivo: 'acima do limite de 2 GB do Telegram',
        });
        atualizarAvisoHistorico();
        return;
      }

      // O Telegram não aceita documento sem conteúdo; melhor dizer isso do
      // que deixar vazar um erro de API sem explicação.
      if (file.size === 0) {
        job.status = 'falhou';
        job.note = 'arquivo vazio — o Telegram não aceita documento de 0 byte';
        Hist.registrar({
          nome: file.name, caminho: destFolder, tamanho: 0,
          estado: Hist.ESTADOS.falhou, motivo: 'arquivo vazio (0 byte)',
        });
        atualizarAvisoHistorico();
        return;
      }

      const willEncrypt = !!key;
      if (destFolder !== destBase) { state.localFolders.add(destFolder); saveFolders(); }

      const man = M.newManifest({
        id: crypto.randomUUID(), name: file.name, folderPath: destFolder,
        mime: file.type, size: file.size, encrypted: willEncrypt,
      });
      const caption = await M.encode(man, willEncrypt ? key : null);
      const wireName = willEncrypt ? `${man.id}.tde` : file.name;

      // A fonte entrega os bytes sob demanda, fatia por fatia. Nada aqui
      // carrega o arquivo inteiro na memória, nem para cifrar.
      const fonte = willEncrypt
        ? fonteCifrada(file, key, (d, t) => jobProgress(job, (d / t) * 8, 'cifrando'))
        : fonteEmClaro(file);

      try {
        await TG.uploadFile(state.client, state.drive.entity, {
          fonte, name: wireName, caption,
          cancelado: () => job.status === 'cancelado',
          onProgress: (sent, total) =>
            jobProgress(job, (sent / total) * 100, willEncrypt ? 'cifrando e enviando' : 'enviando'),
        });
      } catch (err) {
        Hist.registrar({
          nome: file.name, caminho: destFolder, tamanho: file.size,
          estado: Hist.ESTADOS.falhou, motivo: humanError(err),
        });
        atualizarAvisoHistorico();
        throw err;
      }

      // A troca só acontece depois que o novo subiu: se o envio falhar, o
      // arquivo antigo continua lá.
      if (substituir) {
        jobProgress(job, 100, 'removendo a versão antiga');
        try {
          await TG.deleteMessages(state.client, state.drive.entity, [substituir.msgId]);
          state.items = state.items.filter((x) => x.msgId !== substituir.msgId);
        } catch { /* o novo já está salvo; o antigo some no próximo Atualizar */ }
      }

      Hist.registrar({
        nome: file.name, caminho: destFolder, tamanho: file.size,
        estado: substituir ? Hist.ESTADOS.substituido : Hist.ESTADOS.enviado,
        motivo: willEncrypt ? 'cifrado' : '',
      });
      atualizarAvisoHistorico();
      job.note = substituir
        ? 'substituído'
        : (willEncrypt ? 'enviado e cifrado' : 'enviado');
    });
  }
}

/* ------------------------------ download -------------------------------- */

async function fetchDecrypted(it, job) {
  let key = null;
  if (it.man.e || it.man.locked) {
    key = await requireKey();
    if (!key) throw new Error('criptografia trancada');
    const fresh = itemById(it.msgId);
    if (fresh) it = fresh;
  }
  const data = await TG.downloadFile(state.client, it.msg, (got, total) => {
    if (job) jobProgress(job, (got / total) * (key ? 70 : 100), 'baixando');
  });
  if (!key) return data;
  if (job) jobProgress(job, 75, 'decifrando');
  return decryptBytes(key, data, (d, t) => { if (job) jobProgress(job, 75 + (d / t) * 25, 'decifrando'); });
}

async function startDownload(it) {
  enqueue(it.man.n || 'arquivo cifrado', async (job) => {
    const bytes = await fetchDecrypted(it, job);
    const fresh = itemById(it.msgId) || it;
    saveBlob(bytes, fresh.man.n || 'arquivo', fresh.man.m || 'application/octet-stream');
    job.note = 'pronto';
  });
}

/* ------------------------------- eventos -------------------------------- */

$('btnCreds').onclick = async () => {
  const apiId = $('apiId').value.trim();
  const apiHash = $('apiHash').value.trim();
  if (!apiId || !apiHash) { onlyPanel('s-phone'); return msg('mPhone', 'Preencha api_id e api_hash.', 'err'); }
  store.set(KEY.id, apiId); store.set(KEY.hash, apiHash);
  try { await doLogin(apiId, apiHash); }
  catch (err) {
    onlyPanel('s-phone');
    msg('mPhone', 'Não foi possível entrar: ' + (err?.message || err), 'err');
    $('btnPhone').disabled = false;
  }
};

$('btnUpload').onclick = (e) => {
  showMenu(e.clientX, e.clientY + 10, [
    { label: 'Enviar arquivos', run: () => $('filePicker').click() },
    { label: 'Enviar pasta inteira', run: () => $('folderPicker').click() },
  ]);
};
$('filePicker').onchange = (e) => {
  uploadEntries([...e.target.files].map((file) => ({ file, relPath: '' })));
  e.target.value = '';
};
$('folderPicker').onchange = (e) => {
  uploadEntries([...e.target.files].map((file) => ({ file, relPath: file.webkitRelativePath || '' })));
  e.target.value = '';
};
$('btnNewFolder').onclick = () => newFolder();
$('btnReload').onclick = () => reload();
$('btnUnlock').onclick = () => requireKey();

/* ---------------------------- histórico ---------------------------- */

let histFiltro = 'problemas';

/** Marca no botão quantos itens precisam de atenção. */
function atualizarAvisoHistorico() {
  const n = Hist.listar('problemas').length;
  const selo = $('histBadge');
  selo.textContent = n > 99 ? '99+' : String(n);
  selo.classList.toggle('hide', n === 0);
}

function desenharHistorico() {
  // Redesenhar é também a hora de reconferir o selo: assim ele fica certo
  // depois de limpar a lista ou de um envio que correu em outra aba.
  atualizarAvisoHistorico();

  const ul = $('histList');
  ul.innerHTML = '';
  const itens = Hist.listar(histFiltro);

  if (!itens.length) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="vazio"></span>';
    li.querySelector('.vazio').textContent = histFiltro === 'problemas'
      ? 'Nenhum problema registrado. Tudo que você enviou passou.'
      : 'Nada registrado ainda.';
    ul.appendChild(li);
    return;
  }

  const tom = {
    [Hist.ESTADOS.enviado]: 'bom',
    [Hist.ESTADOS.substituido]: 'bom',
    [Hist.ESTADOS.pulado]: 'neutro',
    [Hist.ESTADOS.grande]: 'ruim',
    [Hist.ESTADOS.falhou]: 'ruim',
  };

  for (const x of itens) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="hname"></span><span class="htag"></span><span class="hmeta"></span>';
    li.querySelector('.hname').textContent = x.n;
    const tag = li.querySelector('.htag');
    tag.textContent = x.e;
    tag.classList.add(tom[x.e] || 'neutro');
    li.querySelector('.hmeta').textContent =
      [humanSize(x.s), x.p, humanDate(x.t, true), x.m].filter(Boolean).join('  ·  ');
    ul.appendChild(li);
  }
}

$('btnHistory').onclick = () => { desenharHistorico(); $('dlgHistory').showModal(); };
$('histClose').onclick = () => $('dlgHistory').close();
$('histExport').onclick = () => {
  const texto = new TextEncoder().encode(Hist.exportarTexto());
  saveBlob(texto, 'teledrive-historico.txt', 'text/plain;charset=utf-8');
};
$('histClear').onclick = () => {
  if (!confirm('Apagar todo o histórico de envios?\n\nIsso não mexe nos seus arquivos — só na lista.')) return;
  Hist.limpar();
  atualizarAvisoHistorico();
  desenharHistorico();
};
$('histFilters').querySelectorAll('[data-hf]').forEach((b) => {
  b.onclick = () => {
    histFiltro = b.dataset.hf;
    $('histFilters').querySelectorAll('[data-hf]').forEach((o) => o.classList.toggle('on', o === b));
    desenharHistorico();
  };
});

$('btnFav').onclick = () => {
  state.scope = state.scope === 'fav' ? 'drive' : 'fav';
  state.sel.clear(); render();
};
$('btnTrash').onclick = () => {
  state.scope = state.scope === 'trash' ? 'drive' : 'trash';
  state.sel.clear(); render();
};
$('btnEmptyTrash').onclick = () => {
  const all = state.items.filter((i) => i.man.tr);
  if (all.length) bulkDestroy(all);
};

$('btnView').onclick = () => {
  state.view = state.view === 'grid' ? 'list' : 'grid';
  store.set(KEY.view, state.view);
  render();
};

$('q').oninput = (e) => { state.query = e.target.value.trim(); state.sel.clear(); render(); };

function syncSortButtons() {
  $('btnDir').textContent = state.sort.dir === 1 ? 'Crescente' : 'Decrescente';
}
$('sortBy').onchange = (e) => {
  state.sort.by = e.target.value;
  store.set(KEY.sortBy, state.sort.by);
  render();
};
$('btnDir').onclick = () => {
  state.sort.dir *= -1;
  store.set(KEY.sortDir, String(state.sort.dir));
  syncSortButtons(); render();
};
document.querySelectorAll('.cols button[data-sort]').forEach((b) => {
  b.onclick = () => {
    const by = b.dataset.sort;
    if (state.sort.by === by) state.sort.dir *= -1;
    else { state.sort.by = by; state.sort.dir = 1; }
    $('sortBy').value = by;
    store.set(KEY.sortBy, state.sort.by);
    store.set(KEY.sortDir, String(state.sort.dir));
    syncSortButtons(); render();
  };
});

$('checkAll').onclick = (e) => {
  const keys = visibleKeys();
  if (e.target.checked) keys.forEach((k) => state.sel.add(k));
  else keys.forEach((k) => state.sel.delete(k));
  render();
};
function selectAll() { visibleKeys().forEach((k) => state.sel.add(k)); render(); }

$('selClear').innerHTML = ICON.close;
$('selClear').onclick = () => { state.sel.clear(); render(); };
$('selDownload').onclick = () => bulkDownload(selectionFiles());
$('selMove').onclick = () => bulkMove();
$('selFav').onclick = () => {
  const items = selectionFiles();
  bulkFavorite(items, !items.every((i) => i.man.fv));
};
$('selTrash').onclick = () => bulkTrash(selectedItems(), true, selectedFolders());
$('selRestore').onclick = () => bulkTrash(selectedItems(), false);
$('selDestroy').onclick = () => bulkDestroy(selectedItems());

$('detClose').innerHTML = ICON.close;
$('detClose').onclick = () => { state.details = null; render(); };

$('viewerClose').innerHTML = ICON.close;
$('viewerClose').onclick = closeViewer;

$('xferClose').innerHTML = ICON.close;
$('xferClose').onclick = () => { queue.length = 0; drawQueue(); };
$('xferCancelAll').onclick = () => {
  cancelPending = true;
  queue.forEach((j) => { if (j.status === 'fila') { j.status = 'cancelado'; j.note = 'cancelado'; } });
  drawQueue();
};

function refreshAccountDialog() {
  $('accWho').textContent = state.me
    ? `${[state.me.firstName, state.me.lastName].filter(Boolean).join(' ')}${state.me.username ? ` (@${state.me.username})` : ''}`
    : '';
  const kept = !!store.get(KEY.remembered);
  const chave = !state.hasKey ? 'nenhuma chave neste navegador'
    : state.contentKey ? (kept ? 'aberta e guardada aqui' : 'aberta nesta sessão')
    : 'configurada, trancada';
  const modo = state.encryptNew && state.hasKey
    ? 'novos envios saem cifrados'
    : 'novos envios saem em claro, legíveis por qualquer TeleDrive';
  $('accDrive').textContent = `Canal: ${state.drive?.title || '—'}\nChave: ${chave}\nEnvio: ${modo}`;
  $('cfgConfirmDelete').checked = state.confirmDelete;
  $('cfgEncrypt').checked = state.encryptNew && state.hasKey;
  $('cfgEncrypt').disabled = !state.hasKey;
  $('encNeedsKey').classList.toggle('hide', state.hasKey);
  $('btnExportKey').classList.toggle('hide', !state.hasKey);
  $('btnMakeKey').textContent = state.hasKey ? 'Trocar chave' : 'Criar chave';
  $('btnForget').classList.toggle('hide', !state.contentKey);
  $('btnForget').textContent = kept ? 'Esquecer chave guardada' : 'Trancar agora';
}

$('btnAccount').onclick = () => { refreshAccountDialog(); $('dlgAccount').showModal(); };
$('cfgEncrypt').onchange = (e) => {
  state.encryptNew = e.target.checked && state.hasKey;
  store.set(KEY.encryptNew, state.encryptNew ? '1' : '0');
  refreshAccountDialog(); render();
};
$('cfgConfirmDelete').onchange = (e) => {
  state.confirmDelete = e.target.checked;
  store.set(KEY.confirmDelete, state.confirmDelete ? '1' : '0');
};
$('btnMakeKey').onclick = () => makeKey();
$('btnExportKey').onclick = () => exportKey();
$('btnImportKey').onclick = () => $('keyPicker').click();
$('keyPicker').onchange = (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (f) importKey(f);
};
$('btnForget').onclick = async () => {
  state.contentKey = null;
  store.del(KEY.remembered);
  $('dlgAccount').close();
  await reload();
};
$('btnLogout').onclick = async () => {
  if (!confirm('Sair e apagar a sessão deste navegador?')) return;
  try { await state.client?.invoke(new (await import('telegram')).Api.auth.LogOut()); } catch { /* ignora */ }
  [KEY.session, KEY.drive].forEach(store.del);
  location.reload();
};

/* arrastar de fora para dentro, e menu de contexto */
const sheet = $('sheet');
['dragenter', 'dragover'].forEach((ev) => sheet.addEventListener(ev, (e) => {
  e.preventDefault();
  if (!e.dataTransfer.types.includes('text/td-items')) sheet.classList.add('dropping');
}));
['dragleave', 'drop'].forEach((ev) => sheet.addEventListener(ev, (e) => {
  e.preventDefault();
  if (ev === 'dragleave' && sheet.contains(e.relatedTarget)) return;
  sheet.classList.remove('dropping');
}));
sheet.addEventListener('drop', (e) => {
  if (e.dataTransfer?.types.includes('text/td-items')) return;  // mover interno
  if (!e.dataTransfer) return;
  entriesFromDrop(e.dataTransfer)
    .then((entries) => (entries.length ? uploadEntries(entries) : null))
    .catch((err) => alert('Não consegui ler o que foi arrastado: ' + humanError(err)));
});
/* ------------------- seleção arrastando no vazio -------------------- *
 *
 * Começa só em espaço vazio e só com o botão esquerdo do mouse: em cima de
 * uma linha o arrasto já significa mover o arquivo, e no toque significa
 * rolar a lista.
 *
 * Durante o arrasto as classes são trocadas direto no DOM em vez de chamar
 * render() — redesenhar a lista inteira a cada movimento do mouse trava
 * com algumas centenas de arquivos.
 * ------------------------------------------------------------------- */

let marquee = null;

function marqueeTargets() {
  // __key existe em arquivo e em pasta; é o que torna as duas selecionáveis.
  return [...sheet.querySelectorAll('.row, .tile')].filter((el) => el.__key);
}

function marqueeUpdate(e) {
  const L = Math.min(marquee.x0, e.clientX), R = Math.max(marquee.x0, e.clientX);
  const T = Math.min(marquee.y0, e.clientY), B = Math.max(marquee.y0, e.clientY);
  Object.assign(marquee.box.style, {
    left: `${L}px`, top: `${T}px`, width: `${R - L}px`, height: `${B - T}px`,
  });

  const next = new Set(marquee.add ? marquee.base : []);
  for (const el of marquee.targets) {
    const r = el.getBoundingClientRect();
    if (r.left < R && r.right > L && r.top < B && r.bottom > T) next.add(el.__key);
    const on = next.has(el.__key);
    el.classList.toggle('on', on);
    const cb = el.querySelector('.chk input');
    if (cb) cb.checked = on;
  }
  marquee.next = next;
}

function marqueeEnd(commit) {
  if (!marquee) return;
  marquee.box.remove();
  if (commit && marquee.next) state.sel = marquee.next;
  marquee = null;
  render();
}

sheet.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse' || e.button !== 0) return;
  if (e.target.closest('.row, .tile, button, input, a, select, .cols')) return;

  marquee = {
    x0: e.clientX, y0: e.clientY,
    add: e.ctrlKey || e.metaKey || e.shiftKey,
    base: new Set(state.sel),
    targets: marqueeTargets(),
    box: Object.assign(document.createElement('div'), { className: 'marquee' }),
    next: null,
  };
  if (!marquee.add) { state.sel.clear(); }
  document.body.appendChild(marquee.box);
  marqueeUpdate(e);
  e.preventDefault();   // sem isso o navegador começa a selecionar texto
});

window.addEventListener('pointermove', (e) => { if (marquee) marqueeUpdate(e); });
window.addEventListener('pointerup', () => marqueeEnd(true));
window.addEventListener('pointercancel', () => marqueeEnd(false));

sheet.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const el = e.target.closest('.row, .tile');
  if (el?.__item) showMenu(e.clientX, e.clientY, rowEntries(el.__item));
  else if (el?.__folder) showMenu(e.clientX, e.clientY, folderEntries(el.__folder, M.baseName(el.__folder)));
  else showMenu(e.clientX, e.clientY, areaEntries());
});

/* ----------------------------- teclado ------------------------------ */

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
  if (e.key === 'Escape' && marquee) { marqueeEnd(false); return; }
  if (!$('viewer').classList.contains('hide') && e.key === 'Escape') { closeViewer(); return; }
  if (document.querySelector('dialog[open]')) return;
  if (typing) {
    if (e.key === 'Escape' && e.target.id === 'q') { e.target.value = ''; state.query = ''; render(); e.target.blur(); }
    return;
  }
  if ($('app').classList.contains('hide')) return;

  if (e.key === '/') { e.preventDefault(); $('q').focus(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); selectAll(); return; }
  if (e.key === 'Escape') { state.sel.clear(); state.details = null; render(); return; }

  const sel = selectedItems();
  const pastas = selectedFolders();
  if (!sel.length && !pastas.length) return;
  if (e.key === 'F2' && sel.length) { e.preventDefault(); beginRename(sel[0]); }
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    state.scope === 'trash' ? bulkDestroy(sel) : bulkTrash(sel, true, pastas);
  } else if (e.key === 'Enter' && sel.length) { e.preventDefault(); openItem(sel[0]); }
});

/* -------------------------------- boot ---------------------------------- */

if (window.top !== window.self) {
  document.body.textContent =
    'O TeleDrive Web não funciona dentro de outra página. Abra pelo endereço original.';
  throw new Error('enquadrado em iframe');
}

async function boot() {
  const id = store.get(KEY.id), hash = store.get(KEY.hash), session = store.get(KEY.session);
  if (id) $('apiId').value = id;
  if (hash) $('apiHash').value = hash;
  $('btnView').innerHTML = state.view === 'grid' ? ICON.list : ICON.grid;

  if (id && hash && session) {
    onlyPanel('s-boot');
    try {
      state.client = TG.buildClient(id, hash, session);
      await state.client.connect();
      if (await state.client.isUserAuthorized()) { await enterDrive(); return; }
    } catch (err) {
      console.warn('Reconexão falhou:', err);
    }
    store.del(KEY.session);
  }
  onlyPanel('s-creds');
}

if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});

boot().catch((err) => {
  onlyPanel('s-boot');
  $('bootHint').textContent = 'Erro ao iniciar: ' + (err?.message || err);
});
