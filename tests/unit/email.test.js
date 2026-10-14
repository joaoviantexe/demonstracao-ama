// Testes de lib/email.js (docs/ARQUITETURA.md §6.0, §6.5 e §6.6). Sem rede: fetch simulado.
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emailNovoPedidoAdmin, emailPedidoEnviado, emailPedidoPago, emailStatusPedido, enviarEmail, escaparHtml, urlSegura,
} from '../../lib/email.js';
import { formatarReais } from '../../lib/dinheiro.js';
import { AMBIENTE_VAZIO, aplicarAmbiente, esperarAbort, respostaJson, simularFetch } from '../apoio/servidor.js';

const PEDIDO_ID = '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';
const TOKEN = '0123456789abcdef'.repeat(4);
const SITE = 'https://ama.org.br';
const LINK = `${SITE}/loja/pedido?id=${PEDIDO_ID}&token=${TOKEN}`;

function pedidoBase(extra = {}) {
  return {
    id: PEDIDO_ID,
    numero: 1001,
    token_acesso: TOKEN,
    status: 'pago',
    cliente_nome: 'Maria da Silva',
    cliente_email: 'maria@exemplo.com',
    cliente_telefone: '91981056049',
    endereco: { cep: '67130000', logradouro: 'Conjunto Uirapuru, Quadra 28', numero: '2', complemento: 'Casa 02', bairro: 'Icuí', cidade: 'Ananindeua', uf: 'PA' },
    entrega: { tipo: 'melhor_envio', id: 'me-1', nome: 'PAC', empresa: 'Correios', prazo_dias: 7, preco_centavos: 2350, servico_id: 1 },
    itens: [
      { nome: 'Body Splash Raiz', quantidade: 2, preco_unitario_centavos: 4500, total_centavos: 9000 },
      { nome: 'Creme Hidratante Cupuaçu', quantidade: 1, preco_unitario_centavos: 3990, total_centavos: 3990 },
    ],
    subtotal_centavos: 12990,
    desconto_centavos: 1299,
    frete_centavos: 2350,
    total_centavos: 14041,
    cupom_codigo: 'AMA10',
    metodo_pagamento: 'bank_transfer',
    codigo_rastreio: null,
    url_rastreio: null,
    observacoes: 'Entregar à tarde',
    ...extra,
  };
}

const MODELOS = [
  ['emailPedidoPago', emailPedidoPago],
  ['emailPedidoEnviado', emailPedidoEnviado],
  ['emailNovoPedidoAdmin', emailNovoPedidoAdmin],
];

let restaurarAmbiente;
beforeEach(() => { restaurarAmbiente = aplicarAmbiente(AMBIENTE_VAZIO); });
afterEach(() => { restaurarAmbiente(); });

// ---------------------------------------------------------------------------
describe('escaparHtml e urlSegura', () => {
  test('escaparHtml troca os caracteres especiais', () => {
    assert.equal(escaparHtml(`<a href="x" title='y'>&\`</a>`), '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&#96;&lt;/a&gt;');
    assert.equal(escaparHtml(null), '');
    assert.equal(escaparHtml(undefined), '');
    assert.equal(escaparHtml(1001), '1001');
  });

  test('urlSegura só aceita http(s) absoluta', () => {
    assert.equal(urlSegura('https://rastreio.exemplo/abc'), 'https://rastreio.exemplo/abc');
    assert.equal(urlSegura(' http://ama.org.br '), 'http://ama.org.br/');
    for (const url of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>', 'vbscript:x', '/relativa', 'ftp://x.org',
      'https://usuario:senha@x.org', '', null, 123, {}]) {
      assert.equal(urlSegura(url), '', String(url));
    }
  });
});

