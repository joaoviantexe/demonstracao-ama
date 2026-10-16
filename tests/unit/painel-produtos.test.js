// Testes das páginas de produtos e categorias do painel (public/admin/js/paginas/produtos.js e categorias.js):
// funções puras (endereço, números, fotos, validação igual aos checks do banco, registro, selos, filtros,
// reordenação) e as telas num DOM do linkedom com um supabase falso (sem rede).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

import * as ui from '../../public/admin/js/ui.js';
import * as api from '../../public/admin/js/api.js';
import * as midia from '../../public/admin/js/midia.js';
import * as produtos from '../../public/admin/js/paginas/produtos.js';
import * as categorias from '../../public/admin/js/paginas/categorias.js';

const {
  EXPLICACAO_SEM_PRECO, MAX_IMAGENS, SITUACOES, adicionarImagens, campoDaRestricao, contarPorSituacao,
  erroSlug, filtrarProdutos, formatarDecimal, gerarSlug, imagemValida, lerDecimal, lerInteiro, mensagemAlternarAtivo,
  montarRegistro, moverImagem, normalizarImagens, ordenarProdutos, removerImagem, selosProduto,
  situacaoProduto, sugerirSlug, validarProduto, NOME_PADRAO, vitrineComProduto, ordemParaMover,
} = produtos;
const {
  mensagemApagarCategoria, montarCategoria, planejarReordenacao, proximaOrdem, quantidadeDeProdutos, validarCategoria,
} = categorias;

const lerArquivo = (caminho) => readFileSync(new URL(caminho, import.meta.url), 'utf8');

// Um documento para o arquivo todo (a região de toasts do ui.js fica presa ao primeiro).
const janela = parseHTML('<!doctype html><html lang="pt-BR"><head></head><body></body></html>');
const { document, Event: EventoDom } = janela;
globalThis.document = document;
// O que o linkedom não tem e o navegador tem: scrollIntoView e select.value com setter (sem opção marcada,
// o navegador devolve a primeira).
if (!janela.HTMLElement.prototype.scrollIntoView) janela.HTMLElement.prototype.scrollIntoView = () => {};
Object.defineProperty(janela.HTMLSelectElement.prototype, 'value', {
  configurable: true,
  get() {
    const opcao = this.querySelector('option[selected]') || this.querySelector('option');
    return opcao ? opcao.value : '';
  },
  set(valor) {
    for (const opcao of this.querySelectorAll('option')) opcao.toggleAttribute('selected', opcao.value === String(valor));
  },
});

const SQL = lerArquivo('../../supabase/migrations/20261009120000_inicial.sql');
const SLUG_DO_BANCO = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// O painel só grava estas colunas (endereço, promoção, SKU, medidas e controle de estoque não são editados).
const COLUNAS_PRODUTOS = ['nome', 'descricao', 'preco_centavos', 'estoque', 'ativo', 'destaque', 'categoria_id', 'imagens', 'ordem'];
const CORES_DO_CSS = new Set(Array.from(lerArquivo('../../public/admin/admin.css').matchAll(/\.selo--([a-z-]+)/g), (m) => m[1]));

/** Os checks da tabela produtos (supabase/migrations/…_inicial.sql) aplicados a um registro. */
function checksDoBanco(r) {
  const int = (n) => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647;
  const falhas = [];
  if (!(r.nome.trim().length >= 1 && r.nome.trim().length <= 120)) falhas.push('produtos_nome_check');
  if (!(int(r.preco_centavos) && r.preco_centavos >= 0)) falhas.push('produtos_preco_check');
  if (!(int(r.estoque) && r.estoque >= 0)) falhas.push('produtos_estoque_check');
  if (!Array.isArray(r.imagens)) falhas.push('produtos_imagens_check');
  if (!int(r.ordem)) falhas.push('ordem');
  return falhas;
}

const VALORES_OK = Object.freeze({
  nome: 'Creme Hidratante Cupuaçu', descricao: 'Creme de 200 mL.',
  preco: '69,90', estoque: '10', ativo: true, destaque: false,
  categoria_id: '', imagens: [{ src: '/img/produtos/creme.jpg', alt: 'Frasco âmbar' }], ordem: '0',
});

// ---------------------------------------------------------------------------
// Regras combinadas com a AMA

describe('regras do produto', () => {
  test('explicação de produto sem preço é a frase combinada (sem "Em breve")', () => {
    assert.equal(EXPLICACAO_SEM_PRECO, 'aparece na loja com R$ 00,00 e ninguém consegue finalizar a compra até você definir o preço');
  });

  test('as páginas não falam em "Em breve" nem em pedido pelo WhatsApp', () => {
    for (const arquivo of ['produtos.js', 'categorias.js']) {
      const codigo = lerArquivo(`../../public/admin/js/paginas/${arquivo}`).replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, '');
      assert.doesNotMatch(codigo, /em breve/i, arquivo);
      assert.doesNotMatch(codigo, /whatsapp/i, arquivo);
    }
  });

});

// ---------------------------------------------------------------------------
// Endereço (slug)

describe('endereço (slug)', () => {
  test('gerarSlug: nome → endereço aceito pelo banco', () => {
    assert.equal(gerarSlug('Creme de Cupuaçu 200 mL'), 'creme-de-cupuacu-200-ml');
    assert.equal(gerarSlug('Sabonete Líquido Íntimo Barbatimão & Andiroba'), 'sabonete-liquido-intimo-barbatimao-e-andiroba');
    assert.equal(gerarSlug('  --Bruma!!  '), 'bruma');
    assert.equal(gerarSlug('???'), '');
    const longo = gerarSlug('palavra '.repeat(40));
    assert.ok(longo.length <= 80 && SLUG_DO_BANCO.test(longo), longo);
  });

  test('erroSlug aceita só o que o check do banco aceita', () => {
    for (const ok of ['creme', 'creme-novo', 'a1-b2-c3', 'x'.repeat(120)]) assert.equal(erroSlug(ok), null, ok);
    for (const ruim of ['', '  ', 'Creme', 'creme novo', 'creme--novo', '-creme', 'creme-', 'cremé', 'creme_novo', 'x'.repeat(121)]) {
      assert.equal(typeof erroSlug(ruim), 'string', ruim);
      assert.equal(SLUG_DO_BANCO.test(ruim) && ruim.length <= 120, false, ruim);
    }
    assert.match(erroSlug('x'.repeat(121)), /120 caracteres/);
  });

  test('sugerirSlug devolve o primeiro endereço livre, sempre válido', () => {
    assert.equal(sugerirSlug('body-splash-raiz', []), 'body-splash-raiz');
    assert.equal(sugerirSlug('body-splash-raiz', ['body-splash-raiz']), 'body-splash-raiz-2');
    assert.equal(sugerirSlug('body-splash-raiz', ['body-splash-raiz', 'body-splash-raiz-2', 'body-splash-raiz-3']), 'body-splash-raiz-4');
    assert.equal(sugerirSlug('', []), 'produto');
    const base = 'a'.repeat(120);
    const sugestao = sugerirSlug(base, [base]);
    assert.ok(sugestao.length <= 120 && SLUG_DO_BANCO.test(sugestao) && sugestao !== base, sugestao);
  });
});

// ---------------------------------------------------------------------------
// Números digitados

