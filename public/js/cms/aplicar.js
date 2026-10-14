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
 * - Em listas, um item novo idêntico (nos campos) a um item existente reaproveita
 *   o elemento existente, preservando atributos que não são campos.
 * - O molde de cada lista fica guardado (WeakMap) no primeiro uso: aplicar de novo
 *   no mesmo documento usa o molde original, mesmo depois de `[]`.
 * - `data-cms-fixo` também é respeitado em `texto` e `textolongo`.
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
// Removidas junto com o conteúdo (as do contrato e outras que não têm texto útil).
const TAGS_REMOVIDAS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript',
  'frame', 'frameset', 'noframes', 'noembed', 'applet', 'xmp', 'plaintext', 'title', 'textarea',
  'select', 'option', 'optgroup', 'datalist', 'head', 'link', 'meta', 'base', 'audio', 'video',
  'source', 'track', 'canvas', 'param', 'img', 'picture', 'input'
]);
// Elementos cujo texto é serializado sem escape (o linkedom não escapa nem <title>/<textarea>).
const TEXTO_BRUTO = new Set([
  'title', 'textarea', 'script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext'
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

function colapsar(texto) {
  return String(texto).replace(/[ \t\n\r\f]+/g, ' ').replace(/^ | $/g, '');
}

function escaparTexto(texto) {
  return String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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

// Analisa o HTML num <template> (inerte no navegador: nada carrega nem executa) e
// reconstrói só o que é permitido, com nós novos criados em `doc`.
function limparHtml(html, doc) {
  const fragmento = doc.createDocumentFragment();
  if (typeof html !== 'string' || !html) return fragmento;
  const modelo = doc.createElement('template');
  modelo.innerHTML = html;
  const origem = modelo.content && modelo.content.childNodes ? modelo.content : modelo;

  const pilha = [];
  const empilhar = (no, destino, profundidade) => {
    const lista = filhos(no);
    for (let i = lista.length - 1; i >= 0; i--) pilha.push([lista[i], destino, profundidade]);
  };
  empilhar(origem, fragmento, 0);

  while (pilha.length) {
    const [no, destino, profundidade] = pilha.pop();
    if (no.nodeType === 3) {
      destino.appendChild(doc.createTextNode(String(no.data ?? no.nodeValue ?? '')));
      continue;
    }
    if (no.nodeType !== 1) continue; // comentários e afins
    const tag = nomeTag(no);
    if (TAGS_REMOVIDAS.has(tag)) continue;
    if (!TAGS_PERMITIDAS.has(tag) || profundidade >= PROFUNDIDADE_MAXIMA) {
      empilhar(no, destino, profundidade); // desembrulha: fica só o conteúdo
      continue;
    }
    const novo = doc.createElement(tag);
    if (tag === 'a') {
      const href = urlSegura(no.getAttribute('href'));
      if (href) novo.setAttribute('href', href);
      if (String(no.getAttribute('target') || '').trim().toLowerCase() === '_blank') {
        novo.setAttribute('target', '_blank');
        novo.setAttribute('rel', 'noopener noreferrer');
      }
    }
    destino.appendChild(novo);
    if (tag !== 'br') empilhar(no, novo, profundidade + 1);
  }
  return fragmento;
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
    const caixa = doc.createElement('div');
    caixa.appendChild(limparHtml(html, doc));
    return caixa.innerHTML;
  } catch {
    return escaparTexto(html);
  }
}

// ---------------------------------------------------------------------------
// Estrutura: tipos, grupos, listas e itens

function tipoDoElemento(el) {
  const tipo = atributo(el, 'data-cms-tipo').trim().toLowerCase();
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
  return atributo(el, 'data-cms-tipo').trim().toLowerCase() === 'lista';
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
  const id = atributo(el, 'data-cms-grupo').trim().toLowerCase();
  return RE_GRUPO.test(id) ? id : null;
}

function grupoMaisProximo(el) {
  for (let atual = el; atual; atual = paiElemento(atual)) {
    const id = idGrupo(atual);
    if (id) return { id, el: atual };
  }
  return null;
}

function chaveDoElemento(el) {
  const chave = atributo(el, 'data-cms').trim().toLowerCase();
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
  if (TEXTO_BRUTO.has(nomeTag(el))) return colapsar(el.textContent ?? '');
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
  if (TEXTO_BRUTO.has(nomeTag(el))) return colapsar(el.textContent ?? '');
  if (!fixos.length) return String(el.innerHTML ?? '').trim();
  const copia = el.cloneNode(true);
  for (const fixo of filhosFixos(copia)) copia.removeChild(fixo);
  return String(copia.innerHTML ?? '').trim();
}

function temFilhoElemento(el) {
  return filhos(el).some(ehElemento);
}

function lerTextoDoLink(a) {
  const marcado = a.querySelector('[data-cms-link-texto]');
  if (marcado) return colapsar(marcado.textContent ?? '');
  if (!temFilhoElemento(a)) return colapsar(a.textContent ?? '');
  return colapsar(filhos(a).filter((no) => no.nodeType === 3).map((no) => no.data).join(' '));
}

function lerSrcVideo(video) {
  if (temAtributo(video, 'src')) return atributo(video, 'src');
  const fonte = video.querySelector('source');
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

function textoBrutoSeguro(texto) {
  // Num elemento de texto bruto, "</title>" encerraria o elemento no HTML serializado.
  return String(texto).replace(/</g, '');
}

function aplicarTexto(el, valor, doc) {
  if (typeof valor !== 'string') return;
  if (TEXTO_BRUTO.has(nomeTag(el))) {
    const limpo = textoBrutoSeguro(valor);
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
  if (TEXTO_BRUTO.has(nomeTag(el))) {
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
  if (typeof valor !== 'string' || TEXTO_BRUTO.has(nomeTag(el))) return;
  const fixos = filhosFixos(el);
  // Igual ao que o template já tem: nada a fazer (e nada vindo de fora entra sem sanitização).
  if (valor.trim() === lerHtml(el, fixos)) return;
  substituirConteudo(el, filhos(limparHtml(valor, doc)), fixos);
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
  if (src === null) return; // URL insegura: ignora o valor inteiro
  if (src !== undefined) trocarSrcImagem(img, src);
  if (typeof valor.alt === 'string' && valor.alt !== atributo(img, 'alt')) img.setAttribute('alt', valor.alt);
}

function aplicarVideo(el, valor) {
  if (!objetoSimples(valor)) return;
  const video = alvo(el, 'video');
  if (!video) return;
  const src = urlDoObjeto(valor, 'src');
  const poster = urlDoObjeto(valor, 'poster');
  if (src === null || poster === null) return;
  if (src !== undefined && src !== lerSrcVideo(video)) video.setAttribute('src', src);
  if (poster !== undefined) {
    if (poster !== atributo(video, 'poster')) video.setAttribute('poster', poster);
  } else if (typeof valor.poster === 'string' && temAtributo(video, 'poster')) {
    video.removeAttribute('poster'); // poster "" = sem capa
  }
}

function aplicarTextoDoLink(a, texto, doc) {
  const marcados = Array.from(a.querySelectorAll('[data-cms-link-texto]'));
  if (marcados.length) {
    for (const marcado of marcados) aplicarTexto(marcado, texto, doc);
    return;
  }
  if (!temFilhoElemento(a)) {
    if (colapsar(a.textContent ?? '') !== colapsar(texto)) a.textContent = texto;
    return;
  }
  // Sem marcador e com ícones: troca o texto solto do <a>, se houver.
  const textos = filhos(a).filter((no) => no.nodeType === 3 && /[^ \t\n\r\f]/.test(no.data));
  if (!textos.length || colapsar(textos.map((no) => no.data).join(' ')) === colapsar(texto)) return;
  const [primeiro, ...resto] = textos;
  const inicio = /^[ \t\n\r\f]*/.exec(primeiro.data)[0];
  const fim = /[ \t\n\r\f]*$/.exec(primeiro.data)[0];
  primeiro.data = inicio + texto + fim;
  for (const no of resto) a.removeChild(no);
}

function aplicarLink(el, valor, doc) {
  if (!objetoSimples(valor)) return;
  const a = alvo(el, 'a');
  if (!a) return;
  const href = urlDoObjeto(valor, 'href');
  if (href === null) return;
  if (href !== undefined && href !== atributo(a, 'href')) a.setAttribute('href', href);
  if (typeof valor.texto === 'string' && valor.texto.trim()) aplicarTextoDoLink(a, valor.texto, doc);
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
    if (!temProp(dados, campo)) continue;
    const valor = dados[campo];
    if (valor === null || valor === undefined) continue;
    try {
      aplicarNoElemento(el, tipo, valor, doc);
    } catch {
      // valor malformado: o item fica com o valor do molde
    }
  }
}

function aplicarLista(lista, valor, doc) {
  if (!Array.isArray(valor)) return;
  const dados = valor.filter(objetoSimples).slice(0, LIMITE_ITENS);
  if (valor.length && !dados.length) return; // nada aproveitável: mantém o padrão
  const estado = estadoLista(lista);
  if (!estado.molde) return;

  const atuais = itensDaLista(lista);
  let referencia = atuais[0] || null;
  if (!referencia && estado.marcador && contem(lista, estado.marcador)) referencia = estado.marcador;
  const pai = referencia && referencia.parentNode;
  if (!pai) return;

  const existentes = atuais.map((el) => ({ el, valores: lerItem(el), usado: false }));
  const novos = dados.map((dadosItem) => {
    const clone = estado.molde.cloneNode(true);
    preencherItem(clone, dadosItem, doc);
    const valores = lerItem(clone);
    const igual = existentes.find((x) => !x.usado && iguais(x.valores, valores));
    if (!igual) return clone;
    igual.usado = true;
    return igual.el;
  });

  const espacos = espacosEntreItens(atuais);

  // Nó de texto vazio (invisível no HTML) marca a posição para reaplicações no mesmo documento.
  const marcador = doc.createTextNode('');
  pai.insertBefore(marcador, referencia);
  if (estado.marcador && estado.marcador.parentNode) estado.marcador.parentNode.removeChild(estado.marcador);
  for (const no of espacos) if (no.parentNode) no.parentNode.removeChild(no);
  for (const x of existentes) if (!x.usado && x.el.parentNode) x.el.parentNode.removeChild(x.el);
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

/** Aplica um valor a um único elemento (útil para pré-visualização ao vivo). Nunca lança. */
export function aplicarValor(elemento, tipo, valor) {
  if (!ehElemento(elemento) || valor === null || valor === undefined) return;
  const doc = documentoDe(elemento);
  if (!doc) return;
  const t = TIPOS_CAMPO.includes(tipo) ? tipo : tipoDoElemento(elemento);
  try {
    aplicarNoElemento(elemento, t, valor, doc);
  } catch {
    // mantém o padrão
  }
}

function normalizarConteudo(conteudo) {
  const valores = Object.create(null);
  if (Array.isArray(conteudo)) {
    // Também aceita as linhas da tabela: [{ chave, valor }]
    for (const linha of conteudo) {
      if (objetoSimples(linha) && typeof linha.chave === 'string') valores[linha.chave] = linha.valor;
    }
  } else if (conteudo instanceof Map) {
    for (const [chave, valor] of conteudo) if (typeof chave === 'string') valores[chave] = valor;
  } else if (objetoSimples(conteudo)) {
    for (const chave of Object.keys(conteudo)) valores[chave] = conteudo[chave];
  }
  return valores;
}

function aplicarVisibilidade(raiz, valores) {
  for (const el of selecionar(raiz, '[data-cms-grupo]', ['data-cms-grupo'])) {
    if (!temAtributo(el, 'data-cms-ocultavel')) continue;
    const id = idGrupo(el);
    if (!id || valores[chaveVisibilidade(id)] !== false) continue;
    if (['html', 'head', 'body'].includes(nomeTag(el))) continue;
    if (el.parentNode) el.parentNode.removeChild(el);
  }
}

/**
 * Aplica `conteudo` ({ [chave]: valor }) ao documento, mutando-o. Chaves ausentes,
 * valores nulos ou malformados mantêm o padrão do template. `grupo.<id>.visivel === false`
 * remove os elementos do grupo que têm data-cms-ocultavel. Devolve o próprio documento.
 */
export function aplicarConteudo(documento, conteudo) {
  const raiz = raizDe(documento);
  const doc = raiz ? documentoDe(raiz) : null;
  if (!raiz || !doc || typeof doc.createElement !== 'function') return documento;
  const valores = normalizarConteudo(conteudo);
  const campos = coletarCampos(raiz);

  for (const campo of campos) if (campo.tipo === 'lista') estadoLista(campo.el);

  for (const { el, chave, tipo } of campos) {
    const valor = valores[chave];
    if (valor === null || valor === undefined) continue;
    try {
      aplicarNoElemento(el, tipo, valor, doc);
    } catch {
      // valor malformado: mantém o padrão
    }
  }
  aplicarVisibilidade(raiz, valores);
  return documento;
}

// ---------------------------------------------------------------------------
// Esquema

/** Chave de visibilidade de um grupo ocultável. */
export function chaveVisibilidade(idGrupo) {
  return `grupo.${idGrupo}.visivel`;
}

/** Rótulo legível a partir de uma chave ("quem-somos.botao-texto" → "Botão texto"). */
export function rotuloDeChave(chave, prefixo) {
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
  if (tipo === 'lista') {
    const estado = ESTADO_LISTAS.get(el);
    const molde = itensDaLista(el)[0] || (estado && estado.molde) || null;
    campo.itemRotulo = atributo(el, 'data-cms-item-rotulo').trim() || 'Item';
    campo.campos = molde ? descreverCamposDoItem(molde) : [];
  }
  return campo;
}

/**
 * Descobre grupos e campos do template, na ordem do documento.
 * → { grupos: [{ id, rotulo, ocultavel, chaveVisivel, campos: [Campo] }] }
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
      grupo = { id, rotulo: '', ocultavel: false, chaveVisivel: null, campos: [] };
      grupos.set(id, grupo);
    }
    if (el) {
      if (!grupo.rotulo) grupo.rotulo = atributo(el, 'data-cms-grupo-rotulo').trim();
      if (temAtributo(el, 'data-cms-ocultavel')) {
        grupo.ocultavel = true;
        grupo.chaveVisivel = chaveVisibilidade(id);
      }
    }
    return grupo;
  };

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

  const lista = [];
  for (const grupo of grupos.values()) {
    if (!grupo.campos.length) continue;
    if (!grupo.rotulo) grupo.rotulo = grupo.id === 'geral' ? 'Geral' : rotuloDeChave(grupo.id);
    lista.push(grupo);
  }
  return { grupos: lista };
}

/**
 * Valores padrão de todos os campos ({ chave: padrao }), incluindo
 * `grupo.<id>.visivel: true` dos grupos ocultáveis. Aceita um esquema ou um documento.
 */
export function valoresPadrao(esquemaOuDocumento) {
  const esquema = raizDe(esquemaOuDocumento) ? extrairEsquema(esquemaOuDocumento) : esquemaOuDocumento;
  const valores = {};
  const grupos = esquema && Array.isArray(esquema.grupos) ? esquema.grupos : [];
  for (const grupo of grupos) {
    if (!grupo || !Array.isArray(grupo.campos)) continue;
    if (grupo.ocultavel) valores[chaveVisibilidade(grupo.id)] = true;
    for (const campo of grupo.campos) {
      if (campo && typeof campo.chave === 'string') valores[campo.chave] = clonarJson(campo.padrao);
    }
  }
  return valores;
}

function clonarJson(valor) {
  if (Array.isArray(valor)) return valor.map(clonarJson);
  if (objetoSimples(valor)) {
    const copia = {};
    for (const chave of Object.keys(valor)) copia[chave] = clonarJson(valor[chave]);
    return copia;
  }
  return valor;
}
