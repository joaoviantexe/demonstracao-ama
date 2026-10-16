// Teste ponta a ponta (Playwright + Supabase local + Mercado Pago e Melhor Envio falsos), na ordem:
// admin edita o site → cliente compra → pagamento aprovado no Mercado Pago falso → estoque baixa →
// admin envia pelo Melhor Envio falso → cliente vê o rastreio.
//
// Uso: npm run test:e2e (exige "supabase start" com a migração e o seed; o Chromium vem de /opt/pw-browsers).
// Cria o próprio admin, produto e pedido (sufixo aleatório) e apaga tudo no after(); o título de
// "Quem somos" volta ao que era.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { AMBIENTE_VAZIO, subirServidor } from '../apoio/servidor.js';
import { ambienteLocal, clienteServico, criarUsuario, removerUsuario } from '../apoio/supabase-local.js';
import { iniciar as iniciarMercadoPago } from '../apoio/mercadopago-falso.js';
import { iniciar as iniciarMelhorEnvio } from '../apoio/melhorenvio-falso.js';
import { armazenamentoLocal } from '../../scripts/armazenamento-local.mjs';

const SUF = randomBytes(4).toString('hex');
const ADMIN = { email: `admin-e2e-${SUF}@teste.ama.local`, senha: `Senha-${SUF}-123` };
const CLIENTE = {
  nome: 'Maria Ponta a Ponta', email: `cliente-e2e-${SUF}@exemplo.com.br`, telefone: '91981056049', cpf: '52998224725',
};
const PRODUTO = { nome: `Sabonete E2E ${SUF}`, slug: `sabonete-e2e-${SUF}`, preco_centavos: 3990, estoque: 3 };
const CHAVE_TITULO = 'quem-somos.titulo';
const TITULO_NOVO = `Quem somos ${SUF}`;
const CEP = '66010000';
const VIACEP = {
  [CEP]: {
    cep: '66010-000', logradouro: 'Avenida Presidente Vargas', complemento: '', bairro: 'Campina', localidade: 'Belém', uf: 'PA',
  },
};
const URL_RASTREIO = 'https://rastreamento.correios.com.br/app/index.php';

let servico;
let mp;
let me;
let servidor;
let pastaMidia;
let base;
let navegador;
let admin;
let painel;
let loja;
let produtoId;
let pedidoId;
let urlDoPedido;
let tituloOriginal;
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

/** Contexto do navegador: fontes do Google sem rede viram CSS vazio; ViaCEP falso; erros guardados. */
async function novoContexto(rotulo) {
  const contexto = await navegador.newContext({ viewport: { width: 1280, height: 900 }, locale: 'pt-BR', timezoneId: 'America/Belem' });
  await contexto.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (rota) => rota.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await contexto.route(/^https:\/\/viacep\.com\.br\/ws\/(\d{8})\/json\/?$/, (rota) => {
    const cep = rota.request().url().match(/ws\/(\d{8})\//)[1];
    return rota.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(VIACEP[cep] || { erro: 'true' }),
    });
  });
  contexto.on('page', (pagina) => {
    pagina.on('pageerror', (e) => errosNaPagina.push(`[${rotulo}] ${e.message}`));
  });
  return contexto;
}

const pedidoDoBanco = () => semErro(servico.from('pedidos').select('*').eq('id', pedidoId).single(), 'ler pedido');

async function esperarToast(pagina, texto) {
  await pagina.locator('.toast', { hasText: texto }).first().waitFor({ timeout: 20_000 });
  await pagina.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
}

async function esperarTotais(pagina) {
  await pagina.waitForSelector('.totais:not(.totais--atualizando)', { timeout: 20_000 });
}

/** Espera o passo atual do assistente de envio ter este título. */
async function esperarEtapa(pagina, titulo) {
  await pagina.waitForFunction(
    (t) => (document.querySelector('.envio-etapa--atual .envio-etapa__titulo')?.textContent || '').includes(t),
    titulo, { timeout: 20_000 },
  );
}

