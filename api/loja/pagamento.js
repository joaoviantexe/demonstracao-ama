// POST /api/loja/pagamento — Checkout Transparente: paga o pedido com Pix, boleto ou cartão sem sair do site
// (docs/ARQUITETURA.md §6.7).
//
// Corpo: { id, token, metodo: 'pix' | 'boleto' | 'cartao', chave (UUID novo a cada tentativa), dispositivo?,
//          cartao?: { token, payment_method_id, issuer_id, parcelas, tipo_documento, documento } }
// (os dados do cartão vêm do MercadoPago.js: o número do cartão nunca passa por aqui, só o token).
//
// 1. Sem MP_ACCESS_TOKEN + MP_PUBLIC_KEY → 503. Id ou token errados → o mesmo 404 da página do pedido.
// 2. Pedido pago, cancelado ou com cartão em análise (no banco) → 409. Boleto desligado no painel ou parcelas
//    acima do máximo → 400. Cartão com 5 recusas no pedido → 429 (freia teste de cartões roubados).
// 3. Antes de cobrar, confere no Mercado Pago todos os pagamentos do pedido (a busca + o que o banco aponta):
//    aprovado ou em análise → sincroniza e 409 (nunca cobra de novo). Pix ou boleto em aberto do mesmo método →
//    devolve o mesmo, sem criar outro; de outro método → cancela antes, e se não conseguir cancelar, não cobra
//    (502), para a cliente não pagar duas vezes.
// 4. POST /v1/payments com o total do banco e X-Idempotency-Key = sha256(<pedido>:<chave>): a mesma chave
//    (o navegador repete a chave quando a resposta não chegou) devolve o mesmo pagamento. Sincroniza o pedido
//    (confirmar_pagamento, e-mails) e devolve { ok, pagamento: resumoDoPagamento(...) }.
// Cartão recusado não é erro: volta 200 com pagamento.status 'rejected' e a mensagem para a cliente.

import { createHash } from 'node:crypto';
import { obterAmbiente } from '../../lib/ambiente.js';
import { ErroHttp, exigirMetodo, lerCorpo, responderJson, tratarErro, urlBase } from '../../lib/http.js';
import {
  buscarPedido, CABECALHOS_SEM_CACHE, erroDaLoja, lerConfiguracoes, sincronizarPagamento,
} from '../../lib/loja.js';
import {
  buscarPagamentosPorReferencia, cancelarPagamento, configuracaoCheckout, criarPagamento, METODOS_PAGAMENTO,
  montarPagamento, obterPagamento, resumoDoPagamento,
} from '../../lib/mercadopago.js';
import { servico } from '../../lib/supabase.js';
import { somenteDigitos, validarCpf, validarUuid } from '../../lib/validacao.js';
import { pagamentoEmAberto, tokenConfere } from './pedido.js';

const SELECT = '*,pedido_itens(produto_id,nome,imagem,quantidade,preco_unitario_centavos,total_centavos)';
const PAGOS = new Set(['pago', 'em_separacao', 'enviado', 'entregue']);
const APROVADOS = new Set(['approved', 'authorized']);
const EM_ANALISE = new Set(['in_process', 'in_mediation']);
// Meios que não são cartão: com metodo 'cartao' eles não passam.
const NAO_CARTAO = new Set(['pix', 'bolbradesco', 'pec', 'account_money', 'consumer_credits']);
const TIMEOUT_CONSULTA_MS = 8_000;
const TIMEOUT_CANCELAR_MS = 10_000;
const LIMITE_RECUSAS = 5;

const MSG_SEM_PAGAMENTO = 'O pagamento online ainda não está disponível. Tente novamente mais tarde ou fale com a AMA pelo WhatsApp.';
const MSG_TROCA = 'Não foi possível trocar a forma de pagamento agora. Tente de novo em instantes.';

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
  if (!/^[a-z0-9_]{2,40}$/.test(meio) || NAO_CARTAO.has(meio)) throw invalido('cartao', 'Confira o número do cartão.');
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

const pedidoPago = () => new ErroHttp(409, 'pedido_pago', 'Este pedido já foi pago.');
const emAnalise = () => new ErroHttp(409, 'pagamento_em_analise', 'O pagamento deste pedido está em análise. Aguarde o resultado.');

/** Pagamentos do pedido no Mercado Pago: a busca por external_reference + o que o banco aponta (a busca atrasa). */
async function pagamentosDoPedido(pedido) {
  const lista = await buscarPagamentosPorReferencia(pedido.id, { timeoutMs: TIMEOUT_CONSULTA_MS });
  const apontado = typeof pedido.mp_payment_id === 'string' ? pedido.mp_payment_id : '';
  if (/^\d{1,20}$/.test(apontado) && !lista.some((p) => String(p.id) === apontado)) {
    const atual = await obterPagamento(apontado, { timeoutMs: TIMEOUT_CONSULTA_MS });
    if (atual && String(atual.external_reference ?? '').toLowerCase() === pedido.id) lista.unshift(atual);
  }
  return lista;
}

