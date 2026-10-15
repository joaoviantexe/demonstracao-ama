// lib/frete.js: regras de frete (§6.2) — funções puras e cotarFrete contra o Melhor Envio falso.
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from '../apoio/melhorenvio-falso.js';
import { AMBIENTE_VAZIO, aplicarAmbiente } from '../apoio/servidor.js';
import {
  CACHE_COTACAO_MS, FRETE_PADRAO, MINIMOS_CORREIOS, TIMEOUT_COTACAO_MS, aplicarFreteGratis, cotarFrete, freteGratisAtivo,
  limparCacheCotacoes, montarProdutosMelhorEnvio, normalizarConfigFrete, opcaoMelhorEnvio, opcaoRetirada, opcoesFixas,
  ordenarOpcoes, textoPrazo,
} from '../../lib/frete.js';

let falso;
let restaurar;

const item = (extra = {}) => ({
  produto_id: 'p1', nome: 'Body Splash Raiz', quantidade: 2, preco_unitario_centavos: 4500, total_centavos: 9000,
  disponivel: true, motivo: null, peso_gramas: 300, altura_cm: 4, largura_cm: 12, comprimento_cm: 16, ...extra,
});

function configBase() {
  return {
    loja: { titulo: 'Loja AMA', frete_gratis_acima_centavos: null },
    frete: {
      origem: { ...FRETE_PADRAO.origem, cep: '67125-866' },
      retirada: { ativa: true, nome: 'Retirar na sede da AMA', endereco: 'Icuí, Ananindeua', prazo_texto: 'Disponível após a confirmação do pagamento' },
      fixo: {
        ativo: true,
        opcoes: [
          { id: 'fixo-1', nome: 'Entrega local', preco_centavos: 1500, prazo_dias: 3, ufs: ['PA'] },
          { id: 'nacional', nome: 'Carta registrada', preco_centavos: 2800, prazo_dias: 10, ufs: [] },
        ],
      },
      melhor_envio: { ativo: true, servicos: [1, 2], seguro: true, prazo_extra_dias: 2, taxa_extra_centavos: 100 },
      embalagem_padrao: { peso_gramas: 300, altura_cm: 4, largura_cm: 12, comprimento_cm: 16 },
    },
  };
}

const ids = (resultado) => resultado.opcoes.map((o) => o.id);
const chamadasCotacao = () => falso.estado.requisicoes.filter((r) => r.caminho === '/shipment/calculate');

before(async () => { falso = await iniciar(); });
after(async () => { await falso.fechar(); });
beforeEach(() => {
  falso.estado.reiniciar();
  limparCacheCotacoes();
  restaurar = aplicarAmbiente({
    ...AMBIENTE_VAZIO,
    MELHOR_ENVIO_TOKEN: 'token-de-teste',
    MELHOR_ENVIO_EMAIL: 'tec@ama.org',
    MELHOR_ENVIO_API_BASE: falso.url,
  });
});
afterEach(() => { restaurar(); });

