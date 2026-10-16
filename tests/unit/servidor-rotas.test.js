// Testes de api/render.js, api/config.js e api/cron/manter-ativo.js com fetch simulado (sem rede).
// O render lê templates/home.html de process.cwd(): aqui o cwd aponta para uma pasta temporária
// com um template de teste; a home publicada fica num armazenamento em memória.
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import render from '../../api/render.js';
import config from '../../api/config.js';
import manterAtivo from '../../api/cron/manter-ativo.js';
import { CHAVE_HOME, definirArmazenamento } from '../../lib/armazenamento.js';
import { armazenamentoMemoria } from '../apoio/armazenamento.js';
import {
  AMBIENTE_VAZIO, aplicarAmbiente, chamarHandler, respostaJson, simularFetch,
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
  let armazenamento;
  const PUBLICADA = TEMPLATE.replace('Texto padrão', 'Texto publicado')
    .replace('</head>', '<meta property="og:image" content="/midia/site/2026-10/capa-a1b2c3.jpg">\n</head>');

  before(() => {
    pasta = mkdtempSync(path.join(tmpdir(), 'ama-render-'));
    mkdirSync(path.join(pasta, 'templates'));
    writeFileSync(path.join(pasta, 'templates', 'home.html'), TEMPLATE);
    process.chdir(pasta);
  });
  after(() => {
    process.chdir(cwdOriginal);
    rmSync(pasta, { recursive: true, force: true });
    definirArmazenamento(null);
  });
  beforeEach(() => {
    armazenamento = armazenamentoMemoria();
    definirArmazenamento(armazenamento);
  });
  const configurar = () => aplicarAmbiente({ SUPABASE_URL: URL_SUPA, SUPABASE_ANON_KEY: ANON });

  test('sem home publicada: template puro, X-AMA-CMS padrao e sem cache compartilhado', async () => {
    const res = await chamarHandler(render, { url: '/' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.cabecalhos['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.cabecalhos['x-ama-cms'], 'padrao');
    assert.equal(res.cabecalhos['cache-control'], 'public, max-age=0, must-revalidate');
    assert.equal(res.corpo, TEMPLATE);
  });

  test('sem armazenamento configurado: template puro', async () => {
    definirArmazenamento(null);
    const res = await chamarHandler(render, { url: '/' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.cabecalhos['x-ama-cms'], 'padrao');
    assert.equal(res.corpo, TEMPLATE);
  });

  test('com home publicada: entrega a publicada (X-AMA-CMS publicado), sem consultar o banco', async () => {
    fetchSimulado = simularFetch(() => respostaJson(200, []));
    configurar();
    await armazenamento.gravar(CHAVE_HOME, PUBLICADA);
    const res = await chamarHandler(render, { url: '/' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.cabecalhos['x-ama-cms'], 'publicado');
    assert.equal(res.corpo, PUBLICADA);
    assert.equal(fetchSimulado.chamadas.length, 0);
  });

  test('og:image da home publicada sai com endereço completo quando há SITE_URL', async () => {
    aplicarAmbiente({ SITE_URL: 'https://ama.exemplo.org' });
    await armazenamento.gravar(CHAVE_HOME, PUBLICADA);
    const res = await chamarHandler(render, { url: '/' });
    assert.match(res.corpo, /<meta property="og:image" content="https:\/\/ama\.exemplo\.org\/midia\/site\/2026-10\/capa-a1b2c3\.jpg">/);
  });

  test('armazenamento falhando: template puro com X-AMA-CMS padrao', async (t) => {
    silenciar(t);
    definirArmazenamento({ lerTexto: async () => { throw new Error('R2 fora do ar'); } });
    const res = await chamarHandler(render, { url: '/' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.cabecalhos['x-ama-cms'], 'padrao');
    assert.equal(res.corpo, TEMPLATE);
  });

  test('?modelo=1: template cru e no-store, mesmo com home publicada', async () => {
    await armazenamento.gravar(CHAVE_HOME, PUBLICADA);
    const res = await chamarHandler(render, { url: '/api/render?modelo=1' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.cabecalhos['cache-control'], 'no-store');
    assert.equal(res.cabecalhos['content-type'], 'text/html; charset=utf-8');
    assert.equal(res.corpo, TEMPLATE);

    const comQuery = await chamarHandler(render, { url: '/', query: { modelo: '1' } });
    assert.equal(comQuery.corpo, TEMPLATE);
  });

  test('HEAD: cabeçalhos sem corpo', async () => {
    const res = await chamarHandler(render, { method: 'HEAD', url: '/' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.corpo, '');
    assert.equal(res.cabecalhos['x-ama-cms'], 'padrao');
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
