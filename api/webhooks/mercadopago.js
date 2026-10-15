// POST /api/webhooks/mercadopago — notificações do Mercado Pago (docs/ARQUITETURA.md §6.5).
//
// 1. Aceita Webhooks (?data.id=123&type=payment, corpo { type, action, data: { id } }) e IPN
//    (?topic=payment&id=123). O id vem de preferência da query string. Tópico que não é pagamento → 200 ignorado.
// 2. Com MP_WEBHOOK_SECRET e x-signature: valida a assinatura (inválida → 401). Sem x-signature segue,
//    porque o passo 3 consulta o próprio Mercado Pago (um aviso falso não marca nada como pago).
//    Sem janela anti-replay: repetir uma notificação só refaz uma sincronização idempotente.
// 3. GET /v1/payments/{id} é a fonte da verdade. 404 → 200 ignorado; external_reference que não é UUID
//    ou pedido inexistente → 200 ignorado.
// 4. confirmar_pagamento (+ e-mails se virou pago) → 200.
// 5. Falha transitória (Mercado Pago ou banco fora) → 500 para o Mercado Pago tentar de novo.
// O Mercado Pago espera a resposta em até 22 s: a consulta ao pagamento tem prazo curto (TIMEOUT_CONSULTA_MS)
// e os e-mails, 5 s cada (em paralelo). Sem MP_ACCESS_TOKEN → 503 (o Mercado Pago reenvia depois).

import { obterAmbiente } from '../../lib/ambiente.js';
import { exigirMetodo, lerCorpo, lerQuery, responderJson, urlBase } from '../../lib/http.js';
import { sincronizarPagamento } from '../../lib/loja.js';
import { obterPagamento, validarAssinatura } from '../../lib/mercadopago.js';
import { validarUuid } from '../../lib/validacao.js';

const TIMEOUT_CONSULTA_MS = 8_000;

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const texto = (v) => (typeof v === 'string' ? v.trim() : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));

function cabecalho(req, nome) {
  const valor = req.headers ? req.headers[nome] : undefined;
  return Array.isArray(valor) ? valor[0] : valor;
}

/** Tópico e id da notificação nos dois formatos (Webhooks e IPN). */
export function lerNotificacao(query, corpo) {
  const c = ehObjeto(corpo) ? corpo : {};
  const dados = ehObjeto(c.data) ? c.data : {};
  const acao = texto(c.action);
  let topico = texto(query.type) || texto(query.topic) || texto(c.type) || texto(c.topic);
  if (!topico && /^payment\./.test(acao)) topico = 'payment';

  const idQuery = texto(query['data.id']) || texto(query.id);
  let idCorpo = texto(dados.id);
  // IPN antigo: { resource: "https://api.mercadopago.com/v1/payments/123" } ou só "123".
  if (!idCorpo && typeof c.resource === 'string') {
    const m = c.resource.trim().match(/(?:^|\/)(\d{1,20})$/);
    if (m) idCorpo = m[1];
  }
  return { topico: topico.toLowerCase(), id: idQuery || idCorpo, idQuery: texto(query['data.id']) };
}

const ignorar = (res, motivo) => responderJson(res, 200, { ok: true, ignorado: true, motivo });

export default async function handler(req, res) {
  if (!exigirMetodo(req, res, ['POST'])) return;
  try {
    const query = lerQuery(req);
    let corpo = {};
    try {
      corpo = await lerCorpo(req);
    } catch {
      corpo = {}; // corpo ilegível: a query string ainda pode trazer o tópico e o id
    }

    const { topico, id, idQuery } = lerNotificacao(query, corpo);
    if (topico !== 'payment') return ignorar(res, 'topico');

    const ambiente = obterAmbiente();
    const assinatura = cabecalho(req, 'x-signature');
    if (ambiente.mpWebhookSecret && assinatura) {
      const valida = validarAssinatura({
        xSignature: assinatura,
        xRequestId: cabecalho(req, 'x-request-id'),
        dataId: idQuery || id,
        segredo: ambiente.mpWebhookSecret,
      });
      if (!valida) {
        console.warn('[webhook] assinatura do Mercado Pago inválida: notificação recusada.');
        return responderJson(res, 401, { ok: false, erro: 'assinatura_invalida', mensagem: 'Assinatura inválida.' });
      }
    }

    if (!id) return ignorar(res, 'sem_id');
    if (!ambiente.mercadoPagoConfigurado) {
      return responderJson(res, 503, {
        ok: false, erro: 'pagamento_indisponivel', mensagem: 'Mercado Pago não configurado.',
      });
    }

    const pagamento = await obterPagamento(id, { timeoutMs: TIMEOUT_CONSULTA_MS });
    if (!pagamento) return ignorar(res, 'pagamento_inexistente');
    if (!validarUuid(String(pagamento.external_reference ?? ''))) return ignorar(res, 'referencia_externa');

    try {
      await sincronizarPagamento(pagamento, { siteUrl: urlBase(req) });
    } catch (erro) {
      if (erro && erro.status === 404) return ignorar(res, 'pedido_inexistente');
      if (erro && erro.status === 400) return ignorar(res, 'pagamento_invalido');
      throw erro;
    }
    return responderJson(res, 200, { ok: true });
  } catch (erro) {
    // Mercado Pago ou banco fora do ar: 500 faz o Mercado Pago reenviar mais tarde.
    console.error('[webhook] falha ao processar a notificação:', erro && (erro.mensagem || erro.message || erro));
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return undefined;
    }
    return responderJson(res, 500, {
      ok: false, erro: 'falha_temporaria', mensagem: 'Falha temporária ao processar a notificação.',
    });
  }
}
