// Testes da página de pedidos do painel (public/admin/js/paginas/pedidos.js): funções puras da lista
// (filtros, busca segura para o PostgREST, páginas), textos de pagamento, cliente e entrega, próxima ação,
// formulário de situação, regra de apagar e o assistente de envio do Melhor Envio.
// As telas são conferidas no navegador por scripts/capturas-painel-pedidos.mjs.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { STATUS_PEDIDO } from '../../public/admin/js/ui.js';
import * as pedidos from '../../public/admin/js/paginas/pedidos.js';

const {
  ETAPAS_ENVIO, FILTROS_STATUS, TAMANHO_PAGINA, envioDisponivel, errosRastreio, etapasEnvio, filtroDaUrl,
  filtroOuDaBusca, formatarCpf, formatarTelefone, linhasEndereco, linkWhatsapp, nomeEntrega, opcoesDoStatus,
  ordenarEventos, podeApagar, proximaAcao, rotuloAutor, rotuloMetodo, rotuloPagamento, statusDoFiltro, termoBusca,
  totalDePaginas, totalUnidades, ultimoCarrinho, visualEvento,
} = pedidos;

const evento = (id, tipo, dados, criado = `2026-10-15T12:00:${String(id).padStart(2, '0')}Z`) => ({ id, tipo, dados, descricao: tipo, criado_em: criado });
const envio = (id, acao, extra = {}) => evento(id, 'envio', { acao, ...extra });

