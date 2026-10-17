// GET /api/loja/pedido?id=&token=[&payment_id=] — acompanhamento do pedido pelo cliente (docs/ARQUITETURA.md §6.4).
//
// - Token comparado em tempo constante (SHA-256 dos dois lados + timingSafeEqual, buffers de mesmo tamanho).
//   Id inválido, pedido inexistente ou token errado → o mesmo 404 genérico.
// - Com payment_id (volta do Mercado Pago) e o MP configurado: consulta o pagamento, confere
//   external_reference === id e sincroniza (funciona mesmo se o webhook não chegou). Falha nessa
//   consulta não impede mostrar o pedido.
// - Checkout Transparente (MP_ACCESS_TOKEN + MP_PUBLIC_KEY): `pagamento` traz os métodos aceitos, o máximo de
//   parcelas e o Pix ou boleto ainda em aberto (QR, copia e cola, link e linha digitável), consultado no
//   Mercado Pago a cada visita; se a situação mudou lá (pago, vencido), o pedido é sincronizado antes.
// - Nunca expõe CPF, e-mail, telefone, endereço, token, notas internas nem dados de pagamento além do status
//   e do Pix/boleto em aberto.

import { createHash, timingSafeEqual } from 'node:crypto';
import { obterAmbiente } from '../../lib/ambiente.js';
import { ErroHttp, exigirMetodo, lerQuery, responderJson, tratarErro, urlBase } from '../../lib/http.js';
import {
  buscarPedido, CABECALHOS_SEM_CACHE, erroDaLoja, lerConfiguracoes, sincronizarPagamento,
} from '../../lib/loja.js';
import { configuracaoCheckout, obterPagamento, resumoDoPagamento } from '../../lib/mercadopago.js';
import { validarUuid } from '../../lib/validacao.js';

const SELECT = [
  'id', 'numero', 'token_acesso', 'status', 'status_pagamento', 'criado_em', 'pago_em', 'enviado_em',
  'subtotal_centavos', 'frete_centavos', 'total_centavos', 'entrega',
  'codigo_rastreio', 'url_rastreio', 'cliente_nome', 'mp_init_point', 'mp_payment_id', 'metodo_pagamento',
  'pedido_itens(nome,imagem,quantidade,preco_unitario_centavos,total_centavos)',
].join(',');

// A página do cliente espera esta consulta: prazo curto (sem resposta, mostra o pedido como está).
const TIMEOUT_CONSULTA_MS = 8_000;

const naoEncontrado = () => new ErroHttp(404, 'pedido_nao_encontrado',
  'Pedido não encontrado. Confira o link recebido no e-mail ou fale com a AMA.');

const resumo = (texto) => createHash('sha256').update(String(texto), 'utf8').digest();

/** true se o token confere. Tempo constante: os dois lados viram SHA-256 (32 bytes) antes da comparação. */
export function tokenConfere(recebido, esperado) {
  if (typeof recebido !== 'string' || typeof esperado !== 'string' || !esperado) return false;
  const iguais = timingSafeEqual(resumo(recebido), resumo(esperado));
  return iguais && recebido.length === esperado.length;
}

function primeiroNome(nome) {
  const limpo = String(nome ?? '').replace(/\s+/g, ' ').trim();
  return limpo ? limpo.split(' ')[0] : '';
}

// Tipo de pagamento (payment_type_id) do Pix e do boleto, que ficam em aberto até a cliente pagar.
const TIPOS_EM_ABERTO = { bank_transfer: 'pix', ticket: 'boleto' };

/** Pix ou boleto do pedido ainda pendente no último status conhecido: { id, metodo } | null. */
export function pagamentoEmAberto(p) {
  const metodo = TIPOS_EM_ABERTO[p && p.metodo_pagamento];
  const id = p && typeof p.mp_payment_id === 'string' ? p.mp_payment_id : '';
  if (!metodo || !/^\d{1,20}$/.test(id) || p.status_pagamento !== 'pending') return null;
  if (p.status !== 'aguardando_pagamento' && p.status !== 'pagamento_em_analise') return null;
  return { id, metodo };
}

/**
 * Linha de pedidos → saída pública da §6.4 (sem dados pessoais).
 * opcoes (Checkout Transparente): { transparente, checkout (configuração `checkout`), pendente (resumoDoPagamento) }.
 */