// ---------------------------------------------------------------------------
describe('funções puras', () => {
  test('montarProdutosMelhorEnvio: kg, cm inteiros com mínimos dos Correios, seguro unitário e quantity', () => {
    const produtos = montarProdutosMelhorEnvio([
      item(),
      item({ produto_id: 'p2', quantidade: 1, peso_gramas: 1250, altura_cm: 0.5, largura_cm: 5, comprimento_cm: 10, preco_unitario_centavos: 1999 }),
      item({ produto_id: 'p3', quantidade: 1, altura_cm: 12.2, largura_cm: '20.0', comprimento_cm: 30 }),
    ]);
    assert.deepEqual(produtos, [
      { id: 'p1', width: 12, height: 4, length: 16, weight: 0.3, insurance_value: 45, quantity: 2 },
      { id: 'p2', width: MINIMOS_CORREIOS.largura_cm, height: MINIMOS_CORREIOS.altura_cm, length: MINIMOS_CORREIOS.comprimento_cm, weight: 1.25, insurance_value: 19.99, quantity: 1 },
      { id: 'p3', width: 20, height: 13, length: 30, weight: 0.3, insurance_value: 45, quantity: 1 },
    ]);
  });

  test('montarProdutosMelhorEnvio: sem seguro, embalagem padrão e itens indisponíveis fora', () => {
    const produtos = montarProdutosMelhorEnvio([
      item({ peso_gramas: null, altura_cm: 0, largura_cm: undefined, comprimento_cm: 'x' }),
      item({ produto_id: 'esgotado', disponivel: false, peso_gramas: 50_000 }),
      item({ produto_id: 'zero', quantidade: 0 }),
      null,
    ], { seguro: false, embalagem: { peso_gramas: 500, altura_cm: 6, largura_cm: 15, comprimento_cm: 20 } });
    assert.deepEqual(produtos, [{ id: 'p1', width: 15, height: 6, length: 20, weight: 0.5, insurance_value: 0, quantity: 2 }]);
    assert.deepEqual(montarProdutosMelhorEnvio(undefined), []);
  });

  test('textoPrazo', () => {
    assert.equal(textoPrazo(1), 'até 1 dia útil');
    assert.equal(textoPrazo(7), 'até 7 dias úteis');
    assert.equal(textoPrazo('5'), 'até 5 dias úteis');
    assert.equal(textoPrazo(null, 'Combine pelo WhatsApp'), 'Combine pelo WhatsApp');
    assert.equal(textoPrazo(undefined), 'Prazo a combinar');
  });

  test('opcaoMelhorEnvio soma prazo e taxa extras', () => {
    const opcao = opcaoMelhorEnvio(
      { servico_id: 1, nome: 'PAC', empresa: 'Correios', preco_centavos: 2350, prazo_dias: 8, erro: null, pacotes: [] },
      { prazo_extra_dias: 2, taxa_extra_centavos: 150 },
    );
    assert.deepEqual(opcao, {
      id: 'me-1', tipo: 'melhor_envio', nome: 'PAC', empresa: 'Correios', prazo_dias: 10, prazo_texto: 'até 10 dias úteis',
      preco_centavos: 2500, preco_original_centavos: 2500, gratis: false, servico_id: 1,
    });
  });

  test('opcoesFixas: filtra por UF (lista vazia = todas), ids "fixo-…" e opções inválidas fora', () => {
    const fixo = {
      ativo: true,
      opcoes: [
        { id: 'fixo-1', nome: 'Entrega local', preco_centavos: 1500, prazo_dias: 3, ufs: ['pa', 'AP'] },
        { id: 'Nacional', nome: 'Carta registrada', preco_centavos: 2800, prazo_dias: 10, ufs: [] },
        { nome: 'Sem id', preco_centavos: '900' },
        { id: 'quebrada', nome: 'Preço inválido', preco_centavos: -1 },
        { id: 'desligada', nome: 'Desligada', preco_centavos: 100, ativo: false },
      ],
    };
    assert.deepEqual(opcoesFixas(fixo, 'PA').map((o) => o.id), ['fixo-1', 'fixo-nacional', 'fixo-3']);
    assert.deepEqual(opcoesFixas(fixo, 'AP').map((o) => o.id), ['fixo-1', 'fixo-nacional', 'fixo-3']);
    assert.deepEqual(opcoesFixas(fixo, 'SP').map((o) => o.id), ['fixo-nacional', 'fixo-3']);
    assert.deepEqual(opcoesFixas(fixo, null).map((o) => o.id), ['fixo-nacional', 'fixo-3']);
    const [local] = opcoesFixas(fixo, 'PA');
    assert.deepEqual(local, {
      id: 'fixo-1', tipo: 'fixo', nome: 'Entrega local', empresa: null, prazo_dias: 3, prazo_texto: 'até 3 dias úteis',
      preco_centavos: 1500, preco_original_centavos: 1500, gratis: false, servico_id: null,
    });
    assert.equal(opcoesFixas(fixo, 'PA')[2].prazo_texto, 'Prazo a combinar');
    assert.deepEqual(opcoesFixas({ ...fixo, ativo: false }, 'PA'), []);
    assert.deepEqual(opcoesFixas(undefined, 'PA'), []);
  });

  test('opcaoRetirada: preço 0, prazo_texto da config; null se desativada', () => {
    assert.deepEqual(opcaoRetirada({ ativa: true, nome: 'Retirar na AMA', prazo_texto: 'Combine pelo WhatsApp' }), {
      id: 'retirada', tipo: 'retirada', nome: 'Retirar na AMA', empresa: null, prazo_dias: null,
      prazo_texto: 'Combine pelo WhatsApp', preco_centavos: 0, preco_original_centavos: 0, gratis: false, servico_id: null,
    });
    assert.equal(opcaoRetirada({ ativa: false }), null);
    assert.equal(opcaoRetirada(undefined).nome, FRETE_PADRAO.retirada.nome);
  });

  test('freteGratisAtivo', () => {
    assert.equal(freteGratisAtivo({ freteGratisCupom: true }), true);
    assert.equal(freteGratisAtivo({ subtotalCentavos: 20_000, limiteCentavos: 20_000 }), true);
    assert.equal(freteGratisAtivo({ subtotalCentavos: 19_999, limiteCentavos: 20_000 }), false);
    assert.equal(freteGratisAtivo({ subtotalCentavos: 50_000, limiteCentavos: null }), false);
    assert.equal(freteGratisAtivo({ subtotalCentavos: 50_000, limiteCentavos: 0 }), false);
    assert.equal(freteGratisAtivo({ freteGratisCupom: 'sim', subtotalCentavos: 0 }), false);
  });

  test('aplicarFreteGratis: só a opção PAGA mais barata; retirada e opções já grátis ficam como estão', () => {
    const opcoes = [
      { id: 'me-2', tipo: 'melhor_envio', nome: 'SEDEX', preco_centavos: 3900, preco_original_centavos: 3900, gratis: false, prazo_dias: 5 },
      { id: 'fixo-zero', tipo: 'fixo', nome: 'Entrega no bairro', preco_centavos: 0, preco_original_centavos: 0, gratis: false, prazo_dias: 1 },
      { id: 'me-1', tipo: 'melhor_envio', nome: 'PAC', preco_centavos: 2400, preco_original_centavos: 2400, gratis: false, prazo_dias: 10 },
      { id: 'fixo-1', tipo: 'fixo', nome: 'Local', preco_centavos: 2400, preco_original_centavos: 2400, gratis: false, prazo_dias: 3 },
      { id: 'retirada', tipo: 'retirada', nome: 'Retirada', preco_centavos: 0, preco_original_centavos: 0, gratis: false, prazo_dias: null },
    ];
    const saida = aplicarFreteGratis(opcoes);
    // Empate de preço: vence o menor prazo.
    const gratis = saida.filter((o) => o.gratis);
    assert.deepEqual(gratis.map((o) => o.id), ['fixo-1']);
    assert.equal(gratis[0].preco_centavos, 0);
    assert.equal(gratis[0].preco_original_centavos, 2400);
    assert.equal(saida.find((o) => o.id === 'fixo-zero').gratis, false);
    assert.equal(opcoes[3].preco_centavos, 2400, 'não altera a entrada');
    assert.deepEqual(aplicarFreteGratis([opcoes[4]]), [opcoes[4]]);
    // A retirada nunca é a escolhida, mesmo que um dia tenha preço.
    const retiradaPaga = { ...opcoes[4], preco_centavos: 500, preco_original_centavos: 500 };
    assert.deepEqual(aplicarFreteGratis([retiradaPaga, opcoes[0]]).map((o) => [o.id, o.gratis]), [['retirada', false], ['me-2', true]]);
  });

  test('ordenarOpcoes: retirada por último; demais por preço, prazo e nome', () => {
    const lista = ordenarOpcoes([
      { id: 'retirada', tipo: 'retirada', nome: 'Retirada', preco_centavos: 0, prazo_dias: null },
      { id: 'me-2', tipo: 'melhor_envio', nome: 'SEDEX', preco_centavos: 3900, prazo_dias: 5 },
      { id: 'b', tipo: 'fixo', nome: 'B', preco_centavos: 1500, prazo_dias: null },
      { id: 'a', tipo: 'fixo', nome: 'A', preco_centavos: 1500, prazo_dias: null },
      { id: 'c', tipo: 'fixo', nome: 'C', preco_centavos: 1500, prazo_dias: 2 },
      { id: 'gratis', tipo: 'melhor_envio', nome: 'PAC', preco_centavos: 0, prazo_dias: 10 },
    ]);
    assert.deepEqual(lista.map((o) => o.id), ['gratis', 'c', 'a', 'b', 'me-2', 'retirada']);
  });

  test('normalizarConfigFrete preenche os padrões da §4.1', () => {
    const cfg = normalizarConfigFrete({ frete: { melhor_envio: { ativo: false } } });
    assert.equal(cfg.melhor_envio.ativo, false);
    assert.deepEqual(cfg.melhor_envio.servicos, [1, 2]);
    assert.equal(cfg.retirada.ativa, true);
    assert.equal(cfg.fixo.ativo, false);
    assert.equal(cfg.origem.cep, '');
    assert.equal(cfg.embalagem_padrao.peso_gramas, 300);
    assert.deepEqual(normalizarConfigFrete(undefined).melhor_envio, { ...FRETE_PADRAO.melhor_envio });
  });
});

