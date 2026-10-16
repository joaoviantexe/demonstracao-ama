// Testes do Worker do Cloudflare (worker/), do armazenamento (R2 falso, memória e pasta local), das rotas
// /api/admin/midia e /api/admin/home e da publicação da home pelo painel (public/admin/js/publicar-home.js).
// Tudo roda no Node, sem rede: o Supabase é simulado e o R2 é um bucket falso (tests/apoio/armazenamento.js).
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser, parseHTML } from 'linkedom';
import adminHome from '../../api/admin/home.js';
import adminMidia from '../../api/admin/midia.js';
import {
  caminhoDeMidiaValido, CHAVE_HOME, CHAVE_HOME_INFO, definirArmazenamento,
} from '../../lib/armazenamento.js';
import { definirTemplateHome, validarHomePublicada } from '../../lib/home.js';
import { configurarApi } from '../../public/admin/js/api.js';
import {
  assinaturaDe, conteudoCanonico, montarHome, publicarHome,
} from '../../public/admin/js/publicar-home.js';
import { armazenamentoLocal } from '../../scripts/armazenamento-local.mjs';
import { executarHandler, requisicaoDoHandler } from '../../worker/adaptador.js';
import { criarApp } from '../../worker/app.js';
import { servirMidia } from '../../worker/midia.js';
import { armazenamentoR2 } from '../../worker/r2.js';
import { ROTAS } from '../../worker/rotas.js';
import { armazenamentoMemoria, bucketR2Falso } from '../apoio/armazenamento.js';
import {
  AMBIENTE_VAZIO, aplicarAmbiente, chamarHandler, respostaJson, simularFetch, subirServidor,
} from '../apoio/servidor.js';

