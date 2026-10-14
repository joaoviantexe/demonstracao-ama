// Testes do servidor local (scripts/dev-server.mjs) em porta aleatória, sem rede externa.
// Requer o cwd na raiz do repositório (npm test), porque o api/render.js lê templates/ de lá.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { carregarEnv, fonteParaRegex } from '../../scripts/dev-server.mjs';
import { AMBIENTE_VAZIO, aplicarAmbiente, subirServidor } from '../apoio/servidor.js';

const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const HTTP_JS = pathToFileURL(path.join(RAIZ, 'lib', 'http.js')).href;

// Requisição HTTP crua (o caminho vai exatamente como escrito, sem normalização do cliente).
function pedir(base, caminho, { method = 'GET', headers = {}, body } = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: caminho, method, headers }, (res) => {
      const partes = [];
      res.on('data', (p) => partes.push(p));
      res.on('end', () => {
        const corpo = Buffer.concat(partes);
        resolve({ status: res.statusCode, headers: res.headers, corpo: corpo.toString('utf8'), bytes: corpo });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const json = (r) => JSON.parse(r.corpo);

describe('dev-server com public/ e api/ reais', () => {
  let servidor;
  before(async () => { servidor = await subirServidor(AMBIENTE_VAZIO); });
  after(async () => { await servidor.fechar(); });

  test('GET / devolve a home (rewrite para api/render) com os cabeçalhos do vercel.json', async () => {
    const r = await pedir(servidor.url, '/');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(r.headers['x-ama-cms'], 'padrao');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['referrer-policy'], 'strict-origin-when-cross-origin');
    assert.equal(r.headers['x-frame-options'], undefined);
    assert.match(r.corpo, /^<!doctype html>/i);
    assert.match(r.corpo, /<\/html>\s*$/i);
  });

  test('HEAD / e /?modelo=1', async () => {
    const head = await pedir(servidor.url, '/', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.corpo, '');
    const modelo = await pedir(servidor.url, '/?modelo=1');
    assert.equal(modelo.status, 200);
    assert.equal(modelo.headers['cache-control'], 'no-store');
  });

  test('GET /api/config', async () => {
    const r = await pedir(servidor.url, '/api/config');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'application/javascript; charset=utf-8');
    assert.match(r.corpo, /^window\.AMA_CONFIG = \{.*"configurado":false\};$/);
  });

  test('estáticos com o tipo MIME certo; POST em estático → 405', async () => {
    const css = await pedir(servidor.url, '/css/estilo.css');
    assert.equal(css.status, 200);
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(css.headers['x-content-type-options'], 'nosniff');
    const png = await pedir(servidor.url, '/img/logo-ama.png');
    assert.equal(png.status, 200);
    assert.equal(png.headers['content-type'], 'image/png');
    assert.equal(png.bytes.subarray(1, 4).toString('latin1'), 'PNG');
    const js = await pedir(servidor.url, '/js/cms/aplicar.js');
    assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8');
    const post = await pedir(servidor.url, '/css/estilo.css', { method: 'POST' });
    assert.equal(post.status, 405);
  });

  test('Range em arquivos (vídeo no Safari precisa)', async () => {
    const r = await pedir(servidor.url, '/img/logo-ama.png', { headers: { range: 'bytes=0-9' } });
    assert.equal(r.status, 206);
    assert.equal(r.bytes.length, 10);
    assert.match(r.headers['content-range'], /^bytes 0-9\/\d+$/);
    const ruim = await pedir(servidor.url, '/img/logo-ama.png', { headers: { range: 'bytes=999999999-' } });
    assert.equal(ruim.status, 416);
  });

  test('path traversal bloqueado', async () => {
    for (const caminho of ['/../package.json', '/..%2fpackage.json', '/css/..%2f..%2fpackage.json',
      '/%2e%2e/%2e%2e/package.json', '/css/%2e%2e%2f%2e%2e%2fpackage.json', '/..%5c..%5cpackage.json',
      '/img/..%2f..%2flib/http.js', '/%2e%2e%2ftemplates/home.html']) {
      const r = await pedir(servidor.url, caminho);
      assert.notEqual(r.status, 200, caminho);
      assert.doesNotMatch(r.corpo, /"devDependencies"|export function lerCorpo|data-cms/, caminho);
    }
    for (const caminho of ['/api/..%2f..%2fpackage', '/api/..%2flib%2fhttp', '/api/%2e%2e/lib/http',
      '/api/..%2f..%2fscripts/dev-server']) {
      const r = await pedir(servidor.url, caminho);
      assert.equal(r.status, 404, caminho);
      assert.doesNotMatch(r.corpo, /export |import /, caminho);
    }
  });

  test('/api inexistente → 404 em JSON', async () => {
    for (const caminho of ['/api/nao-existe', '/api', '/api/', '/api/loja/nao-existe']) {
      const r = await pedir(servidor.url, caminho);
      assert.equal(r.status, 404, caminho);
      assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
      assert.deepEqual(json(r), { ok: false, erro: 'nao_encontrado', mensagem: 'Rota não encontrada.' });
    }
  });

  test('cleanUrls: /index.html e /x.html redirecionam com 308', async () => {
    const indice = await pedir(servidor.url, '/index.html?a=1');
    assert.equal(indice.status, 308);
    assert.equal(indice.headers.location, '/?a=1');
    const html = await pedir(servidor.url, '/loja/produto.html?slug=colar');
    assert.equal(html.status, 308);
    assert.equal(html.headers.location, '/loja/produto?slug=colar');
  });

  test('página inexistente → 404 HTML', async () => {
    const r = await pedir(servidor.url, '/nao-existe');
    assert.equal(r.status, 404);
    assert.match(r.headers['content-type'], /^text\/html/);
  });
});

describe('dev-server com pastas de teste (cleanUrls, req.body da Vercel, recarga)', () => {
  let pasta;
  let dirApi;
  let servidor;

  before(async () => {
    pasta = mkdtempSync(path.join(tmpdir(), 'ama-dev-'));
    const publico = path.join(pasta, 'public');
    dirApi = path.join(pasta, 'api');
    for (const dir of ['loja', 'admin', 'sub/dir']) mkdirSync(path.join(publico, dir), { recursive: true });
    mkdirSync(path.join(dirApi, 'grupo'), { recursive: true });
    writeFileSync(path.join(publico, 'loja', 'produto.html'), '<!doctype html><title>produto</title>');
    writeFileSync(path.join(publico, 'loja', 'index.html'), '<!doctype html><title>catalogo</title>');
    writeFileSync(path.join(publico, 'admin', 'index.html'), '<!doctype html><title>painel</title>');
    writeFileSync(path.join(publico, 'sub', 'dir', 'arquivo.json'), '{"a":1}');
    writeFileSync(path.join(publico, '.env'), 'SEGREDO=1');
    writeFileSync(path.join(publico, 'evil.com.html'), 'x');

    writeFileSync(path.join(dirApi, 'eco.js'), `
import { lerCorpo, lerQuery, responderJson, tratarErro } from '${HTTP_JS}';
export default async function handler(req, res) {
  try {
    const corpo = req.method === 'POST' ? await lerCorpo(req) : null;
    responderJson(res, 200, { ok: true, corpo, query: lerQuery(req), cookies: req.cookies, temBody: 'body' in req });
  } catch (erro) {
    tratarErro(res, erro);
  }
}
`);
    writeFileSync(path.join(dirApi, 'cru.js'), `
export default function handler(req, res) {
  const corpo = req.body; // lança com JSON inválido, como na Vercel
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ tipo: Buffer.isBuffer(corpo) ? 'buffer' : typeof corpo, corpo: Buffer.isBuffer(corpo) ? corpo.toString() : corpo }));
}
`);
    writeFileSync(path.join(dirApi, 'versao.js'), 'export default (req, res) => res.end("v1");\n');
    writeFileSync(path.join(dirApi, 'quebra.js'), 'export default () => { throw new Error("falhou"); };\n');
    writeFileSync(path.join(dirApi, '_privado.js'), 'export default (req, res) => res.end("privado");\n');
    writeFileSync(path.join(dirApi, 'grupo', 'rota.js'), 'export default (req, res) => res.status(201).json({ rota: "grupo/rota" });\n');
    writeFileSync(path.join(dirApi, 'render.js'), 'export default (req, res) => res.end("render " + req.url);\n');

    servidor = await subirServidor(AMBIENTE_VAZIO, { dirPublico: publico, dirApi });
  });

  after(async () => {
    await servidor.fechar();
    rmSync(pasta, { recursive: true, force: true });
  });

  test('cleanUrls: /loja/produto, /loja/, /loja e /admin/', async () => {
    const produto = await pedir(servidor.url, '/loja/produto?slug=x');
    assert.equal(produto.status, 200);
    assert.match(produto.corpo, /produto/);
    assert.equal(produto.headers['content-type'], 'text/html; charset=utf-8');
    assert.match((await pedir(servidor.url, '/loja/')).corpo, /catalogo/);
    assert.match((await pedir(servidor.url, '/loja')).corpo, /catalogo/);
    const admin = await pedir(servidor.url, '/admin/');
    assert.equal(admin.status, 200);
    assert.match(admin.corpo, /painel/);
    assert.equal(admin.headers['x-frame-options'], 'DENY');
    assert.equal((await pedir(servidor.url, '/admin')).headers['x-frame-options'], 'DENY');
    assert.equal(produto.headers['x-frame-options'], undefined);
    const redir = await pedir(servidor.url, '/admin/index.html');
    assert.equal(redir.status, 308);
    assert.equal(redir.headers.location, '/admin');
    const json = await pedir(servidor.url, '/sub/dir/arquivo.json');
    assert.equal(json.headers['content-type'], 'application/json; charset=utf-8');
  });

  test('"/" vai para api/render quando não há public/index.html', async () => {
    const r = await pedir(servidor.url, '/?modelo=1');
    assert.equal(r.corpo, 'render /?modelo=1');
  });

  test('arquivos ocultos não são servidos; redirecionamento não sai do domínio', async () => {
    assert.equal((await pedir(servidor.url, '/.env')).status, 404);
    const r = await pedir(servidor.url, '//evil.com.html');
    assert.equal(r.status, 308);
    assert.equal(r.headers.location, '/evil.com');
  });

  test('POST com JSON válido, vazio e inválido (handler que usa lerCorpo)', async () => {
    const tipoJson = { 'content-type': 'application/json' };
    const ok = await pedir(servidor.url, '/api/eco', { method: 'POST', headers: tipoJson, body: '{"nome":"Ana"}' });
    assert.equal(ok.status, 200);
    assert.deepEqual(json(ok).corpo, { nome: 'Ana' });
    assert.equal(json(ok).temBody, true, 'req.body existe, como na Vercel');

    const vazio = await pedir(servidor.url, '/api/eco', { method: 'POST', headers: tipoJson });
    assert.deepEqual(json(vazio).corpo, {});

    const invalido = await pedir(servidor.url, '/api/eco', { method: 'POST', headers: tipoJson, body: '{"nome":' });
    assert.equal(invalido.status, 400);
    assert.equal(json(invalido).erro, 'json_invalido');

    const array = await pedir(servidor.url, '/api/eco', { method: 'POST', headers: tipoJson, body: '[1]' });
    assert.equal(array.status, 400);

    // Com Content-Length e em "chunked" (sem Content-Length).
    const corpoGrande = JSON.stringify({ a: 'x'.repeat(120_000) });
    const grande = await pedir(servidor.url, '/api/eco', {
      method: 'POST', headers: { ...tipoJson, 'content-length': Buffer.byteLength(corpoGrande) }, body: corpoGrande,
    });
    assert.equal(grande.status, 413);
    assert.equal(json(grande).erro, 'corpo_muito_grande');
    const chunked = await pedir(servidor.url, '/api/eco', { method: 'POST', headers: tipoJson, body: corpoGrande });
    assert.equal(chunked.status, 413);
  });

  test('req.body imita a Vercel: getter lança em JSON inválido; tipos por Content-Type', async () => {
    const lanca = await pedir(servidor.url, '/api/cru', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{x',
    });
    assert.equal(lanca.status, 500, 'sem try/catch o erro derruba a função');
    assert.equal(json(lanca).erro, 'erro_interno');

    const semTipo = await pedir(servidor.url, '/api/cru', { method: 'POST', body: '{"a":1}' });
    assert.deepEqual(json(semTipo), { tipo: 'string', corpo: '' });
    const texto = await pedir(servidor.url, '/api/cru', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'olá',
    });
    assert.deepEqual(json(texto), { tipo: 'string', corpo: 'olá' });
    const form = await pedir(servidor.url, '/api/cru', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1&b=2',
    });
    assert.deepEqual(json(form), { tipo: 'object', corpo: { a: '1', b: '2' } });
    const binario = await pedir(servidor.url, '/api/cru', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'bin',
    });
    assert.deepEqual(json(binario), { tipo: 'buffer', corpo: 'bin' });
    const multipart = await pedir(servidor.url, '/api/cru', {
      method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: '--x--',
    });
    assert.deepEqual(json(multipart), { tipo: 'undefined' });
  });

  test('req.query (repetido vira array na Vercel; lerQuery pega o último) e req.cookies', async () => {
    const r = await pedir(servidor.url, '/api/eco?data.id=123&a=1&a=2', { headers: { cookie: 'x=1; y=a%20b' } });
    assert.equal(r.status, 200);
    assert.deepEqual(json(r).query, { 'data.id': '123', a: '2' });
    assert.deepEqual(json(r).cookies, { x: '1', y: 'a b' });
  });

  test('rotas em subpastas, res.status().json() e arquivos com "_" ignorados', async () => {
    const r = await pedir(servidor.url, '/api/grupo/rota');
    assert.equal(r.status, 201);
    assert.deepEqual(json(r), { rota: 'grupo/rota' });
    assert.equal((await pedir(servidor.url, '/api/_privado')).status, 404);
  });

  test('handler que lança → 500 em JSON', async (t) => {
    t.mock.method(console, 'error', () => {});
    const r = await pedir(servidor.url, '/api/quebra');
    assert.equal(r.status, 500);
    assert.equal(json(r).ok, false);
  });

  test('módulos de api/ são recarregados a cada requisição', async () => {
    assert.equal((await pedir(servidor.url, '/api/versao')).corpo, 'v1');
    writeFileSync(path.join(dirApi, 'versao.js'), 'export default (req, res) => res.end("v2");\n');
    assert.equal((await pedir(servidor.url, '/api/versao')).corpo, 'v2');
  });
});