// ---------------------------------------------------------------------------
describe('cotarFrete', () => {
  test('SP: Melhor Envio + fixo nacional + retirada, ordenados; corpo da cotação por products', async () => {
    const itens = [item(), item({ produto_id: 'esgotado', disponivel: false, motivo: 'sem_estoque', peso_gramas: 90_000 })];
    const r = await cotarFrete({ itens, cep: '01310-100', subtotalCentavos: 9000, freteGratisCupom: false, config: configBase() });
    assert.equal(r.erro, null);
    assert.equal(r.uf, 'SP');
    assert.deepEqual(ids(r), ['me-1', 'fixo-nacional', 'me-2', 'retirada']);

    const [pac, , sedex, retirada] = r.opcoes;
    // PAC do falso: R$ 23,50 + taxa extra R$ 1,00; prazo 8 + 2.
    assert.deepEqual(pac, {
      id: 'me-1', tipo: 'melhor_envio', nome: 'PAC', empresa: 'Correios', prazo_dias: 10, prazo_texto: 'até 10 dias úteis',
      preco_centavos: 2450, preco_original_centavos: 2450, gratis: false, servico_id: 1,
    });
    assert.equal(sedex.preco_centavos, 3930);
    assert.equal(sedex.prazo_dias, 5);
    assert.equal(retirada.preco_centavos, 0);
    assert.equal(retirada.prazo_texto, 'Disponível após a confirmação do pagamento');

    const [cotacao] = chamadasCotacao();
    assert.deepEqual(cotacao.corpo.from, { postal_code: '67125866' });
    assert.deepEqual(cotacao.corpo.to, { postal_code: '01310100' });
    assert.equal(cotacao.corpo.services, '1,2');
    // O item indisponível não entra no peso.
    assert.deepEqual(cotacao.corpo.products, [{ id: 'p1', width: 12, height: 4, length: 16, weight: 0.3, insurance_value: 45, quantity: 2 }]);
    assert.equal(cotacao.cabecalhos['user-agent'], 'AMA Loja (tec@ama.org)');
  });

  test('PA: inclui o frete fixo regional', async () => {
    const r = await cotarFrete({ itens: [item()], cep: '66010000', subtotalCentavos: 9000, config: configBase() });
    assert.equal(r.uf, 'PA');
    assert.deepEqual(ids(r), ['fixo-1', 'me-1', 'fixo-nacional', 'me-2', 'retirada']);
  });

  test('frete grátis por cupom: a opção paga mais barata fica com preço 0', async () => {
    const r = await cotarFrete({ itens: [item()], cep: '66010-000', subtotalCentavos: 9000, freteGratisCupom: true, config: configBase() });
    const [primeira] = r.opcoes;
    assert.equal(primeira.id, 'fixo-1');
    assert.equal(primeira.preco_centavos, 0);
    assert.equal(primeira.preco_original_centavos, 1500);
    assert.equal(primeira.gratis, true);
    assert.equal(r.opcoes.filter((o) => o.gratis).length, 1);
    assert.equal(r.opcoes.find((o) => o.id === 'me-1').preco_centavos, 2450);
    assert.equal(r.opcoes.at(-1).id, 'retirada');
  });

  test('frete grátis por valor mínimo (subtotal já com desconto)', async () => {
    const config = configBase();
    config.loja.frete_gratis_acima_centavos = 20_000;
    config.frete.fixo.ativo = false;

    const sim = await cotarFrete({ itens: [item()], cep: '01310-100', subtotalCentavos: 20_000, config });
    assert.deepEqual(ids(sim), ['me-1', 'me-2', 'retirada']);
    assert.equal(sim.opcoes[0].gratis, true);
    assert.equal(sim.opcoes[0].preco_centavos, 0);
    assert.equal(sim.opcoes[0].preco_original_centavos, 2450);

    const abaixo = await cotarFrete({ itens: [item()], cep: '01310-100', subtotalCentavos: 19_999, config });
    assert.ok(abaixo.opcoes.every((o) => !o.gratis));

    // Subtotal 25.000 com desconto de 6.000 fica abaixo de 20.000.
    const comDesconto = await cotarFrete({ itens: [item()], cep: '01310-100', subtotalCentavos: 25_000, descontoCentavos: 6000, config });
    assert.ok(comDesconto.opcoes.every((o) => !o.gratis));
  });

  test('serviço com erro é ignorado; custom_price/custom_delivery_time usados', async () => {
    falso.estado.ajustesServicos = { 1: { custom_price: '20.00', custom_delivery_time: 6 }, 2: { error: 'Trecho não atendido.' } };
    const r = await cotarFrete({ itens: [item()], cep: '01310-100', subtotalCentavos: 9000, config: configBase() });
    assert.equal(r.erro, null);
    assert.deepEqual(ids(r), ['me-1', 'fixo-nacional', 'retirada']);
    assert.equal(r.opcoes[0].preco_centavos, 2100);
    assert.equal(r.opcoes[0].prazo_dias, 8);
  });

  test('serviço não configurado que a API devolva não entra', async () => {
    const config = configBase();
    config.frete.melhor_envio.servicos = [1];
    falso.estado.forcar('/shipment/calculate', {
      status: 200,
      corpo: [
        { id: 1, name: 'PAC', price: '23.50', delivery_time: 8, company: { name: 'Correios' } },
        { id: 2, name: 'SEDEX', price: '9.00', delivery_time: 3, company: { name: 'Correios' } },
      ],
    });
    const r = await cotarFrete({ itens: [item()], cep: '01310-100', subtotalCentavos: 9000, config });
    assert.deepEqual(ids(r), ['me-1', 'fixo-nacional', 'retirada']);
  });

  test('erro do Melhor Envio (500) não derruba: outras opções + mensagem amigável', async (t) => {
    t.mock.method(console, 'warn', () => {});
    falso.estado.forcar('/shipment/calculate', { status: 500, corpo: { message: 'Server Error' } });
    const r = await cotarFrete({ itens: [item()], cep: '66010-000', subtotalCentavos: 9000, config: configBase() });
    assert.deepEqual(ids(r), ['fixo-1', 'fixo-nacional', 'retirada']);
    assert.equal(r.uf, 'PA');
    assert.match(r.erro, /Não foi possível calcular o frete/);
    assert.doesNotMatch(r.erro, /500|Server Error/);
    assert.equal(console.warn.mock.callCount(), 1);
  });

  test('429 uma vez: tenta de novo e cota normalmente', async () => {
    falso.estado.forcar('/shipment/calculate', { status: 429, corpo: { message: 'Too Many Attempts.' }, cabecalhos: { 'Retry-After': '0' } });
    const r = await cotarFrete({ itens: [item()], cep: '01310-100', subtotalCentavos: 9000, config: configBase() });
    assert.equal(r.erro, null);
    assert.deepEqual(ids(r), ['me-1', 'fixo-nacional', 'me-2', 'retirada']);
    assert.equal(chamadasCotacao().length, 2);
  });

  test('Melhor Envio lento: timeout vira erro amigável', async (t) => {
    t.mock.method(console, 'warn', () => {});
    falso.estado.forcar('/shipment/calculate', { status: 200, corpo: [], atrasoMs: 300 });
    const r = await cotarFrete({ itens: [item()], cep: '01310-100', subtotalCentavos: 9000, config: configBase(), timeoutMs: 40 });
    assert.deepEqual(ids(r), ['fixo-nacional', 'retirada']);
    assert.match(r.erro, /Tente de novo/);
  });

  test('nenhum serviço atende (pacote pesado demais): erro informativo e demais opções', async () => {
    const r = await cotarFrete({ itens: [item({ quantidade: 1, peso_gramas: 45_000 })], cep: '01310-100', subtotalCentavos: 4500, config: configBase() });
    assert.deepEqual(ids(r), ['fixo-nacional', 'retirada']);
    assert.match(r.erro, /transportadoras não atendem/);
  });

  test('dimensões pequenas sobem para os mínimos dos Correios e a cotação funciona', async () => {
    const r = await cotarFrete({
      itens: [item({ quantidade: 1, altura_cm: 0.5, largura_cm: 3, comprimento_cm: 5, peso_gramas: 20 })],
      cep: '01310-100', subtotalCentavos: 4500, config: configBase(),
    });
    assert.equal(r.erro, null);
    assert.ok(ids(r).includes('me-1'));
    const [produto] = chamadasCotacao()[0].corpo.products;
    assert.deepEqual([produto.height, produto.width, produto.length, produto.weight], [1, 8, 13, 0.02]);
  });

  test('seguro desligado: insurance_value 0', async () => {
    const config = configBase();
    config.frete.melhor_envio.seguro = false;
    await cotarFrete({ itens: [item()], cep: '01310-100', subtotalCentavos: 9000, config });
    assert.equal(chamadasCotacao()[0].corpo.products[0].insurance_value, 0);
  });

  test('Melhor Envio desativado, sem token ou sem CEP de origem: não chama a API e não dá erro', async () => {
    const desativado = configBase();
    desativado.frete.melhor_envio.ativo = false;
    let r = await cotarFrete({ itens: [item()], cep: '01310-100', subtotalCentavos: 9000, config: desativado });
    assert.deepEqual(ids(r), ['fixo-nacional', 'retirada']);
    assert.equal(r.erro, null);

    const semOrigem = configBase();
    semOrigem.frete.origem.cep = '';
    r = await cotarFrete({ itens: [item()], cep: '01310-100', subtotalCentavos: 9000, config: semOrigem });
    assert.deepEqual(ids(r), ['fixo-nacional', 'retirada']);
    assert.equal(r.erro, null);

    const semServicos = configBase();
    semServicos.frete.melhor_envio.servicos = [];
    r = await cotarFrete({ itens: [item()], cep: '01310-100', subtotalCentavos: 9000, config: semServicos });
    assert.equal(r.erro, null);

    aplicarAmbiente({ MELHOR_ENVIO_TOKEN: undefined });
    r = await cotarFrete({ itens: [item()], cep: '01310-100', subtotalCentavos: 9000, config: configBase() });
    assert.deepEqual(ids(r), ['fixo-nacional', 'retirada']);
    assert.equal(r.erro, null);

    assert.equal(falso.estado.requisicoes.length, 0);
  });

  test('só itens indisponíveis: não cota no Melhor Envio', async () => {
    const r = await cotarFrete({ itens: [item({ disponivel: false })], cep: '01310-100', subtotalCentavos: 0, config: configBase() });
    assert.deepEqual(ids(r), ['fixo-nacional', 'retirada']);
    assert.equal(falso.estado.requisicoes.length, 0);
  });

  test('CEP inválido ou fora das faixas: só a retirada e erro amigável', async () => {
    for (const cep of ['123', '', undefined, 'abcde-fgh', '00999-999']) {
      const r = await cotarFrete({ itens: [item()], cep, subtotalCentavos: 9000, config: configBase() });
      assert.deepEqual(ids(r), ['retirada'], `CEP ${cep}`);
      assert.equal(r.uf, null);
      assert.match(r.erro, /CEP/);
    }
    const semRetirada = configBase();
    semRetirada.frete.retirada.ativa = false;
    const r = await cotarFrete({ itens: [item()], cep: '1', subtotalCentavos: 9000, config: semRetirada });
    assert.deepEqual(r.opcoes, []);
    assert.match(r.erro, /CEP inválido/);
    assert.equal(falso.estado.requisicoes.length, 0);
  });

  test('nenhuma forma de entrega: erro', async () => {
    const config = configBase();
    config.frete.retirada.ativa = false;
    config.frete.fixo.ativo = false;
    config.frete.melhor_envio.ativo = false;
    const r = await cotarFrete({ itens: [item()], cep: '01310-100', subtotalCentavos: 9000, config });
    assert.deepEqual(r.opcoes, []);
    assert.equal(r.uf, 'SP');
    assert.match(r.erro, /Não há forma de entrega/);
  });

  test('config ausente: padrões (retirada ativa; Melhor Envio sem origem não é chamado)', async () => {
    const r = await cotarFrete({ itens: [item()], cep: '01310-100', subtotalCentavos: 9000 });
    assert.deepEqual(ids(r), ['retirada']);
    assert.equal(r.erro, null);
    assert.equal(falso.estado.requisicoes.length, 0);
  });
});

