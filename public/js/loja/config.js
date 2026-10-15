// Configuração pública da loja (docs/ARQUITETURA.md §6.1 e §7).
// window.AMA_CONFIG vem de /api/config (script clássico carregado antes dos módulos).
// restGet fala com o PostgREST só com a chave pública (apikey); a RLS garante que só itens
// ativos e configurações públicas saem do banco.

import { validarSlug } from './formatos.js';

const SELECT_PRODUTO = 'id,nome,slug,descricao,preco_centavos,preco_promocional_centavos,estoque,'
  + 'controlar_estoque,imagens,destaque,categoria_id,categorias(nome,slug)';
const ORDEM_PRODUTOS = 'destaque.desc,ordem.asc,criado_em.desc';

export const CONSULTAS = Object.freeze({
  produtos: `produtos?select=${SELECT_PRODUTO}&ativo=eq.true&order=${ORDEM_PRODUTOS}`,
  categorias: 'categorias?select=id,nome,slug&ativo=eq.true&order=ordem.asc',
  configLoja: 'configuracoes?select=valor&chave=eq.loja',
});

/** Valores padrão de configuracoes.loja (os mesmos da migração). */
export const LOJA_PADRAO = Object.freeze({
  titulo: 'Cosméticos',
  subtitulo: 'Biojoias e cosméticos feitos à mão por mulheres da Amazônia. Cada compra fortalece os projetos da AMA.',
  whatsapp: '5591981056049',
  instagram: 'oscdemulheres',
  email_contato: '',
  aviso_topo: '',
  frete_gratis_acima_centavos: null,
});

/** Erro de leitura do banco: tipo 'nao_configurado' | 'rede' | 'tempo_esgotado' | 'http'. */
export class ErroLeitura extends Error {
  constructor(tipo, mensagem, status = 0) {
    super(mensagem || 'Não foi possível carregar os dados da loja.');
    this.name = 'ErroLeitura';
    this.tipo = tipo;
    this.status = status;
  }
}

/** { supabaseUrl, supabaseAnonKey, configurado } — configurado só com URL http(s) e chave. */
export function obterConfig() {
  const bruto = globalThis.AMA_CONFIG;
  const c = bruto && typeof bruto === 'object' ? bruto : {};
  let url = typeof c.supabaseUrl === 'string' ? c.supabaseUrl.trim().replace(/\/+$/, '') : '';
  if (!/^https?:\/\/[^\s/]+/i.test(url)) url = '';
  const chave = typeof c.supabaseAnonKey === 'string' ? c.supabaseAnonKey.trim() : '';
  return { supabaseUrl: url, supabaseAnonKey: chave, configurado: c.configurado === true && !!url && !!chave };
}

export function lojaConfigurada() {
  return obterConfig().configurado;
}

/** GET <supabaseUrl>/rest/v1/<caminho> com apikey e tempo-limite. Devolve o JSON. */
export async function restGet(caminho, { timeoutMs = 12000 } = {}) {
  const { supabaseUrl, supabaseAnonKey, configurado } = obterConfig();
  if (!configurado) throw new ErroLeitura('nao_configurado', 'A loja ainda está em configuração.');
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), timeoutMs);
  try {
    let resposta;
    try {
      resposta = await fetch(`${supabaseUrl}/rest/v1/${String(caminho).replace(/^\/+/, '')}`, {
        headers: { apikey: supabaseAnonKey, Accept: 'application/json' },
        signal: controle.signal,
        cache: 'no-store',
      });
    } catch (erro) {
      const tempo = erro && erro.name === 'AbortError';
      throw new ErroLeitura(tempo ? 'tempo_esgotado' : 'rede',
        tempo ? 'A loja demorou para responder.' : 'Não foi possível falar com a loja. Confira sua conexão.');
    }
    if (!resposta.ok) throw new ErroLeitura('http', 'Não foi possível carregar os dados da loja.', resposta.status);
    try {
      return await resposta.json();
    } catch {
      throw new ErroLeitura('http', 'Resposta inesperada da loja.', resposta.status);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// configuracoes.loja — lida uma vez por página (sempre fresca: o painel muda e a loja reflete).

let promessaConfig = null;

/** Valor de configuracoes.loja → objeto com tipos garantidos e padrões aplicados. */
export function normalizarConfigLoja(valor) {
  const v = valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {};
  const texto = (nome, max) => (typeof v[nome] === 'string' ? v[nome].trim().slice(0, max) : LOJA_PADRAO[nome]);
  const frete = Number(v.frete_gratis_acima_centavos);
  const whatsapp = typeof v.whatsapp === 'string' || typeof v.whatsapp === 'number'
    ? String(v.whatsapp).replace(/\D+/g, '').slice(0, 15) : LOJA_PADRAO.whatsapp;
  return {
    titulo: texto('titulo', 120) || LOJA_PADRAO.titulo,
    subtitulo: texto('subtitulo', 400),
    whatsapp,
    instagram: (texto('instagram', 60) || '').replace(/^@+/, '').replace(/[^A-Za-z0-9._]/g, ''),
    email_contato: texto('email_contato', 160) || '',
    aviso_topo: texto('aviso_topo', 300) || '',
    frete_gratis_acima_centavos: v.frete_gratis_acima_centavos !== null && Number.isInteger(frete) && frete > 0 ? frete : null,
  };
}

/**
 * configuracoes.loja com os padrões aplicados. Nunca lança: sem banco devolve os padrões
 * (com `padrao: true`).
 */
export function carregarConfigLoja() {
  if (!promessaConfig) {
    promessaConfig = restGet(CONSULTAS.configLoja, { timeoutMs: 8000 })
      .then((linhas) => {
        const valor = Array.isArray(linhas) && linhas[0] ? linhas[0].valor : null;
        return valor ? { ...normalizarConfigLoja(valor), padrao: false } : { ...normalizarConfigLoja(LOJA_PADRAO), padrao: true };
      })
      .catch(() => ({ ...normalizarConfigLoja(LOJA_PADRAO), padrao: true }));
  }
  return promessaConfig;
}

/** Todos os produtos ativos (linhas cruas do PostgREST). */
export function buscarProdutos() {
  return restGet(CONSULTAS.produtos);
}

export function buscarCategorias() {
  return restGet(CONSULTAS.categorias);
}

/** Produto ativo pelo slug (linha crua) ou null. */
export async function buscarProdutoPorSlug(slug) {
  if (!validarSlug(slug)) return null;
  const linhas = await restGet(`produtos?select=${SELECT_PRODUTO}&ativo=eq.true&slug=eq.${encodeURIComponent(slug)}&limit=1`);
  return Array.isArray(linhas) && linhas[0] ? linhas[0] : null;
}

/** Outros produtos da mesma categoria (linhas cruas). */
export async function buscarRelacionados({ categoriaId, slug, limite = 4 }) {
  const filtros = [`ativo=eq.true`, `order=${ORDEM_PRODUTOS}`, `limit=${limite + 1}`];
  if (categoriaId) filtros.push(`categoria_id=eq.${encodeURIComponent(categoriaId)}`);
  const linhas = await restGet(`produtos?select=${SELECT_PRODUTO}&${filtros.join('&')}`);
  return (Array.isArray(linhas) ? linhas : []).filter((p) => p && p.slug !== slug).slice(0, limite);
}