const RAIZ = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TEMPLATE = readFileSync(path.join(RAIZ, 'templates', 'home.html'), 'utf8');
const CABECALHOS = readFileSync(path.join(RAIZ, 'public', '_headers'), 'utf8');
const URL_SUPA = 'http://supabase.teste';
const SUPABASE = { SUPABASE_URL: URL_SUPA, SUPABASE_ANON_KEY: 'sb_publishable_teste', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_teste' };
const ID_ADMIN = '11111111-2222-3333-4444-555555555555';
const comAdmin = { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.assinatura' };
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

let restaurarAmbiente;
let fetchSimulado;
beforeEach(() => { restaurarAmbiente = aplicarAmbiente(AMBIENTE_VAZIO); });
afterEach(() => {
  if (fetchSimulado) fetchSimulado.restaurar();
  fetchSimulado = null;
  definirArmazenamento(null);
  definirTemplateHome(null);
  restaurarAmbiente();
});

const silenciar = (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
};

/** Supabase com uma administradora logada (auth/v1/user + admins). */
function supabaseComAdmin(extra = () => null) {
  aplicarAmbiente(SUPABASE);
  fetchSimulado = simularFetch((url, init, chamada) => {
    const outra = extra(url, init, chamada);
    if (outra) return outra;
    if (url.startsWith(`${URL_SUPA}/auth/v1/user`)) return respostaJson(200, { id: ID_ADMIN, email: 'admin@ama.local' });
    if (url.startsWith(`${URL_SUPA}/rest/v1/admins`)) return respostaJson(200, [{ user_id: ID_ADMIN }]);
    return respostaJson(404, { message: `rota não simulada: ${url}` });
  });
}

// ---------------------------------------------------------------------------

describe('worker/rotas.js', () => {
  test('todo arquivo de api/ tem rota no Worker (e nenhuma rota sobra)', () => {
    const arquivos = [];
    const andar = (pasta) => {
      for (const nome of readdirSync(pasta)) {
        const completo = path.join(pasta, nome);
        if (statSync(completo).isDirectory()) andar(completo);
        else if (nome.endsWith('.js')) arquivos.push(`/${path.relative(RAIZ, completo).replace(/\\/g, '/').replace(/\.js$/, '')}`);
      }
    };
    andar(path.join(RAIZ, 'api'));
    assert.deepEqual(Object.keys(ROTAS).sort(), arquivos.sort());
    for (const handler of Object.values(ROTAS)) assert.equal(typeof handler, 'function');
  });
});

describe('worker/adaptador.js', () => {
  test('requisicaoDoHandler: cabeçalhos em minúsculas, endereço da própria requisição, query e corpo em bytes', async () => {
    const req = await requisicaoDoHandler(new Request('https://ama.org.br/api/x?a=1&a=2&b=3&__proto__=x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-Host': 'mal.example', 'X-Forwarded-Proto': 'http' },
      body: '{"ok":true}',
    }));
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/x?a=1&a=2&b=3&__proto__=x');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers['x-forwarded-host'], 'ama.org.br');
    assert.equal(req.headers['x-forwarded-proto'], 'https');
    assert.deepEqual(req.query, { a: ['1', '2'], b: '3' });
    assert.ok(Buffer.isBuffer(req.body));
    assert.equal(req.body.toString(), '{"ok":true}');
    assert.equal(req.corpoBruto, req.body);
    const get = await requisicaoDoHandler(new Request('https://ama.org.br/'));
    assert.equal('body' in get, false);
  });

  test('executarHandler: status, cabeçalhos, corpo, HEAD sem corpo e Content-Length calculado pelo Worker', async () => {
    const handler = (req, res) => {
      res.statusCode = 201;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Length', '999');
      res.setHeader('Set-Cookie', ['a=1', 'b=2']);
      res.write('olá ');
      res.end(Buffer.from('mundo'));
    };
    const r = await executarHandler(handler, new Request('https://ama.org.br/api/x'));
    assert.equal(r.status, 201);
    assert.equal(await r.text(), 'olá mundo');
    assert.equal(r.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.notEqual(r.headers.get('content-length'), '999');
    assert.deepEqual(r.headers.getSetCookie(), ['a=1', 'b=2']);
    const head = await executarHandler(handler, new Request('https://ama.org.br/api/x', { method: 'HEAD' }));
    assert.equal(await head.text(), '');
  });

  test('handler que lança ou que não responde → 500 em JSON', async (t) => {
    silenciar(t);
    const lanca = await executarHandler(() => { throw new Error('falhou'); }, new Request('https://x.org/api/a'));
    assert.equal(lanca.status, 500);
    assert.equal((await lanca.json()).erro, 'erro_interno');
    const mudo = await executarHandler(async () => {}, new Request('https://x.org/api/a'));
    assert.equal(mudo.status, 500);
  });

  test('handler de verdade com JSON (lerCorpo) recebe o corpo', async () => {
    const r = await executarHandler(ROTAS['/api/loja/cotacao'], new Request('https://x.org/api/loja/cotacao', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itens: [] }),
    }));
    assert.equal(r.status, 400);
    assert.equal((await r.json()).erro, 'carrinho_vazio');
  });
});

