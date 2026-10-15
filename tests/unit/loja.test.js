// Testes de lib/loja.js e das rotas da loja/admin com fetch simulado (sem rede e sem banco).
// O fluxo completo contra o Supabase local e os servidores falsos fica em tests/integracao/loja.test.js.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  codigoRastreioValido, CONFIG_PADRAO, cotar, erroDaLoja, lerConfiguracoes, limparCacheConfiguracoes, normalizarConfiguracoes,
  sincronizarPagamento, urlRastreioValida,
} from '../../lib/loja.js';
import { ErroHttp } from '../../lib/http.js';
import { ErroSupabase } from '../../lib/supabase.js';
import cotacao from '../../api/loja/cotacao.js';
import checkout from '../../api/loja/checkout.js';
import pedidoRota, { pedidoPublico, tokenConfere } from '../../api/loja/pedido.js';
import webhook, { lerNotificacao } from '../../api/webhooks/mercadopago.js';
import status, { modoMercadoPago } from '../../api/admin/status.js';
import pedidoStatus, { argumentosStatus } from '../../api/admin/pedido-status.js';
import envio from '../../api/admin/envio.js';
import pagamentoRota, { escolherPagamento } from '../../api/admin/pagamento.js';
import {
  AMBIENTE_VAZIO, aplicarAmbiente, chamarHandler, respostaJson, simularFetch,
} from '../apoio/servidor.js';

const URL_SUPA = 'http://supabase.teste';
const ANON = 'sb_publishable_teste';
const SERVICO = 'sb_secret_teste_nao_pode_vazar';
const MP = 'http://mp.teste';
const ME = 'http://me.teste';
const RESEND = 'http://resend.teste';
const SEGREDO = 'segredo-teste';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.assinatura';
const ID_ADMIN = '11111111-2222-3333-4444-555555555555';
const ID_PEDIDO = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ID_PRODUTO = '12345678-1234-4123-8123-123456789abc';
const TOKEN = 'ab'.repeat(32);

const SUPABASE = { SUPABASE_URL: URL_SUPA, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICO };

let restaurarAmbiente;
let fetchSimulado;
const silenciar = (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
};

beforeEach(() => {
  restaurarAmbiente = aplicarAmbiente({ ...AMBIENTE_VAZIO, MP_MODO: undefined });
  limparCacheConfiguracoes();
});
afterEach(() => {
  if (fetchSimulado) fetchSimulado.restaurar();
  fetchSimulado = null;
  restaurarAmbiente();
  limparCacheConfiguracoes();
});

const itemCotado = (extra = {}) => ({
  produto_id: ID_PRODUTO, nome: 'Creme', slug: 'creme', imagem: '/img/creme.jpg', preco_unitario_centavos: 4500,
  quantidade: 1, total_centavos: 4500, estoque_disponivel: 3, disponivel: true, motivo: null,
  peso_gramas: 300, altura_cm: 4, largura_cm: 12, comprimento_cm: 16, ...extra,
});

const COTACAO_OK = {
  itens: [itemCotado()], subtotal_centavos: 4500,
};

const LINHAS_CONFIG = [
  { chave: 'loja', valor: { titulo: 'Loja AMA', frete_gratis_acima_centavos: 20000 } },
  { chave: 'frete', valor: { fixo: { ativo: true, opcoes: [{ id: 'fixo-1', nome: 'Entrega local', preco_centavos: 1500, prazo_dias: 3, ufs: ['PA'] }] } } },
  { chave: 'notificacoes', valor: { email_admin: ' equipe@ama.org.br ' } },
];

/**
 * Supabase falso: rotas por trecho da URL. `rotas` mapeia 'rpc/cotar_carrinho', 'configuracoes', 'pedidos',
 * 'auth/v1/user', 'admins'… para uma função (url, chamada) → Response ou um valor (vira JSON 200).
 */
function supabaseFalso(rotas = {}) {
  const padrao = {
    configuracoes: LINHAS_CONFIG,
    'rpc/cotar_carrinho': COTACAO_OK,
    'auth/v1/user': { id: ID_ADMIN, email: 'admin@ama.local' },
    admins: [{ user_id: ID_ADMIN }],
    pedido_eventos: null,
  };
  const todas = { ...padrao, ...rotas };
  return simularFetch((url, init, chamada) => {
    for (const [trecho, resposta] of Object.entries(todas)) {
      const casou = trecho.startsWith('http') ? url.startsWith(trecho)
        : url.startsWith(`${URL_SUPA}/rest/v1/${trecho}`) || url.startsWith(`${URL_SUPA}/${trecho}`);
      if (!casou) continue;
      if (typeof resposta === 'function') return resposta(url, chamada);
      if (resposta instanceof Response) return resposta;
      return resposta === null ? new Response(null, { status: 201 }) : respostaJson(200, resposta);
    }
    return respostaJson(404, { message: `rota não simulada: ${url}` });
  });
}

const rpcs = (nome) => fetchSimulado.chamadas.filter((c) => c.url === `${URL_SUPA}/rest/v1/rpc/${nome}`);

// ---------------------------------------------------------------------------

