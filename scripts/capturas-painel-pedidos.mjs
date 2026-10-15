#!/usr/bin/env node
// Capturas e verificação da página de pedidos do painel (Playwright + Supabase local + servidores falsos).
//
// Uso: node scripts/capturas-painel-pedidos.mjs [--saida <pasta>] [--larguras 390,1440]
//      (padrão da saída: <tmp>/capturas-painel-pedidos)
//
// Em cada largura, com dados próprios (sufixo aleatório; pedidos criados pelas RPCs do banco):
// - lista: busca por e-mail e por número, filtro "Para enviar" guardado na URL, linha que abre o detalhe;
// - pedido pago pelo Melhor Envio: próxima ação, nota interna (e apagar a nota), "Marcar como em
//   separação", o assistente de envio inteiro contra o Melhor Envio falso (carrinho → pagar → gerar →
//   imprimir → rastreio) e "Marcar como enviado" com código de rastreio; confere tudo no banco;
// - pedido aguardando pagamento (frete fixo): "Conferir pagamento" (nenhum pagamento no Mercado Pago falso)
//   e "Apagar pedido"; pedido pago não oferece "Apagar".
// Tudo o que foi criado é apagado no fim (e conferido). Falha (código 1) com erro no console/página,
// rolagem horizontal ou verificação errada.

import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { AMBIENTE_VAZIO, subirServidor } from '../tests/apoio/servidor.js';
import { ambienteLocal, clienteServico } from '../tests/apoio/supabase-local.js';
import { iniciar as iniciarMercadoPago } from '../tests/apoio/mercadopago-falso.js';
import { iniciar as iniciarMelhorEnvio } from '../tests/apoio/melhorenvio-falso.js';

function argumento(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const SAIDA = path.resolve(argumento('saida', path.join(os.tmpdir(), 'capturas-painel-pedidos')));
const LARGURAS = argumento('larguras', '390,1440').split(',').map(Number).filter(Boolean);
const ALTURAS = { 360: 760, 390: 844, 768: 1024, 1024: 800, 1440: 900 };
const ADMIN = { email: 'admin@ama.local', senha: 'admin123456' };

const problemas = [];
const falhar = (texto) => {
  problemas.push(texto);
  console.log(`  ✗ ${texto}`);
};
const ok = (texto) => console.log(`  ✓ ${texto}`);
const conferir = (condicao, sucesso, erro) => (condicao ? ok(sucesso) : falhar(erro));

// ---------------------------------------------------------------------------
// Navegador

function proxyDoAmbiente() {
  const servidor = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!servidor) return undefined;
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  return { server: servidor, bypass: '127.0.0.1,localhost' };
}

async function novaPagina(navegador, largura, rotulo) {
  const contexto = await navegador.newContext({
    viewport: { width: largura, height: ALTURAS[largura] || 900 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    locale: 'pt-BR',
    timezoneId: 'America/Belem',
    hasTouch: largura < 1024,
  });
  await contexto.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (rota) => {
    try {
      await rota.fulfill({ response: await rota.fetch() });
    } catch {
      await rota.abort().catch(() => {});
    }
  });
  const vigiar = (pagina) => {
    pagina.on('pageerror', (e) => falhar(`[${rotulo}] erro de página: ${e.message}`));
    pagina.on('console', (m) => {
      if (m.type() !== 'error') return;
      const origem = (m.location() && m.location().url) || '';
      if (/fonts\.(googleapis|gstatic)\.com/.test(origem)) return;
      falhar(`[${rotulo}] console: ${m.text()} ${origem}`);
    });
  };
  contexto.on('page', vigiar);
  const pagina = await contexto.newPage();
  return { contexto, pagina };
}

