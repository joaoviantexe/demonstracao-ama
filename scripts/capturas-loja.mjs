#!/usr/bin/env node
// Capturas da loja com o Playwright: percorre a compra inteira e fotografa cada página.
//
// Uso: node scripts/capturas-loja.mjs [--saida <pasta>] [--larguras 390,768,1440]
//                                    [--fluxos compra,apresentacao,estados]
//      (padrão da saída: <tmp do sistema>/capturas-loja)
//
// - Sobe o dev-server com o Supabase local (tests/apoio/supabase-local.js), o Mercado Pago falso
//   (webhook assinado com MP_WEBHOOK_SECRET=segredo-teste para o próprio dev-server) e o Melhor Envio falso.
// - ViaCEP é interceptado com uma resposta falsa; as fontes do Google são buscadas pelo Node
//   (com proxy, rode com NODE_USE_ENV_PROXY=1); sem acesso, as páginas usam as fontes de reserva.
// - Fluxo: catálogo → produto → adicionar → carrinho (CEP 66010-000, PAC) →
//   checkout preenchido → Mercado Pago falso (Aprovar) → pedido "Pago" → meus pedidos.
//   Também: carrinho vazio, produto sem preço, o catálogo no "modo apresentação" (todos os preços 0),
//   carrinho com itens indisponíveis e produto inexistente.
// - Cada página é capturada em 390, 768 e 1440 px. O script falha (código 1) se houver erro no console
//   das páginas da loja ou conteúdo saindo da tela na horizontal.
// - No fim, apaga os pedidos criados (devolvendo o estoque que o pagamento consumiu).

import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { iniciarServidor } from './dev-server.mjs';
import { ambienteLocal, sql, sqlJson } from '../tests/apoio/supabase-local.js';
import { iniciar as iniciarMercadoPago } from '../tests/apoio/mercadopago-falso.js';
import { iniciar as iniciarMelhorEnvio } from '../tests/apoio/melhorenvio-falso.js';

const RAIZ = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function argumento(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const SAIDA = path.resolve(argumento('saida', path.join(os.tmpdir(), 'capturas-loja')));
const LARGURAS = argumento('larguras', '390,768,1440').split(',').map(Number).filter(Boolean);
const ALTURAS = { 390: 844, 768: 1024, 1440: 900 };
const FLUXOS = argumento('fluxos', 'compra,apresentacao,estados').split(',');
const SUFIXO = randomBytes(4).toString('hex');
const EMAIL = `capturas.${SUFIXO}@exemplo.com.br`;

// Endereço falso devolvido pelo ViaCEP interceptado.
const CEPS = {
  66010000: { cep: '66010-000', logradouro: 'Avenida Presidente Vargas', complemento: '', bairro: 'Campina', localidade: 'Belém', uf: 'PA' },
};

const CSS_ESTAVEL = `
  *,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}
  html{scroll-behavior:auto!important}
`;

const problemas = [];
const capturas = [];

function registrarProblema(texto) {
  problemas.push(texto);
  console.error(`  ✗ ${texto}`);
}

// ---------------------------------------------------------------------------
// Navegador

async function prepararContexto(navegador, base, { modoApresentacao = false } = {}) {
  const contexto = await navegador.newContext({ viewport: { width: 1440, height: 900 }, locale: 'pt-BR' });

  // Fontes do Google pelo Node (o Chromium daqui não confia no proxy); sem acesso, CSS vazio.
  const cacheFontes = new Map();
  await contexto.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (rota) => {
    const url = rota.request().url();
    try {
      if (!cacheFontes.has(url)) {
        const resposta = await fetch(url, { headers: { 'user-agent': rota.request().headers()['user-agent'] || 'Mozilla/5.0' } });
        cacheFontes.set(url, {
          status: resposta.status,
          contentType: resposta.headers.get('content-type') || 'text/css',
          body: Buffer.from(await resposta.arrayBuffer()),
        });
      }
      const fonte = cacheFontes.get(url);
      await rota.fulfill({ status: fonte.status, contentType: fonte.contentType, body: fonte.body, headers: { 'access-control-allow-origin': '*' } });
    } catch {
      await rota.fulfill({ status: 200, contentType: 'text/css', body: '' });
    }
  });

  // ViaCEP falso.
  await contexto.route(/^https:\/\/viacep\.com\.br\/ws\/(\d{8})\/json\/?$/, async (rota) => {
    const cep = rota.request().url().match(/ws\/(\d{8})\//)[1];
    await rota.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(CEPS[cep] || { erro: 'true' }),
    });
  });

  // Modo apresentação: a vitrine com todos os produtos sem preço ("R$ 00,00").
  if (modoApresentacao) {
    await contexto.route(/\/rest\/v1\/produtos\?/, async (rota) => {
      const resposta = await rota.fetch();
      const produtos = await resposta.json();
      const zerados = Array.isArray(produtos)
        ? produtos.map((p) => ({ ...p, preco_centavos: 0, preco_promocional_centavos: null }))
        : produtos;
      await rota.fulfill({ response: resposta, json: zerados });
    });
  }

  const pagina = await contexto.newPage();
  pagina.on('console', (mensagem) => {
    if (mensagem.type() !== 'error' || !pagina.url().startsWith(base)) return;
    registrarProblema(`console (${new URL(pagina.url()).pathname}): ${mensagem.text()}`);
  });
  pagina.on('pageerror', (erro) => registrarProblema(`erro de JavaScript (${pagina.url()}): ${erro.message}`));
  return { contexto, pagina };
}

