#!/usr/bin/env node
// Capturas e verificação das páginas "Conteúdo do site" e "Mídia" do painel (Playwright + Supabase local).
//
// Uso: node scripts/capturas-painel-conteudo.mjs [--saida <pasta>] [--larguras 390,1440]
//      (padrão da saída: <tmp>/capturas-painel-conteudo)
//
// Em cada largura, com dados próprios (sufixo aleatório):
// - #/conteudo: cartões dos grupos (quantos campos, visível/oculta, editado ou original);
// - "Quem somos": aviso de alterações não salvas, editor rico (Negrito) desfeito com "Restaurar padrão",
//   título novo, pré-visualização numa aba nova (Blob URL com <base>), "Salvar" grava só a chave mudada
//   e GET / (renderizado no servidor) mostra o título novo;
// - "Depoimentos": abre um item, muda o nome, troca a foto por upload (seletor de mídia), sobe o item,
//   adiciona um item (nasce igual ao molde), duplica e remove com confirmação; salva e confere em GET /;
// - "Parcerias": desliga "Mostrar esta seção no site" (some de GET /) e liga de novo (a linha é apagada);
// - #/midia: a foto enviada aparece em uso ("Depoimentos") na confirmação de apagar; envio de 2 fotos de
//   uma vez, busca, copiar endereço, apagar com confirmação, aba Vídeos e busca sem resultado;
// - "Restaurar padrão" do título e da lista de depoimentos: as linhas somem e GET / volta ao original.
// No fim apaga as chaves de conteudo_site criadas (e devolve as que já existiam) e os arquivos enviados.
// Falha (código 1) com erro no console/página, rolagem horizontal ou verificação errada.

import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { parseHTML } from 'linkedom';
import { chromium } from 'playwright';
import { AMBIENTE_VAZIO, subirServidor } from '../tests/apoio/servidor.js';
import { ambienteLocal, clienteServico } from '../tests/apoio/supabase-local.js';

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

async function home(url) {
  const resposta = await fetch(`${url}/`);
  const html = await resposta.text();
  return { status: resposta.status, cms: resposta.headers.get('x-ama-cms'), documento: parseHTML(html).document };
}

const textoDe = (doc, seletor) => (doc.querySelector(seletor)?.textContent || '').replace(/\s+/g, ' ').trim();