describe('worker/app.js', () => {
  const assets = () => {
    const chamadas = [];
    return { chamadas, fetch: async (request) => { chamadas.push(new URL(request.url).pathname); return new Response('arquivo', { status: 200 }); } };
  };

  test('"/" entrega a home publicada no R2 (ou o template), com os cabeçalhos de segurança', async () => {
    const app = criarApp({ template: TEMPLATE, cabecalhos: CABECALHOS });
    const MIDIA = bucketR2Falso();
    const env = { MIDIA, ASSETS: assets() };
    const padrao = await app.fetch(new Request('https://ama.org.br/'), env, {});
    assert.equal(padrao.status, 200);
    assert.equal(padrao.headers.get('x-ama-cms'), 'padrao');
    assert.equal(padrao.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(padrao.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
    assert.equal(await padrao.text(), TEMPLATE);

    await MIDIA.put(CHAVE_HOME, '<!doctype html><html><head><title>Publicada</title></head><body></body></html>');
    const publicada = await app.fetch(new Request('https://ama.org.br/'), env, {});
    assert.equal(publicada.headers.get('x-ama-cms'), 'publicado');
    assert.match(await publicada.text(), /Publicada/);
    assert.equal(env.ASSETS.chamadas.length, 0);
  });

  test('variáveis do Worker viram process.env; /api/config responde; rota inexistente → 404 JSON', async () => {
    const app = criarApp({ template: TEMPLATE, cabecalhos: CABECALHOS });
    const env = { ...SUPABASE, MIDIA: bucketR2Falso(), ASSETS: assets(), UM_NUMERO: 3 };
    const r = await app.fetch(new Request('https://ama.org.br/api/config'), env, {});
    assert.equal(r.status, 200);
    assert.match(await r.text(), /"supabaseUrl":"http:\/\/supabase\.teste"/);
    assert.equal(process.env.SUPABASE_URL, URL_SUPA);
    assert.equal(process.env.UM_NUMERO, undefined, 'só textos viram variáveis');
    const nada = await app.fetch(new Request('https://ama.org.br/api/nada'), env, {});
    assert.equal(nada.status, 404);
    assert.equal((await nada.json()).erro, 'nao_encontrado');
    assert.equal(nada.headers.get('x-content-type-options'), 'nosniff');
  });

  test('o resto vai para os arquivos estáticos (ASSETS)', async () => {
    const app = criarApp({ template: TEMPLATE, cabecalhos: CABECALHOS });
    const env = { MIDIA: bucketR2Falso(), ASSETS: assets() };
    const r = await app.fetch(new Request('https://ama.org.br/loja/produto?slug=x'), env, {});
    assert.equal(await r.text(), 'arquivo');
    assert.deepEqual(env.ASSETS.chamadas, ['/loja/produto']);
  });

  test('agendamento diário chama o manter-ativo com o CRON_SECRET', async (t) => {
    silenciar(t);
    const app = criarApp({ template: TEMPLATE, cabecalhos: CABECALHOS });
    fetchSimulado = simularFetch(() => respostaJson(200, [{ chave: 'loja' }]));
    const pendentes = [];
    await app.scheduled({ cron: '17 9 * * *' }, { ...SUPABASE, CRON_SECRET: 'segredo-cron', MIDIA: bucketR2Falso() },
      { waitUntil: (p) => pendentes.push(p) });
    await Promise.all(pendentes);
    assert.equal(fetchSimulado.chamadas.length, 1);
    assert.match(fetchSimulado.chamadas[0].url, /\/rest\/v1\/configuracoes\?select=chave&limit=1$/);
  });
});

describe('worker/midia.js (/midia/... do R2)', () => {
  let MIDIA;
  const caminho = 'produtos/2026-10/colar-a1b2c3.png';
  const pedir = (sufixo, init) => servirMidia(new Request(`https://ama.org.br/midia/${sufixo}`, init), { MIDIA }, { waitUntil() {} });
  beforeEach(async () => {
    MIDIA = bucketR2Falso();
    await MIDIA.put(caminho, PNG, { httpMetadata: { contentType: 'image/png' } });
  });

  test('200 com o tipo gravado, cache de um ano, ETag e Accept-Ranges', async () => {
    const r = await pedir(caminho);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(r.headers.get('accept-ranges'), 'bytes');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('etag'), /^"[0-9a-f]+"$/);
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()), PNG);
  });

  test('Range: início-fim e sufixo → 206 com Content-Range', async () => {
    const parte = await pedir(caminho, { headers: { Range: 'bytes=2-5' } });
    assert.equal(parte.status, 206);
    assert.equal(parte.headers.get('content-range'), `bytes 2-5/${PNG.length}`);
    assert.deepEqual(new Uint8Array(await parte.arrayBuffer()), PNG.slice(2, 6));
    const fim = await pedir(caminho, { headers: { Range: 'bytes=-4' } });
    assert.equal(fim.headers.get('content-range'), `bytes ${PNG.length - 4}-${PNG.length - 1}/${PNG.length}`);
    const aberto = await pedir(caminho, { headers: { Range: 'bytes=10-' } });
    assert.equal(aberto.headers.get('content-range'), `bytes 10-${PNG.length - 1}/${PNG.length}`);
    const fora = await pedir(caminho, { headers: { Range: 'bytes=999-' } });
    assert.equal(fora.status, 416);
  });

  test('If-None-Match com o mesmo ETag → 304; HEAD sem corpo', async () => {
    const etag = (await pedir(caminho)).headers.get('etag');
    const r = await pedir(caminho, { headers: { 'If-None-Match': etag } });
    assert.equal(r.status, 304);
    const head = await pedir(caminho, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  });

  test('caminhos fora das pastas de mídia, inexistentes ou malformados → 404; POST → 405', async () => {
    await MIDIA.put(CHAVE_HOME, '<!doctype html>');
    for (const sufixo of ['_publicado/home.html', 'site/../_publicado/home.html', 'outra/a.png', 'produtos/2026-10/nao-existe.png', 'produtos//a.png']) {
      assert.equal((await pedir(sufixo)).status, 404, sufixo);
    }
    assert.equal((await pedir('%E0%A4%A')).status, 400);
    assert.equal((await pedir(caminho, { method: 'POST' })).status, 405);
  });

  test('usa o cache do Cloudflare (caches.default) quando existe', async () => {
    const guardadas = new Map();
    globalThis.caches = { default: {
      match: async (req) => (guardadas.has(req.url) ? guardadas.get(req.url).clone() : undefined),
      put: async (req, res) => { guardadas.set(req.url, res); },
    } };
    try {
      const pendentes = [];
      const ctx = { waitUntil: (p) => pendentes.push(p) };
      await servirMidia(new Request(`https://ama.org.br/midia/${caminho}`), { MIDIA }, ctx);
      await Promise.all(pendentes);
      assert.equal(guardadas.size, 1);
      await MIDIA.delete(caminho);
      const doCache = await servirMidia(new Request(`https://ama.org.br/midia/${caminho}`), { MIDIA }, ctx);
      assert.equal(doCache.status, 200, 'veio do cache, não do bucket');
    } finally {
      delete globalThis.caches;
    }
  });
});