before(async () => {
  const local = ambienteLocal();
  assert.ok(local.serviceKey, 'Chave de serviço do Supabase local não encontrada (rode "supabase start").');
  servico = clienteServico();
  const frete = await semErro(servico.from('configuracoes').select('valor').eq('chave', 'frete').maybeSingle(), 'ler frete');
  assert.ok(frete?.valor?.origem?.cep, 'A origem do frete está sem CEP (rode "supabase db reset" para aplicar o seed).');

  const linhaTitulo = await semErro(servico.from('conteudo_site').select('valor').eq('chave', CHAVE_TITULO).maybeSingle(), 'ler título');
  tituloOriginal = linhaTitulo ? linhaTitulo.valor : null;

  admin = await criarUsuario({ email: ADMIN.email, senha: ADMIN.senha, admin: true });
  const produto = await semErro(servico.from('produtos').insert({ ...PRODUTO, ativo: true, imagens: [] }).select('id').single(), 'criar produto');
  produtoId = produto.id;

  mp = await iniciarMercadoPago({ segredo: 'segredo-teste' });
  me = await iniciarMelhorEnvio();
  // Home publicada e fotos numa pasta temporária (o bucket R2 em produção).
  pastaMidia = mkdtempSync(path.join(tmpdir(), 'ama-e2e-midia-'));
  servidor = await subirServidor({
    ...AMBIENTE_VAZIO,
    SUPABASE_URL: local.url,
    SUPABASE_ANON_KEY: local.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: local.serviceKey,
    MP_ACCESS_TOKEN: 'APP_USR-teste-e2e',
    MP_API_BASE: mp.url,
    MP_WEBHOOK_SECRET: 'segredo-teste',
    MELHOR_ENVIO_TOKEN: 'token-melhor-envio-e2e',
    MELHOR_ENVIO_API_BASE: me.url,
    MELHOR_ENVIO_EMAIL: 'tecnico@ama.local',
  }, { armazenamento: armazenamentoLocal(pastaMidia) });
  base = servidor.url;
  mp.estado.webhookUrl = `${base}/api/webhooks/mercadopago`;

  navegador = await chromium.launch({ proxy: proxyDoAmbiente() });
  painel = await (await novoContexto('painel')).newPage();
  loja = await (await novoContexto('loja')).newPage();
});

after(async () => {
  if (navegador) await navegador.close();
  if (servidor) await servidor.fechar();
  if (pastaMidia) rmSync(pastaMidia, { recursive: true, force: true });
  if (mp) await mp.fechar();
  if (me) await me.fechar();
  if (!servico) return;
  await servico.from('pedidos').delete().eq('cliente_email', CLIENTE.email);
  await servico.from('produtos').delete().eq('slug', PRODUTO.slug);
  if (tituloOriginal === null) await servico.from('conteudo_site').delete().eq('chave', CHAVE_TITULO);
  else await servico.from('conteudo_site').upsert({ chave: CHAVE_TITULO, valor: tituloOriginal });
  if (admin) await removerUsuario(admin.id);
});

