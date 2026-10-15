// Testes de lib/supabase.js e lib/admin.js com fetch simulado (sem rede).
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ErroHttp } from '../../lib/http.js';
import { ErroSupabase, montarQuery, selecionarPublico, servico, usuarioDoToken } from '../../lib/supabase.js';
import { exigirAdmin } from '../../lib/admin.js';
import {
  AMBIENTE_VAZIO, aplicarAmbiente, esperarAbort, requisicaoFalsa, respostaFalsa, respostaJson, simularFetch,
} from '../apoio/servidor.js';

const URL_SUPA = 'http://supabase.teste';
const ANON = 'sb_publishable_teste';
const SERVICO = 'sb_secret_teste';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.assinatura';
const ID_ADMIN = '11111111-2222-3333-4444-555555555555';

let restaurarAmbiente;
let fetchSimulado;

beforeEach(() => {
  restaurarAmbiente = aplicarAmbiente({
    ...AMBIENTE_VAZIO,
    SUPABASE_URL: `${URL_SUPA}/`,
    SUPABASE_ANON_KEY: ANON,
    SUPABASE_SERVICE_ROLE_KEY: SERVICO,
  });
});

afterEach(() => {
  if (fetchSimulado) fetchSimulado.restaurar();
  fetchSimulado = null;
  restaurarAmbiente();
});

