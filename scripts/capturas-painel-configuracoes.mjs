#!/usr/bin/env node
// Capturas e verificação da página de configurações do painel (Playwright + Supabase local).
//
// Uso: node scripts/capturas-painel-configuracoes.mjs [--saida <pasta>] [--larguras 390,1440]
//      (padrão da saída: <tmp>/capturas-painel-configuracoes)
//
// Em cada largura:
// - Loja: erro no WhatsApp; salva nome, WhatsApp e aviso no topo; confere no banco e na loja
//   (aviso no alto do catálogo e link do WhatsApp);
// - Frete: aviso "nenhuma forma de entrega", erro no CEP da origem e no estado da opção fixa; liga o frete
//   fixo com uma opção (PA) e frete grátis; confere no banco e na cotação da loja (/api/loja/cotacao);
// - Pagamento (parcelas, boleto, prazo) e Avisos por e-mail (erro e lista de e-mails);
// - Integrações (lista da /api/admin/status); aba guardada na URL; aviso de alterações não salvas.
// As configurações originais são restauradas no fim. Falha (código 1) com erro no console/página,
// rolagem horizontal, texto "null"/"undefined" na tela ou verificação errada.

import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { AMBIENTE_VAZIO, subirServidor } from '../tests/apoio/servidor.js';
import { ambienteLocal, clienteServico } from '../tests/apoio/supabase-local.js';

