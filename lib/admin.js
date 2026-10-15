// Autenticação das rotas de admin (docs/ARQUITETURA.md §6.6).
// O painel envia Authorization: Bearer <jwt da sessão do Supabase>.

import { responderErro } from './http.js';
import { ErroSupabase, servico, usuarioDoToken } from './supabase.js';

function tokenDaRequisicao(req) {
  const bruto = req && req.headers ? req.headers.authorization : undefined;
  const valor = Array.isArray(bruto) ? bruto[0] : bruto;
  const m = typeof valor === 'string' ? valor.match(/^\s*Bearer\s+(\S+)\s*$/i) : null;
  return m ? m[1] : '';
}

function responderFalha(res, erro) {
  if (erro && erro.name === 'ErroHttp' && Number.isInteger(erro.status)) {
    responderErro(res, erro.status, erro.erro, erro.mensagem, erro.extra);
    return;
  }
  if (erro instanceof ErroSupabase) {
    console.error('[admin] falha ao validar o acesso:', erro.status, erro.codigo);
    responderErro(res, 502, 'falha_supabase', 'Não foi possível verificar o acesso agora. Tente novamente.');
    return;
  }
  console.error('[admin] erro inesperado ao validar o acesso:', erro);
  responderErro(res, 500, 'erro_interno', 'Erro interno. Tente novamente em instantes.');
}

/**
 * Exige um admin logado. Devolve { id, email } ou null — neste caso já respondeu:
 * 401 'nao_autenticado' (sem token, token inválido ou expirado), 403 'sem_permissao' (não está em admins),
 * 503 'supabase_nao_configurado', 502 'falha_supabase' (Auth/banco fora do ar).
 */
export async function exigirAdmin(req, res) {
  const token = tokenDaRequisicao(req);
  if (!token) {
    responderErro(res, 401, 'nao_autenticado', 'Entre no painel para continuar.');
    return null;
  }
  try {
    const usuario = await usuarioDoToken(token);
    if (!usuario) {
      responderErro(res, 401, 'nao_autenticado', 'Sua sessão expirou. Entre novamente.');
      return null;
    }
    const linhas = await servico().select('admins', {
      select: 'user_id',
      user_id: `eq.${usuario.id}`,
      limit: 1,
    });
    if (!linhas.length) {
      responderErro(res, 403, 'sem_permissao', 'Este usuário não tem acesso ao painel.');
      return null;
    }
    return { id: usuario.id, email: usuario.email };
  } catch (erro) {
    responderFalha(res, erro);
    return null;
  }
}
