// Carrinho no localStorage (docs/ARQUITETURA.md §7).
// ama_carrinho_v1 = [{ produto_id, quantidade, nome, preco_centavos, imagem, slug }]
// Nome, preço e imagem servem só para exibir rápido: o servidor sempre recota tudo.
// Toda mudança dispara o evento window "carrinho:mudou" (detail: { itens }); outra aba que mudar o
// carrinho também dispara o evento aqui (evento "storage"). Sem localStorage (modo privado
// bloqueado), o carrinho vive só na memória desta página.

import { urlSegura } from './formatos.js';

export const CHAVE_CARRINHO = 'ama_carrinho_v1';
export const CHAVE_PREFERENCIAS = 'ama_carrinho_prefs_v1';
export const EVENTO = 'carrinho:mudou';
export const MAX_QUANTIDADE = 99;
export const MAX_LINHAS = 30;

const REGEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const memoria = new Map();

function armazenamento() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

function lerJson(chave) {
  const s = armazenamento();
  try {
    const t = s ? s.getItem(chave) : memoria.get(chave);
    return t ? JSON.parse(t) : null;
  } catch {
    return null;
  }
}

function gravarJson(chave, valor) {
  const t = JSON.stringify(valor);
  const s = armazenamento();
  try {
    if (s) s.setItem(chave, t);
    else memoria.set(chave, t);
    return true;
  } catch {
    // Cota estourada ou armazenamento bloqueado: mantém na memória desta página.
    memoria.set(chave, t);
    return false;
  }
}

function emitir(itens) {
  try {
    if (typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      globalThis.dispatchEvent(new CustomEvent(EVENTO, { detail: { itens } }));
    }
  } catch {
    // sem ambiente de eventos (testes): ignora
  }
}

const limitar = (n, min, max) => Math.min(max, Math.max(min, n));

/** Uma linha do carrinho com tipos garantidos (ou null se inválida). */
function normalizarLinha(bruta) {
  if (!bruta || typeof bruta !== 'object') return null;
  const id = typeof bruta.produto_id === 'string' ? bruta.produto_id.trim().toLowerCase() : '';
  const quantidade = Number(bruta.quantidade);
  if (!REGEX_UUID.test(id) || !Number.isInteger(quantidade) || quantidade < 1) return null;
  const preco = Number(bruta.preco_centavos);
  return {
    produto_id: id,
    quantidade: Math.min(MAX_QUANTIDADE, quantidade),
    nome: typeof bruta.nome === 'string' ? bruta.nome.slice(0, 200) : '',
    preco_centavos: Number.isInteger(preco) && preco >= 0 ? preco : 0,
    imagem: urlSegura(bruta.imagem),
    slug: typeof bruta.slug === 'string' && /^[a-z0-9-]{1,120}$/.test(bruta.slug) ? bruta.slug : '',
  };
}

/** Junta linhas repetidas, descarta inválidas e limita a 30 linhas / 99 unidades. */
function normalizarLista(lista) {
  const porId = new Map();
  for (const bruta of Array.isArray(lista) ? lista : []) {
    const linha = normalizarLinha(bruta);
    if (!linha) continue;
    const existente = porId.get(linha.produto_id);
    if (existente) existente.quantidade = Math.min(MAX_QUANTIDADE, existente.quantidade + linha.quantidade);
    else if (porId.size < MAX_LINHAS) porId.set(linha.produto_id, linha);
  }
  return [...porId.values()];
}

/** Itens do carrinho (sempre um array válido). */
export function lerCarrinho() {
  return normalizarLista(lerJson(CHAVE_CARRINHO));
}

/** Grava o carrinho (normalizado) e avisa a página. */
export function salvarCarrinho(itens, { emitirEvento = true } = {}) {
  const lista = normalizarLista(itens);
  gravarJson(CHAVE_CARRINHO, lista);
  if (emitirEvento) emitir(lista);
  return lista;
}

/**
 * Adiciona `quantidade` do produto. `maximo` (estoque) limita o total da linha.
 * produto = { id | produto_id, nome, slug, preco_centavos (efetivo), imagem }.
 * Devolve { ok, quantidade (na linha), limitado, motivo: null | 'invalido' | 'limite_linhas' | 'maximo' }.
 */
