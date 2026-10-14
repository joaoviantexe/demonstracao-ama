// Testes das bibliotecas base do servidor: lib/ambiente.js, lib/http.js, lib/dinheiro.js e
// lib/validacao.js (docs/ARQUITETURA.md §3, §6, §6.0 e §6.3). Sem rede.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { obterAmbiente } from '../../lib/ambiente.js';
import {
  ErroHttp, exigirMetodo, lerCorpo, lerQuery, responderErro, responderJson, tratarErro, urlBase,
} from '../../lib/http.js';
import { centavosParaReais, formatarReais, garantirCentavos, reaisParaCentavos } from '../../lib/dinheiro.js';
import {
  UFS, normalizarTexto, somenteDigitos, validarCep, validarCpf, validarDadosCheckout, validarEmail,
  validarNomeCompleto, validarTelefone, validarUf, validarUuid,
} from '../../lib/validacao.js';
import { AMBIENTE_VAZIO, aplicarAmbiente, requisicaoFalsa, respostaFalsa } from '../apoio/servidor.js';

let restaurar;
beforeEach(() => { restaurar = aplicarAmbiente(AMBIENTE_VAZIO); });
afterEach(() => { restaurar(); });

// ---------------------------------------------------------------------------
describe('lib/ambiente.js', () => {
  test('sem nada configurado: strings vazias, padrões e flags falsas', () => {
    const a = obterAmbiente();
    assert.equal(a.supabaseUrl, '');
    assert.equal(a.supabaseAnonKey, '');
    assert.equal(a.supabaseServiceKey, '');
    assert.equal(a.siteUrl, '');
    assert.equal(a.melhorEnvioAmbiente, 'producao');
    assert.equal(a.mpApiBase, 'https://api.mercadopago.com');
    assert.equal(a.melhorEnvioApiBase, 'https://melhorenvio.com.br');
    assert.equal(a.resendApiBase, 'https://api.resend.com');
    assert.equal(a.supabaseConfigurado, false);
    assert.equal(a.supabasePublicoConfigurado, false);
    assert.equal(a.supabaseServicoConfigurado, false);
    assert.equal(a.mercadoPagoConfigurado, false);
    assert.equal(a.melhorEnvioConfigurado, false);
    assert.equal(a.emailConfigurado, false);
  });

  test('nomes principais e flags', () => {
    aplicarAmbiente({
      SUPABASE_URL: 'https://proj.supabase.co/',
      SUPABASE_ANON_KEY: 'anon',
      SUPABASE_SERVICE_ROLE_KEY: 'servico',
      MP_ACCESS_TOKEN: 'mp',
      MP_WEBHOOK_SECRET: 'segredo',
      MELHOR_ENVIO_TOKEN: 'me',
      MELHOR_ENVIO_EMAIL: 'tec@ama.org',
      RESEND_API_KEY: 're',
      CRON_SECRET: 'cron',
      EMAIL_REMETENTE: 'AMA <loja@ama.org>',
    });
    const a = obterAmbiente();
    assert.equal(a.supabaseUrl, 'https://proj.supabase.co');
    assert.equal(a.SUPABASE_URL, 'https://proj.supabase.co');
    assert.equal(a.supabaseAnonKey, 'anon');
    assert.equal(a.supabaseServiceKey, 'servico');
    assert.equal(a.SUPABASE_SERVICE_ROLE_KEY, 'servico');
    assert.equal(a.mpAccessToken, 'mp');
    assert.equal(a.mpWebhookSecret, 'segredo');
    assert.equal(a.melhorEnvioToken, 'me');
    assert.equal(a.melhorEnvioEmail, 'tec@ama.org');
    assert.equal(a.resendApiKey, 're');
    assert.equal(a.cronSecret, 'cron');
    assert.equal(a.CRON_SECRET, 'cron');
    assert.equal(a.emailRemetente, 'AMA <loja@ama.org>');
    assert.equal(a.supabaseConfigurado, true);
    assert.equal(a.mercadoPagoConfigurado, true);
    assert.equal(a.melhorEnvioConfigurado, true);
    assert.equal(a.emailConfigurado, true);
  });

  test('aliases do Supabase (integração Vercel, chaves novas)', () => {
    aplicarAmbiente({
      NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co',
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
      SUPABASE_SECRET_KEY: 'sb_secret_x',
    });
    let a = obterAmbiente();
    assert.equal(a.supabaseUrl, 'https://x.supabase.co');
    assert.equal(a.supabaseAnonKey, 'sb_publishable_x');
    assert.equal(a.supabaseServiceKey, 'sb_secret_x');
    assert.equal(a.supabaseConfigurado, true);

    aplicarAmbiente({ SUPABASE_PUBLISHABLE_KEY: 'pub', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-next' });
    a = obterAmbiente();
    assert.equal(a.supabaseAnonKey, 'pub', 'SUPABASE_PUBLISHABLE_KEY vem antes dos NEXT_PUBLIC_*');

    aplicarAmbiente({ SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'servico', SUPABASE_URL: 'https://y.co' });
    a = obterAmbiente();
    assert.equal(a.supabaseAnonKey, 'anon', 'o nome principal tem prioridade');
    assert.equal(a.supabaseServiceKey, 'servico');
    assert.equal(a.supabaseUrl, 'https://y.co');
  });

  test('só chave pública: público configurado, serviço não', () => {
    aplicarAmbiente({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon' });
    const a = obterAmbiente();
    assert.equal(a.supabasePublicoConfigurado, true);
    assert.equal(a.supabaseServicoConfigurado, false);
    assert.equal(a.supabaseConfigurado, false);
  });

  test('valores só com espaços contam como ausentes', () => {
    aplicarAmbiente({ SUPABASE_ANON_KEY: '   ', SUPABASE_PUBLISHABLE_KEY: 'pub', MP_ACCESS_TOKEN: ' ' });
    const a = obterAmbiente();
    assert.equal(a.supabaseAnonKey, 'pub');
    assert.equal(a.mercadoPagoConfigurado, false);
  });

  test('SITE_URL e VERCEL_PROJECT_PRODUCTION_URL (com https:// e sem barra final)', () => {
    aplicarAmbiente({ VERCEL_PROJECT_PRODUCTION_URL: 'ama.vercel.app' });
    assert.equal(obterAmbiente().siteUrl, 'https://ama.vercel.app');
    aplicarAmbiente({ VERCEL_PROJECT_PRODUCTION_URL: 'https://ama.vercel.app/' });
    assert.equal(obterAmbiente().siteUrl, 'https://ama.vercel.app');
    aplicarAmbiente({ SITE_URL: 'https://www.ama.org.br///' });
    assert.equal(obterAmbiente().siteUrl, 'https://www.ama.org.br', 'SITE_URL tem prioridade');
    assert.equal(obterAmbiente().SITE_URL, 'https://www.ama.org.br');
  });

  test('lê process.env a cada chamada', () => {
    assert.equal(obterAmbiente().mercadoPagoConfigurado, false);
    process.env.MP_ACCESS_TOKEN = 'TEST-1';
    assert.equal(obterAmbiente().mercadoPagoConfigurado, true);
    delete process.env.MP_ACCESS_TOKEN;
    assert.equal(obterAmbiente().mercadoPagoConfigurado, false);
  });

  test('Melhor Envio: sandbox e overrides de API base', () => {
    aplicarAmbiente({ MELHOR_ENVIO_AMBIENTE: 'Sandbox' });
    assert.equal(obterAmbiente().melhorEnvioAmbiente, 'sandbox');
    assert.equal(obterAmbiente().melhorEnvioApiBase, 'https://sandbox.melhorenvio.com.br');
    aplicarAmbiente({ MELHOR_ENVIO_AMBIENTE: 'qualquer' });
    assert.equal(obterAmbiente().melhorEnvioAmbiente, 'producao');
    aplicarAmbiente({
      MELHOR_ENVIO_API_BASE: 'http://127.0.0.1:4001/',
      MP_API_BASE: 'http://127.0.0.1:4000',
      RESEND_API_BASE: 'http://127.0.0.1:4002/',
    });
    const a = obterAmbiente();
    assert.equal(a.melhorEnvioApiBase, 'http://127.0.0.1:4001');
    assert.equal(a.mpApiBase, 'http://127.0.0.1:4000');
    assert.equal(a.resendApiBase, 'http://127.0.0.1:4002');
  });
});

// ---------------------------------------------------------------------------
describe('lib/http.js', () => {
  describe('lerCorpo', () => {
    test('estilo Vercel: objeto pronto', async () => {
      const req = requisicaoFalsa({ method: 'POST', body: { a: 1 }, headers: { 'content-type': 'application/json' } });
      assert.deepEqual(await lerCorpo(req), { a: 1 });
    });

    test('estilo Vercel: getter que lança (JSON inválido) vira ErroHttp 400', async () => {
      const req = requisicaoFalsa({ method: 'POST', corpoLanca: true, headers: { 'content-type': 'application/json' } });
      await assert.rejects(lerCorpo(req), (e) => e instanceof ErroHttp && e.status === 400 && e.erro === 'json_invalido');
    });

    test('estilo Vercel: string (text/plain ou sem Content-Type) e Buffer', async () => {
      assert.deepEqual(await lerCorpo(requisicaoFalsa({ method: 'POST', body: '{"x":"y"}' })), { x: 'y' });
      assert.deepEqual(await lerCorpo(requisicaoFalsa({ method: 'POST', body: '' })), {});
      assert.deepEqual(await lerCorpo(requisicaoFalsa({ method: 'POST', body: Buffer.from('{"b":2}') })), { b: 2 });
      await assert.rejects(lerCorpo(requisicaoFalsa({ method: 'POST', body: '{x' })), { status: 400 });
    });

    test('estilo Vercel: array, null ou multipart', async () => {
      await assert.rejects(lerCorpo(requisicaoFalsa({ method: 'POST', body: [1, 2] })), { status: 400 });
      assert.deepEqual(await lerCorpo(requisicaoFalsa({ method: 'POST', body: null })), {});
      const multipart = requisicaoFalsa({ method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' } });
      multipart.body = undefined;
      await assert.rejects(lerCorpo(multipart), { status: 400 });
    });

    test('estilo Vercel: limite pelo Content-Length e pelo tamanho da string', async () => {
      const grande = requisicaoFalsa({ method: 'POST', body: { a: 1 }, headers: { 'content-length': '200000' } });
      await assert.rejects(lerCorpo(grande), (e) => e.status === 413 && e.erro === 'corpo_muito_grande');
      const texto = JSON.stringify({ a: 'x'.repeat(150) });
      await assert.rejects(lerCorpo(requisicaoFalsa({ method: 'POST', body: texto }), { limiteBytes: 100 }), { status: 413 });
      // Objeto já interpretado e sem Content-Length (envio "chunked"): mede pelo JSON.
      await assert.rejects(lerCorpo(requisicaoFalsa({ method: 'POST', body: { a: 'x'.repeat(100_001) } })), { status: 413 });
      assert.deepEqual(await lerCorpo(requisicaoFalsa({ method: 'POST', body: { a: 'x' } }), { limiteBytes: 20 }), { a: 'x' });
    });

    test('stream: JSON válido, vazio e com BOM', async () => {
      const req = requisicaoFalsa({ estilo: 'stream', method: 'POST', corpoBruto: '{"nome":"Ana","n":[1,2]}' });
      assert.equal('body' in req, false);
      assert.deepEqual(await lerCorpo(req), { nome: 'Ana', n: [1, 2] });
      assert.deepEqual(await lerCorpo(requisicaoFalsa({ estilo: 'stream', method: 'POST' })), {});
      assert.deepEqual(await lerCorpo(requisicaoFalsa({ estilo: 'stream', method: 'POST', corpoBruto: '  \n ' })), {});
      assert.deepEqual(
        await lerCorpo(requisicaoFalsa({ estilo: 'stream', method: 'POST', corpoBruto: '\ufeff{"a":1}' })), { a: 1 });
    });

    test('stream: JSON inválido ou que não é objeto → 400', async () => {
      for (const corpo of ['{x', '[1,2]', '"texto"', '42', 'null']) {
        const req = requisicaoFalsa({ estilo: 'stream', method: 'POST', corpoBruto: corpo });
        await assert.rejects(lerCorpo(req), (e) => e instanceof ErroHttp && e.status === 400, corpo);
      }
    });

    test('stream: acima do limite → 413 (padrão 100 kB)', async () => {
      const corpo = JSON.stringify({ a: 'x'.repeat(100_001) });
      await assert.rejects(lerCorpo(requisicaoFalsa({ estilo: 'stream', method: 'POST', corpoBruto: corpo })), { status: 413 });
      const pequeno = JSON.stringify({ a: 'x'.repeat(50) });
      await assert.rejects(
        lerCorpo(requisicaoFalsa({ estilo: 'stream', method: 'POST', corpoBruto: pequeno }), { limiteBytes: 20 }),
        { status: 413 });
      assert.deepEqual(
        await lerCorpo(requisicaoFalsa({ estilo: 'stream', method: 'POST', corpoBruto: pequeno }), { limiteBytes: 1000 }),
        { a: 'x'.repeat(50) });
    });
  });

  describe('lerQuery', () => {
    test('usa req.query (Vercel); valor repetido → último', () => {
      const req = requisicaoFalsa({ url: '/ignorado?x=0', query: { id: 'abc', tipo: ['a', 'b'], n: 5 } });
      assert.deepEqual(lerQuery(req), { id: 'abc', tipo: 'b', n: '5' });
    });

    test('sem req.query: interpreta req.url', () => {
      const req = requisicaoFalsa({ url: '/api/x?data.id=123&type=payment&a=1&a=2&vazio=&acento=%C3%A1' });
      assert.deepEqual(lerQuery(req), { 'data.id': '123', type: 'payment', a: '2', vazio: '', acento: 'á' });
      assert.deepEqual(lerQuery(requisicaoFalsa({ url: '/sem-query' })), {});
    });

    test('ignora __proto__', () => {
      const q = lerQuery(requisicaoFalsa({ url: '/?__proto__=x&ok=1' }));
      assert.deepEqual(q, { ok: '1' });
      assert.equal(Object.getPrototypeOf(q), Object.prototype);
    });
  });

  describe('respostas', () => {
    test('responderJson: status, Content-Type e cabeçalhos extras', () => {
      const res = respostaFalsa();
      responderJson(res, 201, { ok: true, a: 'ç' }, { 'Cache-Control': 'no-store' });
      assert.equal(res.statusCode, 201);
      assert.equal(res.cabecalhos['content-type'], 'application/json; charset=utf-8');
      assert.equal(res.cabecalhos['cache-control'], 'no-store');
      assert.deepEqual(res.json(), { ok: true, a: 'ç' });
    });

    test('responderErro: { ok:false, erro, mensagem, ...extra }', () => {
      const res = respostaFalsa();
      responderErro(res, 409, 'item_indisponivel', 'Um item acabou.', { itens: [1], ok: true });
      assert.equal(res.statusCode, 409);
      assert.deepEqual(res.json(), { ok: false, erro: 'item_indisponivel', mensagem: 'Um item acabou.', itens: [1] });
    });

    test('exigirMetodo: aceita, aceita HEAD com GET, recusa com 405 e Allow', () => {
      assert.equal(exigirMetodo(requisicaoFalsa({ method: 'POST' }), respostaFalsa(), ['POST']), true);
      assert.equal(exigirMetodo(requisicaoFalsa({ method: 'HEAD' }), respostaFalsa(), ['GET']), true);
      const res = respostaFalsa();
      assert.equal(exigirMetodo(requisicaoFalsa({ method: 'GET' }), res, ['POST']), false);
      assert.equal(res.statusCode, 405);
      assert.equal(res.cabecalhos.allow, 'POST');
      assert.equal(res.json().erro, 'metodo_nao_permitido');
    });

    test('tratarErro: ErroHttp vira resposta com extra', () => {
      const res = respostaFalsa();
      tratarErro(res, new ErroHttp(503, 'pagamento_indisponivel', 'Pagamento fora do ar.', { tentar: true }));
      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.json(), { ok: false, erro: 'pagamento_indisponivel', mensagem: 'Pagamento fora do ar.', tentar: true });
    });

    test('tratarErro: erro comum → 500 genérico e loga', (t) => {
      const log = t.mock.method(console, 'error', () => {});
      const res = respostaFalsa();
      tratarErro(res, new Error('segredo interno'));
      assert.equal(res.statusCode, 500);
      const corpo = res.json();
      assert.equal(corpo.ok, false);
      assert.equal(corpo.erro, 'erro_interno');
      assert.doesNotMatch(res.corpo, /segredo interno/);
      assert.equal(log.mock.callCount(), 1);
    });

    test('ErroHttp sem mensagem usa uma padrão', () => {
      const e = new ErroHttp(400, 'dados_invalidos');
      assert.equal(e.status, 400);
      assert.equal(e.erro, 'dados_invalidos');
      assert.ok(e.mensagem.length > 0);
      assert.deepEqual(e.extra, {});
    });
  });

  describe('urlBase', () => {
    test('SITE_URL tem prioridade', () => {
      aplicarAmbiente({ SITE_URL: 'https://www.ama.org.br/' });
      assert.equal(urlBase(requisicaoFalsa({ headers: { host: 'outro.com' } })), 'https://www.ama.org.br');
    });

    test('VERCEL_PROJECT_PRODUCTION_URL', () => {
      aplicarAmbiente({ VERCEL_PROJECT_PRODUCTION_URL: 'ama.vercel.app' });
      assert.equal(urlBase(requisicaoFalsa({ headers: { host: 'x.com' } })), 'https://ama.vercel.app');
    });

    test('cabeçalhos da requisição (x-forwarded-* e host)', () => {
      assert.equal(urlBase(requisicaoFalsa({
        headers: { 'x-forwarded-proto': 'https, http', 'x-forwarded-host': 'preview.vercel.app', host: 'interno' },
      })), 'https://preview.vercel.app');
      assert.equal(urlBase(requisicaoFalsa({ headers: { host: '127.0.0.1:3000' } })), 'http://127.0.0.1:3000');
      assert.equal(urlBase(requisicaoFalsa({ headers: { host: 'mal"intencionado/x' } })), 'http://localhost');
      assert.equal(urlBase(requisicaoFalsa({ headers: { 'x-forwarded-proto': 'javascript', host: 'a.com' } })), 'http://a.com');
    });
  });
});

// ---------------------------------------------------------------------------
describe('lib/dinheiro.js', () => {
  test('formatarReais', () => {
    assert.equal(formatarReais(123456), 'R$ 1.234,56');
    assert.equal(formatarReais(0), 'R$ 0,00');
    assert.equal(formatarReais(5), 'R$ 0,05');
    assert.equal(formatarReais(4500), 'R$ 45,00');
    assert.equal(formatarReais(123456789), 'R$ 1.234.567,89');
    assert.equal(formatarReais(-500), '-R$ 5,00');
    assert.equal(formatarReais(NaN), '—');
    assert.equal(formatarReais(undefined), '—');
  });

  test('centavosParaReais sem resíduo de ponto flutuante', () => {
    assert.equal(centavosParaReais(2748), 27.48);
    assert.equal(JSON.stringify(centavosParaReais(2748)), '27.48');
    assert.equal(centavosParaReais(1), 0.01);
    assert.equal(centavosParaReais(0), 0);
    assert.equal(centavosParaReais(10), 0.1);
    for (let c = 0; c < 100_000; c += 7) {
      const reais = centavosParaReais(c);
      assert.equal(Math.round(reais * 100), c);
      assert.ok(/^\d+(\.\d{1,2})?$/.test(String(reais)), String(reais));
    }
    assert.throws(() => centavosParaReais(1.5), TypeError);
    assert.throws(() => centavosParaReais('10'), TypeError);
  });

  test('reaisParaCentavos: números', () => {
    assert.equal(reaisParaCentavos(27.48), 2748);
    assert.equal(reaisParaCentavos(0.29), 29);
    assert.equal(reaisParaCentavos(0.1 + 0.2), 30);
    assert.equal(reaisParaCentavos(1.005), 101);
    assert.equal(reaisParaCentavos(10), 1000);
    assert.equal(reaisParaCentavos(0), 0);
    assert.equal(reaisParaCentavos(-5.5), -550);
    assert.equal(reaisParaCentavos(NaN), null);
    assert.equal(reaisParaCentavos(Infinity), null);
  });

  test('reaisParaCentavos: textos', () => {
    const casos = {
      '27.48': 2748,
      '27,48': 2748,
      '27,5': 2750,
      '27': 2700,
      '0,99': 99,
      '1.234,56': 123456,
      '1,234.56': 123456,
      'R$ 1.234,56': 123456,
      'R$\u00a045,00': 4500,
      '1.234.567': 123456700,
      '1.234.567,89': 123456789,
      '-5,00': -500,
      ' 12,30 ': 1230,
    };
    for (const [texto, esperado] of Object.entries(casos)) assert.equal(reaisParaCentavos(texto), esperado, texto);
  });

  test('reaisParaCentavos: null quando não dá para ler com segurança (nunca 0)', () => {
    for (const v of ['', '   ', 'abc', '1.234', '1,234', '27,485', '1.2.3', '12.34.56', '1e3', '5.', '1,2,3,4',
      '1.234,5,6', null, undefined, {}, [], true]) {
      assert.equal(reaisParaCentavos(v), null, JSON.stringify(v));
    }
  });

  test('garantirCentavos', () => {
    assert.equal(garantirCentavos(0), 0);
    assert.equal(garantirCentavos(1500), 1500);
    for (const v of [-1, 1.5, '10', NaN, null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => garantirCentavos(v, 'preco'), TypeError, String(v));
    }
  });
});

// ---------------------------------------------------------------------------
describe('lib/validacao.js', () => {
  test('somenteDigitos', () => {
    assert.equal(somenteDigitos('123.456.789-09'), '12345678909');
    assert.equal(somenteDigitos(null), '');
    assert.equal(somenteDigitos(66000), '66000');
  });

  test('validarCpf', () => {
    for (const cpf of ['529.982.247-25', '52998224725', '111.444.777-35', '123.456.789-09', '000.000.001-91']) {
      assert.equal(validarCpf(cpf), true, cpf);
    }
    for (const cpf of ['529.982.247-26', '123.456.789-00', '111.111.111-11', '00000000000', '1234567890',
      '123456789012', '', null, 'abc']) {
      assert.equal(validarCpf(cpf), false, String(cpf));
    }
  });

  test('validarEmail', () => {
    for (const e of ['ana@ama.org.br', 'a.b+c@sub.dominio.com', ' maria@exemplo.com ']) assert.equal(validarEmail(e), true, e);
    for (const e of ['', 'ana', 'ana@', '@ama.org', 'ana@ama', 'ana @ama.org', 'ana..b@ama.org', '.ana@ama.org',
      'ana@ama..org', `${'a'.repeat(150)}@ama.org.br`, null, 42]) {
      assert.equal(validarEmail(e), false, String(e));
    }
  });

  test('validarTelefone', () => {
    for (const t of ['(91) 98105-6049', '91981056049', '9132345678', '(11) 3234-5678']) assert.equal(validarTelefone(t), true, t);
    for (const t of ['981056049', '+55 91 98105-6049', '(01) 98105-6049', '91 88105-60491', '']) {
      assert.equal(validarTelefone(t), false, t);
    }
    assert.equal(validarTelefone('91881056049'), false, 'celular precisa do 9 depois do DDD');
  });

  test('validarCep, validarUuid, UFS e validarUf', () => {
    assert.equal(validarCep('66000-000'), true);
    assert.equal(validarCep('6600000'), false);
    assert.equal(validarCep('00000-000'), false);
    assert.equal(validarUuid('123e4567-e89b-12d3-a456-426614174000'), true);
    assert.equal(validarUuid('123E4567-E89B-12D3-A456-426614174000'), true);
    assert.equal(validarUuid('123e4567e89b12d3a456426614174000'), false);
    assert.equal(validarUuid("x' or 1=1"), false);
    assert.equal(UFS.length, 27);
    assert.equal(new Set(UFS).size, 27);
    assert.ok(UFS.includes('PA') && UFS.includes('DF') && UFS.includes('TO'));
    assert.equal(validarUf('pa'), true);
    assert.equal(validarUf('XX'), false);
    assert.equal(validarUf(''), false);
    assert.throws(() => { UFS.push('ZZ'); });
  });

  test('validarNomeCompleto', () => {
    assert.equal(validarNomeCompleto('Maria Silva'), true);
    assert.equal(validarNomeCompleto('  Mônica   de Moura '), true);
    assert.equal(validarNomeCompleto('Maria'), false);
    assert.equal(validarNomeCompleto('Maria 123'), false);
    assert.equal(validarNomeCompleto(''), false);
    assert.equal(validarNomeCompleto(`Maria ${'a'.repeat(130)}`), false);
  });

  test('normalizarTexto', () => {
    const ls = String.fromCharCode(0x2028);
    const zw = String.fromCharCode(0x200b);
    assert.equal(normalizarTexto('  Olá \t mundo \n ', 50), 'Olá mundo');
    assert.equal(normalizarTexto(`a${zw}b${ls}c\u0000d`, 50), 'a b c d');
    assert.equal(normalizarTexto('abcdef', 3), 'abc');
    assert.equal(normalizarTexto('😀😀😀', 2), '😀😀');
    assert.equal(normalizarTexto(null), '');
    assert.equal(normalizarTexto({ a: 1 }), '');
    assert.equal(normalizarTexto(123), '123');
    assert.equal(normalizarTexto('linha 1\r\n\r\n\r\n\r\nlinha   2 ', 100, { multilinha: true }), 'linha 1\n\nlinha 2');
  });

  describe('validarDadosCheckout', () => {
    const ID = '123e4567-e89b-12d3-a456-426614174000';
    const valido = () => ({
      itens: [{ produto_id: ID.toUpperCase(), quantidade: 2 }],
      cupom: ' ama10 ',
      frete_id: 'me-1',
      cliente: { nome: ' Maria  da Silva ', email: ' Maria@Exemplo.com ', telefone: '(91) 98105-6049', cpf: '529.982.247-25' },
      endereco: {
        cep: '66000-000', logradouro: 'Rua das Flores', numero: '10', complemento: '',
        bairro: 'Centro', cidade: 'Belém', uf: 'pa',
      },
      observacoes: '  Entregar à tarde  ',
    });

    test('dados válidos são normalizados', () => {
      const r = validarDadosCheckout(valido());
      assert.equal(r.ok, true, JSON.stringify(r.erros));
      assert.deepEqual(r.erros, {});
      assert.deepEqual(r.dados, {
        cliente: { nome: 'Maria da Silva', email: 'maria@exemplo.com', telefone: '91981056049', cpf: '52998224725' },
        endereco: {
          cep: '66000000', logradouro: 'Rua das Flores', numero: '10', complemento: '',
          bairro: 'Centro', cidade: 'Belém', uf: 'PA',
        },
        observacoes: 'Entregar à tarde',
        cupom: 'AMA10',
        itens: [{ produto_id: ID, quantidade: 2 }],
        frete_id: 'me-1',
      });
    });

    test('retirada dispensa o endereço (endereco = {})', () => {
      const corpo = valido();
      corpo.frete_id = 'retirada';
      corpo.endereco = { cep: 'xx' };
      const r = validarDadosCheckout(corpo);
      assert.equal(r.ok, true, JSON.stringify(r.erros));
      assert.deepEqual(r.dados.endereco, {});
      delete corpo.endereco;
      assert.equal(validarDadosCheckout(corpo).ok, true);
    });

    test('opcionais ausentes: cupom e observações null', () => {
      const corpo = valido();
      delete corpo.cupom;
      corpo.observacoes = '   ';
      const r = validarDadosCheckout(corpo);
      assert.equal(r.ok, true);
      assert.equal(r.dados.cupom, null);
      assert.equal(r.dados.observacoes, null);
      corpo.observacoes = 'x'.repeat(600);
      assert.equal(validarDadosCheckout(corpo).dados.observacoes.length, 500);
    });

    test('erros por campo', () => {
      const r = validarDadosCheckout({
        itens: [],
        frete_id: '',
        cupom: 'a',
        cliente: { nome: 'Maria', email: 'x@', telefone: '123', cpf: '111.111.111-11' },
        endereco: { cep: '123', logradouro: '', numero: '', bairro: '', cidade: '', uf: 'XX', complemento: 'c'.repeat(101) },
      });
      assert.equal(r.ok, false);
      for (const campo of ['itens', 'frete_id', 'cupom', 'cliente.nome', 'cliente.email', 'cliente.telefone', 'cliente.cpf',
        'endereco.cep', 'endereco.logradouro', 'endereco.numero', 'endereco.bairro', 'endereco.cidade', 'endereco.uf',
        'endereco.complemento']) {
        assert.equal(typeof r.erros[campo], 'string', campo);
      }
    });

    test('itens: 1 a 30 linhas, uuid e quantidade 1–99', () => {
      const corpo = valido();
      const comItens = (itens) => validarDadosCheckout({ ...corpo, itens });
      assert.equal(comItens([{ produto_id: ID, quantidade: '3' }]).ok, true);
      assert.equal(comItens(Array.from({ length: 30 }, () => ({ produto_id: ID, quantidade: 1 }))).ok, true);
      assert.equal(comItens(Array.from({ length: 31 }, () => ({ produto_id: ID, quantidade: 1 }))).ok, false);
      for (const ruim of [[{ produto_id: 'abc', quantidade: 1 }], [{ produto_id: ID, quantidade: 0 }],
        [{ produto_id: ID, quantidade: 100 }], [{ produto_id: ID, quantidade: 1.5 }], [{ produto_id: ID }], [null],
        'nao-array', undefined]) {
        const r = comItens(ruim);
        assert.equal(r.ok, false, JSON.stringify(ruim));
        assert.ok(r.erros.itens);
      }
    });

    test('corpo que não é objeto', () => {
      for (const corpo of [null, undefined, 'x', [1]]) {
        const r = validarDadosCheckout(corpo);
        assert.equal(r.ok, false);
        assert.ok(r.erros.corpo);
        assert.ok(r.dados && r.dados.cliente);
      }
    });

    test('limites do banco (nome 120, logradouro 200, número 20)', () => {
      const corpo = valido();
      corpo.cliente.nome = `Maria ${'a'.repeat(120)}`;
      corpo.endereco.logradouro = 'r'.repeat(201);
      corpo.endereco.numero = '1'.repeat(21);
      const r = validarDadosCheckout(corpo);
      assert.ok(r.erros['cliente.nome']);
      assert.ok(r.erros['endereco.logradouro']);
      assert.ok(r.erros['endereco.numero']);
    });
  });
});
