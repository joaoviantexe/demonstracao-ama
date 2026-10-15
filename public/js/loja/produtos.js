// Regras de exibição dos produtos (funções puras, testadas em tests/unit/loja-front.test.js).
// Preço efetivo = promocional ?? normal; preço efetivo 0 = "Em breve" ("R$ 00,00"), nunca vendável.

import { normalizarBusca, urlSegura } from './formatos.js';

export const MAX_POR_ITEM = 99;

const inteiro = (v, padrao = 0) => (Number.isInteger(Number(v)) ? Number(v) : padrao);
const texto = (v, max = 5000) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Linha do PostgREST → produto com tipos garantidos e imagens com URL segura. */
export function normalizarProduto(bruto) {
  if (!bruto || typeof bruto !== 'object') return null;
  const id = texto(bruto.id, 64);
  const slug = texto(bruto.slug, 120);
  if (!id || !slug) return null;
  const preco = Math.max(0, inteiro(bruto.preco_centavos));
  const promoBruta = bruto.preco_promocional_centavos;
  const promo = promoBruta === null || promoBruta === undefined ? null : Math.max(0, inteiro(promoBruta));
  const nome = texto(bruto.nome, 200).trim() || 'Produto';
  const imagens = (Array.isArray(bruto.imagens) ? bruto.imagens : [])
    .map((img) => ({
      src: urlSegura(img && typeof img === 'object' ? img.src : img),
      alt: texto(img && typeof img === 'object' ? img.alt : '', 300).trim(),
    }))
    .filter((img) => img.src)
    .slice(0, 12);
  const categoria = bruto.categorias && typeof bruto.categorias === 'object'
    ? { nome: texto(bruto.categorias.nome, 120), slug: texto(bruto.categorias.slug, 120) }
    : null;
  return {
    id,
    nome,
    slug,
    descricao: texto(bruto.descricao, 10000),
    preco_centavos: preco,
    preco_promocional_centavos: promo !== null && promo < preco ? promo : null,
    estoque: Math.max(0, inteiro(bruto.estoque)),
    controlar_estoque: bruto.controlar_estoque !== false,
    imagens,
    destaque: bruto.destaque === true,
    categoria_id: typeof bruto.categoria_id === 'string' ? bruto.categoria_id : null,
    categoria: categoria && categoria.slug ? categoria : null,
  };
}

/** Preço efetivo em centavos. */
export function precoEfetivo(produto) {
  if (!produto) return 0;
  return produto.preco_promocional_centavos ?? produto.preco_centavos ?? 0;
}

/**
 * Situação do produto na vitrine:
 * { preco, precoOriginal (riscado) | null, promocao, emBreve, esgotado, vendavel, maxQuantidade, descontoPercentual }
 */
export function analisarProduto(produto) {
  const preco = precoEfetivo(produto);
  const emBreve = preco <= 0;
  const promocao = !emBreve && produto.preco_promocional_centavos !== null
    && produto.preco_promocional_centavos < produto.preco_centavos;
  const estoque = produto.controlar_estoque ? Math.max(0, produto.estoque) : MAX_POR_ITEM;
  const esgotado = !emBreve && produto.controlar_estoque && produto.estoque <= 0;
  const maxQuantidade = emBreve || esgotado ? 0 : Math.min(MAX_POR_ITEM, estoque);
  return {
    preco,
    precoOriginal: promocao ? produto.preco_centavos : null,
    promocao,
    emBreve,
    esgotado,
    vendavel: !emBreve && !esgotado,
    maxQuantidade,
    descontoPercentual: promocao ? Math.round((1 - preco / produto.preco_centavos) * 100) : 0,
  };
}

/** Primeira imagem (ou null). */
export function imagemPrincipal(produto) {
  return produto && produto.imagens && produto.imagens.length ? produto.imagens[0] : null;
}

