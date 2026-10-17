// Checkout Transparente ponta a ponta (Playwright + Supabase local + Mercado Pago falso + MercadoPago.js falso):
// a cliente compra, cai na página do pedido e paga ali mesmo com Pix (QR e copia e cola; a página vê o
// pagamento sozinha), cartão (recusado e depois aprovado, parcelas limitadas pelo painel) e boleto.
//
// Uso: npm run test:e2e (exige "supabase start" com a migração e o seed). Com CAPTURAS_DIR=<pasta>, salva
// as telas da seção de pagamento (computador e celular) para conferir o visual.
// Cria o próprio produto e pedidos (sufixo aleatório) e apaga tudo no after().

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { AMBIENTE_VAZIO, subirServidor } from '../apoio/servidor.js';
import { ambienteLocal, clienteServico } from '../apoio/supabase-local.js';
import { iniciar as iniciarMercadoPago } from '../apoio/mercadopago-falso.js';
import { SCRIPT_SDK, URL_SDK } from '../apoio/mercadopago-js-falso.js';

const SUF = randomBytes(4).toString('hex');
const CLIENTE = {
  nome: 'Joana Transparente', email: `cliente-ct-${SUF}@exemplo.com.br`, telefone: '91981056049', cpf: '52998224725',
};
const PRODUTO = { nome: `Óleo CT ${SUF}`, slug: `oleo-ct-${SUF}`, preco_centavos: 5000, estoque: 20 };
const CEP = '66010000';
const VIACEP = {
  cep: '66010-000', logradouro: 'Avenida Presidente Vargas', complemento: '', bairro: 'Campina', localidade: 'Belém', uf: 'PA',
};
const PUBLIC_KEY = 'TEST-1a2b3c4d-1111-4222-8333-123456789abc';
const CAPTURAS = process.env.CAPTURAS_DIR || '';

let servico;
let mp;
let servidor;
let base;
let navegador;
let loja;
let checkoutAntes;
let freteAntes;
const errosNaPagina = [];

async function semErro(promessa, rotulo) {
  const { data, error } = await promessa;
  if (error) throw new Error(`${rotulo}: ${error.message}`);
  return data;
}

function proxyDoAmbiente() {
  const servidorProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!servidorProxy) return undefined;
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  return { server: servidorProxy, bypass: '127.0.0.1,localhost' };
}

async function novoContexto(opcoes = {}) {
  const contexto = await navegador.newContext({
    viewport: { width: 1280, height: 900 }, locale: 'pt-BR', timezoneId: 'America/Belem', ...opcoes,
  });
  await contexto.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (rota) => rota.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await contexto.route(URL_SDK, (rota) => rota.fulfill({ status: 200, contentType: 'application/javascript', body: SCRIPT_SDK }));
  await contexto.route(/^https:\/\/viacep\.com\.br\//, (rota) => rota.fulfill({
    status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(VIACEP),
  }));
  contexto.on('page', (pagina) => { pagina.on('pageerror', (e) => errosNaPagina.push(e.message)); });
  return contexto;
}

async function capturar(pagina, nome) {
  if (!CAPTURAS) return;
  mkdirSync(CAPTURAS, { recursive: true });
  await pagina.locator('#pagamento').screenshot({ path: path.join(CAPTURAS, `${nome}.png`) });
}

