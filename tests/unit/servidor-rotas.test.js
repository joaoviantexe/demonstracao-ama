// Testes de api/render.js, api/config.js e api/cron/manter-ativo.js com fetch simulado (sem rede).
// O render lê templates/home.html de process.cwd(): aqui o cwd aponta para uma pasta temporária
// com um template de teste (o template real é anotado por outra etapa).
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import render from '../../api/render.js';
import config from '../../api/config.js';
import manterAtivo from '../../api/cron/manter-ativo.js';
import {
  AMBIENTE_VAZIO, aplicarAmbiente, chamarHandler, esperarAbort, respostaJson, simularFetch,
} from '../apoio/servidor.js';

const URL_SUPA = 'http://supabase.teste';
const ANON = 'sb_publishable_teste';
const SERVICO = 'sb_secret_teste_nao_pode_vazar';

const TEMPLATE = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title data-cms="seo.titulo" data-cms-tipo="texto">Título padrão</title>
</head>
<body>
<h1 class="titulo" data-cms="teste.titulo" data-cms-tipo="texto">Texto padrão</h1>
<p data-cms="teste.paragrafo" data-cms-tipo="texto">Parágrafo padrão</p>
</body>
</html>
`;

let restaurarAmbiente;
let fetchSimulado;
const silenciar = (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
};

beforeEach(() => { restaurarAmbiente = aplicarAmbiente(AMBIENTE_VAZIO); });
afterEach(() => {
  if (fetchSimulado) fetchSimulado.restaurar();
  fetchSimulado = null;
  restaurarAmbiente();
});

describe('api/render.js', () => {
  const cwdOriginal = process.cwd();
  let pasta;

  before(() => {
    pasta = mkdtempSync(path.join(tmpdir(), 'ama-render-'));
    mkdirSync(path.join(pasta, 'templates'));
    writeFileSync(path.join(pasta, 'templates', 'home.html'), TEMPLATE);
    process.chdir(pasta);
  });
  after(() => {
    process.chdir(cwdOriginal);
    rmSync(pasta, { recursive: true, force: true });
  });

  const configurar = () => aplicarAmbiente({ SUPABASE_URL: URL_SUPA, SUPABASE_ANON_KEY: ANON });

  test('sem Supabase: template puro, X-AMA-CMS padrao e cache público', async () => {
    fetchSimulado = simularFetch(() => respostaJson(200, []));
    const res = await chamarHandler(render, { url: '/' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.cabecalhos['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.cabecalhos['x-ama-cms'], 'padrao');
    assert.equal(res.cabecalhos['cache-control'], 'public, s-maxage=15, stale-while-revalidate=600');
    assert.equal(res.corpo, TEMPLATE);
    assert.equal(fetchSimulado.chamadas.length, 0);
  });

  test('chave secreta no lugar da pública: não consulta o banco com ela (X-AMA-CMS padrao)', async (t) => {
    silenciar(t);
    fetchSimulado = simularFetch(() => respostaJson(200, []));
    aplicarAmbiente({ SUPABASE_URL: URL_SUPA, SUPABASE_ANON_KEY: 'sb_secret_render_teste' });
    const res = await chamarHandler(render, { url: '/' });
    assert.equal(res.cabecalhos['x-ama-cms'], 'padrao');
    assert.equal(fetchSimulado.chamadas.length, 0);
  });

  test('com conteúdo no banco: aplica, preserva o doctype e marca X-AMA-CMS banco', async () => {
    configurar();
    fetchSimulado = simularFetch(() => respostaJson(200, [
      { chave: 'teste.titulo', valor: 'Título <b>do banco</b>' },
      { chave: 'seo.titulo', valor: 'AMA — editado' },
    ]));
    const res = await chamarHandler(render, { url: '/' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.cabecalhos['x-ama-cms'], 'banco');
    assert.equal(res.cabecalhos['cache-control'], 'public, s-maxage=15, stale-while-revalidate=600');
    assert.ok(res.corpo.startsWith('<!doctype html>\n<html lang="pt-BR">'), 'doctype igual ao do template');
    assert.match(res.corpo, /<h1 class="titulo"[^>]*>Título &lt;b>do banco&lt;\/b><\/h1>|<h1 class="titulo"[^>]*>Título &lt;b&gt;do banco&lt;\/b&gt;<\/h1>/);
    assert.match(res.corpo, /AMA — editado<\/title>/);
    assert.match(res.corpo, /Parágrafo padrão/, 'chave ausente mantém o padrão');
    assert.doesNotMatch(res.corpo, /Texto padrão/);
    assert.equal(res.cabecalhos['content-length'], String(Buffer.byteLength(res.corpo)));

    assert.equal(fetchSimulado.chamadas.length, 1);
    const [c] = fetchSimulado.chamadas;
    assert.equal(c.url, `${URL_SUPA}/rest/v1/conteudo_site?select=chave,valor`);
    assert.equal(c.cabecalhos.apikey, ANON);
    assert.equal(c.cabecalhos.authorization, `Bearer ${ANON}`);
  });

  test('banco sem linhas: template (aplicado sem mudanças) com X-AMA-CMS banco', async () => {
    configurar();
    fetchSimulado = simularFetch(() => respostaJson(200, []));
    const res = await chamarHandler(render, { url: '/' });
    assert.equal(res.cabecalhos['x-ama-cms'], 'banco');
    assert.match(res.corpo, /^<!doctype html>/i);
    assert.match(res.corpo, /Texto padrão/);
  });

  test('fetch falhando: template puro com X-AMA-CMS padrao', async (t) => {
    silenciar(t);
    configurar();
    fetchSimulado = simularFetch(() => { throw new TypeError('fetch failed'); });
    const res = await chamarHandler(render, { url: '/' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.cabecalhos['x-ama-cms'], 'padrao');
    assert.equal(res.corpo, TEMPLATE);
  });

  test('erro HTTP do Supabase: X-AMA-CMS padrao', async (t) => {
    silenciar(t);
    configurar();
    fetchSimulado = simularFetch(() => respostaJson(500, { message: 'falhou' }));
    const res = await chamarHandler(render, { url: '/' });
    assert.equal(res.cabecalhos['x-ama-cms'], 'padrao');
    assert.equal(res.corpo, TEMPLATE);
  });

  test('Supabase lento: desiste em ~2,5 s e devolve o padrão', async (t) => {
    silenciar(t);
    configurar();
    fetchSimulado = simularFetch((url, init) => esperarAbort(init));
    const inicio = Date.now();
    const res = await chamarHandler(render, { url: '/' });
    const duracao = Date.now() - inicio;
    assert.equal(res.cabecalhos['x-ama-cms'], 'padrao');
    assert.equal(res.corpo, TEMPLATE);
    assert.ok(duracao >= 2000 && duracao < 4500, `durou ${duracao} ms`);
  });

  test('?modelo=1: template cru, no-store e sem consultar o banco', async () => {
    configurar();
    fetchSimulado = simularFetch(() => respostaJson(200, [{ chave: 'teste.titulo', valor: 'X' }]));
    const res = await chamarHandler(render, { url: '/api/render?modelo=1' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.cabecalhos['cache-control'], 'no-store');
    assert.equal(res.cabecalhos['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.corpo, TEMPLATE);
    assert.equal(fetchSimulado.chamadas.length, 0);

    const comQuery = await chamarHandler(render, { url: '/', query: { modelo: '1' } });
    assert.equal(comQuery.corpo, TEMPLATE);
  });

  test('HEAD: cabeçalhos sem corpo', async () => {
    const res = await chamarHandler(render, { method: 'HEAD', url: '/' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.corpo, '');
    assert.equal(res.cabecalhos['x-ama-cms'], 'padrao');
    assert.equal(res.cabecalhos['content-length'], String(Buffer.byteLength(TEMPLATE)));
  });

  test('outros métodos → 405', async () => {
    const res = await chamarHandler(render, { method: 'POST', url: '/' });
    assert.equal(res.statusCode, 405);
    assert.match(res.cabecalhos.allow, /GET/);
    assert.equal(res.json().erro, 'metodo_nao_permitido');
  });
});

describe('api/config.js', () => {
  // Executa o JS devolvido num contexto isolado e lê window.AMA_CONFIG.
  const executar = (codigo) => {
    const contexto = { window: {} };
    vm.runInNewContext(codigo, contexto);
    // Objeto de outro realm: copia para comparar com deepStrictEqual.
    return JSON.parse(JSON.stringify(contexto.window.AMA_CONFIG));
  };

  test('sem Supabase: configurado false e strings vazias', async () => {
    const res = await chamarHandler(config, { url: '/api/config' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.cabecalhos['content-type'], 'application/javascript; charset=utf-8');
    assert.equal(res.cabecalhos['cache-control'], 'public, max-age=300');
    assert.equal(res.corpo, 'window.AMA_CONFIG = {"supabaseUrl":"","supabaseAnonKey":"","configurado":false};');
  });

  test('com Supabase: URL e chave pública, nunca a chave de serviço', async () => {
    aplicarAmbiente({ SUPABASE_URL: `${URL_SUPA}/`, SUPABASE_PUBLISHABLE_KEY: ANON, SUPABASE_SECRET_KEY: SERVICO });
    const res = await chamarHandler(config, { url: '/api/config' });
    assert.equal(res.corpo,
      `window.AMA_CONFIG = {"supabaseUrl":"${URL_SUPA}","supabaseAnonKey":"${ANON}","configurado":true};`);
    assert.doesNotMatch(res.corpo, /sb_secret/);
  });

  test('só a chave de serviço: configurado false e nada vaza', async () => {
    aplicarAmbiente({ SUPABASE_URL: URL_SUPA, SUPABASE_SERVICE_ROLE_KEY: SERVICO });
    const res = await chamarHandler(config, { url: '/api/config' });
    assert.deepEqual(executar(res.corpo), { supabaseUrl: '', supabaseAnonKey: '', configurado: false });
    assert.doesNotMatch(res.corpo, /nao_pode_vazar/);
  });

  test('chave secreta colada no lugar da pública: não publica e loga', async (t) => {
    const log = t.mock.method(console, 'error', () => {});
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const jwt = (role) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'supabase', role, ref: 'cfg' })}.assinatura`;
    const casos = [
      { SUPABASE_ANON_KEY: 'sb_secret_config_teste' },
      { NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_config_teste_2' },
      { SUPABASE_ANON_KEY: jwt('service_role') },
      { SUPABASE_PUBLISHABLE_KEY: 'chave-igual-config', SUPABASE_SECRET_KEY: 'chave-igual-config' },
    ];
    for (const caso of casos) {
      const restaurar = aplicarAmbiente({ SUPABASE_URL: URL_SUPA, ...caso });
      const res = await chamarHandler(config, { url: '/api/config' });
      restaurar();
      assert.equal(res.statusCode, 200);
      assert.deepEqual(executar(res.corpo), { supabaseUrl: '', supabaseAnonKey: '', configurado: false }, JSON.stringify(caso));
      for (const valor of Object.values(caso)) assert.equal(res.corpo.includes(valor), false, 'a chave não pode vazar');
    }
    assert.ok(log.mock.callCount() >= casos.length, 'cada engano é logado');

    // JWT legado com role anon é público de verdade.
    const anon = jwt('anon');
    aplicarAmbiente({ SUPABASE_URL: URL_SUPA, SUPABASE_ANON_KEY: anon });
    const res = await chamarHandler(config, { url: '/api/config' });
    assert.deepEqual(executar(res.corpo), { supabaseUrl: URL_SUPA, supabaseAnonKey: anon, configurado: true });
  });

  test('serialização segura contra </script>, <!-- e U+2028/U+2029', async () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const chave = `abc</script><script>alert(1)</script><!--${ls}${ps}&`;
    aplicarAmbiente({ SUPABASE_URL: URL_SUPA, SUPABASE_ANON_KEY: chave });
    const res = await chamarHandler(config, { url: '/api/config' });
    assert.doesNotMatch(res.corpo, /<\/script/i);
    assert.doesNotMatch(res.corpo, /<!--/);
    assert.equal(res.corpo.includes(ls), false);
    assert.equal(res.corpo.includes(ps), false);
    assert.deepEqual(executar(res.corpo), { supabaseUrl: URL_SUPA, supabaseAnonKey: chave, configurado: true });
  });

  test('HEAD sem corpo; POST → 405', async () => {
    const head = await chamarHandler(config, { method: 'HEAD', url: '/api/config' });
    assert.equal(head.statusCode, 200);
    assert.equal(head.corpo, '');
    const post = await chamarHandler(config, { method: 'POST', url: '/api/config' });
    assert.equal(post.statusCode, 405);
  });
});

