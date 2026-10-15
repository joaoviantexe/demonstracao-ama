// Testes do núcleo do painel /admin (docs/PAINEL.md): funções puras de ui.js e midia.js,
// el() e componentes num DOM do linkedom, envio com pasta inválida e o roteador do app.js.

import { describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

import * as ui from '../../public/admin/js/ui.js';
import * as midia from '../../public/admin/js/midia.js';
import { configurarApi } from '../../public/admin/js/api.js';
import { MENU, ROTAS, normalizarHash, resolverRota } from '../../public/admin/js/app.js';
import { STATUS_PEDIDO as STATUS_DA_API } from '../../api/admin/pedido-status.js';

const lerArquivo = (caminho) => readFileSync(new URL(caminho, import.meta.url), 'utf8');

// Um documento só para o arquivo todo (a região de toasts do ui.js fica presa ao primeiro).
const { document, Event: EventoDom } = parseHTML('<!doctype html><html lang="pt-BR"><head></head><body></body></html>');
globalThis.document = document;

const CORES_DO_CSS = new Set(
  Array.from(lerArquivo('../../public/admin/admin.css').matchAll(/\.selo--([a-z-]+)/g), (m) => m[1]),
);

// ---------------------------------------------------------------------------
// Preço

describe('lerPreco', () => {
  const casos = [
    ['12,50', 1250], ['1.234,56', 123456], ['12', 1200], ['R$ 0,99', 99], ['r$12,5', 1250],
    ['12.5', 1250], ['12.50', 1250], ['1.23', 123], ['1.234', 123400], ['1.000.000', 100000000],
    ['1.234.567,89', 123456789], [' R$ 1.234,56 ', 123456], ['1 234,56', 123456], ['0', 0], ['0,5', 50],
    [',99', 99], ['00,00', 0], ['21474836,47', 2147483647],
  ];
  for (const [entrada, esperado] of casos) {
    test(`"${entrada}" → ${esperado}`, () => assert.equal(ui.lerPreco(entrada), esperado));
  }

  const invalidos = ['', '   ', 'R$', '-3', '-0,50', '1,234', '1,2,3', '12,5,0', 'abc', '12a', '1.2345', '1.23.4',
    '12..5', '1e3', '21474836,48', '99999999999999999999', '0x10', '+5'];
  for (const entrada of invalidos) {
    test(`"${entrada}" → null`, () => assert.equal(ui.lerPreco(entrada), null));
  }

  test('null, undefined e objetos → null', () => {
    assert.equal(ui.lerPreco(null), null);
    assert.equal(ui.lerPreco(undefined), null);
    assert.equal(ui.lerPreco({}), null);
  });

  test('número em reais é aceito; negativo, NaN e infinito não', () => {
    assert.equal(ui.lerPreco(12.5), 1250);
    assert.equal(ui.lerPreco(0.1 + 0.2), 30);
    assert.equal(ui.lerPreco(0), 0);
    assert.equal(ui.lerPreco(-1), null);
    assert.equal(ui.lerPreco(Number.NaN), null);
    assert.equal(ui.lerPreco(Number.POSITIVE_INFINITY), null);
    assert.equal(ui.lerPreco(3e7), null);
  });

  test('o resultado é sempre inteiro (centavos)', () => {
    for (const texto of ['0,01', '9,99', '19.9', '1.5', '7']) assert.ok(Number.isInteger(ui.lerPreco(texto)), texto);
  });
});

describe('formatarPreco', () => {
  test('centavos → reais com milhar e vírgula', () => {
    assert.equal(ui.formatarPreco(123456), 'R$ 1.234,56');
    assert.equal(ui.formatarPreco(4590), 'R$ 45,90');
    assert.equal(ui.formatarPreco(5), 'R$ 0,05');
    assert.equal(ui.formatarPreco(0), 'R$ 0,00');
    assert.equal(ui.formatarPreco(100000000), 'R$ 1.000.000,00');
    assert.equal(ui.formatarPreco('4590'), 'R$ 45,90');
  });

  test('negativo ganha "-" na frente; fração de centavo é arredondada', () => {
    assert.equal(ui.formatarPreco(-150), '-R$ 1,50');
    assert.equal(ui.formatarPreco(12.6), 'R$ 0,13');
  });

  test('sem símbolo (valor de campo)', () => {
    assert.equal(ui.formatarPreco(4590, { simbolo: false }), '45,90');
    assert.equal(ui.formatarPreco(123456, { simbolo: false }), '1.234,56');
  });

  test('vazio ou inválido → "—" (ou "" sem símbolo)', () => {
    for (const v of [null, undefined, '', 'abc', Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(ui.formatarPreco(v), '—');
      assert.equal(ui.formatarPreco(v, { simbolo: false }), '');
    }
  });

  test('ida e volta: lerPreco(formatarPreco(v, sem símbolo)) === v', () => {
    for (const v of [0, 1, 9, 10, 99, 100, 1050, 4590, 99999, 123456, 100000000, 2147483647]) {
      assert.equal(ui.lerPreco(ui.formatarPreco(v, { simbolo: false })), v, String(v));
      assert.equal(ui.lerPreco(ui.formatarPreco(v)), v, `com símbolo ${v}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Texto

describe('slugify', () => {
  test('exemplos do contrato', () => {
    assert.equal(ui.slugify('Creme de Cupuaçu & Cia!'), 'creme-de-cupuacu-e-cia');
    assert.equal(ui.slugify('  Açaí  '), 'acai');
    assert.equal(ui.slugify('Óleo 100% Natural'), 'oleo-100-natural');
    assert.equal(ui.slugify('Ünïcödé — ÇÃO'), 'unicode-cao');
    assert.equal(ui.slugify('Body   Splash___Raiz'), 'body-splash-raiz');
  });

  test('sem nada aproveitável → ""', () => {
    for (const v of ['', '---', '   ', '日本語', '!!!', null, undefined]) assert.equal(ui.slugify(v), '', String(v));
  });

  test('limite de tamanho sem hífen sobrando no fim', () => {
    assert.equal(ui.slugify('a'.repeat(100)).length, 80);
    assert.equal(ui.slugify('abc def', { max: 4 }), 'abc');
    assert.equal(ui.slugify('Biojoia de semente', { max: 8 }), 'biojoia');
  });

  test('o resultado sempre passa no check de slug do banco', () => {
    const amostras = ['Sabonete <script>', '../../etc', 'Ação & Reação 2026', ' -x- ', 'ÀÉÎÕÜ ç ñ', 'a\u0000b', 'R$ 45,90', '😀 Flor'];
    for (const s of amostras) {
      const slug = ui.slugify(s);
      assert.match(slug, /^([a-z0-9]+(-[a-z0-9]+)*)?$/, s);
    }
  });
});

describe('escapar', () => {
  test('escapa os cinco caracteres do HTML', () => {
    assert.equal(ui.escapar('<b>"Oi"</b>'), '&lt;b&gt;&quot;Oi&quot;&lt;/b&gt;');
    assert.equal(ui.escapar("d'água & cia"), 'd&#39;água &amp; cia');
    assert.equal(ui.escapar('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  test('null/undefined → "" e números viram texto', () => {
    assert.equal(ui.escapar(null), '');
    assert.equal(ui.escapar(undefined), '');
    assert.equal(ui.escapar(0), '0');
    assert.equal(ui.escapar('já escapado &amp;'), 'já escapado &amp;amp;');
  });
});

// ---------------------------------------------------------------------------
// Status de pedido

describe('rótulos e cores de status', () => {
  test('mesma lista e mesma ordem do banco e da API', () => {
    assert.deepEqual([...ui.STATUS_PEDIDO], [...STATUS_DA_API]);
    const sql = lerArquivo('../../supabase/migrations/20261009120000_inicial.sql');
    const check = sql.match(/pedidos_status_check check \(status in \(([^)]*)\)\)/);
    assert.ok(check, 'check de status não encontrado na migração');
    assert.deepEqual(Array.from(check[1].matchAll(/'([a-z_]+)'/g), (m) => m[1]), [...ui.STATUS_PEDIDO]);
    assert.ok(Object.isFrozen(ui.STATUS_PEDIDO));
  });

  test('rótulos iguais aos do banco (_rotulo_status)', () => {
    const sql = lerArquivo('../../supabase/migrations/20261009120000_inicial.sql');
    const doBanco = Object.fromEntries(Array.from(sql.matchAll(/when '([a-z_]+)'\s+then '([^']+)'/g), (m) => [m[1], m[2]]));
    for (const status of ui.STATUS_PEDIDO) assert.equal(ui.rotuloStatusPedido(status), doBanco[status], status);
  });

  test('cada status tem uma cor que existe no admin.css e o selo usa as duas', () => {
    for (const status of ui.STATUS_PEDIDO) {
      const cor = ui.corStatusPedido(status);
      assert.ok(CORES_DO_CSS.has(cor), `${status} → selo--${cor} não existe no admin.css`);
      const selo = ui.seloStatusPedido(status);
      assert.equal(selo.className, `selo selo--${cor}`);
      assert.equal(selo.textContent, ui.rotuloStatusPedido(status));
    }
    assert.equal(ui.corStatusPedido('pago'), 'verde');
    assert.equal(ui.corStatusPedido('aguardando_pagamento'), 'ambar');
    assert.equal(ui.corStatusPedido('reembolsado'), 'vermelho');
  });

  test('status desconhecido: rótulo como veio, cor cinza; vazio → "Desconhecido"', () => {
    assert.equal(ui.rotuloStatusPedido('devolvido'), 'devolvido');
    assert.equal(ui.corStatusPedido('devolvido'), 'cinza');
    assert.equal(ui.rotuloStatusPedido(''), 'Desconhecido');
    assert.equal(ui.rotuloStatusPedido(null), 'Desconhecido');
    assert.equal(ui.rotuloStatusPedido(undefined), 'Desconhecido');
    // Propriedades herdadas de Object não contam como status.
    assert.equal(ui.rotuloStatusPedido('toString'), 'toString');
    assert.equal(ui.corStatusPedido('__proto__'), 'cinza');
    assert.equal(ui.corStatusPedido('constructor'), 'cinza');
  });

  test('o selo de status nunca interpreta HTML', () => {
    const selo = ui.seloStatusPedido('<img src=x onerror=alert(1)>');
    assert.equal(selo.querySelector('img'), null);
    assert.equal(selo.textContent, '<img src=x onerror=alert(1)>');
    assert.equal(selo.className, 'selo selo--cinza');
  });
});

// ---------------------------------------------------------------------------
// Datas, números e utilitários

describe('formatação de datas e números', () => {
  test('formatarData no horário de Belém', () => {
    assert.equal(ui.formatarData('2026-10-15T17:30:00Z'), '15/10/2026 14:30');
    assert.equal(ui.formatarData('2026-10-15T17:30:00Z', { hora: false }), '15/10/2026');
    assert.equal(ui.formatarData('2026-10-16T01:00:00Z', { hora: false }), '15/10/2026');
    assert.equal(ui.formatarData('2026-10-15'), '15/10/2026');
    assert.equal(ui.formatarData(new Date('2026-01-02T03:04:00Z')), '02/01/2026 00:04');
    for (const v of ['', null, undefined, 'ontem', 'abc']) assert.equal(ui.formatarData(v), '—');
  });

  test('tempoRelativo', () => {
    const agora = Date.parse('2026-10-15T12:00:00Z');
    const antes = (s) => new Date(agora - s * 1000).toISOString();
    assert.equal(ui.tempoRelativo(antes(10), agora), 'agora');
    assert.equal(ui.tempoRelativo(antes(5 * 60), agora), 'há 5 min');
    assert.equal(ui.tempoRelativo(antes(3 * 3600), agora), 'há 3 h');
    assert.equal(ui.tempoRelativo(antes(30 * 3600), agora), 'ontem');
    assert.equal(ui.tempoRelativo(antes(4 * 86400), agora), 'há 4 dias');
    assert.equal(ui.tempoRelativo(antes(20 * 86400), agora), '25/09/2026');
    assert.equal(ui.tempoRelativo('x', agora), '—');
  });

  test('formatarNumeroPedido e formatarBytes', () => {
    assert.equal(ui.formatarNumeroPedido(1042), '#1042');
    assert.equal(ui.formatarNumeroPedido(null), '#—');
    assert.equal(ui.formatarBytes(512), '512 B');
    assert.equal(ui.formatarBytes(15360), '15 KB');
    assert.equal(ui.formatarBytes(2400000), '2,3 MB');
    assert.equal(ui.formatarBytes(50 * 1024 * 1024), '50 MB');
    assert.equal(ui.formatarBytes(-1), '—');
    assert.equal(ui.formatarBytes('x'), '—');
  });

  test('moverItem devolve cópia e limita os índices', () => {
    const lista = ['a', 'b', 'c'];
    assert.deepEqual(ui.moverItem(lista, 0, 2), ['b', 'c', 'a']);
    assert.deepEqual(ui.moverItem(lista, 2, 0), ['c', 'a', 'b']);
    assert.deepEqual(ui.moverItem(lista, 1, 99), ['a', 'c', 'b']);
    assert.deepEqual(ui.moverItem(lista, -5, 1), ['b', 'a', 'c']);
    assert.deepEqual(lista, ['a', 'b', 'c']);
    assert.deepEqual(ui.moverItem([], 0, 1), []);
  });

  test('debounce chama uma vez com os últimos argumentos e cancelar descarta', async () => {
    const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
    const chamadas = [];
    const f = ui.debounce((v) => chamadas.push(v), 30);
    f(1); f(2); f(3);
    assert.deepEqual(chamadas, []);
    await esperar(60);
    assert.deepEqual(chamadas, [3]);
    f(4);
    f.cancelar();
    await esperar(60);
    assert.deepEqual(chamadas, [3]);
  });

  test('urlPermitida', () => {
    assert.equal(ui.urlPermitida('/admin/'), '/admin/');
    assert.equal(ui.urlPermitida('#/pedidos'), '#/pedidos');
    assert.equal(ui.urlPermitida('https://ama.org.br'), 'https://ama.org.br');
    assert.equal(ui.urlPermitida('mailto:a@b.c'), 'mailto:a@b.c');
    assert.equal(ui.urlPermitida('javascript:alert(1)'), null);
    assert.equal(ui.urlPermitida(' JaVaScRiPt:alert(1)'), null);
    assert.equal(ui.urlPermitida('java\nscript:alert(1)'), null);
    assert.equal(ui.urlPermitida('vbscript:x'), null);
    assert.equal(ui.urlPermitida('data:text/html,<b>'), null);
    assert.equal(ui.urlPermitida('data:image/png;base64,AAAA'), null);
    assert.equal(ui.urlPermitida('data:image/png;base64,AAAA', { midia: true }), 'data:image/png;base64,AAAA');
    assert.equal(ui.urlPermitida('data:image/svg+xml,<svg>', { midia: true }), null);
    assert.equal(ui.urlPermitida('blob:http://x/1', { midia: true }), 'blob:http://x/1');
  });
});

// ---------------------------------------------------------------------------
// el() seguro

describe('el()', () => {
  test('texto nunca vira HTML', () => {
    const p = ui.el('p', {}, '<img src=x onerror=alert(1)>', ' & <b>negrito</b>');
    assert.equal(p.children.length, 0);
    assert.equal(p.textContent, '<img src=x onerror=alert(1)> & <b>negrito</b>');
  });

  test('filhos: números viram texto, listas são achatadas, null/undefined/false/true somem', () => {
    const div = ui.el('div', {}, 'a', null, undefined, false, true, 0, ['b', ['c', ui.el('span', {}, 'd')]]);
    assert.equal(div.textContent, 'a0bcd');
    assert.equal(div.querySelector('span').textContent, 'd');
    const condicional = (sim) => ui.el('p', {}, sim && ui.el('strong', {}, 'só se sim'));
    assert.equal(condicional(false).children.length, 0);
    assert.equal(condicional(true).children.length, 1);
  });

  test('atalhos: el(tag, texto) e el(tag, [filhos])', () => {
    assert.equal(ui.el('p', 'texto').textContent, 'texto');
    assert.equal(ui.el('ul', [ui.el('li', 'a'), ui.el('li', 'b')]).children.length, 2);
    assert.equal(ui.el('p', 42).textContent, '42');
  });

  test('class, dataset, style e eventos', () => {
    let cliques = 0;
    const b = ui.el('button', {
      class: ['botao', false, null, 'botao--primario'], dataset: { id: 7, vazio: null },
      style: { justifyContent: 'flex-end', '--cor': '#fff' }, eventos: { click: () => { cliques += 1; } },
    });
    assert.equal(b.className, 'botao botao--primario');
    assert.equal(b.dataset.id, '7');
    assert.equal(b.hasAttribute('data-vazio'), false);
    assert.match(b.getAttribute('style'), /justify-content: ?flex-end/);
    b.dispatchEvent(new EventoDom('click'));
    assert.equal(cliques, 1);
  });

  test('booleanos: true → atributo vazio; false/null/undefined → omitido', () => {
    const e = ui.el('input', { hidden: true, disabled: false, readonly: null, title: undefined, required: true });
    assert.equal(e.getAttribute('hidden'), '');
    assert.equal(e.getAttribute('required'), '');
    assert.equal(e.hasAttribute('disabled'), false);
    assert.equal(e.hasAttribute('readonly'), false);
    assert.equal(e.hasAttribute('title'), false);
    assert.equal(ui.el('div', { 'data-ativo': false }).hasAttribute('data-ativo'), false);
  });

  test('aria-* com booleano vira "true"/"false" (ARIA não tem atributo booleano)', () => {
    const b = ui.el('button', { 'aria-pressed': false, 'aria-expanded': true, 'aria-hidden': true, 'aria-label': null, 'aria-selected': 'false' });
    assert.equal(b.getAttribute('aria-pressed'), 'false');
    assert.equal(b.getAttribute('aria-expanded'), 'true');
    assert.equal(b.getAttribute('aria-hidden'), 'true');
    assert.equal(b.getAttribute('aria-selected'), 'false');
    assert.equal(b.hasAttribute('aria-label'), false);
  });

  test('value, checked e textarea', () => {
    const caixa = ui.el('input', { type: 'checkbox', checked: true, value: 'sim' });
    assert.equal(caixa.checked, true);
    assert.equal(caixa.getAttribute('value'), 'sim');
    const area = ui.el('textarea', { value: '<b>texto</b>' });
    assert.equal(area.textContent, '<b>texto</b>');
    assert.equal(area.children.length, 0);
  });

  test('on*, innerHTML, srcdoc, tag e nome de atributo inválidos lançam TypeError', () => {
    assert.throws(() => ui.el('a', { onclick: 'alert(1)' }), TypeError);
    assert.throws(() => ui.el('img', { ONERROR: 'alert(1)' }), TypeError);
    assert.throws(() => ui.el('div', { innerHTML: '<b>x</b>' }), TypeError);
    assert.throws(() => ui.el('div', { outerHTML: '<b>x</b>' }), TypeError);
    assert.throws(() => ui.el('iframe', { srcdoc: '<script></script>' }), TypeError);
    assert.throws(() => ui.el('<img>'), TypeError);
    assert.throws(() => ui.el('img src=x'), TypeError);
    assert.throws(() => ui.el('div', { 'x y': '1' }), TypeError);
    assert.throws(() => ui.el('div', { '"><b': '1' }), TypeError);
  });

  test('URL perigosa em href/src/action/srcset é descartada com aviso', () => {
    const aviso = mock.method(console, 'warn', () => {});
    try {
      assert.equal(ui.el('a', { href: 'javascript:alert(1)' }).hasAttribute('href'), false);
      assert.equal(ui.el('a', { href: ' JaVaScRiPt:alert(1)' }).hasAttribute('href'), false);
      assert.equal(ui.el('a', { href: 'java\tscript:alert(1)' }).hasAttribute('href'), false);
      assert.equal(ui.el('iframe', { src: 'data:text/html,<script>alert(1)</script>' }).hasAttribute('src'), false);
      assert.equal(ui.el('form', { action: 'javascript:alert(1)' }).hasAttribute('action'), false);
      assert.equal(ui.el('img', { srcset: '/a.jpg 1x, javascript:alert(1) 2x' }).hasAttribute('srcset'), false);
      assert.ok(aviso.mock.callCount() >= 6);
      assert.equal(ui.el('a', { href: '#/pedidos/1' }).getAttribute('href'), '#/pedidos/1');
      assert.equal(ui.el('img', { src: 'data:image/png;base64,AAAA' }).getAttribute('src'), 'data:image/png;base64,AAAA');
      assert.equal(ui.el('img', { srcset: '/a.jpg 1x, /b.jpg 2x' }).getAttribute('srcset'), '/a.jpg 1x, /b.jpg 2x');
    } finally {
      aviso.mock.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Componentes

describe('tabela', () => {
  const linhas = [
    { id: 'a1', nome: 'Body Splash <b>Raiz</b>', ativo: true, estoque: 0, obs: null },
    { id: 'b2', nome: 'Creme', ativo: false, estoque: 5, obs: '' },
  ];
  const colunas = [
    { titulo: 'Produto', principal: true, chave: 'nome' },
    { titulo: 'À venda', chave: 'ativo' },
    { titulo: 'Estoque', chave: 'estoque', alinhar: 'direita' },
    { titulo: 'Obs.', chave: 'obs', ocultarNoCelular: true },
    { titulo: 'Separado', celula: (l) => ui.el('input', { type: 'checkbox', 'aria-label': `Separado ${l.id}` }) },
    { titulo: 'Ações', celula: (l) => ui.botao({ texto: 'Editar', href: `#/produtos/${l.id}` }) },
  ];

  test('células: booleano → Sim/Não, vazio → "—", zero aparece, texto não vira HTML', () => {
    const t = ui.tabela({ linhas, colunas, legenda: 'Produtos' });
    const celulas = (i) => Array.from(t.querySelectorAll('tbody tr')[i].querySelectorAll('td'), (td) => td.textContent);
    assert.deepEqual(celulas(0).slice(0, 4), ['Body Splash <b>Raiz</b>', 'Sim', '0', '—']);
    assert.deepEqual(celulas(1).slice(0, 4), ['Creme', 'Não', '5', '—']);
    assert.equal(t.querySelector('tbody b'), null);
    assert.equal(t.querySelector('caption').textContent, 'Produtos');
    assert.equal(t.querySelector('td').getAttribute('data-rotulo'), 'Produto');
    assert.ok(t.querySelector('td[data-rotulo="Obs."]').classList.contains('oculto-celular'));
    assert.ok(t.querySelector('td[data-rotulo="Estoque"]').classList.contains('alinhar-direita'));
  });

  test('com link: a coluna principal vira o link da linha e as células com controles ficam por cima', () => {
    const t = ui.tabela({ linhas, colunas, link: (l) => `#/produtos/${l.id}` });
    const tr = t.querySelector('tbody tr');
    assert.ok(tr.classList.contains('tabela__linha--link'));
    const link = tr.querySelector('td.tabela__principal > a.tabela__link');
    assert.equal(link.getAttribute('href'), '#/produtos/a1');
    assert.equal(link.textContent, 'Body Splash <b>Raiz</b>');
    const interativas = Array.from(tr.querySelectorAll('td.tabela__celula--interativa'), (td) => td.dataset.rotulo);
    assert.deepEqual(interativas, ['Separado', 'Ações']);
  });

  test('sem coluna principal o link vai na primeira; sem link nenhuma célula é marcada', () => {
    const t = ui.tabela({ linhas, colunas: colunas.map((c) => ({ ...c, principal: false })), link: () => '#/x' });
    assert.ok(t.querySelector('tbody tr td:first-child > a.tabela__link'));
    assert.equal(t.querySelector('tbody tr td:first-child').classList.contains('tabela__celula--interativa'), false);
    const semLink = ui.tabela({ linhas, colunas });
    assert.equal(semLink.querySelector('.tabela__celula--interativa'), null);
    assert.equal(semLink.querySelector('.tabela__link'), null);
  });

  test('sem linhas → estado vazio com o texto pedido', () => {
    const vazio = ui.tabela({ linhas: [], colunas, vazio: 'Nenhum produto ainda.' });
    assert.ok(vazio.classList.contains('estado-vazio'));
    assert.equal(vazio.querySelector('.estado-vazio__texto').textContent, 'Nenhum produto ainda.');
  });
});

describe('avisos e toasts: "alerta" e "aviso" são o mesmo tipo', () => {
  test('ui.aviso aceita os dois nomes (classe aviso--alerta)', () => {
    for (const tipo of ['alerta', 'aviso']) {
      const a = ui.aviso('Atenção a isto.', tipo, { titulo: 'Estoque baixo' });
      assert.equal(a.className, 'aviso aviso--alerta', tipo);
      assert.equal(a.querySelector('.aviso__titulo').textContent, 'Estoque baixo');
      assert.equal(a.hasAttribute('role'), false);
    }
    assert.equal(ui.aviso('x', 'erro').getAttribute('role'), 'alert');
    assert.equal(ui.aviso('x', 'sucesso').className, 'aviso aviso--sucesso');
    assert.equal(ui.aviso('x', 'outro').className, 'aviso aviso--info');
    assert.equal(ui.aviso('<b>x</b>').querySelector('b'), null);
  });

  test('ui.toast aceita os dois nomes (classe toast--aviso)', () => {
    const fechar = [];
    try {
      for (const tipo of ['aviso', 'alerta']) {
        fechar.push(ui.toast(`Cuidado (${tipo})`, tipo, { duracao: 0 }));
        const ultimo = document.querySelector('.toasts').lastElementChild;
        assert.equal(ultimo.className, 'toast toast--aviso', tipo);
        assert.equal(ultimo.getAttribute('role'), 'status');
      }
      fechar.push(ui.toast('Falhou', 'erro', { duracao: 0 }));
      assert.equal(document.querySelector('.toasts').lastElementChild.getAttribute('role'), 'alert');
      fechar.push(ui.toast('<img src=x onerror=alert(1)>', 'qualquer', { duracao: 0 }));
      const ultimo = document.querySelector('.toasts').lastElementChild;
      assert.equal(ultimo.className, 'toast toast--info');
      assert.equal(ultimo.querySelector('img'), null);
      assert.ok(document.querySelectorAll('.toasts > .toast').length <= 4);
    } finally {
      for (const f of fechar) f();
    }
  });
});

describe('modais', () => {
  test('fecharModais fecha todos (o mais recente primeiro) e resolve com null', async () => {
    const ordem = [];
    const a = ui.modal({ titulo: 'Primeiro', conteudo: 'a', acoes: [{ texto: 'OK', valor: 1 }] });
    const b = ui.modal({ titulo: 'Segundo', conteudo: 'b' });
    a.resultado.then(() => ordem.push('a'));
    b.resultado.then(() => ordem.push('b'));
    assert.equal(document.querySelectorAll('dialog.modal').length, 2);
    assert.ok(document.documentElement.classList.contains('modal-aberto'));
    assert.equal(ui.fecharModais(), 2);
    assert.deepEqual(await Promise.all([a.resultado, b.resultado]), [null, null]);
    assert.deepEqual(ordem, ['b', 'a']);
    assert.equal(document.querySelectorAll('dialog').length, 0);
    assert.equal(document.documentElement.classList.contains('modal-aberto'), false);
    assert.equal(ui.fecharModais(), 0);
  });

  test('confirmar resolve false quando fechado por fora; modal já fechado não conta', async () => {
    const pergunta = ui.confirmar('Apagar a categoria "<b>Cremes</b>"?', { perigo: true, textoConfirmar: 'Apagar' });
    const dialogo = document.querySelector('dialog.modal--confirmar');
    assert.equal(dialogo.querySelector('.modal__mensagem').textContent, 'Apagar a categoria "<b>Cremes</b>"?');
    assert.equal(dialogo.querySelector('.modal__mensagem b'), null);
    const fechado = ui.modal({ titulo: 'Já fechado' });
    fechado.fechar('valor');
    assert.equal(await fechado.resultado, 'valor');
    assert.equal(ui.fecharModais('ignorado'), 1);
    assert.equal(await pergunta, false);
  });

  test('ação com aoClicar fecha com o retorno; false mantém aberto', async () => {
    const m = ui.modal({
      titulo: 'Salvar', acoes: [{ texto: 'Não', aoClicar: () => false }, { texto: 'Sim', tipo: 'primario', aoClicar: async () => 'salvo' }],
    });
    const [nao, sim] = m.rodape.querySelectorAll('button');
    nao.dispatchEvent(new EventoDom('click'));
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(m.elemento.isConnected);
    sim.dispatchEvent(new EventoDom('click'));
    assert.equal(await m.resultado, 'salvo');
    assert.equal(m.elemento.isConnected, false);
  });
});

// ---------------------------------------------------------------------------
// midia.js

describe('nomeSeguroArquivo', () => {
  const data = new Date('2026-10-15T12:00:00Z');
  const FORMATO = /^[a-z0-9]+(-[a-z0-9]+)*\/\d{4}-\d{2}\/[a-z0-9]+(-[a-z0-9]+)*-[0-9a-f]{6}\.[a-z0-9]+$/;

  test('<pasta>/<aaaa-mm>/<slug>-<6 hex>.<ext>', () => {
    assert.equal(midia.nomeSeguroArquivo('Foto do Creme (1).JPEG', 'produtos', { data, sufixo: 'a1b2c3' }), 'produtos/2026-10/foto-do-creme-1-a1b2c3.jpg');
    assert.equal(midia.nomeSeguroArquivo('Vídeo Açaí.mp4', 'videos', { data, sufixo: '000fff' }), 'videos/2026-10/video-acai-000fff.mp4');
    assert.equal(midia.nomeSeguroArquivo('x.jfif', undefined, { data, sufixo: 'abcdef' }), 'site/2026-10/x-abcdef.jpg');
  });

  test('extensão pelo tipo MIME (otimizada) e "bin" quando desconhecida', () => {
    assert.equal(midia.nomeSeguroArquivo('foto.png', 'site', { data, sufixo: 'abcdef', tipo: 'image/webp' }), 'site/2026-10/foto-abcdef.webp');
    assert.equal(midia.nomeSeguroArquivo('foto.png', 'site', { data, sufixo: 'abcdef', tipo: 'IMAGE/JPEG' }), 'site/2026-10/foto-abcdef.jpg');
    assert.equal(midia.nomeSeguroArquivo('leia-me', 'site', { data, sufixo: 'abcdef' }), 'site/2026-10/leia-me-abcdef.bin');
  });

  test('nome perigoso ou vazio vira um nome seguro', () => {
    assert.equal(midia.nomeSeguroArquivo('../../etc/passwd.png', 'site', { data, sufixo: 'abcdef' }), 'site/2026-10/passwd-abcdef.png');
    assert.equal(midia.nomeSeguroArquivo('C:\\Fotos\\Minha foto.PNG', 'site', { data, sufixo: 'abcdef' }), 'site/2026-10/minha-foto-abcdef.png');
    assert.equal(midia.nomeSeguroArquivo('<script>.gif', 'site', { data, sufixo: 'abcdef' }), 'site/2026-10/script-abcdef.gif');
    assert.equal(midia.nomeSeguroArquivo('', 'site', { data, sufixo: 'abcdef' }), 'site/2026-10/arquivo-abcdef.bin');
    assert.equal(midia.nomeSeguroArquivo('日本.webp', 'site', { data, sufixo: 'abcdef' }), 'site/2026-10/arquivo-abcdef.webp');
    assert.equal(midia.nomeSeguroArquivo(`${'a'.repeat(200)}.png`, 'site', { data, sufixo: 'abcdef' }).length, 'site/2026-10/'.length + 60 + 7 + 4);
  });

  test('sufixo aleatório (ou inválido) vira 6 hex; data inválida usa o mês atual', () => {
    const a = midia.nomeSeguroArquivo('a.png', 'site');
    const b = midia.nomeSeguroArquivo('a.png', 'site', { sufixo: 'XYZ', data: new Date('x') });
    assert.match(a, FORMATO);
    assert.match(b, FORMATO);
    assert.notEqual(a, midia.nomeSeguroArquivo('a.png', 'site'));
  });

  test('pasta inválida lança TypeError (função pura); vazia vira "site"', () => {
    for (const pasta of ['../x', 'site/2026-10', 'Site', 'a b', '-site', 'site-', 'x.y', '/site']) {
      assert.throws(() => midia.nomeSeguroArquivo('a.png', pasta), TypeError, pasta);
    }
    assert.match(midia.nomeSeguroArquivo('a.png', '', { data }), /^site\/2026-10\//);
    assert.match(midia.nomeSeguroArquivo('a.png', null, { data }), /^site\/2026-10\//);
    assert.match(midia.nomeSeguroArquivo('a.png', 'loja-2', { data }), /^loja-2\/2026-10\//);
  });
});

describe('validação de arquivos', () => {
  const arquivo = (name, type, size = 1000) => ({ name, type, size });

  test('tipoDoArquivo e categoriaDoTipo', () => {
    assert.equal(midia.tipoDoArquivo(arquivo('a.jpg', 'image/jpg')), 'image/jpeg');
    assert.equal(midia.tipoDoArquivo(arquivo('a.JFIF', '')), 'image/jpeg');
    assert.equal(midia.tipoDoArquivo(arquivo('a.pdf', '')), '');
    assert.equal(midia.tipoDoArquivo(null), '');
    assert.equal(midia.categoriaDoTipo('video/webm'), 'video');
    assert.equal(midia.categoriaDoTipo('foto.png'), 'imagem');
    assert.equal(midia.categoriaDoTipo('image/svg+xml'), null);
    assert.equal(midia.categoriaDoTipo('x.pdf'), null);
  });

  test('validarArquivo: tipo, vazio, limite e avisos', () => {
    assert.deepEqual(midia.validarArquivo(arquivo('a.png', 'image/png')), { ok: true, avisos: [], tipo: 'image/png', categoria: 'imagem' });
    const svg = midia.validarArquivo(arquivo('a.svg', 'image/svg+xml'));
    assert.equal(svg.ok, false);
    assert.match(svg.erro, /não aceito/);
    assert.match(midia.validarArquivo(arquivo('a.mp4', 'video/mp4'), { tipo: 'imagem' }).erro, /JPG, PNG, WebP, GIF ou AVIF/);
    assert.match(midia.validarArquivo(arquivo('a.png', 'image/png'), { tipo: 'video' }).erro, /MP4 ou WebM/);
    assert.equal(midia.validarArquivo(arquivo('a.png', 'image/png', 0)).erro, 'O arquivo está vazio.');
    assert.match(midia.validarArquivo(arquivo('a.mp4', 'video/mp4', midia.LIMITE_BYTES + 1)).erro, /limite é 50 MB/);
    assert.equal(midia.validarArquivo(arquivo('a.jpg', 'image/jpeg', 3 * 1024 * 1024)).avisos.length, 1);
    assert.equal(midia.validarArquivo(arquivo('a.mp4', 'video/mp4', 30 * 1024 * 1024)).avisos.length, 1);
  });

  test('enderecoDeMidiaValido', () => {
    for (const v of ['/img/logo-ama.png', 'https://exemplo.com/a.jpg', ' https://cdn.x/v.mp4 ']) assert.equal(midia.enderecoDeMidiaValido(v), true, v);
    for (const v of ['', 'http://x.com/a.jpg', '//evil.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AA', '/img/a b.png', '/img/"x.png', 'img/x.png']) {
      assert.equal(midia.enderecoDeMidiaValido(v), false, v);
    }
  });
});

describe('enviarArquivo e caminhos do bucket', () => {
  // Cliente falso: só a sessão (o envio de verdade é testado no navegador).
  configurarApi({
    supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'jwt-falso' } } }) } },
    supabaseUrl: 'http://127.0.0.1:54321/',
    supabaseAnonKey: 'anon',
  });
  const video = { name: 'video.mp4', type: 'video/mp4', size: 10 };

  test('pasta inválida rejeita com ErroMidia "pasta_invalida" (e não TypeError)', async () => {
    for (const pasta of ['../site', 'site/2026-10', 'Produtos', 'a b']) {
      await assert.rejects(midia.enviarArquivo(video, pasta, { otimizar: false }), (erro) => {
        assert.ok(erro instanceof midia.ErroMidia, `${pasta}: ${erro && erro.name}`);
        assert.equal(erro.codigo, 'pasta_invalida');
        assert.match(erro.message, /site, produtos, videos/);
        return true;
      });
    }
  });

  test('sem arquivo e tipo não aceito também viram ErroMidia', async () => {
    await assert.rejects(midia.enviarArquivo(null, 'site'), { name: 'ErroMidia', codigo: 'sem_arquivo' });
    await assert.rejects(midia.enviarArquivo({ name: 'x.svg', type: 'image/svg+xml', size: 10 }, 'site'), { name: 'ErroMidia', codigo: 'arquivo_invalido' });
  });

  test('caminhoDaUrl só aceita URLs públicas do bucket deste projeto', () => {
    const base = 'http://127.0.0.1:54321/storage/v1/object/public/midia/';
    assert.equal(midia.caminhoDaUrl(`${base}site/2026-10/a-123456.png`), 'site/2026-10/a-123456.png');
    assert.equal(midia.caminhoDaUrl(`${base}site/2026-10/foto%20x-123456.png?v=1`), 'site/2026-10/foto x-123456.png');
    assert.equal(midia.caminhoDaUrl(`${base}site/../../segredo.png`), null);
    assert.equal(midia.caminhoDaUrl(`${base}site/%2e%2e/x.png`), null);
    assert.equal(midia.caminhoDaUrl('https://outro.supabase.co/storage/v1/object/public/midia/site/a.png'), null);
    assert.equal(midia.caminhoDaUrl('/img/logo-ama.png'), null);
  });

  test('apagarArquivo recusa caminho inválido antes de chamar o Storage', async () => {
    for (const caminho of ['', '/site/a.png', 'site/../x.png', 'site//a.png']) {
      await assert.rejects(midia.apagarArquivo(caminho), { name: 'ErroMidia', codigo: 'caminho_invalido' }, caminho);
    }
  });
});

// ---------------------------------------------------------------------------
// Roteador (funções puras do app.js)

describe('roteador', () => {
  const UUID = '0E8A1C2D-3B4F-4A5B-8C6D-7E8F9A0B1C2D';

  test('resolverRota: páginas, params e consulta', () => {
    assert.equal(resolverRota('#/').pagina, 'visao-geral');
    assert.equal(resolverRota('').pagina, 'visao-geral');
    assert.equal(resolverRota('#secao').pagina, 'visao-geral');
    assert.deepEqual(resolverRota('#/produtos/').params, {});
    assert.equal(resolverRota('#/produtos/').caminho, '/produtos');
    assert.deepEqual(resolverRota('#/produtos/novo').params, { id: 'novo' });
    assert.deepEqual(resolverRota(`#/produtos/${UUID}`).params, { id: UUID.toLowerCase() });
    assert.deepEqual(resolverRota(`#/pedidos/${UUID}`).params, { id: UUID.toLowerCase() });
    assert.deepEqual(resolverRota('#/conteudo/hero').params, { grupo: 'hero' });
    const r = resolverRota('#/pedidos?status=pago&pagina=2');
    assert.equal(r.pagina, 'pedidos');
    assert.deepEqual(r.consulta, { status: 'pago', pagina: '2' });
    assert.equal(r.hash, '#/pedidos?status=pago&pagina=2');
  });

  test('resolverRota: caminho desconhecido → null', () => {
    for (const h of ['#/produtos/abc', '#/Produtos', '#/pedidos/novo', '#/nao-existe', '#/conteudo/Hero', '#/conteudo/-x']) {
      assert.equal(resolverRota(h), null, h);
    }
  });

  test('normalizarHash', () => {
    assert.equal(normalizarHash('produtos'), '#/produtos');
    assert.equal(normalizarHash('/produtos'), '#/produtos');
    assert.equal(normalizarHash('#/produtos?x=1'), '#/produtos?x=1');
    assert.equal(normalizarHash(' #/ '), '#/');
    assert.equal(normalizarHash(''), '#/');
    assert.equal(normalizarHash(null), '#/');
  });

  test('cada item do menu abre uma rota marcada com o próprio item', () => {
    const itens = MENU.flatMap((s) => s.itens);
    assert.equal(new Set(itens.map((i) => i.id)).size, itens.length);
    for (const item of itens) {
      const rota = resolverRota(item.hash);
      assert.ok(rota, item.hash);
      assert.equal(rota.menu, item.id, item.hash);
      assert.ok(ui.ICONES.includes(item.icone), item.icone);
    }
    for (const rota of ROTAS) assert.match(rota.pagina, /^[a-z][a-z-]*$/);
  });
});
