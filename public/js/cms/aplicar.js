/**
 * Motor do CMS da AMA (docs/ARQUITETURA.md §5).
 *
 * Módulo ES sem dependências: roda no navegador (painel, pré-visualização) e no
 * servidor com o linkedom (api/render.js). Lê o esquema de campos a partir dos
 * atributos data-cms-* do template, lê os valores padrão e aplica o conteúdo
 * salvo em `conteudo_site`. Valor ausente, nulo ou malformado nunca quebra a
 * página: o padrão do template é mantido.
 *
 * Decisões que vão além do contrato (todas compatíveis com ele):
 * - Aplicar um valor igual ao que o elemento já mostra não mexe no elemento.
 *   Assim, aplicar os padrões lidos do próprio template não altera o HTML.
 * - Listas: se os itens resultantes têm os mesmos valores, na mesma ordem, que os itens
 *   atuais, a lista fica como está. Senão, todos os itens saem e entram clones do molde.
 * - O molde de cada lista fica guardado (WeakMap) no primeiro uso: aplicar de novo
 *   no mesmo documento usa o molde original, mesmo depois de `[]`; o esquema também o usa.
 * - Itens de lista que não são objetos são ignorados; se nenhum serve, mantém o padrão.
 *   No máximo 200 itens.
 * - imagem/video/link com URL insegura: o valor inteiro é ignorado (mantém o padrão).
 * - `video` com <source> filhos (e sem src no <video>): troca o src do primeiro <source>
 *   e remove os demais. `poster: ""` remove a capa.
 * - `link` sem [data-cms-link-texto] e com filhos elemento: o texto não é campo
 *   (lê "" e não é trocado), como no contrato.
 * - `data-cms-fixo` também é respeitado em `texto` e `textolongo`.
 * - Texto nunca é escrito em <script>, <style>, <iframe> etc.; em <title>/<textarea>
 *   (que o linkedom serializa sem escape) o "<" é removido.
 * - `sanitizarHtml` devolve um HTML canônico, igual no navegador e no linkedom. Além das
 *   tags do contrato, remove com o conteúdo as que não têm texto visível ou são texto cru
 *   (frame, noembed, xmp, plaintext, head, img, input, source...).
 * - Chaves, ids de grupo e tipos valem só exatamente como no contrato (sem trim nem
 *   conversão para minúsculas); fora do padrão, o elemento é ignorado.
 * - Grupo ocultável sem campos aparece no esquema (com `campos: []`) para o painel
 *   poder ocultá-lo.
 * - Sem `data-cms-tipo`, o tipo é deduzido da tag (meta, img, video, a, iframe; senão texto).
 */

export const TIPOS_CAMPO = Object.freeze([
  'texto', 'textolongo', 'html', 'imagem', 'video', 'link', 'url', 'instagram', 'meta', 'lista'
]);

const RE_CHAVE = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const RE_GRUPO = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const RE_CAMPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const RE_VISIBILIDADE = /^grupo\.[a-z0-9][a-z0-9_-]*\.visivel$/;
const LIMITE_ITENS = 200;
const PROFUNDIDADE_MAXIMA = 100;
const TAMANHO_MAXIMO_URL = 4096;

const ESQUEMAS_PERMITIDOS = new Set(['http', 'https', 'mailto', 'tel']);

const TAGS_PERMITIDAS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'h3', 'h4', 'span'
]);
// Removidas junto com o conteúdo: as do contrato e as que não têm texto visível ou guardam
// texto cru. As demais (title, textarea, select, video, canvas...) são desembrulhadas.
const TAGS_REMOVIDAS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript',
  'frame', 'frameset', 'noframes', 'noembed', 'applet', 'xmp', 'plaintext',
  'head', 'link', 'meta', 'base', 'img', 'input', 'source', 'track', 'param'
]);
// O linkedom serializa o texto destas sem escape: aceitam texto, mas sem "<".
const TEXTO_SEM_ESCAPE = new Set(['title', 'textarea']);
// Nunca recebem texto nem HTML vindos do painel.
const CONTEUDO_PROIBIDO = new Set([
  'script', 'style', 'template', 'iframe', 'object', 'embed', 'svg', 'math', 'noscript',
  'xmp', 'noembed', 'noframes', 'plaintext'
]);
const BLOCOS = new Set([
  'p', 'div', 'li', 'ul', 'ol', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'section', 'article', 'header', 'footer', 'figure', 'figcaption', 'pre', 'table', 'tr'
]);
const IGNORAR_NA_LEITURA = new Set(['script', 'style', 'template', 'noscript']);
const ATRIBUTO_URL = new Map([
  ['a', 'href'], ['area', 'href'], ['link', 'href'],
  ['img', 'src'], ['iframe', 'src'], ['video', 'src'], ['audio', 'src'],
  ['source', 'src'], ['track', 'src'], ['embed', 'src']
]);
const TIPOS_INSTAGRAM = new Map([['p', 'p'], ['reel', 'reel'], ['reels', 'reel'], ['tv', 'tv']]);
const SEM_VISIBILIDADE = new Set(['html', 'head', 'body']);

