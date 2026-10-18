/* ------------------------------------------------------------------ *
 * Histórico de envios.
 *
 * A fila de transferências some quando é fechada, e com ela some a lista
 * do que falhou. Para uma migração longa isso é um problema: um arquivo
 * grande demais que deu erro no meio de centenas de outros fica
 * impossível de reencontrar depois.
 *
 * Então cada desfecho vira uma linha aqui, guardada no navegador.
 * ------------------------------------------------------------------ */

const CHAVE = 'td_history';
const LIMITE = 800;   // o suficiente para uma migração inteira, longe do teto do localStorage

export const ESTADOS = {
  enviado: 'enviado',
  pulado: 'pulado',
  substituido: 'substituído',
  grande: 'grande demais',
  falhou: 'falhou',
};

function ler() {
  try {
    const bruto = localStorage.getItem(CHAVE);
    const lista = bruto ? JSON.parse(bruto) : [];
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
}

function gravar(lista) {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(lista.slice(0, LIMITE)));
  } catch {
    // Cota estourada: descarta a metade mais antiga e tenta de novo, para
    // o histórico nunca impedir um envio.
    try { localStorage.setItem(CHAVE, JSON.stringify(lista.slice(0, Math.floor(LIMITE / 2)))); }
    catch { /* desiste em silêncio */ }
  }
}

/** Registra um desfecho. Os mais recentes ficam no topo. */
export function registrar({ nome, caminho, tamanho, estado, motivo = '' }) {
  const lista = ler();
  lista.unshift({
    t: Date.now(),
    n: nome,
    p: caminho || '/',
    s: Number(tamanho) || 0,
    e: estado,
    m: motivo,
  });
  gravar(lista);
}

export function listar(filtro = 'tudo') {
  const lista = ler();
  if (filtro === 'tudo') return lista;
  if (filtro === 'problemas') {
    return lista.filter((x) => x.e === ESTADOS.grande || x.e === ESTADOS.falhou);
  }
  return lista.filter((x) => x.e === filtro);
}

export function contar(estado) {
  return ler().filter((x) => x.e === estado).length;
}

export function limpar() {
  try { localStorage.removeItem(CHAVE); } catch { /* ignora */ }
}

/** Texto para salvar num arquivo, com o caminho completo de cada item. */
export function exportarTexto() {
  const lista = ler();
  const linhas = [
    'TeleDrive Web — histórico de envios',
    `Gerado em ${new Date().toLocaleString('pt-BR')}`,
    `${lista.length} registro(s)`,
    '',
    'data\testado\ttamanho\tcaminho\tmotivo',
  ];
  for (const x of lista) {
    const caminho = x.p === '/' ? `/${x.n}` : `${x.p}/${x.n}`;
    linhas.push([
      new Date(x.t).toLocaleString('pt-BR'),
      x.e,
      x.s,
      caminho,
      x.m,
    ].join('\t'));
  }
  return linhas.join('\n');
}