/** Carrega todas as imagens (as "lazy" também) antes da foto. */
async function carregarImagens(pagina) {
  await pagina.evaluate(async () => {
    const imagens = Array.from(document.images);
    for (const img of imagens) img.loading = 'eager';
    await Promise.all(imagens.map((img) => (img.complete ? null : new Promise((r) => {
      img.addEventListener('load', r, { once: true });
      img.addEventListener('error', r, { once: true });
      setTimeout(r, 5000);
    }))));
    await Promise.all(imagens.map((img) => (img.decode ? img.decode().catch(() => {}) : null)));
    await document.fonts.ready;
  });
  await pagina.waitForTimeout(120);
}

/** Conteúdo saindo da tela na horizontal (fora de contêineres roláveis/recortados). */
async function verificarLayout(pagina, rotulo) {
  const encontrados = await pagina.evaluate(() => {
    const largura = document.documentElement.clientWidth;
    const saida = [];
    if (document.documentElement.scrollWidth > largura + 1) saida.push(`scrollWidth ${document.documentElement.scrollWidth} > ${largura}`);
    const dentroDeRecorte = (el) => {
      for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== 'visible') return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('#menu-mobile, .toasts, script, style, noscript, .sr-only')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if ((r.right > largura + 1 || r.left < -1) && !dentroDeRecorte(el)) {
        const classes = el.classList.length ? `.${[...el.classList].join('.')}` : '';
        saida.push(`${el.tagName.toLowerCase()}${classes} (${Math.round(r.left)} → ${Math.round(r.right)})`);
      }
    }
    return saida.slice(0, 8);
  });
  for (const item of encontrados) registrarProblema(`rolagem horizontal em ${rotulo}: ${item}`);
}

/** Fotografa a página atual em todas as larguras (página inteira). */
async function capturar(pagina, nome) {
  await pagina.addStyleTag({ content: CSS_ESTAVEL });
  for (const largura of LARGURAS) {
    await pagina.setViewportSize({ width: largura, height: ALTURAS[largura] || 900 });
    await pagina.evaluate(() => window.scrollTo(0, 0));
    await carregarImagens(pagina);
    await verificarLayout(pagina, `${nome} @ ${largura}px`);
    const arquivo = path.join(SAIDA, `${nome}-${largura}.png`);
    await pagina.screenshot({ path: arquivo, fullPage: true });
    capturas.push(arquivo);
  }
  await pagina.setViewportSize({ width: 1440, height: 900 });
  console.log(`  ✓ ${nome}`);
}

/** Espera a cotação do carrinho/checkout terminar. */
async function esperarTotais(pagina) {
  await pagina.waitForSelector('.totais:not(.totais--atualizando)', { timeout: 20000 });
  await pagina.waitForTimeout(250);
}

// ---------------------------------------------------------------------------
// Fluxo

