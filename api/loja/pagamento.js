// POST /api/loja/pagamento — Checkout Transparente: paga o pedido com Pix, boleto ou cartão sem sair do site
// (docs/ARQUITETURA.md §6.7).
//
// Corpo: { id, token, metodo: 'pix' | 'boleto' | 'cartao', chave (UUID novo a cada tentativa), dispositivo?,
//          cartao?: { token, payment_method_id, issuer_id, parcelas, tipo_documento, documento } }
// (os dados do cartão vêm do MercadoPago.js: o número do cartão nunca passa por aqui, só o token).
//
// 1. Sem MP_ACCESS_TOKEN + MP_PUBLIC_KEY → 503. Id ou token errados → o mesmo 404 da página do pedido.
// 2. Pedido pago, cancelado ou com cartão em análise → 409. Boleto desligado no painel ou parcelas acima do
//    máximo → 400.
// 3. Pix ou boleto em aberto do mesmo método: devolve o mesmo, sem criar outro. De outro método: cancela o que
//    está em aberto antes (para a cliente não pagar duas vezes).
// 4. POST /v1/payments com o total do banco e X-Idempotency-Key = <pedido>:<chave>; sincroniza o pedido
//    (confirmar_pagamento, e-mails) e devolve { ok, pagamento: resumoDoPagamento(...) }.
// Cartão recusado não é erro: volta 200 com pagamento.status 'rejected' e a mensagem para a cliente.

import { obterAmbiente } from '../../lib/ambiente.js';
import { ErroHttp, exigirMetodo, lerCorpo, responderJson, tratarErro, urlBase } from '../../lib/http.js';
import {
  buscarPedido, CABECALHOS_SEM_CACHE, erroDaLoja, lerConfiguracoes, registrarEvento, sincronizarPagamento,
} from '../../lib/loja.js';
import {
  cancelarPagamento, configuracaoCheckout, criarPagamento, METODOS_PAGAMENTO, montarPagamento, obterPagamento,
  resumoDoPagamento,
} from '../../lib/mercadopago.js';
import { somenteDigitos, validarCpf, validarUuid } from '../../lib/validacao.js';
import { pagamentoEmAberto, tokenConfere } from './pedido.js';

const SELECT = '*,pedido_itens(produto_id,nome,imagem,quantidade,preco_unitario_centavos,total_centavos)';
const PAGOS = new Set(['pago', 'em_separacao', 'enviado', 'entregue']);
const TIMEOUT_CONSULTA_MS = 8_000;

const MSG_SEM_PAGAMENTO = 'O pagamento online ainda não está disponível. Tente novamente mais tarde ou fale com a AMA pelo WhatsApp.';

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const texto = (v) => (typeof v === 'string' ? v.trim() : (typeof v === 'number' && Number.isFinite(v) ? String(v) : ''));

const naoEncontrado = () => new ErroHttp(404, 'pedido_nao_encontrado',
  'Pedido não encontrado. Confira o link recebido no e-mail ou fale com a AMA.');
const invalido = (campo, mensagem) => new ErroHttp(400, 'dados_invalidos', mensagem, { campo });

/** Dados do cartão vindos do MercadoPago.js, conferidos. Lança 400 com o campo. */
export function lerCartao(bruto, parcelasMax) {
  const c = ehObjeto(bruto) ? bruto : {};
  const token = texto(c.token);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(token)) throw invalido('cartao', 'Confira os dados do cartão.');
  const meio = texto(c.payment_method_id).toLowerCase();
  if (!/^[a-z0-9_]{2,40}$/.test(meio)) throw invalido('cartao', 'Confira o número do cartão.');
  const emissor = texto(c.issuer_id);
  if (emissor && !/^\d{1,15}$/.test(emissor)) throw invalido('cartao', 'Confira os dados do cartão.');
  const parcelas = Number(c.parcelas);
  if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > parcelasMax) {
    throw invalido('cartao.parcelas', parcelasMax === 1 ? 'O pagamento no cartão é à vista.' : `Escolha de 1 a ${parcelasMax} parcelas.`);
  }
  const tipo = texto(c.tipo_documento).toUpperCase() === 'CNPJ' ? 'CNPJ' : 'CPF';
  const documento = somenteDigitos(c.documento);
  if (tipo === 'CPF' ? !validarCpf(documento) : documento.length !== 14) {
    throw invalido('cartao.documento', `Confira o ${tipo} do titular do cartão.`);
  }
  return { token, payment_method_id: meio, issuer_id: emissor, parcelas, tipo_documento: tipo, documento };
}

