// Biblioteca de interface do painel (contrato em docs/PAINEL.md e docs/ARQUITETURA.md §8).
// As funções de formatação são puras e rodam no Node; as que mexem na página só tocam no
// `document` global quando são chamadas (testes em tests/unit/painel-ui.test.js, com linkedom).

// ---------------------------------------------------------------------------
// Status de pedido

/** Status na ordem do fluxo (mesma lista do banco e de api/admin/pedido-status.js). */
export const STATUS_PEDIDO = Object.freeze([
  'aguardando_pagamento', 'pagamento_em_analise', 'pago', 'em_separacao', 'enviado', 'entregue', 'cancelado', 'reembolsado',
]);

const ROTULOS_STATUS = Object.freeze({
  aguardando_pagamento: 'Aguardando pagamento',
  pagamento_em_analise: 'Pagamento em análise',
  pago: 'Pago',
  em_separacao: 'Em separação',
  enviado: 'Enviado',
  entregue: 'Entregue',
  cancelado: 'Cancelado',
  reembolsado: 'Reembolsado',
});

// Cor do selo (classe .selo--<cor> do admin.css).
const CORES_STATUS = Object.freeze({
  aguardando_pagamento: 'ambar',
  pagamento_em_analise: 'azul',
  pago: 'verde',
  em_separacao: 'ouro',
  enviado: 'roxo',
  entregue: 'floresta',
  cancelado: 'cinza',
  reembolsado: 'vermelho',
});

/** "pago" → "Pago". Status desconhecido volta como veio (ou "Desconhecido" se vazio). */
export function rotuloStatusPedido(status) {
  if (Object.hasOwn(ROTULOS_STATUS, status)) return ROTULOS_STATUS[status];
  return status ? String(status) : 'Desconhecido';
}

/** "pago" → "verde" (use em class="selo selo--verde"). Desconhecido → "cinza". */
export function corStatusPedido(status) {
  return Object.hasOwn(CORES_STATUS, status) ? CORES_STATUS[status] : 'cinza';
}

// ---------------------------------------------------------------------------
// Texto e números (puras)