describe('números digitados', () => {
  test('lerInteiro', () => {
    assert.deepEqual(lerInteiro('3'), { vazio: false, valor: 3 });
    assert.deepEqual(lerInteiro(' 1.000 '), { vazio: false, valor: 1000 });
    assert.deepEqual(lerInteiro('-2'), { vazio: false, valor: -2 });
    assert.deepEqual(lerInteiro(''), { vazio: true, valor: null });
    assert.deepEqual(lerInteiro(null), { vazio: true, valor: null });
    for (const ruim of ['3,5', '2.5', 'abc', '1e3', '12a', '1.00']) assert.equal(lerInteiro(ruim).valor, null, ruim);
  });

  test('lerDecimal e formatarDecimal', () => {
    assert.equal(lerDecimal('4,5').valor, 4.5);
    assert.equal(lerDecimal('4.5').valor, 4.5);
    assert.equal(lerDecimal('12').valor, 12);
    assert.equal(lerDecimal('').vazio, true);
    for (const ruim of ['1,2,3', 'abc', '4,', ',5']) assert.equal(lerDecimal(ruim).valor, null, ruim);
    assert.equal(formatarDecimal(4), '4');
    assert.equal(formatarDecimal('4.5'), '4,5');
    assert.equal(formatarDecimal('12.0'), '12');
    assert.equal(formatarDecimal(Number.NaN), '');
  });
});

// ---------------------------------------------------------------------------
// Fotos

describe('fotos do produto', () => {
  const a = { src: '/img/a.jpg', alt: 'A' };
  const b = { src: '/img/b.jpg', alt: 'B' };
  const c = { src: '/img/c.jpg', alt: 'C' };

  test('imagemValida: caminho do site ou http(s); nada de esquemas perigosos', () => {
    for (const ok of ['/img/produtos/x.jpg', 'https://abc.supabase.co/storage/v1/object/public/midia/produtos/2026-10/x.png', 'http://127.0.0.1:54321/x.png']) {
      assert.equal(imagemValida(ok), true, ok);
    }
    for (const ruim of ['', '//evil.example/x.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://a b.png', '/img/"x".png', '/img/<x>.png', 'ftp://x/y.png']) {
      assert.equal(imagemValida(ruim), false, ruim);
    }
  });

  test('normalizarImagens descarta itens estranhos', () => {
    assert.deepEqual(
      normalizarImagens([{ src: ' /a.jpg ', alt: 'x' }, '/b.jpg', null, { src: '' }, { src: 5 }, { src: '/c.jpg', alt: 3 }]),
      [{ src: '/a.jpg', alt: 'x' }, { src: '/b.jpg', alt: '' }, { src: '/c.jpg', alt: '' }],
    );
    assert.deepEqual(normalizarImagens(null), []);
    assert.deepEqual(normalizarImagens({ src: '/a.jpg' }), []);
  });

  test('moverImagem: reordena (a primeira é a capa) sem mexer na original; o texto alternativo vai junto', () => {
    const lista = [a, b, c];
    assert.deepEqual(moverImagem(lista, 0, 1), [b, a, c]);
    assert.deepEqual(moverImagem(lista, 2, 0), [c, a, b]); // "Usar como capa"
    assert.deepEqual(moverImagem(lista, 0, 99), [b, c, a]);
    assert.deepEqual(lista, [a, b, c]);
  });

  test('removerImagem', () => {
    assert.deepEqual(removerImagem([a, b, c], 1), [a, c]);
    assert.deepEqual(removerImagem([a], 5), [a]);
    assert.deepEqual(removerImagem(null, 0), []);
  });

  test('adicionarImagens: no fim, sem repetir e sem passar do máximo', () => {
    const r = adicionarImagens([a], [{ src: '/img/b.jpg' }, { src: '/img/a.jpg' }, { src: '' }, { src: ' /img/c.jpg ', alt: 'C' }]);
    assert.deepEqual(r.imagens, [a, { src: '/img/b.jpg', alt: '' }, { src: '/img/c.jpg', alt: 'C' }]);
    assert.deepEqual([r.adicionadas, r.repetidas, r.excedentes], [2, 1, 0]);
    const cheia = Array.from({ length: MAX_IMAGENS }, (_, i) => ({ src: `/img/${i}.jpg`, alt: '' }));
    const r2 = adicionarImagens(cheia, [{ src: '/img/nova.jpg' }]);
    assert.equal(r2.imagens.length, MAX_IMAGENS);
    assert.deepEqual([r2.adicionadas, r2.excedentes], [0, 1]);
  });
});

// ---------------------------------------------------------------------------
// Validação e registro

describe('validarProduto', () => {
  const com = (extra) => validarProduto({ ...VALORES_OK, ...extra });

  test('valores certos → sem erros; as chaves de erro são colunas da tabela (ou "imagens")', () => {
    assert.deepEqual(validarProduto(VALORES_OK), {});
    const erros = validarProduto({
      nome: 'x'.repeat(121), descricao: 'x'.repeat(10001), preco: 'abc', estoque: '-1',
      categoria_id: 'abc', imagens: [{ src: 'javascript:x' }], ordem: 'x',
    });
    assert.deepEqual(Object.keys(erros).sort(), ['categoria_id', 'descricao', 'estoque', 'imagens', 'nome', 'ordem', 'preco_centavos']);
    for (const chave of Object.keys(erros)) assert.ok(COLUNAS_PRODUTOS.includes(chave), chave);
  });

  test('formulário vazio é válido: nome vira "Produto sem Nome", preço e estoque 0', () => {
    assert.deepEqual(validarProduto({ imagens: [] }), {});
    const r = montarRegistro({ imagens: [] });
    assert.equal(r.nome, NOME_PADRAO);
    assert.equal(NOME_PADRAO, 'Produto sem Nome');
    assert.equal(r.preco_centavos, 0);
    assert.equal(r.estoque, 0);
  });

  test('preço: opcional (vazio = 0), nunca negativo', () => {
    assert.deepEqual(com({ preco: '0' }), {});
    assert.deepEqual(com({ preco: '0,00' }), {});
    assert.deepEqual(com({ preco: '' }), {});
    assert.match(com({ preco: '12,345' }).preco_centavos, /inválido/);
    assert.match(com({ preco: '-5' }).preco_centavos, /inválido/);
  });

  test('estoque: inteiro ≥ 0', () => {
    assert.deepEqual(com({ estoque: '0' }), {});
    assert.match(com({ estoque: '-1' }).estoque, /negativo/);
    assert.match(com({ estoque: '2,5' }).estoque, /inteiro/);
    assert.deepEqual(com({ estoque: '' }), {});
    assert.match(com({ estoque: '99999999999' }).estoque, /grande/);
  });

  test('nome, ordem e categoria', () => {
    assert.deepEqual(com({ nome: '   ' }), {});
    assert.equal(com({ nome: 'x'.repeat(120) }).nome, undefined);
    assert.match(com({ nome: 'x'.repeat(121) }).nome, /120/);
    assert.deepEqual(com({ ordem: '-3' }), {});
    assert.match(com({ ordem: '1,5' }).ordem, /inteiro/);
    assert.deepEqual(com({ categoria_id: '11111111-1111-4111-8111-111111111111' }), {});
    assert.match(com({ categoria_id: 'abc' }).categoria_id, /lista/);
  });

  test('fotos: máximo, endereço e descrição', () => {
    const muitas = Array.from({ length: MAX_IMAGENS + 1 }, (_, i) => ({ src: `/img/${i}.jpg`, alt: '' }));
    assert.match(com({ imagens: muitas }).imagens, new RegExp(`no máximo ${MAX_IMAGENS} fotos`));
    assert.match(com({ imagens: [{ src: '/img/a.jpg' }, { src: '//x' }] }).imagens, /foto 2/);
    assert.match(com({ imagens: [{ src: '/img/a.jpg', alt: 'x'.repeat(301) }] }).imagens, /300/);
  });
});

