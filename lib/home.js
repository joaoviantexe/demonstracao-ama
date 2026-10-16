// Home do site (docs/ARQUITETURA.md §5.1).
// O HTML final da home é montado pelo painel, no navegador (public/admin/js/publicar-home.js), com o mesmo
// motor do CMS, e gravado no armazenamento (CHAVE_HOME). Assim o servidor só entrega um arquivo pronto:
// no plano gratuito do Cloudflare cada requisição tem 10 ms de CPU, pouco para montar a página.
// Antes de gravar, validarHomePublicada() confere que o HTML não traz nada executável além do template.

let templateFixo = null;
const leituras = new Map();

/** Define o texto do template (o Worker do Cloudflare embute templates/home.html no pacote). */
export function definirTemplateHome(texto) {
  templateFixo = typeof texto === 'string' ? texto : null;
}

/** Texto de templates/home.html: o definido acima ou lido do disco (servidor local e testes, a partir do cwd). */
export async function lerTemplateHome() {
  if (templateFixo !== null) return templateFixo;
  const [{ readFile }, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
  const arquivo = path.join(process.cwd(), 'templates', 'home.html');
  if (!leituras.has(arquivo)) {
    const leitura = readFile(arquivo, 'utf8');
    leituras.set(arquivo, leitura);
    leitura.catch(() => leituras.delete(arquivo));
  }
  return leituras.get(arquivo);
}

/**
 * WhatsApp e Facebook só mostram a imagem do link com endereço completo:
 * transforma o og:image que começa com "/" em <SITE_URL>/... (siteUrl já é uma origem normalizada).
 */
export function ogImagemAbsoluta(html, siteUrl) {
  if (!siteUrl) return html;
  return html.replace(/<meta\b[^>]*>/gi, (tag) => {
    if (!/\bproperty\s*=\s*["']og:image["']/i.test(tag)) return tag;
    return tag.replace(/(\bcontent\s*=\s*["'])\/(?![\/\\])/i, (_, inicio) => `${inicio}${siteUrl}/`);
  });
}

// ---------------------------------------------------------------------------
// Leitura das tags de um HTML serializado (sem montar a árvore: precisa ser barato no Worker).

const TEXTO_CRU = new Set(['script', 'style', 'textarea', 'title']);

function decodificarEntidades(valor) {
  return valor
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(Math.min(Number.parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
    .replace(/&colon;/gi, ':').replace(/&tab;/gi, '\t').replace(/&newline;/gi, '\n')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function lerAtributos(html, inicio) {
  const atributos = [];
  let i = inicio;
  const n = html.length;
  while (i < n) {
    while (i < n && /[\s/]/.test(html[i])) i += 1;
    if (i >= n || html[i] === '>') break;
    let nome = '';
    while (i < n && !/[\s/>=]/.test(html[i])) nome += html[i++];
    while (i < n && /\s/.test(html[i])) i += 1;
    let valor = '';
    if (html[i] === '=') {
      i += 1;
      while (i < n && /\s/.test(html[i])) i += 1;
      const aspas = html[i];
      if (aspas === '"' || aspas === "'") {
        const fim = html.indexOf(aspas, i + 1);
        const ate = fim === -1 ? n : fim;
        valor = html.slice(i + 1, ate);
        i = ate + 1;
      } else {
        while (i < n && !/[\s>]/.test(html[i])) valor += html[i++];
      }
    }
    if (nome) atributos.push({ nome: nome.toLowerCase(), valor: decodificarEntidades(valor) });
  }
  return { atributos, fim: i };
}

/** Tags de abertura do HTML, na ordem: [{ nome, atributos: [{ nome, valor }], bruto }]. */
export function lerTags(html) {
  const tags = [];
  const n = html.length;
  let minusculo = null;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    if (html.startsWith('<!--', lt)) {
      const fim = html.indexOf('-->', lt + 4);
      i = fim === -1 ? n : fim + 3;
      continue;
    }
    const proximo = html[lt + 1];
    if (proximo === '!' || proximo === '?' || proximo === '/') {
      const fim = html.indexOf('>', lt + 1);
      i = fim === -1 ? n : fim + 1;
      continue;
    }
    if (!/[a-z]/i.test(proximo || '')) {
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(html[j])) j += 1;
    const nome = html.slice(lt + 1, j).toLowerCase();
    const { atributos, fim } = lerAtributos(html, j);
    const fimTag = Math.min(fim + 1, n);
    tags.push({ nome, atributos, bruto: html.slice(lt, fimTag) });
    i = fimTag;
    if (TEXTO_CRU.has(nome)) {
      if (minusculo === null) minusculo = html.toLowerCase();
      const fechamento = minusculo.indexOf(`</${nome}`, i);
      i = fechamento === -1 ? n : fechamento;
    }
  }
  return tags;
}

// ---------------------------------------------------------------------------
// Validação da home publicada

/** Tags que o editor de texto formatado (sanitizarHtml do CMS) pode gerar, além das do template. */
const TAGS_DO_EDITOR = ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'h3', 'h4', 'span'];
const ATRIBUTOS_DE_URL = new Set(['href', 'src', 'poster', 'action', 'formaction', 'xlink:href', 'data', 'background', 'srcset']);
const HOSTS_DE_IFRAME = new Set(['www.instagram.com', 'instagram.com']);
/** Tamanho máximo da home publicada. */
export const LIMITE_HOME_BYTES = 1_000_000;

const normalizarUrl = (valor) => valor.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();

function urlPerigosa(nome, valor) {
  const partes = nome === 'srcset' ? valor.split(',').map((p) => p.trim().split(/\s+/)[0] || '') : [valor];
  return partes.some((p) => /^(?:javascript|vbscript|data|file):/.test(normalizarUrl(p)));
}

// Mesma tag escrita de jeitos diferentes (ordem dos atributos, async vs async="") → mesma assinatura.
function assinatura(tag) {
  const atributos = tag.atributos.map((a) => `${a.nome}=${JSON.stringify(a.valor)}`).sort();
  return `<${tag.nome} ${atributos.join(' ')}>`;
}

function contar(lista) {
  const mapa = new Map();
  for (const item of lista) mapa.set(item, (mapa.get(item) || 0) + 1);
  return mapa;
}

/**
 * Confere a home montada pelo painel contra o template. → mensagem de erro (string) ou null se está ok.
 * Regras: só tags do template ou do editor de texto; <script>, <link>, <style> e <base> só como no template;
 * nenhum atributo on* nem srcdoc; nenhuma URL javascript:/data:/vbscript:; <iframe> só do Instagram (https);
 * <meta http-equiv> só como no template; <title> exatamente um.
 */
export function validarHomePublicada(html, template) {
  if (typeof html !== 'string' || !html.trim()) return 'A página está vazia.';
  if (new TextEncoder().encode(html).length > LIMITE_HOME_BYTES) return 'A página passou do tamanho máximo.';
  if (!/^\s*<!doctype html>/i.test(html) || !/<\/html>\s*$/i.test(html)) return 'A página não é um documento HTML completo.';

  const tagsTemplate = lerTags(template);
  const permitidas = new Set([...tagsTemplate.map((t) => t.nome), ...TAGS_DO_EDITOR]);
  const controladas = (t) => ['script', 'link', 'style', 'base'].includes(t.nome)
    || (t.nome === 'meta' && t.atributos.some((a) => a.nome === 'http-equiv'));
  const doTemplate = contar(tagsTemplate.filter(controladas).map(assinatura));

  const tags = lerTags(html);
  for (const [chave, quantidade] of contar(tags.filter(controladas).map(assinatura))) {
    if (quantidade > (doTemplate.get(chave) || 0)) return `Elemento não permitido: ${chave.slice(0, 160)}`;
  }
  if (tags.filter((t) => t.nome === 'title').length !== 1) return 'A página precisa de exatamente um título.';

  for (const tag of tags) {
    if (!permitidas.has(tag.nome)) return `Elemento não permitido: <${tag.nome}>`;
    for (const { nome, valor } of tag.atributos) {
      if (nome.startsWith('on') || nome === 'srcdoc') return `Atributo não permitido: ${nome} em <${tag.nome}>`;
      if (ATRIBUTOS_DE_URL.has(nome) && urlPerigosa(nome, valor)) return `Endereço não permitido em <${tag.nome} ${nome}>`;
    }
    if (tag.nome === 'iframe') {
      const src = (tag.atributos.find((a) => a.nome === 'src') || {}).valor || '';
      let url = null;
      try { url = new URL(src); } catch { url = null; }
      if (!url || url.protocol !== 'https:' || !HOSTS_DE_IFRAME.has(url.hostname)) {
        return 'Só publicações do Instagram podem ser incorporadas.';
      }
    }
  }
  return null;
}
