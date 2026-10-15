#!/usr/bin/env node
// Capturas e verificação do núcleo do painel /admin (Playwright + Supabase local).
//
// Uso: node scripts/capturas-painel.mjs [--saida <pasta>] [--larguras 390,768,1440]
//      (padrão da saída: <tmp>/capturas-painel)
//
// - Sobe o dev-server ligado ao Supabase local (supabase start), com o Melhor Envio falso
//   (saldo na visão geral) e o Mercado Pago em modo teste (sem rede).
// - Em cada largura: login (vazio, senha errada, certo), visão geral, menu fechado/aberto no
//   celular, página não encontrada, uma página de vitrine dos componentes (injetada com
//   page.route no lugar de paginas/categorias.js, usando só o contrato ctx), aviso de alterações
//   não salvas, modal, toasts e saída. Em 390 px também o seletor de mídia com envio real
//   para o bucket (o arquivo é apagado no fim).
// - Usuário comum (criado e apagado aqui) recebe "sem permissão"; rota preservada no login;
//   sessão encerrada em outra aba mostra o login por cima da página; login sem "Esqueci minha senha";
//   painel sem Supabase mostra "Painel em configuração".
// - Regressões do núcleo (docs/PAINEL.md §13): botões do topo por largura, "Tentar novamente" da
//   visão geral, ctx.navegar(hash atual, { substituir: true }), modal fechado pelo botão Voltar e
//   pelo login por cima, caixa de marcar clicável numa tabela com link.
// - Falha (código 1) com erro no console/página, rolagem horizontal ou verificação errada.

import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { AMBIENTE_VAZIO, subirServidor } from '../tests/apoio/servidor.js';
import { ambienteLocal, clienteServico, criarUsuario, removerUsuario } from '../tests/apoio/supabase-local.js';
import { iniciar as iniciarMelhorEnvio } from '../tests/apoio/melhorenvio-falso.js';