describe('lib/loja.js — configurações e erros', () => {
  test('normalizarConfiguracoes completa com os padrões e limpa valores ruins', () => {
    const vazio = normalizarConfiguracoes({});
    assert.deepEqual(vazio.loja, { ...CONFIG_PADRAO.loja });
    assert.deepEqual(vazio.checkout, { parcelas_max: 6, aceitar_boleto: true, expiracao_horas: 72 });
    assert.equal(vazio.notificacoes.email_admin, '');
    assert.equal(vazio.frete.retirada.ativa, true);
    assert.deepEqual(vazio.frete.melhor_envio.servicos, [1, 2]);
    assert.equal(Object.isFrozen(vazio.frete.melhor_envio.servicos), false, 'cópia mutável');

    for (const ruim of [0, -5, 'abc', 12.5, null]) {
      assert.equal(normalizarConfiguracoes({ loja: { frete_gratis_acima_centavos: ruim } }).loja.frete_gratis_acima_centavos, null);
    }
    const c = normalizarConfiguracoes({
      loja: { frete_gratis_acima_centavos: '20000', titulo: 'Outra' },
      frete: { origem: { cep: '67125866' } },
      checkout: { parcelas_max: 3 },
      notificacoes: { email_admin: ' a@b.com ' },
    });
    assert.equal(c.loja.frete_gratis_acima_centavos, 20000);
    assert.equal(c.loja.whatsapp, CONFIG_PADRAO.loja.whatsapp);
    assert.equal(c.frete.origem.cep, '67125866');
    assert.equal(c.frete.origem.cidade, 'Ananindeua');
    assert.equal(c.checkout.parcelas_max, 3);
    assert.equal(c.checkout.aceitar_boleto, true);
    assert.equal(c.notificacoes.email_admin, 'a@b.com');
  });

  test('erroDaLoja converte os códigos do banco', (t) => {
    silenciar(t);
    const item = erroDaLoja(new ErroSupabase(400, 'item_indisponivel', '[]'), { itens: [1] });
    assert.equal(item.status, 409);
    assert.equal(item.erro, 'item_indisponivel');
    assert.deepEqual(item.extra.itens, [1]);
    const dados = erroDaLoja(new ErroSupabase(400, 'dados_invalidos', 'cliente.cpf'));
    assert.deepEqual([dados.status, dados.extra.campo], [400, 'cliente.cpf']);
    assert.equal(erroDaLoja(new ErroSupabase(400, 'carrinho_vazio')).status, 400);
    assert.equal(erroDaLoja(new ErroSupabase(400, 'total_invalido')).erro, 'total_invalido');
    assert.equal(erroDaLoja(new ErroSupabase(400, 'pedido_nao_encontrado')).status, 404);
    for (const [st, codigo] of [[502, 'falha_conexao'], [504, 'tempo_esgotado'], [503, 'http_503']]) {
      const e = erroDaLoja(new ErroSupabase(st, codigo));
      assert.deepEqual([e.status, e.erro], [502, 'falha_banco']);
    }
    assert.equal(erroDaLoja(new ErroSupabase(404, 'Could not find the function')).status, 500);
    const http = new ErroHttp(418, 'bule');
    assert.equal(erroDaLoja(http), http);
    const comum = new Error('x');
    assert.equal(erroDaLoja(comum), comum);
  });

  test('lerConfiguracoes usa cache curto, devolve cópias e não guarda falhas', async (t) => {
    silenciar(t);
    aplicarAmbiente(SUPABASE);
    let falhar = true;
    fetchSimulado = supabaseFalso({
      configuracoes: () => (falhar ? respostaJson(500, { message: 'fora' }) : respostaJson(200, LINHAS_CONFIG)),
    });
    await assert.rejects(lerConfiguracoes(), (e) => e.status === 502 && e.erro === 'falha_banco');
    falhar = false;
    const a = await lerConfiguracoes();
    a.loja.titulo = 'mudado';
    const b = await lerConfiguracoes();
    assert.equal(b.loja.titulo, 'Loja AMA');
    assert.equal(b.loja.frete_gratis_acima_centavos, 20000);
    assert.equal(b.notificacoes.email_admin, 'equipe@ama.org.br');
    assert.equal(fetchSimulado.chamadas.length, 2, 'uma falha + uma leitura (a segunda veio do cache)');
    const consulta = fetchSimulado.chamadas[1];
    assert.equal(consulta.cabecalhos.apikey, SERVICO);
    assert.match(decodeURIComponent(consulta.url), /chave=in\.\(loja,frete,checkout,notificacoes\)/);
    limparCacheConfiguracoes();
    await lerConfiguracoes();
    assert.equal(fetchSimulado.chamadas.length, 3);
  });
});