async function fluxoCompra(navegador, base) {
  const { contexto, pagina } = await prepararContexto(navegador, base);
  try {
    // Carrinho vazio
    await pagina.goto(`${base}/loja/carrinho`);
    await pagina.waitForSelector('.estado');
    await capturar(pagina, '01-carrinho-vazio');

    // Catálogo
    await pagina.goto(`${base}/loja/`);
    await pagina.waitForSelector('.cartao-produto:not(.cartao-produto--esqueleto)');
    await capturar(pagina, '02-catalogo');

    // Adiciona o creme em promoção pelo cartão da vitrine
    await pagina.locator('.cartao-produto', { hasText: 'Creme Hidratante Cupuaçu' }).getByRole('button', { name: /Adicionar ao carrinho/ }).click();
    await pagina.waitForSelector('.toast--sucesso');

    // Filtro por categoria e busca (só confere que funcionam)
    await pagina.getByRole('button', { name: /Biojoias/ }).click();
    await pagina.waitForFunction(() => location.search.includes('categoria=biojoias'));
    await pagina.getByRole('button', { name: /^Todos/ }).click();

    // Produto
    await pagina.locator('.cartao-produto-link', { hasText: 'Body Splash Raiz' }).click();
    await pagina.waitForSelector('.ficha-nome');
    await capturar(pagina, '03-produto');
    await pagina.getByRole('button', { name: 'Aumentar quantidade', exact: true }).click();
    await pagina.getByRole('button', { name: 'Adicionar ao carrinho', exact: true }).click();
    await pagina.waitForSelector('.toast--sucesso');
    // Frete na página do produto
    await pagina.fill('#frete-cep', '66010-000');
    await pagina.getByRole('button', { name: 'Calcular' }).click();
    await pagina.waitForSelector('.frete-opcao-linha');

    // Produto sem preço (biojoia): aparece como os demais, com "R$ 00,00"
    await pagina.goto(`${base}/loja/produto?slug=biojoia-01`);
    await pagina.waitForSelector('.ficha-nome');
    await capturar(pagina, '04-produto-sem-preco');

    // Carrinho: CEP e PAC
    await pagina.goto(`${base}/loja/carrinho`);
    await esperarTotais(pagina);
    await pagina.fill('#carrinho-cep', '66010000');
    await pagina.getByRole('button', { name: 'Calcular' }).click();
    await pagina.waitForSelector('.opcao-frete input[value="me-1"]');
    await esperarTotais(pagina);
    await pagina.locator('.opcao-frete', { has: pagina.locator('input[value="me-1"]') }).click();
    await esperarTotais(pagina);
    await capturar(pagina, '05-carrinho');

    // Checkout
    await pagina.getByRole('link', { name: 'Finalizar compra' }).click();
    await pagina.waitForSelector('#form-checkout:not([hidden])');
    await esperarTotais(pagina);
    await pagina.fill('#nome', 'Maria Teste da Silva');
    await pagina.fill('#email', EMAIL);
    await pagina.fill('#telefone', '91981056049');
    await pagina.fill('#cpf', '52998224725');
    await pagina.fill('#observacoes', 'É para presente: se possível, embalar com carinho.');
    // Entrega pelos Correios para mostrar o endereço preenchido pelo ViaCEP
    if (await pagina.locator('.opcao-frete input[value="retirada"]').count()) registrarProblema('o checkout ainda oferece a retirada na sede');
    await pagina.locator('.opcao-frete', { has: pagina.locator('input[value="me-1"]') }).click();
    await pagina.waitForFunction(() => document.getElementById('logradouro').value === 'Avenida Presidente Vargas');
    await pagina.fill('#numero', '123');
    await pagina.fill('#complemento', 'Apto 401');
    await esperarTotais(pagina);
    await capturar(pagina, '06-checkout-entrega');
    // Troca para o SEDEX (o fluxo pedido): o total acompanha o frete escolhido
    await pagina.locator('.opcao-frete', { has: pagina.locator('input[value="me-2"]') }).click();
    await esperarTotais(pagina);
    await capturar(pagina, '07-checkout-sedex');

    // Pagamento no Mercado Pago falso
    await Promise.all([
      pagina.waitForURL(/\/pagar\//, { timeout: 30000 }),
      pagina.locator('#botao-pagar').click(),
    ]);
    await Promise.all([
      pagina.waitForURL(/\/loja\/pedido\?/, { timeout: 30000 }),
      pagina.getByRole('button', { name: 'Aprovar' }).click(),
    ]);
    await pagina.waitForSelector('.pedido-selo-status');
    const status = (await pagina.textContent('.pedido-selo-status')).trim();
    if (status !== 'Pago') registrarProblema(`o pedido deveria estar "Pago", mas está "${status}"`);
    const contador = await pagina.locator('.topo-carrinho-contador').isHidden();
    if (!contador) registrarProblema('o carrinho não foi limpo depois do pagamento aprovado');
    await capturar(pagina, '08-pedido-pago');

    // Meus pedidos neste aparelho
    await pagina.goto(`${base}/loja/pedido`);
    await pagina.waitForSelector('.meu-pedido');
    await capturar(pagina, '09-meus-pedidos');

    // Menu do celular
    await pagina.setViewportSize({ width: 390, height: 844 });
    await pagina.click('[data-abrir-menu]');
    await pagina.waitForTimeout(200);
    const arquivo = path.join(SAIDA, '10-menu-celular-390.png');
    await pagina.screenshot({ path: arquivo });
    capturas.push(arquivo);
    console.log('  ✓ 10-menu-celular');
  } finally {
    await contexto.close();
  }
}

// Carrinho com itens que o servidor recusa (estoque insuficiente, sem preço, produto removido)
// e a página de produto inexistente.
async function fluxoEstados(navegador, base, produtos) {
  const { contexto, pagina } = await prepararContexto(navegador, base);
  try {
    const linha = (slug, quantidade) => {
      const p = produtos.find((x) => x.slug === slug);
      return { produto_id: p.id, quantidade, nome: p.nome, preco_centavos: p.preco_centavos, imagem: p.imagens[0] ? p.imagens[0].src : '', slug };
    };
    const itens = [
      linha('body-splash-raiz', 20),
      linha('biojoia-01', 1),
      { produto_id: '00000000-0000-4000-8000-000000000999', quantidade: 1, nome: 'Produto que saiu da loja', preco_centavos: 1000, imagem: '', slug: 'antigo' },
      linha('creme-hidratante-cupuacu', 1),
    ];
    await contexto.addInitScript((carrinho) => {
      if (!sessionStorage.getItem('capturas-iniciado')) {
        localStorage.setItem('ama_carrinho_v1', JSON.stringify(carrinho));
        sessionStorage.setItem('capturas-iniciado', '1');
      }
    }, itens);
    await pagina.goto(`${base}/loja/carrinho`);
    await pagina.waitForSelector('.carrinho-item--indisponivel');
    await esperarTotais(pagina);
    const bloqueado = await pagina.locator('.resumo-finalizar').getAttribute('aria-disabled');
    if (bloqueado !== 'true') registrarProblema('"Finalizar compra" deveria ficar bloqueado com itens indisponíveis');
    await capturar(pagina, '13-carrinho-indisponiveis');
    await pagina.getByRole('button', { name: /^Ajustar para \d+$/ }).click();
    await pagina.waitForFunction(() => document.querySelectorAll('.carrinho-item--indisponivel').length === 2);

    await pagina.goto(`${base}/loja/produto?slug=produto-que-nao-existe`);
    await pagina.waitForSelector('.estado');
    await capturar(pagina, '14-produto-inexistente');
  } finally {
    await contexto.close();
  }
}

async function fluxoApresentacao(navegador, base) {
  const { contexto, pagina } = await prepararContexto(navegador, base, { modoApresentacao: true });
  try {
    await pagina.goto(`${base}/loja/`);
    await pagina.waitForSelector('.cartao-produto:not(.cartao-produto--esqueleto)');
    const precos = await pagina.locator('.cartao-produto .preco-atual').allTextContents();
    if (!precos.length || precos.some((p) => p.trim() !== 'R$ 00,00')) {
      registrarProblema(`modo apresentação: preços diferentes de "R$ 00,00": ${[...new Set(precos)].join(', ')}`);
    }
    // Versão final: produto sem preço aparece como os demais (sem selo "Em breve" e com o botão de compra).
    const cartoes = await pagina.locator('.cartao-produto').count();
    const botoesCompra = await pagina.locator('.cartao-produto button:not([disabled])').count();
    if (botoesCompra !== cartoes) registrarProblema(`modo apresentação: ${cartoes - botoesCompra} cartão(ões) sem botão de compra ativo`);
    const selos = await pagina.locator('.cartao-produto .selo').allTextContents();
    if (selos.some((t) => /em breve|esgotado/i.test(t))) registrarProblema(`modo apresentação: selos indevidos: ${selos.join(', ')}`);
    await capturar(pagina, '11-catalogo-apresentacao');
    await pagina.goto(`${base}/loja/produto?slug=body-splash-raiz`);
    await pagina.waitForSelector('.ficha-nome');
    await capturar(pagina, '12-produto-apresentacao');
  } finally {
    await contexto.close();
  }
}

// ---------------------------------------------------------------------------
// Limpeza

async function limparPedidos() {
  const ids = await sqlJson(`select coalesce(json_agg(id), '[]'::json) from public.pedidos where cliente_email = '${EMAIL}'`);
  if (!ids || !ids.length) return 0;
  await sql(`
    begin;
    update public.produtos p set estoque = p.estoque + x.qtd
      from (select i.produto_id, sum(i.quantidade) as qtd
              from public.pedido_itens i join public.pedidos d on d.id = i.pedido_id
             where d.cliente_email = '${EMAIL}' and d.estoque_baixado and i.produto_id is not null
             group by i.produto_id) x
     where p.id = x.produto_id and p.controlar_estoque;
    delete from public.pedidos where cliente_email = '${EMAIL}';
    commit;`);
  return ids.length;
}

// ---------------------------------------------------------------------------

async function principal() {
  process.chdir(RAIZ);
  mkdirSync(SAIDA, { recursive: true });
  const supabase = ambienteLocal();
  const mp = await iniciarMercadoPago({ segredo: 'segredo-teste' });
  const me = await iniciarMelhorEnvio();

  const ambiente = {
    SUPABASE_URL: supabase.url,
    SUPABASE_ANON_KEY: supabase.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: supabase.serviceKey,
    MP_ACCESS_TOKEN: 'TEST-capturas-loja',
    MP_API_BASE: mp.url,
    MP_WEBHOOK_SECRET: 'segredo-teste',
    MELHOR_ENVIO_TOKEN: 'token-capturas',
    MELHOR_ENVIO_API_BASE: me.url,
    MELHOR_ENVIO_AMBIENTE: 'sandbox',
    MELHOR_ENVIO_EMAIL: 'tecnico@ama.local',
  };
  for (const nome of ['SITE_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'RESEND_API_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY']) delete process.env[nome];
  Object.assign(process.env, ambiente);

  const servidor = await iniciarServidor({ porta: 0, host: '127.0.0.1' });
  mp.estado.webhookUrl = `${servidor.url}/api/webhooks/mercadopago`;
  const navegador = await chromium.launch();
  console.log(`Capturas da loja em ${SAIDA}`);
  try {
    if (FLUXOS.includes('compra')) await fluxoCompra(navegador, servidor.url);
    if (FLUXOS.includes('apresentacao')) await fluxoApresentacao(navegador, servidor.url);
    if (FLUXOS.includes('estados')) {
      const produtos = await (await fetch(`${supabase.url}/rest/v1/produtos?select=id,slug,nome,preco_centavos,imagens&ativo=eq.true`, {
        headers: { apikey: supabase.anonKey },
      })).json();
      await fluxoEstados(navegador, servidor.url, produtos);
    }
  } catch (erro) {
    registrarProblema(`o fluxo parou: ${erro.message.split('\n').slice(0, 14).join('\n')}`);
  } finally {
    await navegador.close();
    await servidor.fechar();
    await mp.fechar();
    await me.fechar();
    try {
      const removidos = await limparPedidos();
      console.log(`Pedidos de teste removidos: ${removidos}`);
    } catch (erro) {
      registrarProblema(`falha ao limpar os pedidos de teste (${EMAIL}): ${erro.message}`);
    }
  }

  console.log(`${capturas.length} capturas salvas.`);
  if (problemas.length) {
    console.error(`\n${problemas.length} problema(s) encontrado(s).`);
    process.exitCode = 1;
  }
}

await principal();