// ---------------------------------------------------------------------------
describe('cotarFrete: cache, duplicados e prazo', () => {
  const pedido = (config, extra = {}) => ({ itens: [item()], cep: '01310-100', subtotalCentavos: 9000, config, ...extra });

  test('serviço repetido na resposta entra uma vez só (o primeiro)', async () => {
    const config = configBase();
    config.frete.fixo.ativo = false;
    falso.estado.forcar('/shipment/calculate', {
      status: 200,
      corpo: [
        { id: 1, name: 'PAC', price: '23.50', delivery_time: 8, company: { name: 'Correios' } },
        { id: 1, name: 'PAC', price: '5.00', delivery_time: 8, company: { name: 'Correios' } },
      ],
    });
    const r = await cotarFrete(pedido(config));
    assert.deepEqual(ids(r), ['me-1', 'retirada']);
    assert.equal(r.opcoes[0].preco_centavos, 2450);
  });

  test('sem timeoutMs, o prazo da chamada é TIMEOUT_COTACAO_MS (8 s)', async (t) => {
    const original = globalThis.setTimeout;
    const prazos = [];
    t.mock.method(globalThis, 'setTimeout', (fn, ms, ...resto) => {
      prazos.push(ms);
      return original(fn, ms, ...resto);
    });
    const r = await cotarFrete(pedido(configBase()));
    t.mock.restoreAll();
    assert.equal(r.erro, null);
    assert.equal(TIMEOUT_COTACAO_MS, 8000);
    assert.ok(prazos.some((ms) => ms > TIMEOUT_COTACAO_MS - 1000 && ms <= TIMEOUT_COTACAO_MS), `prazos usados: ${prazos.join(', ')}`);
  });

  test('prazo total: 429 seguido de resposta lenta não passa do timeoutMs', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const config = configBase();
    config.frete.fixo.ativo = false;
    falso.estado.forcar('/shipment/calculate', { status: 429, corpo: { message: 'Too Many Attempts.' }, cabecalhos: { 'Retry-After': '1' } });
    falso.estado.forcar('/shipment/calculate', { status: 200, corpo: [], atrasoMs: 900 });
    const inicio = Date.now();
    const r = await cotarFrete(pedido(config, { timeoutMs: 1000 }));
    assert.ok(Date.now() - inicio < 1150, `levou ${Date.now() - inicio} ms`);
    assert.deepEqual(ids(r), ['retirada']);
    assert.match(r.erro, /Tente de novo/);
  });

  test('cache: cotação igual não chama a API de novo; taxa e prazo da config valem na hora', async () => {
    const config = configBase();
    const primeira = await cotarFrete(pedido(config));
    assert.equal(primeira.opcoes.find((o) => o.id === 'me-1').preco_centavos, 2450);

    config.frete.melhor_envio.taxa_extra_centavos = 500;
    config.frete.melhor_envio.prazo_extra_dias = 0;
    const segunda = await cotarFrete(pedido(config, { cep: '01310100' }));
    assert.equal(chamadasCotacao().length, 1);
    const pac = segunda.opcoes.find((o) => o.id === 'me-1');
    assert.equal(pac.preco_centavos, 2850);
    assert.equal(pac.prazo_dias, 8);

    // CEP, itens ou serviços diferentes: nova cotação.
    await cotarFrete(pedido(config, { cep: '20040-020' }));
    assert.equal(chamadasCotacao().length, 2);
    await cotarFrete(pedido(config, { itens: [item({ quantidade: 3 })] }));
    assert.equal(chamadasCotacao().length, 3);
    config.frete.melhor_envio.servicos = [1];
    await cotarFrete(pedido(config));
    assert.equal(chamadasCotacao().length, 4);

    limparCacheCotacoes();
    config.frete.melhor_envio.servicos = [1, 2];
    await cotarFrete(pedido(config));
    assert.equal(chamadasCotacao().length, 5);
  });

  test('cache: erro não fica guardado', async (t) => {
    t.mock.method(console, 'warn', () => {});
    falso.estado.forcar('/shipment/calculate', { status: 500, corpo: { message: 'Server Error' } });
    const falhou = await cotarFrete(pedido(configBase()));
    assert.match(falhou.erro, /Não foi possível calcular/);
    const depois = await cotarFrete(pedido(configBase()));
    assert.equal(depois.erro, null);
    assert.ok(ids(depois).includes('me-1'));
    assert.equal(chamadasCotacao().length, 2);
  });

  test('cache: pedidos iguais simultâneos fazem uma chamada; expira depois de CACHE_COTACAO_MS', async (t) => {
    const [a, b] = await Promise.all([cotarFrete(pedido(configBase())), cotarFrete(pedido(configBase()))]);
    assert.deepEqual(a, b);
    assert.equal(chamadasCotacao().length, 1);

    const agoraReal = Date.now;
    t.mock.method(Date, 'now', () => agoraReal.call(Date) + CACHE_COTACAO_MS - 5_000);
    await cotarFrete(pedido(configBase()));
    assert.equal(chamadasCotacao().length, 1, 'ainda no prazo do cache');

    Date.now.mock.mockImplementation(() => agoraReal.call(Date) + CACHE_COTACAO_MS + 1_000);
    await cotarFrete(pedido(configBase()));
    assert.equal(chamadasCotacao().length, 2, 'cache vencido');
  });

  test('cache: outra base de API (outra conta ou sandbox) não reaproveita a cotação', async () => {
    await cotarFrete(pedido(configBase()));
    const outro = await iniciar();
    try {
      aplicarAmbiente({ MELHOR_ENVIO_API_BASE: outro.url });
      const r = await cotarFrete(pedido(configBase()));
      assert.equal(r.erro, null);
      assert.equal(outro.estado.requisicoes.filter((x) => x.caminho === '/shipment/calculate').length, 1);
    } finally {
      await outro.fechar();
    }
  });

  test('token malformado: não chama a API, erro amigável e o token não aparece no log', async (t) => {
    const avisos = [];
    t.mock.method(console, 'warn', (...args) => { avisos.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); });
    aplicarAmbiente({ MELHOR_ENVIO_TOKEN: 'segredo-SUPER\nsecreto' });
    const r = await cotarFrete(pedido(configBase()));
    assert.deepEqual(ids(r), ['fixo-nacional', 'retirada']);
    assert.match(r.erro, /Não foi possível calcular/);
    assert.equal(falso.estado.requisicoes.length, 0);
    assert.equal(avisos.length, 1);
    assert.match(avisos[0], /formato inválido/);
    assert.doesNotMatch(avisos[0], /segredo|secreto/);
  });
});