// Palavras sem acento nas chaves → forma usada no rótulo derivado.
const PALAVRAS = new Map(Object.entries({
  titulo: 'título', subtitulo: 'subtítulo', descricao: 'descrição', video: 'vídeo', videos: 'vídeos',
  botao: 'botão', botoes: 'botões', conteudo: 'conteúdo', historia: 'história', endereco: 'endereço',
  rodape: 'rodapé', cabecalho: 'cabeçalho', pagina: 'página', numero: 'número', secao: 'seção',
  paragrafo: 'parágrafo', paragrafos: 'parágrafos', citacao: 'citação', publicacao: 'publicação',
  publicacoes: 'publicações', informacao: 'informação', informacoes: 'informações', icone: 'ícone',
  area: 'área', missao: 'missão', visao: 'visão', acao: 'ação', acoes: 'ações', midia: 'mídia',
  colaboracoes: 'colaborações', apresentacao: 'apresentação', versiculo: 'versículo',
  referencia: 'referência', secundario: 'secundário', ultimas: 'últimas', ultimos: 'últimos',
  rotulo: 'rótulo', instituicao: 'instituição', localizacao: 'localização', direitos: 'direitos',
  saudacao: 'saudação', mensagem: 'mensagem', galeria: 'galeria', fundadora: 'fundadora',
  seo: 'SEO', og: 'OG', url: 'URL', ama: 'AMA', whatsapp: 'WhatsApp', instagram: 'Instagram',
  email: 'e-mail', cta: 'chamada'
}));

// ---------------------------------------------------------------------------
// Utilitários de DOM (só APIs presentes no navegador e no linkedom)

const temProp = (obj, chave) => obj != null && Object.prototype.hasOwnProperty.call(obj, chave);

function objetoSimples(valor) {
  return valor !== null && typeof valor === 'object' && !Array.isArray(valor) &&
    Object.prototype.toString.call(valor) === '[object Object]';
}

function ehElemento(no) {
  return !!no && no.nodeType === 1;
}

function nomeTag(el) {
  return String((el && (el.localName || el.tagName)) || '').toLowerCase();
}

function temAtributo(el, nome) {
  if (!ehElemento(el)) return false;
  if (typeof el.hasAttribute === 'function') return el.hasAttribute(nome);
  return el.getAttribute(nome) != null;
}

function atributo(el, nome) {
  if (!ehElemento(el)) return '';
  const valor = el.getAttribute(nome);
  return valor == null ? '' : String(valor);
}

function paiElemento(no) {
  const pai = no && no.parentNode;
  return ehElemento(pai) ? pai : null;
}

function filhos(no) {
  return no && no.childNodes ? Array.from(no.childNodes) : [];
}

function contem(ancestral, no) {
  for (let atual = no; atual; atual = atual.parentNode) if (atual === ancestral) return true;
  return false;
}

function documentoDe(no) {
  if (!no) return null;
  if (no.nodeType === 9) return no;
  return no.ownerDocument || null;
}

// Aceita Document, Element, DocumentFragment ou algo com `.document` (resultado do parseHTML).
function raizDe(entrada) {
  if (entrada && typeof entrada.querySelectorAll === 'function') return entrada;
  if (entrada && entrada.document && typeof entrada.document.querySelectorAll === 'function') return entrada.document;
  return null;
}

function obterDocumento(entrada) {
  const raiz = raizDe(entrada);
  const doc = raiz ? documentoDe(raiz) : null;
  if (doc && typeof doc.createElement === 'function') return doc;
  const global = typeof globalThis !== 'undefined' ? globalThis.document : undefined;
  return global && typeof global.createElement === 'function' ? global : null;
}

// querySelectorAll incluindo a própria raiz (quando ela é um elemento que casa).
function selecionar(raiz, seletor, atributos) {
  const lista = Array.from(raiz.querySelectorAll(seletor));
  if (ehElemento(raiz) && atributos.some((nome) => temAtributo(raiz, nome))) lista.unshift(raiz);
  return lista;
}

// Analisa HTML num <template> (inerte no navegador: nada carrega nem executa).
function analisarHtml(html, doc) {
  const modelo = doc.createElement('template');
  modelo.innerHTML = html;
  return modelo.content && modelo.content.childNodes ? modelo.content : modelo;
}

function colapsar(texto) {
  return String(texto).replace(/[ \t\n\r\f]+/g, ' ').replace(/^ | $/g, '');
}