describe('fluxo completo da loja', { concurrency: false }, () => {
  test('admin edita o site', async () => {
    await painel.goto(`${base}/admin/#/conteudo/quem-somos`);
    await painel.fill('.acesso input[name="email"]', ADMIN.email);
    await painel.fill('.acesso input[name="senha"]', ADMIN.senha);
    await painel.getByRole('button', { name: 'Entrar', exact: true }).click();
    const campo = painel.locator(`[data-chave="${CHAVE_TITULO}"] input`);
    await campo.waitFor({ timeout: 20_000 });
    await campo.fill(TITULO_NOVO);
    await painel.locator('.cms-salvar').click();
    // "Salvo." só aparece depois de gravar no banco e publicar a home ("ainda não foi salvo" não conta).
    await painel.locator('.cms-barra__info', { hasText: /^Salvo\./ }).waitFor({ timeout: 20_000 });

    const linha = await semErro(servico.from('conteudo_site').select('valor').eq('chave', CHAVE_TITULO).single(), 'ler título salvo');
    assert.equal(linha.valor, TITULO_NOVO);
    // Ao salvar, o painel montou a home no navegador e publicou (o servidor só entrega o arquivo).
    const home = await loja.goto(`${base}/`);
    assert.equal(home.headers()['x-ama-cms'], 'publicado');
    assert.equal((await loja.locator('h2[data-cms="quem-somos.titulo"]').first().textContent()).trim(), TITULO_NOVO);
  });

  test('cliente compra', async () => {
    await loja.goto(`${base}/loja/produto?slug=${PRODUTO.slug}`);
    await loja.waitForSelector('.ficha-nome');
    assert.equal((await loja.textContent('.ficha-nome')).trim(), PRODUTO.nome);
    await loja.getByRole('button', { name: 'Aumentar quantidade', exact: true }).click();
    await loja.getByRole('button', { name: 'Adicionar ao carrinho', exact: true }).click();
    await loja.waitForSelector('.toast--sucesso');

    await loja.goto(`${base}/loja/carrinho`);
    await esperarTotais(loja);
    await loja.fill('#carrinho-cep', CEP);
    await loja.getByRole('button', { name: 'Calcular' }).click();
    await loja.waitForSelector('.opcao-frete input[value="me-1"]', { timeout: 20_000 });
    await loja.locator('.opcao-frete', { has: loja.locator('input[value="me-1"]') }).click();
    await esperarTotais(loja);

    await loja.getByRole('link', { name: 'Finalizar compra' }).click();
    await loja.waitForSelector('#form-checkout:not([hidden])');
    await esperarTotais(loja);
    await loja.fill('#nome', CLIENTE.nome);
    await loja.fill('#email', CLIENTE.email);
    await loja.fill('#telefone', CLIENTE.telefone);
    await loja.fill('#cpf', CLIENTE.cpf);
    assert.equal(await loja.locator('.opcao-frete input[value="retirada"]').count(), 0, 'o checkout não deve oferecer retirada');
    await loja.locator('.opcao-frete', { has: loja.locator('input[value="me-1"]') }).click();
    await loja.waitForFunction(() => document.getElementById('logradouro').value === 'Avenida Presidente Vargas');
    await loja.fill('#numero', '123');
    await esperarTotais(loja);
    assert.doesNotMatch(await loja.locator('main').innerText(), /Mercado Pago/i, 'o checkout não deve citar o Mercado Pago');

    await Promise.all([
      loja.waitForURL(/\/pagar\//, { timeout: 30_000 }),
      loja.locator('#botao-pagar').click(),
    ]);
    const pedido = await semErro(servico.from('pedidos').select('*').eq('cliente_email', CLIENTE.email).single(), 'ler pedido criado');
    pedidoId = pedido.id;
    const frete = pedido.frete_centavos;
    assert.equal(pedido.status, 'aguardando_pagamento');
    assert.equal(pedido.entrega.tipo, 'melhor_envio');
    assert.equal(pedido.subtotal_centavos, 2 * PRODUTO.preco_centavos);
    assert.equal(pedido.total_centavos, 2 * PRODUTO.preco_centavos + frete);
    const preferencia = mp.estado.ultimaPreferencia();
    assert.equal(preferencia.external_reference, pedidoId);
  });

  test('pagamento aprovado no Mercado Pago falso', async () => {
    await Promise.all([
      loja.waitForURL(/\/loja\/pedido\?/, { timeout: 30_000 }),
      loja.getByRole('button', { name: 'Aprovar' }).click(),
    ]);
    urlDoPedido = loja.url();
    await loja.waitForSelector('.pedido-selo-status');
    assert.equal((await loja.textContent('.pedido-selo-status')).trim(), 'Pago');
    const webhook = mp.estado.webhooks.at(-1);
    assert.equal(webhook.status, 200, `webhook respondeu ${webhook.status} ${webhook.resposta || webhook.erro || ''}`);
    const pedido = await pedidoDoBanco();
    assert.equal(pedido.status, 'pago');
    assert.ok(pedido.mp_payment_id, 'pedido sem o id do pagamento');
  });

  test('estoque baixa', async () => {
    const produto = await semErro(servico.from('produtos').select('estoque').eq('id', produtoId).single(), 'ler estoque');
    assert.equal(produto.estoque, PRODUTO.estoque - 2);
  });

  test('admin envia pelo Melhor Envio falso', async () => {
    await painel.goto(`${base}/admin/#/pedidos/${pedidoId}`);
    await painel.waitForSelector('.envio-etapa--atual', { timeout: 20_000 });

    await painel.getByRole('button', { name: 'Adicionar ao carrinho' }).click();
    await esperarToast(painel, 'carrinho do Melhor Envio');
    await esperarEtapa(painel, 'Pagar');
    await painel.getByRole('button', { name: 'Pagar etiqueta' }).click();
    await esperarToast(painel, 'paga');
    await esperarEtapa(painel, 'Gerar');
    await painel.getByRole('button', { name: 'Gerar etiqueta' }).click();
    await esperarToast(painel, 'Geração pedida');
    await esperarEtapa(painel, 'Imprimir');
    await painel.getByRole('button', { name: 'Preparar a impressão' }).click();
    await esperarToast(painel, 'Etiqueta pronta');
    await esperarEtapa(painel, 'Postar');
    await painel.getByRole('button', { name: 'Buscar rastreio' }).click();
    await esperarToast(painel, 'astreio');

    await painel.locator('.envio-etapa--atual').getByRole('button', { name: 'Marcar como enviado' }).click();
    const modal = painel.locator('dialog.modal--pedido-status[open]');
    await modal.waitFor();
    const codigo = modal.locator('input[name="codigo_rastreio"]');
    if (!(await codigo.inputValue())) await codigo.fill(`AA${SUF}BR`);
    await modal.locator('input[name="url_rastreio"]').fill(URL_RASTREIO);
    await modal.getByRole('button', { name: 'Salvar situação' }).click();
    await esperarToast(painel, 'Enviado');

    const pedido = await pedidoDoBanco();
    assert.equal(pedido.status, 'enviado');
    assert.ok(pedido.codigo_rastreio, 'pedido sem código de rastreio');
    assert.equal(pedido.url_rastreio, URL_RASTREIO);
    assert.ok(pedido.etiqueta_url, 'pedido sem o link da etiqueta');
    assert.ok(me.estado.compras.length >= 1, 'nenhuma etiqueta paga no Melhor Envio falso');
  });

  test('cliente vê o rastreio', async () => {
    const pedido = await pedidoDoBanco();
    await loja.goto(urlDoPedido);
    await loja.waitForSelector('.rastreio-codigos code', { timeout: 20_000 });
    const codigos = await loja.locator('.rastreio-codigos code').allTextContents();
    assert.deepEqual(codigos, pedido.codigo_rastreio.split(',').map((c) => c.trim()).filter(Boolean));
    assert.match(await loja.locator('main').innerText(), /A caminho/);
    assert.equal(await loja.locator(`.rastreio a[href="${URL_RASTREIO}"]`).count(), 1, 'link de rastreio não apareceu');
  });

  test('sem erros de JavaScript nas páginas', () => {
    assert.deepEqual(errosNaPagina, []);
  });
});
