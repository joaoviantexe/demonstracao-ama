#!/usr/bin/env node
// Capturas e verificação das páginas de produtos e categorias do painel (Playwright + Supabase local).
//
// Uso: node scripts/capturas-painel-produtos.mjs [--saida <pasta>] [--larguras 390,1440]
//      (padrão da saída: <tmp>/capturas-painel-produtos)
//
// Em cada largura, com dados próprios (sufixo aleatório):
// - lista de produtos: busca, filtro de situação guardado na URL;
// - produto novo: erros por campo, endereço gerado do nome, categoria criada pelo atalho,
//   2 fotos PNG (geradas aqui) enviadas ao bucket, descrição e ordem das fotos, preço R$ 49,90 e
//   estoque 3; confere no banco e na loja (/loja/produto?slug=) que aparece com o preço;
// - promoção (validação e R$ 39,90 na loja), endereço repetido (erro 23505 com sugestão),
//   aviso de alterações não salvas, "à venda" desligado pela lista (some da loja), duplicar e
//   apagar a cópia;
// - barra "Cancelar / Salvar" visível no meio do formulário (presa no rodapé da tela);
// - categorias: quantidade de produtos, editar no modal, criar e apagar outra pela página, subir/descer,
//   apagar (produto fica sem categoria); por fim apaga o produto pelo formulário.
// Tudo o que foi criado (produtos, categorias, arquivos do bucket) é apagado no fim (e conferido), e a
// ordem das categorias do seed é restaurada. Falha (código 1) com erro no console/página, rolagem
// horizontal ou verificação errada.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';
import { AMBIENTE_VAZIO, subirServidor } from '../tests/apoio/servidor.js';
import { ambienteLocal, clienteServico } from '../tests/apoio/supabase-local.js';

function argumento(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const SAIDA = path.resolve(argumento('saida', path.join(os.tmpdir(), 'capturas-painel-produtos')));
const LARGURAS = argumento('larguras', '390,1440').split(',').map(Number).filter(Boolean);
const ALTURAS = { 360: 760, 390: 844, 768: 1024, 1024: 800, 1440: 900 };
const ADMIN = { email: 'admin@ama.local', senha: 'admin123456' };
const UUID = /^#\/produtos\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const problemas = [];
const falhar = (texto) => {
  problemas.push(texto);
  console.log(`  ✗ ${texto}`);
};
const ok = (texto) => console.log(`  ✓ ${texto}`);
const conferir = (condicao, sucesso, erro) => (condicao ? ok(sucesso) : falhar(erro));

// ---------------------------------------------------------------------------
// PNG sem dependências (gradiente com um círculo), para enviar como foto do produto.

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
      const dentro = Math.hypot(x - lado * 0.5, y - lado * 0.55) < lado * 0.27;
      const cor = dentro ? circulo : fundoA.map((c, i) => Math.round(c * (1 - t) + fundoB[i] * t));
      cor.forEach((c, i) => { linhas[y * largura + 1 + x * 3 + i] = c; });
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0);
  ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8; // 8 bits por canal
  ihdr[9] = 2; // RGB
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

// Erros de console esperados num passo (ex.: o 409 do endereço repetido).
const permitidos = new Set();

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
      if (permitidos.has('409') && /status of 409/.test(m.text()) && /\/rest\/v1\/produtos/.test(origem)) return;
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
    // Tabela no celular vira cartões: não pode precisar de rolagem dentro do container.
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

