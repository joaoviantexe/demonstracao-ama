// Testes dos módulos do navegador da loja (public/js/loja/): funções puras, carrinho com
// localStorage falso, configuração e chamadas às APIs com fetch simulado.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import * as formatos from '../../public/js/loja/formatos.js';
import * as produtos from '../../public/js/loja/produtos.js';
import * as carrinho from '../../public/js/loja/carrinho.js';
import * as config from '../../public/js/loja/config.js';
import * as api from '../../public/js/loja/api.js';
import { opcaoEscolhida, totalExibido } from '../../public/js/loja/resumo.js';
import * as servidor from '../../lib/validacao.js';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ---------------------------------------------------------------------------
// Ambiente de navegador mínimo: localStorage falso e eventos em globalThis.

class ArmazenamentoFalso {
  constructor() { this.dados = new Map(); this.quebrado = false; }
  getItem(chave) { return this.dados.has(chave) ? this.dados.get(chave) : null; }
  setItem(chave, valor) {
    if (this.quebrado) throw new Error('QuotaExceededError');
    this.dados.set(chave, String(valor));
  }
  removeItem(chave) { this.dados.delete(chave); }
  clear() { this.dados.clear(); }
}

let armazenamento;
let alvo;
let eventos;

function prepararNavegador() {
  armazenamento = new ArmazenamentoFalso();
  alvo = new EventTarget();
  eventos = [];
  globalThis.localStorage = armazenamento;
  globalThis.addEventListener = alvo.addEventListener.bind(alvo);
  globalThis.removeEventListener = alvo.removeEventListener.bind(alvo);
  globalThis.dispatchEvent = alvo.dispatchEvent.bind(alvo);
  alvo.addEventListener(carrinho.EVENTO, (e) => eventos.push(e.detail.itens));
}

function desfazerNavegador() {
  delete globalThis.localStorage;
  delete globalThis.addEventListener;
  delete globalThis.removeEventListener;
  delete globalThis.dispatchEvent;
}

// ---------------------------------------------------------------------------

describe('formatos: preço', () => {
  test('centavos em reais com milhar e vírgula', () => {
    assert.equal(formatos.formatarPreco(5990), 'R$ 59,90');
    assert.equal(formatos.formatarPreco(5), 'R$ 0,05');
    assert.equal(formatos.formatarPreco(100), 'R$ 1,00');
    assert.equal(formatos.formatarPreco(123456789), 'R$ 1.234.567,89');
    assert.equal(formatos.formatarPreco(-1198), '-R$ 11,98');
    assert.equal(formatos.formatarPreco('2490'), 'R$ 24,90');
  });

  test('zero: "R$ 0,00" por padrão e "R$ 00,00" só quando pedido', () => {
    assert.equal(formatos.formatarPreco(0), 'R$ 0,00');
    assert.equal(formatos.formatarPreco(0, { zeroComoEmProducao: true }), 'R$ 00,00');
    assert.equal(formatos.formatarPreco(5990, { zeroComoEmProducao: true }), 'R$ 59,90');
    assert.equal(formatos.formatarPreco(NaN), 'R$ 0,00');
    assert.equal(formatos.formatarPreco(undefined, { zeroComoEmProducao: true }), 'R$ 00,00');
  });
});

describe('formatos: máscaras', () => {
  test('CEP progressivo', () => {
    assert.equal(formatos.mascararCep('66'), '66');
    assert.equal(formatos.mascararCep('66010'), '66010');
    assert.equal(formatos.mascararCep('660100'), '66010-0');
    assert.equal(formatos.mascararCep('66010-000'), '66010-000');
    assert.equal(formatos.mascararCep('66010000123'), '66010-000');
  });

  test('CPF progressivo', () => {
    assert.equal(formatos.mascararCpf('529'), '529');
    assert.equal(formatos.mascararCpf('5299'), '529.9');
    assert.equal(formatos.mascararCpf('5299822'), '529.982.2');
    assert.equal(formatos.mascararCpf('5299822472'), '529.982.247-2');
    assert.equal(formatos.mascararCpf('529.982.247-25'), '529.982.247-25');
    assert.equal(formatos.mascararCpf('52998224725999'), '529.982.247-25');
  });

  test('telefone fixo e celular', () => {
    assert.equal(formatos.mascararTelefone(''), '');
    assert.equal(formatos.mascararTelefone('9'), '(9');
    assert.equal(formatos.mascararTelefone('919'), '(91) 9');
    assert.equal(formatos.mascararTelefone('9132221234'), '(91) 3222-1234');
    assert.equal(formatos.mascararTelefone('91981056049'), '(91) 98105-6049');
    assert.equal(formatos.mascararTelefone('(91) 98105-6049 ramal'), '(91) 98105-6049');
  });

  test('WhatsApp da configuração para exibição', () => {
    assert.equal(formatos.formatarWhatsapp('5591981056049'), '(91) 98105-6049');
    assert.equal(formatos.formatarWhatsapp('91981056049'), '(91) 98105-6049');
    assert.equal(formatos.formatarWhatsapp('123'), '123');
  });
});