const ENTIDADES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escapa texto para HTML. null/undefined → "". Prefira el(), que nunca interpreta HTML. */
export function escapar(txt) {
  if (txt === null || txt === undefined) return '';
  return String(txt).replace(/[&<>"']/g, (c) => ENTIDADES[c]);
}

const MILHAR = /\B(?=(\d{3})+(?!\d))/g;

/**
 * Centavos → "R$ 1.234,56" (mesmo formato da loja). Com { simbolo: false } → "1.234,56"
 * (valor para um campo de preço). null, vazio ou inválido → "—" (ou "" sem símbolo).
 */
export function formatarPreco(centavos, { simbolo = true } = {}) {
  const numero = centavos === null || centavos === undefined || centavos === '' ? NaN : Number(centavos);
  if (!Number.isFinite(numero)) return simbolo ? '—' : '';
  const inteiro = Math.round(numero);
  const absoluto = Math.abs(inteiro);
  const reais = String(Math.floor(absoluto / 100)).replace(MILHAR, '.');
  const texto = `${reais},${String(absoluto % 100).padStart(2, '0')}`;
  return `${inteiro < 0 ? '-' : ''}${simbolo ? 'R$ ' : ''}${texto}`;
}

const MAIOR_INT = 2147483647; // colunas int do Postgres

/**
 * Texto digitado → centavos. "12,50" → 1250; "1.234,56" → 123456; "12" → 1200; "R$ 0,99" → 99;
 * "12.5" → 1250 (ponto como decimal só com 1 ou 2 casas); "1.234" → 123400 (milhar).
 * Vazio, negativo, mais de 2 casas ou texto inválido → null.
 * Para diferenciar "vazio" de "inválido": campo.value.trim() !== '' && lerPreco(campo.value) === null.
 */
export function lerPreco(texto) {
  if (typeof texto === 'number') {
    if (!Number.isFinite(texto) || texto < 0) return null;
    const c = Math.round(texto * 100);
    return c <= MAIOR_INT ? c : null;
  }
  if (texto === null || texto === undefined) return null;
  let s = String(texto).replace(/[\s ]+/g, '').replace(/^R\$/i, '');
  if (!s) return null;
  if (!/^(\d[\d.,]*|[.,]\d+)$/.test(s)) return null;
  let inteiro;
  let decimal = '';
  if (s.includes(',')) {
    const partes = s.split(',');
    if (partes.length !== 2) return null;
    [inteiro, decimal] = partes;
    if (inteiro.includes('.')) {
      if (!/^\d{1,3}(\.\d{3})+$/.test(inteiro)) return null;
      inteiro = inteiro.replace(/\./g, '');
    }
  } else if (s.includes('.')) {
    const partes = s.split('.');
    if (partes.length === 2 && partes[1].length <= 2) [inteiro, decimal] = partes;
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) inteiro = s.replace(/\./g, '');
    else return null;
  } else {
    inteiro = s;
  }
  if (inteiro === '') inteiro = '0';
  if (!/^\d+$/.test(inteiro) || !/^\d{0,2}$/.test(decimal)) return null;
  const centavos = Number(inteiro) * 100 + Number(decimal.padEnd(2, '0'));
  return Number.isSafeInteger(centavos) && centavos <= MAIOR_INT ? centavos : null;
}

const FUSO = 'America/Belem';
let formatadorData;
let formatadorDataHora;

function dataValida(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const data = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(data.getTime()) ? null : data;
}

function partesData(data, comHora) {
  if (!formatadorData) {
    const base = { timeZone: FUSO, day: '2-digit', month: '2-digit', year: 'numeric' };
    formatadorData = new Intl.DateTimeFormat('pt-BR', base);
    formatadorDataHora = new Intl.DateTimeFormat('pt-BR', { ...base, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  }
  const partes = {};
  for (const p of (comHora ? formatadorDataHora : formatadorData).formatToParts(data)) partes[p.type] = p.value;
  return partes;
}

/**
 * ISO (ou Date) → "15/10/2026 14:30" no horário de Belém. { hora: false } → "15/10/2026".
 * "2026-10-15" (só a data) não sofre fuso. Vazio ou inválido → "—".
 */
export function formatarData(valor, { hora = true } = {}) {
  if (typeof valor === 'string') {
    const m = valor.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  }
  const data = dataValida(valor);
  if (!data) return '—';
  const p = partesData(data, hora);
  const dia = `${p.day}/${p.month}/${p.year}`;
  return hora ? `${dia} ${p.hour}:${p.minute}` : dia;
}

/** "agora", "há 5 min", "há 3 h", "ontem", "há 4 dias"; mais de 7 dias → data. */
export function tempoRelativo(valor, agora = Date.now()) {
  const data = dataValida(valor);
  if (!data) return '—';
  const segundos = Math.round((Number(agora) - data.getTime()) / 1000);
  if (segundos < 60) return 'agora';
  const minutos = Math.floor(segundos / 60);
  if (minutos < 60) return `há ${minutos} min`;
  const horas = Math.floor(minutos / 60);
  if (horas < 24) return `há ${horas} h`;
  const dias = Math.floor(horas / 24);
  if (dias === 1) return 'ontem';
  if (dias <= 7) return `há ${dias} dias`;
  return formatarData(data, { hora: false });
}

/** 1001 → "#1001". */
export function formatarNumeroPedido(numero) {
  return numero === null || numero === undefined || numero === '' ? '#—' : `#${numero}`;
}

/** 2_400_000 → "2,3 MB". */
export function formatarBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const unidades = ['KB', 'MB', 'GB'];
  let valor = n / 1024;
  let i = 0;
  while (valor >= 1024 && i < unidades.length - 1) {
    valor /= 1024;
    i += 1;
  }
  const casas = valor < 10 ? 1 : 0;
  return `${valor.toFixed(casas).replace('.', ',')} ${unidades[i]}`;
}

/**
 * "Creme de Cupuaçu & Cia!" → "creme-de-cupuacu-e-cia". Só a-z, 0-9 e hífen simples
 * (casa com o check de slug do banco). Sem nada aproveitável → "".
 */
export function slugify(txt, { max = 80 } = {}) {
  return String(txt ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' e ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '');
}

/** Cópia da lista com o item de `de` movido para `para` (índices limitados à lista). */
export function moverItem(lista, de, para) {
  const copia = Array.from(lista || []);
  if (!copia.length) return copia;
  const origem = Math.min(Math.max(Number(de) || 0, 0), copia.length - 1);
  const destino = Math.min(Math.max(Number(para) || 0, 0), copia.length - 1);
  const [item] = copia.splice(origem, 1);
  copia.splice(destino, 0, item);
  return copia;
}

/** Atrasa fn até `ms` sem novas chamadas (busca enquanto digita). .cancelar() descarta. */
export function debounce(fn, ms = 250) {
  let timer = null;
  const envolvida = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  envolvida.cancelar = () => clearTimeout(timer);
  return envolvida;
}

// ---------------------------------------------------------------------------
// URLs em atributos

const ATRIBUTOS_URL = new Set(['href', 'src', 'action', 'formaction', 'poster', 'cite', 'data', 'background', 'xlink:href']);
const ATRIBUTOS_MIDIA = new Set(['src', 'poster']);
const ATRIBUTOS_PROIBIDOS = new Set(['srcdoc', 'innerhtml', 'outerhtml']);

/**
 * URL segura para um atributo: relativa, http(s), mailto ou tel. Com { midia: true } (src/poster)
 * também blob: e data:image/(png|jpeg|gif|webp|avif). Qualquer outro esquema → null.
 */
export function urlPermitida(valor, { midia = false } = {}) {
  const texto = String(valor ?? '').trim();
  const semControles = texto.replace(/[\u0000- \u007f-\u009f]+/g, '');
  const esquema = semControles.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!esquema) return texto;
  const nome = esquema[1].toLowerCase();
  if (['http', 'https', 'mailto', 'tel'].includes(nome)) return texto;
  if (midia && nome === 'blob') return texto;
  if (midia && nome === 'data' && /^data:image\/(png|jpe?g|gif|webp|avif)[;,]/i.test(semControles)) return texto;
  return null;
}

// ---------------------------------------------------------------------------
// Construção de elementos

const NOME_ATRIBUTO = /^[a-zA-Z_:][-a-zA-Z0-9_:.]*$/;
const PROPRIEDADES = new Set(['value', 'checked', 'selected', 'indeterminate']);

function documento() {
  const d = globalThis.document;
  if (!d) throw new Error('ui.js: não há document (rode no navegador ou defina globalThis.document).');
  return d;
}

function adicionarFilhos(alvo, filhos) {
  for (const filho of filhos) {
    if (filho === null || filho === undefined || filho === false || filho === true) continue;
    if (Array.isArray(filho)) adicionarFilhos(alvo, filho);
    else if (typeof filho === 'object' && typeof filho.nodeType === 'number') alvo.append(filho);
    else alvo.append(documento().createTextNode(String(filho)));
  }
}

/**
 * Cria um elemento sem nunca interpretar HTML.
 * - filhos: texto/números viram nós de texto; elementos são anexados; arrays são achatados;
 *   null/undefined/false/true são ignorados (para `cond && el(...)`).
 * - attrs: class (texto ou lista), dataset {chave: valor}, style (texto ou objeto),
 *   eventos { click: fn, input: fn }, value/checked/selected (propriedades), booleanos
 *   (true → atributo vazio; false/null/undefined → omitido; em aria-* viram "true"/"false"),
 *   demais → setAttribute.
 * - Atributos on* (onclick…), srcdoc e innerHTML lançam TypeError. URLs perigosas em
 *   href/src/action/poster… (javascript:, data: …) são descartadas com aviso no console.
 */
export function el(tag, attrs, ...filhos) {
  if (typeof tag !== 'string' || !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(tag)) throw new TypeError(`el(): tag inválida "${tag}"`);
  const d = documento();
  const elemento = d.createElement(tag);
  const props = [];
  // el('p', 'texto') ou el('div', [filhos]) também funcionam.
  if (attrs !== null && attrs !== undefined && (typeof attrs !== 'object' || Array.isArray(attrs) || typeof attrs.nodeType === 'number')) {
    filhos.unshift(attrs);
    attrs = null;
  }
  for (const [nome, valor] of Object.entries(attrs || {})) {
    if (/^on/i.test(nome)) throw new TypeError(`el(): atributo "${nome}" proibido; use eventos: { ${nome.slice(2).toLowerCase() || 'click'}: fn }`);
    if (ATRIBUTOS_PROIBIDOS.has(nome.toLowerCase())) throw new TypeError(`el(): atributo "${nome}" proibido`);
    if (valor === null || valor === undefined) continue;
    // ARIA não tem atributo booleano: omitir não é "false" e vazio não é "true".
    if (typeof valor === 'boolean' && /^aria-[a-z]+$/i.test(nome)) {
      elemento.setAttribute(nome, String(valor));
      continue;
    }
    if (valor === false) continue;
    if (nome === 'class' || nome === 'className') {
      const classes = Array.isArray(valor) ? valor.filter(Boolean).join(' ') : String(valor);
      if (classes.trim()) elemento.setAttribute('class', classes.trim());
    } else if (nome === 'dataset') {
      for (const [chave, v] of Object.entries(valor)) if (v !== null && v !== undefined) elemento.dataset[chave] = String(v);
    } else if (nome === 'style' && typeof valor === 'object') {
      for (const [prop, v] of Object.entries(valor)) {
        if (v === null || v === undefined) continue;
        const css = prop.startsWith('--') ? prop : prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
        elemento.style.setProperty(css, String(v));
      }
    } else if (nome === 'eventos') {
      for (const [evento, fn] of Object.entries(valor)) if (typeof fn === 'function') elemento.addEventListener(evento, fn);
    } else if (PROPRIEDADES.has(nome)) {
      props.push([nome, valor]);
    } else {
      if (!NOME_ATRIBUTO.test(nome)) throw new TypeError(`el(): nome de atributo inválido "${nome}"`);
      let texto = valor === true ? '' : String(valor);
      const minusculo = nome.toLowerCase();
      if (ATRIBUTOS_URL.has(minusculo)) {
        const segura = urlPermitida(texto, { midia: ATRIBUTOS_MIDIA.has(minusculo) });
        if (segura === null) {
          console.warn(`el(): URL recusada em ${nome}:`, texto.slice(0, 80));
          continue;
        }
        texto = segura;
      } else if (minusculo === 'srcset') {
        const partes = texto.split(',').map((p) => p.trim()).filter(Boolean);
        if (partes.some((p) => urlPermitida(p.split(/\s+/)[0], { midia: true }) === null)) {
          console.warn('el(): srcset recusado');
          continue;
        }
      }
      elemento.setAttribute(nome, texto);
    }
  }
  if (tag.toLowerCase() === 'textarea') {
    const valor = props.find(([n]) => n === 'value');
    if (valor) elemento.textContent = String(valor[1]);
  }
  adicionarFilhos(elemento, filhos);
  for (const [nome, valor] of props) {
    if (nome === 'value') {
      const texto = String(valor);
      if (tag.toLowerCase() !== 'textarea' && tag.toLowerCase() !== 'select') elemento.setAttribute('value', texto);
      try { elemento.value = texto; } catch { /* DOM sem a propriedade */ }
    } else {
      if (valor && nome !== 'indeterminate') elemento.setAttribute(nome, '');
      try { elemento[nome] = Boolean(valor); } catch { /* idem */ }
    }
  }
  return elemento;
}

// ---------------------------------------------------------------------------
// Ícones (SVG 24×24 de traço, desenhados para o painel)
// Notação: "M…" = path; "c:cx,cy,r" = círculo; "f:cx,cy,r" = círculo cheio;
// "r:x,y,l,a,rx" = retângulo; "e:cx,cy,rx,ry" = elipse.

const DESENHOS = {
  inicio: ['r:3,3,7,9,1.5', 'r:14,3,7,5,1.5', 'r:14,12,7,9,1.5', 'r:3,16,7,5,1.5'],
  conteudo: ['M14 3H6.5A2.5 2.5 0 0 0 4 5.5v13A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V9z', 'M14 3v6h6', 'M8 13h8', 'M8 17h5'],
  midia: ['r:3,4,18,16,2.5', 'c:8.5,9.5,1.75', 'M20.5 15.5 16 11 6 20'],
  produtos: ['M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z', 'f:7.5,7.5,1.6'],
  categorias: ['M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z'],
  pedidos: ['M5.5 7.5h13l1 13h-15z', 'M9 10V6.5a3 3 0 0 1 6 0V10'],
  cupons: ['M3 7.5A1.5 1.5 0 0 1 4.5 6h15A1.5 1.5 0 0 1 21 7.5V10a2 2 0 0 0 0 4v2.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16.5V14a2 2 0 0 0 0-4z', 'M14.5 6v2.5', 'M14.5 10.75v2.5', 'M14.5 15.5V18'],
  configuracoes: ['M4 6h9', 'M17 6h3', 'M4 12h3', 'M11 12h9', 'M4 18h11', 'M19 18h1', 'c:15,6,2', 'c:9,12,2', 'c:17,18,2'],
  sair: ['M9.5 20.5h-4a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h4', 'M16 16.5 20.5 12 16 7.5', 'M20.5 12H9.5'],
  externo: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10'],
  menu: ['M4 6.5h16', 'M4 12h16', 'M4 17.5h16'],
  fechar: ['M6 6l12 12', 'M18 6 6 18'],
  olho: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'c:12,12,3'],
  'olho-fechado': ['M3 3l18 18', 'M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.1 4.1', 'M6.6 6.6C3.9 8.4 2 12 2 12s3.6 7 10 7a10.4 10.4 0 0 0 5.3-1.5', 'M9.9 9.9a3 3 0 0 0 4.2 4.2'],
  mais: ['M12 5v14', 'M5 12h14'],
  lixeira: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  editar: ['M4 20h4L19 9l-4-4L4 16z', 'M13.5 6.5l4 4'],
  subir: ['M6 15l6-6 6 6'],
  descer: ['M6 9l6 6 6-6'],
  copiar: ['r:9,9,11,11,2', 'M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5'],
  duplicar: ['r:9,9,11,11,2', 'M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5', 'M14.5 12v5', 'M12 14.5h5'],
  arrastar: ['f:9,6,1.5', 'f:15,6,1.5', 'f:9,12,1.5', 'f:15,12,1.5', 'f:9,18,1.5', 'f:15,18,1.5'],
  upload: ['M12 15V4', 'M7.5 8.5 12 4l4.5 4.5', 'M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15'],
  busca: ['c:11,11,7', 'M20.5 20.5l-4.5-4.5'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  alerta: ['M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z', 'M12 9.5v4', 'M12 17h.01'],
  info: ['c:12,12,9', 'M12 11v5.5', 'M12 7.5h.01'],
  sucesso: ['c:12,12,9', 'M8 12.5l2.8 2.8L16.5 9.5'],
  erro: ['c:12,12,9', 'M9 9l6 6', 'M15 9l-6 6'],
  voltar: ['M19 12H5', 'M11 18l-6-6 6-6'],
  avancar: ['M5 12h14', 'M13 6l6 6-6 6'],
  video: ['r:3,5.5,13,13,2', 'M16 10.5l5-3.5v10l-5-3.5z'],
  loja: ['M3.5 9 5 4h14l1.5 5', 'M3.5 9a2.8 2.8 0 0 0 5.6 0 2.8 2.8 0 0 0 5.8 0 2.8 2.8 0 0 0 5.6 0', 'M5 12v8h14v-8', 'M10 20v-4.5h4V20'],
  caminhao: ['M2.5 6.5h11v10h-11z', 'M13.5 10h4l3.5 3.5v3h-7.5', 'c:7,18,2', 'c:17,18,2'],
  relogio: ['c:12,12,9', 'M12 7v5l3.5 2'],
  dinheiro: ['r:2.5,6,19,12,2', 'c:12,12,2.75', 'M6 12h.01', 'M18 12h.01'],
  atualizar: ['M20 11a8 8 0 0 0-14.6-4.5L4 8', 'M4 3.5V8h4.5', 'M4 13a8 8 0 0 0 14.6 4.5L20 16', 'M20 20.5V16h-4.5'],
  link: ['M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1 1', 'M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1'],
  caixa: ['M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z', 'M3 7.5 12 12l9-4.5', 'M12 12v9'],
  usuario: ['c:12,8,4', 'M4 21a8 8 0 0 1 16 0'],
  cadeado: ['r:5,11,14,10,2', 'M8 11V7.5a4 4 0 0 1 8 0V11'],
  email: ['r:3,5,18,14,2', 'M3.5 7l8.5 6 8.5-6'],
  cartao: ['r:2.5,5,19,14,2', 'M2.5 10h19', 'M6 15h4'],
  banco: ['e:12,5.5,8,3', 'M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13', 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
  escudo: ['M12 3l8 3v6c0 5-3.5 8.2-8 9-4.5-.8-8-4-8-9V6z', 'M9 12l2 2 4-4.5'],
  imagem: ['r:3,4,18,16,2.5', 'c:8.5,9.5,1.75', 'M20.5 15.5 16 11 6 20'],
  grafico: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M21 20H3'],
  estrela: ['M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z'],
};

/** Nomes aceitos por icone(). */
export const ICONES = Object.freeze(Object.keys(DESENHOS));

const SVG = 'http://www.w3.org/2000/svg';

/**
 * Ícone SVG inline. Decorativo (aria-hidden) por padrão; com { rotulo } vira role="img" com título.
 * Nome desconhecido → ícone "info".
 */
export function icone(nome, { rotulo = '', classe = '', tamanho } = {}) {
  const d = documento();
  const svg = d.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', `icone${classe ? ` ${classe}` : ''}`);
  svg.setAttribute('focusable', 'false');
  if (tamanho) {
    svg.setAttribute('width', String(tamanho));
    svg.setAttribute('height', String(tamanho));
  }
  if (rotulo) {
    svg.setAttribute('role', 'img');
    const titulo = d.createElementNS(SVG, 'title');
    titulo.textContent = rotulo;
    svg.append(titulo);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  for (const parte of DESENHOS[nome] || DESENHOS.info) {
    let forma;
    const [tipo, numeros] = parte.includes(':') ? parte.split(':') : ['p', parte];
    const n = tipo === 'p' ? [] : numeros.split(',');
    if (tipo === 'p') {
      forma = d.createElementNS(SVG, 'path');
      forma.setAttribute('d', parte);
    } else if (tipo === 'c' || tipo === 'f') {
      forma = d.createElementNS(SVG, 'circle');
      forma.setAttribute('cx', n[0]);
      forma.setAttribute('cy', n[1]);
      forma.setAttribute('r', n[2]);
      if (tipo === 'f') {
        forma.setAttribute('fill', 'currentColor');
        forma.setAttribute('stroke', 'none');
      }
    } else if (tipo === 'r') {
      forma = d.createElementNS(SVG, 'rect');
      forma.setAttribute('x', n[0]);
      forma.setAttribute('y', n[1]);
      forma.setAttribute('width', n[2]);
      forma.setAttribute('height', n[3]);
      if (n[4]) forma.setAttribute('rx', n[4]);
    } else {
      forma = d.createElementNS(SVG, 'ellipse');
      forma.setAttribute('cx', n[0]);
      forma.setAttribute('cy', n[1]);
      forma.setAttribute('rx', n[2]);
      forma.setAttribute('ry', n[3]);
    }
    svg.append(forma);
  }
  return svg;
}

// ---------------------------------------------------------------------------
// Componentes

let contadorIds = 0;
/** Id único para ligar rótulos, ajudas e regiões (prefixo-1, prefixo-2…). */
export function novoId(prefixo = 'ui') {
  contadorIds += 1;
  return `${prefixo}-${contadorIds}`;
}

/**
 * Botão padrão. tipo: primario | secundario | perigo | fantasma | ouro; tamanho: pequeno | grande.
 * Sem texto (só ícone) exige `rotulo` (aria-label). Com href vira <a>.
 */
export function botao({
  texto = '', tipo = 'secundario', tamanho, icone: nomeIcone, iconeDireita, aoClicar, href, rotulo,
  tipoHtml = 'button', bloco = false, classe, attrs = {},
} = {}) {
  const classes = ['botao', `botao--${tipo}`, tamanho && `botao--${tamanho}`, !texto && 'botao--icone', bloco && 'botao--bloco', classe];
  const conteudo = [
    nomeIcone ? icone(nomeIcone) : null,
    texto ? el('span', { class: 'botao__texto' }, texto) : null,
    iconeDireita ? icone(iconeDireita) : null,
  ];
  const base = { class: classes, 'aria-label': rotulo || null, title: !texto && rotulo ? rotulo : null, ...attrs };
  const elemento = href
    ? el('a', { ...base, href }, conteudo)
    : el('button', { ...base, type: tipoHtml }, conteudo);
  if (aoClicar) elemento.addEventListener('click', aoClicar);
  return elemento;
}

/**
 * Executa `tarefa` com o botão em estado "ocupado" (spinner, desativado). Ignora cliques repetidos.
 * Devolve o resultado da tarefa (ou undefined se o botão já estava ocupado).
 */
export async function ocupado(alvo, tarefa) {
  if (!alvo) return tarefa();
  if (alvo.getAttribute('aria-busy') === 'true') return undefined;
  const tinhaFoco = globalThis.document && globalThis.document.activeElement === alvo;
  alvo.setAttribute('aria-busy', 'true');
  alvo.disabled = true;
  try {
    return await tarefa();
  } finally {
    alvo.removeAttribute('aria-busy');
    alvo.disabled = false;
    if (tinhaFoco && globalThis.document.activeElement === globalThis.document.body) alvo.focus();
  }
}

function normalizarOpcoes(opcoes) {
  return (opcoes || []).map((o) => (typeof o === 'object' && o !== null
    ? { valor: String(o.valor ?? ''), rotulo: String(o.rotulo ?? o.valor ?? ''), desativado: Boolean(o.desativado) }
    : { valor: String(o), rotulo: String(o), desativado: false }));
}

/**
 * Campo de formulário completo (rótulo, entrada, ajuda e erro ligados por aria).
 * tipo: text | email | url | number | password | search | tel | date | textarea | select | preco | checkbox | interruptor
 * | senha (password com botão mostrar/ocultar).
 * Outras opções: valor, ajuda, obrigatorio, placeholder, opcoes (select: textos ou { valor, rotulo, desativado }),
 * linhas (textarea), prefixo/sufixo (texto ao lado da entrada), id, classe, attrs (atributos extras da entrada).
 * Devolve { elemento, entrada, ler(), definirErro(msg|null) }.
 * ler(): checkbox/interruptor → boolean; preco → centavos|null; number → número|null; demais → texto.
 */
export function campo({
  rotulo, nome, tipo = 'text', valor, ajuda, obrigatorio = false, placeholder, opcoes, linhas = 4,
  id, classe, prefixo, sufixo, attrs = {},
} = {}) {
  const idEntrada = id || novoId(`campo-${nome || tipo}`);
  const idAjuda = `${idEntrada}-ajuda`;
  const idErro = `${idEntrada}-erro`;
  const ajudaEl = ajuda ? el('p', { class: 'campo__ajuda', id: idAjuda }, ajuda) : null;
  const erroEl = el('p', { class: 'campo__erro', id: idErro, hidden: true });
  const descricao = () => [ajudaEl && idAjuda, !erroEl.hidden && idErro].filter(Boolean).join(' ') || null;
  let entrada;
  let elemento;

  if (tipo === 'checkbox' || tipo === 'interruptor') {
    const interruptor = tipo === 'interruptor';
    entrada = el('input', {
      type: 'checkbox', id: idEntrada, name: nome, role: interruptor ? 'switch' : null,
      class: interruptor ? 'interruptor__entrada' : 'caixa__entrada', checked: Boolean(valor), ...attrs,
    });
    const rotuloEl = interruptor
      ? el('label', { class: 'interruptor', for: idEntrada }, entrada, el('span', { class: 'interruptor__trilho', 'aria-hidden': 'true' }), el('span', { class: 'interruptor__texto' }, rotulo))
      : el('label', { class: 'caixa', for: idEntrada }, entrada, el('span', { class: 'caixa__texto' }, rotulo));
    elemento = el('div', { class: ['campo', 'campo--marcar', classe] }, rotuloEl, ajudaEl, erroEl);
  } else {
    const comum = {
      id: idEntrada, name: nome, class: 'entrada', required: obrigatorio, placeholder,
      'aria-required': obrigatorio ? 'true' : null,
    };
    if (tipo === 'textarea') {
      entrada = el('textarea', { ...comum, rows: linhas, value: valor ?? '', ...attrs });
    } else if (tipo === 'select') {
      entrada = el('select', { ...comum, placeholder: null, value: valor === null || valor === undefined ? null : String(valor), ...attrs },
        normalizarOpcoes(opcoes).map((o) => el('option', { value: o.valor, disabled: o.desativado }, o.rotulo)));
    } else if (tipo === 'preco') {
      entrada = el('input', {
        ...comum, type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: placeholder ?? '0,00',
        value: formatarPreco(valor, { simbolo: false }), ...attrs,
      });
      prefixo = prefixo ?? 'R$';
    } else if (tipo === 'senha') {
      entrada = el('input', { ...comum, type: 'password', value: valor ?? '', autocomplete: 'current-password', spellcheck: 'false', ...attrs });
    } else {
      entrada = el('input', { ...comum, type: tipo, value: valor ?? '', ...attrs });
    }
    const rotuloEl = el('label', { class: 'campo__rotulo', for: idEntrada }, rotulo,
      obrigatorio ? el('span', { class: 'campo__obrigatorio', 'aria-hidden': 'true' }, ' *') : null);
    let alternarSenha = null;
    if (tipo === 'senha') {
      alternarSenha = el('button', {
        type: 'button', class: 'entrada-grupo__botao', 'aria-pressed': 'false', 'aria-controls': idEntrada, 'aria-label': 'Mostrar senha', title: 'Mostrar senha',
      }, icone('olho'));
      alternarSenha.addEventListener('click', () => {
        const mostrar = entrada.type === 'password';
        entrada.type = mostrar ? 'text' : 'password';
        alternarSenha.setAttribute('aria-pressed', String(mostrar));
        const texto = mostrar ? 'Ocultar senha' : 'Mostrar senha';
        alternarSenha.setAttribute('aria-label', texto);
        alternarSenha.title = texto;
        alternarSenha.replaceChildren(icone(mostrar ? 'olho-fechado' : 'olho'));
      });
    }
    const controle = alternarSenha
      ? el('div', { class: 'entrada-grupo' }, entrada, alternarSenha)
      : prefixo || sufixo
      ? el('div', { class: 'entrada-grupo' },
        prefixo ? el('span', { class: 'entrada-grupo__extra', 'aria-hidden': 'true' }, prefixo) : null,
        entrada,
        sufixo ? el('span', { class: 'entrada-grupo__extra', 'aria-hidden': 'true' }, sufixo) : null)
      : entrada;
    elemento = el('div', { class: ['campo', classe] }, rotuloEl, controle, ajudaEl, erroEl);
  }
  const desc = descricao();
  if (desc) entrada.setAttribute('aria-describedby', desc);

  function definirErro(mensagem) {
    if (mensagem) {
      erroEl.textContent = mensagem;
      erroEl.hidden = false;
      entrada.setAttribute('aria-invalid', 'true');
      elemento.classList.add('campo--erro');
    } else {
      erroEl.textContent = '';
      erroEl.hidden = true;
      entrada.removeAttribute('aria-invalid');
      elemento.classList.remove('campo--erro');
    }
    const atual = descricao();
    if (atual) entrada.setAttribute('aria-describedby', atual);
    else entrada.removeAttribute('aria-describedby');
  }

  function ler() {
    if (tipo === 'checkbox' || tipo === 'interruptor') return Boolean(entrada.checked);
    if (tipo === 'preco') return lerPreco(entrada.value);
    if (tipo === 'number') {
      const texto = String(entrada.value).trim().replace(',', '.');
      if (!texto) return null;
      const n = Number(texto);
      return Number.isFinite(n) ? n : null;
    }
    return entrada.value;
  }

  // Corrigir o campo apaga o erro.
  entrada.addEventListener(tipo === 'select' || tipo === 'checkbox' || tipo === 'interruptor' ? 'change' : 'input', () => {
    if (elemento.classList.contains('campo--erro')) definirErro(null);
  });

  return { elemento, entrada, ler, definirErro };
}

/**
 * Cabeçalho padrão de página: { titulo, descricao, voltar: { href, texto }, acoes: [elementos] }.
 * O h1 recebe tabindex="-1": o app põe o foco nele ao trocar de rota.
 */
export function cabecalhoPagina({ titulo, descricao, voltar, acoes = [] } = {}) {
  return el('header', { class: 'pagina-cabecalho' },
    voltar ? el('a', { class: 'pagina-cabecalho__voltar', href: voltar.href }, icone('voltar'), voltar.texto || 'Voltar') : null,
    el('div', { class: 'pagina-cabecalho__linha' },
      el('div', { class: 'pagina-cabecalho__textos' },
        el('h1', { class: 'pagina-cabecalho__titulo', tabindex: '-1' }, titulo),
        descricao ? el('p', { class: 'pagina-cabecalho__descricao' }, descricao) : null),
      acoes && acoes.length ? el('div', { class: 'pagina-cabecalho__acoes' }, acoes) : null));
}

/** <span class="selo selo--verde">Pago</span> */
export function seloStatusPedido(status) {
  return el('span', { class: ['selo', `selo--${corStatusPedido(status)}`] }, rotuloStatusPedido(status));
}

// Elementos que precisam ficar por cima da camada do link da linha (tabela com `link`).
const INTERATIVOS = 'a[href], button, input, select, textarea, label, summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * Tabela que vira lista de cartões no celular.
 * colunas: [{ titulo, chave?, celula?(linha, i) → Node|texto, alinhar?: 'direita'|'centro', principal?, classe?, ocultarNoCelular? }]
 * linhas: array de objetos; link?(linha) → hash da linha (a coluna principal vira link que cobre a linha;
 * botões, links e entradas das outras células continuam clicáveis por cima dele).
 * Célula vazia → "—"; booleano → "Sim"/"Não". vazio: texto quando não há linhas. legenda: para leitores de tela.
 */
export function tabela({ colunas = [], linhas = [], link, vazio = 'Nada por aqui ainda.', legenda, classe } = {}) {
  if (!linhas.length) return estadoVazio(null, vazio);
  const principal = colunas.findIndex((c) => c.principal);
  const colunaLink = principal >= 0 ? principal : 0;
  const cabecalho = el('thead', {}, el('tr', {}, colunas.map((c) => el('th', {
    scope: 'col', class: [c.alinhar && `alinhar-${c.alinhar}`, c.ocultarNoCelular && 'oculto-celular', c.classe],
  }, c.titulo))));
  const corpo = el('tbody', {}, linhas.map((linha, i) => {
    const destino = link ? link(linha) : null;
    return el('tr', { class: destino ? 'tabela__linha--link' : null }, colunas.map((c, j) => {
      let conteudo = c.celula ? c.celula(linha, i) : linha[c.chave];
      if (conteudo === null || conteudo === undefined || conteudo === '') conteudo = '—';
      else if (typeof conteudo === 'boolean') conteudo = conteudo ? 'Sim' : 'Não';
      const ehLink = destino && j === colunaLink;
      if (ehLink) conteudo = el('a', { class: 'tabela__link', href: destino }, conteudo);
      const celula = el('td', {
        'data-rotulo': c.titulo,
        class: [c.alinhar && `alinhar-${c.alinhar}`, j === principal && 'tabela__principal', c.ocultarNoCelular && 'oculto-celular', c.classe],
      }, conteudo);
      if (destino && !ehLink && celula.querySelector(INTERATIVOS)) celula.classList.add('tabela__celula--interativa');
      return celula;
    }));
  }));
  return el('div', { class: ['tabela-container', classe] },
    el('table', { class: 'tabela tabela--responsiva' }, legenda ? el('caption', { class: 'sr-only' }, legenda) : null, cabecalho, corpo));
}

/**
 * Abas acessíveis (setas, Home/End). abas: [{ id, rotulo, conteudo: Node | () => Node }].
 * O conteúdo em função é criado só na primeira vez que a aba abre. Devolve { elemento, ativar(id), ativa() }.
 */
export function abas({ abas: lista = [], ativa, aoTrocar, rotulo = 'Seções' } = {}) {
  const base = novoId('abas');
  const botoes = [];
  const paineis = [];
  const criados = new Set();
  let atual = null;
  const listaEl = el('div', { class: 'abas', role: 'tablist', 'aria-label': rotulo });
  const conteudoEl = el('div', { class: 'abas__paineis' });

  function ativar(id, { focar = false } = {}) {
    const indice = lista.findIndex((a) => a.id === id);
    if (indice < 0) return;
    lista.forEach((aba, i) => {
      const sel = i === indice;
      botoes[i].setAttribute('aria-selected', String(sel));
      botoes[i].tabIndex = sel ? 0 : -1;
      paineis[i].hidden = !sel;
      if (sel && !criados.has(aba.id)) {
        criados.add(aba.id);
        const conteudo = typeof aba.conteudo === 'function' ? aba.conteudo() : aba.conteudo;
        adicionarFilhos(paineis[i], [conteudo]);
      }
    });
    if (focar) botoes[indice].focus();
    const anterior = atual;
    atual = id;
    if (anterior !== null && anterior !== id && aoTrocar) aoTrocar(id);
  }

  lista.forEach((aba, i) => {
    const idBotao = `${base}-aba-${i}`;
    const idPainel = `${base}-painel-${i}`;
    const b = el('button', {
      type: 'button', class: 'aba', role: 'tab', id: idBotao, 'aria-controls': idPainel, 'aria-selected': 'false', tabindex: '-1',
    }, aba.icone ? icone(aba.icone) : null, aba.rotulo);
    b.addEventListener('click', () => ativar(aba.id));
    b.addEventListener('keydown', (evento) => {
      const teclas = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: lista.length - 1 };
      if (!(evento.key in teclas)) return;
      evento.preventDefault();
      const destino = (teclas[evento.key] + lista.length) % lista.length;
      ativar(lista[destino].id, { focar: true });
    });
    const painel = el('div', { class: 'aba-painel', role: 'tabpanel', id: idPainel, 'aria-labelledby': idBotao, tabindex: '0', hidden: true });
    botoes.push(b);
    paineis.push(painel);
    listaEl.append(b);
    conteudoEl.append(painel);
  });
  if (lista.length) ativar(lista.some((a) => a.id === ativa) ? ativa : lista[0].id);
  return { elemento: el('div', { class: 'abas-container' }, listaEl, conteudoEl), ativar, ativa: () => atual };
}

function preencher(container, conteudo) {
  if (container) container.replaceChildren(conteudo);
  return conteudo;
}

/**
 * Esqueleto de carregamento (substitui o conteúdo do container). { linhas, tipo: 'lista'|'cartoes'|'tabela', mensagem }.
 * Devolve o elemento (container pode ser null para só criar).
 */
export function estadoCarregando(container, { linhas = 3, tipo = 'lista', mensagem = 'Carregando…' } = {}) {
  const itens = [];
  for (let i = 0; i < linhas; i += 1) {
    if (tipo === 'cartoes') itens.push(el('div', { class: 'esqueleto esqueleto--bloco' }));
    else if (tipo === 'tabela') itens.push(el('div', { class: 'esqueleto esqueleto--linha esqueleto--alta' }));
    else itens.push(el('div', { class: 'esqueleto esqueleto--linha', style: { width: `${92 - ((i * 17) % 40)}%` } }));
  }
  return preencher(container, el('div', {
    class: ['carregando', `carregando--${tipo}`], role: 'status', 'aria-live': 'polite', 'aria-busy': 'true',
  }, el('span', { class: 'sr-only' }, mensagem), itens));
}

/**
 * Estado vazio (substitui o conteúdo do container).
 * opções: { titulo, icone: nome, acao: { texto, href?, aoClicar?, icone?, tipo? } }.
 */
export function estadoVazio(container, msg, { titulo, icone: nomeIcone = 'caixa', acao } = {}) {
  return preencher(container, el('div', { class: 'estado-vazio' },
    el('div', { class: 'estado-vazio__icone' }, icone(nomeIcone)),
    titulo ? el('p', { class: 'estado-vazio__titulo' }, titulo) : null,
    el('p', { class: 'estado-vazio__texto' }, msg || 'Nada por aqui ainda.'),
    acao ? botao({ tipo: acao.tipo || 'primario', texto: acao.texto, href: acao.href, aoClicar: acao.aoClicar, icone: acao.icone }) : null));
}

/** Estado de erro com "Tentar novamente" opcional: { titulo, aoTentarNovamente }. */
export function estadoErro(container, msg, { titulo = 'Algo deu errado', aoTentarNovamente } = {}) {
  return preencher(container, el('div', { class: 'estado-vazio estado-vazio--erro', role: 'alert' },
    el('div', { class: 'estado-vazio__icone' }, icone('alerta')),
    el('p', { class: 'estado-vazio__titulo' }, titulo),
    el('p', { class: 'estado-vazio__texto' }, msg || 'Não foi possível carregar. Tente novamente.'),
    aoTentarNovamente ? botao({ texto: 'Tentar novamente', icone: 'atualizar', aoClicar: aoTentarNovamente }) : null));
}

// Tipos de aviso e toast. 'alerta' e 'aviso' são a mesma cor âmbar (os dois nomes valem nas duas funções).
const TIPOS_AVISO = Object.freeze({ info: 'info', sucesso: 'sucesso', erro: 'erro', alerta: 'alerta', aviso: 'alerta' });
const ICONES_AVISO = Object.freeze({ info: 'info', sucesso: 'sucesso', erro: 'erro', alerta: 'alerta' });

/** Caixa de aviso: tipo info | sucesso | alerta (ou 'aviso') | erro; desconhecido → info. */
export function aviso(mensagem, tipo = 'info', { titulo } = {}) {
  const tipoValido = TIPOS_AVISO[tipo] || 'info';
  return el('div', { class: ['aviso', `aviso--${tipoValido}`], role: tipoValido === 'erro' ? 'alert' : null },
    icone(ICONES_AVISO[tipoValido]),
    el('div', { class: 'aviso__texto' }, titulo ? el('strong', { class: 'aviso__titulo' }, titulo) : null, el('div', {}, mensagem)));
}

// ---------------------------------------------------------------------------
// Toasts

let regiaoToasts = null;

function elevarToasts() {
  if (!regiaoToasts || typeof regiaoToasts.showPopover !== 'function') return;
  try {
    if (regiaoToasts.matches(':popover-open')) regiaoToasts.hidePopover();
    regiaoToasts.showPopover();
  } catch { /* popover indisponível: fica como camada fixa comum */ }
}

function obterRegiaoToasts() {
  if (regiaoToasts && regiaoToasts.isConnected) return regiaoToasts;
  regiaoToasts = el('div', { class: 'toasts', 'aria-live': 'polite', 'aria-relevant': 'additions', popover: 'manual' });
  documento().body.append(regiaoToasts);
  return regiaoToasts;
}

/**
 * Mensagem passageira. tipo: info | sucesso | erro | aviso (ou 'alerta'); desconhecido → info.
 * Erros ficam 8 s; os demais 4,5 s. opções: { duracao (ms, 0 = só fecha no X) }. Devolve fechar().
 */
export function toast(msg, tipo = 'info', { duracao } = {}) {
  const regiao = obterRegiaoToasts();
  const tipoAviso = TIPOS_AVISO[tipo] || 'info';
  const tipoValido = tipoAviso === 'alerta' ? 'aviso' : tipoAviso; // classe toast--aviso
  const fecharBotao = el('button', { type: 'button', class: 'toast__fechar', 'aria-label': 'Fechar aviso' }, icone('fechar'));
  const item = el('div', { class: ['toast', `toast--${tipoValido}`], role: tipoValido === 'erro' ? 'alert' : 'status' },
    icone(ICONES_AVISO[tipoAviso]), el('p', { class: 'toast__texto' }, String(msg ?? '')), fecharBotao);
  let timer = null;
  const fechar = () => {
    clearTimeout(timer);
    if (!item.isConnected) return;
    item.classList.add('toast--saindo');
    setTimeout(() => item.remove(), 200);
  };
  fecharBotao.addEventListener('click', fechar);
  regiao.append(item);
  while (regiao.children.length > 4) regiao.firstElementChild.remove();
  elevarToasts();
  const tempo = duracao ?? (tipoValido === 'erro' ? 8000 : 4500);
  if (tempo > 0) {
    const iniciar = () => { timer = setTimeout(fechar, tempo); };
    item.addEventListener('mouseenter', () => clearTimeout(timer));
    item.addEventListener('mouseleave', iniciar);
    iniciar();
  }
  return fechar;
}

// ---------------------------------------------------------------------------
// Modal (<dialog> nativo: fundo inerte, Esc, foco preso e devolvido ao fechar)

// Controles dos modais abertos, na ordem em que abriram (fecharModais fecha do último para o primeiro).
const modaisAbertos = new Set();
const FOCAVEIS = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), video[controls], [contenteditable="true"]';

function focaveis(raiz) {
  return Array.from(raiz.querySelectorAll(FOCAVEIS)).filter((e) => !e.closest('[hidden]') && e.getClientRects().length > 0);
}

/**
 * Abre um modal. conteudo: Node, texto ou lista. acoes: [{ texto, tipo, icone, valor, aoClicar(controle), fechar, autofoco }].
 * - Clique numa ação: se tem aoClicar, o botão fica ocupado até a promessa terminar; devolver false
 *   (ou lançar erro, que vira toast) mantém o modal aberto. Senão fecha com `valor` (ou o retorno).
 * - Esc, X e clique fora fecham com null (desligue com fecharComEsc: false / fecharAoClicarFora: false).
 * - Trocar de rota (inclusive pelo botão Voltar) ou o login aparecer por cima fecha com null (fecharModais).
 * tamanho: pequeno | medio | grande | cheio. Devolve o controle:
 * { elemento, corpo, rodape, resultado: Promise, fechar(valor), definirTitulo(txt), definirOcupado(bool) }.
 */
export function modal({
  titulo = '', conteudo, acoes = [], tamanho = 'medio', fecharComEsc = true, fecharAoClicarFora = true,
  classe, aoAbrir, descricao,
} = {}) {
  const d = documento();
  const anterior = d.activeElement;
  const id = novoId('modal');
  const tituloEl = el('h2', { class: 'modal__titulo', id: `${id}-titulo` }, titulo);
  const fecharBotao = el('button', { type: 'button', class: 'botao botao--fantasma botao--icone modal__fechar', 'aria-label': 'Fechar' }, icone('fechar'));
  const corpo = el('div', { class: 'modal__corpo' },
    descricao ? el('p', { class: 'modal__descricao', id: `${id}-descricao` }, descricao) : null,
    typeof conteudo === 'string' ? el('p', {}, conteudo) : conteudo);
  const rodape = el('div', { class: 'modal__rodape' });
  const dialogo = el('dialog', {
    class: ['modal', `modal--${tamanho}`, classe], 'aria-labelledby': `${id}-titulo`,
    'aria-describedby': descricao ? `${id}-descricao` : null,
  }, el('div', { class: 'modal__caixa' },
    el('div', { class: 'modal__cabecalho' }, tituloEl, fecharBotao),
    corpo,
    acoes.length ? rodape : null));

  let resolver;
  const resultado = new Promise((r) => { resolver = r; });
  let fechado = false;
  let ocupadoAgora = false;

  const controle = {
    elemento: dialogo, corpo, rodape, resultado,
    fechar(valor = null) {
      if (fechado) return;
      fechado = true;
      try { dialogo.close(); } catch { /* já fechado */ }
      dialogo.remove();
      modaisAbertos.delete(controle);
      if (!modaisAbertos.size) d.documentElement.classList.remove('modal-aberto');
      if (anterior && typeof anterior.focus === 'function' && anterior.isConnected) anterior.focus();
      resolver(valor);
    },
    definirTitulo(texto) { tituloEl.textContent = texto; },
    definirOcupado(sim) {
      ocupadoAgora = Boolean(sim);
      dialogo.toggleAttribute('data-ocupado', ocupadoAgora);
    },
  };

  let autofoco = null;
  for (const acao of acoes) {
    const b = botao({ texto: acao.texto, tipo: acao.tipo || 'secundario', icone: acao.icone });
    if (acao.autofoco) autofoco = b;
    b.addEventListener('click', async () => {
      if (!acao.aoClicar) {
        controle.fechar(acao.valor ?? null);
        return;
      }
      let retorno;
      controle.definirOcupado(true);
      try {
        retorno = await ocupado(b, () => acao.aoClicar(controle));
      } catch (erro) {
        toast(erro && erro.message ? erro.message : 'Não foi possível concluir.', 'erro');
        return;
      } finally {
        controle.definirOcupado(false);
      }
      if (retorno === false || acao.fechar === false || fechado) return;
      controle.fechar(acao.valor !== undefined ? acao.valor : (retorno ?? null));
    });
    rodape.append(b);
  }

  fecharBotao.addEventListener('click', () => { if (!ocupadoAgora) controle.fechar(null); });
  dialogo.addEventListener('cancel', (evento) => {
    evento.preventDefault();
    if (fecharComEsc && !ocupadoAgora) controle.fechar(null);
  });
  let cliqueComecouFora = false;
  dialogo.addEventListener('mousedown', (evento) => { cliqueComecouFora = evento.target === dialogo; });
  dialogo.addEventListener('click', (evento) => {
    if (evento.target === dialogo && cliqueComecouFora && fecharAoClicarFora && !ocupadoAgora) controle.fechar(null);
    cliqueComecouFora = false;
  });
  dialogo.addEventListener('keydown', (evento) => {
    if (evento.key !== 'Tab') return;
    const lista = focaveis(dialogo);
    if (!lista.length) return;
    const primeiro = lista[0];
    const ultimo = lista[lista.length - 1];
    if (evento.shiftKey && d.activeElement === primeiro) {
      evento.preventDefault();
      ultimo.focus();
    } else if (!evento.shiftKey && d.activeElement === ultimo) {
      evento.preventDefault();
      primeiro.focus();
    }
  });

  d.body.append(dialogo);
  modaisAbertos.add(controle);
  d.documentElement.classList.add('modal-aberto');
  if (typeof dialogo.showModal === 'function') dialogo.showModal();
  else dialogo.setAttribute('open', '');
  elevarToasts();

  const alvoFoco = corpo.querySelector('[autofocus]')
    || autofoco
    || corpo.querySelector('input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])')
    || rodape.querySelector('.botao--primario, .botao--perigo')
    || fecharBotao;
  alvoFoco.focus();
  if (aoAbrir) aoAbrir(controle);
  return controle;
}

/**
 * Fecha todos os modais abertos (o mais recente primeiro); cada `resultado` resolve com `valor`.
 * O app chama na troca de rota e quando o login aparece por cima. → quantidade fechada.
 */
export function fecharModais(valor = null) {
  const abertos = Array.from(modaisAbertos).reverse();
  for (const controle of abertos) controle.fechar(valor);
  return abertos.length;
}

/**
 * Pergunta sim/não. opções: { perigo, titulo, textoConfirmar, textoCancelar }.
 * Com perigo o botão de confirmar fica vermelho e o foco começa em "Cancelar". → Promise<boolean>
 */
export function confirmar(msg, { perigo = false, titulo, textoConfirmar, textoCancelar = 'Cancelar' } = {}) {
  const controle = modal({
    titulo: titulo || (perigo ? 'Tem certeza?' : 'Confirmar'),
    conteudo: el('p', { class: 'modal__mensagem' }, msg),
    tamanho: 'pequeno',
    classe: 'modal--confirmar',
    acoes: [
      { texto: textoCancelar, tipo: 'secundario', valor: false, autofoco: perigo },
      { texto: textoConfirmar || (perigo ? 'Sim, continuar' : 'Confirmar'), tipo: perigo ? 'perigo' : 'primario', valor: true, autofoco: !perigo },
    ],
  });
  return controle.resultado.then((v) => v === true);
}

// ---------------------------------------------------------------------------
// Diversos

const cssCarregados = new Map();

/**
 * Carrega /admin/css/<nome>.css uma única vez (estilos específicos de uma página).
 * Devolve uma promessa que resolve quando o CSS carregou (ou falhou: o aviso vai para o console).
 */
export function carregarCss(nome) {
  if (typeof nome !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(nome)) {
    return Promise.reject(new TypeError(`carregarCss: nome inválido "${nome}"`));
  }
  if (cssCarregados.has(nome)) return cssCarregados.get(nome);
  const d = documento();
  const promessa = new Promise((resolve) => {
    if (d.querySelector(`link[data-css-painel="${nome}"]`)) {
      resolve();
      return;
    }
    const link = el('link', { rel: 'stylesheet', href: `/admin/css/${nome}.css`, 'data-css-painel': nome });
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => {
      console.warn(`[painel] não foi possível carregar /admin/css/${nome}.css`);
      cssCarregados.delete(nome);
      resolve();
    }, { once: true });
    d.head.append(link);
  });
  cssCarregados.set(nome, promessa);
  return promessa;
}

/** Copia para a área de transferência e mostra um toast. → Promise<boolean> */
export async function copiarTexto(texto, { mensagem = 'Copiado!' } = {}) {
  try {
    await navigator.clipboard.writeText(String(texto));
    toast(mensagem, 'sucesso');
    return true;
  } catch {
    const d = documento();
    const area = el('textarea', { class: 'sr-only', value: String(texto), readonly: true });
    d.body.append(area);
    area.select();
    let ok = false;
    try { ok = d.execCommand('copy'); } catch { ok = false; }
    area.remove();
    toast(ok ? mensagem : 'Não foi possível copiar. Selecione e copie manualmente.', ok ? 'sucesso' : 'erro');
    return ok;
  }
}