export function adicionarAoCarrinho(produto, quantidade = 1, { maximo = MAX_QUANTIDADE } = {}) {
  const id = produto && (produto.produto_id || produto.id);
  const qtd = Number(quantidade);
  const teto = limitar(Number.isInteger(Number(maximo)) ? Number(maximo) : MAX_QUANTIDADE, 0, MAX_QUANTIDADE);
  const base = normalizarLinha({ ...produto, produto_id: id, quantidade: 1 });
  if (!base || !Number.isInteger(qtd) || qtd < 1) return { ok: false, quantidade: 0, limitado: false, motivo: 'invalido' };
  if (teto < 1) return { ok: false, quantidade: 0, limitado: true, motivo: 'maximo' };

  const itens = lerCarrinho();
  const existente = itens.find((i) => i.produto_id === base.produto_id);
  if (!existente && itens.length >= MAX_LINHAS) {
    return { ok: false, quantidade: 0, limitado: true, motivo: 'limite_linhas' };
  }
  const atual = existente ? existente.quantidade : 0;
  if (atual >= teto) return { ok: false, quantidade: atual, limitado: true, motivo: 'maximo' };
  const desejada = atual + qtd;
  const final = Math.min(desejada, teto);
  if (existente) {
    Object.assign(existente, { ...base, quantidade: final });
  } else {
    itens.push({ ...base, quantidade: final });
  }
  salvarCarrinho(itens);
  return { ok: true, quantidade: final, limitado: final < desejada, motivo: final < desejada ? 'maximo' : null };
}

/** Define a quantidade da linha (0 remove). Devolve a quantidade final. */
export function definirQuantidade(produtoId, quantidade) {
  const id = String(produtoId || '').toLowerCase();
  const qtd = Number(quantidade);
  const itens = lerCarrinho();
  const linha = itens.find((i) => i.produto_id === id);
  if (!linha || !Number.isFinite(qtd)) return linha ? linha.quantidade : 0;
  if (qtd < 1) {
    salvarCarrinho(itens.filter((i) => i.produto_id !== id));
    return 0;
  }
  linha.quantidade = limitar(Math.floor(qtd), 1, MAX_QUANTIDADE);
  salvarCarrinho(itens);
  return linha.quantidade;
}

export function removerDoCarrinho(produtoId) {
  const id = String(produtoId || '').toLowerCase();
  return salvarCarrinho(lerCarrinho().filter((i) => i.produto_id !== id));
}

export function limparCarrinho() {
  return salvarCarrinho([]);
}

/** Total de unidades (para o contador do cabeçalho). */
export function contarUnidades(itens = lerCarrinho()) {
  return itens.reduce((soma, i) => soma + i.quantidade, 0);
}

/** O que vai para o servidor: só produto e quantidade (nunca preço). */
export function itensParaCotacao(itens = lerCarrinho()) {
  return itens.map((i) => ({ produto_id: i.produto_id, quantidade: i.quantidade }));
}

/**
 * Atualiza nome, preço, imagem e slug guardados com os dados que o servidor devolveu na cotação
 * (só para exibição). Não muda quantidades. Só grava (e emite) se algo mudou.
 */
export function sincronizarComCotacao(itensCotados) {
  if (!Array.isArray(itensCotados)) return lerCarrinho();
  const porId = new Map(itensCotados.filter((i) => i && i.produto_id).map((i) => [String(i.produto_id).toLowerCase(), i]));
  const itens = lerCarrinho();
  let mudou = false;
  for (const linha of itens) {
    const cotado = porId.get(linha.produto_id);
    if (!cotado || typeof cotado.nome !== 'string' || !cotado.nome) continue;
    const novo = normalizarLinha({
      produto_id: linha.produto_id,
      quantidade: linha.quantidade,
      nome: cotado.nome,
      preco_centavos: cotado.preco_unitario_centavos,
      imagem: cotado.imagem || '',
      slug: cotado.slug || linha.slug,
    });
    if (novo && (novo.nome !== linha.nome || novo.preco_centavos !== linha.preco_centavos
      || novo.imagem !== linha.imagem || novo.slug !== linha.slug)) {
      Object.assign(linha, novo);
      mudou = true;
    }
  }
  return mudou ? salvarCarrinho(itens) : itens;
}

