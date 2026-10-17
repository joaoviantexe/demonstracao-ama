// Testes do Checkout Transparente (docs/ARQUITETURA.md §6.7): lib/mercadopago.js (montarPagamento,
// criarPagamento, cancelarPagamento, resumoDoPagamento), MP_PUBLIC_KEY em lib/ambiente.js e /api/config,
// lerCartao (api/loja/pagamento.js) e pedidoPublico/pagamentoEmAberto (api/loja/pedido.js).
// Sem rede externa: só o Mercado Pago falso em 127.0.0.1.
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cancelarPagamento, criarPagamento, mensagemDaRecusa, montarPagamento, resumoDoPagamento,
} from '../../lib/mercadopago.js';
import { obterAmbiente } from '../../lib/ambiente.js';
import config from '../../api/config.js';
import { lerCartao } from '../../api/loja/pagamento.js';
import { pagamentoEmAberto, pedidoPublico } from '../../api/loja/pedido.js';
import { AMBIENTE_VAZIO, aplicarAmbiente, chamarHandler } from '../apoio/servidor.js';
import { iniciar } from '../apoio/mercadopago-falso.js';

const PEDIDO_ID = '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';
const PUBLIC_KEY = 'APP_USR-1a2b3c4d-1111-4222-8333-123456789abc';
const ACCESS_TOKEN = 'APP_USR-1234567890123456-101710-0123456789abcdef0123456789abcdef-123456789';
const AGORA = new Date('2026-10-17T12:00:00.000Z');

function pedidoBase(extra = {}) {
  return {
    id: PEDIDO_ID,
    numero: 1001,
    status: 'aguardando_pagamento',
    subtotal_centavos: 9000,
    frete_centavos: 2350,
    total_centavos: 11350,
    cliente_nome: 'Maria da Silva Souza',
    cliente_email: 'maria@exemplo.com',
    cliente_telefone: '5591981056049',
    cliente_cpf: '52998224725',
    endereco: { cep: '66000000', logradouro: 'Rua das Flores', numero: '28', complemento: 'Casa 2', bairro: 'Icuí', cidade: 'Ananindeua', uf: 'pa' },
    entrega: { tipo: 'melhor_envio', nome: 'PAC', preco_centavos: 2350 },
    pedido_itens: [
      { produto_id: 'prod-raiz', nome: 'Body Splash Raiz', imagem: '/img/produtos/raiz.jpg', preco_unitario_centavos: 4500, quantidade: 2, total_centavos: 9000 },
    ],
    ...extra,
  };
}

const montar = (extra = {}) => montarPagamento({
  pedido: pedidoBase(), metodo: 'pix', config: { expiracao_horas: 72 }, siteUrl: 'https://oscama.com.br', agora: AGORA, ...extra,
});

let restaurarAmbiente;
beforeEach(() => { restaurarAmbiente = aplicarAmbiente(AMBIENTE_VAZIO); });
afterEach(() => { restaurarAmbiente(); });

