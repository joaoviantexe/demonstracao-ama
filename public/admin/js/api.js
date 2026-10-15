// Comunicação do painel com o servidor (rotas /api/admin/*) e com o Supabase (docs/PAINEL.md).
// Nada aqui lança erro para quem chama: tudo volta como { ok: true, ... } ou
// { ok: false, erro: 'codigo', mensagem: 'Texto em português', status }.

let cliente = null;
let avisarSessaoExpirada = null;
let configuracao = { supabaseUrl: '', supabaseAnonKey: '' };

/** Chamado uma vez pelo app.js depois de criar o cliente do Supabase. */
export function configurarApi({ supabase, supabaseUrl = '', supabaseAnonKey = '', aoSessaoExpirada } = {}) {
  cliente = supabase || null;
  configuracao = { supabaseUrl: String(supabaseUrl).replace(/\/+$/, ''), supabaseAnonKey: String(supabaseAnonKey) };
  avisarSessaoExpirada = typeof aoSessaoExpirada === 'function' ? aoSessaoExpirada : null;
}

/** Cliente supabase-js do painel (o mesmo de ctx.supabase). */
export function obterSupabase() {
  if (!cliente) throw new Error('O painel ainda não foi iniciado (cliente do Supabase ausente).');
  return cliente;
}

/** { supabaseUrl, supabaseAnonKey } públicos (de /api/config). */
export function obterConfigSupabase() {
  return { ...configuracao };
}

function sessaoExpirou() {
  if (avisarSessaoExpirada) {
    try { avisarSessaoExpirada(); } catch (erro) { console.error('[painel] aoSessaoExpirada falhou:', erro); }
  }
}

/**
 * JWT da sessão atual (o supabase-js renova sozinho quando está perto de vencer).
 * { forcarRenovacao: true } pede um token novo ao Auth. Sem sessão → null.
 */
export async function obterToken({ forcarRenovacao = false } = {}) {
  const supa = obterSupabase();
  try {
    if (forcarRenovacao) {
      const { data, error } = await supa.auth.refreshSession();
      if (!error && data && data.session) return data.session.access_token;
    }
    const { data } = await supa.auth.getSession();
    const sessao = data && data.session;
    if (!sessao) return null;
    if (forcarRenovacao && Number(sessao.expires_at || 0) * 1000 <= Date.now()) return null;
    return sessao.access_token;
  } catch {
    return null;
  }
}

const MENSAGENS_HTTP = {
  0: 'Não foi possível falar com o servidor. Verifique sua internet e tente de novo.',
  400: 'Alguns dados não foram aceitos. Confira e tente de novo.',
  401: 'Sua sessão expirou. Entre novamente.',
  403: 'Você não tem permissão para fazer isso.',
  404: 'Não encontrado.',
  405: 'Operação não permitida.',
  409: 'A operação não pôde ser concluída no estado atual.',
  413: 'Os dados enviados são grandes demais.',
  429: 'Muitas tentativas seguidas. Aguarde um pouco e tente de novo.',
  500: 'Erro interno no servidor. Tente de novo em instantes.',
  502: 'Um serviço externo não respondeu. Tente de novo em instantes.',
  503: 'Esta integração ainda não está configurada.',
  504: 'O servidor demorou demais para responder. Tente de novo.',
};

/** Mensagem padrão para um status HTTP. */
export function mensagemHttp(status) {
  if (MENSAGENS_HTTP[status]) return MENSAGENS_HTTP[status];
  return status >= 500 ? MENSAGENS_HTTP[500] : 'Não foi possível concluir. Tente de novo.';
}

function caminhoSeguro(caminho) {
  const texto = String(caminho || '').trim();
  if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(texto)) return null; // nunca manda o token para outro domínio
  if (texto.startsWith('/api/')) return texto;
  if (!texto.startsWith('/')) return `/api/${texto}`;
  return null;
}