describe('lib/loja.js — cotar e sincronizarPagamento', () => {
  test('cotar sem CEP: frete null e entrada normalizada para cotar_carrinho', async () => {
    aplicarAmbiente(SUPABASE);
    fetchSimulado = supabaseFalso();
    const r = await cotar({
      itens: [{ produto_id: ` ${ID_PRODUTO.toUpperCase()} `, quantidade: '2' }, { quantidade: 1 }, 'lixo'],
      cupom: ' ama10 ', // campo antigo: ignorado
    });
    assert.equal(r.frete, null);
    assert.equal(r.subtotal_centavos, 4500);
    assert.equal(r.frete_gratis_acima_centavos, 20000);
    assert.deepEqual(Object.keys(r).sort(), ['frete', 'frete_gratis_acima_centavos', 'itens', 'subtotal_centavos']);
    const [chamada] = rpcs('cotar_carrinho');
    assert.deepEqual(JSON.parse(chamada.corpo), { p: { itens: [{ produto_id: ID_PRODUTO, quantidade: 2 }] } });
    assert.equal(chamada.cabecalhos.authorization, `Bearer ${SERVICO}`);
  });

  test('cotar: carrinho vazio ou inválido → 400 sem consultar o banco; comFrete sem CEP → só retirada', async () => {
    aplicarAmbiente(SUPABASE);
    fetchSimulado = supabaseFalso();
    await assert.rejects(cotar({ itens: [] }), (e) => e.status === 400 && e.erro === 'carrinho_vazio');
    await assert.rejects(cotar({}), (e) => e.erro === 'carrinho_vazio');
    await assert.rejects(cotar({ itens: 'x' }), (e) => e.status === 400 && e.erro === 'dados_invalidos');
    assert.equal(fetchSimulado.chamadas.length, 0);

    const r = await cotar({ itens: [{ produto_id: ID_PRODUTO, quantidade: 1 }] }, { comFrete: true });
    assert.deepEqual(r.frete.opcoes.map((o) => o.id), ['retirada']);
    assert.ok(r.frete.erro);
  });

  test('cotar: frete grátis por valor mínimo usa o subtotal', async () => {
    aplicarAmbiente(SUPABASE);
    const abaixoItem = itemCotado({ preco_unitario_centavos: 9_999, quantidade: 2, total_centavos: 19_998 });
    fetchSimulado = supabaseFalso({ 'rpc/cotar_carrinho': { ...COTACAO_OK, itens: [abaixoItem], subtotal_centavos: 19_998 } });
    // Limite de LINHAS_CONFIG: R$ 200,00.
    const abaixo = await cotar({ itens: [{ produto_id: ID_PRODUTO, quantidade: 2 }], cep: '66010-000' });
    assert.equal(abaixo.frete_gratis_acima_centavos, 20_000);
    assert.deepEqual(abaixo.frete.opcoes.map((o) => o.id), ['fixo-1', 'retirada']);
    assert.ok(abaixo.frete.opcoes.every((o) => o.gratis === false));

    fetchSimulado.restaurar();
    const item = itemCotado({ preco_unitario_centavos: 10_000, quantidade: 2, total_centavos: 20_000 });
    fetchSimulado = supabaseFalso({ 'rpc/cotar_carrinho': { ...COTACAO_OK, itens: [item], subtotal_centavos: 20_000 } });
    const noLimite = await cotar({ itens: [{ produto_id: ID_PRODUTO, quantidade: 2 }], cep: '66010-000' });
    assert.equal(noLimite.frete.opcoes[0].gratis, true);
    assert.equal(noLimite.frete.opcoes[0].preco_centavos, 0);
    assert.equal(noLimite.frete.opcoes[0].preco_original_centavos, 1500);
  });

  test('cotar: banco devolve itens vazios → 400 carrinho_vazio', async () => {
    aplicarAmbiente(SUPABASE);
    fetchSimulado = supabaseFalso({ 'rpc/cotar_carrinho': { ...COTACAO_OK, itens: [], subtotal_centavos: 0 } });
    await assert.rejects(cotar({ itens: [{ produto_id: ID_PRODUTO, quantidade: 0 }] }), (e) => e.erro === 'carrinho_vazio');
  });

  test('sincronizarPagamento: referência que não é UUID → 400 sem chamar o banco', async () => {
    aplicarAmbiente(SUPABASE);
    fetchSimulado = supabaseFalso();
    await assert.rejects(sincronizarPagamento({ id: 1, status: 'approved', external_reference: 'abc' }),
      (e) => e.status === 400 && e.erro === 'referencia_invalida');
    assert.equal(fetchSimulado.chamadas.length, 0);
  });

  test('sincronizarPagamento envia só os campos do pagamento; virou pago → e-mails e eventos', async () => {
    aplicarAmbiente({ ...SUPABASE, RESEND_API_KEY: 're_teste', RESEND_API_BASE: RESEND, SITE_URL: 'https://ama.org.br' });
    const pedido = {
      id: ID_PEDIDO, numero: 1001, token_acesso: TOKEN, status: 'pago', cliente_nome: 'Maria Silva', cliente_email: 'maria@exemplo.com',
      entrega: { tipo: 'retirada', nome: 'Retirar na sede' }, total_centavos: 4500, subtotal_centavos: 4500,
      frete_centavos: 0, pedido_itens: [{ nome: 'Creme', quantidade: 1, preco_unitario_centavos: 4500, total_centavos: 4500 }],
    };
    fetchSimulado = supabaseFalso({
      'rpc/confirmar_pagamento': { pedido_id: ID_PEDIDO, numero: 1001, status_anterior: 'aguardando_pagamento', status_novo: 'pago', mudou: true, virou_pago: true },
      pedidos: [pedido],
      [RESEND]: () => respostaJson(200, { id: 'email-1' }),
    });
    const pagamento = {
      id: 987, status: 'approved', status_detail: 'accredited', transaction_amount: 45, payment_type_id: 'credit_card',
      payment_method_id: 'master', date_approved: '2026-10-14T10:00:00.000-03:00', external_reference: ID_PEDIDO.toUpperCase(),
      payer: { email: 'segredo@exemplo.com' }, card: { last_four_digits: '1234' },
    };
    const r = await sincronizarPagamento(pagamento, { siteUrl: 'https://ama.org.br' });
    assert.equal(r.virou_pago, true);
    const [rpc] = rpcs('confirmar_pagamento');
    assert.deepEqual(JSON.parse(rpc.corpo), {
      p_pedido_id: ID_PEDIDO,
      p_pagamento: {
        id: 987, status: 'approved', status_detail: 'accredited', transaction_amount: 45, payment_type_id: 'credit_card',
        payment_method_id: 'master', date_approved: '2026-10-14T10:00:00.000-03:00',
      },
    });
    const emails = fetchSimulado.chamadas.filter((c) => c.url === `${RESEND}/emails`);
    assert.equal(emails.length, 2);
    const para = emails.map((e) => JSON.parse(e.corpo).to[0]).sort();
    assert.deepEqual(para, ['equipe@ama.org.br', 'maria@exemplo.com']);
    assert.equal(emails.find((e) => JSON.parse(e.corpo).to[0] === 'maria@exemplo.com').cabecalhos['idempotency-key'], `pedido-pago-${ID_PEDIDO}`);
    const eventos = fetchSimulado.chamadas.filter((c) => c.url.startsWith(`${URL_SUPA}/rest/v1/pedido_eventos`));
    assert.equal(eventos.length, 2);
    assert.ok(eventos.every((e) => JSON.parse(e.corpo).tipo === 'email'));
  });

  test('sincronizarPagamento: falha do Resend não derruba nem registra evento', async (t) => {
    silenciar(t);
    aplicarAmbiente({ ...SUPABASE, RESEND_API_KEY: 're_teste', RESEND_API_BASE: RESEND });
    fetchSimulado = supabaseFalso({
      'rpc/confirmar_pagamento': { status_novo: 'pago', virou_pago: true },
      pedidos: [{ id: ID_PEDIDO, numero: 1, cliente_email: 'maria@exemplo.com', pedido_itens: [] }],
      [RESEND]: () => respostaJson(500, { message: 'fora' }),
    });
    const r = await sincronizarPagamento({ id: 1, status: 'approved', external_reference: ID_PEDIDO });
    assert.equal(r.virou_pago, true);
    assert.equal(fetchSimulado.chamadas.filter((c) => c.url.includes('pedido_eventos')).length, 0);
  });
});

