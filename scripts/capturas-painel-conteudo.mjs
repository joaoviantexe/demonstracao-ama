#!/usr/bin/env node
// Capturas e verificação das páginas "Conteúdo do site" do painel (#/conteudo) (Playwright + Supabase local).
//
// Uso: node scripts/capturas-painel-conteudo.mjs [--saida <pasta>] [--larguras 390,1440]
//      (padrão da saída: <tmp>/capturas-painel-conteudo)
//
// O armazenamento (fotos e home publicada; o bucket R2 em produção) fica numa pasta temporária, apagada no
// fim. GET / entrega a home publicada pelo painel: antes de entrar, o template (X-AMA-CMS: padrao); ao entrar,
// o painel publica; depois de cada "Salvar", GET / vem com X-AMA-CMS: publicado e o conteúdo novo.
//
// Em cada largura, com dados próprios (sufixo aleatório):
// - #/conteudo: cartões dos grupos (quantos campos, visível/oculta);
// - "Quem somos": editor rico (Negrito, Link com javascript: recusado, Lista e Parágrafo) desfeito ao sair
//   com "Descartar e sair"; título novo e aviso ao sair sem salvar; sem prévia; "Salvar" grava só a chave
//   mudada e GET / mostra o título novo;
// - "Depoimentos": abre um item, muda o nome, troca a foto por upload (seletor de mídia → /midia/site/...),
//   sobe o item, adiciona um item (nasce igual ao molde) e remove com confirmação; salva e confere em GET /;
// - "Parcerias": desliga "Mostrar esta seção no site" (some de GET /) e liga de novo (a linha é apagada);
// - "Banner da Loja" (foto escolhida entre os produtos) e "WhatsApp" (número + mensagem): conferidos em GET /;
// - título salvo igual ao original: a linha some e GET / volta ao original;
// - parte inexistente, História, SEO (prévia do Google) e Postagens (endereço do Instagram inválido não grava).
// No fim apaga as chaves de conteudo_site criadas (e devolve as que já existiam) e a pasta temporária.
// Falha (código 1) com erro no console/página, rolagem horizontal ou verificação errada.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { parseHTML } from 'linkedom';
import { chromium } from 'playwright';
import { AMBIENTE_VAZIO, subirServidor } from '../tests/apoio/servidor.js';
import { ambienteLocal, clienteServico } from '../tests/apoio/supabase-local.js';
import { armazenamentoLocal } from './armazenamento-local.mjs';

function argumento(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const SAIDA = path.resolve(argumento('saida', path.join(os.tmpdir(), 'capturas-painel-conteudo')));
const LARGURAS = argumento('larguras', '390,1440').split(',').map(Number).filter(Boolean);
const ALTURAS = { 360: 760, 390: 844, 768: 1024, 1024: 800, 1440: 900 };
const ADMIN = { email: 'admin@ama.local', senha: 'admin123456' };
// Chaves que este script grava (as que já existirem são devolvidas no fim).
const CHAVES = ['quem-somos.titulo', 'quem-somos.texto', 'depoimentos.itens', 'grupo.parcerias.visivel'];
// Armazenamento numa pasta temporária (criada e apagada em principal()).
let armazenamento = null;

const problemas = [];
const falhar = (texto) => {
  problemas.push(texto);
  console.log(`  ✗ ${texto}`);
};
const ok = (texto) => console.log(`  ✓ ${texto}`);
const conferir = (condicao, sucesso, erro) => (condicao ? ok(sucesso) : falhar(erro));

// ---------------------------------------------------------------------------
// PNG sem dependências (gradiente com um círculo), para enviar como foto.

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function blocoPng(tipo, dados) {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tamanho, corpo, crc]);
}