async function semRolagemHorizontal(pagina, onde) {
  const r = await pagina.evaluate(() => {
    const largos = [];
    for (const e of document.querySelectorAll('body *')) {
      const ret = e.getBoundingClientRect();
      if (!ret.width || ret.right <= window.innerWidth + 1) continue;
      if (e.closest('.menu-lateral,.abas,.tabela-container,dialog,.toasts') || getComputedStyle(e).position === 'fixed') continue;
      const classe = typeof e.className === 'string' ? e.className : (e.className && e.className.baseVal) || '';
      largos.push(`${e.tagName.toLowerCase()}.${classe.split(' ')[0]} (${Math.round(ret.right)}px)`);
    }
    const tabelas = [...document.querySelectorAll('.tabela-container')]
      .filter((t) => window.innerWidth < 720 && t.scrollWidth > t.clientWidth + 1).length;
    return { pagina: document.documentElement.scrollWidth - window.innerWidth, largos: largos.slice(0, 5), tabelas };
  });
  if (r.pagina > 0 || r.largos.length || r.tabelas) {
    falhar(`${onde}: rolagem horizontal (${r.pagina}px) ${r.largos.join(', ')}${r.tabelas ? ' tabela larga no celular' : ''}`);
  } else {
    ok(`${onde}: sem rolagem horizontal`);
  }
}

// Texto "null", "undefined" ou "NaN" na tela é sinal de dado ausente mal tratado.
async function semTextoQuebrado(pagina, onde) {
  const achados = await pagina.evaluate(() => {
    const texto = document.querySelector('.painel') ? document.querySelector('.painel').innerText : document.body.innerText;
    return [...new Set((texto.match(/\b(null|undefined|NaN)\b/g) || []))];
  });
  conferir(!achados.length, `${onde}: sem "null"/"undefined" na tela`, `${onde}: texto quebrado na tela (${achados.join(', ')})`);
}

let contadorCapturas = 0;
async function capturar(pagina, nome, { inteira = true } = {}) {
  await pagina.evaluate(() => document.fonts && document.fonts.ready);
  await pagina.evaluate(() => Promise.all([...document.querySelectorAll('img')].map((img) => {
    img.loading = 'eager';
    return img.decode().catch(() => {});
  })));
  await pagina.waitForTimeout(250);
  contadorCapturas += 1;
  const arquivo = path.join(SAIDA, `${String(contadorCapturas).padStart(2, '0')}-${nome}.png`);
  await pagina.screenshot({ path: arquivo, fullPage: inteira });
  console.log(`    → ${arquivo}`);
  await semTextoQuebrado(pagina, nome);
}

async function irPara(pagina, hash, seletor) {
  await pagina.evaluate((h) => { window.location.hash = h; }, hash);
  await pagina.waitForSelector(seletor, { timeout: 20_000 });
}

async function esperarToast(pagina, texto) {
  const toast = pagina.locator('.toast', { hasText: texto }).last();
  await toast.waitFor({ timeout: 20_000 });
  return (await toast.textContent()).trim();
}

async function fecharToasts(pagina) {
  for (const b of await pagina.locator('.toast__fechar').all()) await b.click().catch(() => {});
  await pagina.waitForTimeout(250);
}

async function confirmarModal(pagina, botao) {
  const dialogo = pagina.locator('dialog.modal--confirmar[open]');
  await dialogo.waitFor();
  const mensagem = (await dialogo.locator('.modal__mensagem').textContent()).trim();
  await dialogo.getByRole('button', { name: botao, exact: true }).click();
  await pagina.waitForSelector('dialog.modal--confirmar', { state: 'detached' });
  return mensagem;
}

const SELETOR_LISTA = '.pagina[data-pagina="pedidos"] .pedidos-tabela, .pagina[data-pagina="pedidos"] .estado-vazio';
const SELETOR_DETALHE = '.pagina[data-pagina="pedidos"] .pedido-eventos';

async function numerosDaLista(pagina) {
  await pagina.waitForSelector(SELETOR_LISTA, { timeout: 20_000 });
  return pagina.locator('.pedidos-tabela .pedido-celula__numero').allTextContents();
}