describe('worker/r2.js e armazenamentos', () => {
  test('armazenamentoR2: gravar, lerTexto, existe, listar (com várias páginas) e apagar', async () => {
    const bucket = bucketR2Falso();
    const r2 = armazenamentoR2(bucket);
    await r2.gravar('site/2026-10/a-a1b2c3.png', PNG, { tipo: 'image/png' });
    await r2.gravar(CHAVE_HOME, '<p>olá</p>', { tipo: 'text/html; charset=utf-8' });
    assert.equal(await r2.lerTexto(CHAVE_HOME), '<p>olá</p>');
    assert.equal(await r2.lerTexto('nao/existe'), null);
    assert.equal(await r2.existe('site/2026-10/a-a1b2c3.png'), true);
    const lista = await r2.listar('site/');
    assert.equal(lista.length, 1);
    assert.equal(lista[0].chave, 'site/2026-10/a-a1b2c3.png');
    assert.equal(lista[0].tamanho, PNG.length);
    assert.equal(lista[0].tipo, 'image/png');
    assert.match(lista[0].criado_em, /^\d{4}-\d{2}-\d{2}T/);
    for (let i = 0; i < 1005; i += 1) await bucket.put(`videos/v-${String(i).padStart(4, '0')}.mp4`, 'x');
    assert.equal((await r2.listar('videos/')).length, 1005);
    assert.equal(await r2.apagar('site/2026-10/a-a1b2c3.png'), true);
    assert.equal(await r2.apagar('site/2026-10/a-a1b2c3.png'), false);
  });

  test('armazenamentoLocal (pasta): mesma interface, tipo gravado e sem sair da pasta', async () => {
    const pasta = mkdtempSync(path.join(tmpdir(), 'ama-midia-'));
    try {
      const local = armazenamentoLocal(pasta);
      await local.gravar('produtos/2026-10/b-a1b2c3.webp', PNG, { tipo: 'image/webp' });
      await local.gravar(CHAVE_HOME, 'html');
      assert.equal(await local.lerTexto(CHAVE_HOME), 'html');
      assert.equal(await local.lerTexto('produtos/nada.png'), null);
      assert.equal(await local.existe('produtos/2026-10/b-a1b2c3.webp'), true);
      const lista = await local.listar('produtos/');
      assert.deepEqual(lista.map((o) => [o.chave, o.tamanho, o.tipo]), [['produtos/2026-10/b-a1b2c3.webp', PNG.length, 'image/webp']]);
      assert.deepEqual(await local.listar('videos/'), []);
      assert.equal(await local.apagar('produtos/2026-10/b-a1b2c3.webp'), true);
      assert.equal(await local.apagar('produtos/2026-10/b-a1b2c3.webp'), false);
      await assert.rejects(local.gravar('../fora.txt', 'x'));
      await assert.rejects(local.lerTexto('site/../../fora.txt'));
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  });

  test('caminhoDeMidiaValido', () => {
    for (const ok of ['site/2026-10/a-a1b2c3.jpg', 'produtos/x.png', 'videos/2026-10/v.mp4']) assert.equal(caminhoDeMidiaValido(ok), ok);
    for (const ruim of ['', 'site', 'outra/a.png', '_publicado/home.html', 'site/../x.png', 'site//a.png', '/site/a.png',
      'site/a b.png', 'site/.oculto', 'site/a.png/', `site/${'a'.repeat(400)}.png`]) {
      assert.equal(caminhoDeMidiaValido(ruim), null, ruim);
    }
  });
});

// ---------------------------------------------------------------------------

describe('api/admin/midia.js', () => {
  let armazenamento;
  beforeEach(() => {
    armazenamento = armazenamentoMemoria();
    definirArmazenamento(armazenamento);
  });
  const enviar = (caminho, corpo, tipo = 'image/png') => chamarHandler(adminMidia, {
    method: 'POST', url: `/api/admin/midia?caminho=${encodeURIComponent(caminho)}`, query: { caminho },
    headers: { ...comAdmin, 'content-type': tipo }, body: corpo === undefined ? undefined : Buffer.from(corpo),
  });

  test('sem login → 401 (antes de mexer no armazenamento)', async () => {
    aplicarAmbiente(SUPABASE);
    const r = await chamarHandler(adminMidia, { method: 'GET', url: '/api/admin/midia' });
    assert.equal(r.statusCode, 401);
  });

  test('envia, lista (mais novos primeiro, por pasta) e apaga', async () => {
    supabaseComAdmin();
    const r = await enviar('produtos/2026-10/colar-a1b2c3.png', PNG);
    assert.equal(r.statusCode, 200, r.corpo);
    assert.deepEqual(r.json(), {
      ok: true, url: '/midia/produtos/2026-10/colar-a1b2c3.png', caminho: 'produtos/2026-10/colar-a1b2c3.png', tamanho: PNG.length, tipo: 'image/png',
    });
    assert.equal(armazenamento.arquivos.get('produtos/2026-10/colar-a1b2c3.png').tipo, 'image/png');
    await enviar('site/2026-10/logo-d4e5f6.webp', PNG, 'image/webp');
    await armazenamento.gravar(CHAVE_HOME, 'não aparece na biblioteca');

    const todas = await chamarHandler(adminMidia, { method: 'GET', url: '/api/admin/midia', headers: comAdmin });
    assert.equal(todas.statusCode, 200);
    assert.deepEqual(todas.json().arquivos.map((a) => [a.caminho, a.pasta, a.categoria, a.url]), [
      ['site/2026-10/logo-d4e5f6.webp', 'site', 'imagem', '/midia/site/2026-10/logo-d4e5f6.webp'],
      ['produtos/2026-10/colar-a1b2c3.png', 'produtos', 'imagem', '/midia/produtos/2026-10/colar-a1b2c3.png'],
    ]);
    const produtos = await chamarHandler(adminMidia, { method: 'GET', url: '/api/admin/midia?pasta=produtos', query: { pasta: 'produtos' }, headers: comAdmin });
    assert.deepEqual(produtos.json().arquivos.map((a) => a.nome), ['colar-a1b2c3.png']);

    const apagar = (caminho) => chamarHandler(adminMidia, { method: 'DELETE', url: '/api/admin/midia', query: { caminho }, headers: comAdmin });
    assert.equal((await apagar('produtos/2026-10/colar-a1b2c3.png')).statusCode, 200);
    assert.equal((await apagar('produtos/2026-10/colar-a1b2c3.png')).statusCode, 404);
  });

  test('recusa: nome repetido (409), tipo não aceito (415), extensão trocada, vazio, caminho e pasta inválidos', async () => {
    supabaseComAdmin();
    assert.equal((await enviar('site/2026-10/a-a1b2c3.png', PNG)).statusCode, 200);
    const repetido = await enviar('site/2026-10/a-a1b2c3.png', PNG);
    assert.equal(repetido.statusCode, 409);
    assert.equal(repetido.json().erro, 'duplicado');
    assert.equal((await enviar('site/2026-10/b.svg', '<svg/>', 'image/svg+xml')).statusCode, 415);
    assert.equal((await enviar('site/2026-10/b.html', '<p>', 'text/html')).statusCode, 415);
    assert.equal((await enviar('site/2026-10/b.html', PNG, 'image/png')).json().erro, 'extensao_invalida');
    assert.equal((await enviar('site/2026-10/b.mp4', PNG, 'image/png')).json().erro, 'extensao_invalida');
    assert.equal((await enviar('site/2026-10/vazio.png', '')).json().erro, 'arquivo_vazio');
    for (const caminho of ['../x.png', '_publicado/home.png', 'site/../x.png', 'outra/x.png']) {
      assert.equal((await enviar(caminho, PNG)).json().erro, 'caminho_invalido', caminho);
    }
    const pasta = await chamarHandler(adminMidia, { method: 'GET', url: '/api/admin/midia', query: { pasta: 'outra' }, headers: comAdmin });
    assert.equal(pasta.statusCode, 400);
    const grande = await chamarHandler(adminMidia, {
      method: 'POST', url: '/api/admin/midia', query: { caminho: 'videos/2026-10/v.mp4' },
      headers: { ...comAdmin, 'content-type': 'video/mp4', 'content-length': String(51 * 1024 * 1024) }, body: Buffer.from('x'),
    });
    assert.equal(grande.statusCode, 413);
  });

  test('sem armazenamento configurado → 503', async () => {
    supabaseComAdmin();
    definirArmazenamento(null);
    const r = await chamarHandler(adminMidia, { method: 'GET', url: '/api/admin/midia', headers: comAdmin });
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().erro, 'armazenamento_nao_configurado');
  });
});