describe('formatos: validações iguais às do servidor', () => {
  const cpfs = ['52998224725', '529.982.247-25', '111.111.111-11', '12345678900', '', '5299822472', '00000000000', '39053344705'];
  const emails = ['maria@exemplo.com.br', ' MARIA@EXEMPLO.COM ', 'maria@exemplo', 'a..b@x.com', '.a@x.com', 'a@x.c', `${'a'.repeat(65)}@x.com`, 'maria silva@x.com', ''];
  const telefones = ['91981056049', '9132221234', '(91) 8105-6049', '91881056049', '0198105604', '919810560', ''];
  const ceps = ['66010-000', '66010000', '00000000', '6601000', ''];
  const nomes = ['Maria da Silva', 'Maria', '  Ana   Paula  ', 'A B', '123 456', 'José Ávila'];

  test('CPF, e-mail, telefone, CEP, nome e UF', () => {
    for (const v of cpfs) assert.equal(formatos.validarCpf(v), servidor.validarCpf(v), `cpf ${v}`);
    for (const v of emails) assert.equal(formatos.validarEmail(v), servidor.validarEmail(v), `email ${v}`);
    for (const v of telefones) assert.equal(formatos.validarTelefone(v), servidor.validarTelefone(v), `telefone ${v}`);
    for (const v of ceps) assert.equal(formatos.validarCep(v), servidor.validarCep(v), `cep ${v}`);
    for (const v of nomes) assert.equal(formatos.validarNomeCompleto(v), servidor.validarNomeCompleto(v), `nome ${v}`);
    for (const v of ['PA', 'pa', 'XX', '']) assert.equal(formatos.validarUf(v), servidor.validarUf(v), `uf ${v}`);
    assert.deepEqual([...formatos.UFS], [...servidor.UFS]);
    assert.equal(formatos.validarCpf('52998224725'), true);
    assert.equal(formatos.validarCpf('11111111111'), false);
  });

  test('normalizarTexto igual ao do servidor', () => {
    const entradas = ['  a   b  ', 'linha 1\r\n\r\n\r\nlinha 2', 'zero\u200blargura', 'bidi\u202etexto', 'x'.repeat(300), 42, null];
    for (const t of entradas) {
      assert.equal(formatos.normalizarTexto(t), servidor.normalizarTexto(t));
      assert.equal(formatos.normalizarTexto(t, 500, { multilinha: true }), servidor.normalizarTexto(t, 500, { multilinha: true }));
    }
  });

  test('formulário do checkout: mesmas chaves e mensagens de validarDadosCheckout', () => {
    const casos = [
      { cliente: {}, endereco: {}, frete_id: '' },
      { cliente: { nome: 'Maria', email: 'x', telefone: '123', cpf: '111' }, endereco: { cep: '1' }, frete_id: 'me-1' },
      { cliente: { nome: 'Maria da Silva', email: 'maria@exemplo.com', telefone: '91981056049', cpf: '52998224725' }, endereco: {}, frete_id: 'retirada' },
      {
        cliente: { nome: 'Maria da Silva', email: 'maria@exemplo.com', telefone: '91981056049', cpf: '529.982.247-25' },
        endereco: { cep: '66010-000', logradouro: 'Av. Presidente Vargas', numero: '123', complemento: 'x'.repeat(101), bairro: 'Campina', cidade: 'Belém', uf: 'pa' },
        frete_id: 'me-1',
      },
      {
        cliente: { nome: 'M'.repeat(121), email: 'maria@exemplo.com', telefone: '91981056049', cpf: '52998224725' },
        endereco: { cep: '66010000', logradouro: 'Rua', numero: '1', bairro: 'B', cidade: 'C', uf: 'XX' },
        frete_id: 'fixo-1',
      },
    ];
    for (const caso of casos) {
      const doCliente = formatos.validarFormularioCheckout(caso).erros;
      const doServidor = servidor.validarDadosCheckout({ ...caso, itens: [{ produto_id: ID_A, quantidade: 1 }] }).erros;
      assert.deepEqual(doCliente, doServidor, JSON.stringify(caso).slice(0, 80));
    }
    const ok = formatos.validarFormularioCheckout(casos[2]);
    assert.equal(ok.ok, true);
  });
});

