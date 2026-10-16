// #/conteudo e #/conteudo/<grupo> — editor do conteúdo da página inicial (docs/ARQUITETURA.md §5 e §8).
//
// - Grupos e campos vêm do template cru (GET /api/render?modelo=1, sem cache) lido com extrairEsquema.
// - O valor de cada campo é a linha de conteudo_site ou, sem linha, o padrão do template.
// - "Salvar" grava só as chaves que mudaram: upsert do valor novo ou, quando ele voltou a ser igual
//   ao padrão do template, apaga a linha (o mesmo que "Restaurar padrão").
// - "Pré-visualizar" abre o template com o rascunho aplicado numa aba nova (Blob URL).
// As funções puras exportadas rodam no Node (tests/unit/painel-conteudo.test.js).

import {
  aplicarConteudo, embedParaInstagram, extrairEsquema, instagramParaEmbed, sanitizarHtml, urlSegura,
} from '../../../js/cms/aplicar.js';

/** Máximo de itens numa lista (o motor do CMS ignora o que passar disso). */
export const LIMITE_ITENS = 200;
/** conteudo_site.valor aceita até 200 000 bytes; a folga cobre a serialização do Postgres. */
export const LIMITE_BYTES = 190_000;
const LIMITE_TEXTO = 500;
const VAZIO = 'Este campo não pode ficar vazio. Escreva um texto ou use "Restaurar padrão".';

const ICONES_GRUPO = {
  seo: 'busca', cabecalho: 'menu', 'quem-somos': 'info', postagens: 'imagem', projetos: 'estrela',
  historia: 'conteudo', loja: 'loja', depoimentos: 'usuario', parcerias: 'link', rodape: 'email', whatsapp: 'link',
};

// ---------------------------------------------------------------------------
// Utilitários puros

const objetoSimples = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const objeto = (v) => (objetoSimples(v) ? v : {});
const texto = (v) => (typeof v === 'string' ? v : '');
const colapsar = (v) => texto(v).replace(/[ \t\n\r\f]+/g, ' ').trim();
const mesmoJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Cópia profunda de um valor do CMS (só JSON). */
export function clonarValor(valor) {
  return valor === undefined ? undefined : JSON.parse(JSON.stringify(valor));
}

/** Chave da visibilidade de um grupo ocultável. */
export function chaveVisibilidade(id) {
  return `grupo.${id}.visivel`;
}

/** Linhas de conteudo_site → Map chave → { valor, atualizado_em }. */
export function mapaDeLinhas(linhas) {
  const mapa = new Map();
  for (const linha of linhas || []) {
    if (linha && typeof linha.chave === 'string') mapa.set(linha.chave, { valor: linha.valor, atualizado_em: linha.atualizado_em || null });
  }
  return mapa;
}

/** "Ideal: até 60 caracteres" na ajuda do template → 60 (ou null). */
export function limiteIdeal(ajuda) {
  const m = texto(ajuda).match(/até\s+(\d{2,4})\s+caracteres/i);
  return m ? Number(m[1]) : null;
}

/** Texto visível de um HTML (para resumos; o resultado vai para a tela só como texto). */
export function textoDoHtml(html) {
  const entidades = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
  return colapsar(texto(html)
    .replace(/<\/(p|li|h3|h4|blockquote)>|<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => entidades[e]));
}

