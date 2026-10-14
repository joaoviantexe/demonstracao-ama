// lib/melhorenvio.js contra o servidor falso (tests/apoio/melhorenvio-falso.js). Sem rede externa.
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from '../apoio/melhorenvio-falso.js';
import { AMBIENTE_VAZIO, aplicarAmbiente } from '../apoio/servidor.js';
import {
  SERVICOS_CORREIOS, adicionarAoCarrinho, aguardarGeracao, calcular, cancelar, comprar, destinatarioDoPedido, gerar, imprimir, listaServicos,
  montarCorpoCotacao, montarItensCarrinho, normalizarServicos, obterEtiqueta, rastrear, saldo, urlApi, userAgent,
} from '../../lib/melhorenvio.js';

let falso;
let restaurar;

const ORIGEM = {
  cep: '67125-866', nome: 'AMA - Associação de Mulheres na Amazônia', telefone: '(91) 99999-0000', email: 'loja@ama.local',
  documento: '11.222.333/0001-81', endereco: 'Conjunto Uirapuru, Quadra 28', numero: '02', complemento: 'Casa 02',
  bairro: 'Icuí-Guajará', cidade: 'Ananindeua', uf: 'PA',
};
const DESTINATARIO = {
  nome: 'Maria da Silva', cpf: '529.982.247-25', telefone: '(11) 98888-7777', email: 'maria@exemplo.com',
  cep: '01310-100', logradouro: 'Avenida Paulista', numero: '1000', complemento: 'ap 12', bairro: 'Bela Vista',
  cidade: 'São Paulo', uf: 'SP',
};
const PRODUTO_LEVE = { id: 'p-leve', width: 12, height: 4, length: 16, weight: 0.3, insurance_value: 45, quantity: 2 };

const ultima = () => falso.estado.requisicoes[falso.estado.requisicoes.length - 1];
const chamadasPara = (caminho) => falso.estado.requisicoes.filter((r) => r.caminho === caminho);

async function rejeita(promessa, { status, erro, mensagem }) {
  await assert.rejects(promessa, (e) => {
    assert.equal(e.name, 'ErroHttp');
    if (status !== undefined) assert.equal(e.status, status);
    if (erro !== undefined) assert.equal(e.erro, erro);
    if (mensagem !== undefined) assert.match(e.mensagem, mensagem);
    return true;
  });
}

before(async () => { falso = await iniciar(); });
after(async () => { await falso.fechar(); });
beforeEach(() => {
  falso.estado.reiniciar();
  falso.estado.token = null;
  falso.estado.atrasoGeracaoMs = 400;
  restaurar = aplicarAmbiente({
    ...AMBIENTE_VAZIO,
    MELHOR_ENVIO_TOKEN: 'token-de-teste',
    MELHOR_ENVIO_EMAIL: 'tec@ama.org',
    MELHOR_ENVIO_API_BASE: falso.url,
  });
});
afterEach(() => { restaurar(); });