// ---------------------------------------------------------------------------
// Banco (chave de serviço): dados de teste, conferências e limpeza

const servico = () => clienteServico();

async function semErro(promessa, rotulo) {
  const { data, error } = await promessa;
  if (error) throw new Error(`${rotulo}: ${error.message}`);
  return data;
}

const pedidoDoBanco = (id) => semErro(servico().from('pedidos').select('*').eq('id', id).maybeSingle(), 'pedido');
const eventosDoBanco = (id) => semErro(servico().from('pedido_eventos').select('tipo, descricao, dados').eq('pedido_id', id).order('id'), 'eventos');

async function criarDados(sufixo) {
  const supa = servico();
  const produtos = await semErro(supa.from('produtos').insert([
    { nome: `Creme Teste Pedidos ${sufixo}`, slug: `teste-pedidos-${sufixo}-a`, preco_centavos: 4590, estoque: 20, ativo: true, imagens: [{ src: '/img/produtos/creme-hidratante-cupuacu.jpg', alt: '' }] },
    { nome: `Sabonete Teste Pedidos ${sufixo}`, slug: `teste-pedidos-${sufixo}-b`, preco_centavos: 2990, estoque: 20, ativo: true, imagens: [] },
  ]).select('id, slug'), 'produtos');
  const [a, b] = produtos;
  const email = `pedidos.${sufixo}@exemplo.com.br`;
  const base = {
    cliente: { nome: 'Joana Teste da Silva', email, telefone: '(91) 98105-6049', cpf: '529.982.247-25' },
    endereco: { cep: '66010-000', logradouro: 'Avenida Presidente Vargas', numero: '100', complemento: 'Apto 12', bairro: 'Campina', cidade: 'Belém', uf: 'PA' },
    observacoes: 'Por favor, embalar para presente.',
  };
  const pedidoMe = await semErro(supa.rpc('criar_pedido', { p: {
    ...base,
    itens: [{ produto_id: a.id, quantidade: 2 }, { produto_id: b.id, quantidade: 1 }],
    entrega: { tipo: 'melhor_envio', id: 'me-1', nome: 'PAC', empresa: 'Correios', prazo_dias: 10, preco_centavos: 2350, servico_id: 1 },
  } }), 'criar pedido Melhor Envio');
  await semErro(supa.rpc('confirmar_pagamento', { p_pedido_id: pedidoMe.id, p_pagamento: {
    id: Number(`9${Date.now().toString().slice(-9)}`), status: 'approved', status_detail: 'accredited',
    transaction_amount: pedidoMe.total_centavos / 100, payment_type_id: 'bank_transfer', payment_method_id: 'pix',
    date_approved: new Date().toISOString(),
  } }), 'confirmar pagamento');
  const pedidoFixo = await semErro(supa.rpc('criar_pedido', { p: {
    ...base, observacoes: null,
    itens: [{ produto_id: b.id, quantidade: 1 }],
    entrega: { tipo: 'fixo', id: 'fixo-1', nome: 'Entrega local', empresa: null, prazo_dias: 3, preco_centavos: 1500, servico_id: null },
  } }), 'criar pedido frete fixo');
  return { email, pedidoMe, pedidoFixo, produtos };
}

async function limpar(sufixo) {
  const supa = servico();
  const email = `pedidos.${sufixo}@exemplo.com.br`;
  await supa.from('pedidos').delete().eq('cliente_email', email);
  await supa.from('produtos').delete().like('slug', `teste-pedidos-${sufixo}-%`);
  const { data: pedidos } = await supa.from('pedidos').select('id').eq('cliente_email', email);
  const { data: produtos } = await supa.from('produtos').select('id').like('slug', `teste-pedidos-${sufixo}-%`);
  if ((pedidos && pedidos.length) || (produtos && produtos.length)) {
    falhar(`limpeza (${sufixo}): sobraram ${pedidos.length} pedido(s) e ${produtos.length} produto(s)`);
  } else {
    console.log(`  limpeza (${sufixo}): pedidos e produtos de teste apagados`);
  }
}

