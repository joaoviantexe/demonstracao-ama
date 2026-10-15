// Testes de lib/mercadopago.js e do Mercado Pago falso (tests/apoio/mercadopago-falso.js).
// docs/ARQUITETURA.md §6.0, §6.3 e §6.5. Sem rede externa: só servidores em 127.0.0.1.
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import {
  buscarPagamentosPorReferencia, criarPreferencia, ehUrlPublicaHttps, montarManifesto, montarPreferencia,
  obterPagamento, validarAssinatura,
} from '../../lib/mercadopago.js';
import { ErroHttp } from '../../lib/http.js';
import { AMBIENTE_VAZIO, aplicarAmbiente, esperarAbort, respostaJson, simularFetch } from '../apoio/servidor.js';
import { assinarNotificacao, iniciar } from '../apoio/mercadopago-falso.js';

const PEDIDO_ID = '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';
const TOKEN = '0123456789abcdef'.repeat(4);
const SITE = 'https://ama.org.br';
const AGORA = new Date('2026-10-14T15:00:00.000Z');
const CLIENTE = Object.freeze({ nome: 'Maria da Silva Souza', email: 'maria@exemplo.com', telefone: '91981056049', cpf: '52998224725' });
const ENTREGA = Object.freeze({ tipo: 'melhor_envio', id: 'me-1', nome: 'PAC', empresa: 'Correios', prazo_dias: 7, preco_centavos: 2350, servico_id: 1 });
const CONFIG = Object.freeze({ parcelas_max: 6, aceitar_boleto: true, expiracao_horas: 72 });

function pedidoBase(extra = {}) {
  return {
    id: PEDIDO_ID,
    numero: 1001,
    token_acesso: TOKEN,
    subtotal_centavos: 9000,
    frete_centavos: 2350,
    total_centavos: 11350,
    endereco: { cep: '66000000', logradouro: 'Rua das Flores', numero: '28', complemento: '', bairro: 'Icuí', cidade: 'Ananindeua', uf: 'PA' },
    itens: [
      { produto_id: 'prod-raiz', nome: 'Body Splash Raiz', imagem: '/img/produtos/raiz.jpg', preco_unitario_centavos: 4500, quantidade: 2, total_centavos: 9000 },
    ],
    ...extra,
  };
}

function montar(extra = {}) {
  return montarPreferencia({
    pedido: pedidoBase(), cliente: CLIENTE, entrega: ENTREGA, config: CONFIG, siteUrl: SITE, agora: AGORA, ...extra,
  });
}

// Soma dos itens em centavos, como o Mercado Pago cobra (quantity × unit_price).
const somaCentavos = (itens) => itens.reduce((soma, item) => soma + Math.round(item.unit_price * 100) * item.quantity, 0);

function conferirDuasCasas(itens) {
  for (const item of itens) {
    assert.equal(typeof item.unit_price, 'number');
    assert.ok(item.unit_price > 0, `unit_price positivo: ${item.unit_price}`);
    assert.match(String(item.unit_price), /^\d+(\.\d{1,2})?$/, `no máximo 2 casas: ${item.unit_price}`);
    assert.ok(Number.isSafeInteger(item.quantity) && item.quantity >= 1);
    assert.equal(item.currency_id, 'BRL');
  }
}

const hmac = (manifesto, segredo = 'segredo-teste') => createHmac('sha256', segredo).update(manifesto).digest('hex');

let restaurarAmbiente;
beforeEach(() => { restaurarAmbiente = aplicarAmbiente(AMBIENTE_VAZIO); });
afterEach(() => { restaurarAmbiente(); });