/** Filtra por categoria (slug) e busca (nome, descrição e categoria, sem acentos; todas as palavras). */
export function filtrarProdutos(lista, { categoria = '', busca = '' } = {}) {
  const termos = normalizarBusca(busca).split(' ').filter(Boolean);
  return lista.filter((p) => {
    if (categoria && (!p.categoria || p.categoria.slug !== categoria)) return false;
    if (!termos.length) return true;
    const alvo = normalizarBusca(`${p.nome} ${p.categoria ? p.categoria.nome : ''} ${p.descricao}`);
    return termos.every((t) => alvo.includes(t));
  });
}

export const ORDENACOES = Object.freeze([
  { valor: 'destaques', rotulo: 'Destaques' },
  { valor: 'menor-preco', rotulo: 'Menor preço' },
  { valor: 'maior-preco', rotulo: 'Maior preço' },
  { valor: 'nome', rotulo: 'Nome (A–Z)' },
]);

const comparadorNome = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR', { sensitivity: 'base' });

/**
 * Ordena sem alterar a lista original. "destaques" mantém a ordem do servidor
 * (destaque, ordem, mais novos). Nos critérios de preço, os produtos "Em breve" vão para o fim.
 */
export function ordenarProdutos(lista, criterio = 'destaques') {
  const copia = lista.map((p, i) => ({ p, i }));
  const desempate = (a, b) => a.i - b.i;
  const semPrecoPorUltimo = (a, b) => (precoEfetivo(a.p) <= 0) - (precoEfetivo(b.p) <= 0);
  if (criterio === 'menor-preco') {
    copia.sort((a, b) => semPrecoPorUltimo(a, b) || precoEfetivo(a.p) - precoEfetivo(b.p) || desempate(a, b));
  } else if (criterio === 'maior-preco') {
    copia.sort((a, b) => semPrecoPorUltimo(a, b) || precoEfetivo(b.p) - precoEfetivo(a.p) || desempate(a, b));
  } else if (criterio === 'nome') {
    copia.sort((a, b) => comparadorNome(a.p, b.p) || desempate(a, b));
  }
  return copia.map((x) => x.p);
}

/** Critério de ordenação válido (ou o padrão). */
export function lerOrdenacao(valor) {
  return ORDENACOES.some((o) => o.valor === valor) ? valor : 'destaques';
}

/**
 * Categorias que têm produtos, na ordem recebida, com a contagem.
 * Categorias vindas do produto e ausentes da lista de categorias entram no fim.
 */
export function categoriasComProdutos(categorias, produtos) {
  const contagem = new Map();
  for (const p of produtos) {
    if (p.categoria) contagem.set(p.categoria.slug, (contagem.get(p.categoria.slug) || 0) + 1);
  }
  const saida = [];
  const vistos = new Set();
  for (const c of categorias || []) {
    if (!c || typeof c.slug !== 'string' || vistos.has(c.slug)) continue;
    const total = contagem.get(c.slug) || 0;
    vistos.add(c.slug);
    if (total) saida.push({ nome: String(c.nome || c.slug), slug: c.slug, total });
  }
  for (const p of produtos) {
    if (p.categoria && !vistos.has(p.categoria.slug)) {
      vistos.add(p.categoria.slug);
      saida.push({ nome: p.categoria.nome || p.categoria.slug, slug: p.categoria.slug, total: contagem.get(p.categoria.slug) });
    }
  }
  return saida;
}

/** Mensagem pronta para encomendar / tirar dúvidas pelo WhatsApp. */
export function mensagemWhatsappProduto(produto, { url = '', motivo = 'duvida' } = {}) {
  const nome = produto && produto.nome ? produto.nome : 'um produto';
  const inicio = motivo === 'encomenda'
    ? `Olá, AMA! Tenho interesse em encomendar: ${nome}.`
    : `Olá, AMA! Tenho uma dúvida sobre o produto: ${nome}.`;
  return url ? `${inicio}\n${url}` : inicio;
}