describe('api/admin/home.js', () => {
  let armazenamento;
  const analisar = (html) => parseHTML(html).document;
  beforeEach(() => {
    armazenamento = armazenamentoMemoria();
    definirArmazenamento(armazenamento);
    definirTemplateHome(TEMPLATE);
  });
  const publicar = (corpo) => chamarHandler(adminHome, { method: 'POST', url: '/api/admin/home', headers: comAdmin, body: corpo });

  test('GET sem publicação; POST grava a home e a assinatura; GET devolve a assinatura', async () => {
    supabaseComAdmin();
    const antes = await chamarHandler(adminHome, { method: 'GET', url: '/api/admin/home', headers: comAdmin });
    assert.deepEqual(antes.json(), { ok: true, publicada: false, assinatura: null, publicado_em: null });

    const html = montarHome(TEMPLATE, { 'quem-somos.titulo': 'Título novo' }, analisar);
    const r = await publicar({ html, assinatura: 'ab'.repeat(32) });
    assert.equal(r.statusCode, 200, r.corpo);
    assert.equal(await armazenamento.lerTexto(CHAVE_HOME), html);
    const info = JSON.parse(await armazenamento.lerTexto(CHAVE_HOME_INFO));
    assert.equal(info.assinatura, 'ab'.repeat(32));
    assert.equal(info.por, 'admin@ama.local');

    const depois = await chamarHandler(adminHome, { method: 'GET', url: '/api/admin/home', headers: comAdmin });
    assert.equal(depois.json().publicada, true);
    assert.equal(depois.json().assinatura, 'ab'.repeat(32));
    assert.equal(depois.json().publicado_em, info.publicado_em);
  });

  test('recusa HTML com script novo (422) e assinatura inválida (400), sem gravar', async (t) => {
    silenciar(t);
    supabaseComAdmin();
    const html = montarHome(TEMPLATE, {}, analisar).replace('</body>', '<script>alert(1)</script></body>');
    const r = await publicar({ html, assinatura: 'ab'.repeat(32) });
    assert.equal(r.statusCode, 422);
    assert.equal(r.json().erro, 'home_invalida');
    assert.equal((await publicar({ html: TEMPLATE, assinatura: 'nao-hex' })).statusCode, 400);
    assert.equal(armazenamento.arquivos.size, 0);
  });

  test('sem login → 401', async () => {
    aplicarAmbiente(SUPABASE);
    assert.equal((await chamarHandler(adminHome, { method: 'POST', url: '/api/admin/home', body: { html: TEMPLATE } })).statusCode, 401);
  });
});