// ---------------------------------------------------------------------------

describe('api/loja/cotacao.js e api/loja/checkout.js', () => {
  test('cotação: 405, JSON inválido 400, sem Supabase 503', async () => {
    fetchSimulado = supabaseFalso();
    const get = await chamarHandler(cotacao, { method: 'GET' });
    assert.equal(get.statusCode, 405);
    assert.equal(get.cabecalhos.allow, 'POST');
    const ruim = await chamarHandler(cotacao, { method: 'POST', corpoLanca: true });
    assert.equal(ruim.statusCode, 400);
    assert.equal(ruim.json().erro, 'json_invalido');
    const semBanco = await chamarHandler(cotacao, { method: 'POST', body: { itens: [{ produto_id: ID_PRODUTO, quantidade: 1 }] } });
    assert.equal(semBanco.statusCode, 503);
    assert.equal(semBanco.json().erro, 'supabase_nao_configurado');
  });

  test('cotação ok: { ok: true, ... } sem cache', async () => {
    aplicarAmbiente(SUPABASE);
    fetchSimulado = supabaseFalso();
    const r = await chamarHandler(cotacao, { method: 'POST', body: { itens: [{ produto_id: ID_PRODUTO, quantidade: 1 }] } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.cabecalhos['cache-control'], 'no-store');
    assert.equal(r.json().ok, true);
    assert.equal(r.json().frete, null);
  });

  const corpoCheckout = (extra = {}) => ({
    itens: [{ produto_id: ID_PRODUTO, quantidade: 1 }],
    frete_id: 'retirada',
    cliente: { nome: 'Maria da Silva', email: 'maria@exemplo.com', telefone: '91981056049', cpf: '52998224725' },
    ...extra,
  });

  test('checkout sem Mercado Pago → 503 antes de qualquer consulta', async () => {
    aplicarAmbiente(SUPABASE);
    fetchSimulado = supabaseFalso();
    const r = await chamarHandler(checkout, { method: 'POST', body: corpoCheckout() });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().erro, 'pagamento_indisponivel');
    assert.equal(fetchSimulado.chamadas.length, 0);
  });

  test('checkout: dados inválidos → 400 com campo e erros; item indisponível → 409 sem criar pedido', async () => {
    aplicarAmbiente({ ...SUPABASE, MP_ACCESS_TOKEN: 'APP_USR-x', MP_API_BASE: MP });
    fetchSimulado = supabaseFalso({ 'rpc/cotar_carrinho': { ...COTACAO_OK, itens: [itemCotado({ disponivel: false, motivo: 'sem_estoque' })] } });
    const invalido = await chamarHandler(checkout, { method: 'POST', body: corpoCheckout({ cliente: { nome: 'Maria' } }) });
    assert.equal(invalido.statusCode, 400);
    assert.equal(invalido.json().campo, 'cliente.nome');
    assert.ok(invalido.json().erros['cliente.cpf']);

    const r = await chamarHandler(checkout, { method: 'POST', body: corpoCheckout() });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().erro, 'item_indisponivel');
    assert.equal(r.json().itens[0].motivo, 'sem_estoque');
    assert.equal(rpcs('criar_pedido').length, 0);
  });

  test('checkout: estoque acabou entre a cotação e o pedido → 409 com o carrinho recotado', async () => {
    aplicarAmbiente({ ...SUPABASE, MP_ACCESS_TOKEN: 'APP_USR-x', MP_API_BASE: MP });
    let cotacoes = 0;
    fetchSimulado = supabaseFalso({
      'rpc/cotar_carrinho': () => {
        cotacoes += 1;
        return respostaJson(200, cotacoes === 1 ? COTACAO_OK
          : { ...COTACAO_OK, itens: [itemCotado({ disponivel: false, motivo: 'sem_estoque', estoque_disponivel: 0 })] });
      },
      'rpc/criar_pedido': () => respostaJson(400, { code: 'P0001', message: 'item_indisponivel', details: '[]' }),
    });
    const r = await chamarHandler(checkout, { method: 'POST', body: corpoCheckout() });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().itens[0].estoque_disponivel, 0);
  });

  test('checkout: falha na preferência → cancela o pedido e responde 502', async (t) => {
    silenciar(t);
    aplicarAmbiente({ ...SUPABASE, MP_ACCESS_TOKEN: 'APP_USR-x', MP_API_BASE: MP, SITE_URL: 'https://ama.org.br' });
    fetchSimulado = supabaseFalso({
      'rpc/criar_pedido': {
        id: ID_PEDIDO, numero: 1001, token_acesso: TOKEN, subtotal_centavos: 4500, frete_centavos: 0,
        total_centavos: 4500, itens: [itemCotado()],
      },
      'rpc/alterar_status_pedido': { status_anterior: 'aguardando_pagamento', status_novo: 'cancelado' },
      [MP]: () => respostaJson(500, { message: 'erro' }),
    });
    const r = await chamarHandler(checkout, { method: 'POST', body: corpoCheckout() });
    assert.equal(r.statusCode, 502);
    assert.equal(r.json().erro, 'falha_mercado_pago');
    const [cancelar] = rpcs('alterar_status_pedido');
    assert.equal(JSON.parse(cancelar.corpo).p_status, 'cancelado');
    assert.equal(JSON.parse(cancelar.corpo).p_pedido_id, ID_PEDIDO);
  });
});