const RAIZ = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function argumento(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const SAIDA = path.resolve(argumento('saida', path.join(os.tmpdir(), 'capturas-painel')));
const LARGURAS = argumento('larguras', '390,768,1440').split(',').map(Number).filter(Boolean);
const ALTURAS = { 360: 760, 390: 844, 768: 1024, 1024: 800, 1440: 900 };
const ADMIN = { email: 'admin@ama.local', senha: 'admin123456' };
const ROTA_VITRINE = '#/categorias';
const IMAGEM_TESTE = path.join(RAIZ, 'public', 'img', 'logo-ama-icone.png');

const problemas = [];
const enviados = [];
// Requisição que o teste faz falhar de propósito (o erro no console é esperado).
let falhaSimulada = null;
const falhar = (texto) => {
  problemas.push(texto);
  console.log(`  ✗ ${texto}`);
};
const ok = (texto) => console.log(`  ✓ ${texto}`);

// Página de vitrine: usa só o contrato (ctx.ui, ctx.midia, ctx.marcarAlterado…), como as páginas reais.
const VITRINE = String.raw`
export async function renderizar(ctx) {
  const { ui, midia } = ctx;
  const { el } = ui;
  window.__rendersVitrine = (window.__rendersVitrine || 0) + 1;
  window.__navegarVitrine = (destino, opcoes) => ctx.navegar(destino, opcoes);
  const nome = ui.campo({ rotulo: 'Nome do produto', nome: 'nome', obrigatorio: true, valor: 'Body Splash Raiz', ajuda: 'Aparece na loja, no carrinho e no pedido.' });
  const preco = ui.campo({ rotulo: 'Preço', nome: 'preco', tipo: 'preco', valor: 4590, obrigatorio: true });
  const promo = ui.campo({ rotulo: 'Preço promocional', nome: 'promo', tipo: 'preco', ajuda: 'Vazio = sem promoção.' });
  const categoria = ui.campo({ rotulo: 'Categoria', nome: 'categoria', tipo: 'select', valor: 'body-splash',
    opcoes: [{ valor: '', rotulo: 'Sem categoria' }, { valor: 'body-splash', rotulo: 'Body splash' }, { valor: 'cremes', rotulo: 'Cremes hidratantes' }] });
  const descricao = ui.campo({ rotulo: 'Descrição', nome: 'descricao', tipo: 'textarea', linhas: 3, valor: 'Fragrância leve inspirada nas raízes da floresta.' });
  const peso = ui.campo({ rotulo: 'Peso', nome: 'peso', tipo: 'number', valor: 300, sufixo: 'g' });
  const sku = ui.campo({ rotulo: 'SKU', nome: 'sku', valor: 'BS-RAIZ', ajuda: 'Código interno (opcional).' });
  sku.definirErro('Este SKU já está em uso em outro produto.');
  const ativo = ui.campo({ rotulo: 'Visível na loja', nome: 'ativo', tipo: 'interruptor', valor: true, ajuda: 'Desligado, o produto fica como rascunho.' });
  const destaque = ui.campo({ rotulo: 'Mostrar entre os destaques', nome: 'destaque', tipo: 'checkbox' });
  const form = el('form', { class: 'formulario', id: 'form-vitrine', novalidate: true },
    el('fieldset', { class: 'formulario__secao' }, el('legend', {}, 'Dados do produto'), nome.elemento,
      el('div', { class: 'formulario__linha' }, preco.elemento, promo.elemento, categoria.elemento),
      descricao.elemento, el('div', { class: 'formulario__linha' }, peso.elemento, sku.elemento)),
    el('fieldset', { class: 'formulario__secao' }, el('legend', {}, 'Publicação'), ativo.elemento, destaque.elemento),
    el('div', { class: 'barra-acoes' }, el('p', { class: 'barra-acoes__info' }, 'As mudanças aparecem na loja na hora.'),
      ui.botao({ texto: 'Cancelar', tipo: 'secundario', href: '#/' }), ui.botao({ texto: 'Salvar produto', tipo: 'primario', tipoHtml: 'submit', icone: 'check' })));
  form.addEventListener('input', () => ctx.marcarAlterado(true));
  form.addEventListener('change', () => ctx.marcarAlterado(true));
  form.addEventListener('submit', (e) => { e.preventDefault(); ctx.marcarAlterado(false); ui.toast('Produto salvo.', 'sucesso'); });

  const resultado = el('p', { id: 'resultado-midia', class: 'texto-pequeno mono truncar' }, 'Nenhuma imagem escolhida.');
  const abrirModal = ui.botao({ texto: 'Abrir modal', icone: 'info', attrs: { id: 'abrir-modal' }, aoClicar: () => ui.modal({
    titulo: 'Nova categoria', conteudo: el('div', { class: 'formulario' }, ui.campo({ rotulo: 'Nome', nome: 'nome', valor: 'Biojoias' }).elemento,
      ui.campo({ rotulo: 'Ordem', nome: 'ordem', tipo: 'number', valor: 10 }).elemento),
    acoes: [{ texto: 'Cancelar', valor: null }, { texto: 'Criar categoria', tipo: 'primario', aoClicar: () => new Promise((r) => setTimeout(() => r('ok'), 300)) }] }) });
  const toasts = ui.botao({ texto: 'Mostrar avisos', icone: 'alerta', attrs: { id: 'mostrar-toasts' }, aoClicar: () => {
    ui.toast('Produto salvo com sucesso.', 'sucesso', { duracao: 0 });
    ui.toast('Não foi possível falar com o servidor. Verifique sua internet.', 'erro', { duracao: 0 });
  } });
  const escolher = ui.botao({ texto: 'Escolher imagem', icone: 'midia', attrs: { id: 'escolher-midia' }, aoClicar: async () => {
    const url = await midia.seletorDeMidia({ tipo: 'imagem', pasta: 'site' });
    resultado.textContent = url || 'cancelado';
  } });
  const confirmar = ui.botao({ texto: 'Excluir…', tipo: 'perigo-suave', icone: 'lixeira', attrs: { id: 'confirmar' }, aoClicar: async () => {
    const sim = await ui.confirmar('Excluir a categoria Biojoias? Esta ação não pode ser desfeita.', { perigo: true, textoConfirmar: 'Excluir categoria' });
    ui.toast(sim ? 'Excluído.' : 'Cancelado.', sim ? 'sucesso' : 'info');
  } });

  const linhas = [
    { id: '11111111-1111-4111-8111-111111111111', numero: 1042, cliente: 'Maria das Graças Souza', total: 13450, status: 'pago', criado: new Date(Date.now() - 3600e3).toISOString() },
    { id: '22222222-2222-4222-8222-222222222222', numero: 1041, cliente: 'Ana Paula Ferreira', total: 4590, status: 'aguardando_pagamento', criado: new Date(Date.now() - 86400e3).toISOString() },
    { id: '33333333-3333-4333-8333-333333333333', numero: 1040, cliente: 'Joana Lima', total: 8990, status: 'enviado', criado: new Date(Date.now() - 4 * 86400e3).toISOString() },
  ];
  const tabela = ui.tabela({ legenda: 'Pedidos de exemplo', linhas, link: (p) => '#/pedidos/' + p.id, colunas: [
    { titulo: 'Pedido', principal: true, celula: (p) => ui.formatarNumeroPedido(p.numero) },
    { titulo: 'Cliente', chave: 'cliente' },
    { titulo: 'Total', alinhar: 'direita', celula: (p) => ui.formatarPreco(p.total) },
    { titulo: 'Status', celula: (p) => ui.seloStatusPedido(p.status) },
    { titulo: 'Quando', celula: (p) => ui.tempoRelativo(p.criado) },
    { titulo: 'Separado', celula: (p) => el('input', { type: 'checkbox', class: 'caixa__entrada', 'aria-label': 'Separado: pedido ' + p.numero, dataset: { pedido: p.numero } }) },
  ] });
  const fotos = ['body-splash-raiz', 'body-splash-bruma', 'body-splash-orvalho'];
  const lista = el('ul', { class: 'lista-ordenavel', 'aria-label': 'Fotos do produto' }, fotos.map((f, i) => el('li', { class: 'lista-ordenavel__item' },
    el('button', { type: 'button', class: 'lista-ordenavel__alca', 'aria-label': 'Arrastar para reordenar' }, ui.icone('arrastar')),
    el('div', { class: 'lista-ordenavel__miniatura' }, el('img', { src: '/img/produtos/' + f + '.jpg', alt: '' })),
    el('div', { class: 'lista-ordenavel__conteudo' }, el('p', { class: 'lista-ordenavel__titulo' }, i === 0 ? 'Foto principal' : 'Foto ' + (i + 1)), el('p', { class: 'lista-ordenavel__detalhe' }, f + '.jpg')),
    el('div', { class: 'lista-ordenavel__acoes' },
      ui.botao({ tipo: 'fantasma', tamanho: 'pequeno', icone: 'subir', rotulo: 'Subir' }),
      ui.botao({ tipo: 'fantasma', tamanho: 'pequeno', icone: 'descer', rotulo: 'Descer' }),
      ui.botao({ tipo: 'fantasma', tamanho: 'pequeno', icone: 'lixeira', rotulo: 'Remover' })))));
  const abas = ui.abas({ rotulo: 'Seções do exemplo', abas: [
    { id: 'botoes', rotulo: 'Botões e selos', icone: 'estrela', conteudo: () => el('div', { class: 'pilha' },
      el('div', { class: 'grupo-botoes' }, ['primario', 'secundario', 'ouro', 'fantasma', 'perigo', 'perigo-suave'].map((t) => ui.botao({ texto: t, tipo: t })),
        ui.botao({ texto: 'Pequeno', tamanho: 'pequeno', icone: 'mais' }), ui.botao({ tipo: 'secundario', icone: 'editar', rotulo: 'Editar' }),
        ui.botao({ texto: 'Salvando', tipo: 'primario', attrs: { 'aria-busy': 'true', disabled: true } })),
      el('div', { class: 'linha' }, ui.STATUS_PEDIDO.map((s) => ui.seloStatusPedido(s)))) },
    { id: 'avisos', rotulo: 'Avisos', icone: 'info', conteudo: () => el('div', { class: 'pilha pilha--estreita' },
      ui.aviso('Mensagem informativa.', 'info'), ui.aviso('Tudo certo.', 'sucesso'), ui.aviso('Atenção a isto.', 'alerta', { titulo: 'Estoque baixo' }), ui.aviso('Algo falhou.', 'erro')) },
  ] });
  const upload = midia.criarAreaUpload({ tipo: 'imagem', aoEscolher: () => {} });
  upload.definirProgresso(0.42, 'Enviando foto.jpg… 42%');
  const vazio = ui.estadoVazio(null, 'Crie a primeira categoria para organizar a loja.', { titulo: 'Nenhuma categoria ainda', icone: 'categorias', acao: { texto: 'Nova categoria', icone: 'mais' } });
  const carregando = ui.estadoCarregando(null, { linhas: 3 });

  ctx.raiz.append(
    ui.cabecalhoPagina({ titulo: 'Vitrine de componentes', descricao: 'Página de teste injetada pelo scripts/capturas-painel.mjs.', voltar: { href: '#/', texto: 'Visão geral' },
      acoes: [abrirModal, toasts, escolher, confirmar] }),
    resultado,
    el('div', { class: 'grade grade--painel' },
      el('section', { class: 'cartao' }, el('div', { class: 'cartao__cabecalho' }, el('h2', { class: 'cartao__titulo' }, 'Formulário')), el('div', { class: 'cartao__corpo' }, form)),
      el('div', { class: 'pilha' },
        el('section', { class: 'cartao' }, el('div', { class: 'cartao__cabecalho' }, el('h2', { class: 'cartao__titulo' }, 'Fotos')), el('div', { class: 'cartao__corpo' }, lista, upload.elemento)),
        el('section', { class: 'cartao' }, el('div', { class: 'cartao__corpo' }, abas.elemento)))),
    el('section', { class: 'cartao' }, el('div', { class: 'cartao__cabecalho' }, el('h2', { class: 'cartao__titulo' }, 'Tabela')), el('div', { class: 'cartao__corpo cartao__corpo--sem-espaco' }, tabela)),
    el('div', { class: 'grade grade--2' }, el('section', { class: 'cartao' }, vazio), el('section', { class: 'cartao' }, el('div', { class: 'cartao__corpo' }, carregando))),
  );
  return () => { window.__limpezaVitrine = (window.__limpezaVitrine || 0) + 1; };
}
`;

// Proxy de saída (Google Fonts) sem passar o servidor local pelo proxy.
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
  await contexto.route(/\/admin\/js\/paginas\/categorias\.js(\?.*)?$/, (rota) => rota.fulfill({
    status: 200, contentType: 'text/javascript; charset=utf-8', body: VITRINE,
  }));
  const vigiar = (pagina) => {
    pagina.on('pageerror', (e) => falhar(`[${rotulo}] erro de página: ${e.message}`));
    pagina.on('console', (m) => {
      if (m.type() !== 'error') return;
      const origem = (m.location() && m.location().url) || '';
      // Sem rede as fontes podem falhar; páginas ainda não criadas dão 404 esperado (em-breve);
      // o 400 do login com senha errada também é esperado.
      // O Supabase local não tem servidor de e-mail: o /recover responde 500 (o painel mostra o aviso).
      if (/fonts\.(googleapis|gstatic)\.com/.test(origem) || /\/admin\/js\/paginas\//.test(origem)
        || /\/auth\/v1\/(token|recover)/.test(origem) || (falhaSimulada && falhaSimulada.test(origem))) return;
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
    const acesso = document.querySelector('.acesso');
    return {
      pagina: document.documentElement.scrollWidth - window.innerWidth,
      acesso: acesso ? acesso.scrollWidth - acesso.clientWidth : 0,
      largos: largos.slice(0, 5),
    };
  });
  if (r.pagina > 0 || r.acesso > 0 || r.largos.length) {
    falhar(`${onde}: rolagem horizontal (${Math.max(r.pagina, r.acesso)}px) ${r.largos.join(', ')}`);
  } else {
    ok(`${onde}: sem rolagem horizontal`);
  }
}

async function capturar(pagina, nome, { inteira = true } = {}) {
  await pagina.evaluate(() => document.fonts && document.fonts.ready);
  await pagina.waitForTimeout(200);
  const arquivo = path.join(SAIDA, `${nome}.png`);
  await pagina.screenshot({ path: arquivo, fullPage: inteira });
  console.log(`    → ${arquivo}`);
}

async function entrar(pagina, email, senha) {
  await pagina.locator('.acesso input[name="email"]').fill(email);
  await pagina.locator('.acesso input[name="senha"]').fill(senha);
  await pagina.getByRole('button', { name: 'Entrar', exact: true }).click();
}

async function esperarVisaoGeral(pagina) {
  await pagina.waitForSelector('.painel .pagina[data-pagina="visao-geral"] .metrica__valor', { timeout: 20_000 });
  await pagina.waitForFunction(() => {
    const ult = document.querySelector('#vg-ultimos')?.closest('.cartao');
    return ult && !ult.querySelector('.carregando');
  }, null, { timeout: 20_000 });
}

async function irPara(pagina, hash, seletor) {
  await pagina.evaluate((h) => { window.location.hash = h; }, hash);
  await pagina.waitForSelector(seletor, { timeout: 20_000 });
}

async function abrirGaveta(pagina) {
  await pagina.getByRole('button', { name: 'Abrir menu' }).click();
  await pagina.waitForSelector('.painel--menu-aberto');
  await pagina.waitForTimeout(350);
}

async function testarVitrine(pagina, largura) {
  await irPara(pagina, ROTA_VITRINE, '#form-vitrine');
  ok('vitrine (página injetada) renderizou pelo contrato ctx');
  await capturar(pagina, `componentes-${largura}`);
  await semRolagemHorizontal(pagina, 'vitrine de componentes');

  // ctx.navegar para o próprio hash com { substituir: true } renderiza de novo.
  const rendersAntes = await pagina.evaluate(() => window.__rendersVitrine);
  await pagina.evaluate(() => window.__navegarVitrine(window.location.hash, { substituir: true }));
  await pagina.waitForFunction((n) => window.__rendersVitrine > n && document.querySelector('#form-vitrine'), rendersAntes, { timeout: 10_000 })
    .then(() => ok('ctx.navegar(hash atual, { substituir: true }) renderiza a página de novo'))
    .catch(() => falhar('ctx.navegar(hash atual, { substituir: true }) não renderizou de novo'));

  // Tabela com link: a caixa de marcar de uma célula fica por cima da camada do link.
  const caixa = pagina.locator('input[data-pedido="1042"]');
  const noTopo = await caixa.evaluate((e) => {
    e.scrollIntoView({ block: 'center' });
    const r = e.getBoundingClientRect();
    return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === e;
  });
  if (!noTopo) {
    falhar('caixa de marcar numa tabela com link ficou por baixo da camada do link');
  } else {
    await caixa.click();
    const depois = await pagina.evaluate(() => ({ hash: window.location.hash, marcada: document.querySelector('input[data-pedido="1042"]').checked }));
    if (depois.hash !== ROTA_VITRINE || !depois.marcada) falhar(`clique na caixa da tabela: ${JSON.stringify(depois)}`);
    else ok('tabela com link: caixa de marcar na célula funciona sem abrir a linha');
  }

  // Botão Voltar do navegador com um modal aberto: a rota troca e o modal fecha.
  await pagina.locator('#abrir-modal').click();
  await pagina.waitForSelector('dialog.modal[open]');
  await pagina.goBack();
  await pagina.waitForSelector('.pagina[data-pagina="nao-encontrada"]');
  if (await pagina.locator('dialog.modal').count()) {
    falhar('o modal continuou aberto depois do botão Voltar');
    await pagina.keyboard.press('Escape');
  } else {
    ok('botão Voltar com modal aberto troca a rota e fecha o modal');
  }
  await pagina.goForward();
  await pagina.waitForSelector('#form-vitrine');

  // Alterações não salvas → confirmação ao trocar de rota.
  await pagina.locator('#form-vitrine input[name="nome"]').fill('Body Splash Raiz — 200 mL');
  if (!(await pagina.isVisible('.topo__alterado'))) falhar('aviso "Alterações não salvas" não apareceu no topo');
  if (largura < 1024) await abrirGaveta(pagina);
  await pagina.locator('.menu-lateral__link[data-menu="pedidos"]').click();
  await pagina.waitForSelector('dialog.modal--confirmar[open]');
  if (largura === 390 || largura === 1440) await capturar(pagina, `confirmar-descarte-${largura}`, { inteira: false });
  await pagina.getByRole('button', { name: 'Continuar editando' }).click();
  await pagina.waitForSelector('dialog.modal--confirmar', { state: 'detached' });
  const hashDepois = await pagina.evaluate(() => window.location.hash);
  const valor = await pagina.locator('#form-vitrine input[name="nome"]').inputValue();
  if (hashDepois !== ROTA_VITRINE || !valor.includes('200 mL')) falhar(`"Continuar editando" não manteve a página (hash ${hashDepois})`);
  else ok('"Continuar editando" mantém a rota e o que foi digitado');
  if (largura < 1024 && await pagina.isVisible('.painel--menu-aberto')) {
    await pagina.keyboard.press('Escape');
    await pagina.waitForSelector('.painel:not(.painel--menu-aberto)');
  }

  // Modal com foco preso e Esc.
  await pagina.locator('#abrir-modal').click();
  await pagina.waitForSelector('dialog.modal[open]');
  const focoNoModal = await pagina.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('dialog.modal')));
  if (!focoNoModal) falhar('foco não entrou no modal');
  for (let i = 0; i < 8; i += 1) await pagina.keyboard.press('Tab');
  const aindaNoModal = await pagina.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('dialog.modal')));
  if (!aindaNoModal) falhar('Tab saiu do modal (foco não está preso)');
  if (largura !== 768) await capturar(pagina, `modal-${largura}`, { inteira: false });
  await pagina.keyboard.press('Escape');
  await pagina.waitForSelector('dialog.modal', { state: 'detached' });
  const focoVoltou = await pagina.evaluate(() => document.activeElement && document.activeElement.id);
  if (focoVoltou !== 'abrir-modal') falhar(`foco não voltou ao botão que abriu o modal (${focoVoltou})`);
  else ok('modal: foco preso, Esc fecha e devolve o foco');

  // Toasts.
  await pagina.locator('#mostrar-toasts').click();
  await pagina.waitForSelector('.toast--erro');
  if (largura !== 768) await capturar(pagina, `toasts-${largura}`, { inteira: false });
  for (const fechar of await pagina.locator('.toast__fechar').all()) await fechar.click();

  // Descartar de verdade.
  await pagina.evaluate(() => { window.location.hash = '#/'; });
  await pagina.waitForSelector('dialog.modal--confirmar[open]');
  await pagina.getByRole('button', { name: 'Descartar e sair' }).click();
  await esperarVisaoGeral(pagina);
  const limpezas = await pagina.evaluate(() => window.__limpezaVitrine || 0);
  if (limpezas < 1) falhar('a função de limpeza da página não foi chamada ao sair');
  if (await pagina.isVisible('.topo__alterado')) falhar('aviso de alterações continuou depois de descartar');
  ok('"Descartar e sair" navega, chama a limpeza e zera o aviso');
}