// ---------------------------------------------------------------------------

describe('publicar-home.js (painel)', () => {
  test('assinatura não depende da ordem das linhas e muda com o template ou o conteúdo', async () => {
    const a = [{ chave: 'b', valor: 1 }, { chave: 'a', valor: { x: [1] } }];
    const b = [{ chave: 'a', valor: { x: [1] } }, { chave: 'b', valor: 1 }];
    assert.equal(conteudoCanonico(a), conteudoCanonico(b));
    assert.equal(await assinaturaDe('t', a), await assinaturaDe('t', b));
    assert.match(await assinaturaDe('t', a), /^[0-9a-f]{64}$/);
    assert.notEqual(await assinaturaDe('t2', a), await assinaturaDe('t', a));
    assert.notEqual(await assinaturaDe('t', [{ chave: 'a', valor: 2 }]), await assinaturaDe('t', a));
  });

  test('publicarHome: só publica quando a assinatura muda (ou com forcar) e o servidor aceita o HTML', async () => {
    globalThis.DOMParser = DOMParser;
    const linhas = [{ chave: 'quem-somos.titulo', valor: 'Quem somos nós' }];
    let publicadaNoServidor = null;
    const supabase = {
      auth: { getSession: async () => ({ data: { session: { access_token: 'jwt' } } }) },
      from: () => ({ select: async () => ({ data: linhas, error: null, status: 200 }) }),
    };
    configurarApi({ supabase, supabaseUrl: URL_SUPA, supabaseAnonKey: 'anon' });
    definirTemplateHome(TEMPLATE);
    fetchSimulado = simularFetch((url, init, chamada) => {
      if (url === '/?modelo=1') return new Response(TEMPLATE, { status: 200 });
      if (url === '/api/admin/home' && chamada.metodo === 'GET') {
        return respostaJson(200, { ok: true, publicada: Boolean(publicadaNoServidor), assinatura: publicadaNoServidor && publicadaNoServidor.assinatura });
      }
      if (url === '/api/admin/home' && chamada.metodo === 'POST') {
        publicadaNoServidor = JSON.parse(chamada.corpo);
        return respostaJson(200, { ok: true, publicado_em: '2026-10-16T12:00:00Z' });
      }
      return respostaJson(404, {});
    });
    try {
      const primeira = await publicarHome({ supabase });
      assert.deepEqual(primeira, { ok: true, publicado: true });
      assert.equal(validarHomePublicada(publicadaNoServidor.html, TEMPLATE), null);
      assert.match(publicadaNoServidor.html, /Quem somos nós/);
      assert.equal(publicadaNoServidor.assinatura, await assinaturaDe(TEMPLATE, linhas));

      const posts = () => fetchSimulado.chamadas.filter((c) => c.metodo === 'POST').length;
      assert.deepEqual(await publicarHome({ supabase }), { ok: true, publicado: false });
      assert.equal(posts(), 1);
      assert.deepEqual(await publicarHome({ supabase, forcar: true }), { ok: true, publicado: true });
      assert.equal(posts(), 2);
    } finally {
      delete globalThis.DOMParser;
    }
  });
});