// ---------------------------------------------------------------------------

describe('api/loja/pedido.js', () => {
  const linha = {
    id: ID_PEDIDO, numero: 1001, token_acesso: TOKEN, status: 'aguardando_pagamento', status_pagamento: null,
    criado_em: '2026-10-14T12:00:00Z', pago_em: null, enviado_em: null, subtotal_centavos: 4500,
    frete_centavos: 0, total_centavos: 4500, entrega: { tipo: 'retirada', id: 'retirada', nome: 'Retirar na sede', preco_centavos: 0 },
    codigo_rastreio: null, url_rastreio: null, cliente_nome: '  Maria   Silva', mp_init_point: 'https://mp.teste/pagar/1',
    pedido_itens: [{ nome: 'Creme', imagem: '/img/c.jpg', quantidade: 1, preco_unitario_centavos: 4500, total_centavos: 4500 }],
  };

  test('tokenConfere em tempo constante (inclusive tamanhos diferentes)', () => {
    assert.equal(tokenConfere(TOKEN, TOKEN), true);
    assert.equal(tokenConfere(TOKEN.slice(0, -1), TOKEN), false);
    assert.equal(tokenConfere(`${TOKEN}0`, TOKEN), false);
    assert.equal(tokenConfere('', TOKEN), false);
    assert.equal(tokenConfere(TOKEN, null), false);
  });

  test('pedidoPublico: só os campos da §6.4', () => {
    const p = pedidoPublico({ ...linha, cliente_cpf: '52998224725', cliente_email: 'x@y.com', notas_internas: 'segredo' });
    assert.equal(p.primeiro_nome, 'Maria');
    assert.equal(p.pode_pagar, true);
    assert.equal(p.link_pagamento, linha.mp_init_point);
    assert.deepEqual(p.entrega, { tipo: 'retirada', nome: 'Retirar na sede', empresa: null, prazo_dias: null });
    const texto = JSON.stringify(p);
    for (const proibido of ['52998224725', 'x@y.com', 'segredo', TOKEN]) assert.ok(!texto.includes(proibido));
    const pago = pedidoPublico({ ...linha, status: 'pago' });
    assert.equal(pago.pode_pagar, false);
    assert.equal(pago.link_pagamento, null);
    assert.equal(pedidoPublico({ ...linha, mp_init_point: null }).pode_pagar, false);
  });

  test('id inválido → 404 sem consultar; token errado → o mesmo 404; certo → 200 no-store', async () => {
    aplicarAmbiente(SUPABASE);
    fetchSimulado = supabaseFalso({ pedidos: [linha] });
    const invalido = await chamarHandler(pedidoRota, { url: '/api/loja/pedido?id=1&token=x', query: { id: '1', token: 'x' } });
    assert.equal(invalido.statusCode, 404);
    assert.equal(fetchSimulado.chamadas.length, 0);
    assert.equal(invalido.cabecalhos['cache-control'], 'no-store');

    const errado = await chamarHandler(pedidoRota, { query: { id: ID_PEDIDO, token: 'cd'.repeat(32) } });
    assert.equal(errado.statusCode, 404);
    assert.equal(errado.json().mensagem, invalido.json().mensagem);

    const certo = await chamarHandler(pedidoRota, { query: { id: ID_PEDIDO.toUpperCase(), token: TOKEN } });
    assert.equal(certo.statusCode, 200);
    assert.equal(certo.cabecalhos['cache-control'], 'no-store');
    assert.equal(certo.json().pedido.numero, 1001);
  });

  test('payment_id de outro pedido não sincroniza; falha do Mercado Pago não derruba a página', async (t) => {
    silenciar(t);
    aplicarAmbiente({ ...SUPABASE, MP_ACCESS_TOKEN: 'APP_USR-x', MP_API_BASE: MP });
    let mpFora = false;
    fetchSimulado = supabaseFalso({
      pedidos: [linha],
      [MP]: () => (mpFora ? respostaJson(500, {}) : respostaJson(200, { id: 5, status: 'approved', external_reference: 'outro' })),
    });
    const outro = await chamarHandler(pedidoRota, { query: { id: ID_PEDIDO, token: TOKEN, payment_id: '5' } });
    assert.equal(outro.statusCode, 200);
    assert.equal(rpcs('confirmar_pagamento').length, 0);
    mpFora = true;
    const fora = await chamarHandler(pedidoRota, { query: { id: ID_PEDIDO, token: TOKEN, payment_id: '5' } });
    assert.equal(fora.statusCode, 200);
    const lixo = await chamarHandler(pedidoRota, { query: { id: ID_PEDIDO, token: TOKEN, payment_id: '../x' } });
    assert.equal(lixo.statusCode, 200);
    assert.equal(fetchSimulado.chamadas.filter((c) => c.url.startsWith(MP)).length, 2, 'payment_id não numérico nem consulta');
  });
});

