// #/produtos, #/produtos/novo e #/produtos/<id> — catálogo da loja (docs/ARQUITETURA.md §4.1 e §8).
// Lista com busca, filtros, ordenação e "à venda" direto na linha; formulário do produto (fotos,
// preço, estoque, publicação) e apagar.
// As funções puras do começo do arquivo são testadas em tests/unit/painel-produtos.test.js.

import { formatarPreco, lerPreco, moverItem, slugify } from '../ui.js';

// ---------------------------------------------------------------------------
// Regras (iguais aos checks do banco: supabase/migrations/20261009120000_inicial.sql)

export const SLUG_VALIDO = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_NOME = 120;
export const MAX_SLUG = 120;
export const MAX_DESCRICAO = 10000; // a loja mostra até 10.000 caracteres
export const MAX_SKU = 60;
export const MAX_ALT = 300; // a loja corta o texto alternativo em 300
export const MAX_IMAGENS = 12; // a loja mostra até 12 fotos
export const MAIOR_INT = 2147483647; // colunas int do Postgres
export const MAIOR_MEDIDA = 99999.9; // numeric(6,1)
export const ESTOQUE_BAIXO = 3;

/** Explicação combinada com a AMA para produto sem preço (a loja não usa "Em breve"). */
export const EXPLICACAO_SEM_PRECO = 'aparece na loja com R$ 00,00 e ninguém consegue finalizar a compra até você definir o preço';