describe('servidor local: /midia/ e /api/admin/midia com a pasta local', () => {
  test('arquivo enviado aparece em /midia/<caminho> com Range', async () => {
    const pasta = mkdtempSync(path.join(tmpdir(), 'ama-dev-midia-'));
    const local = armazenamentoLocal(pasta);
    await local.gravar('videos/2026-10/v-a1b2c3.mp4', PNG, { tipo: 'video/mp4' });
    const servidor = await subirServidor(AMBIENTE_VAZIO, { armazenamento: local });
    try {
      const r = await fetch(`${servidor.url}/midia/videos/2026-10/v-a1b2c3.mp4`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('content-type'), 'video/mp4');
      assert.deepEqual(new Uint8Array(await r.arrayBuffer()), PNG);
      const parte = await fetch(`${servidor.url}/midia/videos/2026-10/v-a1b2c3.mp4`, { headers: { Range: 'bytes=0-3' } });
      assert.equal(parte.status, 206);
      assert.equal((await fetch(`${servidor.url}/midia/videos/2026-10/nao.mp4`)).status, 404);
      assert.equal((await fetch(`${servidor.url}/midia/_publicado/home.html`)).status, 404);
      assert.equal((await fetch(`${servidor.url}/_headers`)).status, 404);
    } finally {
      await servidor.fechar();
      rmSync(pasta, { recursive: true, force: true });
    }
  });
});