// ---------------------------------------------------------------------------
describe('montarPreferencia', () => {
  test('pedido sem desconto: itens em reais, frete como item e soma igual ao total', () => {
    const pref = montar();
    assert.deepEqual(pref.items, [
      {
        id: 'prod-raiz', title: 'Body Splash Raiz', quantity: 2, currency_id: 'BRL', unit_price: 45,
        picture_url: 'https://ama.org.br/img/produtos/raiz.jpg',
      },
      { id: 'frete', title: 'Frete — PAC', quantity: 1, currency_id: 'BRL', unit_price: 23.5 },
    ]);
    assert.equal(somaCentavos(pref.items), 11350);
    assert.equal(pref.external_reference, PEDIDO_ID);
    assert.equal(pref.statement_descriptor, 'AMA');
    assert.ok(pref.statement_descriptor.length <= 13);
    assert.deepEqual(pref.metadata, { pedido_id: PEDIDO_ID, pedido_numero: '1001' });
    assert.equal('sandbox_init_point' in pref, false);
  });

  test('back_urls, notification_url e auto_return com site https público', () => {
    const pref = montar();
    const retorno = `https://ama.org.br/loja/pedido?id=${PEDIDO_ID}&token=${TOKEN}`;
    assert.deepEqual(pref.back_urls, { success: retorno, pending: retorno, failure: retorno });
    assert.equal(pref.notification_url, 'https://ama.org.br/api/webhooks/mercadopago?source_news=webhooks');
    assert.equal(pref.auto_return, 'approved');
  });

  test('barra final na siteUrl não duplica a barra', () => {
    const pref = montar({ siteUrl: 'https://ama.org.br/' });
    assert.equal(pref.back_urls.success, `https://ama.org.br/loja/pedido?id=${PEDIDO_ID}&token=${TOKEN}`);
    assert.equal(pref.notification_url, 'https://ama.org.br/api/webhooks/mercadopago?source_news=webhooks');
  });

  for (const site of ['http://127.0.0.1:3000', 'http://ama.org.br', 'https://localhost:3000', 'https://127.0.0.1', 'https://loja.localhost', 'https://[::1]:8443', 'https://192.168.0.10']) {
    test(`site ${site}: sem notification_url nem auto_return, back_urls mantidas`, () => {
      const pref = montar({ siteUrl: site });
      assert.equal('notification_url' in pref, false);
      assert.equal('auto_return' in pref, false);
      const base = new URL(site).origin;
      const retorno = `${base}/loja/pedido?id=${PEDIDO_ID}&token=${TOKEN}`;
      assert.deepEqual(pref.back_urls, { success: retorno, pending: retorno, failure: retorno });
      assert.equal('picture_url' in pref.items[0], false, 'imagem só com URL pública https');
    });
  }

  test('id e token vão codificados nas back_urls', () => {
    const pref = montar({ pedido: pedidoBase({ token_acesso: undefined, token: 'a&b=c d' }) });
    assert.equal(pref.back_urls.success, `https://ama.org.br/loja/pedido?id=${PEDIDO_ID}&token=a%26b%3Dc%20d`);
  });

  test('valores que geram dízimas: centavos → reais sem erro de ponto flutuante e soma exata', () => {
    const itens = [
      { produto_id: 'a', nome: 'Creme Cupuaçu', preco_unitario_centavos: 1999, quantidade: 3, total_centavos: 5997 },
      { produto_id: 'b', nome: 'Sabonete', preco_unitario_centavos: 3333, quantidade: 1, total_centavos: 3333 },
      { produto_id: 'c', nome: 'Amostra', preco_unitario_centavos: 10, quantidade: 7, total_centavos: 70 },
      { produto_id: 'd', nome: 'Brinde', preco_unitario_centavos: 1, quantidade: 99, total_centavos: 99 },
      { produto_id: 'e', nome: 'Biojoia', preco_unitario_centavos: 33, quantidade: 3, total_centavos: 99 },
      { produto_id: 'f', nome: 'Kit', preco_unitario_centavos: 123456789, quantidade: 1, total_centavos: 123456789 },
    ];
    const subtotal = itens.reduce((s, i) => s + i.total_centavos, 0);
    const pedido = pedidoBase({ itens, subtotal_centavos: subtotal, frete_centavos: 1777, total_centavos: subtotal + 1777 });
    const pref = montar({ pedido, entrega: { ...ENTREGA, preco_centavos: 1777 } });
    conferirDuasCasas(pref.items);
    assert.deepEqual(pref.items.map((i) => i.unit_price), [19.99, 33.33, 0.1, 0.01, 0.33, 1234567.89, 17.77]);
    assert.equal(somaCentavos(pref.items), pedido.total_centavos);
  });

  test('itens que não fecham com o total viram um item único com o valor certo', () => {
    const pedido = pedidoBase({ total_centavos: 12000 });
    const pref = montar({ pedido });
    assert.equal(pref.items.length, 2);
    assert.equal(pref.items[0].title, 'Pedido #1001 — AMA');
    assert.equal(pref.items[0].unit_price, 96.5);
    assert.match(pref.items[0].description, /2× Body Splash Raiz/);
    assert.equal(somaCentavos(pref.items), 12000);
  });

  test('itens vêm de pedido.itens quando o parâmetro itens não é passado; o parâmetro tem prioridade', () => {
    const pref = montar();
    assert.equal(pref.items[0].title, 'Body Splash Raiz');
    const outro = montar({
      itens: [{ produto_id: 'z', nome: 'Creme Ameixa Negra', preco_unitario_centavos: 3000, quantidade: 3, total_centavos: 9000 }],
    });
    assert.equal(outro.items[0].title, 'Creme Ameixa Negra');
    assert.equal(outro.items[0].unit_price, 30);
  });

  test('frete vem de entrega.preco_centavos quando o pedido não tem frete_centavos', () => {
    const pedido = pedidoBase({ frete_centavos: undefined });
    const pref = montar({ pedido });
    assert.equal(pref.items.at(-1).unit_price, 23.5);
    assert.equal(somaCentavos(pref.items), 11350);
  });

  test('payer: nome e sobrenome, e-mail, telefone com DDD, CPF e endereço', () => {
    const pref = montar();
    assert.deepEqual(pref.payer, {
      name: 'Maria',
      surname: 'da Silva Souza',
      email: 'maria@exemplo.com',
      phone: { area_code: '91', number: '981056049' },
      identification: { type: 'CPF', number: '52998224725' },
      address: { zip_code: '66000000', street_name: 'Rua das Flores', street_number: 28 },
    });
  });

  test('payer: telefone fixo, com +55 e máscara; nome único; número "s/n" fica de fora', () => {
    const fixo = montar({ cliente: { ...CLIENTE, telefone: '(91) 3255-1234' } });
    assert.deepEqual(fixo.payer.phone, { area_code: '91', number: '32551234' });
    const ddi = montar({ cliente: { ...CLIENTE, telefone: '+55 (91) 98105-6049', cpf: '529.982.247-25' } });
    assert.deepEqual(ddi.payer.phone, { area_code: '91', number: '981056049' });
    assert.deepEqual(ddi.payer.identification, { type: 'CPF', number: '52998224725' });
    const unico = montar({ cliente: { ...CLIENTE, nome: 'Maria' } });
    assert.equal(unico.payer.name, 'Maria');
    assert.equal('surname' in unico.payer, false);
    const sn = montar({ pedido: pedidoBase({ endereco: { ...pedidoBase().endereco, numero: 's/n' } }) });
    assert.deepEqual(sn.payer.address, { zip_code: '66000000', street_name: 'Rua das Flores' });
  });

  test('cliente cai para os campos cliente_* do pedido', () => {
    const pedido = pedidoBase({
      cliente_nome: 'Ana Paula Lima', cliente_email: 'ana@exemplo.com', cliente_telefone: '91988887777', cliente_cpf: '52998224725',
    });
    const pref = montarPreferencia({ pedido, entrega: ENTREGA, config: CONFIG, siteUrl: SITE, agora: AGORA });
    assert.equal(pref.payer.name, 'Ana');
    assert.equal(pref.payer.surname, 'Paula Lima');
    assert.equal(pref.payer.email, 'ana@exemplo.com');
  });

  test('installments = min(parcelas_max, 12), com padrão 6', () => {
    const casos = [[6, 6], [1, 1], [12, 12], [24, 12], [3.7, 3], [0, 6], ['abc', 6], [undefined, 6], ['10', 10]];
    for (const [parcelas, esperado] of casos) {
      const pref = montar({ config: { ...CONFIG, parcelas_max: parcelas } });
      assert.equal(pref.payment_methods.installments, esperado, `parcelas_max ${parcelas}`);
    }
  });

  test('aceitar_boleto false exclui ticket; true ou ausente não exclui nada', () => {
    assert.deepEqual(montar({ config: { ...CONFIG, aceitar_boleto: false } }).payment_methods.excluded_payment_types, [{ id: 'ticket' }]);
    assert.deepEqual(montar({ config: { ...CONFIG, aceitar_boleto: true } }).payment_methods.excluded_payment_types, []);
    assert.deepEqual(montar({ config: {} }).payment_methods.excluded_payment_types, []);
    assert.deepEqual(montar().payment_methods.excluded_payment_methods, []);
  });

  test('aceita o objeto inteiro de configurações (usa config.checkout)', () => {
    const pref = montar({ config: { loja: {}, checkout: { parcelas_max: 3, aceitar_boleto: false, expiracao_horas: 96 } } });
    assert.equal(pref.payment_methods.installments, 3);
    assert.deepEqual(pref.payment_methods.excluded_payment_types, [{ id: 'ticket' }]);
    assert.equal(Date.parse(pref.expiration_date_to) - AGORA.getTime(), 96 * 3_600_000);
  });

  test('expiração: expires true, ISO com fuso -03:00 e no mínimo 72 h', () => {
    const pref = montar();
    assert.equal(pref.expires, true);
    assert.equal(pref.expiration_date_from, '2026-10-14T12:00:00.000-03:00');
    assert.equal(pref.expiration_date_to, '2026-10-17T12:00:00.000-03:00');
    const formato = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}-03:00$/;
    const horas = (config) => (Date.parse(montar({ config }).expiration_date_to) - AGORA.getTime()) / 3_600_000;
    assert.equal(horas({ expiracao_horas: 24 }), 72);
    assert.equal(horas({ expiracao_horas: 100 }), 100);
    assert.equal(horas({ expiracao_horas: 100000 }), 720);
    assert.equal(horas({}), 72);
    assert.equal(horas(undefined), 72);
    assert.match(montar({ config: { expiracao_horas: 100 } }).expiration_date_to, formato);
    assert.equal(Date.parse(pref.expiration_date_from), AGORA.getTime());
  });

  test('sem "agora" usa o relógio atual', () => {
    const antes = Date.now();
    const pref = montarPreferencia({ pedido: pedidoBase(), cliente: CLIENTE, entrega: ENTREGA, config: CONFIG, siteUrl: SITE });
    const depois = Date.now();
    const inicio = Date.parse(pref.expiration_date_from);
    assert.ok(inicio >= antes - 1 && inicio <= depois + 1);
  });

  test('entrada inválida lança TypeError', () => {
    assert.throws(() => montarPreferencia(), TypeError);
    assert.throws(() => montarPreferencia({ pedido: null, siteUrl: SITE }), TypeError);
    assert.throws(() => montar({ pedido: pedidoBase({ id: '' }) }), TypeError);
    assert.throws(() => montar({ pedido: pedidoBase({ token_acesso: '' }) }), TypeError);
    assert.throws(() => montar({ pedido: pedidoBase({ total_centavos: 0 }) }), TypeError);
    assert.throws(() => montar({ pedido: pedidoBase({ total_centavos: 113.5 }) }), TypeError);
    assert.throws(() => montar({ pedido: pedidoBase({ frete_centavos: 99999 }) }), TypeError);
    assert.throws(() => montar({ siteUrl: '' }), TypeError);
    assert.throws(() => montar({ siteUrl: 'ftp://ama.org.br' }), TypeError);
    assert.throws(() => montar({ siteUrl: 'javascript:alert(1)' }), TypeError);
  });

  test('ehUrlPublicaHttps', () => {
    assert.equal(ehUrlPublicaHttps('https://ama.org.br'), true);
    assert.equal(ehUrlPublicaHttps('https://ama-loja.vercel.app/x'), true);
    for (const url of ['http://ama.org.br', 'https://localhost', 'https://app.localhost', 'https://127.0.0.1:8443', 'https://10.0.0.2', 'https://172.16.1.1', 'https://[::1]', 'https://0.0.0.0', 'nada', '', null]) {
      assert.equal(ehUrlPublicaHttps(url), false, String(url));
    }
  });
});