// ---------------------------------------------------------------------------
describe('montarPagamento (POST /v1/payments)', () => {
  test('Pix: total do pedido, comprador, vencimento e dados para o antifraude', () => {
    const c = montar();
    assert.equal(c.transaction_amount, 113.5);
    assert.equal(c.payment_method_id, 'pix');
    assert.equal(c.external_reference, PEDIDO_ID);
    assert.equal(c.description, 'Pedido #1001 — AMA');
    assert.equal(c.statement_descriptor, 'AMA');
    assert.deepEqual(c.metadata, { pedido_id: PEDIDO_ID, pedido_numero: '1001' });
    assert.deepEqual(c.payer, {
      email: 'maria@exemplo.com', first_name: 'Maria', last_name: 'da Silva Souza',
      identification: { type: 'CPF', number: '52998224725' },
    });
    assert.equal(c.date_of_expiration, '2026-10-20T09:00:00.000-03:00', 'agora + 72 h, no fuso de Belém');
    assert.equal(c.notification_url, 'https://oscama.com.br/api/webhooks/mercadopago?source_news=webhooks');
    assert.deepEqual(c.additional_info.items, [
      { id: 'prod-raiz', title: 'Body Splash Raiz', quantity: 2, unit_price: 45, picture_url: 'https://oscama.com.br/img/produtos/raiz.jpg' },
      { id: 'frete', title: 'Frete — PAC', quantity: 1, unit_price: 23.5 },
    ]);
    assert.deepEqual(c.additional_info.payer.phone, { area_code: '91', number: '981056049' });
    assert.deepEqual(c.additional_info.shipments.receiver_address, {
      zip_code: '66000000', street_name: 'Rua das Flores', street_number: '28', city_name: 'Ananindeua', state_name: 'PA', apartment: 'Casa 2',
    });
    assert.equal(c.token, undefined);
  });

  test('boleto: endereço completo do comprador; sem número vira S/N', () => {
    const c = montar({ metodo: 'boleto' });
    assert.equal(c.payment_method_id, 'bolbradesco');
    assert.deepEqual(c.payer.address, {
      zip_code: '66000000', street_name: 'Rua das Flores', street_number: '28', neighborhood: 'Icuí', city: 'Ananindeua', federal_unit: 'PA',
    });
    const semNumero = montar({ metodo: 'boleto', pedido: pedidoBase({ endereco: { ...pedidoBase().endereco, numero: '' } }) });
    assert.equal(semNumero.payer.address.street_number, 'S/N');
  });

  test('cartão: token, parcelas, bandeira, emissor e documento do titular; sem vencimento', () => {
    const c = montar({
      metodo: 'cartao',
      cartao: { token: 'tok123', payment_method_id: 'visa', issuer_id: '25', parcelas: 3, tipo_documento: 'CPF', documento: '12345678909' },
    });
    assert.equal(c.token, 'tok123');
    assert.equal(c.installments, 3);
    assert.equal(c.payment_method_id, 'visa');
    assert.equal(c.issuer_id, 25);
    assert.deepEqual(c.payer, { email: 'maria@exemplo.com', identification: { type: 'CPF', number: '12345678909' } });
    assert.equal(c.date_of_expiration, undefined);
    assert.throws(() => montar({ metodo: 'cartao', cartao: {} }), /token do cartão/);
  });

  test('prazo do painel (72–720 h); desenvolvimento sem notification_url; itens que não fecham viram um só', () => {
    assert.equal(montar({ config: { expiracao_horas: 24 } }).date_of_expiration, '2026-10-20T09:00:00.000-03:00', 'mínimo de 72 h');
    assert.equal(montar({ config: { checkout: { expiracao_horas: 168 } } }).date_of_expiration, '2026-10-24T09:00:00.000-03:00');
    assert.equal(montar({ siteUrl: 'http://localhost:3000' }).notification_url, undefined);
    const estranho = montar({ pedido: pedidoBase({ pedido_itens: [{ nome: 'X', quantidade: 1, preco_unitario_centavos: 100 }] }) });
    assert.deepEqual(estranho.additional_info.items[0], { id: 'pedido-1001', title: 'Pedido #1001 — AMA', quantity: 1, unit_price: 90, description: '1× X' });
  });

  test('entradas inválidas lançam TypeError', () => {
    assert.throws(() => montar({ metodo: 'dinheiro' }), TypeError);
    assert.throws(() => montar({ pedido: pedidoBase({ total_centavos: 0 }) }), TypeError);
    assert.throws(() => montar({ pedido: pedidoBase({ frete_centavos: 99999 }) }), TypeError);
    assert.throws(() => montar({ pedido: null }), TypeError);
  });
});