// ---------------------------------------------------------------------------
describe('modelos de e-mail', () => {
  test('emailPedidoPago: assunto, saudação, itens, totais, entrega e link do pedido', () => {
    const { assunto, html, texto } = emailPedidoPago(pedidoBase(), SITE);
    assert.equal(assunto, 'Pagamento confirmado — pedido #1001');
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<html lang="pt-BR">/);
    assert.match(html, /Olá, Maria!/);
    assert.match(html, /Body Splash Raiz/);
    assert.match(html, /Creme Hidratante Cupuaçu/);
    for (const valor of [4500, 9000, 3990, 12990, 1299, 2350, 14041]) {
      assert.ok(html.includes(escaparHtml(formatarReais(valor))), formatarReais(valor));
    }
    assert.match(html, /cupom AMA10/);
    assert.match(html, /\(Pix\)/);
    assert.match(html, /PAC \(Correios\)/);
    assert.match(html, /até 7 dias úteis/);
    assert.match(html, /Conjunto Uirapuru, Quadra 28, 2 — Casa 02/);
    assert.match(html, /Icuí, Ananindeua\/PA/);
    assert.match(html, /CEP 67130-000/);
    assert.ok(html.includes(`href="${escaparHtml(LINK)}"`), 'link do pedido com & escapado no atributo');
    assert.match(html, /Acompanhar meu pedido/);
    // Visual da AMA.
    for (const cor of ['#0B2A1C', '#C9982B', '#FBF6EA']) assert.ok(html.includes(cor), cor);
    assert.match(html, /Fraunces/);
    assert.match(html, /Manrope/);
    // Versão em texto.
    assert.ok(texto.includes(LINK));
    assert.match(texto, /Pagamento confirmado!/);
    assert.match(texto, /R\$ 140,41/);
    assert.doesNotMatch(texto, /<[a-z]/i);
  });

  test('siteUrl: 2º argumento (texto ou objeto), pedido.site_url ou SITE_URL; sem ela não há link', () => {
    assert.ok(emailPedidoPago(pedidoBase(), { siteUrl: SITE }).texto.includes(LINK));
    assert.ok(emailPedidoPago(pedidoBase({ site_url: SITE })).texto.includes(LINK));
    assert.ok(emailPedidoPago(pedidoBase({ siteUrl: `${SITE}/` })).texto.includes(LINK));
    aplicarAmbiente({ SITE_URL: 'https://loja.ama.org.br' });
    assert.ok(emailPedidoPago(pedidoBase()).texto.includes(`https://loja.ama.org.br/loja/pedido?id=${PEDIDO_ID}&token=${TOKEN}`));
    aplicarAmbiente({ SITE_URL: undefined });
    const semSite = emailPedidoPago(pedidoBase());
    assert.doesNotMatch(semSite.html, /loja\/pedido/);
    assert.doesNotMatch(semSite.html, /Acompanhar meu pedido/);
    const perigoso = emailPedidoPago(pedidoBase(), 'javascript:alert(1)//');
    assert.doesNotMatch(perigoso.html, /javascript:/i);
    assert.doesNotMatch(perigoso.html, /loja\/pedido/);
  });

  test('token alternativo (pedido.token) e caracteres especiais codificados no link', () => {
    const { texto } = emailPedidoPago(pedidoBase({ token_acesso: undefined, token: 'a&b=c' }), SITE);
    assert.ok(texto.includes(`${SITE}/loja/pedido?id=${PEDIDO_ID}&token=a%26b%3Dc`));
  });

  test('retirada: sem endereço de entrega e frete como "Retirada"', () => {
    const pedido = pedidoBase({
      endereco: {},
      entrega: { tipo: 'retirada', id: 'retirada', nome: 'Retirar na sede da AMA', endereco: 'Icuí, Ananindeua - PA', preco_centavos: 0 },
      frete_centavos: 0,
      total_centavos: 11691,
    });
    const { html } = emailPedidoPago(pedido, SITE);
    assert.match(html, /Retirar na sede da AMA/);
    assert.match(html, />Retirada</);
    assert.match(html, /WhatsApp/);
    assert.doesNotMatch(html, /CEP /);
  });

  test('frete zero fora da retirada aparece como "Grátis"; sem desconto não há linha de desconto', () => {
    const { html } = emailPedidoPago(pedidoBase({ frete_centavos: 0, desconto_centavos: 0, cupom_codigo: null, total_centavos: 12990 }), SITE);
    assert.match(html, />Grátis</);
    assert.doesNotMatch(html, /Desconto/);
  });

  test('emailPedidoEnviado: código e link de rastreio', () => {
    const pedido = pedidoBase({
      status: 'enviado', codigo_rastreio: 'AA123456789BR', url_rastreio: 'https://rastreamento.correios.com.br/app/index.php?objeto=AA123456789BR',
    });
    const { assunto, html, texto } = emailPedidoEnviado(pedido, SITE);
    assert.equal(assunto, 'Seu pedido #1001 foi enviado');
    assert.match(html, /Seu pedido está a caminho!/);
    assert.match(html, /Código de rastreio: <strong[^>]*>AA123456789BR<\/strong>/);
    assert.ok(html.includes(`href="${escaparHtml(pedido.url_rastreio)}"`));
    assert.match(html, /Acompanhar a entrega/);
    assert.match(html, /deve chegar em até 7 dias úteis/);
    assert.ok(texto.includes(LINK));

    const varios = emailPedidoEnviado(pedidoBase({ codigo_rastreio: 'AA1BR, BB2BR' }), SITE);
    assert.match(varios.html, /Códigos de rastreio/);
    assert.match(varios.html, /AA1BR/);
    assert.match(varios.html, /BB2BR/);

    const semRastreio = emailPedidoEnviado(pedidoBase(), SITE);
    assert.doesNotMatch(semRastreio.html, /Código de rastreio:/);
    assert.match(semRastreio.html, /código de rastreio aparece na página do seu pedido/);
  });

  test('emailNovoPedidoAdmin: dados do cliente, observações e link do painel', () => {
    const { assunto, html } = emailNovoPedidoAdmin(pedidoBase(), SITE);
    assert.equal(assunto, 'Novo pedido pago #1001 — R$ 140,41');
    assert.match(html, /Maria da Silva/);
    assert.match(html, /href="mailto:maria@exemplo\.com"/);
    assert.match(html, /\(91\) 98105-6049/);
    assert.match(html, /Entregar à tarde/);
    assert.match(html, /Pix/);
    assert.ok(html.includes(`href="${SITE}/admin/#/pedidos/${PEDIDO_ID}"`));
    assert.match(html, /Abrir no painel/);
    assert.match(html, /Body Splash Raiz/);
    assert.doesNotMatch(html, /Dúvidas\?/, 'rodapé da equipe não tem o convite de contato do cliente');
  });

  test('logo só com site https público; senão a marca vai em texto', () => {
    const publico = emailPedidoPago(pedidoBase(), SITE).html;
    assert.ok(publico.includes(`src="${SITE}/img/logo-ama.png"`));
    assert.match(publico, /alt="AMA"/);
    const local = emailPedidoPago(pedidoBase(), 'http://127.0.0.1:3000').html;
    assert.doesNotMatch(local, /<img/);
    assert.match(local, />AMA<\/div>/);
  });

  test('emailStatusPedido escolhe o modelo pelo status', () => {
    assert.equal(emailStatusPedido(pedidoBase({ status: 'pago' }), SITE).assunto, emailPedidoPago(pedidoBase(), SITE).assunto);
    assert.equal(emailStatusPedido(pedidoBase({ status: 'enviado' }), SITE).assunto, 'Seu pedido #1001 foi enviado');
    assert.equal(emailStatusPedido(pedidoBase({ status: 'entregue' }), SITE).assunto, 'Seu pedido #1001 foi entregue');
    assert.equal(emailStatusPedido(pedidoBase({ status: 'cancelado' }), SITE).assunto, 'Seu pedido #1001 foi cancelado');
    assert.equal(emailStatusPedido(pedidoBase({ status: 'reembolsado' }), SITE).assunto, 'O pagamento do pedido #1001 foi devolvido');
    assert.ok(emailStatusPedido(pedidoBase({ status: 'cancelado' }), SITE).texto.includes(LINK));
    assert.equal(emailStatusPedido(pedidoBase({ status: 'aguardando_pagamento' }), SITE), null);
    assert.equal(emailStatusPedido(null), null);
  });

  test('itens em pedido_itens também funcionam e o whatsapp vira link', () => {
    const pedido = pedidoBase({ itens: undefined, pedido_itens: [{ nome: 'Sabonete Sólido', quantidade: 3, preco_unitario_centavos: 2500 }] });
    const { html } = emailPedidoPago(pedido, { siteUrl: SITE, whatsapp: '+55 (91) 98105-6049' });
    assert.match(html, /Sabonete Sólido/);
    assert.ok(html.includes(escaparHtml(formatarReais(7500))));
    assert.match(html, /href="https:\/\/wa\.me\/5591981056049"/);
  });

  for (const [nome, modelo] of MODELOS) {
    test(`${nome}: escapa todo texto vindo do banco (XSS) e só aceita URLs http(s)`, () => {
      const pedido = pedidoBase({
        numero: '<b>1</b>',
        cliente_nome: '<script>alert(1)</script> Silva',
        cliente_email: '"><script>alert(3)</script>@x.com',
        cliente_telefone: '<i>91</i>',
        cupom_codigo: '"><b>CUPOM',
        observacoes: '<a href="javascript:alert(4)">clique</a>\nsegunda linha',
        entrega: { tipo: 'melhor_envio', nome: '<iframe src=//mal.example>', empresa: '<marquee>', prazo_dias: 3 },
        endereco: { cep: '<b>', logradouro: '<svg/onload=alert(5)>', numero: '1', bairro: '"onmouseover="x', cidade: 'Belém', uf: 'pa' },
        itens: [{ nome: '<img src=x onerror=alert(2)>', quantidade: 1, preco_unitario_centavos: 14041, total_centavos: 14041 }],
        codigo_rastreio: '"><script>alert(6)</script>',
        url_rastreio: 'javascript:alert(7)',
      });
      const { assunto, html, texto } = modelo(pedido, SITE);
      assert.doesNotMatch(html, /<script/i);
      assert.doesNotMatch(html, /<img src=x/i);
      assert.doesNotMatch(html, /<iframe/i);
      assert.doesNotMatch(html, /<svg/i);
      assert.doesNotMatch(html, /<marquee/i);
      assert.doesNotMatch(html, /<b>/i);
      assert.doesNotMatch(html, /<i>/i);
      // "javascript:" só pode aparecer como texto escapado, nunca num atributo.
      assert.doesNotMatch(html, /(?:href|src)\s*=\s*["']?\s*javascript:/i);
      assert.doesNotMatch(html, /"onmouseover=/i);
      assert.doesNotMatch(html, /href="mailto:"/);
      assert.ok(html.includes('&lt;img src=x onerror=alert(2)&gt;'));
      assert.doesNotMatch(assunto, /[\r\n]/);
      assert.equal(typeof texto, 'string');
      // Todo href e src do e-mail é http(s), mailto ou âncora do WhatsApp.
      for (const [, url] of html.matchAll(/(?:href|src)="([^"]*)"/g)) {
        assert.match(url, /^(https?:\/\/|mailto:)/, url);
      }
    });
  }

  test('url de rastreio https com caracteres especiais vai escapada no atributo', () => {
    const { html } = emailPedidoEnviado(pedidoBase({ url_rastreio: 'https://rastreio.exemplo/r?a=1&b="2"' }), SITE);
    assert.ok(html.includes('href="https://rastreio.exemplo/r?a=1&amp;b=%222%22"'));
  });

  test('modelos não lançam com dados vazios ou estranhos', () => {
    for (const [, modelo] of MODELOS) {
      for (const entrada of [undefined, null, {}, { itens: 'x', entrega: 'y', endereco: 5 }, { itens: [null, 1, { nome: null }] }]) {
        const { assunto, html } = modelo(entrada, SITE);
        assert.equal(typeof assunto, 'string');
        assert.match(html, /<\/html>$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('enviarEmail', () => {
  let fetchFalso;
  afterEach(() => { if (fetchFalso) fetchFalso.restaurar(); fetchFalso = null; });

  const mensagem = (extra = {}) => ({ para: 'maria@exemplo.com', ...emailPedidoPago(pedidoBase(), SITE), ...extra });

  test('sem RESEND_API_KEY: não faz nada e devolve false', async () => {
    fetchFalso = simularFetch(() => respostaJson(200, { id: 'x' }));
    assert.equal(await enviarEmail(mensagem()), false);
    assert.equal(await enviarEmail(), false);
    assert.equal(await enviarEmail(null), false);
    assert.equal(fetchFalso.chamadas.length, 0);
  });

  test('com chave: POST <RESEND_API_BASE>/emails com Bearer e remetente padrão', async () => {
    aplicarAmbiente({ RESEND_API_KEY: 're_teste_123', RESEND_API_BASE: 'https://resend.teste/' });
    fetchFalso = simularFetch(() => respostaJson(200, { id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }));
    const dados = mensagem();
    assert.equal(await enviarEmail(dados), true);
    assert.equal(fetchFalso.chamadas.length, 1);
    const [chamada] = fetchFalso.chamadas;
    assert.equal(chamada.url, 'https://resend.teste/emails');
    assert.equal(chamada.metodo, 'POST');
    assert.equal(chamada.cabecalhos.authorization, 'Bearer re_teste_123');
    assert.match(chamada.cabecalhos['content-type'], /application\/json/);
    const corpo = JSON.parse(chamada.corpo);
    assert.equal(corpo.from, 'AMA <onboarding@resend.dev>');
    assert.deepEqual(corpo.to, ['maria@exemplo.com']);
    assert.equal(corpo.subject, dados.assunto);
    assert.equal(corpo.html, dados.html);
    assert.equal(corpo.text, dados.texto);
    assert.equal('reply_to' in corpo, false);
    assert.equal('idempotency-key' in chamada.cabecalhos, false);
  });

  test('usa EMAIL_REMETENTE, a base padrão do Resend, vários destinatários, reply_to e Idempotency-Key', async () => {
    aplicarAmbiente({ RESEND_API_KEY: 're_x', EMAIL_REMETENTE: 'AMA <loja@ama.org.br>' });
    fetchFalso = simularFetch(() => respostaJson(200, { id: 'y' }));
    const ok = await enviarEmail({
      para: ['maria@exemplo.com', 'invalido', 'MARIA@exemplo.com', 'ana@exemplo.com'],
      assunto: 'Teste\r\nBcc: x@y.com',
      html: '<p>oi</p>',
      responderPara: 'contato@ama.org.br',
      idempotencia: 'pedido-pago/123',
    });
    assert.equal(ok, true);
    const [chamada] = fetchFalso.chamadas;
    assert.equal(chamada.url, 'https://api.resend.com/emails');
    assert.equal(chamada.cabecalhos['idempotency-key'], 'pedido-pago/123');
    const corpo = JSON.parse(chamada.corpo);
    assert.equal(corpo.from, 'AMA <loja@ama.org.br>');
    assert.deepEqual(corpo.to, ['maria@exemplo.com', 'MARIA@exemplo.com', 'ana@exemplo.com']);
    assert.equal(corpo.subject, 'Teste Bcc: x@y.com');
    assert.deepEqual(corpo.reply_to, ['contato@ama.org.br']);
    assert.equal('text' in corpo, false);

    fetchFalso.chamadas.length = 0;
    assert.equal(await enviarEmail({ para: 'a@ama.org.br, b@ama.org.br', assunto: 'x', html: '<p>x</p>' }), true);
    assert.deepEqual(JSON.parse(fetchFalso.chamadas[0].corpo).to, ['a@ama.org.br', 'b@ama.org.br']);
  });

  test('dados inválidos: false sem chamar a API', async (t) => {
    aplicarAmbiente({ RESEND_API_KEY: 're_x' });
    t.mock.method(console, 'error', () => {});
    fetchFalso = simularFetch(() => respostaJson(200, {}));
    for (const dados of [
      null, {}, { para: '', assunto: 'a', html: '<p>x</p>' }, { para: 'nao-e-email', assunto: 'a', html: '<p>x</p>' },
      { para: 'a@b.com', assunto: '', html: '<p>x</p>' }, { para: 'a@b.com', assunto: 'a', html: '' },
      { para: 'a@b.com', assunto: 'a', html: 42 }, { para: ['a@b'], assunto: 'a', html: '<p>x</p>' },
    ]) {
      assert.equal(await enviarEmail(dados), false, JSON.stringify(dados));
    }
    assert.equal(fetchFalso.chamadas.length, 0);
  });

  test('nunca lança: erro HTTP, falha de rede, tempo esgotado e resposta quebrada → false (e registra)', async (t) => {
    aplicarAmbiente({ RESEND_API_KEY: 're_x' });
    const erros = t.mock.method(console, 'error', () => {});

    fetchFalso = simularFetch(() => respostaJson(422, { name: 'validation_error', message: 'Invalid `from` field.' }));
    assert.equal(await enviarEmail(mensagem()), false);
    assert.match(String(erros.mock.calls.at(-1).arguments[0]), /HTTP 422.*Invalid `from` field/);
    fetchFalso.restaurar();

    fetchFalso = simularFetch(() => { throw new TypeError('fetch failed'); });
    assert.equal(await enviarEmail(mensagem()), false);
    fetchFalso.restaurar();

    fetchFalso = simularFetch((url, init) => esperarAbort(init));
    const inicio = Date.now();
    assert.equal(await enviarEmail(mensagem({ timeoutMs: 30 })), false);
    assert.ok(Date.now() - inicio < 2000);
    assert.match(String(erros.mock.calls.at(-1).arguments[0]), /tempo esgotado/);
    fetchFalso.restaurar();

    fetchFalso = simularFetch(() => respostaJson(500, { message: 'erro' }));
    assert.equal(await enviarEmail(mensagem()), false);
    assert.ok(erros.mock.callCount() >= 4);
    for (const chamada of erros.mock.calls) assert.doesNotMatch(String(chamada.arguments[0]), /re_x/);
  });
});
