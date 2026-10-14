// Acesso REST ao Supabase com fetch nativo (docs/ARQUITETURA.md §3 e §6.0).
// - servico(): chave de serviço (ignora RLS) — só no servidor.
// - selecionarPublico(): chave pública (anon/publishable), sujeita à RLS.
// - usuarioDoToken(): valida o JWT de um usuário no Auth.
// As chaves sb_* não são JWT: vão no apikey e, no Authorization, exatamente iguais ao apikey.

import { obterAmbiente } from './ambiente.js';
import { ErroHttp } from './http.js';

const TIMEOUT_SERVICO_PADRAO = 10_000;
const TIMEOUT_PUBLICO_PADRAO = 2_500;
const TIMEOUT_AUTH_PADRAO = 5_000;

/** Erro do Supabase/PostgREST. `codigo` = message do PostgREST (ex.: 'item_indisponivel'). */
export class ErroSupabase extends Error {
  /**
   * @param {number} status    status HTTP (0 não se aplica: falha de rede = 502, tempo esgotado = 504)
   * @param {string} codigo    message do PostgREST, ou 'falha_conexao' / 'tempo_esgotado'
   * @param {*} [detalhes]     details do PostgREST (ex.: campo em 'dados_invalidos')
   * @param {object} [extra]   { codigoPostgres, dica }
   */
  constructor(status, codigo, detalhes = null, extra = {}) {
    super(`Supabase ${status}: ${codigo}`);
    this.name = 'ErroSupabase';
    this.status = status;
    this.codigo = codigo;
    this.detalhes = detalhes ?? null;
    this.codigoPostgres = extra.codigoPostgres ?? null;
    this.dica = extra.dica ?? null;
  }
}

const naoConfigurado = () => new ErroHttp(503, 'supabase_nao_configurado',
  'O banco de dados ainda não foi configurado.');

/** Monta a query string a partir de string ("select=*&id=eq.x") ou objeto ({ select: '*', id: 'eq.x' }). */
export function montarQuery(query) {
  if (query === undefined || query === null || query === '') return '';
  if (typeof query === 'string') return query.replace(/^\?+/, '');
  if (query instanceof URLSearchParams) return query.toString();
  const params = new URLSearchParams();
  for (const [chave, valor] of Object.entries(query)) {
    if (valor === undefined || valor === null) continue;
    if (Array.isArray(valor)) {
      for (const v of valor) if (v !== undefined && v !== null) params.append(chave, String(v));
    } else {
      params.append(chave, String(valor));
    }
  }
  return params.toString();
}

function nomeSeguro(nome, tipo) {
  if (typeof nome !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(nome)) {
    throw new TypeError(`Nome de ${tipo} inválido: ${nome}`);
  }
  return nome;
}

function interpretar(texto) {
  if (!texto) return null;
  try {
    return JSON.parse(texto);
  } catch {
    return texto;
  }
}

// Faz a requisição com timeout (que cobre também a leitura do corpo).
// Devolve o JSON (ou null se vazio); lança ErroSupabase em erro HTTP, rede ou timeout.
async function requisitar(url, { metodo = 'GET', cabecalhos = {}, corpo, timeoutMs }) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), timeoutMs);
  try {
    const resposta = await fetch(url, {
      method: metodo,
      headers: cabecalhos,
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
      signal: controlador.signal,
    });
    const texto = await resposta.text();
    const dados = interpretar(texto);
    if (!resposta.ok) {
      const obj = dados && typeof dados === 'object' ? dados : {};
      const codigo = String(obj.message || obj.msg || obj.error_description || obj.error
        || `http_${resposta.status}`);
      throw new ErroSupabase(resposta.status, codigo, obj.details ?? null, {
        codigoPostgres: obj.code ?? obj.error_code ?? null,
        dica: obj.hint ?? null,
      });
    }
    return dados;
  } catch (erro) {
    if (erro instanceof ErroSupabase) throw erro;
    if (controlador.signal.aborted) {
      throw new ErroSupabase(504, 'tempo_esgotado', `Sem resposta do Supabase em ${timeoutMs} ms`);
    }
    throw new ErroSupabase(502, 'falha_conexao', erro && erro.message ? erro.message : String(erro));
  } finally {
    clearTimeout(temporizador);
  }
}

function cabecalhosChave(chave, extras = {}) {
  return { apikey: chave, Authorization: `Bearer ${chave}`, Accept: 'application/json', ...extras };
}

/**
 * Cliente REST com a chave de serviço (ignora RLS). Lança ErroHttp 503 'supabase_nao_configurado'
 * se faltar SUPABASE_URL ou a chave de serviço. Todos os métodos lançam ErroSupabase em erro.
 *
 * - select(tabela, query)                 → array de linhas
 * - rpc(nome, args = {})                  → retorno da função (JSON) ou null
 * - insert(tabela, dados, { retornar = true, upsert = false, onConflict }) → linhas inseridas | null
 * - update(tabela, query, dados)          → linhas alteradas (exige filtro)
 * - remove(tabela, query)                 → linhas apagadas (exige filtro)
 *
 * @param {{ timeoutMs?: number }} [opcoes]
 */
