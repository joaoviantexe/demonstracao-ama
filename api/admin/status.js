// GET /api/admin/status — situação das integrações para o painel (docs/ARQUITETURA.md §6.6).
//
// mercadopago.modo: o prefixo do Access Token NÃO diz o ambiente (o token de teste também começa com
// APP_USR-; ver docs/pesquisa-apis.json → mercadopago). Por isso: MP_MODO=teste (ou test/sandbox) → 'teste';
// MP_MODO ausente ou producao/production → 'producao' (padrão); outro valor → null (desconhecido);
// sem MP_ACCESS_TOKEN → null.

import { obterAmbiente } from '../../lib/ambiente.js';
import { exigirAdmin } from '../../lib/admin.js';
import { exigirMetodo, responderJson, tratarErro, urlBase } from '../../lib/http.js';
import { CABECALHOS_SEM_CACHE } from '../../lib/loja.js';
import { saldo } from '../../lib/melhorenvio.js';

const TIMEOUT_SALDO_MS = 5_000;

/** 'teste' | 'producao' | null a partir de MP_MODO (ver o cabeçalho do arquivo). */
export function modoMercadoPago(configurado, valor = process.env.MP_MODO) {
  if (!configurado) return null;
  const modo = typeof valor === 'string' ? valor.trim().toLowerCase() : '';
  if (!modo || ['producao', 'produção', 'production', 'prod'].includes(modo)) return 'producao';
  if (['teste', 'test', 'sandbox'].includes(modo)) return 'teste';
  return null;
}

async function situacaoMelhorEnvio(ambiente) {
  const situacao = {
    configurado: ambiente.melhorEnvioConfigurado,
    ambiente: ambiente.melhorEnvioAmbiente,
    saldo_centavos: null,
    erro: null,
  };
  if (!ambiente.melhorEnvioConfigurado) return situacao;
  try {
    situacao.saldo_centavos = await saldo({ timeoutMs: TIMEOUT_SALDO_MS });
  } catch (erro) {
    situacao.erro = erro && (erro.mensagem || erro.message) ? String(erro.mensagem || erro.message) : 'Falha ao consultar o saldo.';
  }
  return situacao;
}

export default async function handler(req, res) {
  if (!exigirMetodo(req, res, ['GET'])) return;
  const admin = await exigirAdmin(req, res);
  if (!admin) return;
  try {
    const ambiente = obterAmbiente();
    responderJson(res, 200, {
      ok: true,
      integracoes: {
        supabase: { configurado: ambiente.supabaseConfigurado },
        mercadopago: {
          configurado: ambiente.mercadoPagoConfigurado,
          modo: modoMercadoPago(ambiente.mercadoPagoConfigurado),
        },
        melhor_envio: await situacaoMelhorEnvio(ambiente),
        email: { configurado: ambiente.emailConfigurado },
        webhook_assinatura: Boolean(ambiente.mpWebhookSecret),
        site_url: urlBase(req),
      },
    }, CABECALHOS_SEM_CACHE);
  } catch (erro) {
    tratarErro(res, erro);
  }
}