async function testarSeletorDeMidia(pagina, largura) {
  await irPara(pagina, ROTA_VITRINE, '#form-vitrine');
  await pagina.locator('#escolher-midia').click();
  await pagina.waitForSelector('dialog.modal--midia[open]');
  await pagina.waitForFunction(() => !document.querySelector('.modal--midia .grade-midia .carregando'), null, { timeout: 15_000 });
  const escolha = pagina.waitForEvent('filechooser');
  await pagina.locator('.modal--midia .area-upload .botao').click();
  await (await escolha).setFiles(IMAGEM_TESTE);
  await pagina.waitForSelector('.modal--midia .midia-item--selecionado', { timeout: 20_000 });
  ok('seletor de mídia: imagem otimizada e enviada ao bucket');
  await capturar(pagina, `seletor-midia-${largura}`, { inteira: false });
  await pagina.getByRole('button', { name: 'Usar esta imagem' }).click();
  await pagina.waitForSelector('dialog.modal--midia', { state: 'detached' });
  const url = (await pagina.locator('#resultado-midia').textContent()).trim();
  const m = url.match(/\/storage\/v1\/object\/public\/midia\/(site\/\d{4}-\d{2}\/logo-ama-icone-[0-9a-f]{6,16}\.(webp|png|jpg))$/);
  if (!m) {
    falhar(`URL escolhida inesperada: ${url}`);
    return;
  }
  enviados.push(m[1]);
  const resposta = await pagina.request.get(url);
  if (!resposta.ok()) falhar(`arquivo enviado não abre pela URL pública (HTTP ${resposta.status()})`);
  else ok(`URL pública devolvida: …/${m[1]} (${resposta.headers()['content-type']})`);
}