describe('lib/supabase.js', () => {
  test('montarQuery aceita string e objeto', () => {
    assert.equal(montarQuery('?select=*&id=eq.x'), 'select=*&id=eq.x');
    assert.equal(montarQuery({ select: 'chave,valor', chave: 'eq.loja', vazio: undefined }), 'select=chave%2Cvalor&chave=eq.loja');
    assert.equal(montarQuery({ preco: ['gte.1', 'lte.5'] }), 'preco=gte.1&preco=lte.5');
    assert.equal(montarQuery(undefined), '');
  });

  test('servico().select: URL, cabeçalhos da chave de serviço e resultado', async () => {
    fetchSimulado = simularFetch(() => respostaJson(200, [{ chave: 'loja' }]));
    const linhas = await servico().select('configuracoes', 'select=chave&limit=1');
    assert.deepEqual(linhas, [{ chave: 'loja' }]);
    const [c] = fetchSimulado.chamadas;
    assert.equal(c.url, `${URL_SUPA}/rest/v1/configuracoes?select=chave&limit=1`);
    assert.equal(c.metodo, 'GET');
    assert.equal(c.cabecalhos.apikey, SERVICO);
    assert.equal(c.cabecalhos.authorization, `Bearer ${SERVICO}`);
  });

  test('servico().select com query em objeto', async () => {
    fetchSimulado = simularFetch(() => respostaJson(200, []));
    await servico().select('produtos', { select: 'id,nome', ativo: 'eq.true', order: 'ordem.asc' });
    assert.equal(fetchSimulado.chamadas[0].url,
      `${URL_SUPA}/rest/v1/produtos?select=id%2Cnome&ativo=eq.true&order=ordem.asc`);
  });

  test('servico().rpc: POST com JSON', async () => {
    fetchSimulado = simularFetch(() => respostaJson(200, { id: 'p1', numero: 1001 }));
    const r = await servico().rpc('criar_pedido', { p: { itens: [] } });
    assert.deepEqual(r, { id: 'p1', numero: 1001 });
    const [c] = fetchSimulado.chamadas;
    assert.equal(c.url, `${URL_SUPA}/rest/v1/rpc/criar_pedido`);
    assert.equal(c.metodo, 'POST');
    assert.equal(c.cabecalhos['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(c.corpo), { p: { itens: [] } });
    assert.equal(c.cabecalhos.apikey, SERVICO);
  });

  test('erro do PostgREST vira ErroSupabase com codigo = message', async () => {
    fetchSimulado = simularFetch(() => respostaJson(400, {
      code: 'P0001', message: 'item_indisponivel', details: '[{"produto_id":"x"}]', hint: null,
    }));
    await assert.rejects(servico().rpc('criar_pedido', { p: {} }), (e) => {
      assert.ok(e instanceof ErroSupabase);
      assert.equal(e.status, 400);
      assert.equal(e.codigo, 'item_indisponivel');
      assert.equal(e.detalhes, '[{"produto_id":"x"}]');
      assert.equal(e.codigoPostgres, 'P0001');
      return true;
    });
  });

  test('erro sem JSON também vira ErroSupabase', async () => {
    fetchSimulado = simularFetch(() => new Response('Bad gateway', { status: 502 }));
    await assert.rejects(servico().select('produtos', 'select=id'), (e) => e instanceof ErroSupabase && e.status === 502
      && e.codigo === 'http_502');
  });

  test('insert: Prefer return=representation / minimal / upsert', async () => {
    fetchSimulado = simularFetch((url, init) => (init.headers.Prefer.includes('minimal')
      ? new Response(null, { status: 201 })
      : respostaJson(201, [{ id: 1 }])));
    const svc = servico();
    assert.deepEqual(await svc.insert('pedido_eventos', { tipo: 'nota' }), [{ id: 1 }]);
    assert.equal(await svc.insert('pedido_eventos', { tipo: 'nota' }, { retornar: false }), null);
    await svc.insert('conteudo_site', [{ chave: 'a', valor: 1 }], { upsert: true, onConflict: 'chave' });
    const [c1, c2, c3] = fetchSimulado.chamadas;
    assert.equal(c1.metodo, 'POST');
    assert.equal(c1.cabecalhos.prefer, 'return=representation');
    assert.equal(c2.cabecalhos.prefer, 'return=minimal');
    assert.equal(c3.cabecalhos.prefer, 'return=representation,resolution=merge-duplicates');
    assert.equal(c3.url, `${URL_SUPA}/rest/v1/conteudo_site?on_conflict=chave`);
  });

  test('update e remove exigem filtro', async () => {
    fetchSimulado = simularFetch(() => respostaJson(200, [{ id: 'x' }]));
    const svc = servico();
    assert.deepEqual(await svc.update('pedidos', { id: 'eq.x' }, { notas_internas: 'oi' }), [{ id: 'x' }]);
    assert.deepEqual(await svc.remove('pedidos', 'id=eq.x'), [{ id: 'x' }]);
    const [c1, c2] = fetchSimulado.chamadas;
    assert.equal(c1.metodo, 'PATCH');
    assert.equal(c1.url, `${URL_SUPA}/rest/v1/pedidos?id=eq.x`);
    assert.deepEqual(JSON.parse(c1.corpo), { notas_internas: 'oi' });
    assert.equal(c2.metodo, 'DELETE');
    await assert.rejects(svc.update('pedidos', 'select=*', {}), TypeError);
    await assert.rejects(svc.remove('pedidos', ''), TypeError);
    assert.equal(fetchSimulado.chamadas.length, 2);
  });

  test('nome de tabela/função inválido é recusado antes da rede', async () => {
    fetchSimulado = simularFetch(() => respostaJson(200, []));
    await assert.rejects(servico().select('produtos?x=1', ''), TypeError);
    await assert.rejects(servico().rpc('../auth', {}), TypeError);
    assert.equal(fetchSimulado.chamadas.length, 0);
  });

  test('timeout configurável → ErroSupabase tempo_esgotado (504)', async () => {
    fetchSimulado = simularFetch((url, init) => esperarAbort(init));
    const inicio = Date.now();
    await assert.rejects(servico({ timeoutMs: 50 }).select('produtos', 'select=id'),
      (e) => e instanceof ErroSupabase && e.codigo === 'tempo_esgotado' && e.status === 504);
    assert.ok(Date.now() - inicio < 2000);
  });

  test('falha de rede → ErroSupabase falha_conexao (502)', async () => {
    fetchSimulado = simularFetch(() => { throw new TypeError('fetch failed'); });
    await assert.rejects(selecionarPublico('conteudo_site', 'select=chave'),
      (e) => e instanceof ErroSupabase && e.codigo === 'falha_conexao' && e.status === 502);
  });

  test('selecionarPublico: chave anônima em apikey e Authorization, timeout padrão 2,5 s', async () => {
    fetchSimulado = simularFetch(() => respostaJson(200, [{ chave: 'a', valor: 1 }]));
    const linhas = await selecionarPublico('conteudo_site', 'select=chave,valor');
    assert.deepEqual(linhas, [{ chave: 'a', valor: 1 }]);
    const [c] = fetchSimulado.chamadas;
    assert.equal(c.url, `${URL_SUPA}/rest/v1/conteudo_site?select=chave,valor`);
    assert.equal(c.cabecalhos.apikey, ANON);
    assert.equal(c.cabecalhos.authorization, `Bearer ${ANON}`);
    assert.ok(c.init.signal instanceof AbortSignal);
  });

  test('selecionarPublico respeita timeoutMs', async () => {
    fetchSimulado = simularFetch((url, init) => esperarAbort(init));
    await assert.rejects(selecionarPublico('conteudo_site', '', { timeoutMs: 30 }), { codigo: 'tempo_esgotado' });
  });

  test('sem configuração → ErroHttp 503 supabase_nao_configurado (sem chamar a rede)', async () => {
    fetchSimulado = simularFetch(() => respostaJson(200, []));
    aplicarAmbiente({ SUPABASE_SERVICE_ROLE_KEY: undefined });
    assert.throws(() => servico(), (e) => e instanceof ErroHttp && e.status === 503 && e.erro === 'supabase_nao_configurado');
    aplicarAmbiente({ SUPABASE_ANON_KEY: undefined });
    await assert.rejects(selecionarPublico('conteudo_site', ''), { status: 503, erro: 'supabase_nao_configurado' });
    await assert.rejects(usuarioDoToken(JWT), { status: 503 });
    assert.equal(fetchSimulado.chamadas.length, 0);
  });

  test('chave secreta no lugar da pública: selecionarPublico e usuarioDoToken não a usam', async (t) => {
    t.mock.method(console, 'error', () => {});
    fetchSimulado = simularFetch(() => respostaJson(200, []));
    aplicarAmbiente({ SUPABASE_ANON_KEY: 'sb_secret_publico_teste' });
    await assert.rejects(selecionarPublico('conteudo_site', ''), { status: 503, erro: 'supabase_nao_configurado' });
    await assert.rejects(usuarioDoToken(JWT), { status: 503 });
    assert.equal(fetchSimulado.chamadas.length, 0);
  });

  describe('usuarioDoToken', () => {
    test('token válido → { id, email } (apikey anônima + Bearer do usuário)', async () => {
      fetchSimulado = simularFetch(() => respostaJson(200, { id: ID_ADMIN, email: 'admin@ama.local', role: 'authenticated' }));
      assert.deepEqual(await usuarioDoToken(JWT), { id: ID_ADMIN, email: 'admin@ama.local' });
      const [c] = fetchSimulado.chamadas;
      assert.equal(c.url, `${URL_SUPA}/auth/v1/user`);
      assert.equal(c.cabecalhos.apikey, ANON);
      assert.equal(c.cabecalhos.authorization, `Bearer ${JWT}`);
    });

    test('token recusado (401/403) → null', async () => {
      fetchSimulado = simularFetch(() => respostaJson(403, { code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' }));
      assert.equal(await usuarioDoToken(JWT), null);
    });

    test('token ausente ou malformado → null sem chamar a rede', async () => {
      fetchSimulado = simularFetch(() => respostaJson(200, { id: ID_ADMIN }));
      for (const t of [undefined, '', 'abc', 'a.b', 'a b.c.d', `x.${'y'.repeat(9000)}.z`]) {
        assert.equal(await usuarioDoToken(t), null, String(t).slice(0, 20));
      }
      assert.equal(fetchSimulado.chamadas.length, 0);
    });

    test('Auth fora do ar (5xx) → lança ErroSupabase', async () => {
      fetchSimulado = simularFetch(() => respostaJson(500, { msg: 'erro' }));
      await assert.rejects(usuarioDoToken(JWT), ErroSupabase);
    });
  });
});

describe('lib/admin.js — exigirAdmin', () => {
  // Rotas falsas do Supabase: /auth/v1/user e /rest/v1/admins.
  function supabaseFalso({ usuario = { id: ID_ADMIN, email: 'admin@ama.local' }, admin = true, statusAuth = 200 } = {}) {
    return simularFetch((url) => {
      if (url.endsWith('/auth/v1/user')) {
        return statusAuth === 200 ? respostaJson(200, usuario) : respostaJson(statusAuth, { msg: 'invalid JWT' });
      }
      if (url.includes('/rest/v1/admins')) return respostaJson(200, admin ? [{ user_id: usuario.id }] : []);
      return respostaJson(404, { message: 'nao_encontrado' });
    });
  }

  test('sem token → 401 nao_autenticado', async () => {
    fetchSimulado = supabaseFalso();
    const res = respostaFalsa();
    assert.equal(await exigirAdmin(requisicaoFalsa(), res), null);
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().erro, 'nao_autenticado');
    assert.equal(fetchSimulado.chamadas.length, 0);
  });

  test('Authorization que não é Bearer → 401', async () => {
    fetchSimulado = supabaseFalso();
    const res = respostaFalsa();
    assert.equal(await exigirAdmin(requisicaoFalsa({ headers: { authorization: `Basic ${JWT}` } }), res), null);
    assert.equal(res.statusCode, 401);
  });

  test('token inválido → 401', async () => {
    fetchSimulado = supabaseFalso({ statusAuth: 403 });
    const res = respostaFalsa();
    assert.equal(await exigirAdmin(requisicaoFalsa({ headers: { authorization: `Bearer ${JWT}` } }), res), null);
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().erro, 'nao_autenticado');
  });

  test('usuário que não está em admins → 403 sem_permissao', async () => {
    fetchSimulado = supabaseFalso({ admin: false });
    const res = respostaFalsa();
    assert.equal(await exigirAdmin(requisicaoFalsa({ headers: { authorization: `Bearer ${JWT}` } }), res), null);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().erro, 'sem_permissao');
  });

  test('admin → { id, email }, consulta admins com a chave de serviço', async () => {
    fetchSimulado = supabaseFalso();
    const res = respostaFalsa();
    const admin = await exigirAdmin(requisicaoFalsa({ headers: { Authorization: `Bearer ${JWT}` } }), res);
    assert.deepEqual(admin, { id: ID_ADMIN, email: 'admin@ama.local' });
    assert.equal(res.writableEnded, false, 'não respondeu nada');
    const consulta = fetchSimulado.chamadas.find((c) => c.url.includes('/rest/v1/admins'));
    assert.ok(consulta);
    assert.equal(consulta.cabecalhos.apikey, SERVICO);
    assert.equal(consulta.cabecalhos.authorization, `Bearer ${SERVICO}`);
    assert.match(consulta.url, new RegExp(`user_id=eq\\.${ID_ADMIN}`));
  });

  test('Supabase sem configuração → 503', async () => {
    aplicarAmbiente({ SUPABASE_URL: undefined });
    fetchSimulado = supabaseFalso();
    const res = respostaFalsa();
    assert.equal(await exigirAdmin(requisicaoFalsa({ headers: { authorization: `Bearer ${JWT}` } }), res), null);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().erro, 'supabase_nao_configurado');
  });

  test('Auth fora do ar → 502 (não desloga o admin com 401)', async (t) => {
    t.mock.method(console, 'error', () => {});
    fetchSimulado = simularFetch(() => { throw new TypeError('fetch failed'); });
    const res = respostaFalsa();
    assert.equal(await exigirAdmin(requisicaoFalsa({ headers: { authorization: `Bearer ${JWT}` } }), res), null);
    assert.equal(res.statusCode, 502);
  });
});