function gerarPng(lado, fundoA, fundoB, circulo) {
  const largura = lado * 3 + 1;
  const linhas = Buffer.alloc(largura * lado);
  for (let y = 0; y < lado; y += 1) {
    linhas[y * largura] = 0;
    for (let x = 0; x < lado; x += 1) {
      const t = (x + y) / (2 * lado);
      const dentro = Math.hypot(x - lado * 0.5, y - lado * 0.42) < lado * 0.22;
      const cor = dentro ? circulo : fundoA.map((c, i) => Math.round(c * (1 - t) + fundoB[i] * t));
      cor.forEach((c, i) => { linhas[y * largura + 1 + x * 3 + i] = c; });
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0);
  ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    blocoPng('IHDR', ihdr),
    blocoPng('IDAT', deflateSync(linhas)),
    blocoPng('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Navegador

function proxyDoAmbiente() {
  const servidor = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!servidor) return undefined;
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  return { server: servidor, bypass: '127.0.0.1,localhost' };
}

async function novaPagina(navegador, largura, rotulo, origem) {
  const contexto = await navegador.newContext({
    viewport: { width: largura, height: ALTURAS[largura] || 900 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    locale: 'pt-BR',
    timezoneId: 'America/Belem',
    hasTouch: largura < 1024,
  });
  await contexto.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: origem });
  await contexto.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (rota) => {
    try {
      await rota.fulfill({ response: await rota.fetch() });
    } catch {
      await rota.abort().catch(() => {});
    }
  });
  // A pré-visualização da home incorpora publicações do Instagram: sem rede no teste, responde vazio.
  await contexto.route(/^https:\/\/([a-z0-9-]+\.)*(instagram|cdninstagram|facebook)\.(com|net)\//, (rota) => {
    const script = rota.request().resourceType() === 'script';
    return rota.fulfill(script
      ? { status: 200, contentType: 'text/javascript; charset=utf-8', body: '' }
      : { status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Instagram</title>' });
  });
  const vigiar = (pagina) => {
    pagina.on('pageerror', (e) => falhar(`[${rotulo}] erro de página: ${e.message}`));
    pagina.on('console', (m) => {
      if (m.type() !== 'error') return;
      const local = (m.location() && m.location().url) || '';
      if (/fonts\.(googleapis|gstatic)\.com|instagram\.com|cdninstagram|facebook/.test(local)) return;
      falhar(`[${rotulo}] console: ${m.text()} ${local}`);
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
    return { pagina: document.documentElement.scrollWidth - window.innerWidth, largos: largos.slice(0, 5) };
  });
  if (r.pagina > 0 || r.largos.length) falhar(`${onde}: rolagem horizontal (${r.pagina}px) ${r.largos.join(', ')}`);
  else ok(`${onde}: sem rolagem horizontal`);
}

let contadorCapturas = 0;
async function capturar(pagina, nome, { inteira = true, toasts = false } = {}) {
  // Toasts de passos anteriores cobririam a tela capturada.
  // (Com um modal aberto o X do toast não recebe clique: some direto do DOM, só para a captura.)
  if (!toasts) await limparToasts(pagina);
  await pagina.evaluate(() => document.fonts && document.fonts.ready);
  // Na captura da página inteira as imagens "lazy" fora da tela não carregariam.
  await pagina.evaluate(() => Promise.all([...document.querySelectorAll('img')].map((img) => {
    img.loading = 'eager';
    return img.decode().catch(() => {});
  })));
  await pagina.waitForTimeout(250);
  contadorCapturas += 1;
  const arquivo = path.join(SAIDA, `${String(contadorCapturas).padStart(2, '0')}-${nome}.png`);
  await pagina.screenshot({ path: arquivo, fullPage: inteira });
  console.log(`    → ${arquivo}`);
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

// Tira da tela os toasts antigos antes de uma ação cujo toast será esperado (senão o antigo responde).
async function limparToasts(pagina) {
  await pagina.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
}

async function fecharToasts(pagina) {
  for (const b of await pagina.locator('.toast__fechar').all()) await b.click({ force: true }).catch(() => {});
  await pagina.waitForTimeout(250);
}

async function responderConfirmacao(pagina, botao, { capturaComo } = {}) {
  const dialogo = pagina.locator('dialog.modal--confirmar[open]');
  await dialogo.waitFor({ timeout: 10_000 });
  const mensagem = (await dialogo.locator('.modal__mensagem').textContent()).trim();
  if (capturaComo) await capturar(pagina, capturaComo, { inteira: false });
  await dialogo.getByRole('button', { name: botao, exact: true }).click();
  await pagina.waitForSelector('dialog.modal--confirmar', { state: 'detached' });
  return mensagem;
}

// Seleciona um trecho de texto dentro de um elemento editável (como se a pessoa arrastasse o mouse).
async function selecionarTexto(pagina, seletor, trecho) {
  return pagina.evaluate(({ seletor: s, trecho: t }) => {
    const area = document.querySelector(s);
    area.focus();
    const andador = document.createTreeWalker(area, NodeFilter.SHOW_TEXT);
    for (let no = andador.nextNode(); no; no = andador.nextNode()) {
      const i = no.data.indexOf(t);
      if (i === -1) continue;
      const intervalo = document.createRange();
      intervalo.setStart(no, i);
      intervalo.setEnd(no, i + t.length);
      const selecao = window.getSelection();
      selecao.removeAllRanges();
      selecao.addRange(intervalo);
      return true;
    }
    return false;
  }, { seletor, trecho });
}

// ---------------------------------------------------------------------------
// Banco e site

async function linhas(chaves) {
  const { data, error } = await clienteServico().from('conteudo_site').select('chave, valor').in('chave', chaves);
  if (error) throw new Error(`conteudo_site: ${error.message}`);
  return new Map(data.map((l) => [l.chave, l.valor]));
}

// GET /: a home publicada pelo painel (X-AMA-CMS: publicado) ou o template (padrao).
async function home(url) {
  const resposta = await fetch(`${url}/`);
  const html = await resposta.text();
  return { status: resposta.status, cms: resposta.headers.get('x-ama-cms'), documento: parseHTML(html).document };
}

// Espera GET / passar a entregar a home publicada (o painel publica sozinho ao entrar).
async function esperarHomePublicada(url, limiteMs = 20_000) {
  const fim = Date.now() + limiteMs;
  let site = await home(url);
  while (site.cms !== 'publicado' && Date.now() < fim) {
    await new Promise((r) => { setTimeout(r, 250); });
    site = await home(url);
  }
  return site;
}

const textoDe = (doc, seletor) => (doc.querySelector(seletor)?.textContent || '').replace(/\s+/g, ' ').trim();

// Caminho no armazenamento a partir da URL pública (/midia/<caminho>); null se não é de lá.
function caminhoDaMidia(src) {
  const m = String(src || '').match(/^\/midia\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Arquivos do armazenamento com o sufixo no nome (para a limpeza), em todas as pastas e meses.
async function arquivosDoTeste(sufixo) {
  const achados = [];
  for (const pasta of ['site', 'produtos', 'videos']) {
    for (const { chave } of await armazenamento.listar(`${pasta}/`)) {
      if (chave.split('/').pop().includes(sufixo)) achados.push(chave);
    }
  }
  return achados;
}

// ---------------------------------------------------------------------------
// Fluxo por largura

async function entrar(pagina) {
  await pagina.locator('.acesso input[name="email"]').fill(ADMIN.email);
  await pagina.locator('.acesso input[name="senha"]').fill(ADMIN.senha);
  await pagina.getByRole('button', { name: 'Entrar', exact: true }).click();
}

async function cartaoDoGrupo(pagina, id) {
  const cartao = pagina.locator(`.cms-grupo[data-grupo="${id}"]`);
  return {
    titulo: (await cartao.locator('.cms-grupo__titulo').textContent()).trim(),
    selos: (await cartao.locator('.cms-grupo__selos').textContent()).replace(/\s+/g, ' ').trim(),
  };
}

async function salvar(pagina, onde) {
  await limparToasts(pagina);
  await pagina.locator('.cms-salvar').click();
  await esperarToast(pagina, 'Salvo!');
  await pagina.waitForSelector('.cms-salvar:not([aria-busy="true"])');
  await pagina.waitForTimeout(300); // passa o atraso (150 ms) da atualização dos selos
  const info = (await pagina.locator('.cms-barra__info').textContent()).trim();
  const pendentes = await pagina.evaluate(() => [...document.querySelectorAll('.cms-campo')]
    .filter((c) => c.querySelector('.selo--ambar:not([hidden])')).map((c) => c.dataset.chave));
  conferir(/^Salvo\./.test(info) && !/15 segundos/.test(info) && await pagina.locator('.cms-barra__info a', { hasText: 'Ver no site' }).count() === 1,
    `${onde}: depois de salvar, "Salvo." + "Ver no site"`,
    `${onde}: barra depois de salvar: "${info}" (não salvos: ${pendentes.join(', ')})`);
  const alterado = await pagina.isVisible('.topo__alterado');
  conferir(!alterado, 'aviso de alterações não salvas sumiu depois de salvar', 'aviso de alterações continuou depois de salvar');
}

async function rodarLargura(navegador, url, largura) {
  console.log(`\n== ${largura}px`);
  const sufixo = randomBytes(3).toString('hex');
  const rotulo = `${largura}px`;
  const { contexto, pagina } = await novaPagina(navegador, largura, rotulo, url);
  const enviadosAqui = [];
  try {
    // --- Login e lista de grupos
    await pagina.goto(`${url}/admin/#/conteudo`, { waitUntil: 'load' });
    await pagina.waitForSelector('.acesso input[name="email"]');
    await entrar(pagina);
    await pagina.waitForSelector('.pagina[data-pagina="conteudo"] .cms-grupos', { timeout: 20_000 });
    // Ao entrar, o painel confere a home publicada e publica se o conteúdo (ou o template) mudou.
    const aoEntrar = await esperarHomePublicada(url);
    conferir(aoEntrar.status === 200 && aoEntrar.cms === 'publicado', 'depois de entrar no painel, GET / entrega a home publicada (X-AMA-CMS: publicado)',
      `GET / depois de entrar: HTTP ${aoEntrar.status}, X-AMA-CMS: ${aoEntrar.cms}`);
    const grupos = await pagina.locator('.cms-grupo').count();
    conferir(grupos === 11, `#/conteudo lista os 11 grupos (com Identidade, sem Cabeçalho e menu)`, `#/conteudo mostrou ${grupos} grupos`);
    const qs = await cartaoDoGrupo(pagina, 'quem-somos');
    conferir(qs.titulo === 'Quem somos' && /Visível no site/.test(qs.selos) && /3 campos/.test(qs.selos),
      `cartão "Quem somos": ${qs.selos}`, `cartão "Quem somos" inesperado: ${JSON.stringify(qs)}`);
    const verSite = await pagina.locator('.pagina-cabecalho a', { hasText: 'Ver o site' }).getAttribute('href');
    conferir(verSite === '/', 'botão "Ver o site" leva para /', `"Ver o site" com href ${verSite}`);
    await capturar(pagina, `conteudo-lista-${largura}`);
    await semRolagemHorizontal(pagina, '#/conteudo');

    // --- Quem somos
    await pagina.locator('.cms-grupo[data-grupo="quem-somos"]').click();
    await pagina.waitForSelector('.cms-formulario [data-chave="quem-somos.titulo"] input');
    const h1 = (await pagina.locator('h1').textContent()).trim();
    conferir(h1 === 'Quem somos', 'grupo abre com o título "Quem somos"', `h1 do grupo: ${h1}`);
    conferir(await pagina.isVisible('.cms-visibilidade input[role="switch"]:checked'), 'interruptor "Mostrar esta seção no site" ligado', 'interruptor de visibilidade não apareceu ligado');
    await capturar(pagina, `quem-somos-${largura}`);
    await semRolagemHorizontal(pagina, 'Quem somos');

    // Editor rico: Negrito numa palavra, Link, Lista e Parágrafo; depois sai descartando.
    const seletorRico = '[data-chave="quem-somos.texto"] .cms-rico__area';
    if (!(await selecionarTexto(pagina, seletorRico, 'Associação'))) falhar('não achei o texto para selecionar no editor rico');
    await pagina.locator('[data-chave="quem-somos.texto"] .cms-rico__botao--negrito').click();
    const comNegrito = await pagina.locator(seletorRico).innerHTML();
    conferir(/<b>Associação<\/b>/.test(comNegrito), 'editor rico: botão Negrito aplicou <b>', `Negrito não aplicou: ${comNegrito.slice(0, 120)}`);
    await pagina.waitForSelector('[data-chave="quem-somos.texto"] .selo--ambar:not([hidden])');
    conferir(await pagina.isVisible('.topo__alterado'), 'aviso "Alterações não salvas" no topo', 'aviso de alterações não apareceu');
    // Link: selecionar, "Link", endereço sem https:// (completado) e "Aplicar link".
    await selecionarTexto(pagina, seletorRico, 'Ananindeua');
    await pagina.locator('[data-chave="quem-somos.texto"] .cms-rico__botao--link').click();
    const modalLink = pagina.locator('dialog.modal--cms-link[open]');
    await modalLink.waitFor();
    await modalLink.locator('input[name="endereco"]').fill('javascript:alert(1)');
    await modalLink.getByRole('button', { name: 'Aplicar link' }).click();
    const erroLink = (await modalLink.locator('.campo__erro').first().textContent()).trim();
    conferir(/não aceito/.test(erroLink), 'link com javascript: é recusado no editor', `erro do link: ${erroLink}`);
    await modalLink.locator('input[name="endereco"]').fill('www.ama.org.br');
    await modalLink.getByRole('button', { name: 'Aplicar link' }).click();
    await pagina.waitForSelector('dialog.modal--cms-link', { state: 'detached' });
    const comLink = await pagina.locator(seletorRico).innerHTML();
    conferir(/<a href="https:\/\/www\.ama\.org\.br" target="_blank">Ananindeua<\/a>/.test(comLink), 'editor rico: Link criado com o endereço completado',
      `link não criado: ${comLink.match(/<a[^>]*>[^<]*<\/a>/)?.[0] || comLink.slice(0, 160)}`);
    // Lista e Parágrafo.
    await selecionarTexto(pagina, seletorRico, 'Com uma história');
    await pagina.locator('[data-chave="quem-somos.texto"] .cms-rico__botao--lista').click();
    conferir(/<ul><li>Com uma história/.test(await pagina.locator(seletorRico).innerHTML()), 'editor rico: Lista transforma o parágrafo em lista', 'a lista não foi criada');
    await pagina.locator('[data-chave="quem-somos.texto"] .cms-rico__botao--paragrafo').click();
    conferir(!/<ul>/.test(await pagina.locator(seletorRico).innerHTML()), 'editor rico: Parágrafo tira a lista', 'a lista continuou depois de "Parágrafo"');
    await pagina.locator('.pagina-cabecalho__voltar').click();
    await responderConfirmacao(pagina, 'Descartar e sair');
    await pagina.waitForSelector('.pagina[data-pagina="conteudo"] .cms-grupos');
    await pagina.locator('.cms-grupo[data-grupo="quem-somos"]').click();
    await pagina.waitForSelector(seletorRico);
    const semNegrito = await pagina.locator(seletorRico).innerHTML();
    conferir(!/<b>|<a /.test(semNegrito), '"Descartar e sair" desfaz o que mudou no editor rico', 'o negrito ou o link continuou depois de descartar');

    // Título novo + aviso ao sair sem salvar.
    const tituloNovo = `Quem somos ${sufixo}`;
    await pagina.locator('[data-chave="quem-somos.titulo"] input').fill(tituloNovo);
    await pagina.locator('.pagina-cabecalho__voltar').click();
    const msgDescartar = await responderConfirmacao(pagina, 'Continuar editando');
    conferir(/alterações não salvas/.test(msgDescartar) && (await pagina.locator('[data-chave="quem-somos.titulo"] input').inputValue()) === tituloNovo,
      'sair sem salvar pede confirmação e "Continuar editando" mantém o texto', 'aviso de saída sem salvar falhou');

    // Sem prévia nos editores do site (nem o botão "Pré-visualizar" nem a prévia ao vivo).
    conferir(await pagina.locator('.cms-previsualizar, .cms-previa, .cms-previa__quadro').count() === 0, 'editor de "Quem somos" sem prévia', 'o editor ainda tem prévia');

    // Salvar: só a chave do título vai para o banco.
    await salvar(pagina, 'Quem somos');
    await capturar(pagina, `quem-somos-salvo-${largura}`, { inteira: false });
    const depoisTitulo = await linhas(CHAVES);
    conferir(depoisTitulo.get('quem-somos.titulo') === tituloNovo && !depoisTitulo.has('quem-somos.texto'),
      'conteudo_site recebeu só quem-somos.titulo', `linhas depois de salvar: ${JSON.stringify([...depoisTitulo])}`);
    let site = await home(url);
    conferir(site.status === 200 && site.cms === 'publicado' && textoDe(site.documento, '#sobre h2') === tituloNovo,
      'GET / (X-AMA-CMS: publicado) mostra o título novo', `GET / [${site.cms}] mostrou "${textoDe(site.documento, '#sobre h2')}"`);
    const selosTitulo = (await pagina.locator('[data-chave="quem-somos.titulo"] .cms-campo__estado').innerText()).trim();
    conferir(!selosTitulo && await pagina.getByRole('button', { name: 'Restaurar padrão' }).count() === 0,
      'campo salvo sem selo nem "Restaurar padrão"', `selos do título: ${selosTitulo}`);

    // --- Depoimentos (lista)
    await irPara(pagina, '#/conteudo/depoimentos', '[data-chave="depoimentos.itens"] .cms-item');
    const itens = () => pagina.locator('[data-chave="depoimentos.itens"] .cms-item');
    conferir(await itens().count() === 3, 'lista de depoimentos com 3 itens recolhidos', `depoimentos: ${await itens().count()} itens`);
    await itens().nth(1).locator('.cms-item__alternar').click();
    const corpo = pagina.locator('[data-chave="depoimentos.itens"] .cms-item__corpo');
    await corpo.waitFor();
    const nomeNovo = `Breno ${sufixo}`;
    await corpo.locator('.cms-subcampo[data-campo="nome"] input').fill(nomeNovo);
    const tituloItem = (await itens().nth(1).locator('.lista-ordenavel__titulo').textContent()).trim();
    conferir(tituloItem === nomeNovo, 'o título do item acompanha o nome digitado', `título do item: ${tituloItem}`);

    // Troca a foto por upload no seletor de mídia.
    await corpo.locator('.cms-subcampo[data-campo="foto"]').getByRole('button', { name: 'Trocar imagem' }).click();
    const seletor = pagina.locator('dialog.modal--midia[open]');
    await seletor.waitFor();
    await seletor.locator('.grade-midia .midia-item, .grade-midia .estado-vazio').first().waitFor({ timeout: 20_000 });
    const [escolha] = await Promise.all([
      pagina.waitForEvent('filechooser'),
      seletor.getByRole('button', { name: 'Escolher arquivo', exact: true }).click(),
    ]);
    await limparToasts(pagina);
    await escolha.setFiles({ name: `foto-depoimento-${sufixo}.png`, mimeType: 'image/png', buffer: gerarPng(320, [201, 152, 43], [31, 79, 51], [250, 247, 240]) });
    await esperarToast(pagina, 'Imagem enviada.');
    await seletor.locator('.midia-item[aria-selected="true"]').waitFor();
    await capturar(pagina, `seletor-midia-${largura}`, { inteira: false });
    await seletor.getByRole('button', { name: 'Usar esta imagem' }).click();
    await pagina.waitForSelector('dialog.modal--midia', { state: 'detached' });
    const srcNovo = await corpo.locator('.cms-subcampo[data-campo="foto"] .cms-midia__previa img').getAttribute('src');
    conferir(srcNovo && srcNovo.startsWith('/midia/site/') && srcNovo.includes(sufixo),
      'foto trocada pela enviada (/midia/site/...)', `src da prévia: ${srcNovo}`);
    const caminhoFoto = caminhoDaMidia(srcNovo);
    if (caminhoFoto) enviadosAqui.push(caminhoFoto);
    const respostaFoto = srcNovo ? await fetch(new URL(srcNovo, url)) : null;
    conferir(caminhoFoto && await armazenamento.existe(caminhoFoto) && respostaFoto && respostaFoto.ok
      && /^image\//.test(respostaFoto.headers.get('content-type') || ''),
    'foto gravada no armazenamento e servida pela URL pública',
    `foto ${caminhoFoto}: HTTP ${respostaFoto && respostaFoto.status} ${respostaFoto && respostaFoto.headers.get('content-type')}`);
    const alt = corpo.locator('.cms-subcampo[data-campo="foto"] input[name="alt"]');
    await alt.fill(`Foto de ${nomeNovo}`);
    await fecharToasts(pagina);

    // Sobe o item para o 1º lugar.
    await itens().nth(1).locator('[data-acao="subir"]').click();
    const primeiro = (await itens().nth(0).locator('.lista-ordenavel__titulo').textContent()).trim();
    conferir(primeiro === nomeNovo, '"Subir" levou o depoimento para o 1º lugar', `1º item depois de subir: ${primeiro}`);

    // Adiciona (nasce igual ao molde) e remove com confirmação; não há mais "Duplicar".
    await pagina.locator('[data-chave="depoimentos.itens"]').getByRole('button', { name: 'Adicionar depoimento' }).click();
    await pagina.waitForFunction(() => document.querySelectorAll('[data-chave="depoimentos.itens"] .cms-item').length === 4);
    const novo = itens().nth(3);
    const nomeMolde = await novo.locator('.cms-subcampo[data-campo="nome"] input').inputValue();
    conferir(nomeMolde === 'Doraci Silva' && await novo.locator('.aviso', { hasText: 'começa igual ao primeiro' }).count() === 1,
      'depoimento novo nasce com os valores do molde e explica isso', `item novo: nome "${nomeMolde}"`);
    await capturar(pagina, `depoimentos-${largura}`);
    await semRolagemHorizontal(pagina, 'Depoimentos');
    conferir(await pagina.locator('[data-chave="depoimentos.itens"] [data-acao="duplicar"]').count() === 0, 'sem botão "Duplicar"', 'a lista ainda tem "Duplicar"');
    await itens().nth(3).locator('[data-acao="remover"]').click();
    const msg = await responderConfirmacao(pagina, 'Remover', { capturaComo: `remover-item-${largura}` });
    conferir(/Remover "Doraci Silva" da lista\?/.test(msg), 'remover pede confirmação com o nome do item', `confirmação: ${msg}`);
    conferir(await itens().count() === 3, 'adicionar e remover voltaram a 3 itens', `itens depois: ${await itens().count()}`);
    await salvar(pagina, 'Depoimentos');
    const salvos = (await linhas(['depoimentos.itens'])).get('depoimentos.itens');
    conferir(Array.isArray(salvos) && salvos.length === 3 && salvos[0].nome === nomeNovo && salvos[0].foto.src === srcNovo
      && salvos[0].foto.alt === `Foto de ${nomeNovo}` && salvos[1].nome === 'Doraci Silva',
    'conteudo_site.depoimentos.itens com a ordem, o nome e a foto novos', `depoimentos salvos: ${JSON.stringify(salvos)}`);
    site = await home(url);
    const nomes = [...site.documento.querySelectorAll('#depoimentos [data-cms-campo="nome"]')].map((e) => e.textContent.trim());
    const foto = site.documento.querySelector('#depoimentos .depoimento img')?.getAttribute('src');
    conferir(site.cms === 'publicado' && nomes.join('|') === `${nomeNovo}|Doraci Silva|Maria Rita` && foto === srcNovo,
      'GET / mostra o depoimento editado em 1º, com a foto enviada', `GET / [${site.cms}] depoimentos: ${nomes.join(' | ')} / ${foto}`);

    // --- Parcerias: ocultar e mostrar de novo
    await irPara(pagina, '#/conteudo/parcerias', '.cms-visibilidade');
    await pagina.locator('.cms-visibilidade .interruptor').click();
    await salvar(pagina, 'Parcerias (ocultar)');
    site = await home(url);
    conferir(site.cms === 'publicado' && !site.documento.querySelector('#parcerias'), 'seção oculta some de GET /',
      `a seção #parcerias continuou em GET / [${site.cms}]`);
    await irPara(pagina, '#/conteudo', '.cms-grupos');
    const parc = await cartaoDoGrupo(pagina, 'parcerias');
    conferir(/Oculta no site/.test(parc.selos), 'cartão de "Parcerias" mostra "Oculta no site"', `cartão parcerias: ${parc.selos}`);
    if (largura === LARGURAS[0]) await capturar(pagina, `conteudo-lista-editada-${largura}`);
    await pagina.locator('.cms-grupo[data-grupo="parcerias"]').click();
    await pagina.waitForSelector('.cms-visibilidade');
    await pagina.locator('.cms-visibilidade .interruptor').click();
    await salvar(pagina, 'Parcerias (mostrar)');
    const visivel = await linhas(['grupo.parcerias.visivel']);
    site = await home(url);
    conferir(!visivel.size && site.cms === 'publicado' && site.documento.querySelector('#parcerias'), 'mostrar de novo apaga a linha e a seção volta',
      `parcerias: linha ${JSON.stringify([...visivel])}, seção ${Boolean(site.documento.querySelector('#parcerias'))} [${site.cms}]`);

    // --- Banner da Loja: as fotos são escolhidas entre os produtos
    await irPara(pagina, '#/conteudo/loja', '[data-chave="loja.imagem-1"] .cms-produto select');
    await pagina.waitForFunction(() => document.querySelectorAll('[data-chave="loja.imagem-1"] .cms-produto select option').length > 2, null, { timeout: 20_000 });
    conferir(await pagina.locator('.cms-produto').count() === 3 && await pagina.locator('[data-chave^="loja.imagem"] input[name="alt"]').count() === 0,
      'Banner da Loja: 3 seletores de produto, sem envio de foto nem texto alternativo', 'o banner ainda tem os campos de foto');
    await pagina.locator('[data-chave="loja.imagem-1"] .cms-produto select').selectOption({ label: 'Body Splash Raiz' });
    const fotoEscolhida = await pagina.locator('[data-chave="loja.imagem-1"] .cms-produto__foto img').getAttribute('src');
    await capturar(pagina, `banner-produtos-${largura}`, { inteira: false });
    await salvar(pagina, 'Banner da Loja');
    const banner = (await linhas(['loja.imagem-1'])).get('loja.imagem-1');
    site = await home(url);
    const imgSite = site.documento.querySelector('[data-cms="loja.imagem-1"]');
    conferir(banner && banner.alt === 'Body Splash Raiz' && banner.src === fotoEscolhida && site.cms === 'publicado'
      && imgSite && imgSite.getAttribute('src') === fotoEscolhida,
    'Banner: produto escolhido gravado (foto e nome do produto) e aplicado em GET /',
    `banner: ${JSON.stringify(banner)} / site [${site.cms}]: ${imgSite && imgSite.getAttribute('src')}`);
    await clienteServico().from('conteudo_site').delete().eq('chave', 'loja.imagem-1');

    // --- WhatsApp: número + mensagem padrão (sem endereço); o link é montado sozinho
    await irPara(pagina, '#/conteudo/whatsapp', '[data-chave="whatsapp.link"] input[name="numero"]');
    const textoWa = await pagina.locator('[data-chave="whatsapp.link"]').innerText();
    conferir(!/wa\.me|Endereço|Pode ser um site|Vale para o site todo/.test(textoWa) && await pagina.locator('[data-chave="whatsapp.link"] input[name="endereco"]').count() === 0,
      'WhatsApp: pede o número e a mensagem, sem endereço nem legendas de link', `texto do WhatsApp: ${textoWa}`);
    await pagina.locator('[data-chave="whatsapp.link"] input[name="numero"]').fill('91 98888-7777');
    await pagina.locator('[data-chave="whatsapp.link"] textarea[name="mensagem"]').fill(`Olá, AMA! Teste ${sufixo}`);
    await capturar(pagina, `whatsapp-${largura}`, { inteira: false });
    await salvar(pagina, 'WhatsApp');
    const linhaWa = (await linhas(['whatsapp.link'])).get('whatsapp.link');
    site = await home(url);
    const hrefs = [...site.documento.querySelectorAll('a[href*="wa.me/"]')].map((a) => a.getAttribute('href'));
    conferir(linhaWa && linhaWa.href === `https://wa.me/5591988887777?text=${encodeURIComponent(`Olá, AMA! Teste ${sufixo}`)}` && site.cms === 'publicado'
      && hrefs.length >= 6 && hrefs.every((h) => h.startsWith('https://wa.me/5591988887777')) && hrefs.every((h) => /[?&]text=/.test(h)),
    'WhatsApp: link montado com número e mensagem; vale para todos os links do site',
    `link salvo: ${linhaWa && linhaWa.href}; no site [${site.cms}]: ${hrefs.join(' | ')}`);
    await clienteServico().from('conteudo_site').delete().eq('chave', 'whatsapp.link');

    // --- Título salvo igual ao original: a linha é apagada e a home publicada volta ao original
    await clienteServico().from('conteudo_site').delete().eq('chave', 'depoimentos.itens');
    await irPara(pagina, '#/conteudo/quem-somos', '[data-chave="quem-somos.titulo"] input');
    await pagina.locator('[data-chave="quem-somos.titulo"] input').fill('Quem Somos');
    await salvar(pagina, 'Quem somos (original)');
    const restantes = await linhas(CHAVES);
    conferir(!restantes.size, 'valor igual ao original apaga a linha de conteudo_site', `linhas restantes: ${[...restantes.keys()].join(', ')}`);
    site = await home(url);
    const nomesDepois = [...site.documento.querySelectorAll('#depoimentos [data-cms-campo="nome"]')].map((e) => e.textContent.trim());
    conferir(site.cms === 'publicado' && textoDe(site.documento, '#sobre h2') === 'Quem Somos' && nomesDepois.join('|') === 'Doraci Silva|Breno Aquino|Maria Rita',
      'GET / (publicada de novo) voltou ao conteúdo original',
      `GET / [${site.cms}] depois de voltar ao original: ${textoDe(site.documento, '#sobre h2')} / ${nomesDepois.join(' | ')}`);

    // Grupo que não existe no template.
    await irPara(pagina, '#/conteudo/nao-existe', '.estado-vazio');
    const vazio = (await pagina.locator('.estado-vazio').textContent()).replace(/\s+/g, ' ');
    conferir(/Parte não encontrada/.test(vazio) && await pagina.locator('.estado-vazio a[href="#/conteudo"]').count() === 1,
      '#/conteudo/nao-existe: "Parte não encontrada" com volta para a lista', `grupo inexistente: ${vazio}`);

    // Outras telas só para conferir o visual.
    await irPara(pagina, '#/conteudo/historia', '[data-chave="historia.trechos"] .cms-item');
    await pagina.locator('[data-chave="historia.trechos"] .cms-item__alternar').first().click();
    await pagina.waitForSelector('[data-chave="historia.trechos"] .cms-item__corpo .cms-rico__area');
    await capturar(pagina, `historia-${largura}`);
    await semRolagemHorizontal(pagina, 'História');
    await irPara(pagina, '#/conteudo/seo', '.cms-meta-imagem');
    // Google mantém a prévia (resultado da busca e link compartilhado), que acompanha o que se digita.
    const tituloSeo = pagina.locator('[data-chave="seo.titulo"] input, [data-chave="seo.titulo"] textarea').first();
    const tituloSeoOriginal = await tituloSeo.inputValue();
    await tituloSeo.fill(`Título de busca ${sufixo}`);
    await pagina.waitForTimeout(400);
    conferir((await pagina.locator('.cms-google__titulo').textContent()).includes(`Título de busca ${sufixo}`)
      && await pagina.locator('.cms-google__cartao').count() === 1, 'Google: a prévia mostra o título digitado', 'a prévia do Google não acompanhou o título');
    await tituloSeo.fill(tituloSeoOriginal);
    await capturar(pagina, `seo-${largura}`);
    await semRolagemHorizontal(pagina, 'SEO');
    await irPara(pagina, '#/conteudo/postagens', '[data-chave="postagens.publicacoes"] .cms-item');
    await pagina.locator('[data-chave="postagens.publicacoes"] .cms-item__alternar').first().click();
    const estadoInsta = pagina.locator('.cms-instagram__estado--ok').first();
    await estadoInsta.waitFor();
    ok(`Instagram: "${(await estadoInsta.textContent()).trim()}"`);
    await pagina.locator('[data-chave="postagens.publicacoes"] .cms-instagram input').first().fill('https://www.instagram.com/oscdemulheres/');
    const naoReconhecido = (await pagina.locator('[data-chave="postagens.publicacoes"] .cms-instagram__estado').first().textContent()).trim();
    conferir(/não reconhecido/.test(naoReconhecido), 'endereço de perfil não é aceito como publicação', `estado: ${naoReconhecido}`);
    await limparToasts(pagina);
    await pagina.locator('.cms-salvar').click();
    await esperarToast(pagina, 'Confira o campo marcado em vermelho');
    const erroInsta = (await pagina.locator('[data-chave="postagens.publicacoes"] .campo__erro:not([hidden])').first().textContent()).trim();
    conferir(/Copiar link/.test(erroInsta), 'salvar com endereço inválido mostra o erro no campo e não grava', `erro: ${erroInsta}`);
    await capturar(pagina, `postagens-erro-${largura}`, { inteira: false, toasts: true });
    const postagens = await linhas(['postagens.publicacoes']);
    conferir(!postagens.size, 'nada foi gravado com o endereço inválido', 'gravou postagens.publicacoes com endereço inválido');
    // Sai descartando (o aviso de alterações está ligado).
    await pagina.locator('.pagina-cabecalho__voltar').click();
    await responderConfirmacao(pagina, 'Descartar e sair');
    await pagina.waitForSelector('.cms-grupos');
    ok('"Descartar e sair" volta para a lista de grupos');
  } finally {
    await contexto.close();
    for (const caminho of await arquivosDoTeste(sufixo)) if (!enviadosAqui.includes(caminho)) enviadosAqui.push(caminho);
    if (enviadosAqui.length) {
      try {
        for (const caminho of enviadosAqui) await armazenamento.apagar(caminho);
        console.log(`  arquivos de teste apagados: ${enviadosAqui.length}`);
      } catch (erro) {
        falhar(`não foi possível apagar ${enviadosAqui.join(', ')}: ${erro.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------

async function principal() {
  mkdirSync(SAIDA, { recursive: true });
  const local = ambienteLocal();
  if (!local.serviceKey) throw new Error('Chave de serviço do Supabase local não encontrada (rode "supabase start").');
  // Linhas que já existiam nas chaves usadas aqui: devolvidas no fim.
  const anteriores = await linhas([...CHAVES, 'postagens.publicacoes', 'loja.imagem-1', 'whatsapp.link']);
  if (anteriores.size) console.log(`Aviso: já havia conteúdo salvo em ${[...anteriores.keys()].join(', ')}; ele será devolvido no fim.`);
  if (anteriores.size) await clienteServico().from('conteudo_site').delete().in('chave', [...anteriores.keys()]);

  const navegador = await chromium.launch({ proxy: proxyDoAmbiente() });
  const pastaMidia = mkdtempSync(path.join(os.tmpdir(), 'ama-capturas-conteudo-midia-'));
  armazenamento = armazenamentoLocal(pastaMidia);
  let servidor = null;
  try {
    servidor = await subirServidor({
      ...AMBIENTE_VAZIO,
      SUPABASE_URL: local.url,
      SUPABASE_ANON_KEY: local.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: local.serviceKey,
    }, { armazenamento });
    // Pasta vazia: sem home publicada, GET / entrega o template.
    const inicial = await home(servidor.url);
    conferir(inicial.status === 200 && inicial.cms === 'padrao', 'antes de entrar no painel, GET / entrega o template (X-AMA-CMS: padrao)',
      `GET / antes de entrar: HTTP ${inicial.status}, X-AMA-CMS: ${inicial.cms}`);
    for (const largura of LARGURAS) await rodarLargura(navegador, servidor.url, largura);
  } finally {
    if (servidor) await servidor.fechar();
    await navegador.close();
    rmSync(pastaMidia, { recursive: true, force: true });
    const servico = clienteServico();
    const { error } = await servico.from('conteudo_site').delete().in('chave', [...CHAVES, 'postagens.publicacoes', 'loja.imagem-1', 'whatsapp.link']);
    if (error) console.log(`Aviso: não foi possível apagar as chaves de teste: ${error.message}`);
    if (anteriores.size) {
      const { error: erroVolta } = await servico.from('conteudo_site')
        .upsert([...anteriores].map(([chave, valor]) => ({ chave, valor })), { onConflict: 'chave' });
      if (erroVolta) console.log(`Aviso: não foi possível devolver o conteúdo anterior: ${erroVolta.message}`);
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