// ---------------------------------------------------------------------------
describe('resumoDoPagamento e mensagemDaRecusa', () => {
  test('Pix: QR e copia e cola; imagem que não é base64 fica de fora', () => {
    const r = resumoDoPagamento({
      id: 123, status: 'pending', status_detail: 'pending_waiting_transfer', payment_type_id: 'bank_transfer', payment_method_id: 'pix',
      date_of_expiration: '2026-10-20T09:00:00.000-03:00',
      point_of_interaction: { transaction_data: { qr_code: '000201abc', qr_code_base64: 'iVBORw0KGgo=', ticket_url: 'https://x' } },
      payer: { email: 'segredo@x.com' },
    });
    assert.deepEqual(r, {
      id: '123', status: 'pending', status_detail: 'pending_waiting_transfer', metodo: 'pix', expira_em: '2026-10-20T09:00:00.000-03:00',
      pix: { qr_code: '000201abc', qr_code_base64: 'iVBORw0KGgo=' },
    });
    const ruim = resumoDoPagamento({ id: 1, status: 'pending', payment_method_id: 'pix', point_of_interaction: { transaction_data: { qr_code: 'abc', qr_code_base64: '"><script>' } } });
    assert.deepEqual(ruim.pix, { qr_code: 'abc', qr_code_base64: null });
  });

  test('boleto: link https (ou do falso local) e linha digitável', () => {
    const r = resumoDoPagamento({
      id: 9, status: 'pending', payment_type_id: 'ticket', payment_method_id: 'bolbradesco',
      transaction_details: { external_resource_url: 'https://www.mercadopago.com.br/boleto/9', digitable_line: '23790.00009 1' },
      barcode: { content: '2379000' },
    });
    assert.deepEqual(r.boleto, { url: 'https://www.mercadopago.com.br/boleto/9', linha_digitavel: '23790.00009 1' });
    const soBarras = resumoDoPagamento({ id: 9, status: 'pending', payment_type_id: 'ticket', transaction_details: { external_resource_url: 'javascript:alert(1)' }, barcode: { content: '2379000' } });
    assert.deepEqual(soBarras.boleto, { url: null, linha_digitavel: '2379000' });
    assert.equal(resumoDoPagamento({ id: 9, status: 'pending', payment_type_id: 'ticket', transaction_details: { external_resource_url: 'http://127.0.0.1:9/boleto/9' } }).boleto.url,
      'http://127.0.0.1:9/boleto/9');
  });

  test('cartão recusado leva o motivo em português', () => {
    const r = resumoDoPagamento({ id: 5, status: 'rejected', status_detail: 'cc_rejected_bad_filled_security_code', payment_type_id: 'credit_card' });
    assert.equal(r.metodo, 'cartao');
    assert.equal(r.mensagem, 'Confira o código de segurança do cartão.');
    assert.match(mensagemDaRecusa('cc_rejected_algo_novo'), /recusado/);
    assert.equal(resumoDoPagamento(null), null);
  });
});