describe('formatos: segurança e utilidades', () => {
  test('escaparHtml', () => {
    assert.equal(formatos.escaparHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    assert.equal(formatos.escaparHtml("a & b ' `"), 'a &amp; b &#39; &#96;');
    assert.equal(formatos.escaparHtml(null), '');
  });

  test('urlSegura: só caminho relativo à raiz ou http(s)', () => {
    assert.equal(formatos.urlSegura('/img/produtos/x.jpg'), '/img/produtos/x.jpg');
    assert.equal(formatos.urlSegura('https://exemplo.supabase.co/storage/v1/object/public/midia/a.jpg'),
      'https://exemplo.supabase.co/storage/v1/object/public/midia/a.jpg');
    assert.equal(formatos.urlSegura('http://127.0.0.1:3000/pagar/1'), 'http://127.0.0.1:3000/pagar/1');
    for (const ruim of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:image/svg+xml,<svg>', '//evil.com/x.jpg', '/\\evil.com',
      'img/x.jpg', '', ' ', '/img/a b.jpg', 'vbscript:x', 'https://a.com/\u0000', null, 42]) {
      assert.equal(formatos.urlSegura(ruim), '', String(ruim));
    }
    assert.equal(formatos.urlSegura('/img/x.jpg', { permitirRelativa: false }), '');
  });

  test('slugify, normalizarBusca e validarSlug', () => {
    assert.equal(formatos.slugify('Creme Hidratante Cupuaçu'), 'creme-hidratante-cupuacu');
    assert.equal(formatos.slugify('  Barbatimão & Andiroba!! '), 'barbatimao-andiroba');
    assert.equal(formatos.slugify(''), '');
    assert.equal(formatos.normalizarBusca('  SABONETE   Íntimo '), 'sabonete intimo');
    assert.equal(formatos.validarSlug('body-splash-raiz'), true);
    for (const ruim of ['Body', 'a--b', '-a', 'a b', '', 'x'.repeat(121), null]) assert.equal(formatos.validarSlug(ruim), false);
  });

  test('linkWhatsapp', () => {
    assert.equal(formatos.linkWhatsapp('5591981056049'), 'https://wa.me/5591981056049');
    assert.equal(formatos.linkWhatsapp('+55 (91) 98105-6049', 'Olá, AMA! Quero: Body Splash & Creme'),
      'https://wa.me/5591981056049?text=Ol%C3%A1%2C%20AMA!%20Quero%3A%20Body%20Splash%20%26%20Creme');
    assert.equal(formatos.linkWhatsapp('123'), '');
  });

  test('prazo, motivo, pedido e plural', () => {
    assert.equal(formatos.formatarPrazo({ prazo_texto: 'até 7 dias úteis', prazo_dias: 7 }), 'até 7 dias úteis');
    assert.equal(formatos.formatarPrazo({ prazo_dias: 1 }), 'até 1 dia útil');
    assert.equal(formatos.formatarPrazo({ prazo_dias: 5 }), 'até 5 dias úteis');
    assert.equal(formatos.formatarPrazo({ prazo_dias: null }), '');
    assert.match(formatos.descreverMotivo('estoque_insuficiente', 3), /3 unidades/);
    assert.match(formatos.descreverMotivo('estoque_insuficiente', 1), /1 unidade /);
    assert.match(formatos.descreverMotivo('sem_preco'), /preço deste produto ainda não foi definido/);
    for (const m of ['inexistente', 'inativo', 'sem_estoque', 'outro']) assert.ok(formatos.descreverMotivo(m));
    assert.equal(formatos.descreverMotivo(null), '');
    assert.equal(formatos.formatarNumeroPedido(1001), '#1001');
    assert.equal(formatos.formatarNumeroPedido('x'), '');
    assert.equal(formatos.pluralizar(1, 'item', 'itens'), '1 item');
    assert.equal(formatos.pluralizar(3, 'item', 'itens'), '3 itens');
    assert.match(formatos.formatarData('2026-10-15T14:32:00Z'), /^\d{2}\/\d{2}\/2026 às \d{2}:\d{2}$/);
    assert.equal(formatos.formatarData('inválida'), '');
  });
});

// ---------------------------------------------------------------------------

function produtoBruto(extra = {}) {
  return {
    id: ID_A,
    nome: 'Body Splash Raiz',
    slug: 'body-splash-raiz',
    descricao: 'Frasco de 200 mL.',
    preco_centavos: 5990,
    preco_promocional_centavos: null,
    estoque: 10,
    controlar_estoque: true,
    imagens: [{ src: '/img/produtos/body-splash-raiz.jpg', alt: 'Frasco' }],
    destaque: true,
    categoria_id: 'c1',
    categorias: { nome: 'Body Splash', slug: 'body-splash' },
    ...extra,
  };
}