describe('lista: filtros, busca e páginas', () => {
  test('filtros: todos, para enviar, aguardando e um por status do banco', () => {
    assert.deepEqual(statusDoFiltro(''), null);
    assert.deepEqual(statusDoFiltro('para_enviar'), ['pago', 'em_separacao']);
    assert.deepEqual(statusDoFiltro('aguardando'), ['aguardando_pagamento', 'pagamento_em_analise']);
    for (const s of STATUS_PEDIDO) assert.deepEqual(statusDoFiltro(s), [s], s);
    assert.equal(FILTROS_STATUS.filter((f) => f.individual).length, STATUS_PEDIDO.length);
    assert.equal(new Set(FILTROS_STATUS.map((f) => f.id)).size, FILTROS_STATUS.length, 'ids únicos');
    // statusDoFiltro devolve cópia.
    statusDoFiltro('para_enviar').push('x');
    assert.deepEqual(statusDoFiltro('para_enviar'), ['pago', 'em_separacao']);
  });

  test('filtroDaUrl aceita só ids conhecidos', () => {
    assert.equal(filtroDaUrl('para_enviar'), 'para_enviar');
    assert.equal(filtroDaUrl(' pago '), 'pago');
    for (const ruim of ['', 'qualquer', undefined, null, 42, 'PAGO']) assert.equal(filtroDaUrl(ruim), '', String(ruim));
  });

  test('termoBusca: número do pedido, telefone/CPF e texto sem caracteres que quebram o filtro', () => {
    assert.deepEqual(termoBusca('1042'), { numero: 1042 });
    assert.deepEqual(termoBusca(' #1042 '), { numero: 1042 });
    assert.deepEqual(termoBusca('# 7'), { numero: 7 });
    assert.deepEqual(termoBusca('(91) 98105-6049'), { digitos: '91981056049' });
    assert.deepEqual(termoBusca('+55 91 98105-6049'), { digitos: '91981056049' });
    assert.deepEqual(termoBusca('529.982.247-25'), { digitos: '52998224725' });
    assert.deepEqual(termoBusca('Maria  da Silva'), { texto: 'Maria da Silva' });
    assert.deepEqual(termoBusca('maria@exemplo.com.br'), { texto: 'maria@exemplo.com.br' });
    assert.deepEqual(termoBusca('a,b(c)*d%e"f\'g:h\\i`j'), { texto: 'a b c d e f g h i j' });
    assert.equal(termoBusca(''), null);
    assert.equal(termoBusca('   '), null);
    assert.equal(termoBusca(',,,'), null);
    assert.equal(termoBusca(null), null);
    assert.equal(termoBusca('x'.repeat(200)).texto.length, 80);
    // 10 dígitos ou mais que não são telefone/CPF viram texto; número grande não vira número de pedido.
    assert.deepEqual(termoBusca('1234567890123'), { texto: '1234567890123' });
  });

  test('filtroOuDaBusca: valores entre aspas (o ponto do e-mail é reservado no PostgREST)', () => {
    assert.equal(filtroOuDaBusca({ texto: 'maria@ex.com' }), 'cliente_nome.ilike."*maria@ex.com*",cliente_email.ilike."*maria@ex.com*"');
    assert.equal(filtroOuDaBusca({ digitos: '91981056049' }), 'cliente_telefone.eq.91981056049,cliente_cpf.eq.91981056049');
    assert.equal(filtroOuDaBusca(null), null);
    assert.equal(filtroOuDaBusca({ numero: 1 }), null);
    // Nada que saia das aspas.
    for (const entrada of ['a"),status.eq.pago', 'x\\"y', "a'b", 'a,b']) {
      const filtro = filtroOuDaBusca(termoBusca(entrada));
      assert.equal((filtro.match(/"/g) || []).length, 4, entrada);
    }
  });

  test('totalDePaginas', () => {
    assert.equal(TAMANHO_PAGINA, 20);
    assert.equal(totalDePaginas(0), 1);
    assert.equal(totalDePaginas(null), 1);
    assert.equal(totalDePaginas(20), 1);
    assert.equal(totalDePaginas(21), 2);
    assert.equal(totalDePaginas(41, 10), 5);
  });
});

describe('textos de pagamento, cliente e entrega', () => {
  test('rotuloPagamento e rotuloMetodo', () => {
    assert.equal(rotuloPagamento('approved'), 'Aprovado');
    assert.equal(rotuloPagamento('in_process'), 'Em análise');
    assert.equal(rotuloPagamento('refunded'), 'Devolvido');
    assert.equal(rotuloPagamento(null), 'Sem pagamento ainda');
    assert.equal(rotuloPagamento('novo_status'), 'novo_status');
    assert.equal(rotuloMetodo('bank_transfer'), 'Pix');
    assert.equal(rotuloMetodo('ticket'), 'Boleto');
    assert.equal(rotuloMetodo('credit_card'), 'Cartão de crédito');
    assert.equal(rotuloMetodo(''), '—');
  });

  test('CPF, telefone e link do WhatsApp', () => {
    assert.equal(formatarCpf('52998224725'), '529.982.247-25');
    assert.equal(formatarCpf('123'), '123');
    assert.equal(formatarCpf(null), '');
    assert.equal(formatarTelefone('91981056049'), '(91) 98105-6049');
    assert.equal(formatarTelefone('9132221234'), '(91) 3222-1234');
    assert.equal(formatarTelefone('123'), '123');
    assert.equal(linkWhatsapp('(91) 98105-6049'), 'https://wa.me/5591981056049');
    assert.equal(linkWhatsapp('9132221234'), 'https://wa.me/559132221234');
    assert.equal(linkWhatsapp('123'), null);
    assert.equal(linkWhatsapp(undefined), null);
  });

  test('linhasEndereco', () => {
    assert.deepEqual(linhasEndereco({
      cep: '66010000', logradouro: 'Avenida Presidente Vargas', numero: '100', complemento: 'Apto 12', bairro: 'Campina', cidade: 'Belém', uf: 'pa',
    }), ['Avenida Presidente Vargas, 100 — Apto 12', 'Campina, Belém/PA', 'CEP 66010-000']);
    assert.deepEqual(linhasEndereco({ logradouro: 'Rua A', numero: 'S/N', cidade: 'Ananindeua', uf: 'PA', cep: '1' }), ['Rua A, S/N', 'Ananindeua/PA']);
    assert.deepEqual(linhasEndereco({}), []);
    assert.deepEqual(linhasEndereco(null), []);
  });

  test('nomeEntrega', () => {
    assert.equal(nomeEntrega({ nome: 'PAC', empresa: 'Correios' }), 'PAC (Correios)');
    assert.equal(nomeEntrega({ nome: 'Entrega local', empresa: null }), 'Entrega local');
    assert.equal(nomeEntrega({ nome: 'Correios', empresa: 'Correios' }), 'Correios');
    assert.equal(nomeEntrega(null), 'Entrega');
  });

  test('autor e visual dos eventos', () => {
    assert.equal(rotuloAutor('sistema'), 'Sistema');
    assert.equal(rotuloAutor(''), 'Sistema');
    assert.equal(rotuloAutor('mercadopago'), 'Mercado Pago');
    assert.equal(rotuloAutor('admin@ama.org'), 'admin@ama.org');
    for (const tipo of ['criado', 'pagamento', 'status', 'envio', 'email', 'nota', 'alerta']) {
      assert.ok(visualEvento(tipo).icone, tipo);
    }
    assert.equal(visualEvento('desconhecido').icone, 'info');
  });

  test('ordenarEventos por data e id, sem mudar a lista original', () => {
    const lista = [evento(3, 'b'), evento(1, 'a'), evento(2, 'c', null, '2026-10-15T12:00:01Z')];
    const ordenados = ordenarEventos(lista);
    assert.deepEqual(ordenados.map((e) => e.id), [1, 2, 3]);
    assert.deepEqual(lista.map((e) => e.id), [3, 1, 2]);
    assert.deepEqual(ordenarEventos(null), []);
  });

  test('totalUnidades', () => {
    assert.equal(totalUnidades([{ quantidade: 2 }, { quantidade: 1 }]), 3);
    assert.equal(totalUnidades(null), 0);
  });
});

describe('situação do pedido', () => {
  test('proximaAcao sugere o próximo status na ordem do trabalho', () => {
    assert.equal(proximaAcao({ status: 'aguardando_pagamento' }).conferir, true);
    assert.equal(proximaAcao({ status: 'pagamento_em_analise' }).conferir, true);
    assert.equal(proximaAcao({ status: 'pago' }).proximo, 'em_separacao');
    const separacaoMe = proximaAcao({ status: 'em_separacao', entrega: { tipo: 'melhor_envio' } });
    assert.equal(separacaoMe.proximo, 'enviado');
    assert.match(separacaoMe.texto, /Melhor Envio/);
    assert.doesNotMatch(proximaAcao({ status: 'em_separacao', entrega: { tipo: 'fixo' } }).texto, /Melhor Envio/);
    assert.equal(proximaAcao({ status: 'enviado' }).proximo, 'entregue');
    for (const s of ['entregue', 'cancelado', 'reembolsado']) assert.equal(proximaAcao({ status: s }).proximo, undefined, s);
    assert.equal(proximaAcao({ status: 'entregue' }).tipo, 'sucesso');
    assert.ok(proximaAcao(null).titulo);
  });

  test('opcoesDoStatus: rastreio, e-mail, estoque e avisos', () => {
    const pago = { status: 'pago', pago_em: '2026-10-15T12:00:00Z', estoque_baixado: true };
    const aguardando = { status: 'aguardando_pagamento', pago_em: null, estoque_baixado: false };

    assert.deepEqual(opcoesDoStatus('enviado', pago), { rastreio: true, notificar: true, reporEstoque: false, avisos: [] });
    assert.equal(opcoesDoStatus('entregue', pago).notificar, true);
    assert.equal(opcoesDoStatus('em_separacao', pago).notificar, false);

    const cancelarPago = opcoesDoStatus('cancelado', pago);
    assert.equal(cancelarPago.reporEstoque, true);
    assert.equal(cancelarPago.notificar, true);
    assert.match(cancelarPago.avisos.join(' '), /devolução/);
    assert.equal(opcoesDoStatus('reembolsado', pago).reporEstoque, true);
    assert.equal(opcoesDoStatus('cancelado', aguardando).reporEstoque, false, 'sem estoque baixado não há o que devolver');
    assert.deepEqual(opcoesDoStatus('cancelado', aguardando).avisos, []);

    // Marcar como pago sem o Mercado Pago confirmar: aviso de conferência e baixa de estoque.
    assert.match(opcoesDoStatus('pago', aguardando).avisos.join(' '), /não tem pagamento confirmado/);
    assert.match(opcoesDoStatus('enviado', { status: 'cancelado' }).avisos.join(' '), /estoque/);
    assert.match(opcoesDoStatus('aguardando_pagamento', pago).avisos.join(' '), /Cancelado/);
    assert.deepEqual(opcoesDoStatus('pago', pago).avisos, []);
  });

  test('errosRastreio: mesmas regras do banco', () => {
    assert.deepEqual(errosRastreio('', ''), {});
    assert.deepEqual(errosRastreio('AA123456789BR, BB987654321BR', 'https://rastreamento.correios.com.br/app/index.php?objeto=AA1'), {});
    assert.ok(errosRastreio('<b>', '').codigo);
    assert.ok(errosRastreio('a"b', '').codigo);
    assert.ok(errosRastreio('x'.repeat(201), '').codigo);
    for (const url of ['http://exemplo.com', 'https://', 'https://ex ample.com', 'javascript:alert(1)', 'https://a.com/"x', `https://a.com/${'x'.repeat(500)}`]) {
      assert.ok(errosRastreio('', url).url, url);
    }
  });

  test('podeApagar: só sem estoque baixado e sem pagamento confirmado', () => {
    assert.equal(podeApagar({ status: 'aguardando_pagamento', estoque_baixado: false }), true);
    assert.equal(podeApagar({ status: 'cancelado', estoque_baixado: false }), true);
    assert.equal(podeApagar({ status: 'reembolsado', estoque_baixado: false }), true);
    assert.equal(podeApagar({ status: 'cancelado', estoque_baixado: true }), false);
    for (const s of ['pagamento_em_analise', 'pago', 'em_separacao', 'enviado', 'entregue']) {
      assert.equal(podeApagar({ status: s, estoque_baixado: false }), false, s);
    }
    assert.equal(podeApagar(null), false);
  });
});

describe('envio pelo Melhor Envio', () => {
  const me = (extra = {}) => ({ status: 'em_separacao', entrega: { tipo: 'melhor_envio', servico_id: 1 }, me_ordens: [], etiqueta_url: null, ...extra });
  const situacao = (etapas) => Object.fromEntries(etapas.map((e) => [e.id, e.feito ? 'feito' : e.atual ? 'atual' : '-']));

  test('envioDisponivel por tipo de entrega e status', () => {
    assert.deepEqual(envioDisponivel({ status: 'pago', entrega: { tipo: 'fixo' } }), { usa: false, liberado: false, motivo: null });
    for (const s of ['pago', 'em_separacao', 'enviado']) assert.equal(envioDisponivel(me({ status: s })).liberado, true, s);
    assert.match(envioDisponivel(me({ status: 'aguardando_pagamento' })).motivo, /pagamento/);
    assert.match(envioDisponivel(me({ status: 'entregue' })).motivo, /entregue/);
    assert.match(envioDisponivel(me({ status: 'cancelado' })).motivo, /cancelado/);
    assert.equal(envioDisponivel(null).usa, false);
  });

  test('etapas: começa no carrinho', () => {
    const etapas = etapasEnvio(me(), []);
    assert.deepEqual(etapas.map((e) => e.id), [...ETAPAS_ENVIO]);
    assert.deepEqual(situacao(etapas), { carrinho: 'atual', compra: '-', geracao: '-', impressao: '-', postagem: '-' });
  });

  test('etapas: carrinho → compra → geração → impressão → postagem pelos eventos', () => {
    const pedido = me({ me_ordens: ['ord-1'] });
    const eventos = [envio(1, 'adicionar_carrinho')];
    assert.equal(situacao(etapasEnvio(pedido, eventos)).compra, 'atual');
    eventos.push(envio(2, 'comprar'));
    assert.equal(situacao(etapasEnvio(pedido, eventos)).geracao, 'atual');
    eventos.push(envio(3, 'gerar'));
    assert.equal(situacao(etapasEnvio(pedido, eventos)).impressao, 'atual');
    const impresso = { ...pedido, etiqueta_url: 'https://melhorenvio/x.pdf' };
    assert.equal(situacao(etapasEnvio(impresso, eventos)).postagem, 'atual');
    const enviado = { ...impresso, status: 'enviado' };
    assert.deepEqual(situacao(etapasEnvio(enviado, eventos)), { carrinho: 'feito', compra: 'feito', geracao: 'feito', impressao: 'feito', postagem: 'feito' });
    assert.equal(etapasEnvio(enviado, eventos).some((e) => e.atual), false);
  });

  test('etapas: refazer o carrinho recomeça a compra; eventos fora de ordem não confundem', () => {
    const pedido = me({ me_ordens: ['ord-2'] });
    const eventos = [envio(4, 'adicionar_carrinho'), envio(2, 'comprar'), envio(3, 'gerar'), envio(1, 'adicionar_carrinho')];
    // Em ordem: carrinho(1) → comprar(2) → gerar(3) → carrinho de novo(4): só o carrinho está feito.
    assert.deepEqual(situacao(etapasEnvio(pedido, eventos)), { carrinho: 'feito', compra: 'atual', geracao: '-', impressao: '-', postagem: '-' });
  });

  test('etapas: link de impressão prova compra e geração; sem etiquetas nada conta', () => {
    const comLink = me({ me_ordens: ['o'], etiqueta_url: 'https://x/y.pdf' });
    assert.deepEqual(situacao(etapasEnvio(comLink, [])), { carrinho: 'feito', compra: 'feito', geracao: 'feito', impressao: 'feito', postagem: 'atual' });
    const semEtiquetas = me({ etiqueta_url: 'https://x/y.pdf' });
    assert.equal(situacao(etapasEnvio(semEtiquetas, [envio(1, 'comprar')])).carrinho, 'atual');
  });

  test('ultimoCarrinho', () => {
    const eventos = [envio(1, 'adicionar_carrinho', { etiquetas: [{ id: 'a' }] }), envio(3, 'comprar'), envio(2, 'adicionar_carrinho', { etiquetas: [{ id: 'b' }] })];
    assert.equal(ultimoCarrinho(eventos).dados.etiquetas[0].id, 'b');
    assert.equal(ultimoCarrinho([]), null);
  });
});

describe('arquivos da página', () => {
  test('pedidos.css existe, é carregado pela página e só estiliza dentro dela (ou do modal dela)', () => {
    const css = new URL('../../public/admin/css/pedidos.css', import.meta.url);
    assert.ok(existsSync(css));
    const fonte = readFileSync(new URL('../../public/admin/js/paginas/pedidos.js', import.meta.url), 'utf8');
    assert.match(fonte, /carregarCss\('pedidos'\)/);
    // Nada de innerHTML com dado.
    assert.doesNotMatch(fonte, /innerHTML|insertAdjacentHTML|outerHTML/);
    const seletores = readFileSync(css, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('}')
      .map((bloco) => bloco.split('{')[0].trim()).filter((sel) => sel && !sel.startsWith('@'));
    for (const sel of seletores) {
      for (const parte of sel.split(',')) {
        assert.match(parte.trim(), /^(\.pagina\[data-pagina="pedidos"\]|\.modal--pedido-status)/, parte);
      }
    }
  });
});