// ---------------------------------------------------------------------------
describe('validarAssinatura', () => {
  const ID = '123456';
  const REQ = 'bb56a2f1-6aae-46ac-982e-9dcd3581d08e';
  const TS = '1742505638683';
  const SEGREDO = 'segredo-teste';
  const MANIFESTO = `id:${ID};request-id:${REQ};ts:${TS};`;
  const V1 = hmac(MANIFESTO);

  test('montarManifesto segue o modelo oficial e omite as partes ausentes', () => {
    assert.equal(montarManifesto({ dataId: ID, xRequestId: REQ, ts: TS }), MANIFESTO);
    assert.equal(montarManifesto({ xRequestId: REQ, ts: TS }), `request-id:${REQ};ts:${TS};`);
    assert.equal(montarManifesto({ dataId: ID, ts: TS }), `id:${ID};ts:${TS};`);
    assert.equal(montarManifesto({ dataId: '', xRequestId: '', ts: TS }), `ts:${TS};`);
  });

  test('vetor conhecido: válido (e igual ao do MP falso)', () => {
    assert.equal(V1.length, 64);
    assert.equal(assinarNotificacao({ dataId: ID, xRequestId: REQ, ts: TS, segredo: SEGREDO }), `ts=${TS},v1=${V1}`);
    assert.equal(validarAssinatura({ xSignature: `ts=${TS},v1=${V1}`, xRequestId: REQ, dataId: ID, segredo: SEGREDO }), true);
    assert.equal(validarAssinatura({ xSignature: `ts=${TS},v1=${V1}`, xRequestId: REQ, dataId: Number(ID), segredo: SEGREDO }), true);
  });

  test('tolera espaços, ordem invertida, chaves desconhecidas e maiúsculas', () => {
    const base = { xRequestId: REQ, dataId: ID, segredo: SEGREDO };
    for (const xSignature of [
      ` v1 = ${V1} ,  ts = ${TS} `,
      `ts=${TS}, v1=${V1}`,
      `ts=${TS},v2=abc,v1=${V1}`,
      `TS=${TS},V1=${V1.toUpperCase()}`,
      `ts=${TS},v1=${'0'.repeat(64)},v1=${V1}`,
    ]) {
      assert.equal(validarAssinatura({ ...base, xSignature }), true, xSignature);
    }
  });

  test('ts em segundos e em milissegundos (ts literal no manifesto)', () => {
    for (const ts of ['1742505638', '1742505638683']) {
      const v1 = hmac(`id:${ID};request-id:${REQ};ts:${ts};`);
      assert.equal(validarAssinatura({ xSignature: `ts=${ts},v1=${v1}`, xRequestId: REQ, dataId: ID, segredo: SEGREDO }), true, ts);
    }
  });

  test('partes ausentes saem inteiras do manifesto', () => {
    const semRequest = hmac(`id:${ID};ts:${TS};`);
    assert.equal(validarAssinatura({ xSignature: `ts=${TS},v1=${semRequest}`, dataId: ID, segredo: SEGREDO }), true);
    assert.equal(validarAssinatura({ xSignature: `ts=${TS},v1=${semRequest}`, xRequestId: '', dataId: ID, segredo: SEGREDO }), true);
    assert.equal(validarAssinatura({ xSignature: `ts=${TS},v1=${semRequest}`, xRequestId: REQ, dataId: ID, segredo: SEGREDO }), false);

    const semId = hmac(`request-id:${REQ};ts:${TS};`);
    assert.equal(validarAssinatura({ xSignature: `ts=${TS},v1=${semId}`, xRequestId: REQ, segredo: SEGREDO }), true);
    assert.equal(validarAssinatura({ xSignature: `ts=${TS},v1=${semId}`, xRequestId: REQ, dataId: ID, segredo: SEGREDO }), false);

    const soTs = hmac(`ts:${TS};`);
    assert.equal(validarAssinatura({ xSignature: `ts=${TS},v1=${soTs}`, segredo: SEGREDO }), true);
  });

  test('data.id com maiúsculas: aceita o literal (SDKs) e o minúsculo (documentação)', () => {
    const id = 'ORD01JQ4S4KY8HWQ6NA5PXB65B3D3';
    const literal = hmac(`id:${id};request-id:${REQ};ts:${TS};`);
    const minusculo = hmac(`id:${id.toLowerCase()};request-id:${REQ};ts:${TS};`);
    assert.equal(validarAssinatura({ xSignature: `ts=${TS},v1=${literal}`, xRequestId: REQ, dataId: id, segredo: SEGREDO }), true);
    assert.equal(validarAssinatura({ xSignature: `ts=${TS},v1=${minusculo}`, xRequestId: REQ, dataId: id, segredo: SEGREDO }), true);
    const outro = hmac(`id:ord01;request-id:${REQ};ts:${TS};`);
    assert.equal(validarAssinatura({ xSignature: `ts=${TS},v1=${outro}`, xRequestId: REQ, dataId: id, segredo: SEGREDO }), false);
  });

  test('assinatura errada, segredo errado ou dados trocados → false', () => {
    const trocado = (V1[0] === 'a' ? 'b' : 'a') + V1.slice(1);
    const base = { xRequestId: REQ, dataId: ID, segredo: SEGREDO, xSignature: `ts=${TS},v1=${V1}` };
    assert.equal(validarAssinatura({ ...base, xSignature: `ts=${TS},v1=${trocado}` }), false);
    assert.equal(validarAssinatura({ ...base, segredo: 'outro-segredo' }), false);
    assert.equal(validarAssinatura({ ...base, xSignature: `ts=${Number(TS) + 1},v1=${V1}` }), false);
    assert.equal(validarAssinatura({ ...base, dataId: '123457' }), false);
    assert.equal(validarAssinatura({ ...base, xRequestId: `${REQ}x` }), false);
    assert.equal(validarAssinatura({ ...base, xSignature: `ts=${TS},v1=${hmac(MANIFESTO.slice(0, -1))}` }), false, 'sem o ; final');
  });

  test('entradas malformadas → false, sem lançar', () => {
    const base = { xRequestId: REQ, dataId: ID, segredo: SEGREDO };
    for (const xSignature of [
      undefined, null, '', '   ', 'abc', 'ts=,v1=', `ts=${TS}`, `v1=${V1}`, `ts=abc,v1=${V1}`, `ts=-1,v1=${V1}`,
      `ts=1.5,v1=${V1}`, `ts=${TS},v1=${V1.slice(0, 63)}`, `ts=${TS},v1=${V1}0`, `ts=${TS},v1=${'z'.repeat(64)}`,
      `ts=${TS},ts=${TS},v1=${V1}`, `ts${TS}v1${V1}`, 123, {}, [], `ts=${TS},v1=${V1},${'x'.repeat(2000)}`,
    ]) {
      assert.equal(validarAssinatura({ ...base, xSignature }), false, String(xSignature).slice(0, 40));
    }
    for (const segredo of [undefined, null, '', 123, {}]) {
      assert.equal(validarAssinatura({ ...base, segredo, xSignature: `ts=${TS},v1=${V1}` }), false);
    }
    // ts precisa ser inteiro positivo, mesmo com um HMAC que confere com o ts malformado.
    for (const ts of ['abc', '-1', '1.5', '1e12', '0x10', '12345678901234567']) {
      const v1 = hmac(`id:${ID};request-id:${REQ};ts:${ts};`);
      assert.equal(validarAssinatura({ ...base, xSignature: `ts=${ts},v1=${v1}` }), false, `ts=${ts}`);
    }
    assert.equal(validarAssinatura(), false);
    assert.equal(validarAssinatura(null), false);
    assert.equal(validarAssinatura('ts=1,v1=2'), false);
    assert.equal(validarAssinatura({ ...base, xSignature: `ts=${TS},v1=${V1}`, dataId: { toString() { throw new Error('x'); } } }), false);
    const traicoeiro = { get xSignature() { throw new Error('boom'); }, segredo: SEGREDO };
    assert.equal(validarAssinatura(traicoeiro), false);
  });

  test('cabeçalho repetido (array) usa o primeiro valor', () => {
    assert.equal(validarAssinatura({ xSignature: [`ts=${TS},v1=${V1}`], xRequestId: [REQ], dataId: ID, segredo: SEGREDO }), true);
  });

  test('anti-replay opcional: toleranciaSegundos com ts em ms ou s', () => {
    const base = { xSignature: `ts=${TS},v1=${V1}`, xRequestId: REQ, dataId: ID, segredo: SEGREDO };
    const tsMs = Number(TS);
    assert.equal(validarAssinatura({ ...base, toleranciaSegundos: 300, agora: tsMs + 60_000 }), true);
    assert.equal(validarAssinatura({ ...base, toleranciaSegundos: 300, agora: tsMs + 600_000 }), false);
    assert.equal(validarAssinatura({ ...base, toleranciaSegundos: 300, agora: new Date(tsMs - 10_000) }), true);
    const tsS = '1742505638';
    const v1 = hmac(`id:${ID};request-id:${REQ};ts:${tsS};`);
    assert.equal(validarAssinatura({ ...base, xSignature: `ts=${tsS},v1=${v1}`, toleranciaSegundos: 300, agora: 1742505638_000 + 5_000 }), true);
    assert.equal(validarAssinatura({ ...base, xSignature: `ts=${tsS},v1=${v1}`, toleranciaSegundos: 300, agora: 1742505638_000 + 900_000 }), false);
  });
});