/** Preferências guardadas entre carrinho e checkout: { cep, cupom, frete_id }. */
export function lerPreferencias() {
  const p = lerJson(CHAVE_PREFERENCIAS);
  const ok = p && typeof p === 'object' && !Array.isArray(p);
  const campo = (nome, regex) => (ok && typeof p[nome] === 'string' && regex.test(p[nome]) ? p[nome] : '');
  return {
    cep: campo('cep', /^\d{8}$/),
    cupom: campo('cupom', /^[A-Z0-9_-]{3,30}$/),
    frete_id: campo('frete_id', /^[A-Za-z0-9_-]{1,60}$/),
  };
}

export function salvarPreferencias(parcial) {
  const atual = lerPreferencias();
  const nova = { ...atual, ...(parcial && typeof parcial === 'object' ? parcial : {}) };
  gravarJson(CHAVE_PREFERENCIAS, nova);
  return lerPreferencias();
}

let sincronizando = false;

/** Repassa mudanças feitas em outras abas como "carrinho:mudou". Idempotente. */
export function iniciarSincronizacaoAbas() {
  if (sincronizando || typeof globalThis.addEventListener !== 'function') return;
  sincronizando = true;
  globalThis.addEventListener('storage', (evento) => {
    if (evento.key === CHAVE_CARRINHO || evento.key === null) emitir(lerCarrinho());
  });
}

// ---------------------------------------------------------------------------
// "Meus pedidos neste aparelho": ama_pedidos_v1 = [{ id, token, numero, criado_em }] (mais novo primeiro)

export const CHAVE_PEDIDOS = 'ama_pedidos_v1';
export const MAX_PEDIDOS = 20;

function normalizarPedido(bruto) {
  if (!bruto || typeof bruto !== 'object') return null;
  const id = typeof bruto.id === 'string' ? bruto.id.trim().toLowerCase() : '';
  const token = typeof bruto.token === 'string' ? bruto.token.trim() : '';
  if (!REGEX_UUID.test(id) || !/^[A-Za-z0-9_-]{16,200}$/.test(token)) return null;
  const numero = Number(bruto.numero);
  const data = typeof bruto.criado_em === 'string' && !Number.isNaN(Date.parse(bruto.criado_em)) ? bruto.criado_em : null;
  return { id, token, numero: Number.isInteger(numero) && numero > 0 ? numero : null, criado_em: data };
}

/** Pedidos feitos neste aparelho (válidos, sem repetição, mais novo primeiro). */
export function lerPedidosGuardados() {
  const lista = lerJson(CHAVE_PEDIDOS);
  const vistos = new Set();
  const saida = [];
  for (const bruto of Array.isArray(lista) ? lista : []) {
    const pedido = normalizarPedido(bruto);
    if (!pedido || vistos.has(pedido.id)) continue;
    vistos.add(pedido.id);
    saida.push(pedido);
  }
  return saida.slice(0, MAX_PEDIDOS);
}

/** Guarda um pedido novo no topo da lista (ou atualiza o existente no mesmo lugar). Devolve a lista. */
export function guardarPedido(pedido) {
  const novo = normalizarPedido(pedido);
  if (!novo) return lerPedidosGuardados();
  const anteriores = lerPedidosGuardados();
  const antigo = anteriores.find((p) => p.id === novo.id);
  let lista;
  if (antigo) {
    const combinado = {
      ...novo,
      numero: novo.numero ?? antigo.numero,
      criado_em: antigo.criado_em ?? novo.criado_em,
    };
    lista = anteriores.map((p) => (p.id === novo.id ? combinado : p));
  } else {
    lista = [novo, ...anteriores].slice(0, MAX_PEDIDOS);
  }
  gravarJson(CHAVE_PEDIDOS, lista);
  return lista;
}