/** Padrões do banco para o frete (iguais a configuracoes.frete.embalagem_padrao). */
export const MEDIDAS_PADRAO = Object.freeze({ peso_gramas: 300, altura_cm: 4, largura_cm: 12, comprimento_cm: 16 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Endereço (slug)

/** "Creme de Cupuaçu 200 mL" → "creme-de-cupuacu-200-ml" (até 80 caracteres). */
export function gerarSlug(texto) {
  return slugify(texto, { max: 80 });
}

/** Mensagem de erro do endereço, ou null se ele for aceito pelo banco. */
export function erroSlug(slug) {
  const s = String(slug ?? '').trim();
  if (!s) return 'Informe o endereço. Ele é criado a partir do nome: só letras, números e hífens.';
  if (s.length > MAX_SLUG) return `Use no máximo ${MAX_SLUG} caracteres (agora tem ${s.length}).`;
  if (!SLUG_VALIDO.test(s)) return 'Use só letras minúsculas sem acento, números e hífens (ex.: creme-de-cupuacu).';
  return null;
}

/** Primeiro endereço livre: "base", "base-2", "base-3"… (respeitando 120 caracteres). */
export function sugerirSlug(base, existentes = []) {
  const usados = new Set(existentes);
  const raiz = (gerarSlugLongo(base) || 'produto').slice(0, MAX_SLUG).replace(/-+$/, '');
  if (!usados.has(raiz)) return raiz;
  for (let n = 2; n < 10000; n += 1) {
    const fim = `-${n}`;
    const candidato = `${raiz.slice(0, MAX_SLUG - fim.length).replace(/-+$/, '')}${fim}`;
    if (!usados.has(candidato)) return candidato;
  }
  return `${raiz.slice(0, MAX_SLUG - 14)}-${Date.now().toString(36)}`;
}

function gerarSlugLongo(texto) {
  return slugify(texto, { max: MAX_SLUG });
}

// ---------------------------------------------------------------------------
// Números digitados

/** "3" → 3; "1.000" → 1000; "" → { vazio }. Texto inválido → valor null. */
export function lerInteiro(texto) {
  const s = String(texto ?? '').replace(/\s+/g, '');
  if (!s) return { vazio: true, valor: null };
  let digitos;
  if (/^-?\d+$/.test(s)) digitos = s;
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) digitos = s.replace(/\./g, '');
  else return { vazio: false, valor: null };
  const n = Number(digitos);
  return { vazio: false, valor: Number.isSafeInteger(n) ? n : null };
}

/** "4,5" → 4.5; "12" → 12; "4.5" → 4.5; "" → { vazio }. Texto inválido → valor null. */
export function lerDecimal(texto) {
  const s = String(texto ?? '').replace(/\s+/g, '');
  if (!s) return { vazio: true, valor: null };
  if (!/^-?\d+([.,]\d+)?$/.test(s)) return { vazio: false, valor: null };
  const n = Number(s.replace(',', '.'));
  return { vazio: false, valor: Number.isFinite(n) ? n : null };
}

/** 4 → "4"; 4.5 → "4,5" (para mostrar no campo). */
export function formatarDecimal(numero) {
  const n = Number(numero);
  if (!Number.isFinite(n)) return '';
  const arredondado = Math.round(n * 10) / 10;
  return Number.isInteger(arredondado) ? String(arredondado) : String(arredondado).replace('.', ',');
}

const umaCasa = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Fotos

/** Endereço de foto aceito: caminho do site (/img/…) ou http(s) sem espaços, aspas ou <>. */
export function imagemValida(src) {
  const url = String(src ?? '').trim();
  if (!url || url.length > 2000 || /[\u0000- \u007f"'<>`\\]/.test(url)) return false;
  if (url.startsWith('/')) return !url.startsWith('//');
  try {
    const u = new URL(url);
    return (u.protocol === 'https:' || u.protocol === 'http:') && Boolean(u.hostname);
  } catch {
    return false;
  }
}

/** Lista do banco → [{ src, alt }] só com textos (itens estranhos são descartados). */
export function normalizarImagens(lista) {
  return (Array.isArray(lista) ? lista : [])
    .map((img) => (typeof img === 'string' ? { src: img, alt: '' } : img))
    .filter((img) => img && typeof img === 'object' && typeof img.src === 'string' && img.src.trim())
    .map((img) => ({ src: img.src.trim(), alt: typeof img.alt === 'string' ? img.alt : '' }));
}

/** Cópia com a foto de `de` em `para` (a primeira é a capa). */
export function moverImagem(imagens, de, para) {
  return moverItem(imagens, de, para);
}

/** Cópia sem a foto do índice informado. */
export function removerImagem(imagens, indice) {
  return (imagens || []).filter((_, i) => i !== indice);
}

/**
 * Junta fotos novas no fim, sem repetir endereço e sem passar do máximo.
 * → { imagens, adicionadas, repetidas, excedentes }
 */
export function adicionarImagens(imagens, novas, maximo = MAX_IMAGENS) {
  const lista = [...(imagens || [])];
  let adicionadas = 0;
  let repetidas = 0;
  let excedentes = 0;
  for (const nova of novas || []) {
    const src = String(nova && nova.src ? nova.src : '').trim();
    if (!src) continue;
    if (lista.some((img) => img.src === src)) {
      repetidas += 1;
      continue;
    }
    if (lista.length >= maximo) {
      excedentes += 1;
      continue;
    }
    lista.push({ src, alt: String((nova && nova.alt) || '') });
    adicionadas += 1;
  }
  return { imagens: lista, adicionadas, repetidas, excedentes };
}

// ---------------------------------------------------------------------------
// Validação e montagem do registro

/**
 * Valores do formulário (textos como foram digitados) → { campo: mensagem } (vazio = tudo certo).
 * Campos: nome, descricao, preco, estoque, ativo, destaque, categoria_id, imagens [{ src, alt }], ordem.
 * As chaves do resultado são as colunas da tabela produtos.
 */
export function validarProduto(v) {
  const erros = {};
  const nome = String(v.nome ?? '').trim();
  if (!nome) erros.nome = 'Informe o nome do produto.';
  else if (nome.length > MAX_NOME) erros.nome = `Use no máximo ${MAX_NOME} caracteres (agora tem ${nome.length}).`;

  if (String(v.descricao ?? '').trim().length > MAX_DESCRICAO) {
    erros.descricao = 'A descrição passou de 10.000 caracteres. Encurte um pouco.';
  }

  const precoTexto = String(v.preco ?? '').trim();
  const preco = lerPreco(precoTexto);
  if (!precoTexto) erros.preco_centavos = `Informe o preço. Se ainda não tiver, digite 0: o produto ${EXPLICACAO_SEM_PRECO}.`;
  else if (preco === null) erros.preco_centavos = 'Preço inválido. Digite só o valor, como 49,90.';

  const estoque = lerInteiro(v.estoque);
  if (estoque.vazio) erros.estoque = 'Informe quantas unidades há para vender (pode ser 0).';
  else if (estoque.valor === null) erros.estoque = 'Use um número inteiro, como 3.';
  else if (estoque.valor < 0) erros.estoque = 'O estoque não pode ser negativo.';
  else if (estoque.valor > MAIOR_INT) erros.estoque = 'Número grande demais.';

  const ordem = lerInteiro(v.ordem);
  if (!ordem.vazio && (ordem.valor === null || Math.abs(ordem.valor) > MAIOR_INT)) {
    erros.ordem = 'Use um número inteiro, como 1 ou 10.';
  }

  const categoria = String(v.categoria_id ?? '');
  if (categoria && !UUID.test(categoria)) erros.categoria_id = 'Escolha uma categoria da lista.';

  const imagens = Array.isArray(v.imagens) ? v.imagens : [];
  if (imagens.length > MAX_IMAGENS) {
    erros.imagens = `Use no máximo ${MAX_IMAGENS} fotos (agora são ${imagens.length}). Tire algumas.`;
  } else {
    const ruim = imagens.findIndex((img) => !img || !imagemValida(img.src));
    const longo = imagens.findIndex((img) => img && String(img.alt ?? '').trim().length > MAX_ALT);
    if (ruim >= 0) erros.imagens = `A foto ${ruim + 1} tem um endereço inválido. Tire essa foto e escolha de novo.`;
    else if (longo >= 0) erros.imagens = `A descrição da foto ${longo + 1} passou de ${MAX_ALT} caracteres. Encurte um pouco.`;
  }
  return erros;
}

/**
 * Valores já validados → registro para insert/update em produtos. Endereço (slug), promoção, SKU, medidas e
 * controle de estoque não são editados no painel: ficam como estão (padrões do banco num produto novo).
 */
export function montarRegistro(v) {
  const estoque = lerInteiro(v.estoque).valor;
  const ordem = lerInteiro(v.ordem).valor;
  return {
    nome: String(v.nome ?? '').trim(),
    descricao: String(v.descricao ?? '').trim(),
    preco_centavos: lerPreco(String(v.preco ?? '').trim()) ?? 0,
    estoque: estoque !== null && estoque >= 0 ? estoque : 0,
    ativo: v.ativo === true,
    destaque: v.destaque === true,
    categoria_id: v.categoria_id ? String(v.categoria_id) : null,
    imagens: (Array.isArray(v.imagens) ? v.imagens : []).map((img) => ({
      src: String(img.src).trim(),
      alt: String(img.alt ?? '').trim(),
    })),
    ordem: ordem ?? 0,
  };
}

const RESTRICOES = {
  produtos_nome_check: 'nome',
  produtos_preco_check: 'preco_centavos',
  produtos_estoque_check: 'estoque',
  produtos_imagens_check: 'imagens',
};

/** Nome do check do banco (erro 23514) → campo do formulário (ou null). */
export function campoDaRestricao(restricao) {
  return RESTRICOES[restricao] || null;
}

// ---------------------------------------------------------------------------
// Lista: situação, selos, filtros e ordenação

/**
 * Situação do produto como a loja enxerga (public/js/loja/produtos.js): não há promoção no painel;
 * preço efetivo 0 aparece com "R$ 00,00" e a compra é recusada; esgotado só quando há preço.
 */
export function situacaoProduto(p) {
  const preco = Number(p.preco_centavos) || 0;
  const efetivo = preco;
  const controla = p.controlar_estoque !== false;
  const estoque = Number(p.estoque) || 0;
  return {
    aVenda: p.ativo === true,
    precoEfetivo: efetivo,
    semPreco: efetivo <= 0,
    destaque: p.destaque === true,
    controlaEstoque: controla,
    semEstoque: controla && estoque <= 0,
    estoqueBaixo: controla && estoque > 0 && estoque <= ESTOQUE_BAIXO,
    semFoto: normalizarImagens(p.imagens).length === 0,
  };
}

/** Selos da lista: [{ id, texto, cor, dica }]. */
export function selosProduto(p) {
  const s = situacaoProduto(p);
  const selos = [];
  if (!s.aVenda) selos.push({ id: 'fora', texto: 'Fora da loja', cor: 'cinza', dica: 'Rascunho: não aparece na loja.' });
  if (s.semPreco) selos.push({ id: 'sem-preco', texto: 'Sem preço', cor: 'ambar', dica: `Sem preço: ${EXPLICACAO_SEM_PRECO}.` });
  if (s.semEstoque) {
    selos.push({
      id: 'sem-estoque', texto: 'Sem estoque', cor: 'vermelho',
      dica: s.semPreco
        ? 'Estoque zerado. Quando definir o preço, informe também o estoque; senão ele aparece como esgotado.'
        : 'Aparece na loja como esgotado: ninguém consegue comprar até você repor o estoque.',
    });
  }
  if (s.destaque) selos.push({ id: 'destaque', texto: 'Destaque', cor: 'azul', dica: 'Aparece entre os primeiros da loja.' });
  return selos;
}

/** Filtro de situação da lista. */
export const SITUACOES = Object.freeze([
  { id: '', rotulo: 'Todas as situações', teste: () => true },
  { id: 'a-venda', rotulo: 'À venda', teste: (s) => s.aVenda },
  { id: 'fora', rotulo: 'Fora da loja', teste: (s) => !s.aVenda },
  { id: 'sem-preco', rotulo: 'Sem preço', teste: (s) => s.semPreco },
  { id: 'sem-estoque', rotulo: 'Sem estoque', teste: (s) => s.semEstoque },
  { id: 'estoque-baixo', rotulo: `Estoque baixo (até ${ESTOQUE_BAIXO})`, teste: (s) => s.estoqueBaixo },
  { id: 'destaque', rotulo: 'Destaques', teste: (s) => s.destaque },
]);

/** Ordenação da lista. "loja" é a mesma ordem da vitrine (destaques, posição, mais novos). */
export const ORDENACOES = Object.freeze([
  { id: 'loja', rotulo: 'Ordem da loja' },
  { id: 'nome', rotulo: 'Nome (A–Z)' },
  { id: 'preco-menor', rotulo: 'Menor preço' },
  { id: 'preco-maior', rotulo: 'Maior preço' },
  { id: 'estoque', rotulo: 'Menor estoque' },
  { id: 'recentes', rotulo: 'Mais recentes' },
]);

/** Texto para busca: sem acento, minúsculo, espaços simples. */
export function normalizarBusca(texto) {
  return String(texto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Filtra por busca (nome ou endereço), categoria ('' todas, 'sem' sem categoria, id) e situação. */
export function filtrarProdutos(lista, { busca = '', categoria = '', situacao = '' } = {}) {
  const termos = normalizarBusca(busca).split(' ').filter(Boolean);
  const filtro = SITUACOES.find((s) => s.id === situacao) || SITUACOES[0];
  return (lista || []).filter((p) => {
    if (categoria === 'sem' ? p.categoria_id : categoria && p.categoria_id !== categoria) return false;
    if (!filtro.teste(situacaoProduto(p))) return false;
    if (!termos.length) return true;
    const alvo = normalizarBusca(`${p.nome} ${p.slug}`);
    return termos.every((t) => alvo.includes(t));
  });
}

const compararNome = (a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR', { sensitivity: 'base' });
const tempo = (p) => {
  const t = Date.parse(p.criado_em || '');
  return Number.isNaN(t) ? 0 : t;
};

/** Cópia ordenada. Nos critérios de preço, os produtos sem preço vão para o fim (como na loja). */
export function ordenarProdutos(lista, criterio = 'loja') {
  const copia = [...(lista || [])];
  const preco = (p) => situacaoProduto(p).precoEfetivo;
  const comparadores = {
    loja: (a, b) => (b.destaque === true) - (a.destaque === true) || (Number(a.ordem) || 0) - (Number(b.ordem) || 0) || tempo(b) - tempo(a),
    nome: compararNome,
    'preco-menor': (a, b) => (preco(a) <= 0) - (preco(b) <= 0) || preco(a) - preco(b),
    'preco-maior': (a, b) => (preco(a) <= 0) - (preco(b) <= 0) || preco(b) - preco(a),
    estoque: (a, b) => (a.controlar_estoque === false) - (b.controlar_estoque === false) || (Number(a.estoque) || 0) - (Number(b.estoque) || 0),
    recentes: (a, b) => tempo(b) - tempo(a),
  };
  const comparar = comparadores[criterio] || comparadores.loja;
  return copia.sort((a, b) => comparar(a, b) || compararNome(a, b));
}

/** Quantos produtos há em cada situação do filtro: { 'a-venda': 3, … }. */
export function contarPorSituacao(lista) {
  const contagem = {};
  for (const s of SITUACOES) contagem[s.id] = 0;
  for (const p of lista || []) {
    const s = situacaoProduto(p);
    for (const f of SITUACOES) if (f.teste(s)) contagem[f.id] += 1;
  }
  return contagem;
}

/** Texto da confirmação ao ligar/desligar "à venda" na lista. */
export function mensagemAlternarAtivo(p, novo) {
  if (!novo) {
    return `Tirar "${p.nome}" da loja? Ele some da loja na hora, mas continua guardado aqui no painel e pode voltar à venda quando você quiser. Pedidos já feitos não mudam.`;
  }
  const s = situacaoProduto(p);
  const partes = [`Colocar "${p.nome}" à venda? Ele aparece na loja na hora.`];
  if (s.semPreco) partes.push(`Como está sem preço, ele ${EXPLICACAO_SEM_PRECO}.`);
  else if (s.semEstoque) partes.push('O estoque está zerado: ele aparece como esgotado e ninguém consegue comprar até você repor.');
  if (s.semFoto) partes.push('Ele ainda não tem foto.');
  return partes.join(' ');
}

/** Consulta da lista: só o necessário para a tabela e os filtros. */
const COLUNAS_LISTA = 'id, nome, slug, preco_centavos, preco_promocional_centavos, estoque, controlar_estoque, ativo, destaque, categoria_id, imagens, ordem, criado_em';
const COLUNAS_CATEGORIAS = 'id, nome, ativo, ordem';

// ---------------------------------------------------------------------------
// Página

export async function renderizar(ctx) {
  if (ctx.params.id) return renderizarFormulario(ctx);
  return renderizarLista(ctx);
}

// ---------------------------------------------------------------------------
// Lista #/produtos

async function renderizarLista(ctx) {
  const { ui, api, supabase } = ctx;
  const { el } = ui;
  const consulta = ctx.consulta || {};
  const filtros = {
    busca: consulta.busca || '',
    categoria: consulta.categoria || '',
    situacao: SITUACOES.some((s) => s.id === consulta.situacao) ? consulta.situacao : '',
    ordem: ORDENACOES.some((o) => o.id === consulta.ordem) ? consulta.ordem : 'loja',
  };
  let produtos = [];
  let categorias = [];
  let carregado = false;

  ctx.raiz.append(ui.cabecalhoPagina({
    titulo: 'Produtos',
    descricao: 'Cadastre os produtos, mude preços e estoque e escolha o que fica à venda na loja.',
    acoes: [
      ui.botao({ texto: 'Categorias', icone: 'categorias', href: '#/categorias' }),
      ui.botao({ texto: 'Novo produto', tipo: 'primario', icone: 'mais', href: '#/produtos/novo' }),
    ],
  }));
  const css = ui.carregarCss('produtos');

  const busca = el('input', {
    type: 'search', class: 'entrada', placeholder: 'Buscar pelo nome ou código…', 'aria-label': 'Buscar produtos',
    value: filtros.busca, enterkeyhint: 'search', autocomplete: 'off',
  });
  const selCategoria = el('select', { class: 'entrada', 'aria-label': 'Filtrar por categoria' });
  const selSituacao = el('select', { class: 'entrada', 'aria-label': 'Filtrar por situação' });
  const selOrdem = el('select', { class: 'entrada', 'aria-label': 'Ordenar a lista' },
    ORDENACOES.map((o) => el('option', { value: o.id }, `Ordenar: ${o.rotulo}`)));
  selOrdem.value = filtros.ordem;
  const contador = el('p', { class: 'produtos-contador', 'aria-live': 'polite' });
  const avisos = el('div', { class: 'pilha pilha--estreita produtos-avisos' });
  const corpo = el('div', { class: 'cartao__corpo cartao__corpo--sem-espaco' });
  ctx.raiz.append(
    avisos,
    el('section', { class: 'cartao', 'aria-label': 'Lista de produtos' },
      el('div', { class: 'cartao__corpo produtos-filtros' },
        el('div', { class: 'filtros' }, el('div', { class: 'filtros__busca' }, ui.icone('busca'), busca), selCategoria, selSituacao, selOrdem),
        contador),
      corpo),
  );

  function nomeCategoria(id) {
    const c = categorias.find((x) => x.id === id);
    return c ? c.nome : '';
  }

  function preencherFiltros() {
    selCategoria.replaceChildren(
      el('option', { value: '' }, 'Todas as categorias'),
      ...categorias.map((c) => el('option', { value: c.id }, c.nome)),
      el('option', { value: 'sem' }, 'Sem categoria'),
    );
    if (filtros.categoria && filtros.categoria !== 'sem' && !categorias.some((c) => c.id === filtros.categoria)) filtros.categoria = '';
    selCategoria.value = filtros.categoria;
    const contagem = contarPorSituacao(produtos);
    selSituacao.replaceChildren(...SITUACOES.map((s) => el('option', { value: s.id }, s.id ? `${s.rotulo} (${contagem[s.id]})` : s.rotulo)));
    selSituacao.value = filtros.situacao;
  }

  function guardarFiltrosNaUrl() {
    const p = new URLSearchParams();
    if (filtros.busca.trim()) p.set('busca', filtros.busca.trim());
    if (filtros.categoria) p.set('categoria', filtros.categoria);
    if (filtros.situacao) p.set('situacao', filtros.situacao);
    if (filtros.ordem !== 'loja') p.set('ordem', filtros.ordem);
    const texto = p.toString();
    ctx.navegar(`#/produtos${texto ? `?${texto}` : ''}`, { silencioso: true });
  }

  function limparFiltros() {
    Object.assign(filtros, { busca: '', categoria: '', situacao: '' });
    busca.value = '';
    selCategoria.value = '';
    selSituacao.value = '';
    guardarFiltrosNaUrl();
    desenhar();
    busca.focus();
  }

  function desenharAvisos() {
    const semPreco = produtos.filter((p) => p.ativo && situacaoProduto(p).semPreco).length;
    if (!semPreco || filtros.situacao === 'sem-preco') {
      avisos.replaceChildren();
      return;
    }
    const verQuais = ui.botao({
      texto: 'Ver quais', tipo: 'secundario', tamanho: 'pequeno', classe: 'produtos-avisos__botao',
      aoClicar: () => {
        filtros.situacao = 'sem-preco';
        selSituacao.value = 'sem-preco';
        guardarFiltrosNaUrl();
        desenhar();
      },
    });
    const texto = semPreco === 1
      ? `1 produto à venda está sem preço: ${EXPLICACAO_SEM_PRECO}.`
      : `${semPreco} produtos à venda estão sem preço: cada um ${EXPLICACAO_SEM_PRECO}.`;
    avisos.replaceChildren(ui.aviso(el('div', { class: 'produtos-avisos__texto' }, el('span', {}, texto), verQuais), 'alerta', { titulo: 'Produtos sem preço' }));
  }

  function celulaProduto(p) {
    const capa = normalizarImagens(p.imagens)[0];
    const categoria = nomeCategoria(p.categoria_id);
    return el('div', { class: 'produto-celula' },
      el('div', { class: 'produto-celula__foto' },
        capa ? el('img', { src: capa.src, alt: '', loading: 'lazy', decoding: 'async' }) : ui.icone('imagem', { rotulo: 'Sem foto' })),
      el('div', { class: 'produto-celula__textos' },
        el('a', { class: 'produto-celula__nome', href: `#/produtos/${p.id}` }, p.nome),
        el('span', { class: 'produto-celula__detalhe' },
          el('span', { class: 'so-celular' }, categoria || 'Sem categoria'))));
  }

  function celulaPreco(p) {
    const s = situacaoProduto(p);
    if (s.semPreco) {
      return el('span', { class: 'produto-preco produto-preco--zero', title: `Sem preço: ${EXPLICACAO_SEM_PRECO}` }, 'R$\u00a000,00');
    }
    return el('span', { class: 'produto-preco' }, formatarPreco(p.preco_centavos));
  }

  function celulaEstoque(p) {
    const s = situacaoProduto(p);
    if (!s.controlaEstoque) return el('span', { class: 'texto-suave', title: 'Estoque não controlado: vende sem limite' }, 'Sem limite');
    return el('span', { class: ['produto-estoque', s.semEstoque && 'produto-estoque--zero', s.estoqueBaixo && 'produto-estoque--baixo'] },
      String(Number(p.estoque) || 0));
  }

  function celulaSelos(p) {
    const selos = selosProduto(p);
    if (!selos.length) return el('span', { class: 'produto-selos-vazio texto-suave' }, '—');
    return el('div', { class: 'produto-selos' }, selos.map((s) => el('span', { class: ['selo', `selo--${s.cor}`], title: s.dica }, s.texto)));
  }

  function interruptorAtivo(p) {
    const entrada = el('input', {
      type: 'checkbox', role: 'switch', class: 'interruptor__entrada', checked: p.ativo,
      'aria-label': `À venda: ${p.nome}`, dataset: { id: p.id },
    });
    entrada.addEventListener('click', (evento) => {
      // O estado só muda depois da confirmação e do banco.
      evento.preventDefault();
      alternarAtivo(p, entrada);
    });
    return el('label', { class: 'interruptor produto-interruptor' },
      entrada, el('span', { class: 'interruptor__trilho', 'aria-hidden': 'true' }),
      el('span', { class: 'interruptor__texto', 'aria-hidden': 'true' }, p.ativo ? 'Sim' : 'Não'));
  }

  async function alternarAtivo(p, entrada) {
    if (entrada.disabled) return;
    const novo = !p.ativo;
    const sim = await ui.confirmar(mensagemAlternarAtivo(p, novo), {
      titulo: novo ? 'Colocar à venda?' : 'Tirar da loja?',
      textoConfirmar: novo ? 'Colocar à venda' : 'Tirar da loja',
    });
    if (!sim || !ctx.ativo()) return;
    entrada.disabled = true;
    const r = await api.consultar(supabase.from('produtos').update({ ativo: novo }).eq('id', p.id).select('id, ativo').maybeSingle());
    if (!ctx.ativo()) return;
    entrada.disabled = false;
    if (!r.ok) {
      ui.toast(r.mensagem, 'erro');
      return;
    }
    if (!r.dados) {
      ui.toast('Este produto não existe mais. A lista foi atualizada.', 'aviso');
      carregar({ silencioso: true });
      return;
    }
    p.ativo = r.dados.ativo === true;
    ui.toast(p.ativo ? `"${p.nome}" está à venda na loja.` : `"${p.nome}" saiu da loja.`, 'sucesso');
    desenhar();
    const igual = corpo.querySelector(`input[data-id="${p.id}"]`);
    if (igual) igual.focus();
  }

  function desenhar() {
    if (!carregado) return;
    preencherFiltros();
    desenharAvisos();
    const visiveis = ordenarProdutos(filtrarProdutos(produtos, filtros), filtros.ordem);
    const filtrando = Boolean(filtros.busca.trim() || filtros.categoria || filtros.situacao);
    contador.textContent = !produtos.length ? ''
      : filtrando ? `Mostrando ${visiveis.length} de ${produtos.length} ${produtos.length === 1 ? 'produto' : 'produtos'}`
      : `${produtos.length} ${produtos.length === 1 ? 'produto' : 'produtos'}`;
    if (!produtos.length) {
      ui.estadoVazio(corpo, 'Cadastre o primeiro produto da loja: nome, preço, fotos e estoque.', {
        titulo: 'Nenhum produto ainda', icone: 'produtos', acao: { texto: 'Novo produto', href: '#/produtos/novo', icone: 'mais' },
      });
      return;
    }
    if (!visiveis.length) {
      ui.estadoVazio(corpo, 'Nenhum produto encontrado com esses filtros. Confira a busca ou limpe os filtros.', {
        titulo: 'Nada encontrado', icone: 'busca', acao: { texto: 'Limpar filtros', tipo: 'secundario', icone: 'fechar', aoClicar: limparFiltros },
      });
      return;
    }
    corpo.replaceChildren(ui.tabela({
      legenda: 'Produtos da loja',
      classe: 'produtos-tabela',
      linhas: visiveis,
      colunas: [
        { titulo: 'Produto', principal: true, celula: celulaProduto },
        { titulo: 'Categoria', ocultarNoCelular: true, celula: (p) => nomeCategoria(p.categoria_id) || el('span', { class: 'texto-suave' }, 'Sem categoria') },
        { titulo: 'Preço', alinhar: 'direita', celula: celulaPreco },
        { titulo: 'Estoque', alinhar: 'direita', celula: celulaEstoque },
        { titulo: 'Situação', celula: celulaSelos, classe: 'produtos-col-situacao' },
        { titulo: 'À venda', celula: interruptorAtivo, classe: 'produtos-col-venda' },
        {
          titulo: 'Ações', alinhar: 'direita', classe: 'produtos-col-acoes',
          celula: (p) => ui.botao({ texto: 'Editar', tamanho: 'pequeno', icone: 'editar', href: `#/produtos/${p.id}`, rotulo: `Editar ${p.nome}` }),
        },
      ],
    }));
  }

  async function carregar({ silencioso = false } = {}) {
    if (!silencioso) ui.estadoCarregando(corpo, { linhas: 6, tipo: 'tabela', mensagem: 'Carregando produtos…' });
    const [rp, rc] = await Promise.all([
      api.consultar(supabase.from('produtos').select(COLUNAS_LISTA).order('ordem').order('criado_em', { ascending: false }).limit(1000)),
      api.consultar(supabase.from('categorias').select(COLUNAS_CATEGORIAS).order('ordem').order('nome')),
      css,
    ]);
    if (!ctx.ativo()) return;
    if (!rp.ok) {
      if (silencioso && carregado) return;
      contador.textContent = '';
      avisos.replaceChildren();
      ui.estadoErro(corpo, rp.mensagem, { titulo: 'Não foi possível carregar os produtos', aoTentarNovamente: () => carregar() });
      return;
    }
    produtos = rp.dados || [];
    if (rc.ok) categorias = rc.dados || [];
    carregado = true;
    desenhar();
  }

  // Aplica os filtros (a busca digitada entra junto, sem esperar o atraso da digitação).
  function aplicarFiltros() {
    buscar.cancelar();
    filtros.busca = busca.value;
    filtros.categoria = selCategoria.value;
    filtros.situacao = selSituacao.value;
    filtros.ordem = selOrdem.value;
    guardarFiltrosNaUrl();
    desenhar();
  }
  const buscar = ui.debounce(aplicarFiltros, 250);
  busca.addEventListener('input', buscar);
  for (const s of [selCategoria, selSituacao, selOrdem]) s.addEventListener('change', aplicarFiltros);

  // Volta para a aba do navegador: atualiza sem piscar a tela.
  const aoVoltar = () => {
    if (document.visibilityState === 'visible' && carregado) carregar({ silencioso: true });
  };
  document.addEventListener('visibilitychange', aoVoltar);

  await carregar();

  return () => {
    buscar.cancelar();
    document.removeEventListener('visibilitychange', aoVoltar);
  };
}

// ---------------------------------------------------------------------------
// Formulário #/produtos/novo e #/produtos/<id>

async function renderizarFormulario(ctx) {
  const { ui, api, supabase, midia } = ctx;
  const { el } = ui;
  const novo = ctx.params.id === 'novo';

  const cabecalho = ui.cabecalhoPagina({
    titulo: novo ? 'Novo produto' : 'Produto',
    descricao: novo ? 'Preencha os dados e salve. Os campos com * são obrigatórios.' : 'Carregando…',
    voltar: { href: '#/produtos', texto: 'Produtos' },
  });
  const corpo = el('div', { class: 'pilha' });
  ctx.raiz.append(cabecalho, corpo);
  ui.estadoCarregando(corpo, { linhas: 8, mensagem: novo ? 'Preparando o formulário…' : 'Carregando o produto…' });

  const [rp, rc] = await Promise.all([
    novo ? { ok: true, dados: null } : api.consultar(supabase.from('produtos').select('*').eq('id', ctx.params.id).maybeSingle()),
    api.consultar(supabase.from('categorias').select(COLUNAS_CATEGORIAS).order('ordem').order('nome')),
    ui.carregarCss('produtos'),
  ]);
  if (!ctx.ativo()) return undefined;
  const titulo = cabecalho.querySelector('h1');
  const descricaoTopo = cabecalho.querySelector('.pagina-cabecalho__descricao');
  if (!rp.ok) {
    descricaoTopo.textContent = '';
    ui.estadoErro(corpo, rp.mensagem, { titulo: 'Não foi possível abrir o produto', aoTentarNovamente: () => ctx.navegar(window.location.hash) });
    return undefined;
  }
  if (!novo && !rp.dados) {
    titulo.textContent = 'Produto não encontrado';
    descricaoTopo.textContent = '';
    ui.estadoVazio(corpo, 'Este produto não existe mais (pode ter sido apagado). Volte para a lista para ver os produtos atuais.', {
      titulo: 'Produto não encontrado', icone: 'produtos', acao: { texto: 'Ver produtos', href: '#/produtos', icone: 'voltar' },
    });
    return undefined;
  }
  if (!rc.ok) ui.toast(`Não foi possível carregar as categorias: ${rc.mensagem}`, 'erro');

  let produto = rp.dados; // versão salva (null enquanto o produto novo não foi salvo)
  let categorias = rc.ok ? rc.dados || [] : [];
  let imagens = produto ? normalizarImagens(produto.imagens) : [];
  let alterado = false;
  let enviando = false;
  let modalCategoria = null;

  const marcar = (sim = true) => {
    alterado = sim;
    ctx.marcarAlterado(sim);
  };

  // --- Campos -------------------------------------------------------------
  const p = produto || {};
  const nome = ui.campo({
    rotulo: 'Nome do produto', nome: 'nome', obrigatorio: true, valor: p.nome ?? '',
    attrs: { maxlength: String(MAX_NOME), autocomplete: 'off' },
  });
  const descricao = ui.campo({
    rotulo: 'Descrição', nome: 'descricao', tipo: 'textarea', linhas: 7, valor: p.descricao ?? '',
    attrs: { maxlength: String(MAX_DESCRICAO) },
  });

  const preco = ui.campo({
    rotulo: 'Preço', nome: 'preco', tipo: 'preco', obrigatorio: true, valor: produto ? produto.preco_centavos : null,
    ajuda: `Digite 0 se ainda não tiver preço: o produto ${EXPLICACAO_SEM_PRECO}.`,
  });
  const dicaPreco = el('div', { class: 'produto-dica', 'aria-live': 'polite' });
  const estoque = ui.campo({
    rotulo: 'Estoque', nome: 'estoque', valor: produto ? String(produto.estoque ?? 0) : '', sufixo: 'unidades', placeholder: 'Ex.: 10',
    ajuda: 'Quantas unidades há para vender. A cada venda paga, a loja desconta sozinha.',
    attrs: { inputmode: 'numeric', autocomplete: 'off', maxlength: '10' },
  });
  const ativo = ui.campo({
    rotulo: 'À venda na loja', nome: 'ativo', tipo: 'interruptor', valor: produto ? produto.ativo === true : true,
  });
  const destaque = ui.campo({
    rotulo: 'Mostrar entre os destaques', nome: 'destaque', tipo: 'checkbox', valor: p.destaque === true,
    ajuda: 'Produtos em destaque aparecem primeiro na loja.',
  });
  const categoria = ui.campo({
    rotulo: 'Categoria', nome: 'categoria_id', tipo: 'select', valor: '', opcoes: [{ valor: '', rotulo: 'Sem categoria' }],
  });
  const novaCategoria = ui.botao({ texto: 'Nova categoria', tamanho: 'pequeno', icone: 'mais', classe: 'produto-categoria__nova' });
  const ordem = ui.campo({
    rotulo: 'Posição na loja', nome: 'ordem', valor: String(p.ordem ?? 0),
    ajuda: 'Número menor aparece antes. Os destaques vêm sempre primeiro.', attrs: { inputmode: 'numeric', autocomplete: 'off', maxlength: '10' },
  });

  // --- Fotos --------------------------------------------------------------
  const listaFotos = el('ul', { class: 'lista-ordenavel produto-fotos', 'aria-label': 'Fotos do produto' });
  const semFotos = el('p', { class: 'produto-fotos__vazio' }, ui.icone('imagem'), 'Nenhuma foto ainda. A primeira foto que você adicionar vira a capa.');
  const contadorFotos = el('p', { class: 'texto-pequeno texto-suave', 'aria-live': 'polite' });
  const erroFotos = el('p', { class: 'campo__erro', hidden: true, role: 'alert' });
  const area = midia.criarAreaUpload({ tipo: 'imagem', multiplo: true, texto: 'Arraste as fotos para cá', aoEscolher: enviarFotos });

  // --- Montagem -----------------------------------------------------------
  const cartao = (idTitulo, tituloTexto, subtitulo, ...conteudo) => el('section', { class: 'cartao', 'aria-labelledby': idTitulo },
    el('div', { class: 'cartao__cabecalho' },
      el('h2', { class: 'cartao__titulo', id: idTitulo }, tituloTexto),
      subtitulo ? el('p', { class: 'cartao__subtitulo' }, subtitulo) : null),
    el('div', { class: 'cartao__corpo' }, ...conteudo));

  // Erros de validação aparecem aqui, ao lado do botão (um toast cobriria o próprio "Salvar").
  const INFO_BARRA = '';
  const infoBarra = el('p', { class: 'barra-acoes__info', 'aria-live': 'polite' }, INFO_BARRA);
  const avisarNaBarra = (texto) => {
    infoBarra.textContent = texto || INFO_BARRA;
    infoBarra.classList.toggle('produto-barra__erro', Boolean(texto));
  };
  const botaoSalvar = ui.botao({ texto: novo ? 'Criar produto' : 'Salvar alterações', tipo: 'primario', icone: 'check', tipoHtml: 'submit' });
  const botaoApagar = novo ? null : ui.botao({ texto: 'Apagar produto', tipo: 'perigo-suave', icone: 'lixeira', bloco: true, aoClicar: apagar });

  const form = el('form', { class: 'pilha produto-form', novalidate: true, 'aria-label': novo ? 'Novo produto' : 'Editar produto' },
    el('div', { class: 'grade grade--painel' },
      el('div', { class: 'pilha' },
        cartao('pf-dados', 'Informações', null, nome.elemento, descricao.elemento),
        cartao('pf-fotos', 'Fotos', 'A primeira foto é a capa, que aparece na vitrine. Use fotos quadradas e bem iluminadas.',
          listaFotos, semFotos, contadorFotos, erroFotos,
          el('div', { class: 'produto-fotos__envio' }, area.elemento)),
        cartao('pf-preco', 'Preço e estoque', null,
          preco.elemento,
          estoque.elemento,
          dicaPreco)),
      el('div', { class: 'pilha' },
        cartao('pf-loja', 'Na loja', null,
          ativo.elemento,
          destaque.elemento,
          el('div', { class: 'produto-categoria' }, categoria.elemento, novaCategoria),
          ordem.elemento),
        novo ? null : el('section', { class: 'cartao', 'aria-label': 'Apagar produto' }, el('div', { class: 'cartao__corpo' }, botaoApagar)))),
    el('div', { class: 'barra-acoes' },
      infoBarra,
      ui.botao({ texto: 'Cancelar', href: '#/produtos' }),
      botaoSalvar));
  corpo.replaceChildren(form);

  // --- Comportamento ------------------------------------------------------
  function preencherCategorias(selecionada) {
    const opcoes = [{ valor: '', rotulo: 'Sem categoria' }, ...categorias.map((c) => ({ valor: c.id, rotulo: c.ativo === false ? `${c.nome} (oculta na loja)` : c.nome }))];
    // Lista de categorias não carregou: mantém a do produto para salvar não apagá-la.
    if (selecionada && !categorias.some((c) => c.id === selecionada)) opcoes.push({ valor: selecionada, rotulo: 'Categoria atual (não carregada)' });
    categoria.entrada.replaceChildren(...opcoes.map((o) => el('option', { value: o.valor }, o.rotulo)));
    categoria.entrada.value = selecionada || '';
  }

  function atualizarDicaPreco() {
    const precoTexto = preco.entrada.value.trim();
    const valorPreco = precoTexto ? lerPreco(precoTexto) : null;
    const avisos = [];
    if (valorPreco === 0) {
      avisos.push(ui.aviso(`Com preço 0, o produto ${EXPLICACAO_SEM_PRECO}.`, 'alerta', { titulo: 'Sem preço' }));
    }
    const lidoEstoque = lerInteiro(estoque.entrada.value);
    if (valorPreco > 0 && lidoEstoque.valor === 0) {
      avisos.push(ui.aviso('Com estoque 0, o produto aparece na loja como esgotado e ninguém consegue comprar. Informe quantas unidades há para vender.', 'alerta', { titulo: 'Sem estoque' }));
    }
    dicaPreco.replaceChildren(...avisos);
  }

  function atualizarCabecalho() {
    if (!produto) return;
    titulo.textContent = produto.nome;
    ctx.definirTitulo(produto.nome);
    const selos = selosProduto(produto);
    if (produto.ativo) selos.unshift({ texto: 'À venda', cor: 'verde', dica: 'Aparece na loja.' });
    descricaoTopo.replaceChildren(
      ...selos.map((s) => el('span', { class: ['selo', `selo--${s.cor}`], title: s.dica }, s.texto)),
      el('span', {}, `Atualizado ${ui.tempoRelativo(produto.atualizado_em)}.`),
    );
    descricaoTopo.classList.add('produto-topo__descricao');
  }

  function montarAcoesTopo() {
    if (!produto) return;
    const verNaLoja = ui.botao({
      texto: 'Ver na loja', iconeDireita: 'externo', href: `/loja/produto?slug=${encodeURIComponent(produto.slug)}`,
      attrs: {
        target: '_blank', rel: 'noopener', 'data-ver-na-loja': '',
        'aria-disabled': produto.ativo ? null : 'true', title: produto.ativo ? null : 'Fora da loja: ligue "À venda na loja" e salve',
      },
      aoClicar: (evento) => {
        if (produto && produto.ativo) return;
        evento.preventDefault();
        ui.toast('Este produto está fora da loja. Ligue "À venda na loja" e salve para ele aparecer.', 'aviso');
      },
    });
    const linha = cabecalho.querySelector('.pagina-cabecalho__linha');
    const antigas = linha.querySelector('.pagina-cabecalho__acoes');
    if (antigas) antigas.remove();
    linha.append(el('div', { class: 'pagina-cabecalho__acoes' }, verNaLoja));
  }

  function desenharFotos({ focar } = {}) {
    semFotos.hidden = imagens.length > 0;
    contadorFotos.textContent = imagens.length ? `${imagens.length} de ${MAX_IMAGENS} fotos` : '';
    listaFotos.hidden = imagens.length === 0;
    const nomeAtual = nome.entrada.value.trim();
    listaFotos.replaceChildren(...imagens.map((img, i) => {
      const idAlt = `produto-foto-alt-${i}`;
      const alt = el('input', {
        id: idAlt, class: 'entrada produto-foto__alt', value: img.alt, maxlength: String(MAX_ALT), autocomplete: 'off',
        placeholder: nomeAtual ? `Ex.: ${nomeAtual}` : 'Ex.: frasco de 200 mL com tampa dourada',
      });
      alt.addEventListener('input', () => {
        imagens = imagens.map((x, j) => (j === i ? { ...x, alt: alt.value } : x));
      });
      const subir = ui.botao({ tipo: 'fantasma', tamanho: 'pequeno', icone: 'subir', rotulo: `Subir a foto ${i + 1}`, attrs: { disabled: i === 0, 'data-acao': 'subir' }, aoClicar: () => moverFoto(i, i - 1) });
      const descer = ui.botao({ tipo: 'fantasma', tamanho: 'pequeno', icone: 'descer', rotulo: `Descer a foto ${i + 1}`, attrs: { disabled: i === imagens.length - 1, 'data-acao': 'descer' }, aoClicar: () => moverFoto(i, i + 1) });
      const remover = ui.botao({ tipo: 'fantasma', tamanho: 'pequeno', icone: 'lixeira', rotulo: `Tirar a foto ${i + 1}`, attrs: { 'data-acao': 'remover' }, aoClicar: () => removerFoto(i) });
      return el('li', { class: 'lista-ordenavel__item produto-foto', dataset: { indice: i } },
        el('div', { class: 'lista-ordenavel__miniatura produto-foto__miniatura' }, el('img', { src: img.src, alt: '', loading: 'lazy', decoding: 'async' })),
        el('div', { class: 'lista-ordenavel__conteudo produto-foto__conteudo' },
          el('p', { class: 'produto-foto__titulo' },
            el('span', {}, `Foto ${i + 1}`),
            i === 0 ? el('span', { class: 'selo selo--ouro selo--sem-ponto' }, 'Capa') : null,
            i > 0 ? el('button', { type: 'button', class: 'botao-link produto-foto__capa', eventos: { click: () => moverFoto(i, 0) } }, 'Usar como capa') : null),
          el('label', { class: 'produto-foto__rotulo', for: idAlt }, 'Descrição da foto (para quem usa leitor de tela)'),
          alt),
        el('div', { class: 'lista-ordenavel__acoes' }, subir, descer, remover));
    }));
    if (focar !== undefined) {
      const item = listaFotos.children[Math.max(0, Math.min(focar.indice, imagens.length - 1))];
      const alvo = item && (item.querySelector(`[data-acao="${focar.acao}"]:not([disabled])`) || item.querySelector('.lista-ordenavel__acoes button:not([disabled])'));
      if (alvo) alvo.focus();
      else if (!imagens.length) area.elemento.querySelector('button')?.focus();
    }
  }

  function moverFoto(de, para) {
    imagens = moverImagem(imagens, de, para);
    marcar(true);
    erroFotos.hidden = true;
    desenharFotos({ focar: { indice: para, acao: para < de ? 'subir' : 'descer' } });
  }

  async function removerFoto(i) {
    const sim = await ui.confirmar(`Tirar a foto ${i + 1} deste produto? O arquivo continua na biblioteca de Mídia, e a mudança só vale depois de salvar.`, {
      titulo: 'Tirar foto?', textoConfirmar: 'Tirar foto', perigo: true,
    });
    if (!sim || !ctx.ativo()) return;
    imagens = removerImagem(imagens, i);
    marcar(true);
    erroFotos.hidden = true;
    desenharFotos({ focar: { indice: i, acao: 'remover' } });
  }

  function juntarFotos(novas) {
    const r = adicionarImagens(imagens, novas);
    imagens = r.imagens;
    if (r.adicionadas) {
      marcar(true);
      erroFotos.hidden = true;
      desenharFotos();
    }
    if (r.repetidas) ui.toast(r.repetidas === 1 ? 'Esta foto já está no produto.' : 'Algumas fotos já estavam no produto.', 'aviso');
    if (r.excedentes) ui.toast(`O máximo é ${MAX_IMAGENS} fotos por produto. Tire alguma antes de adicionar outra.`, 'aviso');
    return r.adicionadas;
  }

  function travarEnvio(sim) {
    enviando = sim;
    area.desativar(sim);
  }

  async function enviarFotos(arquivos) {
    if (enviando) return;
    const livres = MAX_IMAGENS - imagens.length;
    if (livres <= 0) {
      ui.toast(`Este produto já tem ${MAX_IMAGENS} fotos, o máximo. Tire alguma antes de enviar outra.`, 'aviso');
      return;
    }
    const lista = arquivos.slice(0, livres);
    if (arquivos.length > livres) ui.toast(`Só cabem mais ${livres} ${livres === 1 ? 'foto' : 'fotos'} (máximo de ${MAX_IMAGENS}). As outras não foram enviadas.`, 'aviso');
    travarEnvio(true);
    let enviadas = 0;
    try {
      for (const [i, arquivo] of lista.entries()) {
        const v = midia.validarArquivo(arquivo, { tipo: 'imagem' });
        if (!v.ok) {
          ui.toast(`${arquivo.name}: ${v.erro}`, 'erro');
          continue;
        }
        const posicao = lista.length > 1 ? ` (${i + 1} de ${lista.length})` : '';
        area.definirProgresso(0, `Preparando ${arquivo.name}${posicao}…`);
        try {
          const r = await midia.enviarArquivo(arquivo, 'produtos', {
            sinal: ctx.sinal,
            aoProgresso: ({ fracao }) => area.definirProgresso(fracao, `Enviando ${arquivo.name}${posicao}… ${Math.round(fracao * 100)}%`),
          });
          if (!ctx.ativo()) return;
          enviadas += juntarFotos([{ src: r.url, alt: '' }]);
        } catch (erro) {
          if (!ctx.ativo() || (erro && erro.codigo === 'cancelado')) return;
          ui.toast(`${arquivo.name}: ${erro && erro.message ? erro.message : 'não foi possível enviar.'}`, 'erro');
        }
      }
    } finally {
      if (ctx.ativo()) {
        area.definirProgresso(null, enviadas ? `${enviadas === 1 ? 'Foto enviada' : `${enviadas} fotos enviadas`}. Salve o produto para guardar.` : '');
        travarEnvio(false);
      }
    }
  }

  async function criarCategoria() {
    let modulo;
    try {
      modulo = await import('./categorias.js');
    } catch {
      if (ctx.ativo()) ui.toast('Não foi possível abrir o cadastro de categoria. Verifique sua internet e tente de novo.', 'erro');
      return;
    }
    if (!ctx.ativo()) return;
    modalCategoria = modulo.editarCategoria(ctx, null, { ordem: modulo.proximaOrdem(categorias) });
    const salva = await modalCategoria.resultado;
    modalCategoria = null;
    if (!salva || !ctx.ativo()) return;
    categorias = [...categorias, salva];
    preencherCategorias(salva.id);
    categoria.definirErro(null);
    marcar(true);
    ui.toast(`Categoria "${salva.nome}" criada e escolhida para este produto.`, 'sucesso');
    categoria.entrada.focus();
  }

  function lerValores() {
    return {
      nome: nome.entrada.value,
      descricao: descricao.entrada.value,
      preco: preco.entrada.value,
      estoque: estoque.entrada.value,
      ativo: ativo.ler(),
      destaque: destaque.ler(),
      categoria_id: categoria.entrada.value,
      imagens,
      ordem: ordem.entrada.value,
    };
  }

  const CAMPOS = {
    nome, descricao, preco_centavos: preco, estoque, ordem, categoria_id: categoria,
  };

  function limparErros() {
    avisarNaBarra(null);
    for (const c of Object.values(CAMPOS)) c.definirErro(null);
    erroFotos.hidden = true;
    erroFotos.textContent = '';
  }

  function focarPrimeiroErro() {
    const alvo = form.querySelector('[aria-invalid="true"]') || (!erroFotos.hidden ? area.elemento.querySelector('button') : null);
    if (!alvo) return;
    alvo.focus({ preventScroll: true });
    (alvo.closest('.campo') || erroFotos).scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function mostrarErros(erros) {
    for (const [campo, mensagem] of Object.entries(erros)) {
      if (campo === 'imagens') {
        erroFotos.textContent = mensagem;
        erroFotos.hidden = false;
      } else if (CAMPOS[campo]) {
        CAMPOS[campo].definirErro(mensagem);
      }
    }
    const total = Object.keys(erros).length;
    avisarNaBarra(total === 1 ? 'Confira o campo marcado em vermelho.' : `Confira os ${total} campos marcados em vermelho.`);
    focarPrimeiroErro();
  }

  async function slugsParecidos(base) {
    const raiz = String(base || '').replace(/-\d+$/, '');
    const r = await api.consultar(supabase.from('produtos').select('slug').like('slug', `${raiz}%`).limit(1000));
    return r.ok ? (r.dados || []).map((l) => l.slug) : [];
  }

  async function tratarErroAoSalvar(r) {
    if (r.erro === 'dados_invalidos' && campoDaRestricao(r.restricao)) {
      mostrarErros({ [campoDaRestricao(r.restricao)]: 'Este valor não foi aceito. Confira e tente de novo.' });
      return;
    }
    if (r.erro === 'em_uso') {
      // Chave estrangeira: a categoria escolhida foi apagada enquanto o formulário estava aberto.
      const rc2 = await api.consultar(supabase.from('categorias').select(COLUNAS_CATEGORIAS).order('ordem').order('nome'));
      if (!ctx.ativo()) return;
      if (rc2.ok) {
        categorias = rc2.dados || [];
        preencherCategorias('');
      }
      mostrarErros({ categoria_id: 'Esta categoria não existe mais. Escolha outra (ou "Sem categoria") e salve de novo.' });
      return;
    }
    if (r.erro === 'nao_encontrado') {
      ui.toast('Este produto foi apagado enquanto você editava. Copie o que precisar e volte para a lista.', 'erro');
      return;
    }
    ui.toast(r.mensagem, 'erro');
  }

  async function salvar() {
    if (enviando) {
      ui.toast('Espere as fotos terminarem de enviar e salve de novo.', 'aviso');
      return;
    }
    limparErros();
    const valores = lerValores();
    const erros = validarProduto(valores);
    if (Object.keys(erros).length) {
      const total = Object.keys(erros).length;
      mostrarErros(erros);
      return;
    }
    const registro = montarRegistro(valores);
    await ui.ocupado(botaoSalvar, async () => {
      let r;
      if (produto) {
        r = await api.consultar(supabase.from('produtos').update(registro).eq('id', produto.id).select('*').single());
      } else {
        // O endereço (slug) da loja sai do nome e nunca é pedido: escolhe o primeiro livre. Se outro
        // produto pegar o mesmo endereço no meio do caminho, tenta de novo com a lista atualizada.
        const base = gerarSlug(registro.nome) || 'produto';
        for (let tentativa = 0; tentativa < 3; tentativa += 1) {
          const usados = await slugsParecidos(base);
          if (!ctx.ativo()) return;
          r = await api.consultar(supabase.from('produtos').insert({ ...registro, slug: sugerirSlug(base, usados) }).select('*').single());
          if (r.ok || r.erro !== 'duplicado') break;
        }
      }
      if (!ctx.ativo()) return;
      if (!r.ok) {
        await tratarErroAoSalvar(r);
        return;
      }
      const eraNovo = !produto;
      produto = r.dados;
      marcar(false);
      if (eraNovo) {
        ui.toast(produto.ativo ? 'Produto criado e já está à venda na loja.' : 'Produto criado (fora da loja).', 'sucesso');
        ctx.navegar(`#/produtos/${produto.id}`, { substituir: true });
        return;
      }
      ui.toast('Alterações salvas.', 'sucesso');
      imagens = normalizarImagens(produto.imagens);
      desenharFotos();
      atualizarCabecalho();
      montarAcoesTopo();
    });
  }

  async function apagar() {
    if (!produto) return;
    const sim = await ui.confirmar(
      `Apagar o produto "${produto.nome}"? Ele sai da loja e do painel. Os pedidos antigos continuam mostrando o nome e o preço do produto, e as fotos continuam na biblioteca de Mídia. Esta ação não pode ser desfeita.`,
      { perigo: true, titulo: 'Apagar produto?', textoConfirmar: 'Apagar produto' },
    );
    if (!sim || !ctx.ativo()) return;
    await ui.ocupado(botaoApagar, async () => {
      const r = await api.consultar(supabase.from('produtos').delete().eq('id', produto.id).select('id'));
      if (!ctx.ativo()) return;
      if (!r.ok) {
        ui.toast(r.mensagem, 'erro');
        return;
      }
      marcar(false);
      ui.toast(r.dados && r.dados.length ? `Produto "${produto.nome}" apagado.` : 'Este produto já tinha sido apagado.', 'sucesso');
      ctx.navegar('#/produtos');
    });
  }

  // Eventos
  preco.entrada.addEventListener('input', atualizarDicaPreco);
  estoque.entrada.addEventListener('input', atualizarDicaPreco);
  novaCategoria.addEventListener('click', criarCategoria);
  // Corrigiu tudo o que estava em vermelho: a barra volta ao texto normal.
  const conferirErrosRestantes = () => {
    if (infoBarra.classList.contains('produto-barra__erro') && !form.querySelector('[aria-invalid="true"]') && erroFotos.hidden) avisarNaBarra(null);
  };
  form.addEventListener('input', () => {
    marcar(true);
    conferirErrosRestantes();
  });
  form.addEventListener('change', () => {
    marcar(true);
    conferirErrosRestantes();
  });
  form.addEventListener('submit', (evento) => {
    evento.preventDefault();
    salvar();
  });

  preencherCategorias(p.categoria_id || '');
  atualizarDicaPreco();
  desenharFotos();
  if (produto) {
    atualizarCabecalho();
    montarAcoesTopo();
  }

  return () => {
    if (modalCategoria) modalCategoria.fechar(null);
  };
}