describe('fonteParaRegex (sources do vercel.json)', () => {
  test('grupos e parâmetros', () => {
    assert.equal(fonteParaRegex('/(.*)').test('/'), true);
    assert.equal(fonteParaRegex('/(.*)').test('/qualquer/coisa'), true);
    assert.equal(fonteParaRegex('/admin/(.*)').test('/admin/'), true);
    assert.equal(fonteParaRegex('/admin/(.*)').test('/admin/js/app.js'), true);
    assert.equal(fonteParaRegex('/admin/(.*)').test('/administrador'), false);
    assert.equal(fonteParaRegex('/admin').test('/admin'), true);
    assert.equal(fonteParaRegex('/p/:slug').test('/p/colar'), true);
    assert.equal(fonteParaRegex('/p/:slug').test('/p/a/b'), false);
    assert.equal(fonteParaRegex('/a.b').test('/aXb'), false);
  });
});

describe('carregarEnv (.env do dev-server)', () => {
  test('lê NOME=valor, aspas, export e comentários sem sobrescrever o ambiente', () => {
    const pasta = mkdtempSync(path.join(tmpdir(), 'ama-env-'));
    const arquivo = path.join(pasta, '.env');
    writeFileSync(arquivo, [
      '# comentário',
      'AMA_T_SIMPLES=valor',
      'AMA_T_ASPAS="com espaço # não é comentário"',
      "AMA_T_SIMPLES_ASPAS='literal $x'",
      'export AMA_T_EXPORT=sim',
      'AMA_T_COMENTARIO=abc # comentário',
      'AMA_T_VAZIO=',
      'AMA_T_EXISTENTE=do-arquivo',
      'linha invalida',
      '',
    ].join('\n'));
    const restaurar = aplicarAmbiente({
      AMA_T_SIMPLES: undefined, AMA_T_ASPAS: undefined, AMA_T_SIMPLES_ASPAS: undefined, AMA_T_EXPORT: undefined,
      AMA_T_COMENTARIO: undefined, AMA_T_VAZIO: undefined, AMA_T_EXISTENTE: 'do-ambiente',
    });
    try {
      const carregadas = carregarEnv(arquivo);
      assert.equal(process.env.AMA_T_SIMPLES, 'valor');
      assert.equal(process.env.AMA_T_ASPAS, 'com espaço # não é comentário');
      assert.equal(process.env.AMA_T_SIMPLES_ASPAS, 'literal $x');
      assert.equal(process.env.AMA_T_EXPORT, 'sim');
      assert.equal(process.env.AMA_T_COMENTARIO, 'abc');
      assert.equal(process.env.AMA_T_VAZIO, '');
      assert.equal(process.env.AMA_T_EXISTENTE, 'do-ambiente', 'não sobrescreve');
      assert.equal(carregadas.includes('AMA_T_EXISTENTE'), false);
      assert.deepEqual(carregarEnv(path.join(pasta, 'nao-existe')), []);
    } finally {
      restaurar();
      for (const nome of ['AMA_T_SIMPLES', 'AMA_T_ASPAS', 'AMA_T_SIMPLES_ASPAS', 'AMA_T_EXPORT', 'AMA_T_COMENTARIO', 'AMA_T_VAZIO']) {
        delete process.env[nome];
      }
      rmSync(pasta, { recursive: true, force: true });
    }
  });
});

describe('vercel.json', () => {
  test('segue o contrato da §2.1', () => {
    const config = JSON.parse(readFileSync(path.join(RAIZ, 'vercel.json'), 'utf8'));
    assert.equal(config.outputDirectory, 'public');
    assert.equal(config.cleanUrls, true);
    assert.deepEqual(config.rewrites, [{ source: '/', destination: '/api/render' }]);
    assert.deepEqual(config.functions, { 'api/render.js': { includeFiles: 'templates/**' } });
    assert.equal(typeof config.functions['api/render.js'].includeFiles, 'string');
    assert.deepEqual(config.crons, [{ path: '/api/cron/manter-ativo', schedule: '17 9 * * *' }]);
    const todos = config.headers.find((h) => h.source === '/(.*)');
    assert.deepEqual(todos.headers, [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    ]);
    const admin = config.headers.find((h) => h.source === '/admin/(.*)');
    assert.deepEqual(admin.headers, [{ key: 'X-Frame-Options', value: 'DENY' }]);
  });
});
