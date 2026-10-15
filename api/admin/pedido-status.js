// POST /api/admin/pedido-status — muda o status do pedido pelo painel (docs/ARQUITETURA.md §6.6).
// Entrada { pedido_id, status, codigo_rastreio?, url_rastreio?, nota?, repor_estoque?, notificar_cliente? }.
// Chama alterar_status_pedido com autor = e-mail do admin. Com notificar_cliente e status enviado,
// entregue ou cancelado, envia o e-mail ao cliente (evento 'email' quando enviado).
// Saída { ok, pedido_id, numero, status_anterior, status_novo, mudou, estoque_reposto, estoque_baixado,
// email_enviado: true | false | null (null = não foi pedido ou o status não tem e-mail) }.

import { exigirAdmin } from '../../lib/admin.js';
import { ErroHttp, exigirMetodo, lerCorpo, responderJson, tratarErro, urlBase } from '../../lib/http.js';
import { CABECALHOS_SEM_CACHE, enviarEmailStatus, erroDaLoja } from '../../lib/loja.js';
import { servico } from '../../lib/supabase.js';
import { validarUuid } from '../../lib/validacao.js';

export const STATUS_PEDIDO = Object.freeze([
  'aguardando_pagamento', 'pagamento_em_analise', 'pago', 'em_separacao', 'enviado', 'entregue', 'cancelado', 'reembolsado',
]);
const STATUS_COM_EMAIL = ['enviado', 'entregue', 'cancelado'];

function textoOpcional(corpo, campo, max, mensagem) {
  const valor = corpo[campo];
  if (valor === undefined) return undefined;
  if (valor === null) return null;
  if (typeof valor !== 'string') throw new ErroHttp(400, 'dados_invalidos', mensagem, { campo });
  const limpo = valor.trim();
  if (limpo.length > max) throw new ErroHttp(400, 'dados_invalidos', mensagem, { campo });
  return limpo || null;
}

/** Valida o corpo e devolve os argumentos de alterar_status_pedido (sem p_autor). */
export function argumentosStatus(corpo) {
  const pedidoId = typeof corpo.pedido_id === 'string' ? corpo.pedido_id.trim().toLowerCase() : '';
  if (!validarUuid(pedidoId)) throw new ErroHttp(400, 'dados_invalidos', 'Pedido inválido.', { campo: 'pedido_id' });
  const status = typeof corpo.status === 'string' ? corpo.status.trim().toLowerCase() : '';
  if (!STATUS_PEDIDO.includes(status)) throw new ErroHttp(400, 'status_invalido', 'Status de pedido inválido.', { campo: 'status' });

  const codigo = textoOpcional(corpo, 'codigo_rastreio', 200, 'Código de rastreio inválido (até 200 caracteres).');
  const url = textoOpcional(corpo, 'url_rastreio', 500, 'Link de rastreio inválido.');
  if (url && !/^https:\/\//i.test(url)) {
    throw new ErroHttp(400, 'dados_invalidos', 'O link de rastreio precisa começar com https://.', { campo: 'url_rastreio' });
  }
  let rastreio = null;
  if (codigo !== undefined || url !== undefined) {
    rastreio = {};
    if (codigo !== undefined) rastreio.codigo_rastreio = codigo;
    if (url !== undefined) rastreio.url_rastreio = url;
  }
  const nota = textoOpcional(corpo, 'nota', 2000, 'A nota pode ter no máximo 2000 caracteres.');

  return {
    p_pedido_id: pedidoId,
    p_status: status,
    p_nota: nota ?? null,
    p_repor_estoque: corpo.repor_estoque === true,
    p_rastreio: rastreio,
  };
}

export default async function handler(req, res) {
  if (!exigirMetodo(req, res, ['POST'])) return;
  const admin = await exigirAdmin(req, res);
  if (!admin) return;
  try {
    const corpo = await lerCorpo(req);
    const argumentos = argumentosStatus(corpo);
    let resultado;
    try {
      resultado = await servico().rpc('alterar_status_pedido', { ...argumentos, p_autor: admin.email || admin.id });
    } catch (erro) {
      throw erroDaLoja(erro);
    }

    let emailEnviado = null;
    if (corpo.notificar_cliente === true && STATUS_COM_EMAIL.includes(resultado.status_novo)) {
      emailEnviado = await enviarEmailStatus(argumentos.p_pedido_id, { siteUrl: urlBase(req), autor: admin.email || 'sistema' });
    }

    responderJson(res, 200, { ok: true, ...resultado, email_enviado: emailEnviado }, CABECALHOS_SEM_CACHE);
  } catch (erro) {
    tratarErro(res, erroDaLoja(erro));
  }
}