describe('produtos: regras da vitrine', () => {
  test('normalizarProduto descarta imagens perigosas e garante os tipos', () => {
    const p = produtos.normalizarProduto(produtoBruto({
      imagens: [{ src: 'javascript:alert(1)', alt: 'x' }, { src: '/img/a.jpg', alt: 7 }, 'texto', null],
      preco_promocional_centavos: 9000,
      estoque: -3,
    }));
    assert.deepEqual(p.imagens, [{ src: '/img/a.jpg', alt: '' }]);
    assert.equal(p.preco_promocional_centavos, null, 'promoção maior que o preço é ignorada');
    assert.equal(p.estoque, 0);
    assert.deepEqual(p.categoria, { nome: 'Body Splash', slug: 'body-splash' });
    assert.equal(produtos.normalizarProduto({ nome: 'sem id' }), null);
    assert.equal(produtos.normalizarProduto(null), null);
  });

  test('analisarProduto: normal, promoção, em breve, esgotado e sem controle de estoque', () => {
    const normal = produtos.analisarProduto(produtos.normalizarProduto(produtoBruto()));
    assert.deepEqual(normal, {
      preco: 5990, precoOriginal: null, promocao: false, semPreco: false, esgotado: false, vendavel: true, maxQuantidade: 10, descontoPercentual: 0,
    });
    const promo = produtos.analisarProduto(produtos.normalizarProduto(produtoBruto({ preco_centavos: 6990, preco_promocional_centavos: 5990 })));
    assert.equal(promo.promocao, true);
    assert.equal(promo.preco, 5990);
    assert.equal(promo.precoOriginal, 6990);
    assert.equal(promo.descontoPercentual, 14);
    // Sem preço: aparece como um produto normal da vitrine (versão final), com "R$ 00,00";
    // quem recusa a compra é o servidor (motivo 'sem_preco').
    const semPreco = produtos.analisarProduto(produtos.normalizarProduto(produtoBruto({ preco_centavos: 0, estoque: 0 })));
    assert.equal(semPreco.semPreco, true);
    assert.equal(semPreco.esgotado, false, 'sem preço não aparece como "Esgotado"');
    assert.equal(semPreco.vendavel, true);
    assert.equal(semPreco.maxQuantidade, 99);
    assert.equal(formatos.formatarPreco(semPreco.preco, { zeroComoEmProducao: true }), 'R$ 00,00');
    const esgotado = produtos.analisarProduto(produtos.normalizarProduto(produtoBruto({ estoque: 0 })));
    assert.equal(esgotado.esgotado, true);
    assert.equal(esgotado.vendavel, false);
    const livre = produtos.analisarProduto(produtos.normalizarProduto(produtoBruto({ estoque: 0, controlar_estoque: false })));
    assert.equal(livre.vendavel, true);
    assert.equal(livre.maxQuantidade, 99);
    const muito = produtos.analisarProduto(produtos.normalizarProduto(produtoBruto({ estoque: 500 })));
    assert.equal(muito.maxQuantidade, 99);
  });

  const lista = [
    produtoBruto({ id: uuid(1), nome: 'Body Splash Raiz', slug: 'raiz', preco_centavos: 5990 }),
    produtoBruto({ id: uuid(2), nome: 'Nome em Produção', slug: 'biojoia-01', preco_centavos: 0, categorias: { nome: 'Biojoias', slug: 'biojoias' } }),
    produtoBruto({ id: uuid(3), nome: 'Sabonete Sólido Cupuaçu', slug: 'sabonete', preco_centavos: 2490, categorias: { nome: 'Sabonete Sólido', slug: 'sabonete-solido' } }),
    produtoBruto({ id: uuid(4), nome: 'Creme Âmbar', slug: 'creme', preco_centavos: 6990, preco_promocional_centavos: 5000, descricao: 'Hidratação intensa' }),
  ].map(produtos.normalizarProduto);

  test('filtrarProdutos: categoria e busca sem acentos', () => {
    assert.deepEqual(produtos.filtrarProdutos(lista, { categoria: 'biojoias' }).map((p) => p.slug), ['biojoia-01']);
    assert.deepEqual(produtos.filtrarProdutos(lista, { busca: 'SABONETE cupuacu' }).map((p) => p.slug), ['sabonete']);
    assert.deepEqual(produtos.filtrarProdutos(lista, { busca: 'hidratacao' }).map((p) => p.slug), ['creme']);
    assert.deepEqual(produtos.filtrarProdutos(lista, { busca: 'body splash' }).map((p) => p.slug), ['raiz', 'creme']);
    assert.equal(produtos.filtrarProdutos(lista, {}).length, 4);
    assert.equal(produtos.filtrarProdutos(lista, { busca: 'inexistente' }).length, 0);
  });

  test('ordenarProdutos: preço efetivo, sem preço por último, nome e ordem original', () => {
    const slugs = (criterio) => produtos.ordenarProdutos(lista, criterio).map((p) => p.slug);
    assert.deepEqual(slugs('destaques'), ['raiz', 'biojoia-01', 'sabonete', 'creme']);
    assert.deepEqual(slugs('menor-preco'), ['sabonete', 'creme', 'raiz', 'biojoia-01']);
    assert.deepEqual(slugs('maior-preco'), ['raiz', 'creme', 'sabonete', 'biojoia-01']);
    assert.deepEqual(slugs('nome'), ['raiz', 'creme', 'biojoia-01', 'sabonete']);
    assert.deepEqual(slugs('qualquer'), slugs('destaques'));
    assert.equal(produtos.lerOrdenacao('maior-preco'), 'maior-preco');
    assert.equal(produtos.lerOrdenacao('<script>'), 'destaques');
  });

  test('categoriasComProdutos: só as que têm produtos, com a contagem', () => {
    const categorias = [
      { nome: 'Body Splash', slug: 'body-splash' }, { nome: 'Vazia', slug: 'vazia' },
      { nome: 'Biojoias', slug: 'biojoias' },
    ];
    assert.deepEqual(produtos.categoriasComProdutos(categorias, lista), [
      { nome: 'Body Splash', slug: 'body-splash', total: 2 },
      { nome: 'Biojoias', slug: 'biojoias', total: 1 },
      { nome: 'Sabonete Sólido', slug: 'sabonete-solido', total: 1 },
    ]);
  });

});