let contadorCapturas = 0;
async function capturar(pagina, nome, { inteira = true } = {}) {
  await pagina.evaluate(() => document.fonts && document.fonts.ready);
  // Na captura da página inteira as fotos "lazy" fora da tela não carregariam.
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

async function linhasDaLista(pagina) {
  return pagina.locator('.produtos-tabela tbody tr').evaluateAll((trs) => trs.map((tr) => ({
    nome: tr.querySelector('.produto-celula__nome')?.textContent.trim(),
    selos: [...tr.querySelectorAll('.produto-selos .selo')].map((s) => s.textContent.trim()),
    preco: tr.querySelector('.produto-preco')?.textContent.replace(/\u00a0/g, ' ').trim(),
    aVenda: tr.querySelector('.produto-interruptor input')?.checked,
  })));
}

async function esperarListaCarregada(pagina) {
  await pagina.waitForSelector('.pagina[data-pagina="produtos"] .produtos-tabela, .pagina[data-pagina="produtos"] .estado-vazio', { timeout: 20_000 });
}

// ---------------------------------------------------------------------------
// Banco (chave de serviço): conferências e limpeza

const servico = () => clienteServico();

async function produtoPorSlug(slug) {
  const { data, error } = await servico().from('produtos').select('*').eq('slug', slug).maybeSingle();
  if (error) throw new Error(`consulta de produto falhou: ${error.message}`);
  return data;
}

function caminhoNoBucket(src) {
  const m = String(src || '').match(/\/storage\/v1\/object\/public\/midia\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Arquivos enviados pelo roteiro (o produto apagado pelo painel deixa as fotos na biblioteca de Mídia).
const arquivosEnviados = new Set();

async function limpar(sufixo) {
  const supa = servico();
  const caminhos = new Set(arquivosEnviados);
  const { data: produtos } = await supa.from('produtos').select('id, imagens').like('slug', `%${sufixo}%`);
  for (const p of produtos || []) for (const img of p.imagens || []) {
    const c = caminhoNoBucket(img && img.src);
    if (c) caminhos.add(c);
  }
  if (produtos && produtos.length) await supa.from('produtos').delete().in('id', produtos.map((p) => p.id));
  const { data: categorias } = await supa.from('categorias').select('id').like('slug', `%${sufixo}%`);
  if (categorias && categorias.length) await supa.from('categorias').delete().in('id', categorias.map((c) => c.id));
  const mes = new Date().toISOString().slice(0, 7);
  for (const pasta of [`produtos/${mes}`]) {
    // A busca do Storage é pelo começo do nome.
    const { data: arquivos } = await supa.storage.from('midia').list(pasta, { limit: 1000, search: `foto-teste-${sufixo}` });
    for (const a of arquivos || []) caminhos.add(`${pasta}/${a.name}`);
  }
  arquivosEnviados.clear();
  if (caminhos.size) {
    const { error } = await supa.storage.from('midia').remove([...caminhos]);
    if (error) console.log(`  Aviso: não foi possível apagar ${[...caminhos].join(', ')}: ${error.message}`);
  }
  const resto = (produtos || []).length + (categorias || []).length;
  console.log(`  limpeza (${sufixo}): ${(produtos || []).length} produto(s), ${(categorias || []).length} categoria(s), ${caminhos.size} arquivo(s)${resto ? ' que sobraram' : ''}`);

  // Confere que nada do roteiro ficou para trás.
  const { data: produtosDepois } = await supa.from('produtos').select('id').like('slug', `%${sufixo}%`);
  const { data: categoriasDepois } = await supa.from('categorias').select('id').like('slug', `%${sufixo}%`);
  const sobras = [];
  for (const caminho of caminhos) {
    const [pasta, nome] = [caminho.slice(0, caminho.lastIndexOf('/')), caminho.slice(caminho.lastIndexOf('/') + 1)];
    const { data: achados } = await supa.storage.from('midia').list(pasta, { limit: 10, search: nome });
    if ((achados || []).some((a) => a.name === nome)) sobras.push(caminho);
  }
  if ((produtosDepois || []).length || (categoriasDepois || []).length || sobras.length) {
    falhar(`limpeza (${sufixo}) incompleta: ${(produtosDepois || []).length} produto(s), ${(categoriasDepois || []).length} categoria(s), arquivos ${sobras.join(', ')}`);
  }
  return caminhos.size;
}

async function restaurarOrdemCategorias(antes) {
  const { data } = await servico().from('categorias').select('id, ordem');
  const mudaram = (data || []).filter((c) => antes.has(c.id) && antes.get(c.id) !== c.ordem);
  for (const c of mudaram) await servico().from('categorias').update({ ordem: antes.get(c.id) }).eq('id', c.id);
  if (mudaram.length) console.log(`  ordem restaurada em ${mudaram.length} categoria(s) do seed`);
}

// ---------------------------------------------------------------------------
// Roteiro

async function verNaLoja(pagina, contexto, base, esperado, nomeCaptura) {
  const href = await pagina.getAttribute('[data-ver-na-loja]', 'href');
  const loja = await contexto.newPage();
  try {
    await loja.goto(`${base}${href}`, { waitUntil: 'load' });
    await loja.waitForFunction((t) => document.body.innerText.includes(t), esperado, { timeout: 20_000 });
    if (nomeCaptura) await capturar(loja, nomeCaptura, { inteira: false });
    return href;
  } finally {
    await loja.close();
  }
}

async function rodarLargura(navegador, base, largura) {
  console.log(`\n== ${largura}px`);
  const sufixo = randomBytes(3).toString('hex');
  const nomeProduto = `Sabonete Teste ${sufixo}`;
  const slugProduto = `sabonete-teste-${sufixo}`;
  const nomeCategoria = `Categoria Teste ${sufixo}`;
  const pastaFotos = path.join(SAIDA, 'fotos');
  mkdirSync(pastaFotos, { recursive: true });
  const fotos = [
    path.join(pastaFotos, `foto-teste-${sufixo}-1.png`),
    path.join(pastaFotos, `foto-teste-${sufixo}-2.png`),
  ];
  writeFileSync(fotos[0], gerarPng(640, [11, 42, 28], [62, 122, 84], [201, 152, 43]));
  writeFileSync(fotos[1], gerarPng(640, [244, 234, 211], [237, 217, 163], [31, 79, 51]));

  // O catálogo inicial vem com preços de teste: um produto à venda sem preço só para este roteiro.
  const { error: erroSemPreco } = await servico().from('produtos').insert({
    nome: `Sem Preço Teste ${sufixo}`, slug: `sem-preco-teste-${sufixo}`, preco_centavos: 0, estoque: 5, ativo: true, imagens: [],
  });
  if (erroSemPreco) throw new Error(`produto sem preço de teste: ${erroSemPreco.message}`);

  const { contexto, pagina } = await novaPagina(navegador, largura, `${largura}px`);
  const celular = largura < 720;
  try {
    // --- Login direto na lista -------------------------------------------------
    await pagina.goto(`${base}/admin/#/produtos`, { waitUntil: 'load' });
    await pagina.waitForSelector('form.acesso__formulario');
    await pagina.locator('.acesso input[name="email"]').fill(ADMIN.email);
    await pagina.locator('.acesso input[name="senha"]').fill(ADMIN.senha);
    await pagina.getByRole('button', { name: 'Entrar', exact: true }).click();
    await esperarListaCarregada(pagina);
    const linhas = await linhasDaLista(pagina);
    conferir(linhas.length >= 17, `lista de produtos com ${linhas.length} linhas`, `lista deveria ter os 16 produtos do seed e o de teste, tem ${linhas.length}`);
    const semPrecoNaLista = linhas.find((l) => l.selos.includes('Sem preço'));
    conferir(semPrecoNaLista && semPrecoNaLista.preco === 'R$ 00,00' && semPrecoNaLista.nome === `Sem Preço Teste ${sufixo}`,
      'produto sem preço mostra "R$ 00,00" e o selo "Sem preço"', `produto sem preço: ${JSON.stringify(semPrecoNaLista)}`);
    const promocao = linhas.find((l) => l.selos.includes('Promoção'));
    conferir(promocao && /R\$ 69,90.*R\$ 59,90/.test(promocao.preco), `promoção riscada na lista (${promocao && promocao.preco})`, `promoção na lista: ${JSON.stringify(promocao)}`);
    const avisoSemPreco = await pagina.locator('.produtos-avisos .aviso').count();
    conferir(avisoSemPreco === 1, 'aviso de produtos à venda sem preço', 'aviso de produtos sem preço não apareceu');
    await capturar(pagina, `lista-${largura}`);
    await semRolagemHorizontal(pagina, 'lista de produtos');

    // Busca e filtro (guardados na URL).
    await pagina.locator('.produtos-filtros input[type="search"]').fill('body splash');
    await pagina.waitForFunction(() => document.querySelectorAll('.produtos-tabela tbody tr').length === 4, null, { timeout: 5000 }).catch(() => {});
    const busca = await linhasDaLista(pagina);
    conferir(busca.length === 4 && busca.every((l) => /Body Splash/.test(l.nome)), 'busca "body splash" → 4 produtos', `busca: ${busca.map((l) => l.nome).join(', ')}`);
    await pagina.locator('.produtos-filtros input[type="search"]').fill('');
    await pagina.locator('.produtos-filtros select[aria-label="Filtrar por situação"]').selectOption('sem-preco');
    const semPreco = await linhasDaLista(pagina);
    const hash = await pagina.evaluate(() => window.location.hash);
    conferir(semPreco.length === 1 && semPreco.every((l) => l.selos.includes('Sem preço')) && hash.includes('situacao=sem-preco'),
      `filtro "Sem preço" → ${semPreco.length} produtos (hash ${hash})`, `filtro sem preço: ${semPreco.length} linhas, hash ${hash}`);
    if (celular) await capturar(pagina, `lista-filtro-sem-preco-${largura}`, { inteira: false });
    await pagina.locator('.produtos-filtros select[aria-label="Filtrar por situação"]').selectOption('');

    // --- Produto novo -------------------------------------------------------------
    await pagina.getByRole('link', { name: 'Novo produto' }).click();
    await pagina.waitForSelector('.produto-form');
    await capturar(pagina, `produto-novo-${largura}`);
    await semRolagemHorizontal(pagina, 'formulário de produto novo');
    await pagina.getByRole('button', { name: 'Criar produto' }).click();
    await pagina.waitForSelector('.campo--erro');
    const erros = await pagina.locator('.produto-form .campo--erro .campo__rotulo').allTextContents();
    conferir(erros.length === 3, `salvar vazio: erros em ${erros.map((t) => t.replace(' *', '')).join(', ')}`, `salvar vazio deveria marcar nome, preço e estoque: ${erros.join(', ')}`);
    const infoBarra = (await pagina.locator('.produto-form .barra-acoes__info').textContent()).trim();
    const toastsErro = await pagina.locator('.toast--erro').count();
    conferir(infoBarra === 'Confira os 3 campos marcados em vermelho.' && toastsErro === 0,
      'aviso dos erros na barra, sem toast por cima do "Criar produto"', `barra: "${infoBarra}", toasts de erro: ${toastsErro}`);
    await capturar(pagina, `produto-erros-${largura}`, { inteira: false });
    await fecharToasts(pagina);

    await pagina.locator('.produto-form input[name="nome"]').fill(nomeProduto);
    const slugGerado = await pagina.locator('.produto-form input[name="slug"]').inputValue();
    conferir(slugGerado === slugProduto, `endereço gerado do nome: ${slugGerado}`, `endereço gerado: ${slugGerado} (esperado ${slugProduto})`);
    await pagina.locator('.produto-form textarea[name="descricao"]').fill('Sabonete de teste criado pelo script de capturas.\n\nPode apagar.');
    await pagina.locator('.produto-form input[name="preco"]').fill('49,90');
    await pagina.locator('.produto-form input[name="preco_promocional"]').fill('59,90');
    await pagina.locator('.produto-form input[name="estoque"]').fill('3');

    // Categoria pelo atalho.
    await pagina.getByRole('button', { name: 'Nova categoria' }).click();
    const modalCategoria = pagina.locator('dialog.modal--categoria[open]');
    await modalCategoria.waitFor();
    await modalCategoria.locator('input[name="nome"]').fill(nomeCategoria);
    const slugCategoria = await modalCategoria.locator('input[name="slug"]').inputValue();
    if (largura === 390) await capturar(pagina, `categoria-atalho-${largura}`, { inteira: false });
    await modalCategoria.getByRole('button', { name: 'Criar categoria' }).click();
    await pagina.waitForSelector('dialog.modal--categoria', { state: 'detached' });
    const escolhida = await pagina.locator('.produto-form select[name="categoria_id"] option:checked').textContent();
    conferir(escolhida === nomeCategoria && slugCategoria === `categoria-teste-${sufixo}`, `atalho "Nova categoria" criou e escolheu "${escolhida}"`, `categoria escolhida: ${escolhida} (${slugCategoria})`);
    await fecharToasts(pagina);

    // Duas fotos enviadas de uma vez.
    const escolha = pagina.waitForEvent('filechooser');
    await pagina.locator('.produto-form .area-upload .botao').click();
    await (await escolha).setFiles(fotos);
    await pagina.waitForFunction(() => document.querySelectorAll('.produto-foto').length === 2, null, { timeout: 30_000 });
    await pagina.waitForFunction(() => !document.querySelector('.produto-form .area-upload--desativada'), null, { timeout: 30_000 });
    ok('2 fotos enviadas ao bucket (pasta produtos/)');
    const srcAntes = await pagina.locator('.produto-foto img').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src')));
    await pagina.locator('.produto-foto').nth(0).locator('input.produto-foto__alt').fill('Foto verde com círculo dourado');
    await pagina.locator('.produto-foto').nth(1).locator('input.produto-foto__alt').fill('Foto creme com círculo verde');
    await pagina.getByRole('button', { name: 'Descer a foto 1' }).click();
    const srcDepois = await pagina.locator('.produto-foto img').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src')));
    const capaAlt = await pagina.locator('.produto-foto').nth(0).locator('input.produto-foto__alt').inputValue();
    conferir(srcDepois[0] === srcAntes[1] && srcDepois[1] === srcAntes[0] && capaAlt === 'Foto creme com círculo verde',
      '"Descer" trocou a ordem das fotos (e o texto alternativo foi junto)', `ordem das fotos: ${JSON.stringify(srcDepois)}`);
    await pagina.getByRole('button', { name: 'Usar como capa' }).click();
    const srcCapa = await pagina.locator('.produto-foto img').first().getAttribute('src');
    conferir(srcCapa === srcAntes[0], '"Usar como capa" levou a foto para o primeiro lugar', 'capa não mudou');

    // Promoção maior que o preço → erro no campo.
    await pagina.getByRole('button', { name: 'Criar produto' }).click();
    await pagina.waitForSelector('.campo--erro');
    const erroPromo = await pagina.locator('.campo--erro').evaluateAll((cs) => cs.map((c) => c.querySelector('.campo__erro').textContent));
    conferir(erroPromo.length === 1 && /menor que o preço/.test(erroPromo[0]), `promoção maior que o preço: "${erroPromo[0]}"`, `erros: ${erroPromo.join(' | ')}`);
    await capturar(pagina, `produto-preenchido-${largura}`);
    await semRolagemHorizontal(pagina, 'formulário preenchido');
    await pagina.locator('.produto-form input[name="preco_promocional"]').fill('');
    await fecharToasts(pagina);

    await pagina.getByRole('button', { name: 'Criar produto' }).click();
    await pagina.waitForFunction(() => /^#\/produtos\/[0-9a-f-]{36}$/.test(window.location.hash), null, { timeout: 20_000 });
    await pagina.waitForSelector('.produto-form [data-ver-na-loja], .pagina-cabecalho [data-ver-na-loja]');
    const id = (await pagina.evaluate(() => window.location.hash)).match(UUID)[1];
    const titulo = (await pagina.locator('h1').textContent()).trim();
    conferir(titulo === nomeProduto, `produto criado (${id}) e aberto para edição`, `título depois de criar: ${titulo}`);
    const salvo = await produtoPorSlug(slugProduto);
    for (const img of (salvo && salvo.imagens) || []) if (caminhoNoBucket(img.src)) arquivosEnviados.add(caminhoNoBucket(img.src));
    const { data: categoriaSalva } = await servico().from('categorias').select('id, nome').eq('slug', `categoria-teste-${sufixo}`).maybeSingle();
    conferir(salvo && salvo.preco_centavos === 4990 && salvo.estoque === 3 && salvo.ativo === true && salvo.preco_promocional_centavos === null
      && salvo.imagens.length === 2 && salvo.imagens[0].alt === 'Foto verde com círculo dourado' && caminhoNoBucket(salvo.imagens[0].src)?.startsWith('produtos/')
      && salvo.categoria_id === categoriaSalva?.id && salvo.peso_gramas === 300 && Number(salvo.altura_cm) === 4,
    'no banco: R$ 49,90, estoque 3, à venda, 2 fotos com descrição, categoria e medidas padrão',
    `registro salvo: ${JSON.stringify(salvo)}`);
    await fecharToasts(pagina);
    await capturar(pagina, `produto-salvo-${largura}`);
    await semRolagemHorizontal(pagina, 'produto salvo');

    // "Salvar alterações" à vista no meio do formulário (barra presa no rodapé da tela).
    await pagina.locator('#pf-fotos').scrollIntoViewIfNeeded();
    await pagina.evaluate(() => window.scrollBy(0, 200));
    const barraVisivel = await pagina.evaluate(() => {
      const r = document.querySelector('.produto-form > .barra-acoes').getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight + 1;
    });
    conferir(barraVisivel, 'barra "Cancelar / Salvar" visível no meio do formulário', 'barra de ações fora da tela no meio do formulário');
    await capturar(pagina, `produto-barra-fixa-${largura}`, { inteira: false });
    await pagina.evaluate(() => window.scrollTo(0, 0));

    const href = await verNaLoja(pagina, contexto, base, 'R$ 49,90', `loja-produto-${largura}`);
    ok(`"Ver na loja" (${href}) mostra o produto com R$ 49,90`);

    // --- Edição: promoção -----------------------------------------------------------
    await pagina.locator('.produto-form input[name="preco_promocional"]').fill('39,90');
    const dica = (await pagina.locator('.produto-dica').textContent()).replace(/\s+/g, ' ');
    conferir(/de R\$ 49,90 por R\$ 39,90/.test(dica), `dica da promoção: "${dica.trim()}"`, `dica da promoção: ${dica}`);
    if (!(await pagina.isVisible('.topo__alterado'))) falhar('aviso "Alterações não salvas" não apareceu');
    await pagina.getByRole('button', { name: 'Salvar alterações' }).click();
    await esperarToast(pagina, 'Alterações salvas.');
    const comPromo = await produtoPorSlug(slugProduto);
    conferir(comPromo.preco_promocional_centavos === 3990, 'promoção R$ 39,90 salva', `promoção salva: ${comPromo.preco_promocional_centavos}`);
    await verNaLoja(pagina, contexto, base, 'R$ 39,90', null);
    ok('loja mostra a promoção (R$ 39,90)');
    await fecharToasts(pagina);

    // Endereço repetido (23505) → erro no campo com sugestão.
    await pagina.locator('.produto-form input[name="slug"]').fill('body-splash-raiz');
    permitidos.add('409');
    await pagina.getByRole('button', { name: 'Salvar alterações' }).click();
    await pagina.waitForSelector('.campo--erro');
    permitidos.delete('409');
    const erroSlug = (await pagina.locator('.campo--erro .campo__erro').first().textContent()).trim();
    conferir(/Já existe outro produto com o endereço "body-splash-raiz".*body-splash-raiz-2/.test(erroSlug), `endereço repetido: "${erroSlug}"`, `erro do endereço repetido: ${erroSlug}`);
    await capturar(pagina, `produto-endereco-repetido-${largura}`, { inteira: false });
    await pagina.locator('.produto-form input[name="slug"]').fill(slugProduto);
    await fecharToasts(pagina);

    // Alterações não salvas → confirmação ao sair.
    await pagina.locator('.produto-form input[name="nome"]').fill(`${nomeProduto} editado`);
    await pagina.evaluate(() => { window.location.hash = '#/produtos'; });
    await pagina.waitForSelector('dialog.modal--confirmar[open]');
    await pagina.getByRole('button', { name: 'Continuar editando' }).click();
    await pagina.waitForSelector('dialog.modal--confirmar', { state: 'detached' });
    const mantido = await pagina.locator('.produto-form input[name="nome"]').inputValue();
    const hashMantido = await pagina.evaluate(() => window.location.hash);
    conferir(mantido === `${nomeProduto} editado` && hashMantido === `#/produtos/${id}`, 'alterações não salvas: "Continuar editando" mantém o formulário', `depois de continuar: ${mantido} ${hashMantido}`);
    await pagina.evaluate(() => { window.location.hash = '#/produtos'; });
    await pagina.waitForSelector('dialog.modal--confirmar[open]');
    await pagina.getByRole('button', { name: 'Descartar e sair' }).click();
    await esperarListaCarregada(pagina);
    const naoSalvo = await produtoPorSlug(slugProduto);
    conferir(naoSalvo && naoSalvo.nome === nomeProduto, '"Descartar e sair" não gravou o nome editado', `nome no banco: ${naoSalvo && naoSalvo.nome}`);

    // --- Desativar pela lista -----------------------------------------------------------
    await pagina.locator('.produtos-filtros input[type="search"]').fill(nomeProduto);
    await pagina.waitForFunction(() => document.querySelectorAll('.produtos-tabela tbody tr').length === 1, null, { timeout: 5000 });
    const linha = pagina.locator('.produtos-tabela tbody tr').first();
    await linha.locator('.produto-interruptor').click();
    const msgDesativar = await confirmarModal(pagina, 'Tirar da loja');
    await esperarToast(pagina, 'saiu da loja');
    const desativado = await produtoPorSlug(slugProduto);
    const [linhaDepois] = await linhasDaLista(pagina);
    conferir(desativado.ativo === false && linhaDepois.aVenda === false && linhaDepois.selos.includes('Fora da loja') && /Tirar/.test(msgDesativar),
      'interruptor "à venda" na lista: confirmou, desativou no banco e mostrou "Fora da loja"', `desativar: ${JSON.stringify(linhaDepois)} ativo=${desativado.ativo}`);
    await capturar(pagina, `lista-produto-fora-${largura}`, { inteira: false });
    await semRolagemHorizontal(pagina, 'lista filtrada');
    const lojaFora = await contexto.newPage();
    await lojaFora.goto(`${base}${href}`, { waitUntil: 'load' });
    await lojaFora.waitForFunction(() => /não encontrado/i.test(document.body.innerText), null, { timeout: 20_000 });
    await lojaFora.close();
    ok('fora da loja: a página do produto na loja diz "não encontrado"');
    await fecharToasts(pagina);

    // --- Duplicar e apagar a cópia ---------------------------------------------------------
    await linha.locator('.produto-celula__nome').click();
    await pagina.waitForSelector('.produto-form [name="nome"]');
    await pagina.getByRole('button', { name: 'Duplicar produto' }).click();
    await confirmarModal(pagina, 'Criar cópia');
    await pagina.waitForFunction((original) => /^#\/produtos\/[0-9a-f-]{36}$/.test(window.location.hash) && !window.location.hash.includes(original)
      && /\(cópia\)/.test(document.querySelector('h1')?.textContent || ''), id, { timeout: 20_000 });
    const copia = await produtoPorSlug(`${slugProduto}-copia`);
    conferir(copia && copia.ativo === false && copia.nome === `${nomeProduto} (cópia)` && copia.imagens.length === 2 && copia.preco_promocional_centavos === 3990,
      'duplicar: cópia fora da loja, com "(cópia)", fotos e preços', `cópia: ${JSON.stringify(copia)}`);
    await fecharToasts(pagina);
    if (largura === 1440) await capturar(pagina, `produto-copia-${largura}`, { inteira: false });
    await pagina.getByRole('button', { name: 'Apagar produto' }).click();
    const msgApagarCopia = await confirmarModal(pagina, 'Apagar produto');
    await esperarListaCarregada(pagina);
    conferir(/pedidos antigos continuam/.test(msgApagarCopia) && !(await produtoPorSlug(`${slugProduto}-copia`)),
      'apagar a cópia: confirmação explica os pedidos antigos e o produto sumiu do banco', `apagar cópia: ${msgApagarCopia}`);
    await fecharToasts(pagina);

    // --- Categorias ------------------------------------------------------------------------
    await irPara(pagina, '#/categorias', '.pagina[data-pagina="categorias"] .categorias-tabela');
    const linhaCategoria = pagina.locator('.categorias-tabela tbody tr', { hasText: nomeCategoria });
    const quantidade = (await linhaCategoria.locator('.categoria-produtos').textContent()).trim();
    conferir(quantidade === '1 produto', `categoria de teste com "${quantidade}"`, `quantidade na categoria: ${quantidade}`);
    await capturar(pagina, `categorias-${largura}`);
    await semRolagemHorizontal(pagina, 'categorias');

    await linhaCategoria.getByRole('button', { name: `Editar ${nomeCategoria}` }).click();
    const modalEditar = pagina.locator('dialog.modal--categoria[open]');
    await modalEditar.waitFor();
    await modalEditar.locator('textarea[name="descricao"]').fill('Categoria criada pelo script de capturas.');
    await capturar(pagina, `categoria-editar-${largura}`, { inteira: false });
    await modalEditar.getByRole('button', { name: 'Salvar' }).click();
    await pagina.waitForSelector('dialog.modal--categoria', { state: 'detached' });
    await esperarToast(pagina, 'Categoria salva.');
    await pagina.waitForFunction((n) => [...document.querySelectorAll('.categorias-tabela tbody tr')].some((tr) => tr.textContent.includes(n) && tr.textContent.includes('script de capturas')), nomeCategoria, { timeout: 10_000 });
    ok('editar categoria no modal');
    await fecharToasts(pagina);

    // Criar pela própria página (botão "Nova categoria") e apagar (sem produtos).
    const nomeExtra = `Categoria Extra ${sufixo}`;
    await pagina.locator('.pagina-cabecalho').getByRole('button', { name: 'Nova categoria' }).click();
    const modalNova = pagina.locator('dialog.modal--categoria[open]');
    await modalNova.waitFor();
    await modalNova.locator('input[name="nome"]').fill(nomeExtra);
    await modalNova.locator('input[name="nome"]').press('Enter'); // Enter num campo salva
    await pagina.waitForSelector('dialog.modal--categoria', { state: 'detached' });
    const linhaExtra = pagina.locator('.categorias-tabela tbody tr', { hasText: nomeExtra });
    await linhaExtra.waitFor({ timeout: 10_000 });
    const { data: extraNoBanco } = await servico().from('categorias').select('slug, ativo').eq('slug', `categoria-extra-${sufixo}`).maybeSingle();
    conferir(extraNoBanco && extraNoBanco.ativo === true && /Nenhum/.test(await linhaExtra.textContent()),
      'nova categoria pela página (Enter salva): visível e sem produtos', `categoria extra: ${JSON.stringify(extraNoBanco)}`);
    await linhaExtra.getByRole('button', { name: `Apagar ${nomeExtra}` }).click();
    const msgExtra = await confirmarModal(pagina, 'Apagar categoria');
    await linhaExtra.waitFor({ state: 'detached', timeout: 10_000 });
    const { data: extraDepois } = await servico().from('categorias').select('id').eq('slug', `categoria-extra-${sufixo}`).maybeSingle();
    conferir(/não tem produtos/.test(msgExtra) && !extraDepois, 'apagar categoria sem produtos', `apagar categoria extra: "${msgExtra}" ${JSON.stringify(extraDepois)}`);
    await fecharToasts(pagina);

    const ordemNomes = () => pagina.locator('.categorias-tabela .categoria-celula__nome').allTextContents();
    const antes = await ordemNomes();
    const posicao = antes.indexOf(nomeCategoria);
    await linhaCategoria.getByRole('button', { name: `Subir ${nomeCategoria}` }).click();
    await pagina.waitForFunction(([n, p]) => [...document.querySelectorAll('.categorias-tabela .categoria-celula__nome')].map((e) => e.textContent).indexOf(n) === p - 1, [nomeCategoria, posicao], { timeout: 10_000 });
    const { data: ordensBanco } = await servico().from('categorias').select('nome, ordem').order('ordem').order('nome');
    const noBanco = ordensBanco.map((c) => c.nome).indexOf(nomeCategoria);
    conferir(noBanco === posicao - 1, `"Subir" levou a categoria para a posição ${posicao} (também no banco)`, `posição no banco depois de subir: ${noBanco + 1}`);
    await linhaCategoria.getByRole('button', { name: `Descer ${nomeCategoria}` }).click();
    await pagina.waitForFunction(([n, p]) => [...document.querySelectorAll('.categorias-tabela .categoria-celula__nome')].map((e) => e.textContent).indexOf(n) === p, [nomeCategoria, posicao], { timeout: 10_000 });
    ok('"Descer" devolveu a categoria ao lugar');

    await linhaCategoria.getByRole('button', { name: `Apagar ${nomeCategoria}` }).click();
    const msgCategoria = await confirmarModal(pagina, 'Apagar categoria');
    await esperarToast(pagina, 'apagada');
    await pagina.waitForFunction((n) => ![...document.querySelectorAll('.categorias-tabela tbody tr')].some((tr) => tr.textContent.includes(n)), nomeCategoria, { timeout: 10_000 });
    const semCategoria = await produtoPorSlug(slugProduto);
    conferir(/O produto dela continua/.test(msgCategoria) && semCategoria.categoria_id === null,
      'apagar categoria: confirmação avisa e o produto ficou sem categoria', `apagar categoria: "${msgCategoria}" categoria_id=${semCategoria.categoria_id}`);
    await fecharToasts(pagina);

    // --- Apagar o produto pelo formulário -----------------------------------------------------
    await irPara(pagina, `#/produtos/${id}`, '.produto-form [name="nome"]');
    if (celular) await capturar(pagina, `produto-acoes-${largura}`, { inteira: false });
    await pagina.getByRole('button', { name: 'Apagar produto' }).click();
    await confirmarModal(pagina, 'Apagar produto');
    await esperarListaCarregada(pagina);
    conferir(!(await produtoPorSlug(slugProduto)), 'produto apagado pelo formulário', 'o produto continua no banco');
    await fecharToasts(pagina);

    // Produto inexistente.
    await irPara(pagina, `#/produtos/${id}`, '.pagina[data-pagina="produtos"] .estado-vazio');
    ok('produto apagado → "Produto não encontrado" com botão para a lista');
  } finally {
    permitidos.clear();
    await contexto.close();
    await limpar(sufixo);
    for (const foto of fotos) rmSync(foto, { force: true });
  }
}

async function principal() {
  mkdirSync(SAIDA, { recursive: true });
  const local = ambienteLocal();
  if (!local.serviceKey) throw new Error('Chave de serviço do Supabase local não encontrada (rode "supabase start").');
  const { data: categoriasAntes, error } = await servico().from('categorias').select('id, ordem');
  if (error) throw new Error(`Supabase local não respondeu: ${error.message}`);
  const ordemAntes = new Map(categoriasAntes.map((c) => [c.id, c.ordem]));
  const navegador = await chromium.launch({ proxy: proxyDoAmbiente() });
  const servidor = await subirServidor({
    ...AMBIENTE_VAZIO,
    SUPABASE_URL: local.url,
    SUPABASE_ANON_KEY: local.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: local.serviceKey,
  });
  try {
    for (const largura of LARGURAS) {
      try {
        await rodarLargura(navegador, servidor.url, largura);
      } catch (erro) {
        falhar(`${largura}px: ${erro.message.split('\n')[0]}`);
        console.error(erro);
      }
    }
  } finally {
    await servidor.fechar();
    await navegador.close();
    await restaurarOrdemCategorias(ordemAntes);
  }
  rmSync(path.join(SAIDA, 'fotos'), { recursive: true, force: true });
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