// ---------------------------------------------------------------------------
describe('chamadas à API contra o Mercado Pago falso', () => {
  let mp;
  let restaurar;
  let erros;
  before(async () => { mp = await iniciar(); });
  after(async () => { await mp.fechar(); });
  beforeEach((t) => {
    mp.estado.limpar();
    mp.estado.token = '';
    mp.estado.webhookUrl = '';
    mp.estado.falhas = { preferencias: null, pagamentos: null, busca: null };
    restaurar = aplicarAmbiente({ MP_API_BASE: mp.url, MP_ACCESS_TOKEN: 'TEST-token-123' });
    erros = t.mock.method(console, 'error', () => {});
  });
  afterEach(() => { restaurar(); });

  // Toda falha do MP vai para o log (console.error), com o motivo, e nunca com o Access Token.
  function conferirLog(quantidade, padrao) {
    assert.equal(erros.mock.callCount(), quantidade, 'uma linha de log por falha');
    for (const chamada of erros.mock.calls) {
      const linha = chamada.arguments.map(String).join(' ');
      assert.match(linha, /^\[mercadopago\] falha ao /);
      assert.doesNotMatch(linha, /TEST-token-123/);
    }
    if (padrao) assert.match(String(erros.mock.calls.at(-1).arguments[0]), padrao);
  }

  const dados = (extra = {}) => ({ pedido: pedidoBase(), cliente: CLIENTE, entrega: ENTREGA, config: CONFIG, siteUrl: SITE, ...extra });

  test('criarPreferencia devolve { id, init_point } e envia Bearer e X-Idempotency-Key', async () => {
    const resultado = await criarPreferencia(dados());
    assert.deepEqual(Object.keys(resultado).sort(), ['id', 'init_point']);
    assert.equal(resultado.init_point, `${mp.url}/pagar/${encodeURIComponent(resultado.id)}`);
    const pref = mp.estado.preferencias.get(resultado.id);
    assert.equal(pref.external_reference, PEDIDO_ID);
    assert.equal(pref.auto_return, 'approved');
    assert.equal(somaCentavos(pref.items), 11350);
    const [req] = mp.estado.requisicoes;
    assert.equal(req.metodo, 'POST');
    assert.equal(req.caminho, '/checkout/preferences');
    assert.equal(req.cabecalhos.authorization, 'Bearer TEST-token-123');
    assert.equal(req.cabecalhos['x-idempotency-key'], PEDIDO_ID);
    assert.match(req.cabecalhos['content-type'], /application\/json/);
    assert.equal(req.cabecalhos.accept, 'application/json');
  });

  test('mesma chave de idempotência devolve a mesma preferência', async () => {
    const a = await criarPreferencia(dados());
    const b = await criarPreferencia(dados());
    assert.equal(a.id, b.id);
    assert.equal(mp.estado.preferencias.size, 1);
  });

  test('site http (desenvolvimento) é aceito: back_urls sem auto_return', async () => {
    const { id } = await criarPreferencia(dados({ siteUrl: 'http://127.0.0.1:3000' }));
    const pref = mp.estado.preferencias.get(id);
    assert.equal(pref.auto_return, undefined);
    assert.equal(pref.notification_url, undefined);
    assert.match(pref.back_urls.success, /^http:\/\/127\.0\.0\.1:3000\/loja\/pedido\?/);
  });

  test('sem MP_ACCESS_TOKEN → 503 pagamento_indisponivel, sem chamar a API', async () => {
    aplicarAmbiente({ MP_ACCESS_TOKEN: undefined });
    for (const chamada of [() => criarPreferencia(dados()), () => obterPagamento('1'), () => buscarPagamentosPorReferencia(PEDIDO_ID)]) {
      await assert.rejects(chamada(), (erro) => erro instanceof ErroHttp && erro.status === 503 && erro.erro === 'pagamento_indisponivel');
    }
    assert.equal(mp.estado.requisicoes.length, 0);
  });

  test('token recusado → 502 falha_mercado_pago com o corpo só em detalhes (não vai ao cliente)', async () => {
    mp.estado.token = 'token-certo';
    await assert.rejects(criarPreferencia(dados()), (erro) => {
      assert.ok(erro instanceof ErroHttp);
      assert.equal(erro.status, 502);
      assert.equal(erro.erro, 'falha_mercado_pago');
      assert.equal(erro.detalhes.status_mercado_pago, 401);
      assert.match(erro.detalhes.resposta_mercado_pago, /invalid access token/);
      assert.deepEqual(erro.extra, {});
      assert.doesNotMatch(erro.mensagem, /TEST-token/);
      return true;
    });
    conferirLog(1, /falha ao criar a preferência de pagamento: Access Token inválido.*\(HTTP 401\).*invalid access token/);
  });

  test('erro 500 e resposta ilegível → 502', async () => {
    mp.estado.falhas.preferencias = 500;
    await assert.rejects(criarPreferencia(dados()), (erro) => erro.status === 502 && erro.detalhes.status_mercado_pago === 500);
    conferirLog(1, /resposta de erro \(HTTP 500\).*erro simulado/);

    const fetchFalso = simularFetch(() => new Response('<html>oi</html>', { status: 200 }));
    try {
      await assert.rejects(criarPreferencia(dados()), (erro) => erro.status === 502 && erro.detalhes.motivo === 'resposta ilegível');
    } finally {
      fetchFalso.restaurar();
    }
    const semInit = simularFetch(() => respostaJson(201, { id: 'abc', sandbox_init_point: 'https://sandbox.example/x' }));
    try {
      await assert.rejects(criarPreferencia(dados()), (erro) => erro.status === 502);
    } finally {
      semInit.restaurar();
    }
    conferirLog(3, /resposta sem id ou init_point/);
    assert.match(String(erros.mock.calls[1].arguments[0]), /resposta ilegível.*<html>oi<\/html>/);
  });

  test('tempo esgotado e erro de rede → 502', async () => {
    const lento = simularFetch((url, init) => esperarAbort(init));
    try {
      const inicio = Date.now();
      await assert.rejects(criarPreferencia(dados(), { timeoutMs: 50 }),
        (erro) => erro.status === 502 && erro.detalhes.motivo === 'tempo esgotado');
      assert.ok(Date.now() - inicio < 2000);
    } finally {
      lento.restaurar();
    }
    const quebrado = simularFetch(() => { throw new TypeError('fetch failed'); });
    try {
      await assert.rejects(obterPagamento('123'), (erro) => erro.status === 502 && /erro de rede/.test(erro.detalhes.motivo));
    } finally {
      quebrado.restaurar();
    }
    conferirLog(2, /falha ao consultar o pagamento 123: erro de rede \(fetch failed\)/);
    assert.match(String(erros.mock.calls[0].arguments[0]), /tempo esgotado/);
  });

  test('obterPagamento: objeto do MP, null no 404 e no id malformado', async () => {
    const { id } = await criarPreferencia(dados());
    const { pagamento } = await mp.estado.pagar(id, 'aprovar');
    const lido = await obterPagamento(pagamento.id);
    assert.equal(lido.id, pagamento.id);
    assert.equal(lido.status, 'approved');
    assert.equal(lido.external_reference, PEDIDO_ID);
    assert.equal(lido.transaction_amount, 113.5);
    assert.deepEqual(await obterPagamento(String(pagamento.id)), lido);
    assert.equal(await obterPagamento('999999'), null);

    const antes = mp.estado.requisicoes.length;
    for (const invalido of ['../checkout/preferences', '', null, undefined, '1 2', 'a/b', 'abc', '-1', {}, 1.5, -3, '9'.repeat(21)]) {
      assert.equal(await obterPagamento(invalido), null, String(invalido));
    }
    assert.equal(mp.estado.requisicoes.length, antes, 'id malformado não chama a API');

    mp.estado.falhas.pagamentos = 500;
    await assert.rejects(obterPagamento(pagamento.id), (erro) => erro.status === 502);
  });

  test('buscarPagamentosPorReferencia: só a referência pedida, do mais recente ao mais antigo', async () => {
    const e = mp.estado;
    e.adicionarPagamento({ id: 501, external_reference: PEDIDO_ID, status: 'rejected', date_created: '2026-10-01T10:00:00.000-04:00' });
    e.adicionarPagamento({ id: 503, external_reference: PEDIDO_ID, status: 'approved', date_created: '2026-10-03T10:00:00.000-04:00' });
    e.adicionarPagamento({ id: 502, external_reference: PEDIDO_ID, status: 'pending', date_created: '2026-10-02T10:00:00.000-04:00' });
    e.adicionarPagamento({ id: 504, external_reference: 'outro-pedido', status: 'approved', date_created: '2026-10-04T10:00:00.000-04:00' });
    const lista = await buscarPagamentosPorReferencia(PEDIDO_ID);
    assert.deepEqual(lista.map((p) => p.id), [503, 502, 501]);
    const req = e.requisicoes.at(-1);
    const query = new URL(req.caminho, 'http://x').searchParams;
    assert.equal(query.get('external_reference'), PEDIDO_ID);
    assert.equal(query.get('sort'), 'date_created');
    assert.equal(query.get('criteria'), 'desc');
    assert.deepEqual(await buscarPagamentosPorReferencia('nada-aqui'), []);

    const antes = e.requisicoes.length;
    assert.deepEqual(await buscarPagamentosPorReferencia(''), []);
    assert.deepEqual(await buscarPagamentosPorReferencia(null), []);
    assert.equal(e.requisicoes.length, antes);

    e.falhas.busca = 503;
    await assert.rejects(buscarPagamentosPorReferencia(PEDIDO_ID), (erro) => erro.status === 502);
  });

  test('buscarPagamentosPorReferencia reordena e filtra mesmo se a API devolver fora de ordem', async () => {
    // Mesma data: o id maior (mais novo) vem primeiro, mesmo chegando depois na resposta.
    const fetchFalso = simularFetch(() => respostaJson(200, {
      paging: { total: 6, limit: 50, offset: 0 },
      results: [
        { id: 1, external_reference: PEDIDO_ID, date_created: '2026-10-01T10:00:00.000-04:00' },
        { id: 2, external_reference: PEDIDO_ID, date_created: '2026-10-03T10:00:00.000-04:00' },
        { id: 9, external_reference: 'intruso', date_created: '2026-10-09T10:00:00.000-04:00' },
        { id: 3, external_reference: PEDIDO_ID, date_created: '2026-10-03T10:00:00.000-04:00' },
        // Acima de 2^53: como Number seriam iguais; a comparação é exata.
        { id: '9007199254740992', external_reference: PEDIDO_ID, date_created: '2026-09-01T10:00:00.000-04:00' },
        { id: '9007199254740993', external_reference: PEDIDO_ID, date_created: '2026-09-01T10:00:00.000-04:00' },
      ],
    }));
    try {
      const lista = await buscarPagamentosPorReferencia(PEDIDO_ID);
      assert.deepEqual(lista.map((p) => String(p.id)), ['3', '2', '1', '9007199254740993', '9007199254740992']);
      assert.match(fetchFalso.chamadas[0].url, /\/v1\/payments\/search\?/);
      assert.equal(fetchFalso.chamadas[0].cabecalhos.authorization, 'Bearer TEST-token-123');
    } finally {
      fetchFalso.restaurar();
    }
  });
});