describe('api/cron/manter-ativo.js', () => {
  const configurar = (extra = {}) => aplicarAmbiente({
    SUPABASE_URL: URL_SUPA, SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICO, ...extra,
  });

  test('com CRON_SECRET: sem Authorization → 401 sem tocar no banco', async () => {
    configurar({ CRON_SECRET: 'segredo-cron' });
    fetchSimulado = simularFetch(() => respostaJson(200, [{ chave: 'loja' }]));
    const res = await chamarHandler(manterAtivo, { url: '/api/cron/manter-ativo' });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().ok, false);
    assert.equal(fetchSimulado.chamadas.length, 0);
  });

  test('com CRON_SECRET: Bearer errado → 401', async () => {
    configurar({ CRON_SECRET: 'segredo-cron' });
    fetchSimulado = simularFetch(() => respostaJson(200, []));
    for (const authorization of ['Bearer outro', 'segredo-cron', 'Bearer segredo-cron2', 'bearer  segredo-cron']) {
      const res = await chamarHandler(manterAtivo, { url: '/api/cron/manter-ativo', headers: { authorization } });
      assert.equal(res.statusCode, 401, authorization);
    }
    assert.equal(fetchSimulado.chamadas.length, 0);
  });

  test('com CRON_SECRET certo: leitura leve com a chave de serviço → { ok: true }', async () => {
    configurar({ CRON_SECRET: 'segredo-cron' });
    fetchSimulado = simularFetch(() => respostaJson(200, [{ chave: 'loja' }]));
    const res = await chamarHandler(manterAtivo, {
      url: '/api/cron/manter-ativo', headers: { authorization: 'Bearer segredo-cron' },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
    assert.equal(res.cabecalhos['cache-control'], 'no-store');
    const [c] = fetchSimulado.chamadas;
    assert.equal(c.url, `${URL_SUPA}/rest/v1/configuracoes?select=chave&limit=1`);
    assert.equal(c.cabecalhos.apikey, SERVICO);
  });

  test('sem CRON_SECRET: não exige Authorization', async () => {
    configurar();
    fetchSimulado = simularFetch(() => respostaJson(200, []));
    const res = await chamarHandler(manterAtivo, { url: '/api/cron/manter-ativo' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { ok: true });
  });

  test('só a chave pública: a leitura pública também serve', async () => {
    aplicarAmbiente({ SUPABASE_URL: URL_SUPA, SUPABASE_ANON_KEY: ANON });
    fetchSimulado = simularFetch(() => respostaJson(200, []));
    const res = await chamarHandler(manterAtivo, { url: '/api/cron/manter-ativo' });
    assert.equal(res.statusCode, 200);
    assert.equal(fetchSimulado.chamadas[0].cabecalhos.apikey, ANON);
  });

  test('sem Supabase → 503', async () => {
    aplicarAmbiente({ CRON_SECRET: 'segredo-cron' });
    const res = await chamarHandler(manterAtivo, {
      url: '/api/cron/manter-ativo', headers: { authorization: 'Bearer segredo-cron' },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().erro, 'supabase_nao_configurado');
  });

  test('Supabase com erro → 502', async (t) => {
    silenciar(t);
    configurar();
    fetchSimulado = simularFetch(() => respostaJson(500, { message: 'fora' }));
    const res = await chamarHandler(manterAtivo, { url: '/api/cron/manter-ativo' });
    assert.equal(res.statusCode, 502);
    assert.equal(res.json().erro, 'falha_supabase');
  });

  test('POST → 405', async () => {
    configurar();
    const res = await chamarHandler(manterAtivo, { method: 'POST', url: '/api/cron/manter-ativo' });
    assert.equal(res.statusCode, 405);
  });
});