describe('montarRegistro', () => {
  test('textos do formulário → registro do banco (centavos, nulos); só as colunas editáveis', () => {
    const registro = montarRegistro({
      ...VALORES_OK, nome: '  Creme  ', descricao: ' Texto \n\n Outro ', preco: '1.234,56', estoque: '3',
      categoria_id: '11111111-1111-4111-8111-111111111111', imagens: [{ src: ' /img/a.jpg ', alt: ' Frasco ' }], ordem: '',
    });
    assert.deepEqual(registro, {
      nome: 'Creme', descricao: 'Texto \n\n Outro', preco_centavos: 123456, estoque: 3, ativo: true, destaque: false,
      categoria_id: '11111111-1111-4111-8111-111111111111', imagens: [{ src: '/img/a.jpg', alt: 'Frasco' }], ordem: 0,
    });
    assert.deepEqual(Object.keys(registro).sort(), [...COLUNAS_PRODUTOS].sort());
  });

  test('categoria vazia e flags', () => {
    const r = montarRegistro({ ...VALORES_OK, ativo: false, destaque: true });
    assert.equal(r.ativo, false);
    assert.equal(r.destaque, true);
    assert.equal(r.categoria_id, null);
  });

  test('todo valor que passa na validação também passa nos checks do banco', () => {
    const casos = [
      VALORES_OK,
      { ...VALORES_OK, preco: '0' },
      { ...VALORES_OK, preco: '0,01' },
      { ...VALORES_OK, preco: '21474836,47', estoque: '2147483647' },
      { ...VALORES_OK, nome: ` ${'x'.repeat(120)} `, ordem: '-2147483647' },
      { ...VALORES_OK, imagens: [] },
    ];
    for (const valores of casos) {
      assert.deepEqual(validarProduto(valores), {}, JSON.stringify(valores));
      assert.deepEqual(checksDoBanco(montarRegistro(valores)), [], JSON.stringify(valores));
    }
  });

  test('os checks do banco usados aqui existem na migração', () => {
    for (const nome of ['produtos_nome_check', 'produtos_preco_check', 'produtos_estoque_check', 'produtos_imagens_check']) {
      assert.match(SQL, new RegExp(`constraint ${nome} check`), nome);
      assert.ok(campoDaRestricao(nome), nome);
    }
    assert.equal(campoDaRestricao('produtos_preco_check'), 'preco_centavos');
    assert.equal(campoDaRestricao('outra_coisa'), null);
  });
});

// ---------------------------------------------------------------------------
// Lista: situação, selos, filtros e ordenação

const P = (extra) => ({
  id: extra.id || 'p', nome: 'Produto', slug: 'produto', preco_centavos: 5990, preco_promocional_centavos: null, estoque: 10,
  controlar_estoque: true, ativo: true, destaque: false, categoria_id: null, imagens: [{ src: '/img/x.jpg', alt: '' }],
  ordem: 0, sku: null, criado_em: '2026-10-01T12:00:00Z', ...extra,
});

describe('situação e selos', () => {
  test('produto sem preço (como as biojoias do seed): selo "Sem preço" com a frase combinada', () => {
    const biojoia = P({ preco_centavos: 0, estoque: 0 });
    const s = situacaoProduto(biojoia);
    assert.equal(s.semPreco, true);
    assert.equal(s.precoEfetivo, 0);
    const selos = selosProduto(biojoia);
    assert.deepEqual(selos.map((x) => x.texto), ['Sem preço', 'Sem estoque']);
    assert.ok(selos[0].dica.includes(EXPLICACAO_SEM_PRECO));
    assert.doesNotMatch(selos[1].dica, /^Aparece na loja como esgotado/); // a loja não mostra "Esgotado" sem preço
  });

  test('destaque, fora da loja e estoque', () => {
    assert.deepEqual(selosProduto(P({ destaque: true })).map((x) => x.texto), ['Destaque']);
    assert.deepEqual(selosProduto(P({ ativo: false })).map((x) => x.texto), ['Fora da loja']);
    assert.deepEqual(selosProduto(P({ estoque: 0 })).map((x) => x.texto), ['Sem estoque']);
    assert.match(selosProduto(P({ estoque: 0 }))[0].dica, /esgotado/);
    assert.deepEqual(selosProduto(P({ estoque: 0, controlar_estoque: false })), []);
    assert.deepEqual(selosProduto(P({})), []);
  });

  test('estoque baixo', () => {
    assert.equal(situacaoProduto(P({ estoque: 3 })).estoqueBaixo, true);
    assert.equal(situacaoProduto(P({ estoque: 4 })).estoqueBaixo, false);
  });

  test('as cores dos selos existem no admin.css e nenhum selo diz "Em breve"', () => {
    const combinacoes = [P({}), P({ ativo: false, preco_centavos: 0, estoque: 0, destaque: true })];
    for (const p of combinacoes) {
      for (const selo of selosProduto(p)) {
        assert.ok(CORES_DO_CSS.has(selo.cor), selo.cor);
        assert.doesNotMatch(`${selo.texto} ${selo.dica}`, /em breve/i);
      }
    }
  });

  test('mensagem de colocar/tirar da loja', () => {
    assert.match(mensagemAlternarAtivo(P({ nome: 'Bruma' }), false), /Tirar "Bruma" da loja\?.*Pedidos já feitos não mudam/);
    assert.ok(mensagemAlternarAtivo(P({ preco_centavos: 0, ativo: false }), true).includes(EXPLICACAO_SEM_PRECO));
    assert.match(mensagemAlternarAtivo(P({ estoque: 0, ativo: false }), true), /esgotado/);
    assert.match(mensagemAlternarAtivo(P({ imagens: [], ativo: false }), true), /não tem foto/);
  });
});

