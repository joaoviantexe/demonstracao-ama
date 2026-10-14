// GET /api/cron/manter-ativo — Vercel Cron diário (docs/ARQUITETURA.md §2).
// Faz uma leitura leve no banco para o projeto Supabase gratuito não ser pausado por inatividade.
// Com CRON_SECRET definido, exige Authorization: Bearer <CRON_SECRET> (a Vercel envia sozinha).

import { createHash, timingSafeEqual } from 'node:crypto';
import { obterAmbiente } from '../../lib/ambiente.js';
import { exigirMetodo, responderErro, responderJson, tratarErro } from '../../lib/http.js';
import { ErroSupabase, selecionarPublico, servico } from '../../lib/supabase.js';

// Compara em tempo constante (os hashes têm sempre o mesmo tamanho).
function iguaisSeguro(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export default async function handler(req, res) {
  try {
    if (!exigirMetodo(req, res, ['GET'])) return;
    const ambiente = obterAmbiente();

    if (ambiente.cronSecret) {
      const recebido = req.headers ? req.headers.authorization : undefined;
      const valor = Array.isArray(recebido) ? recebido[0] : recebido;
      if (typeof valor !== 'string' || !iguaisSeguro(valor, `Bearer ${ambiente.cronSecret}`)) {
        responderErro(res, 401, 'nao_autorizado', 'Não autorizado.');
        return;
      }
    }

    const consulta = 'select=chave&limit=1';
    if (ambiente.supabaseServicoConfigurado) {
      await servico({ timeoutMs: 10_000 }).select('configuracoes', consulta);
    } else {
      // Sem a chave de serviço, a leitura pública também conta como atividade (503 se nem ela existe).
      await selecionarPublico('configuracoes', consulta, { timeoutMs: 10_000 });
    }
    responderJson(res, 200, { ok: true }, { 'Cache-Control': 'no-store' });
  } catch (erro) {
    if (erro instanceof ErroSupabase) {
      console.error('[cron] falha na leitura do Supabase:', erro.status, erro.codigo);
      responderErro(res, 502, 'falha_supabase', 'Falha ao consultar o banco.');
      return;
    }
    tratarErro(res, erro);
  }
}
