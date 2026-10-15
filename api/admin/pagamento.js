// POST /api/admin/pagamento — conferência manual do pagamento no Mercado Pago (docs/ARQUITETURA.md §6.6).
// Entrada { pedido_id }. Busca GET /v1/payments/search?external_reference=<id>, escolhe o pagamento aprovado
// mais recente (senão o mais recente) e sincroniza com confirmar_pagamento (e-mails se virou pago).
// Saída { ok, encontrado, total_pagamentos, pagamento: { id, status, status_detail, transaction_amount,
// payment_type_id, payment_method_id, date_created, date_approved } | null, resultado | null, mensagem? }.

import { obterAmbiente } from '../../lib/ambiente.js';
import { exigirAdmin } from '../../lib/admin.js';
import { ErroHttp, exigirMetodo, lerCorpo, responderJson, tratarErro, urlBase } from '../../lib/http.js';
import {
  buscarPedido, CABECALHOS_SEM_CACHE, erroDaLoja, sincronizarPagamento,
} from '../../lib/loja.js';
import { buscarPagamentosPorReferencia } from '../../lib/mercadopago.js';
import { validarUuid } from '../../lib/validacao.js';

const APROVADOS = ['approved', 'authorized'];

/** Aprovado mais recente; senão o mais recente. A lista já vem do mais recente ao mais antigo. */
export function escolherPagamento(lista) {
  const pagamentos = Array.isArray(lista) ? lista : [];
  return pagamentos.find((p) => APROVADOS.includes(p.status)) || pagamentos[0] || null;
}

const resumoPagamento = (p) => ({
  id: p.id,
  status: p.status ?? null,
  status_detail: p.status_detail ?? null,
  transaction_amount: p.transaction_amount ?? null,
  payment_type_id: p.payment_type_id ?? null,
  payment_method_id: p.payment_method_id ?? null,
  date_created: p.date_created ?? null,
  date_approved: p.date_approved ?? null,
});

export default async function handler(req, res) {
  if (!exigirMetodo(req, res, ['POST'])) return;
  const admin = await exigirAdmin(req, res);
  if (!admin) return;
  try {
    const corpo = await lerCorpo(req);
    const pedidoId = typeof corpo.pedido_id === 'string' ? corpo.pedido_id.trim().toLowerCase() : '';
    if (!validarUuid(pedidoId)) throw new ErroHttp(400, 'dados_invalidos', 'Pedido inválido.', { campo: 'pedido_id' });
    if (!obterAmbiente().mercadoPagoConfigurado) {
      throw new ErroHttp(503, 'pagamento_indisponivel', 'O Mercado Pago não está configurado (falta MP_ACCESS_TOKEN).');
    }
    const pedido = await buscarPedido(pedidoId, 'id,numero');
    if (!pedido) throw new ErroHttp(404, 'pedido_nao_encontrado', 'Pedido não encontrado.');

    const pagamentos = await buscarPagamentosPorReferencia(pedido.id);
    const escolhido = escolherPagamento(pagamentos);
    if (!escolhido) {
      responderJson(res, 200, {
        ok: true,
        encontrado: false,
        total_pagamentos: 0,
        pagamento: null,
        resultado: null,
        mensagem: 'Nenhum pagamento deste pedido foi encontrado no Mercado Pago (a busca cobre os últimos 12 meses).',
      }, CABECALHOS_SEM_CACHE);
      return;
    }

    const resultado = await sincronizarPagamento(escolhido, { siteUrl: urlBase(req) });
    responderJson(res, 200, {
      ok: true,
      encontrado: true,
      total_pagamentos: pagamentos.length,
      pagamento: resumoPagamento(escolhido),
      resultado,
    }, CABECALHOS_SEM_CACHE);
  } catch (erro) {
    tratarErro(res, erroDaLoja(erro));
  }
}