// ---------------------------------------------------------------------------

describe('api/webhooks/mercadopago.js', () => {
  const assinar = (dataId, requestId = 'req-1', ts = String(Date.now())) => {
    const v1 = createHmac('sha256', SEGREDO).update(`id:${dataId};request-id:${requestId};ts:${ts};`).digest('hex');
    return { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId };
  };
  const notificar = (query, { headers = {}, body = { type: 'payment', data: { id: query['data.id'] } } } = {}) => chamarHandler(webhook, {
    method: 'POST', query, headers, body,
  });

  test('lerNotificacao: Webhooks, IPN e resource', () => {
    assert.deepEqual(lerNotificacao({ 'data.id': '123', type: 'payment' }, { data: { id: '999' } }), { topico: 'payment', id: '123', idQuery: '123' });
    assert.deepEqual(lerNotificacao({ topic: 'payment', id: '77' }, {}), { topico: 'payment', id: '77', idQuery: '' });
    assert.deepEqual(lerNotificacao({}, { action: 'payment.created', data: { id: 8 } }), { topico: 'payment', id: '8', idQuery: '' });
    assert.equal(lerNotificacao({ topic: 'payment' }, { resource: 'https://api.mercadopago.com/v1/payments/4455' }).id, '4455');
    assert.equal(lerNotificacao({ topic: 'merchant_order', id: '1' }, {}).topico, 'merchant_order');
  });

  test('tópico que não é pagamento → 200 ignorado sem consultar nada; GET → 405', async () => {
    aplicarAmbiente({ ...SUPABASE, MP_ACCESS_TOKEN: 'x', MP_API_BASE: MP, MP_WEBHOOK_SECRET: SEGREDO });
    fetchSimulado = supabaseFalso();
    const r = await notificar({ topic: 'merchant_order', id: '1' }, { body: {} });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json(), { ok: true, ignorado: true, motivo: 'topico' });
    assert.equal(fetchSimulado.chamadas.length, 0);
    const get = await chamarHandler(webhook, { method: 'GET', query: { 'data.id': '1', type: 'payment' } });
    assert.equal(get.statusCode, 405);
  });

  test('assinatura inválida → 401 sem consultar o Mercado Pago; sem segredo, x-signature é ignorada', async (t) => {
    silenciar(t);
    aplicarAmbiente({ ...SUPABASE, MP_ACCESS_TOKEN: 'x', MP_API_BASE: MP, MP_WEBHOOK_SECRET: SEGREDO });
    fetchSimulado = supabaseFalso({ [MP]: () => respostaJson(404, { message: 'not found' }) });
    const r = await notificar({ 'data.id': '123', type: 'payment' }, { headers: assinar('124') });
    assert.equal(r.statusCode, 401);
    assert.equal(fetchSimulado.chamadas.length, 0);

    const valida = await notificar({ 'data.id': '123', type: 'payment' }, { headers: assinar('123') });
    assert.equal(valida.statusCode, 200);
    assert.equal(valida.json().motivo, 'pagamento_inexistente');

    aplicarAmbiente({ MP_WEBHOOK_SECRET: undefined });
    const semSegredo = await notificar({ 'data.id': '123', type: 'payment' }, { headers: assinar('999') });
    assert.equal(semSegredo.statusCode, 200);
  });

  test('sem Mercado Pago configurado → 503; Mercado Pago fora → 500; banco fora → 500', async (t) => {
    silenciar(t);
    aplicarAmbiente({ ...SUPABASE, MP_API_BASE: MP });
    fetchSimulado = supabaseFalso({
      [MP]: () => respostaJson(200, { id: 1, status: 'approved', external_reference: ID_PEDIDO }),
      'rpc/confirmar_pagamento': () => respostaJson(503, { message: 'fora' }),
    });
    const semMp = await notificar({ 'data.id': '1', type: 'payment' });
    assert.equal(semMp.statusCode, 503);

    aplicarAmbiente({ MP_ACCESS_TOKEN: 'x' });
    const banco = await notificar({ 'data.id': '1', type: 'payment' });
    assert.equal(banco.statusCode, 500);

    fetchSimulado.restaurar();
    fetchSimulado = supabaseFalso({ [MP]: () => respostaJson(502, {}) });
    const mp = await notificar({ 'data.id': '1', type: 'payment' });
    assert.equal(mp.statusCode, 500);
  });

  test('corpo ilegível com a query válida ainda processa; pedido inexistente → 200 ignorado', async () => {
    aplicarAmbiente({ ...SUPABASE, MP_ACCESS_TOKEN: 'x', MP_API_BASE: MP });
    fetchSimulado = supabaseFalso({
      [MP]: () => respostaJson(200, { id: 1, status: 'approved', external_reference: ID_PEDIDO }),
      'rpc/confirmar_pagamento': () => respostaJson(400, { code: 'P0001', message: 'pedido_nao_encontrado' }),
    });
    const r = await chamarHandler(webhook, { method: 'POST', query: { 'data.id': '1', type: 'payment' }, corpoLanca: true });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().motivo, 'pedido_inexistente');
  });
});

