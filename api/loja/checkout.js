// POST /api/loja/checkout — cria o pedido e a preferência do Mercado Pago (docs/ARQUITETURA.md §6.3).
//
// Ordem: método → corpo → Mercado Pago configurado (senão 503, antes de criar qualquer pedido) →
// validação → recotação no servidor (itens e frete) → criar_pedido → preferência → grava
// mp_preference_id/mp_init_point → { ok, pedido: { id, numero, token }, redirecionar }.
//
// Falha ao criar a preferência: o pedido é CANCELADO automaticamente (evento de status com a nota e um
// alerta com o motivo) e a resposta é 502. Escolha: sem link de pagamento o cliente não consegue pagar
// aquele pedido e, ao tentar de novo, cria outro; deixá-lo "aguardando pagamento" só poluiria o painel.
// Mesmo cancelado, um pagamento aprovado que chegue depois (preferência criada, resposta perdida) ainda
// é aceito por confirmar_pagamento, que move cancelado → pago.

import { obterAmbiente } from '../../lib/ambiente.js';
import { ErroHttp, exigirMetodo, lerCorpo, responderJson, tratarErro, urlBase } from '../../lib/http.js';
import {
  atualizarPedido, CABECALHOS_SEM_CACHE, cotar, erroDaLoja, lerConfiguracoes, MSG_ITEM_INDISPONIVEL, registrarEvento,
} from '../../lib/loja.js';
import { criarPreferencia } from '../../lib/mercadopago.js';
import { ErroSupabase, servico } from '../../lib/supabase.js';
import { validarDadosCheckout } from '../../lib/validacao.js';

const MSG_SEM_PAGAMENTO = 'O pagamento online ainda não está disponível. Tente novamente mais tarde ou fale com a AMA pelo WhatsApp.';
const MSG_FRETE_INDISPONIVEL = 'A opção de entrega escolhida não está mais disponível. Escolha outra forma de entrega.';
const MSG_FALHA_PREFERENCIA = 'Não foi possível iniciar o pagamento agora. Nenhuma cobrança foi feita: tente novamente em instantes.';

function entregaDaOpcao(opcao) {
  return {
    tipo: opcao.tipo,
    id: opcao.id,
    nome: opcao.nome,
    empresa: opcao.empresa ?? null,
    prazo_dias: opcao.prazo_dias ?? null,
    preco_centavos: opcao.preco_centavos,
    servico_id: opcao.servico_id ?? null,
  };
}

// Cancela o pedido cuja preferência não pôde ser criada. Nunca lança.
async function cancelarPorFalha(pedido, erro) {
  const detalhes = erro && erro.detalhes ? erro.detalhes : {};
  const motivo = erro && (erro.mensagem || erro.message) ? String(erro.mensagem || erro.message).slice(0, 300) : 'erro desconhecido';
  console.error(`[checkout] falha ao criar a preferência do pedido #${pedido.numero}: ${motivo}`);
  try {
    await servico().rpc('alterar_status_pedido', {
      p_pedido_id: pedido.id,
      p_status: 'cancelado',
      p_autor: 'sistema',
      p_nota: 'Cancelado automaticamente: o Mercado Pago não criou o link de pagamento',
      p_repor_estoque: false,
      p_rastreio: null,
    });
  } catch (falha) {
    console.error(`[checkout] não foi possível cancelar o pedido #${pedido.numero}:`, falha && (falha.codigo || falha.message));
  }
  await registrarEvento(pedido.id, 'alerta', 'Falha ao criar a preferência de pagamento no Mercado Pago', {
    motivo,
    status_mercado_pago: detalhes.status_mercado_pago ?? null,
  });
}

export default async function handler(req, res) {
  if (!exigirMetodo(req, res, ['POST'])) return;
  try {
    const corpo = await lerCorpo(req);
    if (!obterAmbiente().mercadoPagoConfigurado) {
      throw new ErroHttp(503, 'pagamento_indisponivel', MSG_SEM_PAGAMENTO);
    }

    const { ok, erros, dados } = validarDadosCheckout(corpo);
    if (!ok) {
      const [campo, mensagem] = Object.entries(erros)[0];
      throw new ErroHttp(400, 'dados_invalidos', mensagem, { campo, erros });
    }

    // Recota tudo no servidor: o navegador nunca define o valor cobrado.
    const config = await lerConfiguracoes();
    const entradaCotacao = { itens: dados.itens, cep: dados.endereco.cep };
    const cotacao = await cotar(entradaCotacao, { config, comFrete: true });
    if (cotacao.itens.some((item) => item.disponivel !== true)) {
      throw new ErroHttp(409, 'item_indisponivel', MSG_ITEM_INDISPONIVEL, { itens: cotacao.itens });
    }
    const opcao = cotacao.frete.opcoes.find((o) => o.id === dados.frete_id);
    if (!opcao) throw new ErroHttp(409, 'frete_indisponivel', MSG_FRETE_INDISPONIVEL, { frete: cotacao.frete });
    const entrega = entregaDaOpcao(opcao);

    let pedido;
    try {
      pedido = await servico().rpc('criar_pedido', {
        p: {
          itens: dados.itens,
          cliente: dados.cliente,
          endereco: dados.endereco,
          entrega,
        },
      });
    } catch (erro) {
      // Corrida com outra compra (estoque acabou entre a cotação e o pedido): devolve o carrinho atualizado.
      if (erro instanceof ErroSupabase && erro.codigo === 'item_indisponivel') {
        const nova = await cotar(entradaCotacao, { config }).catch(() => null);
        throw erroDaLoja(erro, { itens: nova ? nova.itens : undefined });
      }
      throw erro;
    }

    let preferencia;
    try {
      preferencia = await criarPreferencia({
        pedido: { ...pedido, endereco: dados.endereco, entrega },
        itens: pedido.itens,
        cliente: dados.cliente,
        entrega,
        config,
        siteUrl: urlBase(req),
      });
    } catch (erro) {
      await cancelarPorFalha(pedido, erro);
      throw new ErroHttp(502, 'falha_mercado_pago', MSG_FALHA_PREFERENCIA);
    }

    try {
      await atualizarPedido(pedido.id, { mp_preference_id: preferencia.id, mp_init_point: preferencia.init_point });
    } catch (erro) {
      // O link já existe e o webhook acha o pedido pelo external_reference: segue para o pagamento.
      console.error(`[checkout] pedido #${pedido.numero}: não foi possível gravar a preferência ${preferencia.id}:`,
        erro && (erro.mensagem || erro.message));
      await registrarEvento(pedido.id, 'alerta', 'Não foi possível gravar o link de pagamento no pedido',
        { mp_preference_id: preferencia.id });
    }

    responderJson(res, 200, {
      ok: true,
      pedido: { id: pedido.id, numero: pedido.numero, token: pedido.token_acesso },
      redirecionar: preferencia.init_point,
    }, CABECALHOS_SEM_CACHE);
  } catch (erro) {
    tratarErro(res, erroDaLoja(erro));
  }
}