/** Põe o produto no carrinho, preenche o checkout e chega à página do pedido. Devolve o id do pedido. */
async function comprar(pagina) {
  await pagina.goto(`${base}/loja/produto?slug=${PRODUTO.slug}`);
  await pagina.getByRole('button', { name: 'Adicionar ao carrinho', exact: true }).click();
  await pagina.waitForSelector('.toast--sucesso');
  await pagina.goto(`${base}/loja/checkout`);
  await pagina.waitForSelector('#form-checkout:not([hidden])');
  await pagina.fill('#nome', CLIENTE.nome);
  await pagina.fill('#email', CLIENTE.email);
  await pagina.fill('#telefone', CLIENTE.telefone);
  await pagina.fill('#cpf', CLIENTE.cpf);
  await pagina.fill('#cep', CEP);
  await pagina.waitForFunction(() => document.getElementById('logradouro').value === 'Avenida Presidente Vargas');
  await pagina.locator('.opcao-frete', { has: pagina.locator('input[value="fixo-1"]') }).click();
  await pagina.fill('#numero', '45');
  await pagina.waitForSelector('.totais:not(.totais--atualizando)');
  await Promise.all([
    pagina.waitForURL(/\/loja\/pedido\?id=.*#pagamento$/, { timeout: 30_000 }),
    pagina.locator('#botao-pagar').click(),
  ]);
  await pagina.waitForSelector('#pagamento .pagamento-metodo');
  return new URL(pagina.url()).searchParams.get('id');
}

const pedidoDoBanco = (id) => semErro(servico.from('pedidos').select('*').eq('id', id).single(), 'ler pedido');

async function esperarSelo(pagina, texto) {
  await pagina.waitForFunction((t) => document.querySelector('.pedido-selo-status')?.textContent.trim() === t, texto, { timeout: 20_000 });
}

before(async () => {
  const local = ambienteLocal();
  assert.ok(local.serviceKey, 'Chave de serviço do Supabase local não encontrada (rode "supabase start").');
  servico = clienteServico();
  await semErro(servico.from('produtos').insert({ ...PRODUTO, ativo: true, imagens: [] }), 'criar produto');
  const linha = await semErro(servico.from('configuracoes').select('valor').eq('chave', 'checkout').maybeSingle(), 'ler checkout');
  checkoutAntes = linha ? linha.valor : null;
  await semErro(servico.from('configuracoes').update({ valor: { parcelas_max: 6, aceitar_boleto: true, expiracao_horas: 72 } }).eq('chave', 'checkout'), 'checkout');
  // Entrega fixa ligada (sem Melhor Envio aqui): "fixo-1" atende o PA.
  const frete = await semErro(servico.from('configuracoes').select('valor').eq('chave', 'frete').single(), 'ler frete');
  freteAntes = frete.valor;
  const fixo = { ativo: true, opcoes: [{ id: 'fixo-1', nome: 'Entrega local', preco_centavos: 1500, prazo_dias: 3, ufs: ['PA'] }] };
  await semErro(servico.from('configuracoes').update({ valor: { ...frete.valor, fixo } }).eq('chave', 'frete'), 'frete');

  mp = await iniciarMercadoPago({ segredo: 'segredo-teste' });
  servidor = await subirServidor({
    ...AMBIENTE_VAZIO,
    SUPABASE_URL: local.url,
    SUPABASE_ANON_KEY: local.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: local.serviceKey,
    MP_ACCESS_TOKEN: 'APP_USR-teste-ct',
    MP_PUBLIC_KEY: PUBLIC_KEY,
    MP_API_BASE: mp.url,
    MP_WEBHOOK_SECRET: 'segredo-teste',
  });
  base = servidor.url;
  mp.estado.webhookUrl = `${base}/api/webhooks/mercadopago`;
  navegador = await chromium.launch({ proxy: proxyDoAmbiente() });
  loja = await (await novoContexto()).newPage();
});

after(async () => {
  if (navegador) await navegador.close();
  if (servidor) await servidor.fechar();
  if (mp) await mp.fechar();
  if (!servico) return;
  await servico.from('pedidos').delete().eq('cliente_email', CLIENTE.email);
  await servico.from('produtos').delete().eq('slug', PRODUTO.slug);
  if (checkoutAntes) await servico.from('configuracoes').update({ valor: checkoutAntes }).eq('chave', 'checkout');
  if (freteAntes) await servico.from('configuracoes').update({ valor: freteAntes }).eq('chave', 'frete');
});

describe('Checkout Transparente na loja', { concurrency: false }, () => {
  test('Pix: QR e copia e cola; a página vê o pagamento sozinha', async () => {
    const id = await comprar(loja);
    const metodos = await loja.locator('.pagamento-metodo').allInnerTexts();
    assert.deepEqual(metodos.map((m) => m.trim()), ['Pix', 'Cartão', 'Boleto']);
    assert.equal((await loja.textContent('.pedido-selo-status')).trim(), 'Aguardando pagamento');
    await capturar(loja, '1-pix-gerar');

    await loja.getByRole('button', { name: /com Pix/ }).click();
    await loja.waitForSelector('.pix-qr');
    const codigo = await loja.inputValue('#pix-copia-e-cola');
    assert.match(codigo, /^000201/);
    assert.match(await loja.getAttribute('.pix-qr', 'src'), /^data:image\/png;base64,/);
    assert.equal((await loja.textContent('.pedido-selo-status')).trim(), 'Aguardando pagamento', 'Pix gerado não é "em análise" para a cliente');
    await capturar(loja, '2-pix-qr');

    const pedido = await pedidoDoBanco(id);
    assert.equal(pedido.metodo_pagamento, 'bank_transfer');
    await mp.estado.aprovarPagamento(pedido.mp_payment_id);
    await esperarSelo(loja, 'Pago');
    assert.equal(await loja.locator('#pagamento').count(), 0, 'pago: a seção de pagamento some');
    assert.deepEqual(await loja.evaluate(() => JSON.parse(localStorage.getItem('ama_carrinho_v1') || '[]')), [], 'o carrinho foi esvaziado');
  });

  test('cartão: recusado mostra o motivo; aprovado paga; parcelas até o máximo do painel', async () => {
    const id = await comprar(loja);
    await loja.locator('.pagamento-metodo', { hasText: 'Cartão' }).click();
    await loja.waitForSelector('#mp-numero input');
    const parcelas = await loja.locator('#mp-parcelas option').count();
    assert.equal(parcelas, 6, 'parcelas_max do painel');
    assert.equal(await loja.evaluate(() => window.__mpFalso.chave), PUBLIC_KEY);

    await loja.getByRole('button', { name: /^Pagar R\$/ }).click();
    await loja.waitForSelector('.pagamento-erro:not([hidden])');
    assert.match(await loja.textContent('.pagamento-erro'), /número do cartão/);

    await loja.fill('#mp-numero input', '5031 4332 1540 6351');
    await loja.fill('#mp-validade input', '11/30');
    await loja.fill('#mp-cvv input', '123');
    await loja.fill('#mp-titular', 'FUND');
    await loja.fill('#mp-documento', '123.456.789-09');
    assert.equal(await loja.inputValue('#mp-documento'), '12345678909', 'só dígitos');
    await loja.selectOption('#mp-parcelas', '3');
    await loja.locator('.pagamento-metodo', { hasText: 'Pix' }).click();
    await loja.locator('.pagamento-metodo', { hasText: 'Cartão' }).click();
    assert.equal(await loja.inputValue('#mp-numero input'), '5031 4332 1540 6351', 'trocar de aba não refaz o formulário do cartão');
    assert.equal(await loja.locator('#mp-form-cartao').count(), 1);
    await capturar(loja, '3-cartao');
    await loja.getByRole('button', { name: /^Pagar R\$/ }).click();
    await loja.waitForFunction(() => /limite/.test(document.querySelector('.pagamento-erro')?.textContent || ''), null, { timeout: 20_000 });
    await capturar(loja, '4-cartao-recusado');
    assert.equal((await pedidoDoBanco(id)).status, 'aguardando_pagamento');

    await loja.fill('#mp-titular', 'APRO');
    await loja.getByRole('button', { name: /^Pagar R\$/ }).click();
    await esperarSelo(loja, 'Pago');
    const pedido = await pedidoDoBanco(id);
    assert.equal(pedido.status, 'pago');
    assert.equal(mp.estado.pagamentos.get(pedido.mp_payment_id).corpo.installments, 3);
    assert.equal(mp.estado.pagamentos.get(pedido.mp_payment_id).cabecalhos['x-meli-session-id'], 'armor.falso0123456789');
  });

  test('boleto: link e linha digitável; continua lá ao voltar à página', async () => {
    const id = await comprar(loja);
    await loja.locator('.pagamento-metodo', { hasText: 'Boleto' }).click();
    await loja.getByRole('button', { name: /Gerar boleto/ }).click();
    await loja.waitForSelector('.boleto a.botao');
    assert.match(await loja.getAttribute('.boleto a.botao', 'href'), /\/boleto\/\d+$/);
    assert.ok(await loja.inputValue('#boleto-linha'));
    await capturar(loja, '5-boleto');

    await loja.reload();
    await loja.waitForSelector('.boleto a.botao');
    assert.equal(await loja.locator('.pagamento-metodo input[value="boleto"]').isChecked(), true);
    assert.equal((await pedidoDoBanco(id)).metodo_pagamento, 'ticket');
  });

  test('celular: seção de pagamento sem rolagem horizontal', async () => {
    const contexto = await novoContexto({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const celular = await contexto.newPage();
    await comprar(celular);
    await celular.getByRole('button', { name: /com Pix/ }).click();
    await celular.waitForSelector('.pix-qr');
    const largura = await celular.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(largura <= 390, `rolagem horizontal: ${largura}px`);
    await capturar(celular, '6-celular-pix');
    await celular.locator('.pagamento-metodo', { hasText: 'Cartão' }).click();
    await celular.waitForSelector('#mp-numero input');
    assert.ok(await celular.evaluate(() => document.documentElement.scrollWidth) <= 390);
    await capturar(celular, '7-celular-cartao');
    await contexto.close();
  });

  test('sem erros de JavaScript nas páginas', () => {
    assert.deepEqual(errosNaPagina, []);
  });
});