// ---------------------------------------------------------------------------
// Roteiro

async function entrar(pagina, base, hash) {
  await pagina.goto(`${base}/admin/${hash}`, { waitUntil: 'load' });
  await pagina.waitForSelector('.acesso input[name="email"]', { timeout: 20_000 });
  await pagina.fill('.acesso input[name="email"]', ADMIN.email);
  await pagina.fill('.acesso input[name="senha"]', ADMIN.senha);
  await pagina.getByRole('button', { name: 'Entrar', exact: true }).click();
  await pagina.waitForSelector('.painel .pagina[data-pagina="pedidos"]', { timeout: 20_000 });
}

async function rodarLargura(navegador, base, largura, me) {
  const sufixo = randomBytes(3).toString('hex');
  console.log(`\n== ${largura}px (sufixo ${sufixo})`);
  const celular = largura < 720;
  const dados = await criarDados(sufixo);
  const { pedidoMe, pedidoFixo, email } = dados;
  const { contexto, pagina } = await novaPagina(navegador, largura, `${largura}px`);
  try {
    // --- Lista ------------------------------------------------------------------
    await entrar(pagina, base, `#/pedidos?busca=${encodeURIComponent(email)}`);
    let numeros = await numerosDaLista(pagina);
    conferir(numeros.length === 2 && numeros.includes(`#${pedidoMe.numero}`) && numeros.includes(`#${pedidoFixo.numero}`),
      'busca pelo e-mail acha os 2 pedidos de teste', `busca pelo e-mail: ${numeros.join(', ')}`);
    await capturar(pagina, `lista-${largura}`);
    await semRolagemHorizontal(pagina, `lista ${largura}px`);

    await pagina.locator('.pagina[data-pagina="pedidos"] select').selectOption('para_enviar');
    await pagina.waitForFunction(() => window.location.hash.includes('status=para_enviar'));
    await pagina.waitForFunction((n) => {
      const nums = [...document.querySelectorAll('.pedidos-tabela .pedido-celula__numero')].map((e) => e.textContent);
      return nums.length === 1 && nums[0] === n;
    }, `#${pedidoMe.numero}`, { timeout: 20_000 });
    ok('filtro "Para enviar" mostra só o pedido pago e fica na URL');

    await pagina.locator('.pagina[data-pagina="pedidos"] select').selectOption('');
    await pagina.locator('.pagina[data-pagina="pedidos"] input[type="search"]').fill(`#${pedidoFixo.numero}`);
    await pagina.waitForFunction((n) => {
      const nums = [...document.querySelectorAll('.pedidos-tabela .pedido-celula__numero')].map((e) => e.textContent);
      return nums.length === 1 && nums[0] === n;
    }, `#${pedidoFixo.numero}`, { timeout: 20_000 });
    ok('busca pelo número do pedido');

    // --- Detalhe do pedido pago (Melhor Envio) ------------------------------------
    await irPara(pagina, `#/pedidos/${pedidoMe.id}`, SELETOR_DETALHE);
    const titulo = (await pagina.locator('h1').textContent()).trim();
    const proxima = (await pagina.locator('.pedido-proxima').textContent()).trim();
    conferir(titulo === `Pedido #${pedidoMe.numero}` && /separe os produtos/i.test(proxima),
      'detalhe: título e próxima ação do pedido pago', `detalhe: "${titulo}" / "${proxima.slice(0, 80)}"`);
    const textoPagina = await pagina.locator('.pagina').textContent();
    conferir(/Pix/.test(textoPagina) && /529\.982\.247-25/.test(textoPagina) && /embalar para presente/.test(textoPagina)
      && /CEP 66010-000/.test(textoPagina) && !/Apagar pedido/.test(textoPagina),
    'detalhe: pagamento (Pix), CPF, observação, endereço e sem "Apagar" no pedido pago', 'detalhe: dados do pedido incompletos');
    await capturar(pagina, `detalhe-pago-${largura}`);
    await semRolagemHorizontal(pagina, `detalhe ${largura}px`);

    // Nota interna.
    const textoNota = `Cliente pediu entrega depois das 14 h (${sufixo})`;
    await pagina.locator('.pedido-nota textarea').fill(textoNota);
    await pagina.getByRole('button', { name: 'Adicionar nota' }).click();
    await esperarToast(pagina, 'Nota adicionada');
    await pagina.waitForSelector(`.pedido-evento--nota:has-text("${textoNota}")`);
    const comNota = await eventosDoBanco(pedidoMe.id);
    conferir(comNota.some((e) => e.tipo === 'nota' && e.descricao === textoNota), 'nota interna gravada no banco', 'a nota não foi gravada');
    await fecharToasts(pagina);
    await pagina.locator('.pedido-evento--nota', { hasText: textoNota }).getByRole('button', { name: 'Apagar esta nota' }).click();
    await confirmarModal(pagina, 'Apagar nota');
    await esperarToast(pagina, 'Nota apagada');
    const semNota = await eventosDoBanco(pedidoMe.id);
    conferir(!semNota.some((e) => e.tipo === 'nota'), 'nota apagada', 'a nota continua no banco');
    await fecharToasts(pagina);

    // Em separação pela próxima ação.
    await pagina.locator('.pedido-proxima').getByRole('button', { name: 'Marcar como em separação' }).click();
    const modal = pagina.locator('dialog.modal--pedido-status[open]');
    await modal.waitFor();
    if (celular) await capturar(pagina, `modal-status-${largura}`, { inteira: false });
    await modal.getByRole('button', { name: 'Salvar situação' }).click();
    await esperarToast(pagina, 'Em separação');
    conferir((await pedidoDoBanco(pedidoMe.id)).status === 'em_separacao', 'situação "Em separação" salva', 'status não mudou para em_separacao');
    await fecharToasts(pagina);

    // --- Assistente do Melhor Envio --------------------------------------------------
    const etapaAtual = () => pagina.locator('.envio-etapa--atual .envio-etapa__titulo').textContent().then((t) => t.trim());
    await pagina.locator('.envio-etapa--atual input[name="chave_nfe"]').fill('123');
    await pagina.getByRole('button', { name: 'Adicionar ao carrinho' }).click();
    await pagina.waitForSelector('.envio-etapa--atual .campo--erro', { timeout: 10_000 });
    ok('chave da NF-e inválida mostra o erro no campo');
    await pagina.locator('.envio-etapa--atual input[name="chave_nfe"]').fill('');
    await pagina.getByRole('button', { name: 'Adicionar ao carrinho' }).click();
    await esperarToast(pagina, 'carrinho do Melhor Envio');
    await pagina.waitForFunction(() => /Pagar/.test(document.querySelector('.envio-etapa--atual .envio-etapa__titulo')?.textContent || ''));
    const comEtiqueta = await pedidoDoBanco(pedidoMe.id);
    conferir(comEtiqueta.me_ordens.length >= 1 && me.estado.carrinho.length >= 1, `etiqueta no carrinho (${comEtiqueta.me_ordens.length})`, 'me_ordens vazio depois de adicionar');
    await pagina.waitForSelector('.envio-etapa--atual :text("Saldo na carteira")', { timeout: 10_000 }).catch(() => falhar('saldo do Melhor Envio não apareceu no passo "Pagar"'));
    if (!celular) await capturar(pagina, `envio-pagar-${largura}`);
    await fecharToasts(pagina);

    await pagina.getByRole('button', { name: 'Pagar etiqueta' }).click();
    await esperarToast(pagina, 'paga');
    await pagina.waitForFunction(() => /Gerar/.test(document.querySelector('.envio-etapa--atual .envio-etapa__titulo')?.textContent || ''));
    conferir(me.estado.compras.length >= 1, 'etiqueta paga no Melhor Envio falso', 'nenhuma compra no Melhor Envio falso');
    await fecharToasts(pagina);

    await pagina.getByRole('button', { name: 'Gerar etiqueta' }).click();
    await esperarToast(pagina, 'Geração pedida');
    await pagina.waitForFunction(() => /Imprimir/.test(document.querySelector('.envio-etapa--atual .envio-etapa__titulo')?.textContent || ''));
    await fecharToasts(pagina);

    await pagina.getByRole('button', { name: 'Preparar a impressão' }).click();
    await esperarToast(pagina, 'Etiqueta pronta');
    await pagina.waitForSelector('a:has-text("Abrir etiqueta para imprimir")');
    const impresso = await pedidoDoBanco(pedidoMe.id);
    conferir(Boolean(impresso.etiqueta_url) && (await etapaAtual()).startsWith('Postar'),
      'impressão: link da etiqueta salvo e passo atual "Postar"', `impressão: etiqueta_url=${impresso.etiqueta_url}`);
    await fecharToasts(pagina);

    await pagina.getByRole('button', { name: 'Buscar rastreio' }).click();
    const toastRastreio = await esperarToast(pagina, 'astreio');
    ok(`rastreio consultado: "${toastRastreio.slice(0, 60)}"`);
    await fecharToasts(pagina);
    await capturar(pagina, `envio-postar-${largura}`);

    await pagina.locator('.envio-etapa--atual').getByRole('button', { name: 'Marcar como enviado' }).click();
    await modal.waitFor();
    const codigoNoModal = await modal.locator('input[name="codigo_rastreio"]').inputValue();
    await modal.locator('input[name="url_rastreio"]').fill('http://inseguro.exemplo');
    await modal.getByRole('button', { name: 'Salvar situação' }).click();
    await modal.locator('.campo--erro').first().waitFor({ timeout: 10_000 });
    ok('link de rastreio sem https mostra erro no campo');
    await modal.locator('input[name="codigo_rastreio"]').fill(codigoNoModal || `AA${sufixo}BR`);
    await modal.locator('input[name="url_rastreio"]').fill('https://rastreamento.correios.com.br/app/index.php');
    await modal.getByRole('button', { name: 'Salvar situação' }).click();
    await esperarToast(pagina, 'Enviado');
    const enviado = await pedidoDoBanco(pedidoMe.id);
    conferir(enviado.status === 'enviado' && Boolean(enviado.codigo_rastreio) && enviado.url_rastreio === 'https://rastreamento.correios.com.br/app/index.php',
      `pedido enviado com rastreio ${enviado.codigo_rastreio}`, `enviado: ${enviado.status} ${enviado.codigo_rastreio} ${enviado.url_rastreio}`);
    await pagina.waitForFunction(() => document.querySelectorAll('.envio-etapa--feita').length === 5, null, { timeout: 10_000 })
      .then(() => ok('assistente: as 5 etapas concluídas'))
      .catch(() => falhar('assistente não mostra as 5 etapas concluídas'));
    await fecharToasts(pagina);
    await capturar(pagina, `detalhe-enviado-${largura}`);
    const eventosEnvio = (await eventosDoBanco(pedidoMe.id)).filter((e) => e.tipo === 'envio').map((e) => e.dados.acao);
    conferir(['adicionar_carrinho', 'comprar', 'gerar', 'imprimir'].every((a) => eventosEnvio.includes(a)),
      `linha do tempo com os eventos de envio (${eventosEnvio.join(', ')})`, `eventos de envio: ${eventosEnvio.join(', ')}`);

    // --- Pedido aguardando pagamento (frete fixo): conferir e apagar --------------------
    await irPara(pagina, `#/pedidos/${pedidoFixo.id}`, SELETOR_DETALHE);
    await pagina.waitForFunction((n) => document.querySelector('h1')?.textContent.includes(n), `#${pedidoFixo.numero}`);
    const textoFixo = await pagina.locator('.pagina').textContent();
    conferir(/Frete fixo/.test(textoFixo) && /Aguardando o pagamento/.test(textoFixo), 'pedido de frete fixo aguardando pagamento', 'detalhe do pedido de frete fixo incompleto');
    await pagina.locator('.pedido-proxima').getByRole('button', { name: 'Conferir pagamento' }).click();
    await esperarToast(pagina, 'Nenhum pagamento');
    ok('conferir pagamento sem pagamento no Mercado Pago avisa');
    await fecharToasts(pagina);
    if (celular) await capturar(pagina, `detalhe-aguardando-${largura}`);
    await pagina.getByRole('button', { name: 'Apagar pedido' }).click();
    const msgApagar = await confirmarModal(pagina, 'Apagar pedido');
    await pagina.waitForSelector(SELETOR_LISTA, { timeout: 20_000 });
    conferir(/ainda pagar/.test(msgApagar) && !(await pedidoDoBanco(pedidoFixo.id)), 'pedido apagado (com aviso de pagamento futuro)', `apagar: "${msgApagar}"`);
    await fecharToasts(pagina);

    // Pedido inexistente.
    await irPara(pagina, `#/pedidos/${pedidoFixo.id}`, '.pagina[data-pagina="pedidos"] .estado-vazio');
    ok('pedido apagado → "Pedido não encontrado"');
  } finally {
    await contexto.close();
    await limpar(sufixo);
  }
}

