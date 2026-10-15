/* ------------------------------------------------------------------ *
 * Ícones e tipos de arquivo.
 *
 * O tipo sai da extensão, não do mime: o mime de um arquivo cifrado é
 * sempre octet-stream, e o nome verdadeiro vem do manifesto.
 * ------------------------------------------------------------------ */

const svg = (paths, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor"
        stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

export const ICON = {
  folder: svg('<path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.2l1.6 2H16a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z"/>', 17),
  lock: svg('<rect x="4.5" y="8.5" width="11" height="8" rx="1.5"/><path d="M7 8.5V6a3 3 0 0 1 6 0v2.5"/>'),
  file: svg('<path d="M5 2.5h6l4 4v11H5z"/><path d="M11 2.5v4h4"/>'),
  image: svg('<rect x="3" y="4" width="14" height="12" rx="1.5"/><circle cx="7.5" cy="8" r="1.2"/><path d="M3.5 14l4-4 3 3 2.5-2 3.5 3.5"/>'),
  video: svg('<rect x="2.5" y="4.5" width="15" height="11" rx="1.5"/><path d="M8.5 8l4 2-4 2z"/>'),
  audio: svg('<path d="M7.5 13V5l7-1.5V11"/><circle cx="5.8" cy="13.4" r="1.9"/><circle cx="12.8" cy="11.4" r="1.9"/>'),
  pdf: svg('<path d="M5 2.5h6l4 4v11H5z"/><path d="M11 2.5v4h4"/><path d="M7.5 12.5h5"/><path d="M7.5 14.5h3"/>'),
  doc: svg('<path d="M5 2.5h6l4 4v11H5z"/><path d="M11 2.5v4h4"/><path d="M7.5 10h5M7.5 12.5h5M7.5 15h3"/>'),
  sheet: svg('<rect x="3" y="4" width="14" height="12" rx="1.5"/><path d="M3 8h14M3 12h14M8 4v12M13 4v12"/>'),
  zip: svg('<path d="M5 2.5h6l4 4v11H5z"/><path d="M11 2.5v4h4"/><path d="M8.5 4v1.5M9.5 6v1.5M8.5 8v1.5M9.5 10v1.5"/>'),
  code: svg('<path d="M7.5 7.5 5 10l2.5 2.5"/><path d="M12.5 7.5 15 10l-2.5 2.5"/><path d="M11 5.5l-2 9"/>'),
  star: svg('<path d="M10 3l2.1 4.5 4.9.6-3.6 3.4.9 4.9L10 14l-4.3 2.4.9-4.9L3 8.1l4.9-.6z"/>'),
  starFull: '<svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor"><path d="M10 3l2.1 4.5 4.9.6-3.6 3.4.9 4.9L10 14l-4.3 2.4.9-4.9L3 8.1l4.9-.6z"/></svg>',
  trash: svg('<path d="M4.5 6h11"/><path d="M7.5 6V4.5h5V6"/><path d="M6 6l.8 10h6.4L14 6"/>'),
  info: svg('<circle cx="10" cy="10" r="7.2"/><path d="M10 9.2v4.3"/><circle cx="10" cy="6.6" r=".9" fill="currentColor" stroke="none"/>'),
  close: svg('<path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/>'),
  grid: svg('<rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1"/><rect x="11" y="3.5" width="5.5" height="5.5" rx="1"/><rect x="3.5" y="11" width="5.5" height="5.5" rx="1"/><rect x="11" y="11" width="5.5" height="5.5" rx="1"/>'),
  list: svg('<path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h13"/>'),
};

const BY_EXT = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'svg', 'tiff', 'tif'],
  video: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg'],
  audio: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus'],
  pdf: ['pdf'],
  doc: ['doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'epub'],
  sheet: ['xls', 'xlsx', 'ods', 'csv', 'tsv'],
  zip: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso'],
  code: ['js', 'ts', 'py', 'java', 'kt', 'c', 'cpp', 'h', 'go', 'rs', 'rb', 'php', 'html', 'css', 'json', 'xml', 'yml', 'yaml', 'sh'],
};

export function extensionOf(name) {
  const i = String(name || '').lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Categoria do arquivo: image, video, audio, pdf, doc, sheet, zip, code ou file. */
export function kindOf(name) {
  const ext = extensionOf(name);
  for (const [kind, list] of Object.entries(BY_EXT)) {
    if (list.includes(ext)) return kind;
  }
  return 'file';
}

export function iconFor(name) {
  return ICON[kindOf(name)] || ICON.file;
}

/** Abre no visualizador em vez de baixar. */
export function isPreviewable(name) {
  const k = kindOf(name);
  return k === 'image' || k === 'pdf' || k === 'video' || k === 'audio';
}

/** Estes tocam por streaming, buscando só o trecho que o player pede. */
export function isStreamable(name) {
  const k = kindOf(name);
  return k === 'video' || k === 'audio';
}