// ---------------------------------------------------------------------------
describe('configuração e cabeçalhos', () => {
  test('sem token: 503 frete_nao_configurado e nenhuma chamada', async () => {
    aplicarAmbiente({ MELHOR_ENVIO_TOKEN: undefined });
    const naoConfigurado = { status: 503, erro: 'frete_nao_configurado' };
    await rejeita(calcular({ de: '67125866', para: '01310100', produtos: [PRODUTO_LEVE] }), naoConfigurado);
    await rejeita(saldo(), naoConfigurado);
    await rejeita(adicionarAoCarrinho({ service: 1 }), naoConfigurado);
    await rejeita(comprar(['a']), naoConfigurado);
    await rejeita(gerar(['a']), naoConfigurado);
    await rejeita(imprimir(['a']), naoConfigurado);
    await rejeita(rastrear(['a']), naoConfigurado);
    await rejeita(obterEtiqueta('a'), naoConfigurado);
    await rejeita(cancelar('a'), naoConfigurado);
    assert.equal(falso.estado.requisicoes.length, 0);
  });

  test('urlApi: produção, sandbox e base de teste (sem duplicar o prefixo)', () => {
    aplicarAmbiente({ MELHOR_ENVIO_API_BASE: undefined });
    assert.equal(urlApi(), 'https://melhorenvio.com.br/api/v2/me');
    aplicarAmbiente({ MELHOR_ENVIO_AMBIENTE: 'sandbox' });
    assert.equal(urlApi(), 'https://sandbox.melhorenvio.com.br/api/v2/me');
    aplicarAmbiente({ MELHOR_ENVIO_API_BASE: 'http://127.0.0.1:9/api/v2/me/' });
    assert.equal(urlApi(), 'http://127.0.0.1:9/api/v2/me');
    aplicarAmbiente({ MELHOR_ENVIO_API_BASE: falso.url });
    assert.equal(urlApi(), `${falso.url}/api/v2/me`);
  });

  test('User-Agent: e-mail técnico, e-mail do remetente ou "contato"; sem caracteres perigosos', () => {
    assert.equal(userAgent(), 'AMA Loja (tec@ama.org)');
    aplicarAmbiente({ MELHOR_ENVIO_EMAIL: undefined, EMAIL_REMETENTE: 'AMA <loja@ama.org.br>' });
    assert.equal(userAgent(), 'AMA Loja (loja@ama.org.br)');
    aplicarAmbiente({ EMAIL_REMETENTE: undefined });
    assert.equal(userAgent(), 'AMA Loja (contato)');
    aplicarAmbiente({ MELHOR_ENVIO_EMAIL: 'tec@ama.org\r\nX-Injetado: 1' });
    assert.equal(userAgent(), 'AMA Loja (tec@ama.orgX-Injetado1)');
  });

  test('envia Authorization Bearer, User-Agent, Accept e Content-Type JSON', async () => {
    await calcular({ de: '67125-866', para: '01310-100', produtos: [PRODUTO_LEVE], servicos: [1] });
    const r = ultima();
    assert.equal(r.metodo, 'POST');
    assert.equal(r.caminho, '/shipment/calculate');
    assert.equal(r.cabecalhos.authorization, 'Bearer token-de-teste');
    assert.equal(r.cabecalhos['user-agent'], 'AMA Loja (tec@ama.org)');
    assert.equal(r.cabecalhos.accept, 'application/json');
    assert.equal(r.cabecalhos['content-type'], 'application/json');
  });

  test('o falso recusa sem token (401) e sem User-Agent no formato (400)', async () => {
    const semToken = await fetch(`${falso.url}/api/v2/me/balance`, { headers: { 'User-Agent': 'AMA Loja (tec@ama.org)' } });
    assert.equal(semToken.status, 401);
    assert.deepEqual(await semToken.json(), { message: 'Unauthenticated.' });
    const semUa = await fetch(`${falso.url}/api/v2/me/balance`, { headers: { Authorization: 'Bearer x' } });
    assert.equal(semUa.status, 400);
  });

  test('token recusado pela API → 502 com mensagem sobre o token', async () => {
    falso.estado.token = 'outro-token';
    await rejeita(saldo(), { status: 502, erro: 'falha_melhor_envio', mensagem: /token do Melhor Envio é inválido/ });
  });
});