function encurtar(valor, max) {
  const t = colapsar(valor);
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Último pedaço de um endereço (nome do arquivo), sem a consulta. */
export function nomeDoArquivo(endereco) {
  const semConsulta = texto(endereco).split(/[?#]/)[0];
  const partes = semConsulta.split('/').filter(Boolean);
  try {
    return decodeURIComponent(partes.pop() || '');
  } catch {
    return partes.pop() || '';
  }
}

// ---------------------------------------------------------------------------
// Endereços

/**
 * Completa endereços digitados sem o começo: "www.x.com" e "wa.me/55…" → https://…,
 * "nome@x.com" → mailto:, "(91) 98105-6049" → tel:+919…. Os demais ficam como estão.
 */
export function normalizarEndereco(valor) {
  const v = texto(valor).trim();
  if (!v) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || /^[/#?.]/.test(v)) return v;
  if (/^[^\s@/:]+@[^\s@/:]+\.[a-z]{2,}$/i.test(v)) return `mailto:${v}`;
  if (/^\+?[\d\s().-]{8,}$/.test(v) && (v.match(/\d/g) || []).length >= 8) {
    return `tel:${v.startsWith('+') ? '+' : ''}${v.replace(/\D/g, '')}`;
  }
  if (/^(?:www\.[^\s/]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|br|me|gov|edu|io|app|info|site|store|link|ly|co|tv))(?=[/:?#]|$)/i.test(v)) {
    return `https://${v}`;
  }
  return v;
}

/** Mensagem de erro para um endereço de link (ou null se está bom). */
export function validarEndereco(valor, { obrigatorio = true } = {}) {
  const v = texto(valor).trim();
  if (!v) return obrigatorio ? 'Informe o endereço do link.' : null;
  if (/\s/.test(v)) return 'O endereço não pode ter espaços. Confira se ele foi copiado inteiro.';
  if (!urlSegura(v)) return 'Endereço não aceito. Use um endereço que comece com https://, mailto:, tel:, / ou #.';
  return null;
}

// ---------------------------------------------------------------------------
// Normalização e valores efetivos

const BLOCO_HTML = /\s*(<\/?(?:p|ul|ol|li|blockquote|h3|h4)>|<br>)\s*/g;

/**
 * HTML do editor rico na forma canônica: sanitizado (sanitizarHtml), sem espaços entre blocos,
 * sem &nbsp; e sem parágrafos vazios. Dois textos iguais na tela dão o mesmo resultado.
 */
export function normalizarHtml(html, documento) {
  let limpo = sanitizarHtml(texto(html), documento)
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t\n\r\f]+/g, ' ')
    .replace(BLOCO_HTML, '$1');
  let anterior;
  do {
    anterior = limpo;
    limpo = limpo
      .replace(/(?:<br>)+(<\/(?:p|li|h3|h4|blockquote)>)/g, '$1')
      .replace(/<(p|li|h3|h4|blockquote)>(?:\s|<br>)*<\/\1>/g, '')
      .replace(/<(ul|ol)><\/\1>/g, '');
  } while (limpo !== anterior);
  return limpo.trim();
}

function normalizarTextoLongo(valor) {
  return texto(valor).replace(/\r\n?/g, '\n').split('\n').map(colapsar).join('\n').replace(/^\n+|\n+$/g, '');
}

function vazioDoTipo(campo) {
  switch (campo && campo.tipo) {
    case 'imagem': return { src: '', alt: '' };
    case 'video': return { src: '', poster: '' };
    case 'link': return { href: '', texto: '' };
    case 'lista': return [];
    case 'visivel': return true;
    default: return '';
  }
}

/**
 * Valor na forma que vai para conteudo_site, para comparar e salvar.
 * campo = { tipo, campos? } (do esquema; 'visivel' para a chave grupo.<id>.visivel).
 */
export function normalizarValor(campo, valor, documento) {
  switch (campo && campo.tipo) {
    case 'texto':
    case 'meta':
      return colapsar(valor);
    case 'textolongo':
      return normalizarTextoLongo(valor);
    case 'html':
      return normalizarHtml(valor, documento);
    case 'url':
      return normalizarEndereco(valor);
    case 'instagram': {
      const t = texto(valor).trim();
      return embedParaInstagram(t) || t;
    }
    case 'imagem': {
      const o = objeto(valor);
      return { src: texto(o.src).trim(), alt: colapsar(o.alt) };
    }
    case 'video': {
      const o = objeto(valor);
      return { src: texto(o.src).trim(), poster: texto(o.poster).trim() };
    }
    case 'link': {
      const o = objeto(valor);
      return { href: normalizarEndereco(o.href), texto: colapsar(o.texto) };
    }
    case 'lista': {
      const subcampos = Array.isArray(campo.campos) ? campo.campos : [];
      return (Array.isArray(valor) ? valor : []).filter(objetoSimples).map((item) => {
        if (!subcampos.length) return clonarValor(item);
        const saida = {};
        for (const sub of subcampos) saida[sub.campo] = normalizarValor(sub, item[sub.campo], documento);
        return saida;
      });
    }
    case 'visivel':
      return valor !== false;
    default:
      return valor === undefined ? null : clonarValor(valor);
  }
}

/** Os dois valores mostram a mesma coisa no site? */
export function valoresIguais(campo, a, b, documento) {
  return mesmoJson(normalizarValor(campo, a, documento), normalizarValor(campo, b, documento));
}

const PARTES = { imagem: ['src', 'alt'], video: ['src', 'poster'], link: ['href', 'texto'] };
const PARTES_URL = { imagem: ['src'], video: ['src', 'poster'], link: ['href'] };

function copiaDasPartes(tipo, padrao) {
  const saida = {};
  for (const nome of PARTES[tipo]) saida[nome] = texto(objeto(padrao)[nome]);
  return saida;
}

// Imita aplicarConteudo: URL insegura descarta o valor inteiro; partes ausentes ficam com o padrão.
function efetivoObjeto(tipo, salvo, padrao) {
  if (!objetoSimples(salvo)) return copiaDasPartes(tipo, padrao);
  for (const nome of PARTES_URL[tipo]) {
    const v = salvo[nome];
    if (typeof v === 'string' && v.trim() && !urlSegura(v)) return copiaDasPartes(tipo, padrao);
  }
  const p = objeto(padrao);
  const saida = {};
  for (const nome of PARTES[tipo]) {
    const v = salvo[nome];
    if (PARTES_URL[tipo].includes(nome)) {
      if (typeof v === 'string' && v.trim()) saida[nome] = urlSegura(v);
      else if (tipo === 'video' && nome === 'poster' && typeof v === 'string') saida[nome] = '';
      else saida[nome] = texto(p[nome]);
    } else if (tipo === 'link') {
      saida[nome] = typeof v === 'string' && v.trim() ? v : texto(p[nome]);
    } else {
      saida[nome] = typeof v === 'string' ? v : texto(p[nome]);
    }
  }
  return saida;
}

/** Valores do primeiro item do template (o molde): um item novo nasce assim. */
export function valoresDoMolde(campo) {
  const primeiro = Array.isArray(campo && campo.padrao) && objetoSimples(campo.padrao[0]) ? campo.padrao[0] : {};
  const saida = {};
  for (const sub of (campo && campo.campos) || []) {
    saida[sub.campo] = primeiro[sub.campo] !== undefined ? clonarValor(primeiro[sub.campo]) : vazioDoTipo(sub);
  }
  return saida;
}

function efetivo(campo, salvo, padrao) {
  const base = padrao === undefined ? vazioDoTipo(campo) : padrao;
  if (salvo === undefined || salvo === null) return clonarValor(base);
  switch (campo.tipo) {
    case 'texto':
    case 'textolongo':
    case 'html':
    case 'meta':
      return typeof salvo === 'string' ? salvo : clonarValor(base);
    case 'url':
      return typeof salvo === 'string' && salvo.trim() && urlSegura(salvo) ? salvo : clonarValor(base);
    case 'instagram':
      return typeof salvo === 'string' && instagramParaEmbed(salvo) ? salvo : clonarValor(base);
    case 'imagem':
    case 'video':
    case 'link':
      return efetivoObjeto(campo.tipo, salvo, base);
    case 'lista': {
      if (!Array.isArray(salvo)) return clonarValor(base);
      const itens = salvo.slice(0, LIMITE_ITENS * 5).filter(objetoSimples).slice(0, LIMITE_ITENS);
      if (salvo.length && !itens.length) return clonarValor(base);
      const subcampos = campo.campos || [];
      const molde = valoresDoMolde(campo);
      return itens.map((item) => {
        if (!subcampos.length) return clonarValor(item);
        const saida = {};
        for (const sub of subcampos) saida[sub.campo] = efetivo(sub, item[sub.campo], molde[sub.campo]);
        return saida;
      });
    }
    case 'visivel':
      return salvo !== false;
    default:
      return clonarValor(salvo);
  }
}

/** O que o site mostra hoje: a linha salva (se o motor a aceita) ou o padrão do template. */
export function valorEfetivo(campo, linha) {
  return efetivo(campo, linha ? linha.valor : undefined, campo.padrao);
}

/**
 * Compara o rascunho com o que o site mostra e devolve só o que mudou:
 * { salvar: [{ chave, valor }], apagar: [chave], total }. Valor igual ao padrão do template com
 * linha no banco → apagar (volta ao original); senão upsert do valor normalizado.
 */
export function montarAlteracoes({ campos, rascunho, salvos, documento }) {
  const salvar = [];
  const apagar = [];
  for (const campo of campos || []) {
    if (!rascunho.has(campo.chave)) continue;
    const linha = salvos.get(campo.chave);
    const novo = normalizarValor(campo, rascunho.get(campo.chave), documento);
    const atual = normalizarValor(campo, valorEfetivo(campo, linha), documento);
    if (mesmoJson(novo, atual)) continue;
    const padrao = normalizarValor(campo, campo.padrao === undefined ? vazioDoTipo(campo) : campo.padrao, documento);
    if (linha && mesmoJson(novo, padrao)) apagar.push(campo.chave);
    else salvar.push({ chave: campo.chave, valor: novo });
  }
  return { salvar, apagar, total: salvar.length + apagar.length };
}

// ---------------------------------------------------------------------------
// Validação (sobre o valor já normalizado)

/** Campo meta que guarda o endereço de uma imagem (ex.: seo.og-imagem): ganha o seletor de mídia. */
export function ehMetaDeImagem(campo) {
  return Boolean(campo) && campo.tipo === 'meta' && /(^|[.-])imagem($|[.-])/.test(String(campo.chave || campo.campo || ''));
}

function textoEditavel(padrao) {
  return Boolean(texto(objeto(padrao).texto).trim());
}

function erroDoCampo(campo, valor, padrao) {
  switch (campo.tipo) {
    case 'texto':
      if (!valor) return { mensagem: VAZIO };
      if (valor.length > LIMITE_TEXTO) return { mensagem: `Texto longo demais: use no máximo ${LIMITE_TEXTO} letras.` };
      return null;
    case 'textolongo':
    case 'html':
      return valor ? null : { mensagem: VAZIO };
    case 'meta':
      if (!valor) return { mensagem: VAZIO };
      if (ehMetaDeImagem(campo) && (/\s/.test(valor) || !urlSegura(valor))) {
        return { mensagem: 'Endereço da imagem não aceito. Use "Escolher imagem" ou um endereço que comece com https:// ou /.' };
      }
      return null;
    case 'url': {
      const m = validarEndereco(valor);
      return m ? { mensagem: m } : null;
    }
    case 'instagram':
      if (!valor) return { mensagem: 'Cole o endereço da publicação do Instagram.' };
      return instagramParaEmbed(valor) ? null : {
        mensagem: 'Este endereço não é de uma publicação do Instagram. No Instagram, abra a publicação, toque em ⋯ ou em Compartilhar, escolha "Copiar link" e cole aqui.',
      };
    case 'imagem':
      if (!valor.src) return { parte: 'src', mensagem: 'Escolha uma imagem.' };
      if (!urlSegura(valor.src)) return { parte: 'src', mensagem: 'Endereço da imagem não aceito. Escolha a imagem de novo pela biblioteca.' };
      if (!valor.alt) return { parte: 'alt', mensagem: 'Escreva o texto alternativo: uma frase curta dizendo o que aparece na imagem.' };
      return null;
    case 'video':
      if (!valor.src) return { parte: 'src', mensagem: 'Escolha um vídeo.' };
      if (!urlSegura(valor.src)) return { parte: 'src', mensagem: 'Endereço do vídeo não aceito. Escolha o vídeo de novo pela biblioteca.' };
      if (valor.poster && !urlSegura(valor.poster)) return { parte: 'poster', mensagem: 'Endereço da capa não aceito. Escolha a capa de novo.' };
      return null;
    case 'link': {
      const m = validarEndereco(valor.href);
      if (m) return { parte: 'href', mensagem: m };
      if (textoEditavel(padrao) && !valor.texto) return { parte: 'texto', mensagem: 'Escreva o texto do link.' };
      return null;
    }
    default:
      return null;
  }
}

function bytesDoJson(valor) {
  const json = JSON.stringify(valor) || '';
  return typeof TextEncoder === 'function' ? new TextEncoder().encode(json).length : json.length * 3;
}

/**
 * Erros do valor normalizado de um campo: [{ indice, campo, parte, mensagem }]
 * (indice/campo = item e subcampo nas listas; parte = 'src' | 'alt' | 'href' | 'texto' | 'poster').
 */
export function validarValor(campo, valor) {
  const erros = [];
  if (campo.tipo === 'lista') {
    const itens = Array.isArray(valor) ? valor : [];
    if (itens.length > LIMITE_ITENS) {
      erros.push({ indice: null, campo: null, parte: null, mensagem: `A lista pode ter no máximo ${LIMITE_ITENS} itens.` });
    }
    const molde = valoresDoMolde(campo);
    itens.forEach((item, indice) => {
      for (const sub of campo.campos || []) {
        const e = erroDoCampo(sub, objeto(item)[sub.campo], molde[sub.campo]);
        if (e) erros.push({ indice, campo: sub.campo, parte: e.parte || null, mensagem: e.mensagem });
      }
    });
  } else {
    const e = erroDoCampo(campo, valor, campo.padrao);
    if (e) erros.push({ indice: null, campo: null, parte: e.parte || null, mensagem: e.mensagem });
  }
  if (!erros.length && bytesDoJson(valor) > LIMITE_BYTES) {
    erros.push({ indice: null, campo: null, parte: null, mensagem: 'Este conteúdo ficou grande demais para salvar de uma vez. Encurte o texto ou tire alguns itens.' });
  }
  return erros;
}

// ---------------------------------------------------------------------------
// Operações de lista (devolvem uma lista nova)

export function adicionarItem(lista, item) {
  return [...(lista || []), clonarValor(item)];
}

export function removerItem(lista, indice) {
  return (lista || []).filter((_, i) => i !== indice);
}

export function moverItem(lista, de, para) {
  const copia = [...(lista || [])];
  if (de < 0 || de >= copia.length) return copia;
  const destino = Math.max(0, Math.min(copia.length - 1, para));
  const [item] = copia.splice(de, 1);
  copia.splice(destino, 0, item);
  return copia;
}

/**
 * Título e detalhe de um item recolhido: textos curtos (nome, rótulo) → texto alternativo →
 * texto do link → "<Item> N"; detalhe: começo do texto longo → endereço → nome do arquivo.
 */
export function resumoDoItem(item, campos, indice, itemRotulo = 'Item') {
  const curtos = [];
  const longos = [];
  const alts = [];
  const links = [];
  const enderecos = [];
  let imagem = '';
  let arquivo = '';
  for (const c of campos || []) {
    const v = objeto(item)[c.campo];
    switch (c.tipo) {
      case 'texto':
      case 'meta':
        if (colapsar(v)) curtos.push(colapsar(v));
        break;
      case 'textolongo':
        if (colapsar(v)) longos.push(colapsar(v));
        break;
      case 'html':
        if (textoDoHtml(v)) longos.push(textoDoHtml(v));
        break;
      case 'imagem':
        if (!imagem && texto(objeto(v).src)) {
          imagem = texto(objeto(v).src);
          arquivo = nomeDoArquivo(imagem);
        }
        if (colapsar(objeto(v).alt)) alts.push(colapsar(objeto(v).alt));
        break;
      case 'video':
        if (!arquivo && texto(objeto(v).src)) arquivo = nomeDoArquivo(objeto(v).src);
        break;
      case 'link':
        if (colapsar(objeto(v).texto)) links.push(colapsar(objeto(v).texto));
        if (texto(objeto(v).href)) enderecos.push(texto(objeto(v).href).trim());
        break;
      case 'url':
      case 'instagram':
        if (texto(v).trim()) enderecos.unshift(texto(v).trim());
        break;
      default:
        break;
    }
  }
  const padrao = `${itemRotulo} ${indice + 1}`;
  let titulo = curtos.length ? [...curtos, ...links].join(' ') : alts[0] || links[0] || '';
  if (!titulo) titulo = padrao;
  const detalhe = longos[0] || enderecos[0] || arquivo || '';
  return { titulo: encurtar(titulo, 80), detalhe: encurtar(detalhe, 90), imagem };
}

// ---------------------------------------------------------------------------
// Visão geral dos grupos e pré-visualização

/** SEO por último: é a parte que menos se edita. */
export function ordenarGrupos(grupos) {
  const lista = grupos || [];
  const meio = lista.filter((g) => g.id !== 'seo' && g.id !== 'identidade');
  return [...lista.filter((g) => g.id === 'identidade'), ...meio, ...lista.filter((g) => g.id === 'seo')];
}

/** Resumo de cada grupo para os cartões de #/conteudo. */
export function resumirGrupos(esquema, salvos) {
  return ordenarGrupos((esquema && esquema.grupos) || []).map((g) => {
    const linhas = g.campos.map((c) => salvos.get(c.chave)).filter(Boolean);
    const visibilidade = salvos.get(chaveVisibilidade(g.id));
    const datas = [...linhas, visibilidade].filter(Boolean).map((l) => l.atualizado_em).filter(Boolean).sort();
    return {
      id: g.id,
      rotulo: g.rotulo,
      ocultavel: Boolean(g.ocultavel),
      visivel: !(g.ocultavel && visibilidade && visibilidade.valor === false),
      totalCampos: g.campos.length,
      rotulosCampos: g.campos.map((c) => c.rotulo),
      personalizados: linhas.length,
      atualizadoEm: datas.length ? datas[datas.length - 1] : null,
    };
  });
}

const ESTILO_FAIXA = [
  'position:fixed', 'left:12px', 'bottom:14px', 'z-index:2147483647',
  'max-width:min(420px,calc(100% - 210px))', 'padding:8px 14px', 'border-radius:14px', 'background:#0B2A1C', 'color:#FBF6EA',
  'font:600 13px/1.3 system-ui,sans-serif', 'text-align:center', 'box-shadow:0 6px 18px rgba(0,0,0,.3)',
  'pointer-events:none',
].join(';');

/**
 * HTML da pré-visualização: template + conteúdo aplicado + <base> na origem do site (os caminhos
 * /css, /img e /js continuam funcionando dentro de um blob:) + faixa "Pré-visualização".
 * analisar(html) → Document (DOMParser no navegador, linkedom nos testes).
 */
export function htmlDaPrevia(template, conteudo, { analisar, origem = '', aviso = '' } = {}) {
  const doc = analisar(template);
  aplicarConteudo(doc, conteudo);
  const head = doc.head || doc.querySelector('head');
  if (head) {
    const base = doc.createElement('base');
    base.setAttribute('href', `${origem}/`);
    head.insertBefore(base, head.firstChild);
  }
  const corpo = doc.body || doc.querySelector('body');
  if (aviso && corpo) {
    const faixa = doc.createElement('div');
    faixa.setAttribute('style', ESTILO_FAIXA);
    faixa.setAttribute('role', 'status');
    faixa.setAttribute('data-previa-painel', '');
    faixa.textContent = aviso;
    corpo.appendChild(faixa);
  }
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

// ---------------------------------------------------------------------------
// Página

/**
 * Recursos da renderização atual, liberados na limpeza. Os modais abertos (confirmar, seletor de
 * mídia, link) são fechados pelo próprio app na troca de rota (docs/PAINEL.md §3.4).
 */
function criarRecursos() {
  return { urls: new Set(), limpezas: new Set() };
}

function liberarRecursos(recursos) {
  for (const fn of recursos.limpezas) {
    try { fn(); } catch (erro) { console.error('[conteudo] erro na limpeza:', erro); }
  }
  recursos.limpezas.clear();
  // A aba da pré-visualização pode ainda estar carregando: libera a Blob URL um pouco depois.
  for (const url of recursos.urls) setTimeout(() => URL.revokeObjectURL(url), 30_000);
  recursos.urls.clear();
}

async function buscarModelo(sinal) {
  try {
    const resposta = await fetch('/api/render?modelo=1', { cache: 'no-store', signal: sinal, credentials: 'same-origin' });
    if (!resposta.ok) {
      return { ok: false, mensagem: 'Não foi possível carregar o modelo da página inicial. Tente de novo em instantes.' };
    }
    return { ok: true, html: await resposta.text() };
  } catch (erro) {
    if (erro && erro.name === 'AbortError') return { ok: false, erro: 'cancelado' };
    return { ok: false, mensagem: 'Não foi possível falar com o servidor. Verifique sua internet e tente de novo.' };
  }
}

async function carregarDados(ctx) {
  const [modelo, linhas] = await Promise.all([
    buscarModelo(ctx.sinal),
    ctx.api.consultar(ctx.supabase.from('conteudo_site').select('chave, valor, atualizado_em')),
  ]);
  if (!modelo.ok) return modelo;
  if (!linhas.ok) return linhas;
  let documento;
  let esquema;
  try {
    documento = new DOMParser().parseFromString(modelo.html, 'text/html');
    esquema = extrairEsquema(documento);
  } catch (erro) {
    console.error('[conteudo] não foi possível ler o modelo:', erro);
    esquema = { grupos: [] };
  }
  if (!esquema.grupos.length) {
    return { ok: false, mensagem: 'O modelo da página inicial não tem partes editáveis. Avise o responsável técnico.' };
  }
  return { ok: true, template: modelo.html, documento, esquema, salvos: mapaDeLinhas(linhas.dados) };
}

function ancoraDoGrupo(documento, id) {
  const elemento = documento && documento.querySelector(`[data-cms-grupo="${id}"]`);
  const ancora = elemento ? elemento.getAttribute('id') || '' : '';
  return /^[A-Za-z][\w-]*$/.test(ancora) ? ancora : '';
}

export async function renderizar(ctx) {
  const { ui } = ctx;
  const { el } = ui;
  const grupoId = ctx.params.grupo || null;
  const recursos = criarRecursos();
  const limpar = () => liberarRecursos(recursos);
  const estilo = ui.carregarCss('conteudo');

  const cabecalho = ui.cabecalhoPagina(grupoId
    ? { titulo: 'Conteúdo do site', voltar: { href: '#/conteudo', texto: 'Conteúdo do site' } }
    : {
      titulo: 'Conteúdo do site',
      descricao: 'Textos, fotos, vídeos e links da página inicial.',
      acoes: [ui.botao({ texto: 'Ver o site', iconeDireita: 'externo', href: '/', attrs: { target: '_blank', rel: 'noopener' } })],
    });
  const corpo = el('div', { class: 'pilha cms-pagina' });
  ctx.raiz.append(cabecalho, corpo);
  ui.estadoCarregando(corpo, { linhas: 6, tipo: grupoId ? 'lista' : 'tabela', mensagem: 'Carregando o conteúdo do site…' });

  const [dados] = await Promise.all([carregarDados(ctx), estilo]);
  if (!ctx.ativo()) return limpar;
  if (!dados.ok) {
    if (dados.erro === 'cancelado') return limpar;
    ui.estadoErro(corpo, dados.mensagem, { aoTentarNovamente: () => ctx.navegar(window.location.hash) });
    return limpar;
  }
  if (grupoId) montarGrupo(ctx, dados, { cabecalho, corpo, recursos, grupoId });
  else montarVisaoGeral(ctx, dados, corpo);
  return limpar;
}

// ---------------------------------------------------------------------------
// #/conteudo — lista de grupos

function montarVisaoGeral(ctx, dados, corpo) {
  const { ui } = ctx;
  const { el } = ui;
  const resumos = resumirGrupos(dados.esquema, dados.salvos);
  const cartao = (r) => {
    const nomes = r.rotulosCampos.slice(0, 3).join(' · ') + (r.rotulosCampos.length > 3 ? ` e mais ${r.rotulosCampos.length - 3}` : '');
    const quando = r.atualizadoEm ? ui.tempoRelativo(r.atualizadoEm) : '';
    const selos = [];
    if (r.ocultavel) {
      selos.push(el('span', { class: ['selo', r.visivel ? 'selo--verde' : 'selo--cinza'] }, r.visivel ? 'Visível no site' : 'Oculta no site'));
    }
    selos.push(r.personalizados
      ? el('span', { class: 'selo selo--ouro' }, `Editado ${/^\d/.test(quando) ? `em ${quando}` : quando}`.trim())
      : el('span', { class: 'selo selo--cinza selo--sem-ponto' }, 'Conteúdo original'));
    const quantidade = r.totalCampos === 1 ? '1 campo' : `${r.totalCampos} campos`;
    return el('a', { class: 'cms-grupo', href: `#/conteudo/${r.id}`, dataset: { grupo: r.id } },
      el('span', { class: 'cms-grupo__icone' }, ui.icone(ICONES_GRUPO[r.id] || 'conteudo')),
      el('span', { class: 'cms-grupo__textos' },
        el('span', { class: 'cms-grupo__titulo' }, r.rotulo),
        el('span', { class: 'cms-grupo__campos' }, r.totalCampos ? nomes : 'Mostrar ou ocultar esta parte'),
        el('span', { class: 'cms-grupo__selos' }, selos, r.totalCampos ? el('span', { class: 'cms-grupo__quantidade' }, quantidade) : null)),
      ui.icone('avancar', { classe: 'cms-grupo__seta' }));
  };
  corpo.replaceChildren(
    el('ul', { class: 'cms-grupos', 'aria-label': 'Partes da página inicial' }, resumos.map((r) => el('li', {}, cartao(r)))),
  );
}

// ---------------------------------------------------------------------------
// Editores por tipo. Todos devolvem { elemento, mostrarErros(erros), focarErro(), focar(), idEntrada? }.

function definirErroEm({ entrada, erro, envoltorio, idAjuda }, mensagem) {
  erro.textContent = mensagem || '';
  erro.hidden = !mensagem;
  if (envoltorio) envoltorio.classList.toggle('campo--erro', Boolean(mensagem));
  if (!entrada) return;
  if (mensagem) entrada.setAttribute('aria-invalid', 'true');
  else entrada.removeAttribute('aria-invalid');
  const descricao = [idAjuda, mensagem ? erro.id : null].filter(Boolean).join(' ');
  if (descricao) entrada.setAttribute('aria-describedby', descricao);
  else entrada.removeAttribute('aria-describedby');
}

function ajustarAltura(area) {
  if (!area || area.tagName !== 'TEXTAREA' || !area.isConnected) return;
  area.style.height = 'auto';
  if (!area.scrollHeight) return; // escondido: mantém a altura do CSS
  area.style.height = `${Math.min(area.scrollHeight + 4, Math.round(window.innerHeight * 0.6))}px`;
}

/** Texto curto mostrado numa caixa que cresce (sem cortar no celular) quando passa disto. */
const TEXTO_CURTO = 28;

function editorTexto(ctx, campo, valor, aoMudar, { idRotulo, idAjuda }) {
  const { ui } = ctx;
  const { el } = ui;
  const id = ui.novoId('cms-texto');
  const limite = limiteIdeal(campo.ajuda);
  // texto e meta são uma linha só: numa caixa que cresce, Enter não quebra a linha.
  const umaLinha = campo.tipo !== 'textolongo';
  const longo = !ehMetaDeImagem(campo) && (campo.tipo === 'textolongo' || campo.tipo === 'meta' || colapsar(valor).length > TEXTO_CURTO);
  const entrada = longo
    ? el('textarea', {
      class: ['entrada', 'cms-area', umaLinha && 'cms-area--linha'], id, rows: umaLinha ? '1' : '4', value: texto(valor),
      'aria-labelledby': idRotulo, maxlength: campo.tipo === 'texto' ? String(LIMITE_TEXTO) : null,
    })
    : el('input', {
      class: 'entrada', id, type: 'text', value: texto(valor), 'aria-labelledby': idRotulo, autocomplete: 'off',
      maxlength: campo.tipo === 'texto' ? String(LIMITE_TEXTO) : null,
    });
  if (idAjuda) entrada.setAttribute('aria-describedby', idAjuda);
  const contador = limite ? el('p', { class: 'cms-contador' }) : null;
  const erro = el('p', { class: 'campo__erro', id: `${id}-erro`, hidden: true });
  const elemento = el('div', { class: 'campo cms-editor' }, entrada, contador, erro);
  const partes = { entrada, erro, envoltorio: elemento, idAjuda };
  // Meta com endereço de imagem: prévia e "Escolher imagem" (biblioteca ou envio novo).
  let atualizarPrevia = () => {};
  if (ehMetaDeImagem(campo)) {
    const previa = el('div', { class: 'cms-meta-imagem__previa' });
    atualizarPrevia = () => {
      const src = urlSegura(entrada.value.trim()) && !/\s/.test(entrada.value.trim()) ? entrada.value.trim() : '';
      previa.replaceChildren(previaDeImagem(ui, src));
    };
    const escolher = ui.botao({
      texto: 'Escolher imagem', icone: 'imagem', tipo: 'secundario',
      aoClicar: async () => {
        const url = await ctx.midia.seletorDeMidia({ tipo: 'imagem', pasta: 'site', titulo: campo.rotulo, atual: entrada.value.trim() });
        if (!url || !ctx.ativo()) return;
        entrada.value = url;
        entrada.dispatchEvent(new Event('input', { bubbles: true }));
        escolher.focus();
      },
    });
    elemento.classList.add('cms-meta-imagem');
    elemento.prepend(el('div', { class: 'cms-meta-imagem__linha' }, previa, el('div', { class: 'grupo-botoes' }, escolher)));
    atualizarPrevia();
  }
  const contar = () => {
    if (!contador) return;
    const n = colapsar(entrada.value).length;
    contador.textContent = `${n} de ${limite} caracteres recomendados`;
    contador.classList.toggle('cms-contador--acima', n > limite);
  };
  contar();
  entrada.addEventListener('input', () => {
    if (!erro.hidden) definirErroEm(partes, null);
    contar();
    ajustarAltura(entrada);
    atualizarPrevia();
    aoMudar(entrada.value);
  });
  if (longo) {
    requestAnimationFrame(() => ajustarAltura(entrada));
    if (umaLinha) {
      entrada.addEventListener('keydown', (evento) => {
        if (evento.key === 'Enter') evento.preventDefault();
      });
    }
  }
  return {
    elemento, idEntrada: id,
    mostrarErros: (erros) => definirErroEm(partes, erros && erros[0] ? erros[0].mensagem : null),
    focarErro: () => entrada.focus(),
    focar: () => entrada.focus(),
  };
}

// Conteúdo de HTML sanitizado (só tags permitidas, sem atributos perigosos) num elemento editável.
function preencherHtml(alvo, html) {
  const modelo = document.createElement('template');
  modelo.innerHTML = sanitizarHtml(texto(html), document);
  alvo.replaceChildren(modelo.content);
}

const PERMITIDAS_NO_EDITOR = 'p,br,strong,b,em,i,u,s,a,ul,ol,li,blockquote,h3,h4,span';

function editorRico(ctx, campo, valor, aoMudar, { idRotulo, idAjuda, recursos }) {
  const { ui } = ctx;
  const { el } = ui;
  const id = ui.novoId('cms-rico');
  const area = el('div', {
    class: 'cms-rico__area', id, contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true',
    'aria-labelledby': idRotulo, 'aria-describedby': idAjuda, spellcheck: 'true', lang: 'pt-BR', tabindex: '0',
  });
  preencherHtml(area, valor);
  const erro = el('p', { class: 'campo__erro', id: `${id}-erro`, hidden: true });
  let ultimoIntervalo = null;

  const BOTOES = [
    { id: 'negrito', comando: 'bold', estado: true, rotulo: 'Negrito', dica: 'Negrito (Ctrl+B)', marca: el('b', {}, 'N') },
    { id: 'italico', comando: 'italic', estado: true, rotulo: 'Itálico', dica: 'Itálico (Ctrl+I)', marca: el('i', {}, 'I') },
    { id: 'link', comando: 'link', rotulo: 'Link', dica: 'Criar ou editar um link', icone: 'link' },
    { id: 'lista', comando: 'insertUnorderedList', estado: true, rotulo: 'Lista', dica: 'Lista com marcadores', icone: 'menu' },
    { id: 'paragrafo', comando: 'paragrafo', rotulo: 'Parágrafo', dica: 'Texto normal (tira a lista)', marca: el('span', { 'aria-hidden': 'true' }, '¶') },
  ];
  const botoes = new Map();
  const barra = el('div', { class: 'cms-rico__barra', role: 'toolbar', 'aria-label': `Formatação do texto: ${campo.rotulo}`, 'aria-controls': id },
    BOTOES.map((b) => {
      const botao = el('button', {
        type: 'button', class: ['botao', 'botao--fantasma', 'botao--pequeno', 'cms-rico__botao', `cms-rico__botao--${b.id}`],
        title: b.dica, 'aria-pressed': b.estado ? 'false' : null,
      }, b.icone ? ui.icone(b.icone) : b.marca, el('span', { class: 'cms-rico__rotulo' }, b.rotulo));
      // Não tira o foco (nem a seleção) do texto.
      botao.addEventListener('mousedown', (evento) => evento.preventDefault());
      botao.addEventListener('click', () => executar(b));
      botoes.set(b.id, { definicao: b, botao });
      return botao;
    }));
  const elemento = el('div', { class: 'campo cms-editor' }, el('div', { class: 'cms-rico' }, barra, area), erro);
  const partes = { entrada: area, erro, envoltorio: elemento, idAjuda };

  const emitir = () => aoMudar(area.innerHTML);

  function selecaoDentro() {
    const selecao = window.getSelection();
    return selecao && selecao.rangeCount && area.contains(selecao.anchorNode) ? selecao : null;
  }

  function guardarSelecao() {
    const selecao = selecaoDentro();
    if (selecao) ultimoIntervalo = selecao.getRangeAt(0).cloneRange();
    atualizarBotoes();
  }

  function garantirFoco() {
    if (document.activeElement === area && selecaoDentro()) return;
    area.focus();
    const selecao = window.getSelection();
    if (ultimoIntervalo && selecao) {
      selecao.removeAllRanges();
      selecao.addRange(ultimoIntervalo);
    }
  }

  function atualizarBotoes() {
    for (const { definicao, botao } of botoes.values()) {
      if (!definicao.estado) continue;
      let ativo = false;
      try { ativo = document.activeElement === area && document.queryCommandState(definicao.comando); } catch { ativo = false; }
      botao.setAttribute('aria-pressed', String(Boolean(ativo)));
    }
  }

  function executar(b) {
    if (b.comando === 'link') {
      editarLink();
      return;
    }
    garantirFoco();
    try {
      document.execCommand('styleWithCSS', false, false);
      if (b.comando === 'paragrafo') {
        if (document.queryCommandState('insertUnorderedList')) document.execCommand('insertUnorderedList');
        else if (document.queryCommandState('insertOrderedList')) document.execCommand('insertOrderedList');
        else document.execCommand('formatBlock', false, 'p');
      } else {
        document.execCommand(b.comando, false, null);
      }
    } catch (erroComando) {
      console.warn('[conteudo] comando de formatação falhou:', erroComando);
    }
    guardarSelecao();
    emitir();
  }

  function linkAtual() {
    const selecao = selecaoDentro();
    let no = selecao ? selecao.anchorNode : null;
    while (no && no !== area) {
      if (no.nodeType === 1 && no.tagName === 'A') return no;
      no = no.parentNode;
    }
    return null;
  }

  async function editarLink() {
    garantirFoco();
    const selecao = selecaoDentro();
    const intervalo = selecao ? selecao.getRangeAt(0).cloneRange() : null;
    const atual = linkAtual();
    if (!intervalo || (intervalo.collapsed && !atual)) {
      ui.toast('Primeiro selecione no texto as palavras que vão virar link.', 'aviso');
      return;
    }
    const endereco = ui.campo({
      rotulo: 'Endereço do link', nome: 'endereco', valor: atual ? atual.getAttribute('href') || '' : '', placeholder: 'https://…', obrigatorio: true,
      ajuda: 'Ex.: https://www.instagram.com/oscdemulheres/, /loja/ ou mailto:contato@exemplo.com',
      attrs: { inputmode: 'url', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' },
    });
    const novaAba = ui.campo({ tipo: 'checkbox', nome: 'nova-aba', rotulo: 'Abrir em outra aba', valor: atual ? atual.getAttribute('target') === '_blank' : true });
    const acoes = [{ texto: 'Cancelar', valor: null }];
    if (atual) acoes.push({ texto: 'Tirar o link', tipo: 'perigo-suave', valor: 'remover' });
    acoes.push({
      texto: 'Aplicar link', tipo: 'primario', icone: 'check',
      aoClicar: () => {
        const href = normalizarEndereco(endereco.ler());
        const mensagem = validarEndereco(href);
        if (mensagem) {
          endereco.definirErro(mensagem);
          endereco.entrada.focus();
          return false;
        }
        return { href, novaAba: novaAba.ler() };
      },
    });
    const controle = ui.modal({
      titulo: atual ? 'Editar link' : 'Criar link', tamanho: 'pequeno', classe: 'modal--cms-link',
      conteudo: el('div', { class: 'formulario' }, endereco.elemento, novaAba.elemento), acoes,
    });
    const resultado = await controle.resultado;
    if (!resultado || !ctx.ativo() || !area.isConnected) return;
    area.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(intervalo);
    if (resultado === 'remover') {
      if (intervalo.collapsed && atual) {
        const todo = document.createRange();
        todo.selectNodeContents(atual);
        sel.removeAllRanges();
        sel.addRange(todo);
      }
      document.execCommand('unlink');
    } else if (atual && intervalo.collapsed) {
      atual.setAttribute('href', resultado.href);
      if (resultado.novaAba) atual.setAttribute('target', '_blank');
      else atual.removeAttribute('target');
    } else {
      document.execCommand('createLink', false, resultado.href);
      for (const a of area.querySelectorAll('a')) {
        if (a.getAttribute('href') !== resultado.href) continue;
        if (resultado.novaAba) a.setAttribute('target', '_blank');
        else a.removeAttribute('target');
      }
    }
    guardarSelecao();
    emitir();
  }

  // selectionchange só enquanto o editor tem o foco.
  const aoMudarSelecao = () => guardarSelecao();
  area.addEventListener('focus', () => {
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* navegador sem suporte */ }
    document.addEventListener('selectionchange', aoMudarSelecao);
    atualizarBotoes();
  });
  area.addEventListener('blur', () => {
    document.removeEventListener('selectionchange', aoMudarSelecao);
    atualizarBotoes();
    // Colagem ou edição deixou tags ou estilos que o site não usa: limpa o que aparece no editor.
    if (area.querySelector(`:not(${PERMITIDAS_NO_EDITOR}), [style], [class]`)) {
      preencherHtml(area, normalizarHtml(area.innerHTML, document));
      emitir();
    }
  });
  recursos.limpezas.add(() => document.removeEventListener('selectionchange', aoMudarSelecao));
  area.addEventListener('input', () => {
    // Texto digitado direto no editor vazio vira parágrafo (como no site).
    if (area.firstChild && area.firstChild.nodeType === 3 && area.firstChild.textContent.trim()) {
      try { document.execCommand('formatBlock', false, 'p'); } catch { /* segue sem parágrafo */ }
    }
    if (!erro.hidden) definirErroEm(partes, null);
    emitir();
  });
  area.addEventListener('paste', (evento) => {
    const dados = evento.clipboardData;
    if (!dados) return;
    evento.preventDefault();
    const html = dados.getData('text/html');
    const simples = dados.getData('text/plain');
    const limpo = html ? normalizarHtml(html, document) : '';
    if (limpo) document.execCommand('insertHTML', false, limpo);
    else if (simples) document.execCommand('insertText', false, simples);
  });
  area.addEventListener('drop', (evento) => {
    if (evento.dataTransfer && evento.dataTransfer.files && evento.dataTransfer.files.length) evento.preventDefault();
  });

  return {
    elemento,
    mostrarErros: (erros) => definirErroEm(partes, erros && erros[0] ? erros[0].mensagem : null),
    focarErro: () => area.focus(),
    focar: () => area.focus(),
  };
}

function previaDeImagem(ui, src, { vazio = 'Nenhuma imagem escolhida' } = {}) {
  const { el } = ui;
  const caixa = el('div', { class: 'cms-midia__previa' });
  const semImagem = (mensagem, icone) => caixa.replaceChildren(el('span', { class: 'cms-midia__vazia' }, ui.icone(icone), mensagem));
  if (!src) {
    semImagem(vazio, 'imagem');
    return caixa;
  }
  const img = el('img', { src, alt: '', loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => semImagem('Não foi possível mostrar esta imagem', 'alerta'), { once: true });
  caixa.append(img);
  return caixa;
}

function editorImagem(ctx, campo, valor, aoMudar, { idRotulo }) {
  const { ui } = ctx;
  const { el } = ui;
  let atual = { src: texto(objeto(valor).src), alt: texto(objeto(valor).alt) };
  const previa = el('div', { class: 'cms-midia__caixa' });
  const arquivo = el('p', { class: 'cms-midia__arquivo mono truncar' });
  const erroGeral = el('p', { class: 'campo__erro', id: ui.novoId('cms-erro'), hidden: true });
  const dica = el('p', { class: 'cms-dica', hidden: true, 'aria-live': 'polite' });
  const alt = ui.campo({
    rotulo: 'Texto alternativo (descrição da imagem)', nome: 'alt', valor: atual.alt, obrigatorio: true,
    ajuda: 'Descreva em poucas palavras o que aparece na imagem. Ajuda quem usa leitor de tela e o Google. Ex.: "Mulheres da AMA numa oficina de biojoias".',
    attrs: { maxlength: '300', autocomplete: 'off' },
  });
  const trocar = ui.botao({
    texto: atual.src ? 'Trocar imagem' : 'Escolher imagem', icone: 'imagem', tipo: 'secundario',
    aoClicar: async () => {
      const url = await ctx.midia.seletorDeMidia({ tipo: 'imagem', pasta: 'site', titulo: `Imagem: ${campo.rotulo}`, atual: atual.src });
      if (!url || !ctx.ativo() || url === atual.src) return;
      atual = { ...atual, src: url };
      desenhar();
      erroGeral.hidden = true;
      dica.textContent = 'Imagem trocada. Confira se o texto alternativo combina com a imagem nova.';
      dica.hidden = false;
      aoMudar({ ...atual });
      if (!atual.alt.trim()) alt.entrada.focus();
      else trocar.focus();
    },
  });
  function desenhar() {
    previa.replaceChildren(previaDeImagem(ui, atual.src));
    arquivo.textContent = nomeDoArquivo(atual.src) || 'Nenhum arquivo';
    arquivo.title = atual.src;
    const rotulo = trocar.querySelector('.botao__texto');
    if (rotulo) rotulo.textContent = atual.src ? 'Trocar imagem' : 'Escolher imagem';
  }
  desenhar();
  alt.entrada.addEventListener('input', () => {
    atual = { ...atual, alt: alt.entrada.value };
    aoMudar({ ...atual });
  });
  const elemento = el('div', { class: 'cms-midia', role: 'group', 'aria-labelledby': idRotulo },
    previa,
    el('div', { class: 'cms-midia__lado' }, arquivo, el('div', { class: 'grupo-botoes' }, trocar), erroGeral, alt.elemento, dica));
  let parteComErro = null;
  return {
    elemento,
    mostrarErros(erros) {
      const e = erros && erros[0];
      parteComErro = e ? e.parte : null;
      alt.definirErro(e && e.parte === 'alt' ? e.mensagem : null);
      erroGeral.textContent = e && e.parte !== 'alt' ? e.mensagem : '';
      erroGeral.hidden = !(e && e.parte !== 'alt');
    },
    focarErro: () => (parteComErro === 'alt' ? alt.entrada.focus() : trocar.focus()),
    focar: () => trocar.focus(),
  };
}

/** Capa (primeira foto) de um produto, ou ''. */
export function capaDoProduto(produto) {
  const imagens = produto && Array.isArray(produto.imagens) ? produto.imagens : [];
  const primeira = imagens.find((img) => img && typeof img.src === 'string' && img.src.trim());
  return primeira ? primeira.src.trim() : '';
}

// Produtos para os seletores do Banner da Loja (uma consulta por página).
function produtosDoBanner(ctx, recursos) {
  if (!recursos.produtos) {
    recursos.produtos = ctx.api.consultar(ctx.supabase.from('produtos').select('id, nome, imagens, ativo').order('ordem').order('nome').limit(1000))
      .then((r) => (r.ok && Array.isArray(r.dados) ? r.dados : []));
  }
  return recursos.produtos;
}

// Banner da Loja: em vez de enviar fotos, escolhe um produto; a foto e o texto alternativo vêm dele.
function editorProduto(ctx, campo, valor, aoMudar, { idRotulo, recursos }) {
  const { ui } = ctx;
  const { el } = ui;
  let atual = { src: texto(objeto(valor).src), alt: texto(objeto(valor).alt) };
  let produtos = [];
  const foto = el('div', { class: 'cms-produto__foto' });
  const selecao = ui.campo({ rotulo: 'Produto', nome: 'produto', tipo: 'select', valor: '', opcoes: [{ valor: '', rotulo: 'Carregando os produtos…' }] });
  esconderRotulo(selecao);
  selecao.entrada.setAttribute('aria-labelledby', idRotulo);
  function desenhar() {
    foto.replaceChildren(atual.src ? el('img', { src: atual.src, alt: '', loading: 'lazy', decoding: 'async' }) : ui.icone('imagem'));
    const escolhido = produtos.find((p) => capaDoProduto(p) === atual.src);
    selecao.entrada.value = escolhido ? escolhido.id : '';
  }
  produtosDoBanner(ctx, recursos).then((lista) => {
    if (!ctx.ativo()) return;
    produtos = lista;
    const escolhido = produtos.some((p) => capaDoProduto(p) === atual.src);
    const opcoes = [
      { valor: '', rotulo: escolhido || !atual.src ? 'Escolha um produto' : 'Foto atual (escolha um produto para trocar)' },
      ...produtos.map((p) => ({
        valor: p.id, rotulo: `${p.nome}${p.ativo === false ? ' (fora da loja)' : ''}${capaDoProduto(p) ? '' : ' (sem foto)'}`, desativado: !capaDoProduto(p),
      })),
    ];
    selecao.entrada.replaceChildren(...opcoes.map((o) => el('option', { value: o.valor, disabled: o.desativado || null }, o.rotulo)));
    desenhar();
  });
  selecao.entrada.addEventListener('change', () => {
    const p = produtos.find((x) => x.id === selecao.entrada.value);
    if (!p || !capaDoProduto(p)) return;
    atual = { src: capaDoProduto(p), alt: p.nome };
    selecao.definirErro(null);
    desenhar();
    aoMudar({ ...atual });
  });
  desenhar();
  return {
    elemento: el('div', { class: 'cms-produto', role: 'group', 'aria-labelledby': idRotulo }, foto, el('div', { class: 'cms-produto__lado' }, selecao.elemento)),
    mostrarErros(erros) {
      const e = erros && erros[0];
      selecao.definirErro(e ? 'Escolha um produto com foto.' : null);
    },
    focarErro: () => selecao.entrada.focus(),
    focar: () => selecao.entrada.focus(),
  };
}

function editorVideo(ctx, campo, valor, aoMudar, { idRotulo }) {
  const { ui } = ctx;
  const { el } = ui;
  let atual = { src: texto(objeto(valor).src), poster: texto(objeto(valor).poster) };
  const previa = el('div', { class: 'cms-midia__caixa cms-midia__caixa--video' });
  const capa = el('div', { class: 'cms-video__capa' });
  const arquivo = el('p', { class: 'cms-midia__arquivo mono truncar' });
  const erroGeral = el('p', { class: 'campo__erro', id: ui.novoId('cms-erro'), hidden: true });
  const mudar = () => aoMudar({ ...atual });
  const trocar = ui.botao({
    texto: 'Trocar vídeo', icone: 'video', tipo: 'secundario',
    aoClicar: async () => {
      const url = await ctx.midia.seletorDeMidia({ tipo: 'video', pasta: 'videos', titulo: `Vídeo: ${campo.rotulo}`, atual: atual.src });
      if (!url || !ctx.ativo() || url === atual.src) return;
      atual = { ...atual, src: url };
      erroGeral.hidden = true;
      desenhar();
      mudar();
      trocar.focus();
    },
  });
  const trocarCapa = ui.botao({
    texto: 'Trocar capa', icone: 'imagem', tipo: 'secundario', tamanho: 'pequeno',
    aoClicar: async () => {
      const url = await ctx.midia.seletorDeMidia({ tipo: 'imagem', pasta: 'site', titulo: 'Capa do vídeo', atual: atual.poster });
      if (!url || !ctx.ativo()) return;
      atual = { ...atual, poster: url };
      desenhar();
      mudar();
      trocarCapa.focus();
    },
  });
  const tirarCapa = ui.botao({
    texto: 'Tirar capa', icone: 'lixeira', tipo: 'fantasma', tamanho: 'pequeno',
    aoClicar: () => {
      atual = { ...atual, poster: '' };
      desenhar();
      mudar();
      trocarCapa.focus();
    },
  });
  function desenhar() {
    const video = atual.src
      ? el('video', { src: atual.src, poster: atual.poster || null, controls: true, preload: 'metadata', muted: true, playsinline: true })
      : el('span', { class: 'cms-midia__vazia' }, ui.icone('video'), 'Nenhum vídeo escolhido');
    previa.replaceChildren(video);
    arquivo.textContent = nomeDoArquivo(atual.src) || 'Nenhum arquivo';
    arquivo.title = atual.src;
    capa.replaceChildren(previaDeImagem(ui, atual.poster, { vazio: 'Sem capa' }));
    tirarCapa.hidden = !atual.poster;
  }
  desenhar();
  const elemento = el('div', { class: 'cms-midia', role: 'group', 'aria-labelledby': idRotulo },
    previa,
    el('div', { class: 'cms-midia__lado' },
      arquivo,
      el('div', { class: 'grupo-botoes' }, trocar),
      erroGeral,
      el('div', { class: 'cms-video__linha-capa' },
        capa,
        el('div', { class: 'pilha pilha--estreita' },
          el('p', { class: 'campo__rotulo' }, 'Capa do vídeo'),
          el('p', { class: 'campo__ajuda' }, 'Imagem mostrada enquanto o vídeo carrega.'),
          el('div', { class: 'grupo-botoes' }, trocarCapa, tirarCapa)))));
  return {
    elemento,
    mostrarErros(erros) {
      const e = erros && erros[0];
      erroGeral.textContent = e ? e.mensagem : '';
      erroGeral.hidden = !e;
    },
    focarErro: () => (erroGeral.textContent.includes('capa') ? trocarCapa.focus() : trocar.focus()),
    focar: () => trocar.focus(),
  };
}

// O título do cartão (ou do subcampo) já diz o que é: o rótulo de dentro fica só para leitores de tela.
function esconderRotulo(campo) {
  const rotulo = campo.elemento.querySelector('.campo__rotulo');
  if (rotulo) rotulo.classList.add('sr-only');
}

// Campo de endereço com "completar" ao sair (https://, mailto:, tel:).
function campoEndereco(ctx, { rotulo, valor, ajuda, aoMudar }) {
  const { ui } = ctx;
  const { el } = ui;
  const campo = ui.campo({
    rotulo, nome: 'endereco', valor: texto(valor), placeholder: 'https://…', ajuda,
    attrs: { inputmode: 'url', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' },
  });
  const dica = el('p', { class: 'cms-dica', hidden: true, 'aria-live': 'polite' });
  campo.entrada.addEventListener('input', () => {
    dica.hidden = true;
    aoMudar(campo.entrada.value);
  });
  campo.entrada.addEventListener('change', () => {
    const digitado = campo.entrada.value.trim();
    const completo = normalizarEndereco(digitado);
    if (completo !== digitado) {
      campo.entrada.value = completo;
      dica.textContent = `Completamos o endereço: ${completo}`;
      dica.hidden = false;
      aoMudar(completo);
    }
    campo.definirErro(validarEndereco(completo));
  });
  campo.elemento.append(dica);
  return campo;
}

function editorLink(ctx, campo, valor, aoMudar, { idRotulo, padrao }) {
  const { ui } = ctx;
  const { el } = ui;
  let atual = { href: texto(objeto(valor).href), texto: texto(objeto(valor).texto) };
  const comTexto = textoEditavel(padrao) || Boolean(atual.texto.trim());
  const campoTexto = comTexto ? ui.campo({ rotulo: 'Texto que aparece', nome: 'texto', valor: atual.texto, attrs: { maxlength: '200', autocomplete: 'off' } }) : null;
  if (campoTexto) {
    campoTexto.entrada.addEventListener('input', () => {
      atual = { ...atual, texto: campoTexto.entrada.value };
      aoMudar({ ...atual });
    });
  }
  const endereco = campoEndereco(ctx, {
    rotulo: 'Endereço (para onde o link leva)', valor: atual.href,
    ajuda: 'Pode ser um site (https://…), um WhatsApp (https://wa.me/5591…), a loja (/loja/) ou uma parte desta página (#sobre).',
    aoMudar: (v) => {
      atual = { ...atual, href: v };
      aoMudar({ ...atual });
    },
  });
  const elemento = el('div', { class: 'formulario__linha cms-link', role: 'group', 'aria-labelledby': idRotulo },
    campoTexto && campoTexto.elemento, endereco.elemento);
  let parteComErro = null;
  return {
    elemento,
    mostrarErros(erros) {
      const e = erros && erros[0];
      parteComErro = e ? e.parte : null;
      endereco.definirErro(e && e.parte !== 'texto' ? e.mensagem : null);
      if (campoTexto) campoTexto.definirErro(e && e.parte === 'texto' ? e.mensagem : null);
    },
    focarErro: () => (parteComErro === 'texto' && campoTexto ? campoTexto.entrada.focus() : endereco.entrada.focus()),
    focar: () => (campoTexto || endereco).entrada.focus(),
  };
}

function editorUrl(ctx, campo, valor, aoMudar, { idRotulo }) {
  const endereco = campoEndereco(ctx, { rotulo: campo.rotulo || 'Endereço', valor, ajuda: 'Endereço completo (https://…) ou um caminho do site (/loja/).', aoMudar });
  esconderRotulo(endereco);
  return {
    elemento: ctx.ui.el('div', { role: 'group', 'aria-labelledby': idRotulo }, endereco.elemento),
    mostrarErros: (erros) => endereco.definirErro(erros && erros[0] ? erros[0].mensagem : null),
    focarErro: () => endereco.entrada.focus(),
    focar: () => endereco.entrada.focus(),
  };
}

function editorInstagram(ctx, campo, valor, aoMudar, { idRotulo }) {
  const { ui } = ctx;
  const { el } = ui;
  const endereco = ui.campo({
    rotulo: 'Endereço da publicação', nome: 'instagram', valor: texto(valor), placeholder: 'https://www.instagram.com/p/…',
    attrs: { inputmode: 'url', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' },
  });
  esconderRotulo(endereco);
  const estado = el('p', { class: 'cms-instagram__estado', 'aria-live': 'polite' });
  const previa = el('div', { class: 'cms-instagram__previa', hidden: true });
  const mostrar = ui.botao({
    texto: 'Mostrar prévia', tipo: 'secundario', tamanho: 'pequeno', icone: 'olho',
    aoClicar: () => {
      if (!previa.hidden) {
        previa.hidden = true;
        previa.replaceChildren();
        mostrar.querySelector('.botao__texto').textContent = 'Mostrar prévia';
        return;
      }
      const embed = instagramParaEmbed(endereco.entrada.value);
      if (!embed) return;
      previa.replaceChildren(el('iframe', {
        src: embed, title: 'Prévia da publicação do Instagram', loading: 'lazy', referrerpolicy: 'strict-origin-when-cross-origin',
        sandbox: 'allow-scripts allow-same-origin allow-popups',
      }));
      previa.hidden = false;
      mostrar.querySelector('.botao__texto').textContent = 'Esconder prévia';
    },
  });
  function atualizar() {
    const v = endereco.entrada.value.trim();
    const publicacao = embedParaInstagram(v);
    estado.hidden = false;
    estado.replaceChildren();
    if (publicacao) {
      estado.className = 'cms-instagram__estado cms-instagram__estado--ok';
      estado.append(ui.icone('sucesso'), 'Publicação reconhecida.');
    } else {
      estado.className = 'cms-instagram__estado';
      estado.append(ui.icone('info'), v ? 'Endereço ainda não reconhecido como publicação do Instagram.' : 'Cole aqui o endereço da publicação.');
    }
    mostrar.hidden = !publicacao;
    if (!publicacao && !previa.hidden) {
      previa.hidden = true;
      previa.replaceChildren();
      mostrar.querySelector('.botao__texto').textContent = 'Mostrar prévia';
    }
  }
  atualizar();
  endereco.entrada.addEventListener('input', () => {
    atualizar();
    aoMudar(endereco.entrada.value);
  });
  const elemento = el('div', { class: 'pilha pilha--estreita cms-instagram', role: 'group', 'aria-labelledby': idRotulo },
    endereco.elemento, estado, el('div', { class: 'linha' }, mostrar), previa);
  return {
    elemento,
    mostrarErros(erros) {
      const mensagem = erros && erros[0] ? erros[0].mensagem : null;
      endereco.definirErro(mensagem);
      // A mensagem de erro já explica; a linha de situação volta quando a pessoa digitar.
      estado.hidden = Boolean(mensagem);
    },
    focarErro: () => endereco.entrada.focus(),
    focar: () => endereco.entrada.focus(),
  };
}

function criarEditor(ctx, campo, valor, aoMudar, opcoes) {
  switch (campo.tipo) {
    case 'texto':
    case 'textolongo':
    case 'meta':
      return editorTexto(ctx, campo, valor, aoMudar, opcoes);
    case 'html':
      return editorRico(ctx, campo, valor, aoMudar, opcoes);
    case 'imagem':
      if (campo.editor === 'produto') return editorProduto(ctx, campo, valor, aoMudar, opcoes);
      return editorImagem(ctx, campo, valor, aoMudar, opcoes);
    case 'video':
      return editorVideo(ctx, campo, valor, aoMudar, opcoes);
    case 'link':
      return editorLink(ctx, campo, valor, aoMudar, opcoes);
    case 'url':
      return editorUrl(ctx, campo, valor, aoMudar, opcoes);
    case 'instagram':
      return editorInstagram(ctx, campo, valor, aoMudar, opcoes);
    case 'lista':
      return editorLista(ctx, campo, valor, aoMudar, opcoes);
    default:
      return editorTexto(ctx, { ...campo, tipo: 'texto' }, typeof valor === 'string' ? valor : '', aoMudar, opcoes);
  }
}

// Subcampo de um item de lista: rótulo, ajuda e editor.
function subcampo(ctx, sub, valor, aoMudar, recursos, padrao) {
  const { ui } = ctx;
  const { el } = ui;
  const idRotulo = ui.novoId('cms-sub');
  const idAjuda = sub.ajuda ? `${idRotulo}-ajuda` : null;
  const editor = criarEditor(ctx, sub, valor, aoMudar, { idRotulo, idAjuda, recursos, padrao });
  const rotulo = editor.idEntrada
    ? el('label', { class: 'campo__rotulo', id: idRotulo, for: editor.idEntrada }, sub.rotulo)
    : el('p', { class: 'campo__rotulo', id: idRotulo }, sub.rotulo);
  return {
    editor,
    elemento: el('div', { class: 'cms-subcampo' }, rotulo, sub.ajuda ? el('p', { class: 'campo__ajuda', id: idAjuda }, sub.ajuda) : null, editor.elemento),
  };
}

const LISTAS_SEM_ADICIONAR = new Set(['cabecalho.menu']);

function editorLista(ctx, campo, valor, aoMudar, { idRotulo, recursos }) {
  const { ui } = ctx;
  const { el } = ui;
  const itemRotulo = campo.itemRotulo || 'Item';
  const minusculo = itemRotulo.charAt(0).toLowerCase() + itemRotulo.slice(1);
  const subcampos = campo.campos || [];
  const molde = valoresDoMolde(campo);
  let sequencia = 0;
  const embrulhar = (valores) => ({ id: `item-${(sequencia += 1)}`, valores: clonarValor(valores) || {} });
  let itens = (Array.isArray(valor) ? valor : []).map(embrulhar);
  const abertos = new Set();
  const novos = new Set();
  let erros = new Map(); // id do item → [erro]

  const lista = el('ol', { class: 'lista-ordenavel cms-lista', 'aria-labelledby': idRotulo });
  const vazio = el('div', { class: 'cms-lista__vazia', hidden: true },
    ui.icone('caixa'), el('p', {}, `Nenhum ${minusculo} na lista. Do jeito que está, esta parte aparece vazia no site.`));
  const anuncio = el('p', { class: 'sr-only', 'aria-live': 'polite' });
  const erroGeral = el('p', { class: 'campo__erro', id: ui.novoId('cms-erro'), hidden: true });
  const adicionar = ui.botao({ texto: `Adicionar ${minusculo}`, icone: 'mais', tipo: 'secundario', aoClicar: () => adicionarNovo() });
  // Os itens do menu são fixos (as seções da página): dá para mudar, subir/descer e tirar, mas não criar novos.
  const podeAdicionar = !LISTAS_SEM_ADICIONAR.has(campo.chave);
  const elemento = el('div', { class: 'cms-lista-editor', role: 'group', 'aria-labelledby': idRotulo },
    lista, vazio, erroGeral, podeAdicionar ? el('div', { class: 'cms-lista__rodape' }, adicionar) : null, anuncio);

  const emitir = () => aoMudar(itens.map((i) => i.valores));
  const anunciar = (mensagem) => { anuncio.textContent = mensagem; };

  function focarNoItem(id, alvo) {
    const li = lista.querySelector(`[data-item="${id}"]`);
    if (!li) {
      adicionar.focus();
      return;
    }
    let foco = null;
    if (alvo === 'primeiro') foco = li.querySelector('.cms-item__corpo input, .cms-item__corpo textarea, .cms-item__corpo [contenteditable], .cms-item__corpo button');
    else if (alvo) foco = li.querySelector(`[data-acao="${alvo}"]:not([disabled])`) || li.querySelector('.lista-ordenavel__acoes button:not([disabled])');
    (foco || li.querySelector('.cms-item__alternar')).focus();
    if (alvo === 'primeiro') li.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function desenhar(foco) {
    lista.replaceChildren(...itens.map((item, i) => desenharItem(item, i)));
    vazio.hidden = itens.length > 0;
    adicionar.disabled = itens.length >= LIMITE_ITENS;
    if (foco) focarNoItem(foco.id, foco.alvo);
  }

  function desenharItem(item, i) {
    const aberto = abertos.has(item.id);
    const idCorpo = `${idRotulo}-${item.id}`;
    const nomeItem = `${itemRotulo} ${i + 1}`;
    const resumo = resumoDoItem(item.valores, subcampos, i, itemRotulo);
    const titulo = el('span', { class: 'lista-ordenavel__titulo' }, resumo.titulo);
    const detalhe = el('span', { class: 'lista-ordenavel__detalhe' }, resumo.detalhe);
    const miniatura = el('span', { class: 'lista-ordenavel__miniatura', hidden: !resumo.imagem },
      resumo.imagem ? el('img', { src: resumo.imagem, alt: '', loading: 'lazy' }) : null);
    const temErro = (erros.get(item.id) || []).length > 0;
    const alternar = el('button', {
      type: 'button', class: 'cms-item__alternar', 'aria-expanded': String(aberto), 'aria-controls': aberto ? idCorpo : null,
      'data-acao': 'alternar',
    },
    el('span', { class: 'cms-item__numero', 'aria-hidden': 'true' }, String(i + 1)),
    miniatura,
    el('span', { class: 'lista-ordenavel__conteudo' }, el('span', { class: 'sr-only' }, `${nomeItem}: `), titulo, detalhe,
      temErro ? el('span', { class: 'cms-item__aviso' }, ui.icone('alerta'), 'Tem um campo para corrigir') : null),
    ui.icone(aberto ? 'subir' : 'descer', { classe: 'cms-item__seta' }));
    alternar.addEventListener('click', () => {
      if (aberto) abertos.delete(item.id);
      else abertos.add(item.id);
      desenhar({ id: item.id, alvo: aberto ? null : 'primeiro' });
    });
    // Ícone com a palavra: mais claro para quem não conhece os ícones (no celular, a palavra fica embaixo).
    const acao = (icone, rotulo, alvo, desativado, fn) => ui.botao({
      texto: rotulo, tipo: 'fantasma', tamanho: 'pequeno', icone, rotulo: `${rotulo} ${nomeItem}`, classe: 'cms-item__acao',
      attrs: { disabled: desativado, 'data-acao': alvo }, aoClicar: fn,
    });
    const acoes = el('div', { class: 'lista-ordenavel__acoes' },
      acao('subir', 'Subir', 'subir', i === 0, () => mover(i, i - 1, 'subir')),
      acao('descer', 'Descer', 'descer', i === itens.length - 1, () => mover(i, i + 1, 'descer')),
      acao('lixeira', 'Remover', 'remover', false, () => remover(i)));
    const li = el('li', {
      class: ['lista-ordenavel__item', 'cms-item', aberto && 'lista-ordenavel__item--aberto', temErro && 'cms-item--erro'],
      'data-item': item.id,
    }, alternar, acoes);
    if (aberto) li.append(corpoDoItem(item, i, idCorpo, { titulo, detalhe, miniatura }));
    return li;
  }

  function corpoDoItem(item, i, idCorpo, resumoEl) {
    const corpo = el('div', { class: 'cms-item__corpo', id: idCorpo, role: 'group', 'aria-label': `${itemRotulo} ${i + 1}` });
    if (novos.has(item.id)) {
      corpo.append(ui.aviso(`${itemRotulo} novo: ele começa igual ao primeiro da lista. Troque os textos e as imagens.`, 'info'));
    }
    const errosItem = erros.get(item.id) || [];
    const atualizarResumo = () => {
      const r = resumoDoItem(item.valores, subcampos, itens.indexOf(item), itemRotulo);
      resumoEl.titulo.textContent = r.titulo;
      resumoEl.detalhe.textContent = r.detalhe;
      const img = resumoEl.miniatura.querySelector('img');
      if (r.imagem && (!img || img.getAttribute('src') !== r.imagem)) resumoEl.miniatura.replaceChildren(el('img', { src: r.imagem, alt: '' }));
      resumoEl.miniatura.hidden = !r.imagem;
    };
    for (const sub of subcampos) {
      const s = subcampo(ctx, sub, item.valores[sub.campo], (v) => {
        item.valores[sub.campo] = v;
        if (erros.has(item.id)) erros.set(item.id, erros.get(item.id).filter((e) => e.campo !== sub.campo));
        atualizarResumo();
        emitir();
      }, recursos, molde[sub.campo]);
      const doCampo = errosItem.filter((e) => e.campo === sub.campo);
      if (doCampo.length) s.editor.mostrarErros(doCampo);
      s.elemento.dataset.campo = sub.campo;
      corpo.append(s.elemento);
      item.editores = item.editores || new Map();
      item.editores.set(sub.campo, s.editor);
    }
    corpo.append(el('div', { class: 'cms-item__fim' },
      ui.botao({
        texto: `Fechar ${minusculo}`, tipo: 'secundario', tamanho: 'pequeno', icone: 'subir',
        aoClicar: () => {
          abertos.delete(item.id);
          desenhar({ id: item.id, alvo: null });
        },
      })));
    return corpo;
  }

  function mover(de, para, alvo) {
    if (para < 0 || para >= itens.length) return;
    itens = moverItem(itens, de, para);
    emitir();
    desenhar({ id: itens[para].id, alvo });
    anunciar(`${itemRotulo} movido para a posição ${para + 1} de ${itens.length}.`);
  }

  async function remover(i) {
    const item = itens[i];
    const resumo = resumoDoItem(item.valores, subcampos, i, itemRotulo);
    const sim = await ui.confirmar(
      `Remover "${resumo.titulo}" da lista? Ele sai do site quando você salvar.`,
      { perigo: true, titulo: `Remover ${minusculo}?`, textoConfirmar: 'Remover' },
    );
    if (!sim || !ctx.ativo() || !elemento.isConnected) return;
    const indice = itens.indexOf(item);
    if (indice < 0) return;
    itens = removerItem(itens, indice);
    abertos.delete(item.id);
    novos.delete(item.id);
    erros.delete(item.id);
    emitir();
    const proximo = itens[Math.min(indice, itens.length - 1)];
    desenhar(proximo ? { id: proximo.id, alvo: 'remover' } : null);
    if (!proximo) adicionar.focus();
    anunciar(`${itemRotulo} removido. A lista tem ${itens.length} ${itens.length === 1 ? 'item' : 'itens'}.`);
  }

  function adicionarNovo() {
    if (itens.length >= LIMITE_ITENS) return;
    const novo = embrulhar(molde);
    itens = [...itens, novo];
    abertos.add(novo.id);
    novos.add(novo.id);
    emitir();
    desenhar({ id: novo.id, alvo: 'primeiro' });
    anunciar(`${itemRotulo} ${itens.length} adicionado no fim da lista.`);
  }

  desenhar();
  return {
    elemento,
    mostrarErros(lista) {
      erros = new Map();
      const gerais = [];
      for (const e of lista || []) {
        if (e.indice === null || e.indice === undefined || !itens[e.indice]) {
          gerais.push(e);
          continue;
        }
        const id = itens[e.indice].id;
        if (!erros.has(id)) erros.set(id, []);
        erros.get(id).push(e);
        abertos.add(id);
      }
      erroGeral.textContent = gerais.length ? gerais[0].mensagem : '';
      erroGeral.hidden = !gerais.length;
      desenhar();
    },
    focarErro() {
      for (const item of itens) {
        const doItem = erros.get(item.id);
        if (!doItem || !doItem.length) continue;
        const editor = item.editores && item.editores.get(doItem[0].campo);
        const li = lista.querySelector(`[data-item="${item.id}"]`);
        if (li) li.scrollIntoView({ block: 'center' });
        if (editor) editor.focarErro();
        return;
      }
      adicionar.focus();
    },
    focar: () => (lista.querySelector('.cms-item__alternar') || adicionar).focus(),
  };
}

// ---------------------------------------------------------------------------
// #/conteudo/<grupo> — formulário do grupo

function montarGrupo(ctx, dados, { cabecalho, corpo, recursos, grupoId }) {
  const { ui, api, supabase } = ctx;
  const { el } = ui;
  const grupo = dados.esquema.grupos.find((g) => g.id === grupoId);
  if (!grupo) {
    ui.estadoVazio(corpo, 'Esta parte da página não foi encontrada. Ela pode ter saído do site numa atualização.', {
      titulo: 'Parte não encontrada', icone: 'busca', acao: { texto: 'Ver todas as partes', href: '#/conteudo', icone: 'voltar' },
    });
    return;
  }
  ctx.definirTitulo(`${grupo.rotulo} · Conteúdo do site`);
  const ancora = ancoraDoGrupo(dados.documento, grupo.id);
  const enderecoSite = ancora ? `/#${ancora}` : '/';
  const salvos = dados.salvos;
  const campoVisivel = grupo.ocultavel
    ? { chave: chaveVisibilidade(grupo.id), tipo: 'visivel', padrao: true, rotulo: 'Mostrar esta seção no site' }
    : null;
  const campos = [...(campoVisivel ? [campoVisivel] : []), ...grupo.campos];
  const porChave = new Map(campos.map((c) => [c.chave, c]));
  const rascunho = new Map(campos.map((c) => [c.chave, clonarValor(valorEfetivo(c, salvos.get(c.chave)))]));
  const controles = new Map();
  let acabouDeSalvar = false;

  cabecalho.replaceWith(ui.cabecalhoPagina({
    titulo: grupo.rotulo,
    descricao: 'Mude os textos, fotos e links desta parte da página inicial. Nada muda no site antes de você salvar.',
    voltar: { href: '#/conteudo', texto: 'Conteúdo do site' },
    acoes: [ui.botao({ texto: 'Ver no site', iconeDireita: 'externo', href: enderecoSite, classe: 'cms-ver-site', attrs: { target: '_blank', rel: 'noopener' } })],
  }));

  const aoMudar = (chave, valor) => {
    rascunho.set(chave, valor);
    acabouDeSalvar = false;
    ctx.marcarAlterado(true);
    atualizarDepois();
  };

  // --- cartões dos campos
  function desenharEditor(controle) {
    const { campo } = controle;
    controle.editor = criarEditor(ctx, campo, rascunho.get(campo.chave), (v) => aoMudar(campo.chave, v), {
      idRotulo: controle.idRotulo, idAjuda: controle.idAjuda, recursos, padrao: campo.padrao,
    });
    controle.conteudo.replaceChildren(controle.editor.elemento);
  }

  function cartaoDoCampo(campo) {
    const idRotulo = ui.novoId('cms-campo');
    const idAjuda = campo.ajuda ? `${idRotulo}-ajuda` : null;
    const seloSalvo = el('span', { class: 'selo selo--ouro', hidden: true, title: 'O site mostra a versão salva pelo painel, diferente da original.' }, 'Editado');
    const seloPendente = el('span', { class: 'selo selo--ambar', hidden: true }, 'Não salvo');
    const restaurar = ui.botao({ texto: 'Restaurar padrão', tipo: 'fantasma', tamanho: 'pequeno', icone: 'atualizar', classe: 'cms-campo__restaurar', aoClicar: () => restaurarCampo(campo) });
    restaurar.hidden = true;
    const conteudo = el('div', { class: 'cartao__corpo' });
    const cartao = el('section', { class: ['cartao', 'cms-campo', `cms-campo--${campo.tipo}`], 'aria-labelledby': idRotulo, 'data-chave': campo.chave },
      el('div', { class: 'cartao__cabecalho' },
        el('h2', { class: 'cartao__titulo', id: idRotulo }, campo.rotulo),
        el('div', { class: 'cms-campo__estado' }, seloSalvo, seloPendente, restaurar),
        campo.ajuda ? el('p', { class: 'cartao__subtitulo', id: idAjuda }, campo.ajuda) : null),
      conteudo);
    const controle = { campo, cartao, conteudo, seloSalvo, seloPendente, restaurar, idRotulo, idAjuda, editor: null };
    desenharEditor(controle);
    return controle;
  }

  function cartaoVisibilidade(campo) {
    const interruptor = ui.campo({
      tipo: 'interruptor', nome: 'visivel', rotulo: campo.rotulo, valor: rascunho.get(campo.chave) !== false,
    });
    interruptor.entrada.addEventListener('change', () => aoMudar(campo.chave, interruptor.ler()));
    const seloPendente = el('span', { class: 'selo selo--ambar', hidden: true }, 'Não salvo');
    const cartao = el('section', { class: 'cartao cms-campo cms-visibilidade', 'aria-label': 'Visibilidade da seção', 'data-chave': campo.chave },
      el('div', { class: 'cartao__corpo' }, el('div', { class: 'cms-visibilidade__linha' }, interruptor.elemento, seloPendente)));
    const editor = { mostrarErros() {}, focarErro: () => interruptor.entrada.focus(), focar: () => interruptor.entrada.focus() };
    return { campo, cartao, seloSalvo: null, seloPendente, restaurar: null, editor, interruptor };
  }

  for (const campo of campos) controles.set(campo.chave, campo.tipo === 'visivel' ? cartaoVisibilidade(campo) : cartaoDoCampo(campo));

  // --- barra de ações
  const info = el('p', { class: 'barra-acoes__info cms-barra__info', 'aria-live': 'polite' });
  const previa = ui.botao({ texto: 'Pré-visualizar', tipo: 'secundario', icone: 'olho', classe: 'cms-previsualizar', aoClicar: () => previsualizar() });
  const salvarBotao = ui.botao({ texto: 'Salvar', tipo: 'primario', icone: 'check', classe: 'cms-salvar', aoClicar: () => salvar() });
  const form = el('form', { class: 'pilha cms-formulario', novalidate: true, 'aria-label': `Conteúdo: ${grupo.rotulo}` },
    grupo.campos.length ? null : ui.aviso('Esta parte não tem textos para editar: aqui você só escolhe se ela aparece no site.', 'info'),
    Array.from(controles.values(), (c) => c.cartao),
    el('div', { class: 'barra-acoes cms-barra' }, info, previa, salvarBotao));
  form.addEventListener('submit', (evento) => evento.preventDefault());
  corpo.replaceChildren(form);

  // --- estado (selos, aviso de alterações, texto da barra)
  function atualizarEstado() {
    const alteracoes = montarAlteracoes({ campos, rascunho, salvos, documento: document });
    const alteradas = new Set([...alteracoes.salvar.map((s) => s.chave), ...alteracoes.apagar]);
    for (const c of controles.values()) {
      const chave = c.campo.chave;
      if (c.seloSalvo) c.seloSalvo.hidden = !salvos.has(chave);
      c.seloPendente.hidden = !alteradas.has(chave);
      if (c.restaurar) c.restaurar.hidden = !(salvos.has(chave) || !valoresIguais(c.campo, rascunho.get(chave), c.campo.padrao, document));
    }
    ctx.marcarAlterado(alteradas.size > 0);
    if (alteradas.size) {
      info.textContent = alteradas.size === 1 ? '1 campo mudou e ainda não foi salvo.' : `${alteradas.size} campos mudaram e ainda não foram salvos.`;
    } else if (acabouDeSalvar) {
      info.replaceChildren('Salvo. ',
        el('a', { href: enderecoSite, target: '_blank', rel: 'noopener', class: 'cms-barra__link' }, 'Ver no site'));
    } else {
      info.textContent = '';
    }
    return alteracoes;
  }
  const atualizarDepois = ui.debounce(atualizarEstado, 150);
  recursos.limpezas.add(() => atualizarDepois.cancelar());
  atualizarEstado();

  // --- salvar
  async function salvar() {
    atualizarDepois.cancelar();
    const alteracoes = atualizarEstado();
    for (const c of controles.values()) c.editor.mostrarErros([]);
    if (!alteracoes.total) {
      ui.toast('Nada para salvar: nada mudou desde a última vez.', 'info');
      return;
    }
    const comErro = [];
    for (const { chave, valor } of alteracoes.salvar) {
      const erros = validarValor(porChave.get(chave), valor);
      if (!erros.length) continue;
      controles.get(chave).editor.mostrarErros(erros);
      comErro.push(chave);
    }
    if (comErro.length) {
      const primeiro = controles.get(comErro[0]);
      primeiro.cartao.scrollIntoView({ block: 'center' });
      primeiro.editor.focarErro();
      ui.toast(comErro.length === 1 ? 'Confira o campo marcado em vermelho antes de salvar.' : `Confira os ${comErro.length} campos marcados em vermelho antes de salvar.`, 'erro');
      return;
    }
    await ui.ocupado(salvarBotao, async () => {
      if (alteracoes.salvar.length) {
        const r = await api.consultar(supabase.from('conteudo_site').upsert(alteracoes.salvar, { onConflict: 'chave' }).select('chave, valor, atualizado_em'));
        if (!ctx.ativo()) return;
        if (!r.ok) {
          ui.toast(r.erro === 'sem_permissao' ? 'Você não tem permissão para mudar o site. Entre com uma conta de administradora.' : r.mensagem, 'erro');
          return;
        }
        for (const linha of r.dados || []) salvos.set(linha.chave, { valor: linha.valor, atualizado_em: linha.atualizado_em });
      }
      if (alteracoes.apagar.length) {
        const r = await api.consultar(supabase.from('conteudo_site').delete().in('chave', alteracoes.apagar));
        if (!ctx.ativo()) return;
        if (!r.ok) {
          ui.toast(r.mensagem, 'erro');
          atualizarEstado();
          return;
        }
        for (const chave of alteracoes.apagar) salvos.delete(chave);
      }
      acabouDeSalvar = true;
      const restante = atualizarEstado();
      if (!restante.total) ui.toast('Salvo!', 'sucesso');
    });
  }

  // --- restaurar padrão de um campo
  async function restaurarCampo(campo) {
    const controle = controles.get(campo.chave);
    const temLinha = salvos.has(campo.chave);
    const mudouAgora = !valoresIguais(campo, rascunho.get(campo.chave), valorEfetivo(campo, salvos.get(campo.chave)), document);
    const mensagem = temLinha
      ? `Voltar "${campo.rotulo}" ao conteúdo original do site? A versão salva pelo painel será apagada${mudouAgora ? ', junto com o que você mudou agora' : ''}.`
      : `Desfazer o que você mudou em "${campo.rotulo}" e voltar ao conteúdo original?`;
    const sim = await ui.confirmar(mensagem, { perigo: true, titulo: 'Restaurar padrão?', textoConfirmar: 'Restaurar padrão' });
    if (!sim || !ctx.ativo()) return;
    if (temLinha) {
      const r = await ui.ocupado(controle.restaurar, () => api.consultar(supabase.from('conteudo_site').delete().eq('chave', campo.chave)));
      if (!ctx.ativo()) return;
      if (!r || !r.ok) {
        ui.toast(r ? r.mensagem : 'Não foi possível restaurar agora. Tente de novo.', 'erro');
        return;
      }
      salvos.delete(campo.chave);
    }
    rascunho.set(campo.chave, clonarValor(campo.padrao));
    desenharEditor(controle);
    acabouDeSalvar = temLinha;
    atualizarEstado();
    controle.editor.focar();
    ui.toast(temLinha ? 'Padrão restaurado.' : 'Mudanças desfeitas.', 'sucesso');
  }

  // --- pré-visualizar (template + tudo o que está salvo + o rascunho deste grupo)
  function previsualizar() {
    const conteudo = {};
    for (const [chave, linha] of salvos) conteudo[chave] = linha.valor;
    for (const campo of campos) conteudo[campo.chave] = normalizarValor(campo, rascunho.get(campo.chave), document);
    const pendente = montarAlteracoes({ campos, rascunho, salvos, documento: document }).total > 0;
    let html;
    try {
      html = htmlDaPrevia(dados.template, conteudo, {
        analisar: (t) => new DOMParser().parseFromString(t, 'text/html'),
        origem: window.location.origin,
        aviso: pendente ? 'Pré-visualização: as mudanças ainda não foram salvas' : 'Pré-visualização',
      });
    } catch (erro) {
      console.error('[conteudo] falha ao montar a pré-visualização:', erro);
      ui.toast('Não foi possível montar a pré-visualização. Tente de novo.', 'erro');
      return;
    }
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    recursos.urls.add(url);
    const janela = window.open(ancora ? `${url}#${ancora}` : url, '_blank');
    if (!janela) {
      ui.toast('O navegador bloqueou a nova aba. Permita janelas pop-up para este site e tente de novo.', 'aviso');
      return;
    }
    try { janela.opener = null; } catch { /* outra origem */ }
  }
}
