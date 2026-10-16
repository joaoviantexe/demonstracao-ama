#!/usr/bin/env node
// Compara, pixel a pixel, a home renderizada pelo projeto (templates/home.html servido pelo
// dev-server) com a home do site estático original (commit b289daa, o último da main antes do novo
// projeto: index.html, css/estilo.css, js/main.js + public/img).
//
// Uso: node scripts/comparar-home.mjs [--ref b289daa] [--larguras 1440,768,390]
//
// - Animações desligadas nos dois lados (prefers-reduced-motion, .reveal visível, sem transições),
//   iframes do Instagram escondidos (não carregam aqui), vídeo pausado e escondido.
// - Captura cada seção equivalente nos tamanhos pedidos e compara desenhando os dois PNGs num
//   <canvas> dentro do próprio Chromium (sem dependências).
// - Salva os PNGs (main, novo e diferença) em tests/e2e/capturas/comparacao/<largura>/.
// - Sai com código 1 se alguma região que não devia mudar ficou diferente.

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { iniciarServidor } from './dev-server.mjs';

const RAIZ = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SAIDA = path.join(RAIZ, 'tests', 'e2e', 'capturas', 'comparacao');

function argumento(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const REF = argumento('ref', 'b289daa');
const LARGURAS = argumento('larguras', '1440,768,390').split(',').map(Number).filter(Boolean);
const ALTURAS = { 1440: 900, 768: 1024, 390: 844 };

// Regiões comparadas. `muda: true` = mudança pedida (só informativo).
const REGIOES = [
  { nome: 'cabecalho', seletor: '.topo', fixo: true, muda: true },
  { nome: 'quem-somos', seletor: '#sobre' },
  { nome: 'postagens', seletor: '#redes', muda: true },
  { nome: 'projetos', seletor: '#cursos' },
  { nome: 'historia', seletor: '#historia' },
  { nome: 'depoimentos', seletor: '#depoimentos' },
  { nome: 'parcerias', seletor: '#parcerias' },
  { nome: 'rodape', seletor: 'footer.rodape' },
  { nome: 'whatsapp', seletor: '.wa-flutuante', fixo: true, noFim: true },
  { nome: 'menu-mobile', seletor: '#menu-mobile', menu: true, muda: true },
];
// Só de um lado (capturadas para olhar, não comparadas).
const SO_MAIN = [{ nome: 'biojoias', seletor: '#biojoias' }];
const SO_NOVO = [{ nome: 'loja', seletor: '#loja' }];

// Estabiliza a página: sem animações, sem iframes do Instagram, sem quadro de vídeo.
const CSS_ESTAVEL = `
  *,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}
  .reveal{opacity:1!important;transform:none!important}
  html{scroll-behavior:auto!important}
  iframe{visibility:hidden!important}
  .player-video video{display:none!important}
  .pv-progresso-buffer{visibility:hidden!important}
`;
const CSS_SEM_FIXOS = '.topo,.wa-flutuante{visibility:hidden!important}';

// ---------------------------------------------------------------------------
// Servidores

function gitShow(arquivo) {
  return execFileSync('git', ['show', `${REF}:${arquivo}`], { cwd: RAIZ, maxBuffer: 64 * 1024 * 1024 });
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.mp4': 'video/mp4', '.svg': 'image/svg+xml',
};

// Servidor estático mínimo com a home da main (imagens de public/img, com Range para o vídeo).
function servidorMain() {
  const arquivos = new Map([
    ['/index.html', gitShow('index.html')],
    ['/css/estilo.css', gitShow('css/estilo.css')],
    ['/js/main.js', gitShow('js/main.js')],
  ]);
  const dirImg = path.join(RAIZ, 'public', 'img');
  const servidor = http.createServer((req, res) => {
    const caminho = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const chave = caminho === '/' ? '/index.html' : caminho;
    const tipo = TIPOS[path.extname(chave).toLowerCase()] || 'application/octet-stream';
    if (arquivos.has(chave)) {
      res.writeHead(200, { 'Content-Type': tipo });
      res.end(arquivos.get(chave));
      return;
    }
    const arquivo = path.join(dirImg, path.normalize(chave.replace(/^\/img\//, '/')));
    if (!chave.startsWith('/img/') || !arquivo.startsWith(dirImg + path.sep)) {
      res.writeHead(404).end();
      return;
    }
    let info;
    try {
      info = statSync(arquivo);
    } catch {
      res.writeHead(404).end();
      return;
    }
    const faixa = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (faixa) {
      const inicio = faixa[1] ? Number(faixa[1]) : 0;
      const fim = faixa[2] ? Math.min(Number(faixa[2]), info.size - 1) : info.size - 1;
      res.writeHead(206, {
        'Content-Type': tipo, 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${inicio}-${fim}/${info.size}`, 'Content-Length': fim - inicio + 1,
      });
      createReadStream(arquivo, { start: inicio, end: fim }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': tipo, 'Content-Length': info.size, 'Accept-Ranges': 'bytes' });
    createReadStream(arquivo).pipe(res);
  });
  return new Promise((resolver) => {
    servidor.listen(0, '127.0.0.1', () => {
      resolver({
        url: `http://127.0.0.1:${servidor.address().port}`,
        fechar: () => new Promise((r) => { servidor.closeAllConnections?.(); servidor.close(() => r()); }),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Captura

async function prepararPagina(pagina) {
  await pagina.addStyleTag({ content: CSS_ESTAVEL });
  await pagina.evaluate(async () => {
    const imagens = Array.from(document.images);
    for (const img of imagens) img.loading = 'eager';
    await Promise.all(imagens.map((img) => (img.complete ? Promise.resolve() : new Promise((r) => {
      img.addEventListener('load', r, { once: true });
      img.addEventListener('error', r, { once: true });
    }))));
    await Promise.all(imagens.map((img) => (img.decode ? img.decode().catch(() => {}) : null)));

    const video = document.querySelector('#player-institucional video');
    if (video) {
      if (video.readyState < 1) {
        await new Promise((r) => {
          video.addEventListener('loadedmetadata', r, { once: true });
          setTimeout(r, 5000);
        });
      }
      video.pause();
      video.currentTime = 0;
      await new Promise((r) => setTimeout(r, 100));
    }
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
  await pagina.waitForTimeout(150);
}

async function retangulo(pagina, seletor) {
  return pagina.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  }, seletor);
}

function arredondar(r, largura) {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  return {
    x, y,
    width: Math.min(largura, Math.ceil(r.x + r.width)) - x,
    height: Math.ceil(r.y + r.height) - y,
  };
}

async function capturar(pagina, regiao, largura) {
  if (regiao.menu) {
    const visivel = await pagina.locator('[data-abrir-menu]').isVisible();
    if (!visivel) return null;
    await pagina.click('[data-abrir-menu]');
    await pagina.waitForTimeout(100);
    const png = await pagina.screenshot();
    await pagina.click('[data-fechar-menu]');
    await pagina.waitForTimeout(50);
    return png;
  }
  if (regiao.fixo) {
    // O botão do WhatsApp é capturado no fim da página, sobre o fundo liso do rodapé.
    await pagina.evaluate((noFim) => window.scrollTo(0, noFim ? document.documentElement.scrollHeight : 0), !!regiao.noFim);
    await pagina.waitForTimeout(50);
    const r = await pagina.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: b.left, y: b.top, width: b.width, height: b.height };
    }, regiao.seletor);
    if (!r || !r.width) return null;
    const png = await pagina.screenshot({ clip: arredondar(r, largura) });
    await pagina.evaluate(() => window.scrollTo(0, 0));
    return png;
  }
  const estilo = await pagina.addStyleTag({ content: CSS_SEM_FIXOS });
  const r = await retangulo(pagina, regiao.seletor);
  let png = null;
  if (r) png = await pagina.screenshot({ fullPage: true, clip: arredondar(r, largura) });
  await estilo.evaluate((el) => el.remove());
  return png;
}

// ---------------------------------------------------------------------------
// Comparação no <canvas>

async function compararPngs(paginaComparacao, pngA, pngB) {
  return paginaComparacao.evaluate(async ([a64, b64]) => {
    const carregar = (b64) => new Promise((ok, erro) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => erro(new Error('PNG inválido'));
      img.src = `data:image/png;base64,${b64}`;
    });
    const [a, b] = await Promise.all([carregar(a64), carregar(b64)]);
    const largura = Math.max(a.width, b.width);
    const altura = Math.max(a.height, b.height);
    const pixels = (img) => {
      const c = document.createElement('canvas');
      c.width = largura;
      c.height = altura;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, largura, altura).data;
    };
    const pa = pixels(a);
    const pb = pixels(b);
    const saida = document.createElement('canvas');
    saida.width = largura;
    saida.height = altura;
    const ctx = saida.getContext('2d');
    const diff = ctx.createImageData(largura, altura);
    const d = diff.data;
    let diferentes = 0;
    let fortes = 0;
    for (let y = 0; y < altura; y++) {
      for (let x = 0; x < largura; x++) {
        const i = (y * largura + x) * 4;
        const dentro = x < a.width && y < a.height && x < b.width && y < b.height;
        const delta = dentro
          ? Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) + Math.abs(pa[i + 3] - pb[i + 3])
          : 1020;
        if (delta > 0) {
          diferentes++;
          if (delta > 48) fortes++;
          d[i] = 255; d[i + 1] = dentro ? 0 : 0; d[i + 2] = dentro ? 0 : 255; d[i + 3] = 255;
        } else {
          const cinza = (pa[i] * 0.3 + pa[i + 1] * 0.59 + pa[i + 2] * 0.11) * 0.25 + 191;
          d[i] = cinza; d[i + 1] = cinza; d[i + 2] = cinza; d[i + 3] = 255;
        }
      }
    }
    ctx.putImageData(diff, 0, 0);
    return {
      tamanhoA: [a.width, a.height],
      tamanhoB: [b.width, b.height],
      total: largura * altura,
      diferentes,
      fortes,
      png: saida.toDataURL('image/png').split(',')[1],
    };
  }, [pngA.toString('base64'), pngB.toString('base64')]);
}

// ---------------------------------------------------------------------------

// Com HTTPS_PROXY (ambientes com proxy de saída), as fontes do Google passam pelo proxy e os
// servidores locais não: o Playwright força "<-loopback>" (loopback pelo proxy) se não for desligado.
function proxyDoAmbiente() {
  const servidor = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!servidor) return undefined;
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  return { server: servidor, bypass: '127.0.0.1,localhost' };
}

async function abrir(navegador, url, largura, erros) {
  const contexto = await navegador.newContext({
    viewport: { width: largura, height: ALTURAS[largura] || 900 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const pagina = await contexto.newPage();
  // O Instagram não é acessível daqui: bloqueado nos dois lados.
  await pagina.route(/instagram\.com/, (rota) => rota.abort());
  // Google Fonts pelo lado Node do Playwright (verifica TLS com NODE_EXTRA_CA_CERTS e usa o proxy).
  await pagina.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, async (rota) => {
    try {
      await rota.fulfill({ response: await rota.fetch() });
    } catch {
      await rota.abort().catch(() => {});
    }
  });
  if (erros) {
    pagina.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
    pagina.on('console', (m) => {
      if (m.type() !== 'error') return;
      const origem = (m.location() && m.location().url) || '';
      if (/instagram\.com/.test(origem) || /instagram\.com/.test(m.text())) return;
      erros.push(`console: ${m.text()} ${origem}`);
    });
  }
  await pagina.goto(url, { waitUntil: 'load', timeout: 60000 });
  await prepararPagina(pagina);
  return { contexto, pagina };
}

// O banner da loja fica depois de História (ordem do documento); na main a vitrine de biojoias vinha
// antes dela (order 4). E o banner tem outra altura que a vitrine: as seções seguintes começariam em
// outra posição (outra fração de pixel e outra grade de "tiles" de rasterização do Chromium) e o texto
// e as fotos sairiam com antisserrilhado ligeiramente diferente. Para comparar só o que mudou de
// verdade, durante a captura a vitrine da main vai para o lugar do banner (depois de História) e o
// banner ocupa exatamente a altura da vitrine (espaço extra dentro dele, acima da borda inferior).
// Se o banner for mais alto, iguala ao menos a fração de pixel.
async function alinharPosicao(paginaMain, paginaNovo) {
  const ordem = (pagina, sel) => pagina.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? Number(getComputedStyle(el).order) : null;
  }, sel);
  const ordemLoja = await ordem(paginaNovo, '#loja');
  if (ordemLoja !== null && ordemLoja !== await ordem(paginaMain, '#biojoias')) {
    // Empate com #historia: o desempate segue o documento, onde #biojoias vem depois de #historia.
    await paginaMain.addStyleTag({ content: `#biojoias{order:${ordemLoja}!important}` });
  }
  const altura = (pagina, sel) => pagina.evaluate((s) => {
    const el = document.querySelector(s);
    return el ? el.getBoundingClientRect().height : null;
  }, sel);
  const hMain = await altura(paginaMain, '#biojoias');
  const hNovo = await altura(paginaNovo, '#loja');
  if (hMain === null || hNovo === null) return null;
  if (hNovo <= hMain) {
    await paginaNovo.addStyleTag({ content: `#loja{min-height:${hMain}px!important}` });
    return { modo: 'altura', delta: hMain - hNovo };
  }
  const delta = (((hMain - hNovo) % 1) + 1) % 1;
  if (delta > 0.001 && delta < 0.999) {
    await paginaNovo.addStyleTag({ content: `#loja>.wrap{margin-bottom:${delta}px!important}` });
  }
  return { modo: 'fracao', delta };
}

const pct = (n, total) => (total ? (100 * n / total) : 0).toFixed(4);

async function main() {
  // A home do projeto sempre com o conteúdo padrão do template (sem Supabase).
  for (const nome of Object.keys(process.env)) {
    if (/SUPABASE/.test(nome)) delete process.env[nome];
  }
  const ladoMain = await servidorMain();
  const ladoNovo = await iniciarServidor({ porta: 0, host: '127.0.0.1' });
  const navegador = await chromium.launch({ proxy: proxyDoAmbiente() });
  const paginaComparacao = await (await navegador.newContext()).newPage();
  await paginaComparacao.setContent('<!doctype html><title>comparação</title>');

  rmSync(SAIDA, { recursive: true, force: true });
  const linhas = [];
  const errosNovo = [];
  let falhou = false;

  try {
    for (const largura of LARGURAS) {
      const pasta = path.join(SAIDA, String(largura));
      mkdirSync(pasta, { recursive: true });
      const a = await abrir(navegador, `${ladoMain.url}/`, largura, null);
      const b = await abrir(navegador, `${ladoNovo.url}/`, largura, errosNovo);
      // Regiões de um lado só (para olhar), antes do alinhamento.
      for (const [lado, regioes] of [[a, SO_MAIN], [b, SO_NOVO]]) {
        for (const regiao of regioes) {
          const png = await capturar(lado.pagina, regiao, largura);
          if (png) writeFileSync(path.join(pasta, `${regiao.nome}-${lado === a ? 'main' : 'novo'}.png`), png);
        }
      }
      const ajuste = await alinharPosicao(a.pagina, b.pagina);
      if (ajuste) {
        console.log(ajuste.modo === 'altura'
          ? `${largura}px: banner da loja esticado em +${ajuste.delta.toFixed(3)}px na captura (mesma altura da vitrine antiga)`
          : `${largura}px: banner mais alto que a vitrine antiga; fração de pixel alinhada em +${ajuste.delta.toFixed(3)}px`);
      }

      for (const regiao of REGIOES) {
        const pngA = await capturar(a.pagina, regiao, largura);
        const pngB = await capturar(b.pagina, regiao, largura);
        if (!pngA && !pngB) continue;
        if (!pngA || !pngB) {
          linhas.push({ largura, regiao: regiao.nome, obs: `só existe em ${pngA ? 'main' : 'novo'}` });
          if (!regiao.muda) falhou = true;
          continue;
        }
        writeFileSync(path.join(pasta, `${regiao.nome}-main.png`), pngA);
        writeFileSync(path.join(pasta, `${regiao.nome}-novo.png`), pngB);
        const r = await compararPngs(paginaComparacao, pngA, pngB);
        writeFileSync(path.join(pasta, `${regiao.nome}-diff.png`), Buffer.from(r.png, 'base64'));
        const mesmoTamanho = r.tamanhoA.join('x') === r.tamanhoB.join('x');
        linhas.push({
          largura,
          regiao: regiao.nome,
          tamanho: mesmoTamanho ? r.tamanhoA.join('x') : `${r.tamanhoA.join('x')} → ${r.tamanhoB.join('x')}`,
          diferentes: `${pct(r.diferentes, r.total)}%`,
          fortes: `${pct(r.fortes, r.total)}%`,
          esperado: regiao.muda ? 'muda (pedido)' : 'igual',
        });
        if (!regiao.muda && r.diferentes > 0) falhou = true;
      }
      await a.contexto.close();
      await b.contexto.close();
    }
  } finally {
    await navegador.close();
    await ladoMain.fechar();
    await ladoNovo.fechar();
  }

  console.table(linhas);
  if (errosNovo.length) {
    console.log('Erros no console da home nova:');
    for (const e of new Set(errosNovo)) console.log(`  - ${e}`);
    falhou = true;
  } else {
    console.log('Console da home nova: sem erros (fora as requisições bloqueadas do Instagram).');
  }
  console.log(`Capturas em ${path.relative(RAIZ, SAIDA)}/<largura>/`);
  if (falhou) {
    console.log('Há regiões que não deviam mudar com diferenças (ou erros no console).');
    process.exitCode = 1;
  }
}

main().catch((erro) => {
  console.error(erro);
  process.exitCode = 1;
});