async function rodarLargura(navegador, base, largura) {
  console.log(`\n== ${largura}px`);
  const { contexto, pagina } = await novaPagina(navegador, largura, `${largura}px`);
  try {
    await pagina.goto(`${base}/admin/`, { waitUntil: 'load' });
    await pagina.waitForSelector('form.acesso__formulario');
    const titulo = await pagina.title();
    if (!/Painel AMA/.test(titulo)) falhar(`título inesperado no login: ${titulo}`);
    const robots = await pagina.getAttribute('meta[name="robots"]', 'content');
    if (!/noindex/.test(robots || '')) falhar('meta robots sem noindex');
    await capturar(pagina, `login-${largura}`);
    await semRolagemHorizontal(pagina, 'login');

    // Validação no navegador, senha errada e mostrar/ocultar.
    await pagina.getByRole('button', { name: 'Entrar', exact: true }).click();
    const erros = await pagina.locator('.campo__erro:not([hidden])').allTextContents();
    if (erros.length < 2) falhar(`login vazio deveria mostrar 2 erros, mostrou ${erros.length}`);
    else ok(`login vazio: ${erros.join(' / ')}`);
    await entrar(pagina, ADMIN.email, 'senha-errada');
    await pagina.waitForSelector('.acesso .aviso--erro:not([hidden])');
    const msg = (await pagina.locator('.acesso .aviso--erro').textContent()).trim();
    if (!/incorretos/.test(msg)) falhar(`mensagem de senha errada inesperada: ${msg}`);
    else ok(`senha errada: "${msg}"`);
    await pagina.getByRole('button', { name: 'Mostrar senha' }).click();
    if ((await pagina.getAttribute('input[name="senha"]', 'type')) !== 'text') falhar('mostrar senha não trocou o tipo do campo');
    else ok('mostrar/ocultar senha');
    if (largura === 390) await capturar(pagina, `login-erro-${largura}`, { inteira: false });

    // Login certo → visão geral.
    await entrar(pagina, ADMIN.email, ADMIN.senha);
    await esperarVisaoGeral(pagina);
    ok('login do admin → visão geral');
    const emailTopo = await pagina.locator('.topo__email').textContent();
    if (emailTopo !== ADMIN.email) falhar(`e-mail no topo: ${emailTopo}`);
    const foco = await pagina.evaluate(() => document.activeElement && document.activeElement.tagName);
    if (foco !== 'H1') falhar(`foco depois da rota deveria estar no h1, está em ${foco}`);
    if (await pagina.locator('.integracao__nome, #vg-integracoes').count()) falhar('a visão geral ainda mostra as integrações');
    else ok('visão geral sem o cartão de integrações');
    await capturar(pagina, `visao-geral-${largura}`);
    await semRolagemHorizontal(pagina, 'visão geral');

    // Topo: "Abrir menu" só abaixo de 1024 px; "Sair" do topo só a partir de 640 px (no celular fica na gaveta).
    const menuVisivel = await pagina.isVisible('.topo__menu');
    const sairVisivel = await pagina.isVisible('.topo__sair');
    if (menuVisivel !== largura < 1024) falhar(`botão "Abrir menu" ${menuVisivel ? 'aparece' : 'não aparece'} no topo em ${largura}px`);
    if (sairVisivel !== largura >= 640) falhar(`"Sair" do topo ${sairVisivel ? 'aparece' : 'não aparece'} em ${largura}px`);
    if (menuVisivel === largura < 1024 && sairVisivel === largura >= 640) {
      ok(`topo: "Abrir menu" ${menuVisivel ? 'visível' : 'oculto'}, "Sair" ${sairVisivel ? 'visível' : 'oculto (fica na gaveta)'}`);
    }

    // "Tentar novamente" de "Últimos pedidos" (a consulta falha uma vez de propósito).
    falhaSimulada = /\/rest\/v1\/pedidos\?select=id%2Cnumero/;
    let falhas = 0;
    await contexto.route(falhaSimulada, (rota) => (falhas++ === 0
      ? rota.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"falha simulada"}' })
      : rota.continue()));
    try {
      await irPara(pagina, '#/?teste=falha', 'section:has(#vg-ultimos) .estado-vazio--erro');
      if (largura === 390) await capturar(pagina, `visao-geral-erro-${largura}`, { inteira: false });
      await pagina.locator('section:has(#vg-ultimos) .estado-vazio--erro .botao').click();
      await pagina.waitForFunction(() => {
        const cartao = document.querySelector('#vg-ultimos')?.closest('.cartao');
        return cartao && !cartao.querySelector('.estado-vazio--erro, .carregando');
      }, null, { timeout: 15_000 });
      ok('visão geral: "Tentar novamente" de "Últimos pedidos" carrega de novo');
    } catch (erro) {
      falhar(`visão geral: "Tentar novamente" não recarregou (${erro.message.split('\n')[0]})`);
    } finally {
      await contexto.unroute(falhaSimulada);
      falhaSimulada = null;
    }

    if (largura < 1024) {
      await capturar(pagina, `menu-fechado-${largura}`, { inteira: false });
      if (!(await pagina.evaluate(() => document.getElementById('menu-lateral').inert))) falhar('gaveta fechada deveria ficar inerte (fora do Tab)');
      await abrirGaveta(pagina);
      const dentro = await pagina.evaluate(() => Boolean(document.activeElement && document.activeElement.closest('#menu-lateral')));
      if (!dentro) falhar('foco não foi para dentro do menu aberto');
      if ((await pagina.getAttribute('.topo__menu', 'aria-expanded')) !== 'true') falhar('aria-expanded do botão do menu não virou true');
      const alturaLink = await pagina.evaluate(() => document.querySelector('.menu-lateral__link').getBoundingClientRect().height);
      if (alturaLink < 44) falhar(`itens do menu baixos para o dedo (${alturaLink}px)`);
      else ok(`gaveta aberta (itens com ${Math.round(alturaLink)}px de altura)`);
      await capturar(pagina, `menu-aberto-${largura}`, { inteira: false });
      await pagina.keyboard.press('Escape');
      await pagina.waitForSelector('.painel:not(.painel--menu-aberto)');
      const voltou = await pagina.evaluate(() => document.activeElement && document.activeElement.classList.contains('topo__menu'));
      if (!voltou) falhar('Esc não devolveu o foco ao botão do menu');
      else ok('Esc fecha a gaveta e devolve o foco');
    } else if (!(await pagina.isVisible('#menu-lateral .menu-lateral__link[aria-current="page"]'))) {
      falhar('menu lateral deveria estar visível no desktop com a rota atual marcada');
    } else {
      ok('menu lateral fixo com a rota atual marcada');
    }

    await irPara(pagina, '#/nao-existe', '.pagina[data-pagina="nao-encontrada"]');
    ok('rota desconhecida → "Página não encontrada"');
    if (largura === 390) await capturar(pagina, `nao-encontrada-${largura}`, { inteira: false });

    await testarVitrine(pagina, largura);
    if (largura === 390) await testarSeletorDeMidia(pagina, largura);

    // Sair.
    if (largura < 640) {
      await abrirGaveta(pagina);
      await pagina.locator('.menu-lateral__sair').click();
    } else {
      await pagina.locator('.topo__sair').click();
    }
    await pagina.waitForSelector('.acesso .aviso--info:not([hidden])');
    const saida = (await pagina.locator('.acesso .aviso--info').textContent()).trim();
    if (!/saiu/.test(saida)) falhar(`mensagem ao sair: ${saida}`);
    else ok('Sair → volta ao login');
  } finally {
    await contexto.close();
  }
}