// ---------------------------------------------------------------------------

describe('rotas de admin (unidade)', () => {
  const comAdmin = { authorization: `Bearer ${JWT}` };

  test('modoMercadoPago: produção por padrão, teste só com MP_MODO', () => {
    assert.equal(modoMercadoPago(false, 'teste'), null);
    assert.equal(modoMercadoPago(true, undefined), 'producao');
    assert.equal(modoMercadoPago(true, ''), 'producao');
    assert.equal(modoMercadoPago(true, 'Producao'), 'producao');
    assert.equal(modoMercadoPago(true, 'teste'), 'teste');
    assert.equal(modoMercadoPago(true, 'sandbox'), 'teste');
    assert.equal(modoMercadoPago(true, 'qualquer'), null);
  });

  test('status: integrações sem Melhor Envio nem e-mail', async () => {
    aplicarAmbiente({ ...SUPABASE, SITE_URL: 'https://ama.org.br', MP_ACCESS_TOKEN: 'APP_USR-x' });
    fetchSimulado = supabaseFalso();
    const r = await chamarHandler(status, { method: 'GET', headers: comAdmin });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.json().integracoes, {
      supabase: { configurado: true },
      mercadopago: { configurado: true, modo: 'producao' },
      melhor_envio: { configurado: false, ambiente: 'producao', saldo_centavos: null, erro: null },
      email: { configurado: false },
      webhook_assinatura: false,
      site_url: 'https://ama.org.br',
    });
  });

  test('argumentosStatus valida e monta p_rastreio só com o que veio', () => {
    assert.throws(() => argumentosStatus({ pedido_id: 'x', status: 'pago' }), (e) => e.status === 400 && e.extra.campo === 'pedido_id');
    assert.throws(() => argumentosStatus({ pedido_id: ID_PEDIDO, status: 'sumiu' }), (e) => e.erro === 'status_invalido');
    assert.throws(() => argumentosStatus({ pedido_id: ID_PEDIDO, status: 'enviado', url_rastreio: 'http://x.com' }), (e) => e.extra.campo === 'url_rastreio');
    assert.throws(() => argumentosStatus({ pedido_id: ID_PEDIDO, status: 'enviado', codigo_rastreio: 12 }), (e) => e.extra.campo === 'codigo_rastreio');
    assert.deepEqual(argumentosStatus({ pedido_id: ID_PEDIDO.toUpperCase(), status: ' Enviado ' }), {
      p_pedido_id: ID_PEDIDO, p_status: 'enviado', p_nota: null, p_repor_estoque: false, p_rastreio: null,
    });
    assert.deepEqual(argumentosStatus({
      pedido_id: ID_PEDIDO, status: 'cancelado', codigo_rastreio: '', nota: ' ok ', repor_estoque: true,
    }), {
      p_pedido_id: ID_PEDIDO, p_status: 'cancelado', p_nota: 'ok', p_repor_estoque: true, p_rastreio: { codigo_rastreio: null },
    });
  });

  test('urlRastreioValida e codigoRastreioValido seguem as regras do banco', () => {
    for (const ok of ['https://rastreamento.correios.com.br/app/index.php', 'https://melhorrastreio.com.br/rastreio/AA1BR?x=1#y', 'https://a.b:8443']) {
      assert.equal(urlRastreioValida(ok), true, ok);
    }
    for (const ruim of ['http://x.com', 'https://', 'https://x.com/a b', 'https://x.com/"><script>', "https://x.com/'", 'https://x.com/`',
      'https://x.com/\\a', 'javascript:alert(1)', `https://x.com/${'a'.repeat(500)}`, null, 12]) {
      assert.equal(urlRastreioValida(ruim), false, String(ruim));
    }
    assert.equal(codigoRastreioValido('AA123456789BR, BB987654321BR'), true);
    for (const ruim of ['AA<b>', 'a"b', "a'b", 'a`b', 'a\u0001b', 'x'.repeat(201), 5]) assert.equal(codigoRastreioValido(ruim), false);
  });

  test('pedido-status: erros de rastreio com o nome do campo da entrada (inclusive vindos do banco)', async () => {
    assert.throws(() => argumentosStatus({ pedido_id: ID_PEDIDO, status: 'enviado', url_rastreio: 'https://x.com/"a' }),
      (e) => e.status === 400 && e.extra.campo === 'url_rastreio');
    assert.throws(() => argumentosStatus({ pedido_id: ID_PEDIDO, status: 'enviado', codigo_rastreio: 'AA<1>' }),
      (e) => e.status === 400 && e.extra.campo === 'codigo_rastreio');
    assert.deepEqual(argumentosStatus({ pedido_id: ID_PEDIDO, status: 'enviado', url_rastreio: '' }).p_rastreio, { url_rastreio: null }, '"" apaga');

    aplicarAmbiente(SUPABASE);
    for (const [detalhe, campo] of [['p_rastreio.url_rastreio', 'url_rastreio'], ['p_rastreio.codigo_rastreio', 'codigo_rastreio'], ['p_nota', 'nota']]) {
      fetchSimulado = supabaseFalso({
        'rpc/alterar_status_pedido': () => respostaJson(400, { code: 'P0001', message: 'dados_invalidos', details: detalhe }),
      });
      const r = await chamarHandler(pedidoStatus, {
        method: 'POST', headers: comAdmin, body: { pedido_id: ID_PEDIDO, status: 'enviado', url_rastreio: 'https://ok.com/x' },
      });
      assert.equal(r.statusCode, 400);
      assert.equal(r.json().erro, 'dados_invalidos');
      assert.equal(r.json().campo, campo);
      fetchSimulado.restaurar();
      fetchSimulado = null;
    }
    fetchSimulado = supabaseFalso({ 'rpc/alterar_status_pedido': () => respostaJson(400, { code: 'P0001', message: 'pedido_nao_encontrado' }) });
    const inexistente = await chamarHandler(pedidoStatus, { method: 'POST', headers: comAdmin, body: { pedido_id: ID_PEDIDO, status: 'pago' } });
    assert.equal(inexistente.statusCode, 404);
  });

  test('pedido-status: autor = e-mail do admin; sem pedir, nenhum e-mail', async () => {
    aplicarAmbiente(SUPABASE);
    fetchSimulado = supabaseFalso({ 'rpc/alterar_status_pedido': { status_anterior: 'pago', status_novo: 'em_separacao', mudou: true } });
    const r = await chamarHandler(pedidoStatus, { method: 'POST', headers: comAdmin, body: { pedido_id: ID_PEDIDO, status: 'em_separacao', notificar_cliente: true } });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().email_enviado, null, 'em_separacao não tem e-mail');
    assert.equal(JSON.parse(rpcs('alterar_status_pedido')[0].corpo).p_autor, 'admin@ama.local');
  });

  test('envio: ação inválida → 400; sem Melhor Envio → 503', async () => {
    aplicarAmbiente(SUPABASE);
    fetchSimulado = supabaseFalso();
    const acao = await chamarHandler(envio, { method: 'POST', headers: comAdmin, body: { pedido_id: ID_PEDIDO, acao: 'x' } });
    assert.equal(acao.statusCode, 400);
    assert.equal(acao.json().erro, 'acao_invalida');
    const semMe = await chamarHandler(envio, { method: 'POST', headers: comAdmin, body: { pedido_id: ID_PEDIDO, acao: 'rastrear' } });
    assert.equal(semMe.statusCode, 503);
    assert.equal(semMe.json().erro, 'frete_nao_configurado');
  });

  test('envio: chave da NF-e inválida → 400 antes de chamar o Melhor Envio; pedido de retirada → 409', async () => {
    aplicarAmbiente({ ...SUPABASE, MELHOR_ENVIO_TOKEN: 'token-me', MELHOR_ENVIO_API_BASE: ME });
    const pedido = {
      id: ID_PEDIDO, numero: 1001, status: 'pago', entrega: { tipo: 'melhor_envio', servico_id: 1, nome: 'PAC' },
      endereco: { cep: '66010000' }, me_ordens: [], pedido_itens: [],
    };
    let linha = pedido;
    fetchSimulado = supabaseFalso({ pedidos: () => respostaJson(200, [linha]), [ME]: () => respostaJson(500, {}) });
    const r = await chamarHandler(envio, {
      method: 'POST', headers: comAdmin, body: { pedido_id: ID_PEDIDO, acao: 'adicionar_carrinho', chave_nfe: '1234' },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().erro, 'chave_nfe_invalida');
    assert.equal(r.json().campo, 'chave_nfe');
    assert.equal(fetchSimulado.chamadas.filter((c) => c.url.startsWith(ME)).length, 0);

    linha = { ...pedido, entrega: { tipo: 'retirada' } };
    const retirada = await chamarHandler(envio, { method: 'POST', headers: comAdmin, body: { pedido_id: ID_PEDIDO, acao: 'rastrear' } });
    assert.equal(retirada.statusCode, 409);
    assert.equal(retirada.json().erro, 'envio_indisponivel');

    linha = { ...pedido, status: 'aguardando_pagamento' };
    const naoPago = await chamarHandler(envio, { method: 'POST', headers: comAdmin, body: { pedido_id: ID_PEDIDO, acao: 'rastrear' } });
    assert.equal(naoPago.statusCode, 409);
    assert.equal(naoPago.json().erro, 'status_nao_permite_envio');
  });

  test('pagamento: escolhe o aprovado mais recente, senão o mais recente', async () => {
    assert.equal(escolherPagamento([]), null);
    assert.equal(escolherPagamento(null), null);
    const lista = [{ id: 3, status: 'rejected' }, { id: 2, status: 'approved' }, { id: 1, status: 'approved' }];
    assert.equal(escolherPagamento(lista).id, 2);
    assert.equal(escolherPagamento([{ id: 9, status: 'pending' }, { id: 8, status: 'rejected' }]).id, 9);

    aplicarAmbiente(SUPABASE);
    fetchSimulado = supabaseFalso();
    const semMp = await chamarHandler(pagamentoRota, { method: 'POST', headers: comAdmin, body: { pedido_id: ID_PEDIDO } });
    assert.equal(semMp.statusCode, 503);
  });
});