export function pedidoPublico(p, { transparente = false, checkout = null, pendente = null } = {}) {
  const entrega = p.entrega && typeof p.entrega === 'object' ? p.entrega : {};
  const emAberto = pendente && (pendente.pix || pendente.boleto) ? pendente : null;
  const podePagar = transparente
    ? p.status === 'aguardando_pagamento' || (p.status === 'pagamento_em_analise' && Boolean(emAberto))
    : p.status === 'aguardando_pagamento' && typeof p.mp_init_point === 'string' && p.mp_init_point !== '';
  let pagamento = null;
  if (transparente && podePagar) {
    const regras = configuracaoCheckout(checkout);
    pagamento = {
      metodos: regras.aceitarBoleto ? ['pix', 'cartao', 'boleto'] : ['pix', 'cartao'],
      parcelas_max: regras.parcelas,
      pendente: emAberto,
    };
  }
  return {
    numero: p.numero,
    status: p.status,
    status_pagamento: p.status_pagamento ?? null,
    criado_em: p.criado_em,
    pago_em: p.pago_em ?? null,
    enviado_em: p.enviado_em ?? null,
    itens: (Array.isArray(p.pedido_itens) ? p.pedido_itens : []).map((item) => ({
      nome: item.nome,
      imagem: item.imagem ?? null,
      quantidade: item.quantidade,
      preco_unitario_centavos: item.preco_unitario_centavos,
      total_centavos: item.total_centavos,
    })),
    subtotal_centavos: p.subtotal_centavos,
    frete_centavos: p.frete_centavos,
    total_centavos: p.total_centavos,
    entrega: {
      tipo: entrega.tipo ?? null,
      nome: entrega.nome ?? null,
      empresa: entrega.empresa ?? null,
      prazo_dias: entrega.prazo_dias ?? null,
    },
    codigo_rastreio: p.codigo_rastreio ?? null,
    url_rastreio: p.url_rastreio ?? null,
    primeiro_nome: primeiroNome(p.cliente_nome),
    pode_pagar: podePagar,
    link_pagamento: podePagar && !transparente ? p.mp_init_point : null,
    pagamento,
  };
}

// Sincroniza com o pagamento informado na volta do Mercado Pago. Nunca lança.
async function sincronizarRetorno(pedidoId, paymentId, siteUrl) {
  if (!obterAmbiente().mercadoPagoConfigurado || !/^\d{1,20}$/.test(paymentId)) return false;
  try {
    const pagamento = await obterPagamento(paymentId, { timeoutMs: TIMEOUT_CONSULTA_MS });
    if (!pagamento || String(pagamento.external_reference ?? '').trim().toLowerCase() !== pedidoId) return false;
    await sincronizarPagamento(pagamento, { siteUrl });
    return true;
  } catch (erro) {
    console.error(`[pedido] falha ao sincronizar o pagamento ${paymentId}:`, erro && (erro.mensagem || erro.message));
    return false;
  }
}

// Pix ou boleto em aberto: consulta o Mercado Pago, sincroniza se a situação mudou e devolve
// { pedido, pendente } (pendente = resumo do pagamento se ele continua em aberto). Nunca lança.
async function conferirEmAberto(pedido, select, siteUrl) {
  const aberto = pagamentoEmAberto(pedido);
  if (!aberto) return { pedido, pendente: null };
  try {
    const pagamento = await obterPagamento(aberto.id, { timeoutMs: TIMEOUT_CONSULTA_MS });
    if (!pagamento) return { pedido, pendente: null };
    let atual = pedido;
    if (String(pagamento.status) !== pedido.status_pagamento) {
      await sincronizarPagamento(pagamento, { siteUrl });
      atual = (await buscarPedido(pedido.id, select)) || pedido;
    }
    return { pedido: atual, pendente: pagamento.status === 'pending' ? resumoDoPagamento(pagamento) : null };
  } catch (erro) {
    console.error(`[pedido] falha ao consultar o pagamento ${aberto.id}:`, erro && (erro.mensagem || erro.message));
    return { pedido, pendente: null };
  }
}

export default async function handler(req, res) {
  if (!exigirMetodo(req, res, ['GET'])) return;
  try {
    const query = lerQuery(req);
    const id = typeof query.id === 'string' ? query.id.trim().toLowerCase() : '';
    const token = typeof query.token === 'string' ? query.token.trim() : '';
    if (!validarUuid(id) || !token || token.length > 200) throw naoEncontrado();

    let pedido = await buscarPedido(id, SELECT);
    if (!pedido || !tokenConfere(token, pedido.token_acesso)) throw naoEncontrado();

    const paymentId = typeof query.payment_id === 'string' ? query.payment_id.trim() : '';
    if (paymentId && await sincronizarRetorno(id, paymentId, urlBase(req))) {
      pedido = (await buscarPedido(id, SELECT)) || pedido;
    }

    const { checkoutTransparente } = obterAmbiente();
    let pendente = null;
    let checkout = null;
    if (checkoutTransparente) {
      ({ pedido, pendente } = await conferirEmAberto(pedido, SELECT, urlBase(req)));
      if (pedido.status === 'aguardando_pagamento' || pedido.status === 'pagamento_em_analise') {
        checkout = (await lerConfiguracoes()).checkout;
      }
    }

    responderJson(res, 200, {
      ok: true,
      pedido: pedidoPublico(pedido, { transparente: checkoutTransparente, checkout, pendente }),
    }, CABECALHOS_SEM_CACHE);
  } catch (erro) {
    if (!res.headersSent) res.setHeader('Cache-Control', 'no-store');
    tratarErro(res, erroDaLoja(erro));
  }
}