export function servico({ timeoutMs = TIMEOUT_SERVICO_PADRAO } = {}) {
  const { supabaseUrl, supabaseServiceKey } = obterAmbiente();
  if (!supabaseUrl || !supabaseServiceKey) throw naoConfigurado();
  const base = `${supabaseUrl}/rest/v1`;

  const urlTabela = (tabela, query) => {
    const qs = montarQuery(query);
    return `${base}/${nomeSeguro(tabela, 'tabela')}${qs ? `?${qs}` : ''}`;
  };
  const exigirFiltro = (query, operacao) => {
    const qs = montarQuery(query);
    const temFiltro = qs.split('&').some((par) => {
      let nome = par.split('=')[0] || '';
      try { nome = decodeURIComponent(nome); } catch { /* mantém o nome cru */ }
      return nome && !['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(nome);
    });
    if (!temFiltro) throw new TypeError(`${operacao} sem filtro não é permitido`);
  };
  const req = (url, opcoes) => requisitar(url, {
    timeoutMs,
    ...opcoes,
    cabecalhos: cabecalhosChave(supabaseServiceKey, opcoes.cabecalhos),
  });

  return {
    async select(tabela, query) {
      const dados = await req(urlTabela(tabela, query), {});
      return Array.isArray(dados) ? dados : dados === null ? [] : [dados];
    },

    async rpc(nome, args = {}) {
      return req(`${base}/rpc/${nomeSeguro(nome, 'função')}`, {
        metodo: 'POST',
        corpo: args ?? {},
        cabecalhos: { 'Content-Type': 'application/json' },
      });
    },

    async insert(tabela, dados, { retornar = true, upsert = false, onConflict } = {}) {
      const prefer = [retornar ? 'return=representation' : 'return=minimal'];
      if (upsert) prefer.push('resolution=merge-duplicates');
      const query = onConflict ? { on_conflict: onConflict } : undefined;
      const resposta = await req(urlTabela(tabela, query), {
        metodo: 'POST',
        corpo: dados,
        cabecalhos: { 'Content-Type': 'application/json', Prefer: prefer.join(',') },
      });
      return retornar ? resposta : null;
    },

    async update(tabela, query, dados) {
      exigirFiltro(query, 'update');
      const resposta = await req(urlTabela(tabela, query), {
        metodo: 'PATCH',
        corpo: dados,
        cabecalhos: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      });
      return Array.isArray(resposta) ? resposta : [];
    },

    async remove(tabela, query) {
      exigirFiltro(query, 'remove');
      const resposta = await req(urlTabela(tabela, query), {
        metodo: 'DELETE',
        cabecalhos: { Prefer: 'return=representation' },
      });
      return Array.isArray(resposta) ? resposta : [];
    },
  };
}

/**
 * SELECT com a chave pública (RLS vale). Devolve array de linhas.
 * Lança ErroHttp 503 sem configuração; ErroSupabase em erro, rede ou timeout.
 */
export async function selecionarPublico(tabela, query, { timeoutMs = TIMEOUT_PUBLICO_PADRAO } = {}) {
  const { supabaseUrl, supabaseAnonKey } = obterAmbiente();
  if (!supabaseUrl || !supabaseAnonKey) throw naoConfigurado();
  const qs = montarQuery(query);
  const url = `${supabaseUrl}/rest/v1/${nomeSeguro(tabela, 'tabela')}${qs ? `?${qs}` : ''}`;
  const dados = await requisitar(url, { cabecalhos: cabecalhosChave(supabaseAnonKey), timeoutMs });
  return Array.isArray(dados) ? dados : dados === null ? [] : [dados];
}

/**
 * Valida o JWT de um usuário em GET /auth/v1/user.
 * → { id, email } | null (token ausente, malformado, expirado ou recusado).
 * Lança ErroHttp 503 sem configuração e ErroSupabase se o Auth estiver fora do ar (5xx, rede, timeout).
 */
export async function usuarioDoToken(jwt, { timeoutMs = TIMEOUT_AUTH_PADRAO } = {}) {
  if (typeof jwt !== 'string') return null;
  const token = jwt.trim();
  // JWT = três partes base64url; recusa lixo antes de chamar a rede.
  if (!token || token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(token)) return null;

  const { supabaseUrl, supabaseAnonKey } = obterAmbiente();
  if (!supabaseUrl || !supabaseAnonKey) throw naoConfigurado();

  let usuario;
  try {
    usuario = await requisitar(`${supabaseUrl}/auth/v1/user`, {
      cabecalhos: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}`, Accept: 'application/json' },
      timeoutMs,
    });
  } catch (erro) {
    if (erro instanceof ErroSupabase && erro.status >= 400 && erro.status < 500) return null;
    throw erro;
  }
  if (!usuario || typeof usuario !== 'object' || typeof usuario.id !== 'string' || !usuario.id) return null;
  return { id: usuario.id, email: typeof usuario.email === 'string' ? usuario.email : '' };
}