// Escape igual ao da serialização dos navegadores (e "<" ">" também em atributos).
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\u00a0': '&nbsp;' };
const escaparTexto = (texto) => String(texto).replace(/[&<>\u00a0]/g, (c) => ESCAPES[c]);
const escaparAtributo = (texto) => String(texto).replace(/[&<>"\u00a0]/g, (c) => ESCAPES[c]);

function iguais(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => iguais(x, b[i]));
  }
  if (objetoSimples(a) && objetoSimples(b)) {
    const chavesA = Object.keys(a);
    return chavesA.length === Object.keys(b).length && chavesA.every((k) => temProp(b, k) && iguais(a[k], b[k]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// URLs e Instagram

/**
 * Devolve a URL limpa se for segura para href/src, senão null.
 * Aceita relativas (/x, ./x, x/y.jpg, #ancora, ?q), http:, https:, mailto:, tel:.
 * Rejeita outros esquemas, URLs protocolo-relativas (//host) e "&" antes de ? ou #
 * (o linkedom não escapa "&" em atributos: "javascript&colon;" viraria "javascript:").
 */
export function urlSegura(url) {
  if (typeof url !== 'string') return null;
  // Como o analisador de URL: tab/quebra de linha somem em qualquer posição; controles e espaços nas pontas também.
  let s = url.replace(/[\t\n\r]/g, '');
  s = s.replace(/^[\s\u0000-\u001f\u007f]+|[\s\u0000-\u001f\u007f]+$/g, '');
  if (!s || s.length > TAMANHO_MAXIMO_URL) return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  if (/^[\\/]{2}/.test(s) || s.charAt(0) === '\\') return null;

  const fimCaminho = s.search(/[?#]/);
  const caminho = fimCaminho === -1 ? s : s.slice(0, fimCaminho);
  if (caminho.includes('&')) return null;

  const fimEsquema = s.search(/[/?#]/);
  const antes = fimEsquema === -1 ? s : s.slice(0, fimEsquema);
  const doisPontos = antes.indexOf(':');
  if (doisPontos !== -1) {
    const esquema = antes.slice(0, doisPontos).toLowerCase();
    if (!/^[a-z][a-z0-9+.-]*$/.test(esquema) || !ESQUEMAS_PERMITIDOS.has(esquema)) return null;
  }
  return s;
}

function analisarInstagram(url) {
  if (typeof url !== 'string') return null;
  let s = url.trim();
  if (!s || s.length > TAMANHO_MAXIMO_URL) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  let endereco;
  try {
    endereco = new URL(s);
  } catch {
    return null;
  }
  if (endereco.protocol !== 'https:' && endereco.protocol !== 'http:') return null;
  if (endereco.username || endereco.password || endereco.port) return null;
  if (!/^(?:www\.|m\.)?instagram\.com$/.test(endereco.hostname)) return null;

  const partes = endereco.pathname.split('/').filter(Boolean);
  let i = 0;
  // Links de compartilhamento novos: /<usuario>/p/<codigo>/
  if (partes.length > 2 && !TIPOS_INSTAGRAM.has(partes[0].toLowerCase()) && /^[A-Za-z0-9._]{1,30}$/.test(partes[0])) i = 1;
  const tipo = TIPOS_INSTAGRAM.get(String(partes[i] || '').toLowerCase());
  const codigo = String(partes[i + 1] || '');
  if (!tipo || !/^[A-Za-z0-9_-]{3,64}$/.test(codigo)) return null;
  return { tipo, codigo };
}

/** URL de publicação do Instagram → URL do iframe de incorporação (ou null). */
export function instagramParaEmbed(url) {
  const info = analisarInstagram(url);
  return info ? `https://www.instagram.com/${info.tipo}/${info.codigo}/embed/captioned/` : null;
}

/** src de um iframe do Instagram (ou qualquer URL de publicação) → URL da publicação (ou null). */
export function embedParaInstagram(src) {
  const info = analisarInstagram(src);
  return info ? `https://www.instagram.com/${info.tipo}/${info.codigo}/` : null;
}

// ---------------------------------------------------------------------------
// Sanitização de HTML (baseada em DOM, por lista de permissões)

function atributosDoLink(a) {
  let atributos = '';
  const href = urlSegura(a.getAttribute('href'));
  if (href) atributos += ` href="${escaparAtributo(href)}"`;
  if (String(a.getAttribute('target') || '').trim().toLowerCase() === '_blank') {
    atributos += ' target="_blank" rel="noopener noreferrer"';
  }
  return atributos;
}

// Analisa o HTML num <template> e reescreve como texto só o que é permitido.
// Gerar a string (em vez de nós) deixa a saída igual no navegador e no linkedom.
function limparHtml(html, doc) {
  if (typeof html !== 'string' || !html) return '';
  const saida = [];
  const pilha = [];
  const empilhar = (no, profundidade) => {
    const lista = filhos(no);
    for (let i = lista.length - 1; i >= 0; i--) pilha.push({ no: lista[i], profundidade });
  };
  empilhar(analisarHtml(html, doc), 0);

  while (pilha.length) {
    const { no, profundidade, fechar } = pilha.pop();
    if (fechar) {
      saida.push(`</${fechar}>`);
      continue;
    }
    if (no.nodeType === 3) {
      saida.push(escaparTexto(no.data ?? no.nodeValue ?? ''));
      continue;
    }
    if (no.nodeType !== 1) continue; // comentários e afins
    const tag = nomeTag(no);
    if (TAGS_REMOVIDAS.has(tag)) continue;
    if (!TAGS_PERMITIDAS.has(tag) || profundidade >= PROFUNDIDADE_MAXIMA) {
      empilhar(no, profundidade); // desembrulha: fica só o conteúdo
      continue;
    }
    saida.push(`<${tag}${tag === 'a' ? atributosDoLink(no) : ''}>`);
    if (tag === 'br') continue;
    pilha.push({ fechar: tag });
    empilhar(no, profundidade + 1);
  }
  return saida.join('');
}

/**
 * Limpa HTML vindo do painel. Permite p, br, strong, b, em, i, u, s, a, ul, ol, li,
 * blockquote, h3, h4, span; em <a> só href seguro e target="_blank" (com rel forçado).
 * `documento` é o Document onde analisar (no navegador, o padrão é `document`).
 */
export function sanitizarHtml(html, documento) {
  if (typeof html !== 'string' || !html) return '';
  const doc = obterDocumento(documento);
  if (!doc) return escaparTexto(html);
  try {
    return limparHtml(html, doc);
  } catch {
    return escaparTexto(html);
  }
}

// ---------------------------------------------------------------------------
// Estrutura: tipos, grupos, listas e itens

function tipoDoElemento(el) {
  const tipo = atributo(el, 'data-cms-tipo');
  if (TIPOS_CAMPO.includes(tipo)) return tipo;
  switch (nomeTag(el)) {
    case 'meta': return 'meta';
    case 'img': return 'imagem';
    case 'video': return 'video';
    case 'a': return 'link';
    case 'iframe': return embedParaInstagram(atributo(el, 'src')) ? 'instagram' : 'url';
    default: return 'texto';
  }
}

function ehLista(el) {
  return atributo(el, 'data-cms-tipo') === 'lista';
}

// Equivalentes a closest('[data-cms-tipo="lista"]') e closest('[data-cms-item]').
function listaMaisProxima(el) {
  for (let atual = el; atual; atual = paiElemento(atual)) if (ehLista(atual)) return atual;
  return null;
}

function itemMaisProximo(el) {
  for (let atual = el; atual; atual = paiElemento(atual)) if (temAtributo(atual, 'data-cms-item')) return atual;
  return null;
}

function dentroDeItem(el) {
  const item = itemMaisProximo(el);
  return !!item && !!listaMaisProxima(item);
}

function idGrupo(el) {
  if (!temAtributo(el, 'data-cms-grupo')) return null;
  const id = atributo(el, 'data-cms-grupo');
  return RE_GRUPO.test(id) ? id : null;
}

function grupoMaisProximo(el) {
  for (let atual = el; atual; atual = paiElemento(atual)) {
    const id = idGrupo(atual);
    if (id) return { id, el: atual };
  }
  return null;
}

function ocultavel(el) {
  return temAtributo(el, 'data-cms-ocultavel') && !SEM_VISIBILIDADE.has(nomeTag(el));
}

function chaveVisibilidade(id) {
  return `grupo.${id}.visivel`;
}

function chaveDoElemento(el) {
  const chave = atributo(el, 'data-cms');
  if (!RE_CHAVE.test(chave) || RE_VISIBILIDADE.test(chave)) return null;
  return chave;
}

// Campos de nível superior (fora de itens de lista), na ordem do documento, com espelhos.
function coletarCampos(raiz) {
  const campos = [];
  for (const el of selecionar(raiz, '[data-cms]', ['data-cms'])) {
    const chave = chaveDoElemento(el);
    if (!chave || dentroDeItem(el)) continue;
    campos.push({ el, chave, tipo: tipoDoElemento(el) });
  }
  return campos;
}

function itensDaLista(lista) {
  return Array.from(lista.querySelectorAll('[data-cms-item]')).filter((item) => listaMaisProxima(item) === lista);
}

function camposDoItem(item) {
  const elementos = Array.from(item.querySelectorAll('[data-cms-campo]')).filter((el) => itemMaisProximo(el) === item);
  if (temAtributo(item, 'data-cms-campo')) elementos.unshift(item);
  const campos = [];
  for (const el of elementos) {
    const campo = atributo(el, 'data-cms-campo').trim();
    const tipo = tipoDoElemento(el);
    if (RE_CAMPO.test(campo) && tipo !== 'lista') campos.push({ el, campo, tipo });
  }
  return campos;
}

const ESTADO_LISTAS = new WeakMap();

function soEspacos(no) {
  return !!no && no.nodeType === 3 && !/[^ \t\n\r\f]/.test(no.data);
}

// Nós de texto só com espaços entre itens vizinhos (somem junto com os itens).
function espacosEntreItens(itens) {
  const encontrados = [];
  for (let k = 0; k + 1 < itens.length; k++) {
    const entre = [];
    let no = itens[k].nextSibling;
    while (no && no !== itens[k + 1] && soEspacos(no)) {
      entre.push(no);
      no = no.nextSibling;
    }
    if (no === itens[k + 1]) encontrados.push(...entre);
  }
  return encontrados;
}

// Espaço usado entre itens novos: o do template entre os dois primeiros itens
// ou, com um item só, o recuo antes dele.
function separadorDosItens(itens) {
  if (!itens.length) return '';
  if (itens.length > 1) {
    let texto = '';
    let no = itens[0].nextSibling;
    while (no && no !== itens[1] && soEspacos(no)) {
      texto += no.data;
      no = no.nextSibling;
    }
    if (no === itens[1]) return texto;
  }
  const anterior = itens[0].previousSibling;
  return soEspacos(anterior) ? anterior.data : '';
}

// Molde = clone do primeiro item, tirado antes de qualquer alteração e guardado para reaplicações.
function estadoLista(lista) {
  let estado = ESTADO_LISTAS.get(lista);
  if (!estado) {
    estado = { molde: null, separador: '', marcador: null };
    ESTADO_LISTAS.set(lista, estado);
  }
  if (!estado.molde) {
    const itens = itensDaLista(lista);
    if (itens.length) {
      estado.molde = itens[0].cloneNode(true);
      estado.separador = separadorDosItens(itens);
    }
  }
  return estado;
}

function filhosFixos(el) {
  return filhos(el).filter((no) => ehElemento(no) && temAtributo(no, 'data-cms-fixo'));
}

// Troca o conteúdo do elemento por `novos`, mantendo os filhos fixos no fim.
function substituirConteudo(el, novos, fixos) {
  for (const no of filhos(el)) el.removeChild(no);
  for (const no of novos) el.appendChild(no);
  for (const no of fixos) el.appendChild(no);
}

function alvo(el, tag) {
  if (nomeTag(el) === tag) return el;
  return el.querySelector(tag);
}

function semConteudoEditavel(el) {
  const tag = nomeTag(el);
  return CONTEUDO_PROIBIDO.has(tag) || TEXTO_SEM_ESCAPE.has(tag);
}

// ---------------------------------------------------------------------------
// Leitura

function textoSemFixos(el, fixos) {
  if (!fixos.length) return String(el.textContent ?? '');
  let texto = '';
  for (const no of filhos(el)) {
    if (no.nodeType === 3) texto += no.data;
    else if (ehElemento(no) && !fixos.includes(no)) texto += no.textContent;
  }
  return texto;
}

function normalizarTextoLongo(texto) {
  return String(texto).replace(/\r\n?/g, '\n').split('\n').map(colapsar).join('\n').replace(/^\n+|\n+$/g, '');
}

function lerTextoLongo(el, fixos) {
  if (semConteudoEditavel(el)) return colapsar(el.textContent ?? '');
  const partes = [];
  const andar = (no) => {
    for (const filho of filhos(no)) {
      if (filho.nodeType === 3) {
        partes.push(String(filho.data).replace(/[ \t\n\r\f]+/g, ' '));
      } else if (ehElemento(filho) && !fixos.includes(filho)) {
        const tag = nomeTag(filho);
        if (tag === 'br') partes.push('\n');
        else if (!IGNORAR_NA_LEITURA.has(tag)) {
          const bloco = BLOCOS.has(tag);
          if (bloco) partes.push('\n');
          andar(filho);
          if (bloco) partes.push('\n');
        }
      }
    }
  };
  andar(el);
  return normalizarTextoLongo(partes.join(''));
}

function lerHtml(el, fixos) {
  if (semConteudoEditavel(el)) return colapsar(el.textContent ?? '');
  if (!fixos.length) return String(el.innerHTML ?? '').trim();
  const copia = el.cloneNode(true);
  for (const fixo of filhosFixos(copia)) copia.removeChild(fixo);
  return String(copia.innerHTML ?? '').trim();
}

function temFilhoElemento(el) {
  return filhos(el).some(ehElemento);
}

// Texto do link: em [data-cms-link-texto] ou no próprio <a> se ele não tem filhos elemento.
// Fora disso o texto não é campo.
function lerTextoDoLink(a) {
  const marcado = a.querySelector('[data-cms-link-texto]');
  if (marcado) return colapsar(marcado.textContent ?? '');
  if (!temFilhoElemento(a)) return colapsar(a.textContent ?? '');
  return '';
}

function fontesDoVideo(video) {
  return filhos(video).filter((no) => nomeTag(no) === 'source');
}

function lerSrcVideo(video) {
  if (temAtributo(video, 'src')) return atributo(video, 'src');
  const [fonte] = fontesDoVideo(video);
  return fonte ? atributo(fonte, 'src') : '';
}

function lerItem(item) {
  const valores = {};
  for (const { el, campo, tipo } of camposDoItem(item)) {
    if (!temProp(valores, campo)) valores[campo] = lerValor(el, tipo);
  }
  return valores;
}

/** Valor atual de um elemento, no formato salvo em `conteudo_site` (tabela 5.3). */
export function lerValor(elemento, tipo) {
  if (!ehElemento(elemento)) return null;
  const t = TIPOS_CAMPO.includes(tipo) ? tipo : tipoDoElemento(elemento);
  try {
    switch (t) {
      case 'texto':
        return colapsar(textoSemFixos(elemento, filhosFixos(elemento)));
      case 'textolongo':
        return lerTextoLongo(elemento, filhosFixos(elemento));
      case 'html':
        return lerHtml(elemento, filhosFixos(elemento));
      case 'imagem': {
        const img = alvo(elemento, 'img');
        return { src: atributo(img, 'src'), alt: atributo(img, 'alt') };
      }
      case 'video': {
        const video = alvo(elemento, 'video');
        return { src: video ? lerSrcVideo(video) : '', poster: atributo(video, 'poster') };
      }
      case 'link': {
        const a = alvo(elemento, 'a');
        return { href: atributo(a, 'href'), texto: a ? lerTextoDoLink(a) : '' };
      }
      case 'url': {
        const nome = ATRIBUTO_URL.get(nomeTag(elemento));
        return nome ? atributo(elemento, nome) : '';
      }
      case 'instagram': {
        const iframe = alvo(elemento, 'iframe');
        return embedParaInstagram(atributo(iframe, 'src')) || '';
      }
      case 'meta':
        return atributo(elemento, 'content');
      case 'lista':
        return itensDaLista(elemento).map(lerItem);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Aplicação

function aplicarTexto(el, valor, doc) {
  if (typeof valor !== 'string') return;
  const tag = nomeTag(el);
  if (CONTEUDO_PROIBIDO.has(tag)) return;
  if (TEXTO_SEM_ESCAPE.has(tag)) {
    // Sem "<" não há como fechar a tag no HTML serializado.
    const limpo = valor.replace(/</g, '');
    if (colapsar(el.textContent ?? '') !== colapsar(limpo)) el.textContent = limpo;
    return;
  }
  const fixos = filhosFixos(el);
  if (colapsar(valor) === colapsar(textoSemFixos(el, fixos))) return;
  if (!fixos.length) {
    el.textContent = valor;
    return;
  }
  substituirConteudo(el, [doc.createTextNode(valor)], fixos);
}

function aplicarTextoLongo(el, valor, doc) {
  if (typeof valor !== 'string') return;
  const texto = valor.replace(/\r\n?/g, '\n');
  if (semConteudoEditavel(el)) {
    aplicarTexto(el, texto.replace(/\n/g, ' '), doc);
    return;
  }
  const fixos = filhosFixos(el);
  if (normalizarTextoLongo(texto) === lerTextoLongo(el, fixos)) return;
  const nos = [];
  texto.split('\n').forEach((linha, i) => {
    if (i > 0) nos.push(doc.createElement('br'));
    if (linha) nos.push(doc.createTextNode(linha));
  });
  substituirConteudo(el, nos, fixos);
}

function aplicarHtml(el, valor, doc) {
  if (typeof valor !== 'string' || semConteudoEditavel(el)) return;
  const fixos = filhosFixos(el);
  const atual = lerHtml(el, fixos);
  // Igual ao que o template já tem: nada a fazer.
  if (valor.trim() === atual) return;
  const limpo = limparHtml(valor, doc).trim();
  if (limpo === atual) return;
  // O HTML limpo só tem tags e atributos permitidos; analisá-lo de novo não cria nada além disso.
  substituirConteudo(el, filhos(analisarHtml(limpo, doc)), fixos);
}

// Lê uma URL opcional de um objeto: undefined = não informada, null = insegura.
function urlDoObjeto(objeto, nome) {
  const valor = objeto[nome];
  if (typeof valor !== 'string' || !valor.trim()) return undefined;
  return urlSegura(valor);
}

function removerFontesDePicture(img) {
  const pai = paiElemento(img);
  if (!pai || nomeTag(pai) !== 'picture') return;
  for (const no of filhos(pai)) if (nomeTag(no) === 'source') pai.removeChild(no);
}

function trocarSrcImagem(img, src) {
  if (atributo(img, 'src') === src) return;
  img.setAttribute('src', src);
  img.removeAttribute('srcset');
  removerFontesDePicture(img);
}

function aplicarImagem(el, valor) {
  if (!objetoSimples(valor)) return;
  const img = alvo(el, 'img');
  if (!img) return;
  const src = urlDoObjeto(valor, 'src');
  const alt = valor.alt;
  if (src === null) return; // URL insegura: ignora o valor inteiro
  if (src !== undefined) trocarSrcImagem(img, src);
  if (typeof alt === 'string' && alt !== atributo(img, 'alt')) img.setAttribute('alt', alt);
}

function trocarSrcVideo(video, src) {
  if (src === lerSrcVideo(video)) return;
  const fontes = fontesDoVideo(video);
  if (temAtributo(video, 'src') || !fontes.length) {
    video.setAttribute('src', src);
    return;
  }
  // Troca o primeiro <source> e tira os outros (o type deles pode não bater com o arquivo novo).
  fontes[0].setAttribute('src', src);
  fontes[0].removeAttribute('type');
  for (const fonte of fontes.slice(1)) video.removeChild(fonte);
}

function aplicarVideo(el, valor) {
  if (!objetoSimples(valor)) return;
  const video = alvo(el, 'video');
  if (!video) return;
  const src = urlDoObjeto(valor, 'src');
  const poster = urlDoObjeto(valor, 'poster');
  const posterInformado = typeof valor.poster === 'string';
  if (src === null || poster === null) return;
  if (src !== undefined) trocarSrcVideo(video, src);
  if (poster !== undefined) {
    if (poster !== atributo(video, 'poster')) video.setAttribute('poster', poster);
  } else if (posterInformado && temAtributo(video, 'poster')) {
    video.removeAttribute('poster'); // poster "" = sem capa
  }
}

function aplicarTextoDoLink(a, texto, doc) {
  const marcados = Array.from(a.querySelectorAll('[data-cms-link-texto]'));
  if (marcados.length) {
    for (const marcado of marcados) aplicarTexto(marcado, texto, doc);
    return;
  }
  // Sem marcador e com filhos elemento (ícones etc.), o texto não é campo.
  if (temFilhoElemento(a)) return;
  if (colapsar(a.textContent ?? '') !== colapsar(texto)) a.textContent = texto;
}

function aplicarLink(el, valor, doc) {
  if (!objetoSimples(valor)) return;
  const a = alvo(el, 'a');
  if (!a) return;
  const href = urlDoObjeto(valor, 'href');
  const texto = valor.texto;
  if (href === null) return;
  if (href !== undefined && href !== atributo(a, 'href')) a.setAttribute('href', href);
  if (typeof texto === 'string' && texto.trim()) aplicarTextoDoLink(a, texto, doc);
}

function aplicarUrl(el, valor) {
  if (typeof valor !== 'string' || !valor.trim()) return;
  const seguro = urlSegura(valor);
  const tag = nomeTag(el);
  const nome = ATRIBUTO_URL.get(tag);
  if (!seguro || !nome) return;
  if (tag === 'img') trocarSrcImagem(el, seguro);
  else if (atributo(el, nome) !== seguro) el.setAttribute(nome, seguro);
}

function aplicarInstagram(el, valor) {
  if (typeof valor !== 'string') return;
  const embed = instagramParaEmbed(valor);
  const iframe = alvo(el, 'iframe');
  if (!embed || !iframe) return;
  if (embedParaInstagram(atributo(iframe, 'src')) === embedParaInstagram(embed)) return;
  iframe.setAttribute('src', embed);
}

function aplicarMeta(el, valor) {
  if (typeof valor !== 'string' || atributo(el, 'content') === valor) return;
  el.setAttribute('content', valor);
}

function preencherItem(item, dados, doc) {
  for (const { el, campo, tipo } of camposDoItem(item)) {
    try {
      if (!temProp(dados, campo)) continue;
      const valor = dados[campo];
      if (valor === null || valor === undefined) continue;
      aplicarNoElemento(el, tipo, valor, doc);
    } catch {
      // valor malformado: o item fica com o valor do molde
    }
  }
}

function aplicarLista(lista, valor, doc) {
  if (!Array.isArray(valor)) return;
  const dados = valor.slice(0, LIMITE_ITENS * 5).filter(objetoSimples).slice(0, LIMITE_ITENS);
  if (valor.length && !dados.length) return; // nada aproveitável: mantém o padrão
  const estado = estadoLista(lista);
  if (!estado.molde) return;

  const atuais = itensDaLista(lista);
  let referencia = atuais[0] || null;
  if (!referencia && estado.marcador && contem(lista, estado.marcador)) referencia = estado.marcador;
  const pai = referencia && referencia.parentNode;
  if (!pai) return;

  // Todo item novo é um clone do molde (§5.2), com os campos informados preenchidos.
  const novos = dados.map((dadosItem) => {
    const clone = estado.molde.cloneNode(true);
    preencherItem(clone, dadosItem, doc);
    return clone;
  });

  // Mesmos valores, na mesma ordem, que os itens atuais: a lista fica como está
  // (aplicar os padrões não altera o template e reaplicar não muda nada).
  if (novos.length === atuais.length && novos.every((no, i) => iguais(lerItem(no), lerItem(atuais[i])))) return;

  const espacos = espacosEntreItens(atuais);

  // Nó de texto vazio (invisível no HTML) marca a posição para reaplicações no mesmo documento.
  const marcador = doc.createTextNode('');
  pai.insertBefore(marcador, referencia);
  if (estado.marcador && estado.marcador.parentNode) estado.marcador.parentNode.removeChild(estado.marcador);
  for (const no of espacos) if (no.parentNode) no.parentNode.removeChild(no);
  for (const item of atuais) if (item.parentNode) item.parentNode.removeChild(item);
  novos.forEach((no, i) => {
    if (i > 0 && estado.separador) pai.insertBefore(doc.createTextNode(estado.separador), marcador);
    pai.insertBefore(no, marcador);
  });
  estado.marcador = marcador;
}

function aplicarNoElemento(el, tipo, valor, doc) {
  switch (tipo) {
    case 'texto': return aplicarTexto(el, valor, doc);
    case 'textolongo': return aplicarTextoLongo(el, valor, doc);
    case 'html': return aplicarHtml(el, valor, doc);
    case 'imagem': return aplicarImagem(el, valor);
    case 'video': return aplicarVideo(el, valor);
    case 'link': return aplicarLink(el, valor, doc);
    case 'url': return aplicarUrl(el, valor);
    case 'instagram': return aplicarInstagram(el, valor);
    case 'meta': return aplicarMeta(el, valor);
    case 'lista': return aplicarLista(el, valor, doc);
    default: return undefined;
  }
}

// { chave: valor } (ou linhas [{ chave, valor }], ou Map) → Map. Valor ilegível é ignorado.
function normalizarConteudo(conteudo) {
  const valores = new Map();
  const guardar = (chave, ler) => {
    if (typeof chave !== 'string') return;
    try {
      valores.set(chave, ler());
    } catch {
      // mantém o padrão
    }
  };
  if (Array.isArray(conteudo)) {
    for (const linha of conteudo) {
      if (objetoSimples(linha)) guardar(linha.chave, () => linha.valor);
    }
  } else if (conteudo instanceof Map) {
    for (const [chave, valor] of conteudo) guardar(chave, () => valor);
  } else if (objetoSimples(conteudo)) {
    for (const chave of Object.keys(conteudo)) guardar(chave, () => conteudo[chave]);
  }
  return valores;
}

/** Número (só dígitos, 10 a 15) de um link https://wa.me/<número>…; '' se o endereço não for desse formato. */
function numeroDoWhatsapp(url) {
  const m = /^https:\/\/wa\.me\/(\d{10,15})(?=$|[/?#])/i.exec(String(url ?? '').trim());
  return m ? m[1] : '';
}

// O número do botão do WhatsApp ("whatsapp.link") vale para o site todo: todo link wa.me da página
// (menu, projetos, rodapé) passa a usar esse número, mantendo a mensagem (?text=) de cada um.
function aplicarWhatsappUniversal(raiz, valores) {
  const valor = valores.get('whatsapp.link');
  const numero = objetoSimples(valor) ? numeroDoWhatsapp(urlDoObjeto(valor, 'href')) : '';
  if (!numero) return;
  for (const a of raiz.querySelectorAll('a[href]')) {
    const href = atributo(a, 'href');
    if (typeof href !== 'string') continue;
    const novo = href.replace(/^(https:\/\/wa\.me\/)\d{10,15}(?=$|[/?#])/i, `$1${numero}`);
    if (novo !== href) a.setAttribute('href', novo);
  }
}

function aplicarVisibilidade(raiz, valores) {
  for (const el of selecionar(raiz, '[data-cms-grupo]', ['data-cms-grupo'])) {
    const id = idGrupo(el);
    if (!id || !ocultavel(el) || valores.get(chaveVisibilidade(id)) !== false) continue;
    if (el.parentNode) el.parentNode.removeChild(el);
  }
}

/**
 * Aplica `conteudo` ({ [chave]: valor }) ao documento, mutando-o. Chaves ausentes,
 * valores nulos ou malformados mantêm o padrão do template. `grupo.<id>.visivel === false`
 * remove os elementos do grupo que têm data-cms-ocultavel. Devolve o próprio documento.
 */
export function aplicarConteudo(documento, conteudo) {
  try {
    const raiz = raizDe(documento);
    const doc = raiz ? documentoDe(raiz) : null;
    if (!raiz || !doc || typeof doc.createElement !== 'function') return documento;
    const valores = normalizarConteudo(conteudo);
    const campos = coletarCampos(raiz);

    for (const campo of campos) if (campo.tipo === 'lista') estadoLista(campo.el);

    for (const { el, chave, tipo } of campos) {
      const valor = valores.get(chave);
      if (valor === null || valor === undefined) continue;
      try {
        aplicarNoElemento(el, tipo, valor, doc);
      } catch {
        // valor malformado: mantém o padrão
      }
    }
    aplicarVisibilidade(raiz, valores);
    aplicarWhatsappUniversal(raiz, valores);
  } catch {
    // nunca quebra a página
  }
  return documento;
}

// ---------------------------------------------------------------------------
// Esquema

// Rótulo legível a partir de uma chave ("quem-somos.botao-texto" → "Botão texto").
function rotuloDeChave(chave, prefixo) {
  let texto = String(chave ?? '');
  if (prefixo && texto.startsWith(prefixo + '.')) texto = texto.slice(prefixo.length + 1);
  const palavras = texto.split(/[._\-\s]+/).filter(Boolean).map((p) => {
    const minuscula = p.toLowerCase();
    return PALAVRAS.has(minuscula) ? PALAVRAS.get(minuscula) : minuscula;
  });
  if (!palavras.length) return 'Campo';
  const frase = palavras.join(' ');
  return frase.charAt(0).toUpperCase() + frase.slice(1);
}

function descreverCamposDoItem(item) {
  const vistos = new Set();
  const campos = [];
  for (const { el, campo, tipo } of camposDoItem(item)) {
    if (vistos.has(campo)) continue;
    vistos.add(campo);
    campos.push({
      campo,
      tipo,
      rotulo: atributo(el, 'data-cms-rotulo').trim() || rotuloDeChave(campo),
      ajuda: atributo(el, 'data-cms-ajuda').trim()
    });
  }
  return campos;
}

function descreverCampo(el, chave, tipo, grupo) {
  const campo = {
    chave,
    tipo,
    rotulo: atributo(el, 'data-cms-rotulo').trim() || rotuloDeChave(chave, grupo),
    ajuda: atributo(el, 'data-cms-ajuda').trim(),
    padrao: lerValor(el, tipo)
  };
  // Editor especial no painel (ex.: "produto": a imagem é escolhida entre os produtos da loja).
  const editor = atributo(el, 'data-cms-editor').trim();
  if (editor) campo.editor = editor;
  if (tipo === 'lista') {
    const estado = ESTADO_LISTAS.get(el);
    // O molde guardado na primeira aplicação; num template cru, o primeiro item.
    const molde = (estado && estado.molde) || itensDaLista(el)[0] || null;
    campo.itemRotulo = atributo(el, 'data-cms-item-rotulo').trim() || 'Item';
    campo.campos = molde ? descreverCamposDoItem(molde) : [];
  }
  return campo;
}

/**
 * Descobre grupos e campos do template, na ordem do documento.
 * → { grupos: [{ id, rotulo, ocultavel, campos: [Campo] }] }
 * Campo = { chave, tipo, rotulo, ajuda, padrao, itemRotulo?, campos?: [{ campo, tipo, rotulo, ajuda }] }
 */
export function extrairEsquema(documento) {
  const raiz = raizDe(documento);
  if (!raiz) return { grupos: [] };
  const grupos = new Map();
  const chavesVistas = new Set();

  const registrarGrupo = (id, el) => {
    let grupo = grupos.get(id);
    if (!grupo) {
      grupo = { id, rotulo: '', ocultavel: false, campos: [] };
      grupos.set(id, grupo);
    }
    if (el) {
      if (!grupo.rotulo) grupo.rotulo = atributo(el, 'data-cms-grupo-rotulo').trim();
      if (ocultavel(el)) grupo.ocultavel = true;
    }
    return grupo;
  };

  try {
    for (const el of selecionar(raiz, '[data-cms-grupo], [data-cms]', ['data-cms-grupo', 'data-cms'])) {
      const id = idGrupo(el);
      if (id) registrarGrupo(id, el);
      if (!temAtributo(el, 'data-cms')) continue;
      const chave = chaveDoElemento(el);
      if (!chave || chavesVistas.has(chave) || dentroDeItem(el)) continue;
      chavesVistas.add(chave);
      const encontrado = grupoMaisProximo(el);
      const grupo = encontrado ? registrarGrupo(encontrado.id, encontrado.el) : registrarGrupo('geral', null);
      grupo.campos.push(descreverCampo(el, chave, tipoDoElemento(el), grupo.id));
    }
  } catch {
    return { grupos: [] };
  }

  const lista = [];
  for (const grupo of grupos.values()) {
    // Grupo ocultável sem campos continua no esquema: o painel ainda pode ocultá-lo.
    if (!grupo.campos.length && !grupo.ocultavel) continue;
    if (!grupo.rotulo) grupo.rotulo = grupo.id === 'geral' ? 'Geral' : rotuloDeChave(grupo.id);
    lista.push(grupo);
  }
  return { grupos: lista };
}