/**
 * Chama uma rota do servidor com Authorization: Bearer <jwt da sessão>.
 * caminho: '/api/admin/status' (ou 'admin/status'). metodo padrão: GET sem corpo, POST com corpo.
 * opções: { metodo, corpo (objeto → JSON), sinal (AbortSignal), timeoutMs = 30000 }.
 * → { ok: true, ...resposta } | { ok: false, erro, mensagem, status, ...extras da resposta }.
 * 401: renova o token e tenta uma vez; se continuar 401, avisa o app (volta ao login).
 */
export async function chamarApi(caminho, { metodo, corpo, sinal, timeoutMs = 30_000 } = {}) {
  const url = caminhoSeguro(caminho);
  if (!url) return { ok: false, erro: 'caminho_invalido', mensagem: 'Endereço de API inválido.', status: 0 };
  const verbo = (metodo || (corpo === undefined ? 'GET' : 'POST')).toUpperCase();

  async function tentar(token) {
    const controle = new AbortController();
    const cancelar = () => controle.abort(new DOMException('cancelado', 'AbortError'));
    if (sinal) {
      if (sinal.aborted) cancelar();
      else sinal.addEventListener('abort', cancelar, { once: true });
    }
    let estourou = false;
    const timer = setTimeout(() => { estourou = true; controle.abort(); }, timeoutMs);
    const cabecalhos = { Accept: 'application/json' };
    if (token) cabecalhos.Authorization = `Bearer ${token}`;
    if (corpo !== undefined) cabecalhos['Content-Type'] = 'application/json';
    try {
      const resposta = await fetch(url, {
        method: verbo,
        headers: cabecalhos,
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        signal: controle.signal,
        cache: 'no-store',
        credentials: 'same-origin',
      });
      let json = null;
      try { json = await resposta.json(); } catch { json = null; }
      return { resposta, json };
    } catch (erro) {
      if (estourou) return { falha: { ok: false, erro: 'tempo_esgotado', mensagem: MENSAGENS_HTTP[504], status: 0 } };
      if (sinal && sinal.aborted) return { falha: { ok: false, erro: 'cancelado', mensagem: 'Operação cancelada.', status: 0 } };
      return { falha: { ok: false, erro: 'sem_conexao', mensagem: MENSAGENS_HTTP[0], status: 0, detalhe: String(erro && erro.message || erro) } };
    } finally {
      clearTimeout(timer);
      if (sinal) sinal.removeEventListener('abort', cancelar);
    }
  }

  let token = await obterToken();
  let r = await tentar(token);
  if (r.falha) return r.falha;
  if (r.resposta.status === 401) {
    token = await obterToken({ forcarRenovacao: true });
    if (token) {
      r = await tentar(token);
      if (r.falha) return r.falha;
    }
    if (r.resposta.status === 401) sessaoExpirou();
  }

  const { resposta, json } = r;
  const status = resposta.status;
  if (resposta.ok && json && typeof json === 'object' && json.ok !== false) return { ...json, ok: true, status };
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    return {
      ...json,
      ok: false,
      erro: typeof json.erro === 'string' && json.erro ? json.erro : `http_${status}`,
      mensagem: typeof json.mensagem === 'string' && json.mensagem ? json.mensagem : mensagemHttp(status),
      status,
    };
  }
  if (resposta.ok) return { ok: false, erro: 'resposta_invalida', mensagem: 'Resposta inesperada do servidor.', status };
  return { ok: false, erro: `http_${status}`, mensagem: mensagemHttp(status), status };
}

// ---------------------------------------------------------------------------
// Erros do Supabase (PostgREST, Auth e Storage) em português

const NOMES_CAMPOS = {
  slug: 'endereço (slug)', codigo: 'código', nome: 'nome', sku: 'SKU', chave: 'chave', email: 'e-mail',
};

/**
 * Converte um erro do supabase-js em { ok: false, erro, mensagem, status, campo?, detalhe }.
 * JWT vencido → avisa o app (login) e devolve erro 'nao_autenticado'.
 */