async function principal() {
  mkdirSync(SAIDA, { recursive: true });
  const local = ambienteLocal();
  if (!local.serviceKey) throw new Error('Chave de serviço do Supabase local não encontrada (rode "supabase start").');
  const { data: frete, error } = await servico().from('configuracoes').select('valor').eq('chave', 'frete').maybeSingle();
  if (error) throw new Error(`Supabase local não respondeu: ${error.message}`);
  if (!frete || !frete.valor || !frete.valor.origem || !frete.valor.origem.cep) {
    throw new Error('A origem do frete está sem CEP (rode "supabase db reset" para aplicar o seed).');
  }
  const mp = await iniciarMercadoPago({ segredo: 'segredo-teste' });
  const me = await iniciarMelhorEnvio();
  const navegador = await chromium.launch({ proxy: proxyDoAmbiente() });
  const servidor = await subirServidor({
    ...AMBIENTE_VAZIO,
    SUPABASE_URL: local.url,
    SUPABASE_ANON_KEY: local.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: local.serviceKey,
    MP_ACCESS_TOKEN: 'APP_USR-teste-painel',
    MP_API_BASE: mp.url,
    MP_WEBHOOK_SECRET: 'segredo-teste',
    MELHOR_ENVIO_TOKEN: 'token-melhor-envio-teste',
    MELHOR_ENVIO_API_BASE: me.url,
    MELHOR_ENVIO_EMAIL: 'tecnico@ama.local',
  });
  try {
    for (const largura of LARGURAS) {
      try {
        await rodarLargura(navegador, servidor.url, largura, me);
      } catch (erro) {
        falhar(`${largura}px: ${erro.message.split('\n')[0]}`);
        console.error(erro);
      }
    }
  } finally {
    await servidor.fechar();
    await navegador.close();
    await mp.fechar();
    await me.fechar();
  }
  console.log(`\nCapturas em ${SAIDA}`);
  if (problemas.length) {
    console.log(`\n${problemas.length} problema(s):`);
    for (const p of problemas) console.log(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log('Tudo certo.');
  }
}

principal().catch((erro) => {
  console.error(erro);
  process.exitCode = 1;
});