/** Cancela um Pix/boleto em aberto. Sem conseguir (ou se ele já foi pago), não deixa cobrar de novo. */
async function cancelarEmAberto(pedido, pagamento, siteUrl) {
  let cancelado = null;
  try {
    cancelado = await cancelarPagamento(pagamento.id, { timeoutMs: TIMEOUT_CANCELAR_MS });
  } catch (erro) {
    console.error(`[pagamento] pedido #${pedido.numero}: não foi possível cancelar o pagamento ${pagamento.id}:`,
      erro && (erro.mensagem || erro.message));
  }
  if (cancelado && cancelado.status === 'cancelled') {
    await sincronizar(cancelado, siteUrl);
    return;
  }
  const agora = await obterPagamento(pagamento.id, { timeoutMs: TIMEOUT_CONSULTA_MS }).catch(() => null);
  if (agora && agora.status !== 'pending') await sincronizar(agora, siteUrl);
  if (agora && APROVADOS.has(agora.status)) throw pedidoPago();
  if (agora && EM_ANALISE.has(agora.status)) throw emAnalise();
  if (agora && (agora.status === 'cancelled' || agora.status === 'rejected')) return;
  throw new ErroHttp(502, 'falha_mercado_pago', MSG_TROCA);
}

/**
 * Confere no Mercado Pago antes de cobrar (ver o cabeçalho). Devolve o resumo do Pix/boleto em aberto do mesmo
 * método para reaproveitar, ou null para criar um pagamento novo. Lança 409 se já foi pago ou está em análise.
 */
async function conferirNoMercadoPago(pedido, metodo, siteUrl) {
  const pagamentos = await pagamentosDoPedido(pedido);
  const aprovado = pagamentos.find((p) => APROVADOS.has(p.status));
  if (aprovado) {
    await sincronizar(aprovado, siteUrl);
    throw pedidoPago();
  }
  const analise = pagamentos.find((p) => EM_ANALISE.has(p.status));
  if (analise) {
    await sincronizar(analise, siteUrl);
    throw emAnalise();
  }
  let reaproveitado = null;
  for (const pendente of pagamentos.filter((p) => p.status === 'pending')) {
    let resumo = resumoDoPagamento(pendente);
    if (!reaproveitado && metodo !== 'cartao' && resumo.metodo === metodo) {
      // A busca pode vir sem o QR/linha digitável: lê o pagamento completo.
      const completo = resumo.pix || resumo.boleto ? pendente : await obterPagamento(pendente.id, { timeoutMs: TIMEOUT_CONSULTA_MS });
      resumo = completo ? resumoDoPagamento(completo) : resumo;
      if (completo && completo.status === 'pending' && (resumo.pix || resumo.boleto)) {
        if (String(completo.id) !== pedido.mp_payment_id) await sincronizar(completo, siteUrl);
        reaproveitado = resumo;
        continue;
      }
    }
    await cancelarEmAberto(pedido, pendente, siteUrl);
  }
  return reaproveitado;
}

/** Recusas de cartão já registradas no pedido (eventos de pagamento do Mercado Pago). */
async function recusasDoPedido(pedidoId) {
  try {
    const linhas = await servico().select('pedido_eventos', {
      select: 'id', pedido_id: `eq.${pedidoId}`, tipo: 'eq.pagamento', autor: 'eq.mercadopago',
      'dados->>status': 'eq.rejected', limit: LIMITE_RECUSAS,
    });
    return Array.isArray(linhas) ? linhas.length : 0;
  } catch (erro) {
    throw erroDaLoja(erro);
  }
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
    if (cartao && await recusasDoPedido(pedido.id) >= LIMITE_RECUSAS) {
      throw new ErroHttp(429, 'tentativas_excedidas', 'Muitas tentativas recusadas com cartão neste pedido. Pague com Pix ou boleto.');
    }

    const siteUrl = urlBase(req);
    const reaproveitado = await conferirNoMercadoPago(pedido, metodo, siteUrl);
    if (reaproveitado) {
      responderJson(res, 200, { ok: true, pagamento: reaproveitado }, CABECALHOS_SEM_CACHE);
      return;
    }
    pedido = (await buscarPedido(id, SELECT)) || pedido;
    conferirSituacao(pedido);

    const pagamento = await criarPagamento(montarPagamento({ pedido, metodo, cartao, config, siteUrl }), {
      // 64 caracteres; a mesma chave do navegador (nova tentativa sem resposta) devolve o mesmo pagamento.
      chaveIdempotencia: createHash('sha256').update(`${pedido.id}:${chave}`).digest('hex'),
      sessaoDispositivo: texto(c.dispositivo),
    });
    if (String(pagamento.external_reference ?? '').toLowerCase() !== pedido.id) {
      console.error(`[pagamento] pedido #${pedido.numero}: o Mercado Pago devolveu o pagamento ${pagamento.id} de outra referência`);
      throw new ErroHttp(502, 'falha_mercado_pago', 'Não foi possível concluir o pagamento. Tente de novo.');
    }
    await sincronizar(pagamento, siteUrl);
    responderJson(res, 200, { ok: true, pagamento: resumoDoPagamento(pagamento) }, CABECALHOS_SEM_CACHE);
  } catch (erro) {
    tratarErro(res, erroDaLoja(erro));
  }
}