describe('filtros e ordenação', () => {
  const lista = [
    P({ id: 'a', nome: 'Creme Hidratante Cupuaçu', slug: 'creme-cupuacu', categoria_id: 'cremes', preco_centavos: 6990, ordem: 2, criado_em: '2026-10-02T00:00:00Z' }),
    P({ id: 'b', nome: 'Body Splash Raiz', slug: 'body-splash-raiz', categoria_id: 'splash', sku: 'AMA-BS-RAIZ', destaque: true, ordem: 5 }),
    P({ id: 'c', nome: 'Nome em Produção', slug: 'biojoia-01', categoria_id: 'biojoias', preco_centavos: 0, estoque: 0, ordem: 1 }),
    P({ id: 'd', nome: 'Antigo', slug: 'antigo', ativo: false, preco_centavos: 1000, estoque: 2, ordem: 1, criado_em: '2026-09-01T00:00:00Z' }),
  ];
  const ids = (l) => l.map((p) => p.id).join('');

  test('busca sem acento pelo nome ou endereço (todas as palavras)', () => {
    assert.equal(ids(filtrarProdutos(lista, { busca: 'cupuacu' })), 'a');
    assert.equal(ids(filtrarProdutos(lista, { busca: 'CREME   hidratante' })), 'a');
    assert.equal(ids(filtrarProdutos(lista, { busca: 'body-splash' })), 'b');
    assert.equal(ids(filtrarProdutos(lista, { busca: 'biojoia' })), 'c');
    assert.equal(ids(filtrarProdutos(lista, { busca: 'creme raiz' })), '');
  });

  test('categoria e situação', () => {
    assert.equal(ids(filtrarProdutos(lista, { categoria: 'splash' })), 'b');
    assert.equal(ids(filtrarProdutos([...lista, P({ id: 'e' })], { categoria: 'sem' })), 'de');
    assert.equal(ids(filtrarProdutos(lista, { situacao: 'sem-preco' })), 'c');
    assert.equal(ids(filtrarProdutos(lista, { situacao: 'fora' })), 'd');
    assert.equal(ids(filtrarProdutos(lista, { situacao: 'a-venda' })), 'abc');
    assert.equal(ids(filtrarProdutos(lista, { situacao: 'estoque-baixo' })), 'd');
    assert.equal(ids(filtrarProdutos(lista, { situacao: 'nao-existe' })), 'abcd');
  });

  test('contarPorSituacao bate com o filtro', () => {
    const contagem = contarPorSituacao(lista);
    for (const s of SITUACOES) assert.equal(contagem[s.id], filtrarProdutos(lista, { situacao: s.id }).length, s.id);
  });

  test('ordenar: ordem da loja, nome, preço (sem preço no fim), estoque e recentes, sem mexer na lista', () => {
    const copia = [...lista];
    assert.equal(ids(ordenarProdutos(lista, 'loja')), 'bcda'); // destaque, ordem, mais novos
    assert.equal(ids(ordenarProdutos(lista, 'nome')), 'dbac');
    // Empates (mesmo preço, estoque ou data) saem pelo nome.
    assert.equal(ids(ordenarProdutos(lista, 'preco-menor')), 'dbac');
    assert.equal(ids(ordenarProdutos(lista, 'preco-maior')), 'abdc');
    assert.equal(ids(ordenarProdutos(lista, 'estoque')), 'cdba');
    assert.equal(ids(ordenarProdutos(lista, 'recentes')), 'abcd');
    assert.equal(ids(ordenarProdutos(lista, 'desconhecido')), 'bcda');
    assert.deepEqual(lista, copia);
  });
});

// ---------------------------------------------------------------------------
// Categorias (puras)

describe('categorias: funções puras', () => {
  test('validarCategoria e montarCategoria (sem endereço: ele sai do nome)', () => {
    assert.deepEqual(Object.keys(validarCategoria({ nome: ' ' })), ['nome']);
    assert.deepEqual(validarCategoria({ nome: 'Body Splash', descricao: '' }), {});
    assert.match(validarCategoria({ nome: 'x'.repeat(121) }).nome, /120/);
    assert.match(validarCategoria({ nome: 'X', descricao: 'd'.repeat(501) }).descricao, /500/);
    assert.deepEqual(montarCategoria({ nome: ' Body Splash ', descricao: ' Perfumes ' }),
      { nome: 'Body Splash', descricao: 'Perfumes', ativo: true });
    assert.equal(montarCategoria({ nome: 'X', ativo: false }).ativo, false);
  });

  test('proximaOrdem', () => {
    assert.equal(proximaOrdem([]), 1);
    assert.equal(proximaOrdem([{ ordem: 3 }, { ordem: '7' }, { ordem: null }]), 8);
  });

  test('planejarReordenacao: numera 1, 2, 3… e só grava o que mudou', () => {
    const lista = [{ id: 'a', ordem: 1 }, { id: 'b', ordem: 2 }, { id: 'c', ordem: 3 }];
    const plano = planejarReordenacao(lista, 2, 1);
    assert.deepEqual(plano.lista.map((c) => c.id), ['a', 'c', 'b']);
    assert.deepEqual(plano.mudancas, [{ id: 'c', ordem: 2 }, { id: 'b', ordem: 3 }]);
    assert.deepEqual(lista.map((c) => c.ordem), [1, 2, 3]);
    const baguncada = planejarReordenacao([{ id: 'a', ordem: 0 }, { id: 'b', ordem: 0 }, { id: 'c', ordem: 5 }], 0, 1);
    assert.deepEqual(baguncada.mudancas, [{ id: 'b', ordem: 1 }, { id: 'a', ordem: 2 }, { id: 'c', ordem: 3 }]);
    assert.deepEqual(planejarReordenacao(lista, 0, 0).mudancas, []);
  });

  test('quantidadeDeProdutos (produtos(count) do PostgREST)', () => {
    assert.equal(quantidadeDeProdutos({ produtos: [{ count: 4 }] }), 4);
    assert.equal(quantidadeDeProdutos({ produtos: { count: 2 } }), 2);
    assert.equal(quantidadeDeProdutos({ produtos: [] }), 0);
    assert.equal(quantidadeDeProdutos({}), 0);
  });

  test('mensagemApagarCategoria explica que os produtos ficam sem categoria', () => {
    assert.match(mensagemApagarCategoria({ nome: 'Vazia' }, 0), /não tem produtos/);
    assert.match(mensagemApagarCategoria({ nome: 'Uma' }, 1), /O produto dela continua.*sem categoria/);
    assert.match(mensagemApagarCategoria({ nome: 'Várias' }, 3), /Os 3 produtos dela continuam.*sem categoria/);
  });
});

// ---------------------------------------------------------------------------
// Telas num DOM do linkedom, com supabase falso

/** Supabase falso: grava a cadeia de cada consulta e responde com responder(chamada). */
function supabaseFalso(responder) {
  const chamadas = [];
  return {
    chamadas,
    from(tabela) {
      const chamada = { tabela, passos: [] };
      chamadas.push(chamada);
      const construtor = new Proxy({}, {
        get(_, nome) {
          if (nome === 'then') {
            return (ok, falha) => Promise.resolve()
              .then(() => ({ data: null, error: null, status: 200, count: null, ...(responder(chamada) || {}) }))
              .then(ok, falha);
          }
          return (...args) => {
            chamada.passos.push([nome, ...args]);
            return construtor;
          };
        },
      });
      return construtor;
    },
  };
}

const passo = (chamada, nome) => chamada.passos.find((p) => p[0] === nome);
const operacao = (chamada) => ['insert', 'update', 'delete'].find((o) => passo(chamada, o)) || 'select';