function argumento(nome, padrao) {
  const i = process.argv.indexOf(`--${nome}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const SAIDA = path.resolve(argumento('saida', path.join(os.tmpdir(), 'capturas-painel-configuracoes')));
const LARGURAS = argumento('larguras', '390,1440').split(',').map(Number).filter(Boolean);
const ALTURAS = { 360: 760, 390: 844, 768: 1024, 1024: 800, 1440: 900 };
const ADMIN = { email: 'admin@ama.local', senha: 'admin123456' };
const CHAVES = ['loja', 'frete', 'checkout', 'notificacoes'];

const problemas = [];
const falhar = (texto) => {
  problemas.push(texto);
  console.log(`  ✗ ${texto}`);
};
const ok = (texto) => console.log(`  ✓ ${texto}`);
const conferir = (condicao, sucesso, erro) => (condicao ? ok(sucesso) : falhar(erro));

function proxyDoAmbiente() {
  const servidor = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (!servidor) return undefined;
  process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK = '1';
  return { server: servidor, bypass: '127.0.0.1,localhost' };
}

async function novaPagina(navegador, largura, rotulo) {
  const contexto = await navegador.newContext({
    viewport: { width: largura, height: ALTURAS[largura] || 900 },
    deviceScaleFactor: 1, reducedMotion: 'reduce', locale: 'pt-BR', timezoneId: 'America/Belem', hasTouch: largura < 1024,
  });
  await contexto.route(/^https:\/\/(fonts\.(googleapis|gstatic)\.com|www\.instagram\.com)\//, async (rota) => {
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
      if (/fonts\.(googleapis|gstatic)\.com|instagram\.com/.test(origem)) return;
      falhar(`[${rotulo}] console: ${m.text()} ${origem}`);
    });
  };
  contexto.on('page', vigiar);
  const pagina = await contexto.newPage();
  return { contexto, pagina };
}

async function verificarTela(pagina, onde) {
  const r = await pagina.evaluate(() => {
    const largos = [];
    for (const e of document.querySelectorAll('body *')) {
      const ret = e.getBoundingClientRect();
      if (!ret.width || ret.right <= window.innerWidth + 1) continue;
      if (e.closest('.menu-lateral,.abas,.tabela-container,dialog,.toasts') || getComputedStyle(e).position === 'fixed') continue;
      const classe = typeof e.className === 'string' ? e.className : (e.className && e.className.baseVal) || '';
      largos.push(`${e.tagName.toLowerCase()}.${classe.split(' ')[0]} (${Math.round(ret.right)}px)`);
    }
    const painel = document.querySelector('.painel');
    const quebrado = [...new Set(((painel ? painel.innerText : '').match(/\b(null|undefined|NaN)\b/g) || []))];
    return { pagina: document.documentElement.scrollWidth - window.innerWidth, largos: largos.slice(0, 5), quebrado };
  });
  if (r.pagina > 0 || r.largos.length) falhar(`${onde}: rolagem horizontal (${r.pagina}px) ${r.largos.join(', ')}`);
  else ok(`${onde}: sem rolagem horizontal`);
  if (r.quebrado.length) falhar(`${onde}: texto quebrado na tela (${r.quebrado.join(', ')})`);
}

let contadorCapturas = 0;
async function capturar(pagina, nome, { inteira = true } = {}) {
  await pagina.evaluate(() => document.fonts && document.fonts.ready);
  await pagina.waitForTimeout(250);
  contadorCapturas += 1;
  const arquivo = path.join(SAIDA, `${String(contadorCapturas).padStart(2, '0')}-${nome}.png`);
  await pagina.screenshot({ path: arquivo, fullPage: inteira });
  console.log(`    → ${arquivo}`);
  await verificarTela(pagina, nome);
}

async function esperarToast(pagina, texto) {
  const toast = pagina.locator('.toast', { hasText: texto }).last();
  await toast.waitFor({ timeout: 20_000 });
  return (await toast.textContent()).trim();
}

async function fecharToasts(pagina) {
  for (const b of await pagina.locator('.toast__fechar').all()) await b.click().catch(() => {});
  await pagina.waitForTimeout(200);
}

const servico = () => clienteServico();

async function lerConfig() {
  const { data, error } = await servico().from('configuracoes').select('chave, valor, publico').in('chave', CHAVES);
  if (error) throw new Error(`configurações: ${error.message}`);
  return Object.fromEntries(data.map((l) => [l.chave, l]));
}

async function restaurar(originais) {
  for (const chave of CHAVES) {
    const linha = originais[chave];
    if (!linha) continue;
    const { error } = await servico().from('configuracoes').update({ valor: linha.valor, publico: linha.publico }).eq('chave', chave);
    if (error) falhar(`restaurar ${chave}: ${error.message}`);
  }
}


async function salvarAba(pagina, rotuloForm) {
  await pagina.locator(`form[aria-label="${rotuloForm}"]`).getByRole('button', { name: 'Salvar', exact: true }).click();
}

async function rodarLargura(navegador, base, largura) {
  console.log(`\n== ${largura}px`);
  const celular = largura < 720;
  const { contexto, pagina } = await novaPagina(navegador, largura, `${largura}px`);
  try {
    await pagina.goto(`${base}/admin/#/configuracoes`, { waitUntil: 'load' });
    await pagina.waitForSelector('.acesso input[name="email"]', { timeout: 20_000 });
    await pagina.fill('.acesso input[name="email"]', ADMIN.email);
    await pagina.fill('.acesso input[name="senha"]', ADMIN.senha);
    await pagina.getByRole('button', { name: 'Entrar', exact: true }).click();
    await pagina.waitForSelector('.pagina[data-pagina="configuracoes"] form[aria-label="Dados da loja"]', { timeout: 20_000 });

    // --- Loja --------------------------------------------------------------------
    const formLoja = pagina.locator('form[aria-label="Dados da loja"]');
    await formLoja.locator('input[name="whatsapp"]').fill('1234');
    await salvarAba(pagina, 'Dados da loja');
    await formLoja.locator('.campo--erro input[name="whatsapp"]').waitFor({ timeout: 10_000 });
    ok('WhatsApp inválido mostra o erro no campo');
    await formLoja.locator('input[name="whatsapp"]').fill('(91) 98888-7777');
    await formLoja.locator('input[name="aviso_topo"]').fill('Frete grátis acima de R$ 150 (teste)');
    await formLoja.locator('input[name="titulo"]').fill('Produtos AMA');
    await capturar(pagina, `loja-${largura}`);
    await salvarAba(pagina, 'Dados da loja');
    await esperarToast(pagina, 'Dados da loja salvos');
    let config = await lerConfig();
    conferir(config.loja.valor.whatsapp === '5591988887777' && config.loja.valor.aviso_topo === 'Frete grátis acima de R$ 150 (teste)'
      && config.loja.valor.titulo === 'Produtos AMA' && config.loja.publico === true && 'instagram' in config.loja.valor,
    'loja salva no banco (WhatsApp com 55, aviso, nome; campos não mostrados mantidos)', `loja no banco: ${JSON.stringify(config.loja)}`);
    const pronta = await pagina.locator('form[aria-label="Dados da loja"] input[name="whatsapp"]').inputValue();
    conferir(pronta === '(91) 98888-7777', 'WhatsApp mostrado formatado', `WhatsApp no campo: ${pronta}`);
    await fecharToasts(pagina);

    const loja = await contexto.newPage();
    await loja.goto(`${base}/loja/`, { waitUntil: 'load' });
    await loja.waitForSelector('.aviso-topo', { timeout: 20_000 });
    const avisoLoja = (await loja.locator('.aviso-topo').textContent()).trim();
    const linkWa = await loja.locator('[data-whatsapp-loja]').first().getAttribute('href');
    conferir(/Frete grátis acima de R\$ 150/.test(avisoLoja) && /5591988887777/.test(linkWa || ''),
      'a loja mostra o aviso no topo e o WhatsApp novo', `loja: aviso "${avisoLoja}" link ${linkWa}`);
    await loja.close();

    // --- Frete -------------------------------------------------------------------
    await pagina.getByRole('tab', { name: 'Frete' }).click();
    await pagina.waitForFunction(() => window.location.hash.includes('aba=frete'));
    const formFrete = pagina.locator('form[aria-label="Frete"]');
    // Desliga tudo: aviso de que ninguém consegue comprar.
    if (await formFrete.locator('input[name="me_ativo"]').isChecked()) await formFrete.locator('label:has(input[name="me_ativo"])').click();
    if (await formFrete.locator('input[name="fixo_ativo"]').isChecked()) await formFrete.locator('label:has(input[name="fixo_ativo"])').click();
    await formFrete.locator('.config-aviso-entrega .aviso').waitFor({ timeout: 10_000 });
    const avisoEntrega = (await formFrete.locator('.config-aviso-entrega').textContent()).trim();
    conferir(/Nenhuma forma de entrega/.test(avisoEntrega), 'aviso quando nenhuma forma de entrega está ligada', `aviso: "${avisoEntrega}"`);

    await formFrete.locator('label:has(input[name="fixo_ativo"])').click();
    await formFrete.getByRole('button', { name: 'Adicionar opção' }).click();
    const opcao = formFrete.locator('.config-fixo__item').last();
    await opcao.locator('input[name="fixo_nome"]').fill('Entrega na Grande Belém');
    await opcao.locator('input[name="fixo_preco"]').fill('12,50');
    await opcao.locator('input[name="fixo_prazo"]').fill('2');
    await opcao.locator('input[name="fixo_ufs"]').fill('PA, XX');
    await formFrete.locator('input[name="origem_cep"]').fill('123');
    await formFrete.locator('input[name="frete_gratis"]').fill('abc');
    await salvarAba(pagina, 'Frete');
    await formFrete.locator('.campo--erro input[name="fixo_ufs"]').last().waitFor({ timeout: 10_000 });
    const errosFrete = await formFrete.locator('.campo--erro').count();
    conferir(errosFrete >= 3, `erros por campo no frete (${errosFrete}: CEP, estado e frete grátis)`, `só ${errosFrete} erro(s) no frete`);
    await opcao.locator('input[name="fixo_ufs"]').fill('pa');
    await formFrete.locator('input[name="origem_cep"]').fill('67125-866');
    await formFrete.locator('input[name="frete_gratis"]').fill('300,00');
    await capturar(pagina, `frete-${largura}`);
    await salvarAba(pagina, 'Frete');
    await esperarToast(pagina, 'frete salvas');
    config = await lerConfig();
    const fixo = config.frete.valor.fixo;
    const nova = fixo.opcoes.find((o) => o.nome === 'Entrega na Grande Belém');
    conferir(fixo.ativo === true && nova && nova.preco_centavos === 1250 && nova.prazo_dias === 2 && nova.ufs.join() === 'PA'
      && /^fixo-/.test(nova.id) && config.frete.valor.origem.cep === '67125866' && config.loja.valor.frete_gratis_acima_centavos === 30000
      && !('retirada' in config.frete.valor),
    'frete salvo (opção fixa, CEP de origem e frete grátis em loja)', `frete no banco: ${JSON.stringify(config.frete.valor.fixo)} / ${config.loja.valor.frete_gratis_acima_centavos}`);
    await fecharToasts(pagina);

    // A cotação da loja já oferece a opção nova (o cache de configurações dura até 15 s).
    const { data: produto } = await servico().from('produtos').select('id').eq('slug', 'body-splash-raiz').single();
    let opcoes = [];
    for (let tentativa = 0; tentativa < 12; tentativa += 1) {
      const r = await fetch(`${base}/api/loja/cotacao`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itens: [{ produto_id: produto.id, quantidade: 1 }], cep: '66010-000' }),
      }).then((res) => res.json());
      opcoes = (r.frete && r.frete.opcoes) || [];
      if (opcoes.some((o) => o.id === nova.id)) break;
      await new Promise((resolve) => { setTimeout(resolve, 2000); });
    }
    const cotada = opcoes.find((o) => o.id === nova.id);
    conferir(cotada && cotada.preco_centavos === 1250 && !opcoes.some((o) => o.tipo === 'retirada'),
      'a cotação da loja oferece o frete fixo salvo (sem retirada)', `cotação: ${JSON.stringify(opcoes)}`);

    // --- Pagamento ---------------------------------------------------------------
    await pagina.getByRole('tab', { name: 'Pagamento' }).click();
    const formPag = pagina.locator('form[aria-label="Pagamento"]');
    await formPag.locator('select[name="parcelas_max"]').selectOption('3');
    await formPag.locator('select[name="prazo_dias"]').selectOption('5');
    await formPag.locator('label:has(input[name="aceitar_boleto"])').click();
    await salvarAba(pagina, 'Pagamento');
    await esperarToast(pagina, 'Pagamento salvo');
    config = await lerConfig();
    conferir(config.checkout.valor.parcelas_max === 3 && config.checkout.valor.expiracao_horas === 120 && config.checkout.valor.aceitar_boleto === false,
      'pagamento salvo (3x, 5 dias, sem boleto)', `checkout: ${JSON.stringify(config.checkout.valor)}`);
    if (celular) await capturar(pagina, `pagamento-${largura}`);
    await fecharToasts(pagina);

    // --- Avisos ------------------------------------------------------------------
    await pagina.getByRole('tab', { name: 'Avisos por e-mail' }).click();
    const formAvisos = pagina.locator('form[aria-label="Avisos por e-mail"]');
    await formAvisos.locator('input[name="email_admin"]').fill('equipe@ama.org.br, errado@');
    await salvarAba(pagina, 'Avisos por e-mail');
    await formAvisos.locator('.campo--erro').waitFor({ timeout: 10_000 });
    ok('e-mail inválido na lista mostra erro');
    await formAvisos.locator('input[name="email_admin"]').fill('Equipe@AMA.org.br; loja@ama.org.br');
    await salvarAba(pagina, 'Avisos por e-mail');
    await esperarToast(pagina, 'Avisos salvos');
    config = await lerConfig();
    conferir(config.notificacoes.valor.email_admin === 'equipe@ama.org.br, loja@ama.org.br', 'e-mails da equipe salvos normalizados',
      `notificações: ${JSON.stringify(config.notificacoes.valor)}`);
    await fecharToasts(pagina);

    // --- Integrações e alterações não salvas -------------------------------------
    await pagina.getByRole('tab', { name: 'Integrações' }).click();
    await pagina.waitForSelector('.pagina[data-pagina="configuracoes"] .integracoes .integracao', { timeout: 20_000 });
    const nomes = await pagina.locator('.integracao__nome').allTextContents();
    conferir(nomes.some((n) => /Supabase/.test(n)) && nomes.some((n) => /Mercado Pago/.test(n)) && nomes.some((n) => /Melhor Envio/.test(n)),
      `integrações listadas (${nomes.length})`, `integrações: ${nomes.join(' | ')}`);
    await capturar(pagina, `integracoes-${largura}`);

    await pagina.getByRole('tab', { name: 'Loja' }).click();
    await pagina.locator('form[aria-label="Dados da loja"] input[name="titulo"]').fill('Mudança sem salvar');
    await pagina.evaluate(() => { window.location.hash = '#/'; });
    await pagina.waitForSelector('dialog.modal--confirmar[open]');
    await pagina.getByRole('button', { name: 'Continuar editando' }).click();
    await pagina.waitForSelector('dialog.modal--confirmar', { state: 'detached' });
    const mantido = await pagina.locator('form[aria-label="Dados da loja"] input[name="titulo"]').inputValue();
    conferir(mantido === 'Mudança sem salvar', 'aviso de alterações não salvas mantém o que foi digitado', `título depois de continuar: ${mantido}`);
  } finally {
    await contexto.close();
  }
}

async function principal() {
  mkdirSync(SAIDA, { recursive: true });
  const local = ambienteLocal();
  if (!local.serviceKey) throw new Error('Chave de serviço do Supabase local não encontrada (rode "supabase start").');
  const originais = await lerConfig();
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
      } finally {
        await restaurar(originais);
      }
    }
  } finally {
    await servidor.fechar();
    await navegador.close();
    await restaurar(originais);
  }
  const depois = await lerConfig();
  conferir(CHAVES.every((c) => JSON.stringify(depois[c].valor) === JSON.stringify(originais[c].valor)),
    'configurações originais restauradas', 'as configurações não voltaram ao original');
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