// ---------------------------------------------------------------------------
describe('Mercado Pago falso: pagar → webhook assinado → redirecionamento', () => {
  let mp;
  let receptor;
  let urlReceptor;
  const recebidos = [];
  let restaurar;

  before(async () => {
    receptor = http.createServer((req, res) => {
      const partes = [];
      req.on('data', (p) => partes.push(p));
      req.on('end', () => {
        recebidos.push({ metodo: req.method, url: req.url, cabecalhos: req.headers, corpo: Buffer.concat(partes).toString('utf8') });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise((resolve) => receptor.listen(0, '127.0.0.1', resolve));
    urlReceptor = `http://127.0.0.1:${receptor.address().port}`;
    mp = await iniciar({ webhookUrl: `${urlReceptor}/api/webhooks/mercadopago` });
  });
  after(async () => {
    await mp.fechar();
    receptor.closeAllConnections();
    await new Promise((resolve) => receptor.close(resolve));
  });
  beforeEach(() => {
    recebidos.length = 0;
    mp.estado.limpar();
    restaurar = aplicarAmbiente({ MP_API_BASE: mp.url, MP_ACCESS_TOKEN: 'TEST-token-123' });
  });
  afterEach(() => { restaurar(); });

  const SITE_DEV = 'http://127.0.0.1:4321';
  const novaPreferencia = () => criarPreferencia({ pedido: pedidoBase(), cliente: CLIENTE, entrega: ENTREGA, config: CONFIG, siteUrl: SITE_DEV });

  function conferirWebhook(recebido, action, caminho = '/api/webhooks/mercadopago') {
    const url = new URL(recebido.url, 'http://x');
    assert.equal(recebido.metodo, 'POST');
    assert.equal(url.pathname, caminho);
    assert.equal(url.searchParams.get('type'), 'payment');
    const dataId = url.searchParams.get('data.id');
    assert.match(dataId, /^\d+$/);
    const corpo = JSON.parse(recebido.corpo);
    assert.equal(corpo.type, 'payment');
    assert.equal(corpo.action, action);
    assert.deepEqual(corpo.data, { id: dataId });
    const assinatura = {
      xSignature: recebido.cabecalhos['x-signature'], xRequestId: recebido.cabecalhos['x-request-id'], dataId,
    };
    assert.match(assinatura.xSignature, /^ts=\d{13},v1=[0-9a-f]{64}$/);
    assert.equal(validarAssinatura({ ...assinatura, segredo: 'segredo-teste' }), true);
    assert.equal(validarAssinatura({ ...assinatura, segredo: 'outro' }), false);
    assert.equal(validarAssinatura({ ...assinatura, dataId: `${dataId}1`, segredo: 'segredo-teste' }), false);
    return dataId;
  }

  test('página de pagamento mostra itens, total e os três botões', async () => {
    const { init_point: initPoint } = await novaPreferencia();
    const resposta = await fetch(initPoint);
    assert.equal(resposta.status, 200);
    assert.match(resposta.headers.get('content-type'), /text\/html/);
    const html = await resposta.text();
    assert.match(html, /Body Splash Raiz/);
    assert.match(html, /Frete — PAC/);
    assert.match(html, /R\$ 113,50/);
    for (const botao of ['Aprovar', 'Pendente', 'Recusar']) assert.match(html, new RegExp(`>${botao}</button>`));
    assert.equal((await fetch(`${mp.url}/pagar/inexistente`)).status, 404);
  });

  test('Aprovar: cria o pagamento, envia o webhook assinado e redireciona para success', async () => {
    const { id: prefId, init_point: initPoint } = await novaPreferencia();
    const resposta = await fetch(`${initPoint}/aprovar`, { method: 'POST', redirect: 'manual' });
    assert.equal(resposta.status, 302);
    const destino = new URL(resposta.headers.get('location'));
    assert.equal(`${destino.origin}${destino.pathname}`, `${SITE_DEV}/loja/pedido`);
    assert.equal(destino.searchParams.get('id'), PEDIDO_ID);
    assert.equal(destino.searchParams.get('token'), TOKEN);
    assert.equal(destino.searchParams.get('status'), 'approved');
    assert.equal(destino.searchParams.get('collection_status'), 'approved');
    assert.equal(destino.searchParams.get('external_reference'), PEDIDO_ID);
    assert.equal(destino.searchParams.get('preference_id'), prefId);
    const paymentId = destino.searchParams.get('payment_id');
    assert.equal(destino.searchParams.get('collection_id'), paymentId);

    assert.equal(recebidos.length, 1, 'webhook entregue antes do redirecionamento');
    assert.equal(conferirWebhook(recebidos[0], 'payment.created'), paymentId);
    assert.equal(mp.estado.webhooks[0].status, 200);

    const pagamento = await obterPagamento(paymentId);
    assert.equal(pagamento.status, 'approved');
    assert.equal(pagamento.status_detail, 'accredited');
    assert.equal(pagamento.external_reference, PEDIDO_ID);
    assert.equal(pagamento.transaction_amount, 113.5);
    assert.equal(pagamento.payment_type_id, 'credit_card');
    assert.ok(pagamento.payment_method_id);
    assert.ok(pagamento.date_approved);
  });

  test('Pendente e Recusar redirecionam com o status certo (também por GET)', async () => {
    const { init_point: initPoint } = await novaPreferencia();
    const pendente = await fetch(`${initPoint}/pendente`, { method: 'POST', redirect: 'manual' });
    assert.equal(pendente.status, 302);
    const urlPendente = new URL(pendente.headers.get('location'));
    assert.equal(urlPendente.searchParams.get('status'), 'pending');
    const pagamentoPendente = await obterPagamento(urlPendente.searchParams.get('payment_id'));
    assert.equal(pagamentoPendente.status, 'pending');
    assert.equal(pagamentoPendente.payment_type_id, 'bank_transfer');
    assert.equal(pagamentoPendente.date_approved, null);

    const recusado = await fetch(`${initPoint}/recusar`, { redirect: 'manual' });
    assert.equal(recusado.status, 302);
    const urlRecusado = new URL(recusado.headers.get('location'));
    assert.equal(urlRecusado.searchParams.get('status'), 'rejected');
    assert.equal(recebidos.length, 2);
    for (const r of recebidos) conferirWebhook(r, 'payment.created');

    const lista = await buscarPagamentosPorReferencia(PEDIDO_ID);
    assert.deepEqual(lista.map((p) => p.status), ['rejected', 'pending']);
  });

  test('alterarStatus (ex.: refunded) e aprovarPagamento reenviam o webhook payment.updated', async () => {
    const { id: prefId } = await novaPreferencia();
    const { pagamento } = await mp.estado.pagar(prefId, 'pendente');
    const aprovado = await mp.estado.aprovarPagamento(pagamento.id);
    assert.equal(aprovado.pagamento.status, 'approved');
    assert.ok(aprovado.pagamento.date_approved);
    const estornado = await mp.estado.alterarStatus(pagamento.id, 'refunded');
    assert.equal(estornado.webhook.status, 200);
    assert.equal(recebidos.length, 3);
    conferirWebhook(recebidos[0], 'payment.created');
    conferirWebhook(recebidos[1], 'payment.updated');
    conferirWebhook(recebidos[2], 'payment.updated');
    const lido = await obterPagamento(pagamento.id);
    assert.equal(lido.status, 'refunded');
    assert.equal(lido.transaction_amount_refunded, 113.5);
  });

  test('webhook vai para a notification_url da preferência; sem ela, para a opção webhookUrl', async () => {
    const { id: prefId, init_point: initPoint } = await novaPreferencia();
    // O falso (como o MP real) só aceita notification_url https pública na criação; aqui ela é trocada na
    // preferência guardada para apontar para o receptor local.
    const pref = mp.estado.preferencias.get(prefId);
    pref.notification_url = `${urlReceptor}/via-preferencia?source_news=webhooks`;

    const resposta = await fetch(`${initPoint}/aprovar`, { method: 'POST', redirect: 'manual' });
    assert.equal(resposta.status, 302);
    assert.equal(recebidos.length, 1);
    const dataId = conferirWebhook(recebidos[0], 'payment.created', '/via-preferencia');
    const query = new URL(recebidos[0].url, 'http://x').searchParams;
    assert.equal(query.get('source_news'), 'webhooks', 'query original da notification_url mantida');
    assert.equal(mp.estado.webhooks[0].url, `${urlReceptor}/via-preferencia?source_news=webhooks&data.id=${dataId}&type=payment`);

    // Mudanças de status do mesmo pagamento também vão para a notification_url.
    await mp.estado.alterarStatus(dataId, 'refunded');
    conferirWebhook(recebidos[1], 'payment.updated', '/via-preferencia');
    // Pagamento montado com adicionarPagamento acha a preferência pelo external_reference.
    const avulso = mp.estado.adicionarPagamento({ external_reference: PEDIDO_ID, status: 'approved' });
    await mp.estado.enviarWebhook(avulso.id);
    conferirWebhook(recebidos[2], 'payment.updated', '/via-preferencia');

    // Sem notification_url: cai na opção webhookUrl.
    delete pref.notification_url;
    await fetch(`${initPoint}/aprovar`, { method: 'POST', redirect: 'manual' });
    assert.equal(recebidos.length, 4);
    conferirWebhook(recebidos[3], 'payment.created', '/api/webhooks/mercadopago');
  });

  test('cada ação redireciona para a sua back_url (success, pending, failure), mantendo a query', async () => {
    const corpo = {
      items: [{ id: 'x', title: 'Produto', quantity: 2, currency_id: 'BRL', unit_price: 12.34 }],
      external_reference: 'ref-retorno',
      back_urls: {
        success: `${SITE_DEV}/retorno/sucesso?pedido=1`,
        pending: `${SITE_DEV}/retorno/pendente?pedido=1`,
        failure: `${SITE_DEV}/retorno/falha?pedido=1`,
      },
    };
    const criada = await fetch(`${mp.url}/checkout/preferences`, {
      method: 'POST', headers: { Authorization: 'Bearer TEST-1', 'Content-Type': 'application/json' }, body: JSON.stringify(corpo),
    });
    assert.equal(criada.status, 201);
    const { id: prefId, init_point: initPoint } = await criada.json();
    const casos = [
      ['aprovar', '/retorno/sucesso', 'approved'],
      ['pendente', '/retorno/pendente', 'pending'],
      ['recusar', '/retorno/falha', 'rejected'],
    ];
    for (const [acao, caminho, status] of casos) {
      const resposta = await fetch(`${initPoint}/${acao}`, { method: 'POST', redirect: 'manual' });
      assert.equal(resposta.status, 302, acao);
      const destino = new URL(resposta.headers.get('location'));
      assert.equal(destino.origin, SITE_DEV, acao);
      assert.equal(destino.pathname, caminho, acao);
      assert.equal(destino.searchParams.get('pedido'), '1', acao);
      assert.equal(destino.searchParams.get('status'), status, acao);
      assert.equal(destino.searchParams.get('external_reference'), 'ref-retorno', acao);
      assert.equal(destino.searchParams.get('preference_id'), prefId, acao);
      const pagamento = mp.estado.pagamentos.get(destino.searchParams.get('payment_id'));
      assert.equal(pagamento.status, status, acao);
      assert.equal(pagamento.transaction_amount, 24.68, acao);
    }

    // Sem back_url para a ação: página simples em vez de redirecionar.
    const semRetorno = await fetch(`${mp.url}/checkout/preferences`, {
      method: 'POST',
      headers: { Authorization: 'Bearer TEST-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...corpo, back_urls: { success: corpo.back_urls.success } }),
    });
    const { init_point: semRetornoInit } = await semRetorno.json();
    const recusado = await fetch(`${semRetornoInit}/recusar`, { method: 'POST', redirect: 'manual' });
    assert.equal(recusado.status, 200);
    assert.match(await recusado.text(), /rejected/);
  });

  test('pagar com extras simula valor divergente; sem destino de webhook registra o erro', async () => {
    const { id: prefId } = await novaPreferencia();
    const { pagamento } = await mp.estado.pagar(prefId, 'aprovar', { transaction_amount: 1 });
    assert.equal((await obterPagamento(pagamento.id)).transaction_amount, 1);

    mp.estado.webhookUrl = '';
    const { webhook } = await mp.estado.pagar(prefId, 'aprovar');
    assert.match(webhook.erro, /sem destino/);
    mp.estado.webhookUrl = `${urlReceptor}/api/webhooks/mercadopago`;
  });

  test('assinatura com ts em segundos (unidadeTs: "s")', async () => {
    const outro = await iniciar({ webhookUrl: `${urlReceptor}/hook`, unidadeTs: 's', segredo: 'chave-2' });
    try {
      aplicarAmbiente({ MP_API_BASE: outro.url });
      const { id } = await novaPreferencia();
      await outro.estado.pagar(id, 'aprovar');
      const recebido = recebidos.at(-1);
      assert.match(recebido.cabecalhos['x-signature'], /^ts=\d{10},v1=/);
      const dataId = new URL(recebido.url, 'http://x').searchParams.get('data.id');
      assert.equal(validarAssinatura({
        xSignature: recebido.cabecalhos['x-signature'], xRequestId: recebido.cabecalhos['x-request-id'], dataId, segredo: 'chave-2',
      }), true);
    } finally {
      await outro.fechar();
    }
  });
});

// ---------------------------------------------------------------------------
describe('Mercado Pago falso: validações como o MP real', () => {
  let mp;
  before(async () => { mp = await iniciar(); });
  after(async () => { await mp.fechar(); });

  const item = (extra = {}) => ({ id: 'x', title: 'Produto', quantity: 1, currency_id: 'BRL', unit_price: 10, ...extra });
  const criar = (corpo, cabecalhos = { Authorization: 'Bearer TEST-1' }) => fetch(`${mp.url}/checkout/preferences`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...cabecalhos }, body: JSON.stringify(corpo),
  });

  test('exige Bearer', async () => {
    const resposta = await criar({ items: [item()] }, {});
    assert.equal(resposta.status, 401);
    assert.equal((await fetch(`${mp.url}/v1/payments/1`)).status, 401);
    assert.equal((await fetch(`${mp.url}/v1/payments/search?external_reference=x`)).status, 401);
  });

  test('recusa itens inválidos e URLs que o MP recusa', async () => {
    const invalidos = [
      { items: [] },
      { items: [item({ unit_price: 10.005 })] },
      { items: [item({ unit_price: 0 })] },
      { items: [item({ unit_price: -5 })] },
      { items: [item({ unit_price: '10.00' })] },
      { items: [item({ quantity: 1.5 })] },
      { items: [item({ title: '' })] },
      { items: [item({ currency_id: 'USD' })] },
      { items: [item()], statement_descriptor: 'ASSOCIACAO AMA PA' },
      { items: [item()], notification_url: 'http://ama.org.br/api/webhooks/mercadopago' },
      { items: [item()], notification_url: 'https://localhost/api/webhooks/mercadopago' },
      { items: [item()], auto_return: 'approved' },
      { items: [item()], auto_return: 'approved', back_urls: { success: 'http://127.0.0.1:3000/loja/pedido' } },
      { items: [item()], payment_methods: { installments: 0 } },
    ];
    for (const corpo of invalidos) {
      const resposta = await criar(corpo);
      assert.equal(resposta.status, 400, JSON.stringify(corpo));
    }
  });

  test('aceita a preferência montada para um site https e devolve init_point e sandbox_init_point (que não serve)', async () => {
    const corpo = montarPreferencia({ pedido: pedidoBase(), cliente: CLIENTE, entrega: ENTREGA, config: CONFIG, siteUrl: SITE });
    const resposta = await criar(corpo);
    assert.equal(resposta.status, 201);
    const pref = await resposta.json();
    assert.equal(pref.init_point, `${mp.url}/pagar/${encodeURIComponent(pref.id)}`);
    assert.equal(pref.notification_url, corpo.notification_url);
    assert.equal((await fetch(pref.sandbox_init_point)).status, 410);
    const lida = await fetch(`${mp.url}/checkout/preferences/${encodeURIComponent(pref.id)}`, { headers: { Authorization: 'Bearer x' } });
    assert.equal((await lida.json()).id, pref.id);
  });

  test('busca filtra por external_reference, pagina e 404 de pagamento inexistente no formato do MP', async () => {
    mp.estado.limpar();
    const buscar = async (query) => (await fetch(`${mp.url}/v1/payments/search?${query}`, { headers: { Authorization: 'Bearer x' } })).json();
    for (let i = 0; i < 3; i += 1) {
      mp.estado.adicionarPagamento({ external_reference: 'ref-1' });
      mp.estado.adicionarPagamento({ external_reference: 'ref-2' });
    }
    mp.estado.adicionarPagamento({ external_reference: 'ref-10' });
    mp.estado.adicionarPagamento({});

    const corpo = await buscar('external_reference=ref-1&limit=2&offset=0');
    assert.deepEqual(corpo.paging, { total: 3, limit: 2, offset: 0 });
    assert.equal(corpo.results.length, 2);
    assert.ok(corpo.results.every((p) => p.external_reference === 'ref-1'));
    assert.ok(Date.parse(corpo.results[0].date_created) >= Date.parse(corpo.results[1].date_created));
    const resto = await buscar('external_reference=ref-1&limit=2&offset=2');
    assert.equal(resto.results.length, 1);
    assert.equal(resto.results[0].external_reference, 'ref-1');

    const outra = await buscar('external_reference=ref-2');
    assert.equal(outra.paging.total, 3);
    assert.deepEqual([...new Set(outra.results.map((p) => p.external_reference))], ['ref-2']);
    assert.deepEqual((await buscar('external_reference=nada')).results, []);
    assert.equal((await buscar('limit=50')).paging.total, 8, 'sem external_reference lista todos');
    const naoAchou = await fetch(`${mp.url}/v1/payments/424242`, { headers: { Authorization: 'Bearer x' } });
    assert.equal(naoAchou.status, 404);
    assert.equal((await naoAchou.json()).error, 'not_found');
  });
});