async function testarAcesso(navegador, base) {
  console.log('\n== usuário comum, rota preservada, sessão encerrada e login (390px)');
  const sufixo = randomBytes(4).toString('hex');
  const comum = { email: `comum-${sufixo}@ama.local`, senha: `senha-${sufixo}-123` };
  const usuario = await criarUsuario({ email: comum.email, senha: comum.senha, admin: false });
  const { contexto, pagina } = await novaPagina(navegador, 390, 'acesso');
  try {
    await pagina.goto(`${base}/admin/${ROTA_VITRINE}`, { waitUntil: 'load' });
    await pagina.waitForSelector('form.acesso__formulario');
    await entrar(pagina, comum.email, comum.senha);
    await pagina.waitForSelector('.acesso .aviso--erro:not([hidden])');
    const msg = (await pagina.locator('.acesso .aviso--erro').textContent()).trim();
    if (!/sem permiss/i.test(msg)) falhar(`usuário comum deveria ver "sem permissão": ${msg}`);
    else ok(`usuário comum: "${msg}"`);
    const sessoes = await pagina.evaluate(() => Object.keys(localStorage).filter((k) => /auth-token/.test(k)).length);
    if (sessoes) falhar('usuário sem permissão continuou com sessão salva');
    else ok('sessão do usuário comum foi encerrada');
    if (await pagina.isVisible('.painel')) falhar('o painel apareceu para o usuário comum');
    await capturar(pagina, 'sem-permissao-390');

    // O admin entra e cai direto na rota pedida antes do login.
    await entrar(pagina, ADMIN.email, ADMIN.senha);
    await pagina.waitForSelector('#form-vitrine', { timeout: 20_000 });
    ok(`depois do login a rota pedida (${ROTA_VITRINE}) foi mantida`);
    await pagina.locator('#form-vitrine input[name="nome"]').fill('Texto ainda não salvo');
    // Um modal aberto não pode deixar a tela de login inerte quando a sessão acaba.
    await pagina.locator('#abrir-modal').click();
    await pagina.waitForSelector('dialog.modal[open]');

    // Saída em outra aba = sessão encerrada aqui: login por cima, página preservada.
    const outra = await contexto.newPage();
    await outra.goto(`${base}/admin/`, { waitUntil: 'load' });
    await outra.waitForSelector('.painel', { timeout: 20_000 });
    await outra.getByRole('button', { name: 'Abrir menu' }).click();
    await outra.waitForSelector('.painel--menu-aberto');
    await outra.locator('.menu-lateral__sair').click();
    await outra.waitForSelector('form.acesso__formulario');
    await outra.close();
    await pagina.waitForSelector('.acesso form.acesso__formulario', { timeout: 15_000 });
    if (await pagina.locator('dialog.modal').count()) falhar('sessão encerrada: o modal da página ficou aberto por cima do login');
    else ok('sessão encerrada: o modal aberto fechou e o login ficou utilizável');
    const aviso = (await pagina.locator('.acesso .aviso:not([hidden])').first().textContent()).trim();
    if (!/sessão expirou/i.test(aviso)) falhar(`sessão encerrada: aviso inesperado "${aviso}"`);
    const preservada = await pagina.evaluate(() => ({
      inerte: document.querySelector('.painel') && document.querySelector('.painel').inert,
      valor: document.querySelector('#form-vitrine input[name="nome"]') && document.querySelector('#form-vitrine input[name="nome"]').value,
      hash: window.location.hash,
    }));
    if (!preservada.inerte || preservada.valor !== 'Texto ainda não salvo' || preservada.hash !== ROTA_VITRINE) {
      falhar(`sessão encerrada: página não preservada ${JSON.stringify(preservada)}`);
    } else {
      ok('sessão encerrada: login por cima, rota e texto não salvo preservados');
    }
    await capturar(pagina, 'sessao-expirada-390', { inteira: false });
    await pagina.locator('.acesso input[name="senha"]').fill(ADMIN.senha);
    await pagina.getByRole('button', { name: 'Entrar', exact: true }).click();
    await pagina.waitForSelector('.acesso', { state: 'detached', timeout: 20_000 });
    const depois = await pagina.locator('#form-vitrine input[name="nome"]').inputValue();
    if (depois !== 'Texto ainda não salvo') falhar('o texto não salvo se perdeu depois de entrar de novo');
    else ok('entrou de novo e continuou na mesma página, com o texto');

    // Sem "Esqueci minha senha": o login só tem e-mail e senha.
    await pagina.evaluate(() => { window.location.hash = '#/'; });
    await pagina.waitForSelector('dialog.modal--confirmar[open]');
    await pagina.getByRole('button', { name: 'Descartar e sair' }).click();
    await esperarVisaoGeral(pagina);
    await abrirGaveta(pagina);
    await pagina.locator('.menu-lateral__sair').click();
    await pagina.waitForSelector('form.acesso__formulario');
    if (await pagina.getByText(/esqueci minha senha/i).count()) falhar('o login ainda mostra "Esqueci minha senha"');
    else ok('login sem "Esqueci minha senha"');
    await capturar(pagina, 'login-390');

    // Link de recuperação vencido (#error=…): mensagem clara no login e URL limpa.
    await pagina.goto('about:blank');
    await pagina.goto(`${base}/admin/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`, { waitUntil: 'load' });
    await pagina.waitForSelector('.acesso .aviso--erro:not([hidden])');
    const vencido = (await pagina.locator('.acesso .aviso--erro').textContent()).trim();
    const hashLimpo = await pagina.evaluate(() => window.location.hash);
    if (!/expirou/.test(vencido) || hashLimpo !== '#/') falhar(`link vencido: "${vencido}" (hash ${hashLimpo})`);
    else ok('link de recuperação vencido: aviso no login e URL limpa');
  } finally {
    await contexto.close();
    await removerUsuario(usuario.id);
    ok('usuário comum removido');
  }
}