// ---------------------------------------------------------------------------
describe('MP_PUBLIC_KEY e /api/config', () => {
  test('só uma Public Key válida liga o Checkout Transparente (o Access Token nunca vai ao navegador)', (t) => {
    const log = t.mock.method(console, 'error', () => {});
    aplicarAmbiente({ MP_ACCESS_TOKEN: ACCESS_TOKEN, MP_PUBLIC_KEY: PUBLIC_KEY });
    assert.equal(obterAmbiente().mpPublicKey, PUBLIC_KEY);
    assert.equal(obterAmbiente().checkoutTransparente, true);
    aplicarAmbiente({ MP_PUBLIC_KEY: 'TEST-1a2b3c4d-1111-4222-8333-123456789abc' });
    assert.equal(obterAmbiente().checkoutTransparente, true);

    for (const errada of [ACCESS_TOKEN, 'TEST-1234-abc', 'chave qualquer']) {
      aplicarAmbiente({ MP_PUBLIC_KEY: errada });
      assert.equal(obterAmbiente().mpPublicKey, '', errada);
      assert.equal(obterAmbiente().checkoutTransparente, false);
    }
    assert.ok(log.mock.callCount() >= 1);
    aplicarAmbiente({ MP_ACCESS_TOKEN: undefined, MP_PUBLIC_KEY: PUBLIC_KEY });
    assert.equal(obterAmbiente().checkoutTransparente, false, 'sem Access Token não há pagamento');
  });

  test('/api/config manda mpPublicKey só com a loja configurada e o Checkout Transparente ligado', async () => {
    aplicarAmbiente({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_x', MP_ACCESS_TOKEN: ACCESS_TOKEN });
    let res = await chamarHandler(config, { url: '/api/config' });
    assert.doesNotMatch(res.corpo, /mpPublicKey/);
    aplicarAmbiente({ MP_PUBLIC_KEY: PUBLIC_KEY });
    res = await chamarHandler(config, { url: '/api/config' });
    assert.match(res.corpo, new RegExp(`"configurado":true,"mpPublicKey":"${PUBLIC_KEY}"`));
    assert.doesNotMatch(res.corpo, new RegExp(ACCESS_TOKEN));
  });
});

// ---------------------------------------------------------------------------
describe('lerCartao e pedidoPublico', () => {
  const cartao = (extra = {}) => ({ token: 'a1b2c3d4e5f6', payment_method_id: 'Master', issuer_id: '24', parcelas: 2, tipo_documento: 'cpf', documento: '123.456.789-09', ...extra });

  test('lerCartao normaliza e confere parcelas e documento', () => {
    assert.deepEqual(lerCartao(cartao(), 6), {
      token: 'a1b2c3d4e5f6', payment_method_id: 'master', issuer_id: '24', parcelas: 2, tipo_documento: 'CPF', documento: '12345678909',
    });
    assert.equal(lerCartao(cartao({ tipo_documento: 'CNPJ', documento: '11.222.333/0001-81' }), 6).documento, '11222333000181');
    const erroDe = (fn) => { try { fn(); } catch (e) { return [e.status, e.extra.campo]; } return null; };
    assert.deepEqual(erroDe(() => lerCartao(cartao({ parcelas: 7 }), 6)), [400, 'cartao.parcelas']);
    assert.deepEqual(erroDe(() => lerCartao(cartao({ parcelas: '1.5' }), 6)), [400, 'cartao.parcelas']);
    assert.deepEqual(erroDe(() => lerCartao(cartao({ documento: '11111111111' }), 6)), [400, 'cartao.documento']);
    assert.deepEqual(erroDe(() => lerCartao(cartao({ token: 'x y' }), 6)), [400, 'cartao']);
    assert.deepEqual(erroDe(() => lerCartao(cartao({ issuer_id: 'abc' }), 6)), [400, 'cartao']);
    assert.deepEqual(erroDe(() => lerCartao(null, 6)), [400, 'cartao']);
    assert.deepEqual(erroDe(() => lerCartao(cartao({ payment_method_id: 'bolbradesco' }), 6)), [400, 'cartao']);
  });

  test('pagamentoEmAberto: só Pix/boleto pendente de pedido não pago', () => {
    const base = { status: 'pagamento_em_analise', status_pagamento: 'pending', metodo_pagamento: 'bank_transfer', mp_payment_id: '123' };
    assert.deepEqual(pagamentoEmAberto(base), { id: '123', metodo: 'pix' });
    assert.deepEqual(pagamentoEmAberto({ ...base, metodo_pagamento: 'ticket' }), { id: '123', metodo: 'boleto' });
    assert.equal(pagamentoEmAberto({ ...base, metodo_pagamento: 'credit_card' }), null);
    assert.equal(pagamentoEmAberto({ ...base, status_pagamento: 'approved' }), null);
    assert.equal(pagamentoEmAberto({ ...base, status: 'pago' }), null);
    assert.equal(pagamentoEmAberto({ ...base, mp_payment_id: 'x' }), null);
  });

  test('pedidoPublico no Checkout Transparente: métodos, parcelas e Pix em aberto', () => {
    const linha = { ...pedidoBase(), pedido_itens: [], mp_init_point: 'https://mp/pagar' };
    const p = pedidoPublico(linha, { transparente: true, checkout: { parcelas_max: 3, aceitar_boleto: false } });
    assert.equal(p.pode_pagar, true);
    assert.equal(p.link_pagamento, null);
    assert.deepEqual(p.pagamento, { metodos: ['pix', 'cartao'], parcelas_max: 3, pendente: null });

    const pendente = { id: '1', status: 'pending', metodo: 'pix', pix: { qr_code: 'abc', qr_code_base64: null } };
    const emAnalise = pedidoPublico({ ...linha, status: 'pagamento_em_analise' }, { transparente: true, pendente });
    assert.equal(emAnalise.pode_pagar, true);
    assert.deepEqual(emAnalise.pagamento.pendente, pendente);
    assert.deepEqual(emAnalise.pagamento.metodos, ['pix', 'cartao', 'boleto']);
    const semLer = pedidoPublico({ ...linha, status: 'pagamento_em_analise' },
      { transparente: true, pendente: { id: '1', metodo: 'pix', status: 'pending', indisponivel: true } });
    assert.equal(semLer.pode_pagar, true, 'consulta que falhou não tira o Pix da página');
    const cartaoEmAnalise = pedidoPublico({ ...linha, status: 'pagamento_em_analise' }, { transparente: true });
    assert.equal(cartaoEmAnalise.pode_pagar, false);
    assert.equal(cartaoEmAnalise.pagamento, null);
    assert.equal(pedidoPublico({ ...linha, status: 'pago' }, { transparente: true }).pagamento, null);
    assert.equal(pedidoPublico(linha).pagamento, null, 'Checkout Pro');
  });
});

// ---------------------------------------------------------------------------
describe('criarPagamento e cancelarPagamento contra o Mercado Pago falso', () => {
  let mp;
  before(async () => { mp = await iniciar(); });
  after(async () => { await mp.fechar(); });
  beforeEach(() => {
    mp.estado.limpar();
    aplicarAmbiente({ MP_API_BASE: mp.url, MP_ACCESS_TOKEN: 'TEST-token-123' });
  });

  test('idempotência, device id e Pix pendente', async () => {
    const corpo = montar({ siteUrl: 'http://localhost:3000' });
    await assert.rejects(criarPagamento(corpo, {}), /chaveIdempotencia/);
    const pix = await criarPagamento(corpo, { chaveIdempotencia: 'k-1', sessaoDispositivo: 'armor.abc123def456' });
    assert.equal(pix.status, 'pending');
    const recebidos = (id) => mp.estado.pagamentos.get(String(id)).cabecalhos;
    assert.equal(recebidos(pix.id)['x-idempotency-key'], 'k-1');
    assert.equal(recebidos(pix.id)['x-meli-session-id'], 'armor.abc123def456');
    assert.equal(recebidos(pix.id).authorization, 'Bearer TEST-token-123');
    const repetido = await criarPagamento(corpo, { chaveIdempotencia: 'k-1', sessaoDispositivo: 'valor inválido com espaço' });
    assert.equal(repetido.id, pix.id);
    assert.equal(mp.estado.pagamentos.size, 1);
    const outro = await criarPagamento(corpo, { chaveIdempotencia: 'k-2', sessaoDispositivo: 'x y' });
    assert.equal(recebidos(outro.id)['x-meli-session-id'], undefined, 'device id fora do formato não vai');

    const cancelado = await cancelarPagamento(pix.id);
    assert.equal(cancelado.status, 'cancelled');
    await assert.rejects(cancelarPagamento('abc'), TypeError);
  });

  test('cartão recusado volta normalmente; dados recusados → 400; falha → 502 sem o token no log', async (t) => {
    const log = t.mock.method(console, 'error', () => {});
    const aviso = t.mock.method(console, 'warn', () => {});
    const corpo = montar({ metodo: 'cartao', siteUrl: 'http://localhost:3000', cartao: { token: 'ccfalso_OTHE_1', payment_method_id: 'master', parcelas: 1 } });
    const recusado = await criarPagamento(corpo, { chaveIdempotencia: 'c-1' });
    assert.equal(recusado.status, 'rejected');

    mp.estado.falhas.criarPagamento = 400;
    await assert.rejects(criarPagamento(corpo, { chaveIdempotencia: 'c-2' }), (e) => e.status === 400 && e.erro === 'pagamento_nao_processado');
    assert.equal(aviso.mock.callCount(), 1);
    mp.estado.falhas.criarPagamento = 500;
    await assert.rejects(criarPagamento(corpo, { chaveIdempotencia: 'c-3' }), (e) => e.status === 502 && e.erro === 'falha_mercado_pago');
    assert.ok(log.mock.calls.every((c) => !String(c.arguments.join(' ')).includes('TEST-token-123')));
    mp.estado.falhas.criarPagamento = null;

    const aprovado = await criarPagamento(montar({ metodo: 'cartao', siteUrl: 'http://localhost:3000', cartao: { token: 'ccfalso_APRO_2', payment_method_id: 'master', parcelas: 1 } }), { chaveIdempotencia: 'c-4' });
    await assert.rejects(cancelarPagamento(aprovado.id), (e) => e.status === 502);
  });

  test('sem Access Token → 503 antes de chamar o Mercado Pago', async () => {
    aplicarAmbiente({ MP_ACCESS_TOKEN: undefined });
    await assert.rejects(criarPagamento(montar(), { chaveIdempotencia: 'k' }), (e) => e.status === 503);
    assert.equal(mp.estado.requisicoes.length, 0);
  });
});