export function erroSupabase(erro, status) {
  const e = erro || {};
  const codigo = String(e.code || e.error || '');
  const mensagemOriginal = String(e.message || e.msg || e.error_description || '');
  const st = Number(status || e.status || e.statusCode || 0) || 0;
  const base = { ok: false, status: st, detalhe: mensagemOriginal || undefined };

  if (codigo === 'PGRST301' || codigo === 'PGRST303' || /jwt (expired|is expired)|invalid jwt|token is expired/i.test(mensagemOriginal) || st === 401) {
    sessaoExpirou();
    return { ...base, erro: 'nao_autenticado', mensagem: MENSAGENS_HTTP[401] };
  }
  if (e.name === 'AuthRetryableFetchError' || /failed to fetch|networkerror|load failed|network request failed/i.test(mensagemOriginal)) {
    return { ...base, erro: 'sem_conexao', mensagem: MENSAGENS_HTTP[0] };
  }
  if (codigo === '42501' || st === 403 || /row-level security|permission denied/i.test(mensagemOriginal)) {
    return { ...base, erro: 'sem_permissao', mensagem: 'Você não tem permissão para esta ação.' };
  }
  if (codigo === '23505') {
    const m = String(e.details || '').match(/Key \(([^)]+)\)/);
    const campo = m ? m[1] : undefined;
    const nome = campo ? NOMES_CAMPOS[campo] || campo : '';
    return { ...base, erro: 'duplicado', campo, mensagem: nome ? `Já existe um registro com este ${nome}.` : 'Já existe um registro igual.' };
  }
  if (codigo === '23503') {
    return { ...base, erro: 'em_uso', mensagem: 'Este item está ligado a outros registros e não pode ser removido.' };
  }
  if (codigo === '23502') {
    const m = mensagemOriginal.match(/column "([^"]+)"/);
    return { ...base, erro: 'campo_obrigatorio', campo: m ? m[1] : undefined, mensagem: 'Preencha os campos obrigatórios.' };
  }
  if (codigo === '23514' || codigo === '22P02' || codigo === '22003' || codigo === '22001') {
    const m = mensagemOriginal.match(/constraint "([^"]+)"/);
    return { ...base, erro: 'dados_invalidos', restricao: m ? m[1] : undefined, mensagem: 'Algum valor não foi aceito. Confira os campos e tente de novo.' };
  }
  if (codigo === 'PGRST116') {
    return { ...base, erro: 'nao_encontrado', mensagem: 'Registro não encontrado.' };
  }
  if (st === 413 || /payload too large|maximum allowed size|exceeded the maximum/i.test(mensagemOriginal)) {
    return { ...base, erro: 'muito_grande', mensagem: 'O arquivo passa do limite de 50 MB.' };
  }
  if (/mime type .* not supported|invalid_mime_type/i.test(mensagemOriginal)) {
    return { ...base, erro: 'tipo_nao_aceito', mensagem: 'Tipo de arquivo não aceito. Use JPG, PNG, WebP, GIF, AVIF, MP4 ou WebM.' };
  }
  if (st === 429) return { ...base, erro: 'muitas_tentativas', mensagem: MENSAGENS_HTTP[429] };
  return { ...base, erro: 'erro_supabase', mensagem: 'Não foi possível concluir a operação. Tente de novo.' };
}

/**
 * Executa uma consulta do supabase-js e normaliza o resultado.
 *   const r = await api.consultar(ctx.supabase.from('produtos').select('*', { count: 'exact' }));
 *   if (!r.ok) return ui.toast(r.mensagem, 'erro');
 *   r.dados, r.total
 * → { ok: true, dados, total, status } | { ok: false, erro, mensagem, ... }
 */
export async function consultar(construtor) {
  let resultado;
  try {
    resultado = await construtor;
  } catch (erro) {
    return erroSupabase(erro);
  }
  if (!resultado) return { ok: false, erro: 'erro_supabase', mensagem: 'Resposta vazia do banco.', status: 0 };
  if (resultado.error) return erroSupabase(resultado.error, resultado.status);
  return { ok: true, dados: resultado.data ?? null, total: resultado.count ?? null, status: resultado.status };
}