async function testarSemConfiguracao(navegador) {
  console.log('\n== sem Supabase configurado (390px)');
  const servidor = await subirServidor({ ...AMBIENTE_VAZIO });
  const { contexto, pagina } = await novaPagina(navegador, 390, 'sem-config');
  try {
    await pagina.goto(`${servidor.url}/admin/`, { waitUntil: 'load' });
    await pagina.waitForSelector('.acesso__titulo');
    const titulo = (await pagina.locator('.acesso__titulo').textContent()).trim();
    if (titulo !== 'Painel em configuração') falhar(`sem Supabase: título "${titulo}"`);
    else ok('sem Supabase: "Painel em configuração"');
    await capturar(pagina, 'sem-configuracao-390', { inteira: false });
  } finally {
    await contexto.close();
    await servidor.fechar();
  }
}

async function principal() {
  mkdirSync(SAIDA, { recursive: true });
  const local = ambienteLocal();
  if (!local.serviceKey) throw new Error('Chave de serviço do Supabase local não encontrada (rode "supabase start").');
  const me = await iniciarMelhorEnvio();
  const navegador = await chromium.launch({ proxy: proxyDoAmbiente() });
  try {
    await testarSemConfiguracao(navegador);
    const servidor = await subirServidor({
      ...AMBIENTE_VAZIO,
      SUPABASE_URL: local.url,
      SUPABASE_ANON_KEY: local.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: local.serviceKey,
      MP_ACCESS_TOKEN: 'APP_USR-teste-painel',
      MP_MODO: 'teste',
      MELHOR_ENVIO_TOKEN: 'token-teste-painel',
      MELHOR_ENVIO_API_BASE: me.url,
      MELHOR_ENVIO_EMAIL: 'tecnico@ama.local',
    });
    try {
      for (const largura of LARGURAS) await rodarLargura(navegador, servidor.url, largura);
      await testarAcesso(navegador, servidor.url);
    } finally {
      await servidor.fechar();
    }
  } finally {
    await navegador.close();
    await me.fechar();
    if (enviados.length) {
      const { error } = await clienteServico().storage.from('midia').remove(enviados);
      if (error) console.log(`Aviso: não foi possível apagar ${enviados.join(', ')}: ${error.message}`);
      else console.log(`Arquivos de teste apagados do bucket: ${enviados.join(', ')}`);
    }
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