// Arquivos do bucket com o sufixo no nome (para a limpeza), em todas as pastas e meses.
async function arquivosDoTeste(sufixo) {
  const storage = clienteServico().storage.from('midia');
  const achados = [];
  for (const pasta of ['site', 'produtos', 'videos']) {
    const { data: meses } = await storage.list(pasta, { limit: 1000 });
    for (const mes of meses || []) {
      if (mes.id) continue;
      const { data } = await storage.list(`${pasta}/${mes.name}`, { limit: 1000 });
      for (const a of data || []) if (a.name.includes(sufixo)) achados.push(`${pasta}/${mes.name}/${a.name}`);
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
  await esperarToast(pagina, 'Salvo! O site mostra as mudanças em até 15 segundos');
  await pagina.waitForSelector('.cms-salvar:not([aria-busy="true"])');
  await pagina.waitForTimeout(300); // passa o atraso (150 ms) da atualização dos selos
  const info = (await pagina.locator('.cms-barra__info').textContent()).trim();
  const pendentes = await pagina.evaluate(() => [...document.querySelectorAll('.cms-campo')]
    .filter((c) => c.querySelector('.selo--ambar:not([hidden])')).map((c) => c.dataset.chave));
  conferir(/^Salvo! O site mostra as mudanças em até 15 segundos/.test(info) && await pagina.locator('.cms-barra__info a', { hasText: 'Ver no site' }).count() === 1,
    `${onde}: depois de salvar, "Salvo! O site mostra as mudanças em até 15 segundos" + "Ver no site"`,
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
    const grupos = await pagina.locator('.cms-grupo').count();
    conferir(grupos === 11, `#/conteudo lista os 11 grupos do template`, `#/conteudo mostrou ${grupos} grupos`);
    const qs = await cartaoDoGrupo(pagina, 'quem-somos');
    conferir(qs.titulo === 'Quem somos' && /Visível no site/.test(qs.selos) && /Conteúdo original/.test(qs.selos) && /3 campos/.test(qs.selos),
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

    // Editor rico: Negrito numa palavra, depois "Restaurar padrão" (sem linha no banco = desfaz).
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
    await limparToasts(pagina);
    await pagina.locator('[data-chave="quem-somos.texto"] .cms-campo__restaurar').click();
    const msgDesfazer = await responderConfirmacao(pagina, 'Restaurar padrão');
    conferir(/Desfazer o que você mudou/.test(msgDesfazer), 'restaurar sem linha no banco só desfaz o rascunho', `mensagem de restaurar: ${msgDesfazer}`);
    const semNegrito = await pagina.locator(seletorRico).innerHTML();
    conferir(!/<b>|<a /.test(semNegrito), 'editor rico voltou ao texto original', 'o negrito ou o link continuou depois de restaurar');
    await fecharToasts(pagina);

    // Título novo + aviso ao sair sem salvar.
    const tituloNovo = `Quem somos ${sufixo}`;
    await pagina.locator('[data-chave="quem-somos.titulo"] input').fill(tituloNovo);
    await pagina.locator('.pagina-cabecalho__voltar').click();
    const msgDescartar = await responderConfirmacao(pagina, 'Continuar editando');
    conferir(/alterações não salvas/.test(msgDescartar) && (await pagina.locator('[data-chave="quem-somos.titulo"] input').inputValue()) === tituloNovo,
      'sair sem salvar pede confirmação e "Continuar editando" mantém o texto', 'aviso de saída sem salvar falhou');

    // Pré-visualizar (aba nova com Blob URL).
    const [previa] = await Promise.all([contexto.waitForEvent('page'), pagina.locator('.cms-previsualizar').click()]);
    await previa.waitForLoadState('load');
    const dadosPrevia = await previa.evaluate(() => ({
      url: window.location.href,
      base: document.querySelector('base')?.getAttribute('href'),
      titulo: document.querySelector('[data-cms="quem-somos.titulo"]')?.textContent,
      faixa: document.querySelector('[data-previa-painel]')?.textContent,
      css: [...document.styleSheets].some((f) => /\/css\/estilo\.css$/.test(f.href || '')),
    }));
    conferir(dadosPrevia.url.startsWith('blob:') && dadosPrevia.base === `${url}/` && dadosPrevia.titulo === tituloNovo && dadosPrevia.css,
      'pré-visualização: Blob URL, <base> na origem, rascunho aplicado e CSS do site', `pré-visualização: ${JSON.stringify(dadosPrevia)}`);
    conferir(/ainda não foram salvas/.test(dadosPrevia.faixa || ''), 'pré-visualização avisa que não está salvo', `faixa: ${dadosPrevia.faixa}`);
    await previa.setViewportSize({ width: largura, height: ALTURAS[largura] || 900 });
    await previa.evaluate(() => document.querySelector('#sobre')?.scrollIntoView());
    await capturar(previa, `previa-quem-somos-${largura}`, { inteira: false });
    await previa.close();

    // Salvar: só a chave do título vai para o banco.
    await salvar(pagina, 'Quem somos');
    await capturar(pagina, `quem-somos-salvo-${largura}`, { inteira: false });
    const depoisTitulo = await linhas(CHAVES);
    conferir(depoisTitulo.get('quem-somos.titulo') === tituloNovo && !depoisTitulo.has('quem-somos.texto'),
      'conteudo_site recebeu só quem-somos.titulo', `linhas depois de salvar: ${JSON.stringify([...depoisTitulo])}`);
    let site = await home(url);
    conferir(site.status === 200 && textoDe(site.documento, '#sobre h2') === tituloNovo,
      `GET / mostra o título novo (${site.cms || 'sem cabeçalho'})`, `GET / mostrou "${textoDe(site.documento, '#sobre h2')}"`);
    const selosTitulo = (await pagina.locator('[data-chave="quem-somos.titulo"] .cms-campo__estado').textContent()).replace(/\s+/g, ' ');
    conferir(/Editado/.test(selosTitulo) && await pagina.isVisible('[data-chave="quem-somos.titulo"] .cms-campo__restaurar'),
      'campo salvo ganha o selo "Editado" e "Restaurar padrão"', `selos do título: ${selosTitulo}`);

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
    conferir(srcNovo && srcNovo.includes('/storage/v1/object/public/midia/site/') && srcNovo.includes(sufixo),
      'foto trocada pela enviada (pasta site/)', `src da prévia: ${srcNovo}`);
    if (srcNovo) enviadosAqui.push(decodeURIComponent(srcNovo.split('/object/public/midia/')[1] || ''));
    const alt = corpo.locator('.cms-subcampo[data-campo="foto"] input[name="alt"]');
    await alt.fill(`Foto de ${nomeNovo}`);
    await fecharToasts(pagina);

    // Sobe o item para o 1º lugar.
    await itens().nth(1).locator('[data-acao="subir"]').click();
    const primeiro = (await itens().nth(0).locator('.lista-ordenavel__titulo').textContent()).trim();
    conferir(primeiro === nomeNovo, '"Subir" levou o depoimento para o 1º lugar', `1º item depois de subir: ${primeiro}`);

    // Adiciona (nasce igual ao molde), duplica e remove com confirmação.
    await pagina.locator('[data-chave="depoimentos.itens"]').getByRole('button', { name: 'Adicionar depoimento' }).click();
    await pagina.waitForFunction(() => document.querySelectorAll('[data-chave="depoimentos.itens"] .cms-item').length === 4);
    const novo = itens().nth(3);
    const nomeMolde = await novo.locator('.cms-subcampo[data-campo="nome"] input').inputValue();
    conferir(nomeMolde === 'Doraci Silva' && await novo.locator('.aviso', { hasText: 'começa igual ao primeiro' }).count() === 1,
      'depoimento novo nasce com os valores do molde e explica isso', `item novo: nome "${nomeMolde}"`);
    await capturar(pagina, `depoimentos-${largura}`);
    await semRolagemHorizontal(pagina, 'Depoimentos');
    await novo.locator('[data-acao="duplicar"]').click();
    await pagina.waitForFunction(() => document.querySelectorAll('[data-chave="depoimentos.itens"] .cms-item').length === 5);
    for (const indice of [4, 3]) {
      await itens().nth(indice).locator('[data-acao="remover"]').click();
      const msg = await responderConfirmacao(pagina, 'Remover', { capturaComo: indice === 4 ? `remover-item-${largura}` : null });
      if (indice === 4) conferir(/Remover "Doraci Silva" da lista\?/.test(msg), 'remover pede confirmação com o nome do item', `confirmação: ${msg}`);
    }
    conferir(await itens().count() === 3, 'adicionar, duplicar e remover voltaram a 3 itens', `itens depois: ${await itens().count()}`);
    await salvar(pagina, 'Depoimentos');
    const salvos = (await linhas(['depoimentos.itens'])).get('depoimentos.itens');
    conferir(Array.isArray(salvos) && salvos.length === 3 && salvos[0].nome === nomeNovo && salvos[0].foto.src === srcNovo
      && salvos[0].foto.alt === `Foto de ${nomeNovo}` && salvos[1].nome === 'Doraci Silva',
    'conteudo_site.depoimentos.itens com a ordem, o nome e a foto novos', `depoimentos salvos: ${JSON.stringify(salvos)}`);
    site = await home(url);
    const nomes = [...site.documento.querySelectorAll('#depoimentos [data-cms-campo="nome"]')].map((e) => e.textContent.trim());
    const foto = site.documento.querySelector('#depoimentos .depoimento img')?.getAttribute('src');
    conferir(nomes.join('|') === `${nomeNovo}|Doraci Silva|Maria Rita` && foto === srcNovo,
      'GET / mostra o depoimento editado em 1º, com a foto enviada', `GET / depoimentos: ${nomes.join(' | ')} / ${foto}`);

    // --- Parcerias: ocultar e mostrar de novo
    await irPara(pagina, '#/conteudo/parcerias', '.cms-visibilidade');
    await pagina.locator('.cms-visibilidade .interruptor').click();
    await salvar(pagina, 'Parcerias (ocultar)');
    site = await home(url);
    conferir(!site.documento.querySelector('#parcerias'), 'seção oculta some de GET /', 'a seção #parcerias continuou em GET /');
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
    conferir(!visivel.size && site.documento.querySelector('#parcerias'), 'mostrar de novo apaga a linha e a seção volta',
      `parcerias: linha ${JSON.stringify([...visivel])}, seção ${Boolean(site.documento.querySelector('#parcerias'))}`);

    // --- Restaurar padrão (apaga as linhas) e conferir que GET / voltou
    await irPara(pagina, '#/conteudo/quem-somos', '[data-chave="quem-somos.titulo"] .cms-campo__restaurar');
    await limparToasts(pagina);
    await pagina.locator('[data-chave="quem-somos.titulo"] .cms-campo__restaurar').click();
    const msgRestaurar = await responderConfirmacao(pagina, 'Restaurar padrão', { capturaComo: `restaurar-padrao-${largura}` });
    conferir(/versão salva pelo painel será apagada/.test(msgRestaurar), 'restaurar com linha no banco explica que a versão salva será apagada', `mensagem: ${msgRestaurar}`);
    await esperarToast(pagina, 'Padrão restaurado');
    const valorTitulo = await pagina.locator('[data-chave="quem-somos.titulo"] input').inputValue();
    conferir(valorTitulo === 'Quem Somos', 'o campo voltou ao texto original', `campo depois de restaurar: ${valorTitulo}`);
    await irPara(pagina, '#/conteudo/depoimentos', '[data-chave="depoimentos.itens"] .cms-campo__restaurar');
    await limparToasts(pagina);
    await pagina.locator('[data-chave="depoimentos.itens"] .cms-campo__restaurar').click();
    await responderConfirmacao(pagina, 'Restaurar padrão');
    await esperarToast(pagina, 'Padrão restaurado');
    const restantes = await linhas(CHAVES);
    conferir(!restantes.size, 'restaurar padrão apagou as linhas de conteudo_site', `linhas restantes: ${[...restantes.keys()].join(', ')}`);
    site = await home(url);
    const nomesDepois = [...site.documento.querySelectorAll('#depoimentos [data-cms-campo="nome"]')].map((e) => e.textContent.trim());
    conferir(textoDe(site.documento, '#sobre h2') === 'Quem Somos' && nomesDepois.join('|') === 'Doraci Silva|Breno Aquino|Maria Rita',
      'GET / voltou ao conteúdo original', `GET / depois de restaurar: ${textoDe(site.documento, '#sobre h2')} / ${nomesDepois.join(' | ')}`);

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
      const { error } = await clienteServico().storage.from('midia').remove(enviadosAqui.filter(Boolean));
      if (error) falhar(`não foi possível apagar ${enviadosAqui.join(', ')}: ${error.message}`);
      else console.log(`  arquivos de teste apagados: ${enviadosAqui.length}`);
    }
  }
}

// ---------------------------------------------------------------------------

async function principal() {
  mkdirSync(SAIDA, { recursive: true });
  const local = ambienteLocal();
  if (!local.serviceKey) throw new Error('Chave de serviço do Supabase local não encontrada (rode "supabase start").');
  // Linhas que já existiam nas chaves usadas aqui: devolvidas no fim.
  const anteriores = await linhas([...CHAVES, 'postagens.publicacoes']);
  if (anteriores.size) console.log(`Aviso: já havia conteúdo salvo em ${[...anteriores.keys()].join(', ')}; ele será devolvido no fim.`);
  if (anteriores.size) await clienteServico().from('conteudo_site').delete().in('chave', [...anteriores.keys()]);

  const navegador = await chromium.launch({ proxy: proxyDoAmbiente() });
  const servidor = await subirServidor({
    ...AMBIENTE_VAZIO,
    SUPABASE_URL: local.url,
    SUPABASE_ANON_KEY: local.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: local.serviceKey,
  });
  try {
    for (const largura of LARGURAS) await rodarLargura(navegador, servidor.url, largura);
  } finally {
    await servidor.fechar();
    await navegador.close();
    const servico = clienteServico();
    const { error } = await servico.from('conteudo_site').delete().in('chave', [...CHAVES, 'postagens.publicacoes']);
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