async function esperar(condicao, descricao = 'condição') {
  for (let i = 0; i < 300; i += 1) {
    if (condicao()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`não aconteceu: ${descricao}`);
}

function criarCtx({ params = {}, consulta = {}, responder, midiaExtra = {} }) {
  document.body.replaceChildren();
  const raiz = document.createElement('div');
  raiz.className = 'pagina';
  document.body.append(raiz);
  const supabase = supabaseFalso(responder);
  const registro = { navegacoes: [], alterado: [], toasts: [], titulos: [] };
  const ctx = {
    raiz, supabase, params, consulta, usuario: { id: 'u1', email: 'admin@ama.local' }, rota: 'produtos', hash: '#/produtos', titulo: 'Produtos',
    sinal: new AbortController().signal,
    ui: {
      ...ui,
      carregarCss: async () => {},
      toast: (msg, tipo) => {
        registro.toasts.push([msg, tipo]);
        return () => {};
      },
    },
    api,
    midia: { ...midia, ...midiaExtra },
    ativo: () => true,
    navegar: (destino, opcoes) => registro.navegacoes.push([destino, opcoes]),
    marcarAlterado: (sim = true) => registro.alterado.push(sim),
    definirTitulo: (t) => registro.titulos.push(t),
    atualizarContadores: async () => {},
  };
  return { ctx, supabase, registro };
}

const disparar = (alvo, tipo) => alvo.dispatchEvent(new EventoDom(tipo, { bubbles: true, cancelable: true }));
function digitar(entrada, valor) {
  entrada.value = valor;
  disparar(entrada, 'input');
}
const textoDe = (no) => (no ? no.textContent.replace(/\s+/g, ' ').trim() : '');
const botaoPorTexto = (raiz, texto) => Array.from(raiz.querySelectorAll('button, a')).find((b) => textoDe(b) === texto);
const botaoPorRotulo = (raiz, rotulo) => raiz.querySelector(`[aria-label="${rotulo}"]`);
const dialogo = () => document.querySelector('dialog[open]');

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';
const CAT1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CAT2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CATEGORIAS = [{ id: CAT1, nome: 'Body Splash', ativo: true, ordem: 1 }, { id: CAT2, nome: 'Biojoias', ativo: true, ordem: 2 }];

describe('tela: lista de produtos', () => {
  const lista = () => [
    P({ id: ID1, nome: 'Body Splash Raiz', slug: 'body-splash-raiz', categoria_id: CAT1, preco_centavos: 6990, destaque: true }),
    P({ id: ID2, nome: 'Nome em Produção', slug: 'biojoia-01', categoria_id: CAT2, preco_centavos: 0, estoque: 0 }),
    P({ id: ID3, nome: 'Rascunho <b>x</b>', slug: 'rascunho', ativo: false, imagens: [] }),
  ];

  function montar(extra = {}) {
    const dados = lista();
    return criarCtx({
      ...extra,
      responder: (c) => {
        if (c.tabela === 'categorias') return { data: CATEGORIAS };
        if (operacao(c) === 'update') {
          const [, mudanca] = passo(c, 'update');
          const id = passo(c, 'eq')[2];
          const p = dados.find((x) => x.id === id);
          Object.assign(p, mudanca);
          return { data: { id, ativo: p.ativo } };
        }
        return { data: dados };
      },
    });
  }

  test('linhas com preço (R$ 00,00 sem preço), estoque, selos e aviso dos sem preço', async () => {
    const { ctx } = montar();
    const limpar = await produtos.renderizar(ctx);
    const linhas = ctx.raiz.querySelectorAll('.produtos-tabela tbody tr');
    assert.equal(linhas.length, 3);
    assert.equal(textoDe(ctx.raiz.querySelector('h1')), 'Produtos');
    assert.equal(textoDe(ctx.raiz.querySelector('.produtos-contador')), '3 produtos');
    const [comPreco, semPreco, rascunho] = linhas;
    assert.equal(textoDe(comPreco.querySelector('.produto-preco')), 'R$ 69,90');
    assert.equal(comPreco.querySelector('s'), null);
    assert.equal(textoDe(semPreco.querySelector('.produto-preco')).replace(/ /g, ' '), 'R$ 00,00');
    assert.deepEqual(Array.from(semPreco.querySelectorAll('.selo'), textoDe), ['Sem preço', 'Sem estoque']);
    assert.deepEqual(Array.from(rascunho.querySelectorAll('.selo'), textoDe), ['Fora da loja']);
    assert.equal(textoDe(rascunho.querySelector('.produto-celula__nome')), 'Rascunho <b>x</b>'); // texto, nunca HTML
    assert.equal(rascunho.querySelector('b'), null);
    assert.equal(rascunho.querySelector('.produto-celula__nome').getAttribute('href'), `#/produtos/${ID3}`);
    assert.ok(!rascunho.querySelector('.produto-interruptor input').checked);
    const aviso = textoDe(ctx.raiz.querySelector('.produtos-avisos .aviso'));
    assert.ok(aviso.includes(`1 produto à venda está sem preço: ${EXPLICACAO_SEM_PRECO}`), aviso);
    assert.doesNotMatch(textoDe(ctx.raiz), /em breve/i);
    limpar();
  });

  test('filtro de situação guarda na URL (sem renderizar de novo)', async () => {
    const { ctx, registro } = montar();
    const limpar = await produtos.renderizar(ctx);
    const situacao = ctx.raiz.querySelector('select[aria-label="Filtrar por situação"]');
    situacao.value = 'sem-preco';
    disparar(situacao, 'change');
    assert.equal(ctx.raiz.querySelectorAll('.produtos-tabela tbody tr').length, 1);
    assert.deepEqual(registro.navegacoes.at(-1), ['#/produtos?situacao=sem-preco', { silencioso: true }]);
    assert.equal(textoDe(ctx.raiz.querySelector('.produtos-contador')), 'Mostrando 1 de 3 produtos');
    limpar();
  });

  test('filtros vindos da URL e estado "nada encontrado" com "Limpar filtros"', async () => {
    const { ctx } = montar({ consulta: { busca: 'nao existe', categoria: CAT1 } });
    const limpar = await produtos.renderizar(ctx);
    assert.equal(ctx.raiz.querySelector('input[type="search"]').value, 'nao existe');
    assert.equal(textoDe(ctx.raiz.querySelector('.estado-vazio__titulo')), 'Nada encontrado');
    botaoPorTexto(ctx.raiz, 'Limpar filtros').click();
    assert.equal(ctx.raiz.querySelectorAll('.produtos-tabela tbody tr').length, 3);
    limpar();
  });

  test('"À venda" na lista: confirma antes e só então grava', async () => {
    const { ctx, supabase, registro } = montar();
    const limpar = await produtos.renderizar(ctx);
    const entrada = ctx.raiz.querySelector(`input[data-id="${ID1}"]`);
    entrada.click();
    await esperar(() => dialogo(), 'confirmação');
    assert.equal(entrada.checked, true, 'não muda antes de confirmar');
    assert.match(textoDe(dialogo().querySelector('.modal__mensagem')), /Tirar "Body Splash Raiz" da loja\?/);
    botaoPorTexto(dialogo(), 'Cancelar').click();
    await esperar(() => !dialogo(), 'fechar');
    assert.equal(supabase.chamadas.filter((c) => operacao(c) === 'update').length, 0);

    ctx.raiz.querySelector(`input[data-id="${ID1}"]`).click();
    await esperar(() => dialogo(), 'confirmação');
    botaoPorTexto(dialogo(), 'Tirar da loja').click();
    await esperar(() => registro.toasts.length, 'toast');
    const update = supabase.chamadas.find((c) => operacao(c) === 'update');
    assert.deepEqual(passo(update, 'update')[1], { ativo: false });
    assert.deepEqual(passo(update, 'eq').slice(1), ['id', ID1]);
    const linha = ctx.raiz.querySelector(`input[data-id="${ID1}"]`).closest('tr');
    assert.ok(Array.from(linha.querySelectorAll('.selo'), textoDe).includes('Fora da loja'));
    assert.match(registro.toasts.at(-1)[0], /saiu da loja/);
    limpar();
  });

  test('erro ao carregar → mensagem com "Tentar novamente"', async () => {
    const { ctx } = criarCtx({ responder: () => ({ error: { message: 'Failed to fetch' }, status: 0 }) });
    await produtos.renderizar(ctx);
    assert.equal(textoDe(ctx.raiz.querySelector('.estado-vazio--erro .estado-vazio__titulo')), 'Não foi possível carregar os produtos');
    assert.ok(botaoPorTexto(ctx.raiz, 'Tentar novamente'));
  });
});

describe('tela: formulário do produto', () => {
  const PRODUTO = {
    ...P({ id: ID1, nome: 'Body Splash Raiz', slug: 'body-splash-raiz', categoria_id: CAT1, preco_centavos: 5990, estoque: 4 }),
    descricao: 'Perfume', peso_gramas: 300, altura_cm: '4.0', largura_cm: '12.0', comprimento_cm: '16.0',
    atualizado_em: '2026-10-15T10:00:00Z',
  };

  test('produto novo: nada obrigatório, seções em uma coluna, salvar vazio cria "Produto sem Nome" com preço e estoque 0', async () => {
    const inseridos = [];
    const { ctx, registro } = criarCtx({
      params: { id: 'novo' },
      responder: (c) => {
        if (c.tabela === 'categorias') return { data: CATEGORIAS };
        if (operacao(c) === 'insert') {
          inseridos.push(passo(c, 'insert')[1]);
          return { data: { ...inseridos.at(-1), id: ID2 } };
        }
        if (passo(c, 'like')) return { data: [{ slug: 'creme-de-cupuacu-200-ml' }] }; // o endereço do nome já existe
        return { data: [] };
      },
    });
    await produtos.renderizar(ctx);
    const form = ctx.raiz.querySelector('form.produto-form');
    const campo = (nome) => form.querySelector(`[name="${nome}"]`);
    assert.equal(textoDe(ctx.raiz.querySelector('h1')), 'Novo produto');
    assert.equal(textoDe(ctx.raiz.querySelector('.pagina-cabecalho__descricao')), '');
    assert.deepEqual(Array.from(form.querySelectorAll('.cartao__titulo'), textoDe), ['Informações', 'Fotos', 'Preço', 'Disponibilidade', 'Visualização']);
    assert.equal(form.querySelector('.grade--painel'), null, 'uma coluna só');
    assert.equal(form.querySelectorAll('[required]').length, 0, 'nenhum campo obrigatório');
    assert.equal(campo('ativo').checked, true, 'produto novo começa à venda');
    assert.equal(campo('preco').value, '0,00');
    assert.equal(campo('estoque').value, '0');
    assert.equal(campo('categoria_id').closest('.cartao').querySelector('.cartao__titulo').textContent, 'Informações');
    assert.equal(campo('estoque').closest('.cartao').querySelector('.cartao__titulo').textContent, 'Disponibilidade');
    assert.equal(campo('destaque').closest('.cartao').querySelector('.cartao__titulo').textContent, 'Visualização');
    for (const removido of ['slug', 'preco_promocional', 'sku', 'controlar_estoque', 'peso_gramas', 'altura_cm', 'ordem']) {
      assert.equal(campo(removido), null, `${removido} não existe mais no formulário`);
    }
    for (const texto of ['Escolher da biblioteca', 'Duplicar', 'Nenhuma foto ainda', 'A primeira foto é a capa', 'Quantas unidades', 'Digite 0 se']) {
      assert.equal(textoDe(ctx.raiz).includes(texto), false, texto);
    }
    assert.match(textoDe(form.querySelector('.produto-previa__cartao--atual')), /Produto sem Nome/);

    // Salvar vazio: sem aviso, vira "Produto sem Nome".
    disparar(form, 'submit');
    await esperar(() => registro.navegacoes.length, 'navegar');
    assert.equal(form.querySelector('.campo--erro'), null);
    assert.deepEqual(inseridos[0], {
      nome: 'Produto sem Nome', slug: 'produto-sem-nome', descricao: '', preco_centavos: 0,
      estoque: 0, ativo: true, destaque: false, categoria_id: null, imagens: [], ordem: 0,
    });
    assert.deepEqual(registro.navegacoes.at(-1), [`#/produtos/${ID2}`, { substituir: true }]);
    assert.equal(registro.alterado.at(-1), false, 'desliga o aviso antes de navegar');
  });

  test('produto novo com dados: endereço gerado do nome, categoria; preço e estoque nunca negativos', async () => {
    let inserido = null;
    const { ctx, registro } = criarCtx({
      params: { id: 'novo' },
      responder: (c) => {
        if (c.tabela === 'categorias') return { data: CATEGORIAS };
        if (operacao(c) === 'insert') {
          inserido = passo(c, 'insert')[1];
          return { data: { ...inserido, id: ID2 } };
        }
        if (passo(c, 'like')) return { data: [{ slug: 'creme-de-cupuacu-200-ml' }] };
        return { data: [] };
      },
    });
    await produtos.renderizar(ctx);
    const form = ctx.raiz.querySelector('form.produto-form');
    const campo = (nome) => form.querySelector(`[name="${nome}"]`);
    digitar(campo('nome'), 'Creme de Cupuaçu 200 mL');
    digitar(campo('preco'), '-49,90');
    assert.equal(campo('preco').value, '49,90', 'o sinal de menos não entra no preço');
    digitar(campo('estoque'), '-3');
    assert.equal(campo('estoque').value, '3', 'o sinal de menos não entra no estoque');
    campo('categoria_id').value = CAT2;
    disparar(campo('categoria_id'), 'change');
    assert.equal(registro.alterado.at(-1), true);
    disparar(form, 'submit');
    await esperar(() => registro.navegacoes.length, 'navegar');
    assert.deepEqual(inserido, {
      nome: 'Creme de Cupuaçu 200 mL', slug: 'creme-de-cupuacu-200-ml-2', descricao: '', preco_centavos: 4990,
      estoque: 3, ativo: true, destaque: false, categoria_id: CAT2, imagens: [], ordem: 0,
    });
  });

  test('Visualização: posição na vitrine, vizinhos, destaque e "Mais para o começo/fim"', async () => {
    const vitrine = [
      P({ id: 'v1', nome: 'Primeiro', destaque: true, ordem: 0, criado_em: '2026-10-01T00:00:00Z' }),
      P({ id: 'v2', nome: 'Segundo', ordem: 1, criado_em: '2026-10-01T00:00:00Z' }),
      P({ id: 'v3', nome: 'Terceiro', ordem: 5, criado_em: '2026-10-01T00:00:00Z' }),
    ];
    let salvo = null;
    const PRODUTO_V = { ...P({ id: ID1, nome: 'Body Splash Raiz', ordem: 3, preco_centavos: 5990, estoque: 4 }), descricao: '', atualizado_em: '2026-10-15T10:00:00Z' };
    const { ctx } = criarCtx({
      params: { id: ID1 },
      responder: (c) => {
        if (c.tabela === 'categorias') return { data: CATEGORIAS };
        if (operacao(c) === 'update') {
          salvo = passo(c, 'update')[1];
          return { data: { ...PRODUTO_V, ...salvo } };
        }
        if (passo(c, 'maybeSingle')) return { data: PRODUTO_V };
        return { data: [...vitrine, PRODUTO_V] };
      },
    });
    await produtos.renderizar(ctx);
    const form = ctx.raiz.querySelector('form.produto-form');
    const posicao = () => textoDe(form.querySelector('.produto-previa__posicao'));
    const nomes = () => Array.from(form.querySelectorAll('.produto-previa__cartao .produto-previa__nome'), textoDe);
    assert.equal(posicao(), '3º de 4 na loja');
    assert.deepEqual(nomes(), ['Segundo', 'Body Splash Raiz', 'Terceiro']);
    botaoPorTexto(form, 'Mais para o começo').click();
    assert.equal(posicao(), '2º de 4 na loja');
    assert.deepEqual(nomes(), ['Primeiro', 'Body Splash Raiz', 'Segundo']);
    assert.equal(botaoPorTexto(form, 'Mais para o começo').disabled, true, 'não passa na frente dos destaques');
    const destaque = form.querySelector('[name="destaque"]');
    destaque.checked = true;
    disparar(destaque, 'change');
    assert.match(textoDe(form.querySelector('.produto-previa__cartao--atual')), /Destaque/);
    const ativo = form.querySelector('[name="ativo"]');
    ativo.checked = false;
    disparar(ativo, 'change');
    assert.match(posicao(), /Fora da loja/);
    ativo.checked = true;
    disparar(ativo, 'change');
    destaque.checked = false;
    disparar(destaque, 'change');
    disparar(form, 'submit');
    await esperar(() => salvo, 'update');
    assert.equal(salvo.ordem, 0, 'a nova posição vai para o banco');
  });

  test('fotos: envio na pasta produtos/, só imagens, reordenar, texto alternativo e remover', async () => {
    let area = null;
    const enviados = [];
    let salvo = null;
    const { ctx, registro } = criarCtx({
      params: { id: ID1 },
      midiaExtra: {
        criarAreaUpload: (opcoes) => {
          area = opcoes;
          return midia.criarAreaUpload(opcoes);
        },
        enviarArquivo: async (arquivo, pasta) => {
          enviados.push([arquivo.name, pasta]);
          return { url: `https://exemplo.supabase.co/storage/v1/object/public/midia/${pasta}/2026-10/${arquivo.name}` };
        },
      },
      responder: (c) => {
        if (c.tabela === 'categorias') return { data: CATEGORIAS };
        if (operacao(c) === 'update') {
          salvo = passo(c, 'update')[1];
          return { data: { ...PRODUTO, ...salvo } };
        }
        return { data: { ...PRODUTO, imagens: [] } };
      },
    });
    await produtos.renderizar(ctx);
    const form = ctx.raiz.querySelector('form.produto-form');
    assert.equal(textoDe(ctx.raiz.querySelector('h1')), 'Body Splash Raiz');
    assert.equal(ctx.raiz.querySelector('[data-ver-na-loja]').getAttribute('href'), '/loja/produto?slug=body-splash-raiz');

    await area.aoEscolher([
      new File([new Uint8Array([137, 80, 78, 71])], 'frente.png', { type: 'image/png' }),
      new File(['texto'], 'nota.txt', { type: 'text/plain' }),
      new File([new Uint8Array([255, 216, 255])], 'verso.jpg', { type: 'image/jpeg' }),
    ]);
    assert.deepEqual(enviados, [['frente.png', 'produtos'], ['verso.jpg', 'produtos']]);
    assert.ok(registro.toasts.some(([msg, tipo]) => tipo === 'erro' && /^nota\.txt:/.test(msg)));
    const fotos = () => Array.from(form.querySelectorAll('.produto-foto img'), (img) => img.getAttribute('src').split('/').pop());
    assert.deepEqual(fotos(), ['frente.png', 'verso.jpg']);
    assert.equal(textoDe(form.querySelector('.produto-foto .selo')), 'Capa');

    const alt = form.querySelectorAll('.produto-foto__alt');
    digitar(alt[0], 'Frasco de frente');
    digitar(alt[1], 'Frasco de costas');
    botaoPorRotulo(form, 'Descer a foto 1').click();
    assert.deepEqual(fotos(), ['verso.jpg', 'frente.png']);
    assert.equal(form.querySelectorAll('.produto-foto__alt')[0].value, 'Frasco de costas');

    botaoPorRotulo(form, 'Tirar a foto 2').click();
    await esperar(() => dialogo(), 'confirmação de tirar foto');
    botaoPorTexto(dialogo(), 'Tirar foto').click();
    await esperar(() => fotos().length === 1, 'foto removida');

    disparar(form, 'submit');
    await esperar(() => salvo, 'update');
    assert.deepEqual(salvo.imagens, [{ src: 'https://exemplo.supabase.co/storage/v1/object/public/midia/produtos/2026-10/verso.jpg', alt: 'Frasco de costas' }]);
    assert.equal(salvo.categoria_id, CAT1);
    assert.ok(registro.toasts.some(([msg]) => msg === 'Alterações salvas.'));
  });

  test('produto novo com endereço repetido (23505): tenta de novo com o próximo livre, sem mostrar erro', async () => {
    const tentativas = [];
    const { ctx, registro } = criarCtx({
      params: { id: 'novo' },
      responder: (c) => {
        if (c.tabela === 'categorias') return { data: [] };
        if (operacao(c) === 'insert') {
          const reg = passo(c, 'insert')[1];
          tentativas.push(reg.slug);
          if (tentativas.length === 1) {
            return { error: { code: '23505', details: 'Key (slug)=(bruma) already exists.', message: 'duplicate key value violates unique constraint "produtos_slug_key"' }, status: 409 };
          }
          return { data: { ...reg, id: ID2 } };
        }
        if (passo(c, 'like')) return { data: tentativas.length ? [{ slug: 'bruma' }, { slug: 'bruma-2' }] : [] };
        return { data: [] };
      },
    });
    await produtos.renderizar(ctx);
    const form = ctx.raiz.querySelector('form.produto-form');
    digitar(form.querySelector('[name="nome"]'), 'Bruma');
    digitar(form.querySelector('[name="preco"]'), '10');
    digitar(form.querySelector('[name="estoque"]'), '1');
    disparar(form, 'submit');
    await esperar(() => registro.navegacoes.length, 'navegar');
    assert.deepEqual(tentativas, ['bruma', 'bruma-3']);
    assert.equal(form.querySelector('.campo--erro'), null);
  });

  test('categorias não carregaram: salvar mantém a categoria do produto', async () => {
    let salvo = null;
    const { ctx, registro } = criarCtx({
      params: { id: ID1 },
      responder: (c) => {
        if (c.tabela === 'categorias') return { error: { message: 'Failed to fetch' }, status: 0 };
        if (operacao(c) === 'update') {
          salvo = passo(c, 'update')[1];
          return { data: { ...PRODUTO, ...salvo } };
        }
        return { data: PRODUTO };
      },
    });
    await produtos.renderizar(ctx);
    assert.ok(registro.toasts.some(([msg, tipo]) => tipo === 'erro' && /categorias/.test(msg)));
    const form = ctx.raiz.querySelector('form.produto-form');
    assert.equal(form.querySelector('[name="categoria_id"]').value, CAT1);
    disparar(form, 'submit');
    await esperar(() => salvo, 'update');
    assert.equal(salvo.categoria_id, CAT1);
  });

  test('"Nova categoria" no formulário cria pelo modal e já escolhe', async () => {
    let inserida = null;
    const { ctx } = criarCtx({
      params: { id: 'novo' },
      responder: (c) => {
        if (c.tabela === 'categorias' && operacao(c) === 'insert') {
          inserida = passo(c, 'insert')[1];
          return { data: { id: CAT2, ...inserida } };
        }
        if (c.tabela === 'categorias') return { data: [CATEGORIAS[0]] };
        return { data: [] };
      },
    });
    await produtos.renderizar(ctx);
    botaoPorTexto(ctx.raiz, 'Nova categoria').click();
    await esperar(() => dialogo(), 'modal de categoria');
    digitar(dialogo().querySelector('[name="nome"]'), 'Óleos & Essências');
    assert.equal(dialogo().querySelector('[name="slug"]'), null);
    botaoPorTexto(dialogo(), 'Criar categoria').click();
    await esperar(() => !dialogo(), 'modal fechado');
    assert.deepEqual(inserida, { nome: 'Óleos & Essências', slug: 'oleos-e-essencias', descricao: '', ativo: true, ordem: 2 });
    const select = ctx.raiz.querySelector('[name="categoria_id"]');
    await esperar(() => select.value === CAT2, 'categoria escolhida');
  });

  test('apagar: confirmação explica os pedidos antigos e volta para a lista', async () => {
    const { ctx, supabase, registro } = criarCtx({
      params: { id: ID1 },
      responder: (c) => {
        if (c.tabela === 'categorias') return { data: CATEGORIAS };
        if (operacao(c) === 'delete') return { data: [{ id: ID1 }] };
        return { data: PRODUTO };
      },
    });
    await produtos.renderizar(ctx);
    botaoPorTexto(ctx.raiz, 'Apagar').click(); // no topo da página, ao lado de "Ver na loja"
    await esperar(() => dialogo(), 'confirmação');
    assert.match(textoDe(dialogo().querySelector('.modal__mensagem')), /pedidos antigos continuam mostrando o nome/);
    botaoPorTexto(dialogo(), 'Apagar produto').click();
    await esperar(() => registro.navegacoes.length, 'navegar');
    const apagar = supabase.chamadas.find((c) => operacao(c) === 'delete');
    assert.deepEqual(passo(apagar, 'eq').slice(1), ['id', ID1]);
    assert.deepEqual(registro.navegacoes.at(-1), ['#/produtos', undefined]);
  });

  test('produto que não existe → "Produto não encontrado" com volta para a lista', async () => {
    const { ctx } = criarCtx({ params: { id: ID3 }, responder: (c) => (c.tabela === 'categorias' ? { data: [] } : { data: null }) });
    await produtos.renderizar(ctx);
    assert.equal(textoDe(ctx.raiz.querySelector('h1')), 'Produto não encontrado');
    assert.equal(ctx.raiz.querySelector('form'), null);
    assert.equal(botaoPorTexto(ctx.raiz, 'Ver produtos').getAttribute('href'), '#/produtos');
  });
});

describe('tela: categorias', () => {
  const dados = () => [
    { id: CAT1, nome: 'Body Splash', slug: 'body-splash', descricao: 'Perfumes', ordem: 1, ativo: true, produtos: [{ count: 4 }] },
    { id: CAT2, nome: 'Biojoias', slug: 'biojoias', descricao: '', ordem: 2, ativo: false, produtos: [{ count: 0 }] },
  ];

  test('lista com quantidade (link para os produtos), situação, subir/descer e apagar', async () => {
    const lista = dados();
    const { ctx, supabase } = criarCtx({
      responder: (c) => {
        if (operacao(c) === 'update') {
          const [, mudanca] = passo(c, 'update');
          Object.assign(lista.find((x) => x.id === passo(c, 'eq')[2]), mudanca);
          return {};
        }
        if (operacao(c) === 'delete') {
          lista.splice(lista.findIndex((x) => x.id === passo(c, 'eq')[2]), 1);
          return {};
        }
        return { data: [...lista].sort((a, b) => a.ordem - b.ordem) };
      },
    });
    const limpar = await categorias.renderizar(ctx);
    const nomes = () => Array.from(ctx.raiz.querySelectorAll('.categoria-celula__nome'), textoDe);
    assert.deepEqual(nomes(), ['Body Splash', 'Biojoias']);
    assert.match(passo(supabase.chamadas[0], 'select')[1], /produtos\(count\)/);
    const link = ctx.raiz.querySelector('.categoria-produtos');
    assert.equal(textoDe(link), '4 produtos');
    assert.equal(link.getAttribute('href'), `#/produtos?categoria=${CAT1}`);
    assert.deepEqual(Array.from(ctx.raiz.querySelectorAll('.selo'), textoDe), ['Visível', 'Oculta']);
    assert.equal(botaoPorRotulo(ctx.raiz, 'Subir Body Splash').disabled, true);

    botaoPorRotulo(ctx.raiz, 'Descer Body Splash').click();
    await esperar(() => nomes()[0] === 'Biojoias', 'reordenar');
    const updates = supabase.chamadas.filter((c) => operacao(c) === 'update').map((c) => [passo(c, 'eq')[2], passo(c, 'update')[1].ordem]);
    assert.deepEqual(updates.sort(), [[CAT1, 2], [CAT2, 1]].sort());

    botaoPorRotulo(ctx.raiz, 'Apagar Body Splash').click();
    await esperar(() => dialogo(), 'confirmação');
    assert.match(textoDe(dialogo().querySelector('.modal__mensagem')), /Os 4 produtos dela continuam na loja e no painel, só que sem categoria/);
    botaoPorTexto(dialogo(), 'Apagar categoria').click();
    await esperar(() => nomes().length === 1, 'apagar');
    assert.deepEqual(nomes(), ['Biojoias']);
    limpar();
  });

  test('editar no modal: não há campo de endereço e o update não envia o endereço', async () => {
    let enviado = null;
    const { ctx } = criarCtx({
      responder: (c) => {
        if (operacao(c) === 'update') {
          enviado = passo(c, 'update')[1];
          return { data: { ...dados()[0], ...enviado } };
        }
        return { data: dados() };
      },
    });
    const limpar = await categorias.renderizar(ctx);
    botaoPorRotulo(ctx.raiz, 'Editar Body Splash').click();
    await esperar(() => dialogo(), 'modal');
    assert.equal(dialogo().querySelector('[name="nome"]').value, 'Body Splash');
    assert.equal(dialogo().querySelector('[name="slug"]'), null);
    digitar(dialogo().querySelector('[name="nome"]'), 'Body Splash Novo');
    botaoPorTexto(dialogo(), 'Salvar').click();
    await esperar(() => enviado, 'update');
    assert.deepEqual(enviado, { nome: 'Body Splash Novo', descricao: 'Perfumes', ativo: true });
    limpar();
  });
});