// ---------------------------------------------------------------------------

describe('carrinho (localStorage falso)', () => {
  beforeEach(prepararNavegador);
  afterEach(desfazerNavegador);

  const produto = (id, extra = {}) => ({ id, nome: 'Produto', slug: 'produto', preco_centavos: 1000, imagem: '/img/p.jpg', ...extra });

  test('adiciona, soma a mesma linha e emite carrinho:mudou', () => {
    assert.deepEqual(carrinho.lerCarrinho(), []);
    const r1 = carrinho.adicionarAoCarrinho(produto(ID_A), 2);
    assert.deepEqual(r1, { ok: true, quantidade: 2, limitado: false, motivo: null });
    carrinho.adicionarAoCarrinho(produto(ID_A), 1);
    carrinho.adicionarAoCarrinho(produto(ID_B, { nome: 'Outro' }), 1);
    const itens = carrinho.lerCarrinho();
    assert.equal(itens.length, 2);
    assert.equal(itens[0].quantidade, 3);
    assert.equal(carrinho.contarUnidades(), 4);
    assert.equal(eventos.length, 3);
    assert.equal(eventos.at(-1).length, 2);
    assert.deepEqual(JSON.parse(armazenamento.getItem(carrinho.CHAVE_CARRINHO))[1], {
      produto_id: ID_B, quantidade: 1, nome: 'Outro', preco_centavos: 1000, imagem: '/img/p.jpg', slug: 'produto',
    });
  });

  test('limite de 99 por item, do estoque e de 30 linhas', () => {
    let r = carrinho.adicionarAoCarrinho(produto(ID_A), 150);
    assert.equal(r.quantidade, 99);
    assert.equal(r.limitado, true);
    r = carrinho.adicionarAoCarrinho(produto(ID_A), 1);
    assert.deepEqual(r, { ok: false, quantidade: 99, limitado: true, motivo: 'maximo' });
    carrinho.limparCarrinho();
    r = carrinho.adicionarAoCarrinho(produto(ID_A), 5, { maximo: 3 });
    assert.equal(r.quantidade, 3);
    r = carrinho.adicionarAoCarrinho(produto(ID_A), 1, { maximo: 3 });
    assert.equal(r.motivo, 'maximo');
    assert.equal(carrinho.adicionarAoCarrinho(produto(ID_B), 1, { maximo: 0 }).ok, false);
    carrinho.limparCarrinho();
    for (let i = 1; i <= 30; i += 1) assert.equal(carrinho.adicionarAoCarrinho(produto(uuid(i)), 1).ok, true);
    assert.deepEqual(carrinho.adicionarAoCarrinho(produto(uuid(31)), 1), { ok: false, quantidade: 0, limitado: true, motivo: 'limite_linhas' });
    assert.equal(carrinho.adicionarAoCarrinho(produto(uuid(5)), 1).ok, true, 'linha existente continua aceitando');
    assert.equal(carrinho.lerCarrinho().length, 30);
  });

  test('entradas inválidas são recusadas', () => {
    assert.equal(carrinho.adicionarAoCarrinho(produto('nao-e-uuid'), 1).motivo, 'invalido');
    assert.equal(carrinho.adicionarAoCarrinho(produto(ID_A), 0).motivo, 'invalido');
    assert.equal(carrinho.adicionarAoCarrinho(produto(ID_A), 1.5).motivo, 'invalido');
    assert.equal(carrinho.adicionarAoCarrinho(null, 1).motivo, 'invalido');
    assert.deepEqual(carrinho.lerCarrinho(), []);
  });

  test('definirQuantidade, removerDoCarrinho e itensParaCotacao (sem preço)', () => {
    carrinho.adicionarAoCarrinho(produto(ID_A), 2);
    carrinho.adicionarAoCarrinho(produto(ID_B), 1);
    assert.equal(carrinho.definirQuantidade(ID_A, 5), 5);
    assert.equal(carrinho.definirQuantidade(ID_A, 500), 99);
    assert.equal(carrinho.definirQuantidade(ID_A.toUpperCase(), 7), 7);
    assert.deepEqual(carrinho.itensParaCotacao(), [{ produto_id: ID_A, quantidade: 7 }, { produto_id: ID_B, quantidade: 1 }]);
    assert.equal(carrinho.definirQuantidade(ID_B, 0), 0);
    assert.deepEqual(carrinho.lerCarrinho().map((i) => i.produto_id), [ID_A]);
    carrinho.removerDoCarrinho(ID_A);
    assert.deepEqual(carrinho.lerCarrinho(), []);
    assert.equal(carrinho.definirQuantidade(ID_A, 3), 0, 'produto fora do carrinho não é criado');
  });

  test('dados corrompidos no localStorage não quebram a loja', () => {
    armazenamento.setItem(carrinho.CHAVE_CARRINHO, '{isso não é json');
    assert.deepEqual(carrinho.lerCarrinho(), []);
    armazenamento.setItem(carrinho.CHAVE_CARRINHO, JSON.stringify([
      { produto_id: ID_A, quantidade: 2, nome: 'A', preco_centavos: 10, imagem: 'javascript:alert(1)', slug: '../x' },
      { produto_id: ID_A, quantidade: 98 },
      { produto_id: 'x', quantidade: 1 },
      { produto_id: ID_B, quantidade: -1 },
      { produto_id: ID_B, quantidade: '2' },
      null,
    ]));
    assert.deepEqual(carrinho.lerCarrinho(), [
      { produto_id: ID_A, quantidade: 99, nome: 'A', preco_centavos: 10, imagem: '', slug: '' },
      { produto_id: ID_B, quantidade: 2, nome: '', preco_centavos: 0, imagem: '', slug: '' },
    ]);
  });

  test('sem localStorage (ou cheio) o carrinho vive na memória da página', () => {
    armazenamento.quebrado = true;
    carrinho.adicionarAoCarrinho(produto(ID_A), 2);
    assert.equal(carrinho.lerCarrinho().length, 0, 'o localStorage existe mas recusa gravar: leitura vem dele');
    delete globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
    carrinho.limparCarrinho();
    carrinho.adicionarAoCarrinho(produto(ID_B), 3);
    assert.deepEqual(carrinho.itensParaCotacao(), [{ produto_id: ID_B, quantidade: 3 }]);
    delete globalThis.localStorage;
  });

  test('sincronizarComCotacao atualiza nome, preço e imagem só quando mudam', () => {
    carrinho.adicionarAoCarrinho(produto(ID_A, { nome: 'Antigo', preco_centavos: 100 }), 2);
    carrinho.adicionarAoCarrinho(produto(ID_B), 1);
    const antes = eventos.length;
    carrinho.sincronizarComCotacao([
      { produto_id: ID_A, nome: 'Novo nome', slug: 'novo', imagem: '/img/novo.jpg', preco_unitario_centavos: 5990, quantidade: 2 },
      { produto_id: ID_B, nome: null, slug: null, imagem: null, preco_unitario_centavos: 0, motivo: 'inexistente' },
    ]);
    const [a, b] = carrinho.lerCarrinho();
    assert.deepEqual(a, { produto_id: ID_A, quantidade: 2, nome: 'Novo nome', preco_centavos: 5990, imagem: '/img/novo.jpg', slug: 'novo' });
    assert.equal(b.nome, 'Produto', 'item inexistente mantém o que estava guardado');
    assert.equal(eventos.length, antes + 1);
    carrinho.sincronizarComCotacao([{ produto_id: ID_A, nome: 'Novo nome', slug: 'novo', imagem: '/img/novo.jpg', preco_unitario_centavos: 5990 }]);
    assert.equal(eventos.length, antes + 1, 'sem mudança não grava nem emite');
  });

  test('outra aba mudou o carrinho: evento storage vira carrinho:mudou', () => {
    carrinho.iniciarSincronizacaoAbas();
    armazenamento.setItem(carrinho.CHAVE_CARRINHO, JSON.stringify([{ produto_id: ID_A, quantidade: 4 }]));
    const evento = new Event('storage');
    Object.defineProperty(evento, 'key', { value: carrinho.CHAVE_CARRINHO });
    globalThis.dispatchEvent(evento);
    assert.equal(eventos.at(-1)[0].quantidade, 4);
  });

  test('preferências (CEP, frete) validadas', () => {
    assert.deepEqual(carrinho.lerPreferencias(), { cep: '', frete_id: '' });
    carrinho.salvarPreferencias({ cep: '66010000', frete_id: 'fixo-1' });
    carrinho.salvarPreferencias({ frete_id: 'me-1' });
    assert.deepEqual(carrinho.lerPreferencias(), { cep: '66010000', frete_id: 'me-1' });
    // Preferência antiga com cupom: o campo é ignorado.
    armazenamento.setItem(carrinho.CHAVE_PREFERENCIAS, JSON.stringify({ cep: '66010000', cupom: 'AMA10', frete_id: 'me-1' }));
    assert.deepEqual(carrinho.lerPreferencias(), { cep: '66010000', frete_id: 'me-1' });
    armazenamento.setItem(carrinho.CHAVE_PREFERENCIAS, JSON.stringify({ cep: '660', frete_id: 'a b' }));
    assert.deepEqual(carrinho.lerPreferencias(), { cep: '', frete_id: '' });
  });

  test('pedidos guardados neste aparelho (ama_pedidos_v1)', () => {
    const token = 'a'.repeat(64);
    assert.deepEqual(carrinho.lerPedidosGuardados(), []);
    carrinho.guardarPedido({ id: ID_A, token, numero: 1001, criado_em: '2026-10-15T10:00:00Z' });
    carrinho.guardarPedido({ id: ID_B, token, numero: 1002, criado_em: '2026-10-15T11:00:00Z' });
    carrinho.guardarPedido({ id: ID_A, token, numero: 1001 });
    carrinho.guardarPedido({ id: 'x', token });
    carrinho.guardarPedido({ id: uuid(9), token: 'curto' });
    const lista = carrinho.lerPedidosGuardados();
    assert.deepEqual(lista.map((p) => p.numero), [1002, 1001], 'novo no topo; atualizar não reordena');
    assert.equal(lista[1].criado_em, '2026-10-15T10:00:00Z');
    for (let i = 1; i <= 25; i += 1) carrinho.guardarPedido({ id: uuid(100 + i), token, numero: 2000 + i });
    assert.equal(carrinho.lerPedidosGuardados().length, carrinho.MAX_PEDIDOS);
    assert.equal(carrinho.lerPedidosGuardados()[0].numero, 2025);
  });
});