// ---------------------------------------------------------------------------
describe('calcular', () => {
  test('corpo por products: CEPs só com dígitos, services em CSV, sem volumes', async () => {
    await calcular({ de: { postal_code: '67125-866' }, para: '01310-100', produtos: [PRODUTO_LEVE], servicos: [1, 2, 17, 1] });
    const { corpo } = ultima();
    assert.deepEqual(corpo.from, { postal_code: '67125866' });
    assert.deepEqual(corpo.to, { postal_code: '01310100' });
    assert.equal(corpo.services, '1,2,17');
    assert.equal(corpo.volumes, undefined);
    assert.deepEqual(corpo.products, [PRODUTO_LEVE]);
    assert.deepEqual(corpo.options, { receipt: false, own_hand: false });
  });

  test('normaliza: preço STRING → centavos, prazo, empresa, pacotes; serviço com erro mantido com erro', async () => {
    const servicos = await calcular({ de: '67125866', para: '01310100', produtos: [PRODUTO_LEVE], servicos: '1,2,17' });
    assert.equal(servicos.length, 3);
    const [pac, sedex, mini] = servicos;
    // PAC: 18,50 + 4,10 (1 kg) + 1% de R$ 90 de seguro = 23,50.
    assert.deepEqual(
      { ...pac, pacotes: undefined },
      { servico_id: 1, nome: 'PAC', empresa: 'Correios', preco_centavos: 2350, prazo_dias: 8, erro: null, pacotes: undefined },
    );
    assert.deepEqual(pac.pacotes, [{
      preco_centavos: 2350, peso_kg: 0.6, altura_cm: 8, largura_cm: 12, comprimento_cm: 16, seguro_centavos: 9000,
      formato: 'box', produtos: [{ id: 'p-leve', quantidade: 2 }],
    }]);
    assert.equal(sedex.preco_centavos, 3830);
    assert.equal(sedex.prazo_dias, 3);
    // Mini Envios: 600 g não cabem no limite de 300 g.
    assert.equal(mini.servico_id, 17);
    assert.equal(mini.preco_centavos, null);
    assert.match(mini.erro, /não cabem/);
    assert.deepEqual(mini.pacotes, []);
  });

  test('usa custom_price e custom_delivery_time quando existem', async () => {
    falso.estado.ajustesServicos = { 1: { custom_price: '19.90', custom_delivery_time: 12 } };
    falso.estado.prazoExtraConta = 1;
    const [pac, sedex] = await calcular({ de: '67125866', para: '01310100', produtos: [PRODUTO_LEVE], servicos: [1, 2] });
    assert.equal(pac.preco_centavos, 1990);
    assert.equal(pac.prazo_dias, 12);
    assert.equal(sedex.prazo_dias, 4); // custom_delivery_time = 3 + 1
  });

  test('preço número também é aceito; ilegível, zero ou ambíguo descarta o serviço (nunca vira 0)', async () => {
    falso.estado.ajustesServicos = { 2: { price: 31.5, custom_price: null } };
    let lista = await calcular({ de: '67125866', para: '01310100', produtos: [PRODUTO_LEVE], servicos: [1, 2] });
    assert.equal(lista.find((s) => s.servico_id === 2).preco_centavos, 3150);

    falso.estado.ajustesServicos = { 1: { custom_price: 'abc' }, 2: { price: '0.00', custom_price: '0.00' } };
    lista = await calcular({ de: '67125866', para: '01310100', produtos: [PRODUTO_LEVE], servicos: [1, 2] });
    assert.deepEqual(lista, []);

    falso.estado.ajustesServicos = { 1: { custom_price: '1.234' }, 2: { price: undefined, custom_price: undefined } };
    lista = await calcular({ de: '67125866', para: '01310100', produtos: [PRODUTO_LEVE], servicos: [1, 2] });
    assert.deepEqual(lista, []);
  });

  test('cotação de um serviço só (a API devolve objeto, não lista)', async () => {
    const direto = await fetch(`${falso.url}/api/v2/me/shipment/calculate`, {
      method: 'POST',
      headers: { Authorization: 'Bearer x', 'User-Agent': 'AMA Loja (tec@ama.org)', 'Content-Type': 'application/json' },
      body: JSON.stringify(montarCorpoCotacao({ de: '67125866', para: '01310100', produtos: [PRODUTO_LEVE], servicos: [2] })),
    });
    const bruto = await direto.json();
    assert.ok(!Array.isArray(bruto));
    assert.equal(bruto.price, '38.30');

    const lista = await calcular({ de: '67125866', para: '01310100', produtos: [PRODUTO_LEVE], servicos: [2] });
    assert.equal(lista.length, 1);
    assert.equal(lista[0].servico_id, 2);
    assert.equal(lista[0].preco_centavos, 3830);
  });

  test('o falso aplica os mínimos dos Correios (1 x 8 x 13 cm): abaixo disso o serviço vem com erro', async () => {
    const pequeno = { id: 'mini', width: 5, height: 0.5, length: 10, weight: 0.05, insurance_value: 0, quantity: 1 };
    const [pac] = await calcular({ de: '67125866', para: '01310100', produtos: [pequeno], servicos: [1] });
    assert.match(pac.erro, /mínimo/);
  });

  test('por volumes: chave "insurance" (reais) vinda de valorSeguro em centavos', async () => {
    const lista = await calcular({
      de: '67125866', para: '01310100', volumes: { width: 12, height: 8, length: 16, weight: 0.6 }, valorSeguro: 9000, servicos: [1],
    });
    assert.deepEqual(ultima().corpo.volumes, [{ width: 12, height: 8, length: 16, weight: 0.6, insurance: 90 }]);
    assert.equal(ultima().corpo.products, undefined);
    assert.equal(lista[0].preco_centavos, 2350);
  });

  test('entrada inválida → 400 sem chamar a API', async () => {
    await rejeita(calcular({ de: '123', para: '01310100', produtos: [PRODUTO_LEVE] }), { status: 400, erro: 'cep_invalido' });
    await rejeita(calcular({ de: '67125866', para: 'abc', produtos: [PRODUTO_LEVE] }), { status: 400, erro: 'cep_invalido' });
    await rejeita(calcular({ de: '67125866', para: '01310100' }), { status: 400, erro: 'sem_volumes' });
    await rejeita(calcular({ de: '67125866', para: '01310100', produtos: [{ id: 'x', width: 1 }] }), { status: 400, erro: 'produto_invalido' });
    assert.equal(falso.estado.requisicoes.length, 0);
  });

  test('HTTP 500 → 502 falha_melhor_envio com o corpo cru em extra', async () => {
    falso.estado.forcar('/shipment/calculate', { status: 500, corpo: { message: 'Server Error' } });
    await assert.rejects(calcular({ de: '67125866', para: '01310100', produtos: [PRODUTO_LEVE] }), (e) => {
      assert.equal(e.status, 502);
      assert.equal(e.erro, 'falha_melhor_envio');
      assert.match(e.mensagem, /calcular o frete/);
      assert.match(e.mensagem, /instável/);
      assert.equal(e.extra.status_melhor_envio, 500);
      assert.equal(e.extra.resposta_melhor_envio, '{"message":"Server Error"}');
      return true;
    });
  });

  test('422 com errors: a mensagem traz o detalhe da validação', async () => {
    falso.estado.forcar('/shipment/calculate', {
      status: 422, corpo: { message: 'The given data was invalid.', errors: { 'to.postal_code': ['CEP inexistente.'] } },
    });
    await rejeita(calcular({ de: '67125866', para: '01310100', produtos: [PRODUTO_LEVE] }), {
      status: 502, mensagem: /recusou os dados.*to\.postal_code: CEP inexistente\./,
    });
  });

  test('429: espera e tenta de novo uma vez', async () => {
    falso.estado.forcar('/shipment/calculate', { status: 429, corpo: { message: 'Too Many Attempts.' }, cabecalhos: { 'Retry-After': '0' } });
    const lista = await calcular({ de: '67125866', para: '01310100', produtos: [PRODUTO_LEVE], servicos: [1] });
    assert.equal(lista[0].preco_centavos, 2350);
    assert.equal(chamadasPara('/shipment/calculate').length, 2);
  });

  test('429 repetido → 502 depois de duas tentativas', async () => {
    falso.estado.forcar('/shipment/calculate', { status: 429, corpo: { message: 'Too Many Attempts.' }, cabecalhos: { 'Retry-After': '0' }, vezes: 5 });
    await assert.rejects(calcular({ de: '67125866', para: '01310100', produtos: [PRODUTO_LEVE] }), (e) => {
      assert.equal(e.status, 502);
      assert.equal(e.extra.status_melhor_envio, 429);
      assert.match(e.mensagem, /Muitas requisições/);
      return true;
    });
    assert.equal(chamadasPara('/shipment/calculate').length, 2);
  });

  test('timeout → 502 "não respondeu a tempo"', async () => {
    falso.estado.forcar('/shipment/calculate', { status: 200, corpo: [], atrasoMs: 400 });
    await rejeita(calcular({ de: '67125866', para: '01310100', produtos: [PRODUTO_LEVE], timeoutMs: 50 }), {
      status: 502, erro: 'falha_melhor_envio', mensagem: /não respondeu a tempo/,
    });
  });

  test('resposta 200 que não é JSON → 502', async () => {
    falso.estado.forcar('/shipment/calculate', { status: 200, bruto: '<html>manutenção</html>' });
    await assert.rejects(calcular({ de: '67125866', para: '01310100', produtos: [PRODUTO_LEVE] }), (e) => {
      assert.equal(e.status, 502);
      assert.match(e.mensagem, /ilegível/);
      assert.equal(e.extra.resposta_melhor_envio, '<html>manutenção</html>');
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
describe('funções puras', () => {
  test('listaServicos', () => {
    assert.deepEqual(listaServicos([1, '2', 2, 'x', -1, 0, 17]), [1, 2, 17]);
    assert.deepEqual(listaServicos('1, 2,abc,17'), [1, 2, 17]);
    assert.deepEqual(listaServicos(3), [3]);
    assert.deepEqual(listaServicos(null), []);
    assert.deepEqual(SERVICOS_CORREIOS, [1, 2, 17]);
  });

  test('montarCorpoCotacao: products tem prioridade sobre volumes; nunca os dois', () => {
    const corpo = montarCorpoCotacao({
      de: 67125866, para: '01310100', produtos: [PRODUTO_LEVE], volumes: [{ width: 1, height: 1, length: 1, weight: 1 }],
    });
    assert.ok(corpo.products);
    assert.equal(corpo.volumes, undefined);
    assert.equal(corpo.services, undefined);
  });

  test('montarCorpoCotacao: valorSeguro dividido entre volumes sem insurance', () => {
    const corpo = montarCorpoCotacao({
      de: '67125866', para: '01310100', valorSeguro: 1001,
      volumes: [{ width: 12, height: 4, length: 16, weight: 1 }, { width: 12, height: 4, length: 16, weight: 1 }, { width: 12, height: 4, length: 16, weight: 1, insurance: 5 }],
    });
    assert.deepEqual(corpo.volumes.map((v) => v.insurance), [5.01, 5, 5]);
  });

  test('normalizarServicos: entradas estranhas não quebram', () => {
    assert.deepEqual(normalizarServicos(null), []);
    assert.deepEqual(normalizarServicos('x'), []);
    assert.deepEqual(normalizarServicos([null, 1, { id: 'abc', price: '10.00' }]), []);
    const [s] = normalizarServicos({ id: 3, name: '.Package', error: 'Transportadora não atende o trecho.' });
    assert.deepEqual(s, {
      servico_id: 3, nome: '.Package', empresa: null, preco_centavos: null, prazo_dias: null,
      erro: 'Transportadora não atende o trecho.', pacotes: [],
    });
    const [faixa] = normalizarServicos([{ id: 1, name: 'PAC', price: '20,00', delivery_range: { min: 5, max: 9 }, company: { name: 'Correios' } }]);
    assert.equal(faixa.preco_centavos, 2000);
    assert.equal(faixa.prazo_dias, 9);
  });

  test('montarItensCarrinho: pacote único, documentos, NF-e e tags', () => {
    const [corpo, ...resto] = montarItensCarrinho({
      servicoId: '1',
      pacotes: [{ altura_cm: 8, largura_cm: 12, comprimento_cm: 16, peso_kg: 0.6, produtos: [] }],
      remetente: ORIGEM,
      destinatario: DESTINATARIO,
      itens: [{ produto_id: 'p1', nome: 'Body Splash Raiz', quantidade: 2, preco_unitario_centavos: 4500 }],
      chaveNfe: '1'.repeat(44),
      tag: 'pedido-1001',
      urlPedido: 'https://ama.org.br/loja/pedido?id=1',
    });
    assert.equal(resto.length, 0);
    assert.equal(corpo.service, 1);
    assert.equal(corpo.from.company_document, '11222333000181');
    assert.equal(corpo.from.document, undefined);
    assert.equal(corpo.from.phone, '91999990000');
    assert.equal(corpo.from.postal_code, '67125866');
    assert.equal(corpo.from.state_abbr, 'PA');
    assert.equal(corpo.to.document, '52998224725');
    assert.equal(corpo.to.address, 'Avenida Paulista');
    assert.equal(corpo.to.postal_code, '01310100');
    assert.deepEqual(corpo.products, [{ name: 'Body Splash Raiz', quantity: 2, unitary_value: 45 }]);
    assert.deepEqual(corpo.volumes, [{ height: 8, width: 12, length: 16, weight: 0.6 }]);
    assert.equal(corpo.options.insurance_value, 90);
    assert.equal(corpo.options.non_commercial, false);
    assert.deepEqual(corpo.options.invoice, { key: '1'.repeat(44) });
    assert.deepEqual(corpo.options.tags, [{ tag: 'pedido-1001', url: 'https://ama.org.br/loja/pedido?id=1' }]);
    assert.equal(corpo.agency, undefined);
  });

  test('montarItensCarrinho: sem NF-e é declaração de conteúdo; erros de entrada', () => {
    const base = {
      servicoId: 2,
      pacotes: [{ altura_cm: 8, largura_cm: 12, comprimento_cm: 16, peso_kg: 0.6 }],
      remetente: ORIGEM,
      destinatario: DESTINATARIO,
      itens: [{ produto_id: 'p1', nome: 'Sabonete', quantidade: 1, preco_unitario_centavos: 2000 }],
    };
    const [corpo] = montarItensCarrinho(base);
    assert.equal(corpo.options.non_commercial, true);
    assert.equal(corpo.options.invoice, undefined);
    assert.throws(() => montarItensCarrinho({ ...base, chaveNfe: '123' }), { erro: 'chave_nfe_invalida' });
    assert.throws(() => montarItensCarrinho({ ...base, servicoId: 'x' }), { erro: 'servico_invalido' });
    assert.throws(() => montarItensCarrinho({ ...base, pacotes: [] }), { erro: 'sem_pacotes' });
    assert.throws(() => montarItensCarrinho({ ...base, itens: [] }), { erro: 'sem_itens' });
    assert.throws(() => montarItensCarrinho({ ...base, destinatario: { ...DESTINATARIO, cep: '1' } }), { erro: 'cep_invalido' });
    assert.throws(() => montarItensCarrinho({ ...base, pacotes: [base.pacotes[0], base.pacotes[0]] }), { erro: 'pacotes_sem_produtos' });
    assert.throws(() => montarItensCarrinho({ ...base, pacotes: [{ altura_cm: 8 }] }), { erro: 'pacote_invalido' });
  });

  test('montarItensCarrinho: origem incompleta e documentos obrigatórios nos Correios', () => {
    const base = {
      servicoId: 1,
      pacotes: [{ altura_cm: 8, largura_cm: 12, comprimento_cm: 16, peso_kg: 0.6 }],
      remetente: ORIGEM,
      destinatario: DESTINATARIO,
      itens: [{ produto_id: 'p1', nome: 'Sabonete', quantidade: 1, preco_unitario_centavos: 2000 }],
    };
    assert.throws(() => montarItensCarrinho({ ...base, remetente: { ...ORIGEM, endereco: '' } }), { status: 400, erro: 'origem_incompleta' });
    assert.throws(() => montarItensCarrinho({ ...base, destinatario: { ...DESTINATARIO, cidade: '' } }), { erro: 'destino_incompleto' });
    assert.throws(() => montarItensCarrinho({ ...base, remetente: { ...ORIGEM, documento: '' } }), { erro: 'documento_obrigatorio', mensagem: /remetente/ });
    assert.throws(() => montarItensCarrinho({ ...base, destinatario: { ...DESTINATARIO, cpf: '' } }), { erro: 'documento_obrigatorio', mensagem: /destinatário/ });
    // Fora dos Correios o documento não é exigido aqui (a transportadora decide).
    assert.equal(montarItensCarrinho({ ...base, servicoId: 3, remetente: { ...ORIGEM, documento: '' } }).length, 1);
  });

  test('destinatarioDoPedido: linha de pedidos → destinatário', () => {
    const pedido = {
      cliente_nome: 'Maria da Silva', cliente_cpf: '52998224725', cliente_telefone: '11988887777', cliente_email: 'maria@exemplo.com',
      endereco: { cep: '01310100', logradouro: 'Avenida Paulista', numero: '1000', complemento: '', bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'SP' },
    };
    const destinatario = destinatarioDoPedido(pedido);
    assert.deepEqual(destinatario, {
      nome: 'Maria da Silva', documento: '52998224725', telefone: '11988887777', email: 'maria@exemplo.com', cep: '01310100',
      logradouro: 'Avenida Paulista', numero: '1000', complemento: '', bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'SP',
    });
    const [corpo] = montarItensCarrinho({
      servicoId: 2,
      pacotes: [{ altura_cm: 8, largura_cm: 12, comprimento_cm: 16, peso_kg: 0.6 }],
      remetente: ORIGEM,
      destinatario,
      itens: [{ produto_id: 'p1', nome: 'Sabonete', quantidade: 1, preco_unitario_centavos: 2000 }],
    });
    assert.deepEqual(corpo.to, {
      name: 'Maria da Silva', phone: '11988887777', email: 'maria@exemplo.com', address: 'Avenida Paulista', complement: '',
      number: '1000', district: 'Bela Vista', city: 'São Paulo', state_abbr: 'SP', country_id: 'BR', postal_code: '01310100',
      document: '52998224725',
    });
    assert.deepEqual(destinatarioDoPedido(null).nome, undefined);
  });
});

// ---------------------------------------------------------------------------
describe('saldo', () => {
  test('número ou string → centavos', async () => {
    falso.estado.saldoCentavos = 12_345;
    assert.equal(await saldo(), 12_345);
    assert.equal(ultima().caminho, '/balance');
    falso.estado.forcar('/balance', { status: 200, corpo: { balance: '1234.56' } });
    assert.equal(await saldo(), 123_456);
  });

  test('saldo ilegível → 502', async () => {
    falso.estado.forcar('/balance', { status: 200, corpo: { balance: 'muito' } });
    await rejeita(saldo(), { status: 502, mensagem: /saldo ilegível/ });
  });
});

// ---------------------------------------------------------------------------
describe('carrinho → comprar → gerar → imprimir → rastrear', () => {
  const ITENS_PEDIDO = [
    { produto_id: 'p-pesado', nome: 'Kit grande', quantidade: 3, preco_unitario_centavos: 10_000 },
    { produto_id: 'p-leve', nome: 'Sabonete Sólido', quantidade: 1, preco_unitario_centavos: 4_500 },
  ];
  const PRODUTOS_COTACAO = [
    { id: 'p-pesado', width: 30, height: 20, length: 40, weight: 12, insurance_value: 100, quantity: 3 },
    { id: 'p-leve', width: 12, height: 4, length: 16, weight: 0.3, insurance_value: 45, quantity: 1 },
  ];

  test('fluxo completo com dois pacotes (uma etiqueta por pacote) e geração assíncrona', async () => {
    falso.estado.atrasoGeracaoMs = 60_000; // só conclui pela 2ª consulta
    const [pac] = await calcular({ de: ORIGEM.cep, para: DESTINATARIO.cep, produtos: PRODUTOS_COTACAO, servicos: [1] });
    assert.equal(pac.erro, null);
    assert.equal(pac.pacotes.length, 2);
    assert.deepEqual(pac.pacotes.map((p) => p.produtos), [
      [{ id: 'p-pesado', quantidade: 2 }],
      [{ id: 'p-pesado', quantidade: 1 }, { id: 'p-leve', quantidade: 1 }],
    ]);

    const corpos = montarItensCarrinho({
      servicoId: pac.servico_id, pacotes: pac.pacotes, remetente: ORIGEM, destinatario: DESTINATARIO,
      itens: ITENS_PEDIDO, tag: 'pedido-1001',
    });
    assert.equal(corpos.length, 2);
    assert.deepEqual(corpos[0].products, [{ name: 'Kit grande', quantity: 2, unitary_value: 100 }]);
    assert.equal(corpos[0].options.insurance_value, 200);
    assert.deepEqual(corpos[1].products, [
      { name: 'Kit grande', quantity: 1, unitary_value: 100 }, { name: 'Sabonete Sólido', quantity: 1, unitary_value: 45 },
    ]);
    assert.equal(corpos[1].options.insurance_value, 145);
    assert.deepEqual(corpos.map((c) => c.options.tags[0].tag), ['pedido-1001-1', 'pedido-1001-2']);
    assert.ok(corpos.every((c) => c.volumes.length === 1));

    const itens = await adicionarAoCarrinho(corpos);
    assert.equal(itens.length, 2);
    for (const item of itens) {
      assert.match(item.id, /^[0-9a-f-]{36}$/);
      assert.equal(item.servico_id, 1);
      assert.equal(item.status, 'pending');
      assert.ok(item.preco_centavos > 0);
    }
    const envios = chamadasPara('/cart');
    assert.equal(envios.length, 2);
    assert.ok(envios.every((r) => r.corpo.service === 1 && r.corpo.volumes.length === 1));
    assert.deepEqual(falso.estado.carrinho, itens.map((i) => i.id));

    const ids = itens.map((i) => i.id);
    const total = itens.reduce((s, i) => s + i.preco_centavos, 0);
    const saldoAntes = falso.estado.saldoCentavos;
    const compra = await comprar(ids, { valorCentavos: total });
    assert.equal(chamadasPara('/balance').length, 1, 'confere o saldo antes de comprar');
    assert.deepEqual(chamadasPara('/shipment/checkout')[0].corpo, { orders: ids });
    assert.equal(compra.total_centavos, total);
    assert.match(compra.protocolo, /^PUR-/);
    assert.deepEqual(compra.ordens.map((o) => o.id), ids);
    assert.equal(falso.estado.saldoCentavos, saldoAntes - total);
    assert.deepEqual(falso.estado.carrinho, []);

    const geracao = await gerar(ids);
    assert.deepEqual(Object.keys(geracao), ids);
    assert.ok(Object.values(geracao).every((g) => g.ok));

    // Logo depois do generate ainda não há generated_at: imprimir recusa sem chamar /shipment/print.
    await assert.rejects(imprimir(ids), (e) => {
      assert.equal(e.status, 409);
      assert.equal(e.erro, 'etiqueta_em_geracao');
      assert.deepEqual(e.extra.pendentes, ids);
      return true;
    });
    assert.equal(chamadasPara('/shipment/print').length, 0);

    const espera = await aguardarGeracao(ids, { tentativas: 3, intervaloMs: 5 });
    assert.deepEqual(espera.geradas, ids);
    assert.deepEqual(espera.pendentes, []);
    assert.ok(espera.etiquetas[ids[0]].generated_at);

    const { url } = await imprimir(ids);
    assert.match(url, new RegExp(`^${falso.url}/imprimir/`));
    assert.deepEqual(falso.estado.ultimaImpressao, { mode: 'public', orders: ids });
    assert.deepEqual(chamadasPara('/shipment/print')[0].corpo, { mode: 'public', orders: ids });

    const rastreio = await rastrear(ids);
    for (const id of ids) {
      assert.match(rastreio[id].codigo_rastreio, /^AM\d{9}BR$/);
      assert.match(rastreio[id].codigo_melhor_envio, /^ME\d+/);
      assert.equal(rastreio[id].url_rastreio, `https://www.melhorrastreio.com.br/rastreio/${rastreio[id].codigo_rastreio}`);
      assert.equal(rastreio[id].status, 'released');
    }

    const etiqueta = await obterEtiqueta(ids[0]);
    assert.equal(etiqueta.gerada, true);
    assert.equal(etiqueta.paga, true);
    assert.equal(etiqueta.cancelada, false);
    assert.equal(etiqueta.codigo_rastreio, rastreio[ids[0]].codigo_rastreio);

    // Gerar de novo: "já está gerado" conta como ok.
    const deNovo = await gerar(ids[0]);
    assert.equal(deNovo[ids[0]].ok, true);
    assert.match(deNovo[ids[0]].mensagem, /já está gerado/);

    const cancelamento = await cancelar(ids[1]);
    assert.equal(cancelamento.cancelada, true);
    assert.deepEqual(chamadasPara('/shipment/cancel')[0].corpo.order.reason_id, 2);
    assert.equal((await obterEtiqueta(ids[1])).cancelada, true);
  });

  test('a geração também conclui sozinha depois do atraso', async () => {
    falso.estado.atrasoGeracaoMs = 30;
    const [pac] = await calcular({ de: ORIGEM.cep, para: DESTINATARIO.cep, produtos: [PRODUTO_LEVE], servicos: [1] });
    const corpos = montarItensCarrinho({
      servicoId: 1, pacotes: pac.pacotes, remetente: ORIGEM, destinatario: DESTINATARIO,
      itens: [{ produto_id: 'p-leve', nome: 'Sabonete', quantidade: 2, preco_unitario_centavos: 4500 }],
    });
    const [item] = await adicionarAoCarrinho(corpos);
    await comprar(item.id);
    await gerar([item.id]);
    await new Promise((r) => { setTimeout(r, 60); });
    const { url } = await imprimir([item.id]);
    assert.ok(url);
  });

  test('saldo insuficiente: 409 antes do checkout (com valorCentavos) ou pela resposta da API', async () => {
    const [pac] = await calcular({ de: ORIGEM.cep, para: DESTINATARIO.cep, produtos: [PRODUTO_LEVE], servicos: [2] });
    const [item] = await adicionarAoCarrinho(montarItensCarrinho({
      servicoId: 2, pacotes: pac.pacotes, remetente: ORIGEM, destinatario: DESTINATARIO,
      itens: [{ produto_id: 'p-leve', nome: 'Sabonete', quantidade: 2, preco_unitario_centavos: 4500 }],
    }));
    falso.estado.saldoCentavos = 100;
    await assert.rejects(comprar([item.id], { valorCentavos: item.preco_centavos }), (e) => {
      assert.equal(e.status, 409);
      assert.equal(e.erro, 'saldo_insuficiente');
      assert.match(e.mensagem, /disponível R\$ 1,00/);
      assert.equal(e.extra.saldo_centavos, 100);
      return true;
    });
    assert.equal(chamadasPara('/shipment/checkout').length, 0);

    await rejeita(comprar([item.id]), { status: 409, erro: 'saldo_insuficiente' });
    assert.equal(chamadasPara('/shipment/checkout').length, 1);
    assert.deepEqual(falso.estado.carrinho, [item.id]);
  });

  test('carrinho: service vira inteiro; vários volumes nos Correios são recusados', async () => {
    const [corpo] = montarItensCarrinho({
      servicoId: 1,
      pacotes: [{ altura_cm: 8, largura_cm: 12, comprimento_cm: 16, peso_kg: 0.6 }],
      remetente: ORIGEM,
      destinatario: DESTINATARIO,
      itens: [{ produto_id: 'p1', nome: 'Sabonete', quantidade: 1, preco_unitario_centavos: 2000 }],
    });
    await adicionarAoCarrinho({ ...corpo, service: '1' });
    assert.equal(ultima().corpo.service, 1);

    await rejeita(adicionarAoCarrinho({ ...corpo, volumes: [corpo.volumes[0], corpo.volumes[0]] }), {
      status: 400, erro: 'volumes_demais',
    });
    await rejeita(adicionarAoCarrinho({ ...corpo, service: 'PAC' }), { status: 400, erro: 'servico_invalido' });
    assert.equal(chamadasPara('/cart').length, 1);

    // O próprio falso também recusa (como a API real).
    const resposta = await fetch(`${falso.url}/api/v2/me/cart`, {
      method: 'POST',
      headers: { Authorization: 'Bearer x', 'User-Agent': 'AMA Loja (tec@ama.org)', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...corpo, volumes: [corpo.volumes[0], corpo.volumes[0]] }),
    });
    assert.equal(resposta.status, 422);
    assert.match((await resposta.json()).message, /vários volumes/);
  });

  test('carrinho: erro da API vira 502 com a mensagem; sem id na resposta também', async () => {
    const [corpo] = montarItensCarrinho({
      servicoId: 1,
      pacotes: [{ altura_cm: 8, largura_cm: 12, comprimento_cm: 16, peso_kg: 0.6 }],
      remetente: ORIGEM,
      destinatario: DESTINATARIO,
      itens: [{ produto_id: 'p1', nome: 'Sabonete', quantidade: 1, preco_unitario_centavos: 2000 }],
    });
    falso.estado.forcar('/cart', { status: 500, corpo: { error: 'Houve um erro ao salvar o pedido no carrinho.' } });
    await rejeita(adicionarAoCarrinho(corpo), { status: 502, mensagem: /salvar o pedido no carrinho/ });
    falso.estado.forcar('/cart', { status: 201, corpo: { status: 'pending' } });
    await rejeita(adicionarAoCarrinho(corpo), { status: 502, mensagem: /id da etiqueta/ });
  });

  test('ids inválidos → 400 sem chamar a API; print sem url → 409', async () => {
    await rejeita(gerar([]), { status: 400, erro: 'etiqueta_invalida' });
    await rejeita(rastrear(['../balance']), { status: 400, erro: 'etiqueta_invalida' });
    await rejeita(obterEtiqueta('a/b'), { status: 400, erro: 'etiqueta_invalida' });
    assert.equal(falso.estado.requisicoes.length, 0);

    falso.estado.forcar('/shipment/print', { status: 200, corpo: {} });
    await rejeita(imprimir(['abc'], { conferirGeracao: false }), { status: 409, erro: 'etiqueta_em_geracao' });
  });

  test('etiqueta inexistente → 502 (404 do Melhor Envio)', async () => {
    await assert.rejects(obterEtiqueta('nao-existe'), (e) => {
      assert.equal(e.status, 502);
      assert.equal(e.extra.status_melhor_envio, 404);
      return true;
    });
  });
});