/** Lança 409 quando o pedido não pode receber um pagamento novo. */
function conferirSituacao(pedido) {
  if (PAGOS.has(pedido.status)) throw new ErroHttp(409, 'pedido_pago', 'Este pedido já foi pago.');
  if (pedido.status === 'cancelado' || pedido.status === 'reembolsado') {
    throw new ErroHttp(409, 'pedido_cancelado', 'Este pedido foi cancelado. Para comprar, faça um novo pedido na loja.');
  }
  if (pedido.status === 'pagamento_em_analise' && !pagamentoEmAberto(pedido)) {
    throw new ErroHttp(409, 'pagamento_em_analise', 'O pagamento deste pedido está em análise. Aguarde o resultado.');
  }
}

// O pagamento já existe no Mercado Pago: falha ao sincronizar não volta ao cliente (o webhook refaz depois).
async function sincronizar(pagamento, siteUrl) {
  try {
    await sincronizarPagamento(pagamento, { siteUrl });
  } catch (erro) {
    console.error(`[pagamento] falha ao sincronizar o pagamento ${pagamento && pagamento.id}:`,
      erro && (erro.mensagem || erro.message));
  }
}

/**
 * Pix ou boleto em aberto: devolve o resumo para reaproveitar (mesmo método e ainda pendente) ou cancela
 * e devolve null. Também sincroniza o pedido quando o Mercado Pago já tem outra situação (ex.: pago).
 */
async function tratarEmAberto(pedido, metodo, siteUrl) {
  const aberto = pagamentoEmAberto(pedido);
  if (!aberto) return null;
  const atual = await obterPagamento(aberto.id, { timeoutMs: TIMEOUT_CONSULTA_MS });
  if (!atual) return null;
  if (atual.status !== 'pending') {
    await sincronizar(atual, siteUrl);
    return null;
  }
  const resumo = resumoDoPagamento(atual);
  if (aberto.metodo === metodo && (resumo.pix || resumo.boleto)) return resumo;
  try {
    await sincronizar(await cancelarPagamento(aberto.id), siteUrl);
  } catch (erro) {
    console.error(`[pagamento] pedido #${pedido.numero}: não foi possível cancelar o pagamento ${aberto.id}:`,
      erro && (erro.mensagem || erro.message));
    await registrarEvento(pedido.id, 'alerta',
      `Não foi possível cancelar o ${aberto.metodo === 'pix' ? 'Pix' : 'boleto'} anterior: confira se a cliente não pagou duas vezes`,
      { mp_payment_id: aberto.id });
  }
  return null;
}

export default async function handler(req, res) {
  if (!exigirMetodo(req, res, ['POST'])) return;
  try {
    const corpo = await lerCorpo(req);
    if (!obterAmbiente().checkoutTransparente) throw new ErroHttp(503, 'pagamento_indisponivel', MSG_SEM_PAGAMENTO);
    const c = ehObjeto(corpo) ? corpo : {};
    const metodo = texto(c.metodo);
    if (!METODOS_PAGAMENTO.includes(metodo)) throw invalido('metodo', 'Escolha Pix, cartão ou boleto.');
    const chave = texto(c.chave).toLowerCase();
    if (!validarUuid(chave)) throw invalido('chave', 'Não foi possível iniciar o pagamento. Recarregue a página e tente de novo.');
    const id = texto(c.id).toLowerCase();
    const token = texto(c.token);
    if (!validarUuid(id) || !token || token.length > 200) throw naoEncontrado();

    let pedido = await buscarPedido(id, SELECT);
    if (!pedido || !tokenConfere(token, pedido.token_acesso)) throw naoEncontrado();

    const config = await lerConfiguracoes();
    const regras = configuracaoCheckout(config);
    if (metodo === 'boleto' && !regras.aceitarBoleto) {
      throw new ErroHttp(400, 'metodo_indisponivel', 'O boleto não está disponível. Pague com Pix ou cartão.');
    }
    const cartao = metodo === 'cartao' ? lerCartao(c.cartao, regras.parcelas) : null;
    conferirSituacao(pedido);

    const siteUrl = urlBase(req);
    if (pagamentoEmAberto(pedido)) {
      const reaproveitado = await tratarEmAberto(pedido, metodo, siteUrl);
      if (reaproveitado) {
        responderJson(res, 200, { ok: true, pagamento: reaproveitado }, CABECALHOS_SEM_CACHE);
        return;
      }
      pedido = (await buscarPedido(id, SELECT)) || pedido;
      conferirSituacao(pedido);
    }

    const pagamento = await criarPagamento(montarPagamento({ pedido, metodo, cartao, config, siteUrl }), {
      chaveIdempotencia: `${pedido.id}:${chave}`,
      sessaoDispositivo: texto(c.dispositivo),
    });
    await sincronizar(pagamento, siteUrl);
    responderJson(res, 200, { ok: true, pagamento: resumoDoPagamento(pagamento) }, CABECALHOS_SEM_CACHE);
  } catch (erro) {
    tratarErro(res, erroDaLoja(erro));
  }
}