// ---------------------------------------------------------------------------

describe('config e APIs (fetch simulado)', () => {
  let fetchOriginal;
  let chamadas;

  function simularFetch(responder) {
    chamadas = [];
    globalThis.fetch = async (url, init = {}) => {
      chamadas.push({ url: String(url), init });
      return responder(String(url), init);
    };
  }

  beforeEach(() => {
    fetchOriginal = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = fetchOriginal;
    delete globalThis.AMA_CONFIG;
  });

  test('obterConfig: só configurado com URL http(s) e chave', () => {
    assert.deepEqual(config.obterConfig(), { supabaseUrl: '', supabaseAnonKey: '', configurado: false });
    globalThis.AMA_CONFIG = { supabaseUrl: 'https://x.supabase.co/', supabaseAnonKey: 'sb_publishable_x', configurado: true };
    assert.deepEqual(config.obterConfig(), { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'sb_publishable_x', configurado: true });
    globalThis.AMA_CONFIG = { supabaseUrl: 'javascript:alert(1)', supabaseAnonKey: 'k', configurado: true };
    assert.equal(config.lojaConfigurada(), false);
    globalThis.AMA_CONFIG = { supabaseUrl: '', supabaseAnonKey: '', configurado: false };
    assert.equal(config.lojaConfigurada(), false);
  });

  test('restGet manda a apikey (sem Authorization) e trata erros', async () => {
    await assert.rejects(config.restGet('produtos'), (e) => e.tipo === 'nao_configurado');
    globalThis.AMA_CONFIG = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'chave-publica', configurado: true };
    simularFetch(() => new Response(JSON.stringify([{ id: 1 }]), { status: 200 }));
    assert.deepEqual(await config.restGet(config.CONSULTAS.categorias), [{ id: 1 }]);
    assert.equal(chamadas[0].url, 'https://x.supabase.co/rest/v1/categorias?select=id,nome,slug&ativo=eq.true&order=ordem.asc');
    assert.equal(chamadas[0].init.headers.apikey, 'chave-publica');
    assert.equal(chamadas[0].init.headers.Authorization, undefined);
    simularFetch(() => new Response('{"message":"x"}', { status: 401 }));
    await assert.rejects(config.restGet('produtos'), (e) => e.tipo === 'http' && e.status === 401);
    simularFetch(() => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(config.restGet('produtos'), (e) => e.tipo === 'rede');
  });

  test('buscarProdutoPorSlug valida o slug antes de consultar', async () => {
    globalThis.AMA_CONFIG = { supabaseUrl: 'https://x.supabase.co', supabaseAnonKey: 'k', configurado: true };
    simularFetch(() => new Response('[]', { status: 200 }));
    assert.equal(await config.buscarProdutoPorSlug('../produtos?select=*'), null);
    assert.equal(chamadas.length, 0);
    assert.equal(await config.buscarProdutoPorSlug('body-splash-raiz'), null);
    assert.match(chamadas[0].url, /slug=eq\.body-splash-raiz&limit=1$/);
    assert.match(chamadas[0].url, /ativo=eq\.true/);
  });

  test('normalizarConfigLoja aplica padrões e limpa os campos', () => {
    const cfg = config.normalizarConfigLoja({
      titulo: '  Loja da AMA  ', whatsapp: '+55 (91) 98105-6049', instagram: '@osc de<mulheres>',
      frete_gratis_acima_centavos: 20000, aviso_topo: 'Frete grátis!',
    });
    assert.equal(cfg.titulo, 'Loja da AMA');
    assert.equal(cfg.whatsapp, '5591981056049');
    assert.equal(cfg.instagram, 'oscdemulheres');
    assert.equal(cfg.frete_gratis_acima_centavos, 20000);
    assert.equal(cfg.aviso_topo, 'Frete grátis!');
    const padrao = config.normalizarConfigLoja(null);
    assert.equal(padrao.titulo, 'Cosméticos');
    assert.equal(padrao.whatsapp, '5591981056049');
    assert.equal(padrao.frete_gratis_acima_centavos, null);
    assert.equal(config.normalizarConfigLoja({ frete_gratis_acima_centavos: -5 }).frete_gratis_acima_centavos, null);
  });

  test('cotar envia só produto, quantidade e CEP', async () => {
    simularFetch(() => new Response(JSON.stringify({ ok: true, itens: [], subtotal_centavos: 0 }), { status: 200 }));
    const r = await api.cotar({ itens: [{ produto_id: ID_A, quantidade: 2 }], cep: '66010000', cupom: 'AMA10' });
    assert.equal(r.ok, true);
    assert.equal(chamadas[0].url, '/api/loja/cotacao');
    assert.equal(chamadas[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(chamadas[0].init.body), { itens: [{ produto_id: ID_A, quantidade: 2 }], cep: '66010000' });
    await api.cotar({ itens: [{ produto_id: ID_A, quantidade: 1 }] });
    assert.deepEqual(JSON.parse(chamadas[1].init.body), { itens: [{ produto_id: ID_A, quantidade: 1 }] });
  });

  test('erros normalizados: status, código, mensagem e dados extras', async () => {
    simularFetch(() => new Response(JSON.stringify({
      ok: false, erro: 'item_indisponivel', mensagem: 'Alguns itens mudaram.', itens: [{ produto_id: ID_A }],
    }), { status: 409 }));
    await assert.rejects(api.finalizar({}), (e) => e instanceof api.ErroApi && e.status === 409
      && e.erro === 'item_indisponivel' && e.mensagem === 'Alguns itens mudaram.' && e.dados.itens.length === 1);
    simularFetch(() => new Response('<html>erro</html>', { status: 502 }));
    await assert.rejects(api.finalizar({}), (e) => e.status === 502 && e.erro === 'http_502' && /serviço externo/.test(e.mensagem));
    simularFetch(() => { throw new TypeError('Failed to fetch'); });
    await assert.rejects(api.cotar({ itens: [] }), (e) => e.status === 0 && e.erro === 'rede');
    simularFetch(() => new Response(JSON.stringify({ ok: false, erro: 'pagamento_indisponivel', mensagem: 'Em configuração' }), { status: 503 }));
    await assert.rejects(api.finalizar({}), (e) => e.status === 503 && e.erro === 'pagamento_indisponivel');
  });

  test('consultarPedido monta a URL com payment_id opcional', async () => {
    simularFetch(() => new Response(JSON.stringify({ ok: true, pedido: { numero: 1001 } }), { status: 200 }));
    await api.consultarPedido({ id: ID_A, token: 'abc', paymentId: '123' });
    await api.consultarPedido({ id: ID_A, token: 'a&b=c' });
    assert.equal(chamadas[0].url, `/api/loja/pedido?id=${ID_A}&token=abc&payment_id=123`);
    assert.equal(chamadas[1].url, `/api/loja/pedido?id=${ID_A}&token=a%26b%3Dc`);
  });
});

describe('resumo: total exibido com os números do servidor', () => {
  const cotacao = {
    subtotal_centavos: 17970,
    frete: { opcoes: [{ id: 'me-1', preco_centavos: 2440 }, { id: 'retirada', preco_centavos: 0 }] },
  };

  test('opcaoEscolhida e totalExibido', () => {
    assert.equal(opcaoEscolhida(cotacao, 'me-1').preco_centavos, 2440);
    assert.equal(opcaoEscolhida(cotacao, 'nao-existe'), null);
    assert.equal(opcaoEscolhida(null, 'me-1'), null);
    assert.equal(totalExibido(cotacao, opcaoEscolhida(cotacao, 'me-1')), 20410);
    assert.equal(totalExibido(cotacao, opcaoEscolhida(cotacao, 'retirada')), 17970);
    assert.equal(totalExibido(cotacao, null), 17970);
    assert.equal(totalExibido(null, null), 0);
  });
});
