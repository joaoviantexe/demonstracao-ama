// Testes de integração das APIs da loja e do painel (docs/ARQUITETURA.md §6.2 a §6.6) contra o Supabase local
// e os servidores falsos do Mercado Pago, do Melhor Envio e do Resend. Exige "supabase start" com a migração.
//
// Sobe o dev-server (scripts/dev-server.mjs) no próprio processo. Cria os próprios produtos, usuários e
// pedidos com sufixo aleatório e apaga tudo no after(); as configurações (loja, frete, notificacoes) são
// trocadas por valores de teste e restauradas no fim.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { AMBIENTE_VAZIO, subirServidor } from '../apoio/servidor.js';
import { ambienteLocal, cliente, clienteServico, criarUsuario, removerUsuario } from '../apoio/supabase-local.js';
import { assinarNotificacao, iniciar as iniciarMercadoPago } from '../apoio/mercadopago-falso.js';
import { iniciar as iniciarMelhorEnvio } from '../apoio/melhorenvio-falso.js';
import { limparCacheConfiguracoes } from '../../lib/loja.js';
import { limparCacheCotacoes } from '../../lib/frete.js';

const SUF = randomBytes(4).toString('hex');
const SENHA = `Senha-${SUF}-123`;
const EMAIL_ADMIN = `admin-loja-${SUF}@teste.ama.local`;
const EMAIL_COMUM = `comum-loja-${SUF}@teste.ama.local`;
const EMAIL_EQUIPE = `equipe-${SUF}@ama.local`;
const SEGREDO = 'segredo-teste';

const emailCliente = (nome = 'cliente') => `${nome}-${SUF}@exemplo.com.br`;
const CLIENTE = {
  nome: 'Maria da Silva Teste', email: emailCliente(), telefone: '(91) 98105-6049', cpf: '529.982.247-25',
};
const CPF_DIGITOS = '52998224725';
const ENDERECO_PA = {
  cep: '66010-000', logradouro: 'Avenida Presidente Vargas', numero: '100', complemento: 'Apto 1',
  bairro: 'Campina', cidade: 'Belém', uf: 'PA',
};
const ENDERECO_SP = {
  cep: '01310-100', logradouro: 'Avenida Paulista', numero: '1000', complemento: '',
  bairro: 'Bela Vista', cidade: 'São Paulo', uf: 'SP',
};

const FRETE_TESTE = {
  origem: {
    cep: '67125866', nome: 'AMA - Associação de Mulheres na Amazônia', telefone: '91999990000', email: 'loja@ama.local',
    documento: '11222333000181', endereco: 'Conjunto Uirapuru, Quadra 28', numero: '02', complemento: 'Casa 02',
    bairro: 'Icuí-Guajará', cidade: 'Ananindeua', uf: 'PA',
  },
  fixo: { ativo: true, opcoes: [{ id: 'fixo-1', nome: 'Entrega local', preco_centavos: 1500, prazo_dias: 3, ufs: ['PA'] }] },
  melhor_envio: { ativo: true, servicos: [1, 2], seguro: true, prazo_extra_dias: 2, taxa_extra_centavos: 0 },
  embalagem_padrao: { peso_gramas: 300, altura_cm: 4, largura_cm: 12, comprimento_cm: 16 },
};

let servico;
let servidor;
let base;
let mp;
let me;
let resend;
let configOriginal = {};
let usuarioAdmin;
let usuarioComum;
let tokenAdmin;
let tokenComum;
const produtosCriados = [];

const P = {};

// ---------------------------------------------------------------------------
// Apoio

async function semErro(promessa, contexto) {
  const { data, error } = await promessa;
  if (error) throw new Error(`${contexto}: ${error.message} (${error.code || ''}) ${error.details || ''}`);
  return data;
}

let contador = 0;
async function criarProduto(campos = {}) {
  contador += 1;
  const produto = await semErro(servico.from('produtos').insert({
    nome: `Produto loja ${SUF} ${contador}`,
    slug: `loja-${SUF}-${contador}`,
    preco_centavos: 1000,
    estoque: 10,
    ativo: true,
    imagens: [{ src: `/img/produtos/teste-${contador}.jpg`, alt: 'Foto' }],
    ...campos,
  }).select().single(), 'criar produto');
  produtosCriados.push(produto.id);
  return produto;
}

async function definirConfig(chave, valor) {
  await semErro(servico.from('configuracoes').update({ valor }).eq('chave', chave), `config ${chave}`);
  limparCacheConfiguracoes();
}

async function api(caminho, { metodo = 'GET', corpo, token, cabecalhos = {} } = {}) {
  const headers = { ...cabecalhos };
  if (corpo !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const resposta = await fetch(`${base}${caminho}`, {
    method: metodo,
    headers,
    body: corpo === undefined ? undefined : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)),
    redirect: 'manual',
  });
  const texto = await resposta.text();
  let json = null;
  try {
    json = JSON.parse(texto);
  } catch {
    json = null;
  }
  return { status: resposta.status, json, texto, cabecalhos: resposta.headers };
}

const cotar = (corpo) => api('/api/loja/cotacao', { metodo: 'POST', corpo });

function corpoCheckout(extra = {}) {
  return {
    itens: [{ produto_id: P.principal.id, quantidade: 1 }],
    frete_id: 'fixo-1',
    cliente: CLIENTE,
    endereco: ENDERECO_PA,
    ...extra,
  };
}

const checkout = (extra) => api('/api/loja/checkout', { metodo: 'POST', corpo: corpoCheckout(extra) });

async function checkoutOk(extra) {
  const r = await checkout(extra);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.ok, true);
  return r.json;
}

async function pedidoDoBanco(id) {
  const pedido = await semErro(servico.from('pedidos').select('*, pedido_itens(*), pedido_eventos(*)').eq('id', id).single(), 'ler pedido');
  pedido.pedido_eventos.sort((a, b) => a.id - b.id);
  pedido.pedido_itens.sort((a, b) => a.id - b.id);
  return pedido;
}

async function estoque(id) {
  const p = await semErro(servico.from('produtos').select('estoque').eq('id', id).single(), 'ler estoque');
  return p.estoque;
}

const eventos = (pedido, tipo) => pedido.pedido_eventos.filter((e) => e.tipo === tipo);

const prefIdDe = (initPoint) => decodeURIComponent(new URL(initPoint).pathname.split('/').pop());

// Clica num botão da página falsa do Mercado Pago (o falso manda o webhook e só depois redireciona).
async function pagarNaPagina(initPoint, acao) {
  const resposta = await fetch(`${initPoint}/${acao}`, { method: 'POST', redirect: 'manual' });
  await resposta.arrayBuffer();
  assert.equal(resposta.status, 302);
  const destino = new URL(resposta.headers.get('location'));
  return { destino, paymentId: destino.searchParams.get('payment_id') };
}

async function enviarWebhook({ dataId, query, corpo, assinatura, semAssinatura = false }) {
  const requestId = randomUUID();
  const cabecalhos = {};
  if (!semAssinatura) {
    cabecalhos['x-request-id'] = requestId;
    cabecalhos['x-signature'] = assinatura
      ?? assinarNotificacao({ dataId: String(dataId), xRequestId: requestId, ts: String(Date.now()), segredo: SEGREDO });
  }
  return api(`/api/webhooks/mercadopago?${query ?? `data.id=${encodeURIComponent(dataId)}&type=payment`}`, {
    metodo: 'POST',
    corpo: corpo ?? { type: 'payment', action: 'payment.updated', data: { id: String(dataId) } },
    cabecalhos,
  });
}

const consultarPedido = (id, token, extra = '') => api(`/api/loja/pedido?id=${id}&token=${token}${extra}`);

// Sem destino de webhook: simula notificação que não chegou.
async function semWebhook(fn) {
  const anterior = mp.estado.webhookUrl;
  mp.estado.webhookUrl = '';
  try {
    return await fn();
  } finally {
    mp.estado.webhookUrl = anterior;
  }
}

async function iniciarResendFalso() {
  const emails = [];
  const srv = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (p) => partes.push(p));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/emails') {
        let corpo = null;
        try {
          corpo = JSON.parse(Buffer.concat(partes).toString('utf8'));
        } catch {
          corpo = null;
        }
        emails.push({ cabecalhos: req.headers, corpo });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: randomUUID() }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"message":"not found"}');
    });
  });
  await new Promise((resolve) => { srv.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${srv.address().port}`,
    emails,
    fechar: () => new Promise((resolve) => { srv.close(() => resolve()); srv.closeAllConnections(); }),
  };
}

async function tokenDe(email) {
  const { data, error } = await cliente().auth.signInWithPassword({ email, password: SENHA });
  if (error) throw new Error(`login de ${email}: ${error.message}`);
  return data.session.access_token;
}

// ---------------------------------------------------------------------------
// Preparação

before(async () => {
  const local = ambienteLocal();
  assert.ok(local.serviceKey, 'Chave de serviço do Supabase local não encontrada (rode "supabase start").');
  servico = clienteServico();

  const linhas = await semErro(servico.from('configuracoes').select('chave, valor')
    .in('chave', ['loja', 'frete', 'notificacoes']), 'ler configurações');
  configOriginal = Object.fromEntries(linhas.map((l) => [l.chave, l.valor]));

  mp = await iniciarMercadoPago({ segredo: SEGREDO });
  me = await iniciarMelhorEnvio();
  resend = await iniciarResendFalso();

  servidor = await subirServidor({
    ...AMBIENTE_VAZIO,
    MP_MODO: undefined,
    SUPABASE_URL: local.url,
    SUPABASE_ANON_KEY: local.anonKey,
    SUPABASE_SERVICE_ROLE_KEY: local.serviceKey,
    MP_ACCESS_TOKEN: 'APP_USR-teste-loja',
    MP_WEBHOOK_SECRET: SEGREDO,
    MP_API_BASE: mp.url,
    MELHOR_ENVIO_TOKEN: 'token-melhor-envio-teste',
    MELHOR_ENVIO_API_BASE: me.url,
    MELHOR_ENVIO_EMAIL: 'tecnico@ama.local',
    RESEND_API_KEY: 're_teste_loja',
    RESEND_API_BASE: resend.url,
    EMAIL_REMETENTE: 'AMA <loja@ama.local>',
  });
  base = servidor.url;
  process.env.SITE_URL = base; // só conhecida depois de subir (restaurada pelo fechar())
  mp.estado.webhookUrl = `${base}/api/webhooks/mercadopago`;

  await definirConfig('frete', FRETE_TESTE);
  await definirConfig('loja', { ...(configOriginal.loja || {}), frete_gratis_acima_centavos: null });
  await definirConfig('notificacoes', { email_admin: EMAIL_EQUIPE });
  limparCacheCotacoes();

  P.principal = await criarProduto({ preco_centavos: 4500, estoque: 50 });
  P.promo = await criarProduto({ preco_centavos: 3000, preco_promocional_centavos: 2500, estoque: 20 });
  P.semPreco = await criarProduto({ preco_centavos: 0, estoque: 10 });
  P.inativo = await criarProduto({ preco_centavos: 1000, ativo: false });
  P.ultimo = await criarProduto({ preco_centavos: 1990, estoque: 1 });
  P.envio = await criarProduto({ preco_centavos: 3500, estoque: 30, peso_gramas: 400, altura_cm: 5, largura_cm: 12, comprimento_cm: 18 });
  // 40 cm de altura: no PAC do falso, 3 unidades viram 2 pacotes (empilhadas passam de 100 cm).
  P.grande = await criarProduto({ preco_centavos: 5000, estoque: 30, peso_gramas: 1000, altura_cm: 40, largura_cm: 20, comprimento_cm: 30 });

  usuarioAdmin = await criarUsuario({ email: EMAIL_ADMIN, senha: SENHA, admin: true });
  usuarioComum = await criarUsuario({ email: EMAIL_COMUM, senha: SENHA });
  tokenAdmin = await tokenDe(EMAIL_ADMIN);
  tokenComum = await tokenDe(EMAIL_COMUM);
});

after(async () => {
  const erros = [];
  const tentar = async (fn, rotulo) => {
    try {
      await fn();
    } catch (erro) {
      erros.push(`${rotulo}: ${erro.message}`);
    }
  };
  if (servico) {
    await tentar(() => semErro(servico.from('pedidos').delete().like('cliente_email', `%-${SUF}@exemplo.com.br`), 'pedidos'), 'pedidos');
    if (produtosCriados.length) await tentar(() => semErro(servico.from('produtos').delete().in('id', produtosCriados), 'produtos'), 'produtos');
    for (const [chave, valor] of Object.entries(configOriginal)) {
      await tentar(() => semErro(servico.from('configuracoes').update({ valor }).eq('chave', chave), chave), `config ${chave}`);
    }
  }
  limparCacheConfiguracoes();
  limparCacheCotacoes();
  await tentar(() => removerUsuario(usuarioAdmin && usuarioAdmin.id), 'admin');
  await tentar(() => removerUsuario(usuarioComum && usuarioComum.id), 'comum');
  if (servidor) await servidor.fechar();
  if (mp) await mp.fechar();
  if (me) await me.fechar();
  if (resend) await resend.fechar();
  if (erros.length) throw new Error(`Limpeza incompleta: ${erros.join('; ')}`);
});

// ---------------------------------------------------------------------------
// Cotação

describe('POST /api/loja/cotacao', () => {
  test('método errado → 405; carrinho vazio → 400', async () => {
    const r = await api('/api/loja/cotacao');
    assert.equal(r.status, 405);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.erro, 'metodo_nao_permitido');

    const vazio = await cotar({ itens: [] });
    assert.equal(vazio.status, 400);
    assert.equal(vazio.json.erro, 'carrinho_vazio');

    const invalido = await api('/api/loja/cotacao', { metodo: 'POST', corpo: '{"itens":' });
    assert.equal(invalido.status, 400);
    assert.equal(invalido.json.erro, 'json_invalido');
  });

  test('sem CEP: itens e totais recalculados, frete null', async () => {
    const r = await cotar({
      itens: [
        { produto_id: P.principal.id, quantidade: 2 },
        { produto_id: P.promo.id, quantidade: 1 },
        { produto_id: P.principal.id, quantidade: 1 },
      ],
    });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.cabecalhos.get('cache-control'), 'no-store');
    const c = r.json;
    assert.equal(c.ok, true);
    assert.equal(c.frete, null);
    assert.deepEqual(Object.keys(c).sort(), ['frete', 'frete_gratis_acima_centavos', 'itens', 'ok', 'subtotal_centavos']);
    assert.equal(c.frete_gratis_acima_centavos, null);
    assert.equal(c.itens.length, 2, 'linhas repetidas do mesmo produto são juntadas');
    const principal = c.itens.find((i) => i.produto_id === P.principal.id);
    assert.equal(principal.quantidade, 3);
    assert.equal(principal.preco_unitario_centavos, 4500);
    assert.equal(principal.total_centavos, 13_500);
    assert.equal(principal.disponivel, true);
    assert.equal(principal.imagem, P.principal.imagens[0].src);
    const promo = c.itens.find((i) => i.produto_id === P.promo.id);
    assert.equal(promo.preco_unitario_centavos, 2500, 'preço promocional');
    assert.equal(c.subtotal_centavos, 16_000);
  });

  test('com CEP do PA: Melhor Envio + frete fixo, ordenados por preço (sem retirada)', async () => {
    limparCacheCotacoes();
    const antes = me.estado.requisicoes.length;
    const r = await cotar({ itens: [{ produto_id: P.principal.id, quantidade: 1 }], cep: '66010-000' });
    assert.equal(r.status, 200, r.texto);
    const { opcoes, erro } = r.json.frete;
    assert.equal(erro, null);
    assert.deepEqual(opcoes.map((o) => o.id), ['fixo-1', 'me-1', 'me-2']);

    // Falso do Melhor Envio: base + por kg + 1% do seguro (R$ 45,00): PAC 1850 + 410 + 45; SEDEX 2990 + 750 + 45.
    const pac = opcoes.find((o) => o.id === 'me-1');
    assert.deepEqual(pac, {
      id: 'me-1', tipo: 'melhor_envio', nome: 'PAC', empresa: 'Correios', prazo_dias: 10, prazo_texto: 'até 10 dias úteis',
      preco_centavos: 2305, preco_original_centavos: 2305, gratis: false, servico_id: 1,
    });
    const sedex = opcoes.find((o) => o.id === 'me-2');
    assert.equal(sedex.preco_centavos, 3785);
    assert.equal(sedex.prazo_dias, 5, 'prazo do serviço + prazo_extra_dias');
    const fixo = opcoes.find((o) => o.id === 'fixo-1');
    assert.equal(fixo.tipo, 'fixo');
    assert.equal(fixo.preco_centavos, 1500);
    assert.ok(opcoes.every((o) => o.tipo !== 'retirada'));

    const chamada = me.estado.requisicoes.slice(antes).find((q) => q.caminho === '/shipment/calculate');
    assert.ok(chamada, 'cotou no Melhor Envio');
    assert.equal(chamada.corpo.from.postal_code, '67125866');
    assert.equal(chamada.corpo.to.postal_code, '66010000');
    assert.equal(chamada.corpo.services, '1,2');
    assert.equal(chamada.corpo.products[0].insurance_value, 45);
    assert.match(chamada.cabecalhos['user-agent'], /^AMA Loja \(tecnico@ama\.local\)$/);
  });

  test('CEP de SP: o frete fixo (só PA) não aparece; CEP inválido: sem opções e com erro', async () => {
    const sp = await cotar({ itens: [{ produto_id: P.principal.id, quantidade: 1 }], cep: '01310100' });
    assert.equal(sp.status, 200, sp.texto);
    assert.deepEqual(sp.json.frete.opcoes.map((o) => o.id), ['me-1', 'me-2']);

    const invalido = await cotar({ itens: [{ produto_id: P.principal.id, quantidade: 1 }], cep: '123' });
    assert.equal(invalido.status, 200);
    assert.deepEqual(invalido.json.frete.opcoes, []);
    assert.match(invalido.json.frete.erro, /CEP/);
  });

  test('falha do Melhor Envio não derruba a cotação', async (t) => {
    t.mock.method(console, 'warn', () => {});
    limparCacheCotacoes();
    me.estado.forcar('/shipment/calculate', { status: 500 });
    const r = await cotar({ itens: [{ produto_id: P.principal.id, quantidade: 1 }], cep: '66010000' });
    assert.equal(r.status, 200, r.texto);
    assert.deepEqual(r.json.frete.opcoes.map((o) => o.id), ['fixo-1']);
    assert.match(r.json.frete.erro, /frete/);
    limparCacheCotacoes();
  });

  test('frete grátis acima do valor configurado: a opção paga mais barata fica grátis', async () => {
    await definirConfig('loja', { ...(configOriginal.loja || {}), frete_gratis_acima_centavos: 4000 });
    try {
      const r = await cotar({ itens: [{ produto_id: P.principal.id, quantidade: 1 }], cep: '66010-000' });
      assert.equal(r.status, 200, r.texto);
      assert.equal(r.json.frete_gratis_acima_centavos, 4000);
      const fixo = r.json.frete.opcoes.find((o) => o.id === 'fixo-1');
      assert.equal(fixo.gratis, true);
      assert.equal(fixo.preco_centavos, 0);
      assert.equal(fixo.preco_original_centavos, 1500);
      assert.equal(r.json.frete.opcoes.find((o) => o.id === 'me-1').gratis, false);

      const abaixo = await cotar({ itens: [{ produto_id: P.ultimo.id, quantidade: 1 }], cep: '66010-000' });
      assert.ok(abaixo.json.frete.opcoes.every((o) => o.gratis === false));
    } finally {
      await definirConfig('loja', { ...(configOriginal.loja || {}), frete_gratis_acima_centavos: null });
    }
  });

  test('campo cupom (removido) é ignorado', async () => {
    const r = await cotar({ itens: [{ produto_id: P.principal.id, quantidade: 2 }], cupom: 'AMA10' });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.subtotal_centavos, 9000);
    assert.equal('cupom' in r.json, false);
    assert.equal('desconto_centavos' in r.json, false);
  });

  test('itens indisponíveis: inativo, sem preço, estoque insuficiente e inexistente não somam', async () => {
    const r = await cotar({
      itens: [
        { produto_id: P.principal.id, quantidade: 1 },
        { produto_id: P.inativo.id, quantidade: 1 },
        { produto_id: P.semPreco.id, quantidade: 1 },
        { produto_id: P.ultimo.id, quantidade: 2 },
        { produto_id: randomUUID(), quantidade: 1 },
      ],
    });
    assert.equal(r.status, 200, r.texto);
    const porId = Object.fromEntries(r.json.itens.map((i) => [i.produto_id, i]));
    assert.equal(porId[P.inativo.id].motivo, 'inativo');
    assert.equal(porId[P.inativo.id].nome, null, 'produto despublicado não expõe dados');
    assert.equal(porId[P.semPreco.id].motivo, 'sem_preco');
    assert.equal(porId[P.semPreco.id].disponivel, false);
    assert.equal(porId[P.ultimo.id].motivo, 'estoque_insuficiente');
    assert.equal(porId[P.ultimo.id].estoque_disponivel, 1);
    assert.equal(r.json.itens.filter((i) => i.motivo === 'inexistente').length, 1);
    assert.equal(r.json.subtotal_centavos, 4500);
  });
});

// ---------------------------------------------------------------------------
// Checkout

describe('POST /api/loja/checkout', () => {
  test('método errado → 405', async () => {
    const r = await api('/api/loja/checkout');
    assert.equal(r.status, 405);
    assert.equal(r.json.erro, 'metodo_nao_permitido');
  });

  test('validações → 400 dados_invalidos com o campo', async () => {
    const semSobrenome = await checkout({ cliente: { ...CLIENTE, nome: 'Maria' } });
    assert.equal(semSobrenome.status, 400);
    assert.equal(semSobrenome.json.erro, 'dados_invalidos');
    assert.equal(semSobrenome.json.campo, 'cliente.nome');
    assert.ok(semSobrenome.json.mensagem);

    const cpf = await checkout({ cliente: { ...CLIENTE, cpf: '111.111.111-11' } });
    assert.equal(cpf.status, 400);
    assert.equal(cpf.json.erros['cliente.cpf'], 'CPF inválido.');

    const endereco = await checkout({ endereco: { ...ENDERECO_PA, cep: '', bairro: '' } });
    assert.equal(endereco.status, 400);
    assert.ok(endereco.json.erros['endereco.cep']);
    assert.ok(endereco.json.erros['endereco.bairro']);

    const semFrete = await checkout({ frete_id: '' });
    assert.equal(semFrete.status, 400);
    assert.ok(semFrete.json.erros.frete_id);
  });

  test('sem Mercado Pago configurado → 503 antes de criar o pedido', async () => {
    const email = emailCliente('semmp');
    const token = process.env.MP_ACCESS_TOKEN;
    delete process.env.MP_ACCESS_TOKEN;
    try {
      const r = await checkout({ cliente: { ...CLIENTE, email } });
      assert.equal(r.status, 503);
      assert.equal(r.json.erro, 'pagamento_indisponivel');
    } finally {
      process.env.MP_ACCESS_TOKEN = token;
    }
    const pedidos = await semErro(servico.from('pedidos').select('id').eq('cliente_email', email), 'pedidos');
    assert.equal(pedidos.length, 0);
  });

  test('frete inexistente ou que não atende o CEP → 409 frete_indisponivel', async () => {
    const r = await checkout({ frete_id: 'me-99' });
    assert.equal(r.status, 409);
    assert.equal(r.json.erro, 'frete_indisponivel');
    assert.ok(Array.isArray(r.json.frete.opcoes));

    const sp = await checkout({ frete_id: 'fixo-1', endereco: ENDERECO_SP });
    assert.equal(sp.status, 409);
    assert.equal(sp.json.erro, 'frete_indisponivel');
  });

  test('estoque insuficiente → 409 item_indisponivel com os itens atualizados', async () => {
    const r = await checkout({ itens: [{ produto_id: P.ultimo.id, quantidade: 3 }] });
    assert.equal(r.status, 409);
    assert.equal(r.json.erro, 'item_indisponivel');
    assert.equal(r.json.itens[0].motivo, 'estoque_insuficiente');
    assert.equal(r.json.itens[0].estoque_disponivel, 1);

    const semPreco = await checkout({ itens: [{ produto_id: P.semPreco.id, quantidade: 1 }] });
    assert.equal(semPreco.status, 409);
    assert.equal(semPreco.json.itens[0].motivo, 'sem_preco');
  });

  test('sucesso: pedido criado, preferência no Mercado Pago e redirecionar = init_point', async () => {
    const r = await checkoutOk({
      itens: [{ produto_id: P.principal.id, quantidade: 2 }],
      frete_id: 'me-1',
      cupom: 'AMA10', // campo antigo: ignorado
    });
    assert.match(r.pedido.id, /^[0-9a-f-]{36}$/);
    assert.ok(Number.isSafeInteger(r.pedido.numero) && r.pedido.numero >= 1001);
    assert.match(r.pedido.token, /^[0-9a-f]{64}$/);

    const pref = mp.estado.ultimaPreferencia();
    assert.equal(r.redirecionar, pref.init_point);
    assert.equal(pref.external_reference, r.pedido.id);
    assert.equal(pref.cabecalhos['x-idempotency-key'], r.pedido.id);
    const retorno = `${base}/loja/pedido?id=${r.pedido.id}&token=${r.pedido.token}`;
    assert.deepEqual(pref.back_urls, { success: retorno, pending: retorno, failure: retorno });
    assert.equal(pref.notification_url, undefined, 'SITE_URL http: sem notification_url');
    assert.equal(pref.auto_return, undefined);
    assert.equal(pref.statement_descriptor, 'AMA');
    assert.equal(pref.payer.identification.number, CPF_DIGITOS);

    const banco = await pedidoDoBanco(r.pedido.id);
    assert.equal(banco.status, 'aguardando_pagamento');
    assert.equal(banco.mp_preference_id, pref.id);
    assert.equal(banco.mp_init_point, pref.init_point);
    assert.equal(banco.subtotal_centavos, 9000);
    // PAC no falso: 1850 + 410 (até 1 kg) + 1% de R$ 90,00 de seguro (2 unidades).
    assert.equal(banco.frete_centavos, 2350, 'PAC recotado no servidor');
    assert.equal(banco.total_centavos, 9000 + banco.frete_centavos);
    assert.equal(banco.entrega.tipo, 'melhor_envio');
    assert.equal(banco.entrega.servico_id, 1);
    assert.equal('cupom_codigo' in banco, false);
    assert.equal(banco.cliente_cpf, CPF_DIGITOS);

    const somaItens = pref.items.reduce((soma, item) => soma + Math.round(item.unit_price * 100) * item.quantity, 0);
    assert.equal(somaItens, banco.total_centavos);
    assert.equal(pref.items.length, 2, 'o produto + o frete');
    assert.equal(pref.items[0].title, P.principal.nome);
    assert.equal(pref.items[0].quantity, 2);
    assert.equal(pref.items[0].unit_price, 45);
    assert.equal(pref.items[1].title, 'Frete — PAC');
  });

  test('retirada na sede não existe: frete_id "retirada" → 409 e sem endereço → 400', async () => {
    const retirada = await checkout({ frete_id: 'retirada' });
    assert.equal(retirada.status, 409);
    assert.equal(retirada.json.erro, 'frete_indisponivel');
    const semEndereco = await checkout({ endereco: undefined });
    assert.equal(semEndereco.status, 400);
    assert.equal(semEndereco.json.erro, 'dados_invalidos');
    assert.match(semEndereco.json.campo, /^endereco\./);
  });

  test('frete fixo: pedido com o endereço e o frete da configuração', async () => {
    const r = await checkoutOk({ frete_id: 'fixo-1' });
    const banco = await pedidoDoBanco(r.pedido.id);
    assert.equal(banco.entrega.tipo, 'fixo');
    assert.equal(banco.frete_centavos, 1500);
    assert.equal(banco.endereco.cep, '66010000');
  });

  test('falha ao criar a preferência → 502 e o pedido é cancelado com evento', async (t) => {
    t.mock.method(console, 'error', () => {});
    const email = emailCliente('falhamp');
    mp.estado.falhas.preferencias = 500;
    let r;
    try {
      r = await checkout({ cliente: { ...CLIENTE, email } });
    } finally {
      mp.estado.falhas.preferencias = null;
    }
    assert.equal(r.status, 502);
    assert.equal(r.json.erro, 'falha_mercado_pago');
    assert.ok(!('detalhes' in r.json));
    const [pedido] = await semErro(servico.from('pedidos').select('id').eq('cliente_email', email), 'pedido');
    const banco = await pedidoDoBanco(pedido.id);
    assert.equal(banco.status, 'cancelado');
    assert.equal(banco.mp_init_point, null);
    assert.ok(eventos(banco, 'status').some((e) => /Mercado Pago/.test(e.descricao)));
    assert.equal(eventos(banco, 'alerta').length, 1);
  });
});

// ---------------------------------------------------------------------------
// Pagamento, webhook e página do pedido

describe('pagamento: página do Mercado Pago, webhook e GET /api/loja/pedido', () => {
  let pedido;
  let paymentId;

  test('GET do pedido: token errado → 404; token certo → dados sem PII e pode_pagar', async () => {
    pedido = await checkoutOk({ itens: [{ produto_id: P.principal.id, quantidade: 2 }] });
    const { id, token } = pedido.pedido;

    const errado = await consultarPedido(id, `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`);
    assert.equal(errado.status, 404);
    assert.equal(errado.json.erro, 'pedido_nao_encontrado');
    const outroId = await consultarPedido(randomUUID(), token);
    assert.equal(outroId.status, 404);
    assert.equal(outroId.json.mensagem, errado.json.mensagem, '404 genérico');
    const semToken = await api(`/api/loja/pedido?id=${id}`);
    assert.equal(semToken.status, 404);
    const post = await api(`/api/loja/pedido?id=${id}&token=${token}`, { metodo: 'POST', corpo: {} });
    assert.equal(post.status, 405);

    const r = await consultarPedido(id, token);
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.cabecalhos.get('cache-control'), 'no-store');
    const p = r.json.pedido;
    assert.deepEqual(Object.keys(p).sort(), [
      'codigo_rastreio', 'criado_em', 'entrega', 'enviado_em', 'frete_centavos', 'itens',
      'link_pagamento', 'numero', 'pago_em', 'pode_pagar', 'primeiro_nome', 'status', 'status_pagamento',
      'subtotal_centavos', 'total_centavos', 'url_rastreio',
    ]);
    assert.equal(p.numero, pedido.pedido.numero);
    assert.equal(p.status, 'aguardando_pagamento');
    assert.equal(p.primeiro_nome, 'Maria');
    assert.equal(p.pode_pagar, true);
    assert.equal(p.link_pagamento, pedido.redirecionar);
    assert.deepEqual(p.entrega, { tipo: 'fixo', nome: 'Entrega local', empresa: null, prazo_dias: 3 });
    assert.deepEqual(Object.keys(p.itens[0]).sort(), ['imagem', 'nome', 'preco_unitario_centavos', 'quantidade', 'total_centavos']);
    assert.equal(p.total_centavos, 9000 + 1500);
    const texto = r.texto;
    for (const proibido of [CLIENTE.email, CPF_DIGITOS, '91981056049', 'Presidente Vargas', token, 'Entregar à tarde']) {
      assert.ok(!texto.includes(proibido), `não expõe ${proibido}`);
    }
  });

  test('página do falso → Aprovar → webhook assinado → pedido pago, estoque baixado e e-mails', async () => {
    const { id, token } = pedido.pedido;
    const pagina = await fetch(pedido.redirecionar);
    const html = await pagina.text();
    assert.equal(pagina.status, 200);
    assert.match(html, /Aprovar/);

    const estoqueAntes = await estoque(P.principal.id);
    const emailsAntes = resend.emails.length;
    const pago = await pagarNaPagina(pedido.redirecionar, 'aprovar');
    paymentId = pago.paymentId;
    assert.equal(pago.destino.searchParams.get('id'), id);
    assert.equal(pago.destino.searchParams.get('status'), 'approved');

    const webhook = mp.estado.webhooks.at(-1);
    assert.equal(webhook.url.startsWith(`${base}/api/webhooks/mercadopago?`), true);
    assert.equal(webhook.status, 200, webhook.resposta);

    const banco = await pedidoDoBanco(id);
    assert.equal(banco.status, 'pago');
    assert.equal(banco.status_pagamento, 'approved');
    assert.equal(banco.mp_payment_id, String(paymentId));
    assert.equal(banco.metodo_pagamento, 'credit_card');
    assert.equal(banco.estoque_baixado, true);
    assert.ok(banco.pago_em);
    assert.equal(await estoque(P.principal.id), estoqueAntes - 2);

    const novos = resend.emails.slice(emailsAntes);
    assert.equal(novos.length, 2, 'cliente e equipe');
    const doCliente = novos.find((e) => e.corpo.to.includes(CLIENTE.email));
    const daEquipe = novos.find((e) => e.corpo.to.includes(EMAIL_EQUIPE));
    assert.ok(doCliente && daEquipe);
    assert.match(doCliente.corpo.subject, new RegExp(`Pagamento confirmado — pedido #${banco.numero}`));
    assert.match(daEquipe.corpo.subject, /Novo pedido pago/);
    assert.equal(doCliente.cabecalhos.authorization, 'Bearer re_teste_loja');
    assert.ok(doCliente.corpo.html.includes(`${base}/loja/pedido?id=${id}&amp;token=${token}`));
    assert.equal(eventos(banco, 'email').length, 2);

    const r = await consultarPedido(id, token);
    assert.equal(r.json.pedido.status, 'pago');
    assert.equal(r.json.pedido.pode_pagar, false);
    assert.equal(r.json.pedido.link_pagamento, null);
    assert.ok(r.json.pedido.pago_em);
  });

  test('webhook repetido é idempotente (estoque, eventos e e-mails)', async () => {
    const { id } = pedido.pedido;
    const antes = await pedidoDoBanco(id);
    const estoqueAntes = await estoque(P.principal.id);
    const emailsAntes = resend.emails.length;

    const reenvio = await mp.estado.enviarWebhook(paymentId);
    assert.equal(reenvio.status, 200, reenvio.resposta);
    const manual = await enviarWebhook({ dataId: paymentId });
    assert.equal(manual.status, 200, manual.texto);
    const ipn = await enviarWebhook({ query: `topic=payment&id=${paymentId}`, corpo: {}, semAssinatura: true });
    assert.equal(ipn.status, 200, ipn.texto);
    assert.equal(ipn.json.ok, true);

    const depois = await pedidoDoBanco(id);
    assert.equal(depois.status, 'pago');
    assert.equal(await estoque(P.principal.id), estoqueAntes);
    assert.equal(eventos(depois, 'pagamento').length, eventos(antes, 'pagamento').length);
    assert.equal(resend.emails.length, emailsAntes);
  });

  test('webhook: assinatura inválida → 401; tópicos e pagamentos desconhecidos → 200 ignorado', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const invalida = await enviarWebhook({ dataId: paymentId, assinatura: `ts=${Date.now()},v1=${'0'.repeat(64)}` });
    assert.equal(invalida.status, 401);
    assert.equal(invalida.json.erro, 'assinatura_invalida');

    // Assinatura feita para outro id.
    const requestId = randomUUID();
    const trocada = await api(`/api/webhooks/mercadopago?data.id=${paymentId}&type=payment`, {
      metodo: 'POST',
      corpo: { type: 'payment', data: { id: String(paymentId) } },
      cabecalhos: {
        'x-request-id': requestId,
        'x-signature': assinarNotificacao({ dataId: '999', xRequestId: requestId, ts: String(Date.now()), segredo: SEGREDO }),
      },
    });
    assert.equal(trocada.status, 401);

    const consultasAntes = mp.estado.requisicoes.filter((q) => q.caminho.startsWith('/v1/payments')).length;
    const ordem = await enviarWebhook({ query: 'topic=merchant_order&id=123', corpo: {}, semAssinatura: true });
    assert.equal(ordem.status, 200);
    assert.equal(ordem.json.ignorado, true);
    const tipoOrdem = await enviarWebhook({ dataId: '555', query: 'data.id=555&type=merchant_order', corpo: { type: 'merchant_order', data: { id: '555' } } });
    assert.equal(tipoOrdem.status, 200);
    assert.equal(tipoOrdem.json.ignorado, true);
    assert.equal(mp.estado.requisicoes.filter((q) => q.caminho.startsWith('/v1/payments')).length, consultasAntes,
      'tópicos que não são pagamento nem consultam o Mercado Pago');

    const inexistente = await enviarWebhook({ dataId: '123456' });
    assert.equal(inexistente.status, 200);
    assert.equal(inexistente.json.motivo, 'pagamento_inexistente');

    const semRef = mp.estado.adicionarPagamento({ status: 'approved', transaction_amount: 10, external_reference: 'pedido-antigo' });
    const naoUuid = await enviarWebhook({ dataId: semRef.id });
    assert.equal(naoUuid.status, 200);
    assert.equal(naoUuid.json.motivo, 'referencia_externa');

    const orfao = mp.estado.adicionarPagamento({ status: 'approved', transaction_amount: 10, external_reference: randomUUID() });
    const semPedido = await enviarWebhook({ dataId: orfao.id });
    assert.equal(semPedido.status, 200);
    assert.equal(semPedido.json.motivo, 'pedido_inexistente');

    const get = await api('/api/webhooks/mercadopago?data.id=1&type=payment');
    assert.equal(get.status, 405);
  });

  test('webhook: Mercado Pago fora do ar → 500 para reenviar depois', async (t) => {
    t.mock.method(console, 'error', () => {});
    mp.estado.falhas.pagamentos = 500;
    try {
      const r = await enviarWebhook({ dataId: paymentId });
      assert.equal(r.status, 500);
      assert.equal(r.json.ok, false);
    } finally {
      mp.estado.falhas.pagamentos = null;
    }
  });

  test('Pendente → pagamento_em_analise (sem pode_pagar); aprovado depois → pago', async () => {
    const novo = await checkoutOk({ frete_id: 'fixo-1' });
    const { id, token } = novo.pedido;
    const { paymentId: pendente } = await pagarNaPagina(novo.redirecionar, 'pendente');

    let banco = await pedidoDoBanco(id);
    assert.equal(banco.status, 'pagamento_em_analise');
    assert.equal(banco.status_pagamento, 'pending');
    assert.equal(banco.estoque_baixado, false);
    const r = await consultarPedido(id, token);
    assert.equal(r.json.pedido.status, 'pagamento_em_analise');
    assert.equal(r.json.pedido.pode_pagar, false);
    assert.equal(r.json.pedido.link_pagamento, null);

    const { webhook } = await mp.estado.aprovarPagamento(pendente);
    assert.equal(webhook.status, 200);
    banco = await pedidoDoBanco(id);
    assert.equal(banco.status, 'pago');
  });

  test('Recusar → continua aguardando e pode pagar de novo', async () => {
    const novo = await checkoutOk({ frete_id: 'fixo-1' });
    const { id, token } = novo.pedido;
    await pagarNaPagina(novo.redirecionar, 'recusar');

    const banco = await pedidoDoBanco(id);
    assert.equal(banco.status, 'aguardando_pagamento');
    assert.equal(banco.status_pagamento, 'rejected');
    const r = await consultarPedido(id, token);
    assert.equal(r.json.pedido.pode_pagar, true);
    assert.equal(r.json.pedido.link_pagamento, novo.redirecionar);
    assert.equal(r.json.pedido.status_pagamento, 'rejected');

    await pagarNaPagina(novo.redirecionar, 'aprovar');
    assert.equal((await pedidoDoBanco(id)).status, 'pago');
  });

  test('GET do pedido com payment_id sincroniza mesmo sem webhook (e ignora pagamento de outro pedido)', async () => {
    const novo = await checkoutOk({ frete_id: 'fixo-1' });
    const outro = await checkoutOk({ frete_id: 'fixo-1' });
    const { id, token } = novo.pedido;
    const prefOutro = prefIdDe(outro.redirecionar);
    const { pagamento: doOutro } = await semWebhook(() => mp.estado.pagar(prefOutro, 'aprovar'));
    const { pagamento } = await semWebhook(() => mp.estado.pagar(prefIdDe(novo.redirecionar), 'aprovar'));
    assert.equal((await pedidoDoBanco(id)).status, 'aguardando_pagamento', 'webhook não chegou');

    const errado = await consultarPedido(id, token, `&payment_id=${doOutro.id}`);
    assert.equal(errado.status, 200);
    assert.equal(errado.json.pedido.status, 'aguardando_pagamento');
    assert.equal((await pedidoDoBanco(outro.pedido.id)).status, 'aguardando_pagamento');

    const certo = await consultarPedido(id, token, `&payment_id=${pagamento.id}`);
    assert.equal(certo.status, 200, certo.texto);
    assert.equal(certo.json.pedido.status, 'pago');
    assert.equal(certo.json.pedido.status_pagamento, 'approved');
    assert.equal(certo.json.pedido.pode_pagar, false);
  });
});

// ---------------------------------------------------------------------------
// Admin

describe('rotas de admin', () => {
  let pedidoMe;

  test('autenticação: sem token → 401, não admin → 403', async () => {
    for (const rota of ['/api/admin/status']) {
      const semToken = await api(rota);
      assert.equal(semToken.status, 401);
      assert.equal(semToken.json.erro, 'nao_autenticado');
      const comum = await api(rota, { token: tokenComum });
      assert.equal(comum.status, 403);
      assert.equal(comum.json.erro, 'sem_permissao');
    }
    for (const rota of ['/api/admin/pedido-status', '/api/admin/envio', '/api/admin/pagamento']) {
      const semToken = await api(rota, { metodo: 'POST', corpo: {} });
      assert.equal(semToken.status, 401, rota);
      const comum = await api(rota, { metodo: 'POST', corpo: {}, token: tokenComum });
      assert.equal(comum.status, 403, rota);
      const metodo = await api(rota, { token: tokenAdmin });
      assert.equal(metodo.status, 405, rota);
    }
  });

  test('GET /api/admin/status', async (t) => {
    const r = await api('/api/admin/status', { token: tokenAdmin });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.cabecalhos.get('cache-control'), 'no-store');
    assert.deepEqual(r.json, {
      ok: true,
      integracoes: {
        supabase: { configurado: true },
        mercadopago: { configurado: true, modo: 'producao' },
        melhor_envio: { configurado: true, ambiente: 'producao', saldo_centavos: me.estado.saldoCentavos, erro: null },
        email: { configurado: true },
        webhook_assinatura: true,
        site_url: base,
      },
    });

    process.env.MP_MODO = 'teste';
    me.estado.forcar('/balance', { status: 500 });
    try {
      const teste = await api('/api/admin/status', { token: tokenAdmin });
      assert.equal(teste.json.integracoes.mercadopago.modo, 'teste');
      assert.equal(teste.json.integracoes.melhor_envio.saldo_centavos, null);
      assert.match(teste.json.integracoes.melhor_envio.erro, /saldo/);
    } finally {
      delete process.env.MP_MODO;
    }
  });

  test('POST /api/admin/pedido-status: validações, enviado com rastreio e e-mail ao cliente', async () => {
    const novo = await checkoutOk({});
    await pagarNaPagina(novo.redirecionar, 'aprovar');
    const { id } = novo.pedido;

    const statusInvalido = await api('/api/admin/pedido-status', { metodo: 'POST', token: tokenAdmin, corpo: { pedido_id: id, status: 'perdido' } });
    assert.equal(statusInvalido.status, 400);
    assert.equal(statusInvalido.json.erro, 'status_invalido');
    const urlHttp = await api('/api/admin/pedido-status', {
      metodo: 'POST', token: tokenAdmin, corpo: { pedido_id: id, status: 'enviado', url_rastreio: 'http://rastreio.exemplo.com/x' },
    });
    assert.equal(urlHttp.status, 400);
    assert.equal(urlHttp.json.campo, 'url_rastreio');
    const urlRuim = await api('/api/admin/pedido-status', {
      metodo: 'POST', token: tokenAdmin, corpo: { pedido_id: id, status: 'enviado', url_rastreio: 'https://exemplo.com/"><script>' },
    });
    assert.equal(urlRuim.status, 400);
    assert.equal(urlRuim.json.campo, 'url_rastreio', 'mesma regra do banco, com o nome do campo da entrada');
    const codigoRuim = await api('/api/admin/pedido-status', {
      metodo: 'POST', token: tokenAdmin, corpo: { pedido_id: id, status: 'enviado', codigo_rastreio: 'AA1<b>' },
    });
    assert.equal(codigoRuim.status, 400);
    assert.equal(codigoRuim.json.campo, 'codigo_rastreio');
    assert.equal((await pedidoDoBanco(id)).status, 'pago', 'nada mudou com os dados inválidos');
    const inexistente = await api('/api/admin/pedido-status', { metodo: 'POST', token: tokenAdmin, corpo: { pedido_id: randomUUID(), status: 'enviado' } });
    assert.equal(inexistente.status, 404);

    const emailsAntes = resend.emails.length;
    const r = await api('/api/admin/pedido-status', {
      metodo: 'POST',
      token: tokenAdmin,
      corpo: {
        pedido_id: id, status: 'enviado', codigo_rastreio: 'AA123456789BR', url_rastreio: 'https://rastreamento.correios.com.br/app/index.php',
        nota: 'Postado na agência central', notificar_cliente: true,
      },
    });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.status_anterior, 'pago');
    assert.equal(r.json.status_novo, 'enviado');
    assert.equal(r.json.email_enviado, true);

    const banco = await pedidoDoBanco(id);
    assert.equal(banco.status, 'enviado');
    assert.equal(banco.codigo_rastreio, 'AA123456789BR');
    assert.ok(banco.enviado_em);
    const status = eventos(banco, 'status').at(-1);
    assert.equal(status.autor, EMAIL_ADMIN);
    assert.match(status.descricao, /Postado na agência central/);
    const email = resend.emails.slice(emailsAntes);
    assert.equal(email.length, 1);
    assert.deepEqual(email[0].corpo.to, [CLIENTE.email]);
    assert.match(email[0].corpo.subject, /foi enviado/);
    assert.ok(email[0].corpo.html.includes('AA123456789BR'));
    const evEmail = eventos(banco, 'email').find((e) => e.dados && e.dados.modelo === 'status_enviado');
    assert.ok(evEmail, 'evento do e-mail de envio');
    assert.equal(evEmail.autor, EMAIL_ADMIN);
    assert.match(evEmail.descricao, /enviado ao cliente/);

    const consulta = await consultarPedido(id, novo.pedido.token);
    assert.equal(consulta.json.pedido.codigo_rastreio, 'AA123456789BR');
    assert.equal(consulta.json.pedido.url_rastreio, 'https://rastreamento.correios.com.br/app/index.php');

    // Sem notificar_cliente: nenhum e-mail.
    const entregue = await api('/api/admin/pedido-status', { metodo: 'POST', token: tokenAdmin, corpo: { pedido_id: id, status: 'entregue' } });
    assert.equal(entregue.status, 200);
    assert.equal(entregue.json.email_enviado, null);
    assert.equal(resend.emails.length, emailsAntes + 1);
  });

  test('POST /api/admin/pedido-status: cancelado com repor_estoque devolve o estoque e avisa o cliente', async () => {
    const novo = await checkoutOk({ itens: [{ produto_id: P.principal.id, quantidade: 2 }] });
    const { id } = novo.pedido;
    const estoqueAntes = await estoque(P.principal.id);
    await pagarNaPagina(novo.redirecionar, 'aprovar');
    assert.equal(await estoque(P.principal.id), estoqueAntes - 2);

    const emailsAntes = resend.emails.length;
    const r = await api('/api/admin/pedido-status', {
      metodo: 'POST',
      token: tokenAdmin,
      corpo: { pedido_id: id, status: 'cancelado', repor_estoque: true, notificar_cliente: true, nota: 'Cliente desistiu' },
    });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.status_anterior, 'pago');
    assert.equal(r.json.status_novo, 'cancelado');
    assert.equal(r.json.estoque_reposto, true);
    assert.equal(r.json.email_enviado, true);
    assert.equal(await estoque(P.principal.id), estoqueAntes, 'estoque devolvido');

    const banco = await pedidoDoBanco(id);
    assert.equal(banco.status, 'cancelado');
    assert.ok(banco.cancelado_em);
    assert.equal(banco.estoque_baixado, false);
    const novos = resend.emails.slice(emailsAntes);
    assert.equal(novos.length, 1);
    assert.deepEqual(novos[0].corpo.to, [CLIENTE.email]);
    assert.match(novos[0].corpo.subject, /foi cancelado/);
    assert.ok(eventos(banco, 'email').some((e) => e.dados && e.dados.modelo === 'status_cancelado' && e.autor === EMAIL_ADMIN));

    const consulta = await consultarPedido(id, novo.pedido.token);
    assert.equal(consulta.json.pedido.status, 'cancelado');
    assert.equal(consulta.json.pedido.pode_pagar, false);
  });

  test('POST /api/admin/envio: regras de pedido e ação', async () => {
    const fixo = await checkoutOk({ frete_id: 'fixo-1' });
    await pagarNaPagina(fixo.redirecionar, 'aprovar');
    const r1 = await api('/api/admin/envio', { metodo: 'POST', token: tokenAdmin, corpo: { pedido_id: fixo.pedido.id, acao: 'adicionar_carrinho' } });
    assert.equal(r1.status, 409);
    assert.equal(r1.json.erro, 'envio_indisponivel');

    pedidoMe = await checkoutOk({ itens: [{ produto_id: P.envio.id, quantidade: 3 }], frete_id: 'me-1' });
    const naoPago = await api('/api/admin/envio', { metodo: 'POST', token: tokenAdmin, corpo: { pedido_id: pedidoMe.pedido.id, acao: 'adicionar_carrinho' } });
    assert.equal(naoPago.status, 409);
    assert.equal(naoPago.json.erro, 'status_nao_permite_envio');

    const acao = await api('/api/admin/envio', { metodo: 'POST', token: tokenAdmin, corpo: { pedido_id: pedidoMe.pedido.id, acao: 'explodir' } });
    assert.equal(acao.status, 400);
    assert.equal(acao.json.erro, 'acao_invalida');

    const inexistente = await api('/api/admin/envio', { metodo: 'POST', token: tokenAdmin, corpo: { pedido_id: randomUUID(), acao: 'rastrear' } });
    assert.equal(inexistente.status, 404);
  });

  test('POST /api/admin/envio: carrinho → comprar → gerar → imprimir → rastrear no Melhor Envio falso', async () => {
    await pagarNaPagina(pedidoMe.redirecionar, 'aprovar');
    const { id } = pedidoMe.pedido;
    const envio = (corpo) => api('/api/admin/envio', { metodo: 'POST', token: tokenAdmin, corpo: { pedido_id: id, ...corpo } });

    const semEtiquetas = await envio({ acao: 'comprar' });
    assert.equal(semEtiquetas.status, 409);
    assert.equal(semEtiquetas.json.erro, 'sem_etiquetas');

    const antes = me.estado.requisicoes.length;
    const carrinho = await envio({ acao: 'adicionar_carrinho' });
    assert.equal(carrinho.status, 200, carrinho.texto);
    assert.equal(carrinho.json.acao, 'adicionar_carrinho');
    assert.ok(carrinho.json.me_ordens.length >= 1);
    assert.deepEqual([...me.estado.carrinho].sort(), [...carrinho.json.me_ordens].sort());
    const postsCarrinho = me.estado.requisicoes.slice(antes).filter((q) => q.metodo === 'POST' && q.caminho === '/cart');
    assert.equal(postsCarrinho.length, carrinho.json.me_ordens.length, 'um item de carrinho por pacote');
    const item = postsCarrinho[0].corpo;
    assert.equal(item.service, 1);
    assert.equal(item.volumes.length, 1);
    assert.equal(item.from.company_document, '11222333000181');
    assert.equal(item.from.postal_code, '67125866');
    assert.equal(item.to.document, CPF_DIGITOS);
    assert.equal(item.to.postal_code, '66010000');
    assert.equal(item.to.name, CLIENTE.nome);
    assert.equal(item.options.non_commercial, true, 'sem NF-e: declaração de conteúdo');
    assert.equal(item.products[0].quantity, 3);

    let banco = await pedidoDoBanco(id);
    assert.deepEqual(banco.me_ordens, carrinho.json.me_ordens);

    const repetido = await envio({ acao: 'adicionar_carrinho' });
    assert.equal(repetido.status, 409);
    assert.equal(repetido.json.erro, 'etiquetas_existentes');

    const saldo = me.estado.saldoCentavos;
    me.estado.saldoCentavos = 0;
    const semSaldo = await envio({ acao: 'comprar' });
    me.estado.saldoCentavos = saldo;
    assert.equal(semSaldo.status, 409);
    assert.equal(semSaldo.json.erro, 'saldo_insuficiente');
    assert.equal(me.estado.compras.length, 0);

    const compra = await envio({ acao: 'comprar' });
    assert.equal(compra.status, 200, compra.texto);
    assert.ok(compra.json.compra.total_centavos > 0);
    assert.equal(me.estado.saldoCentavos, saldo - compra.json.compra.total_centavos);
    assert.ok(me.estado.requisicoes.some((q) => q.caminho === '/balance'), 'conferiu o saldo antes');
    const deNovo = await envio({ acao: 'comprar' });
    assert.equal(deNovo.status, 200);
    assert.equal(deNovo.json.compra, null, 'já pagas: não compra de novo');
    assert.equal(me.estado.compras.length, 1);

    const refazerPagas = await envio({ acao: 'adicionar_carrinho', refazer: true });
    assert.equal(refazerPagas.status, 409);
    assert.equal(refazerPagas.json.erro, 'etiquetas_pagas');
    assert.deepEqual((await pedidoDoBanco(id)).me_ordens, carrinho.json.me_ordens, 'etiquetas pagas continuam no pedido');

    const gerar = await envio({ acao: 'gerar' });
    assert.equal(gerar.status, 200, gerar.texto);
    for (const ordem of carrinho.json.me_ordens) assert.equal(gerar.json.resultado[ordem].ok, true);

    let imprimir;
    for (let tentativa = 0; tentativa < 5; tentativa += 1) {
      imprimir = await envio({ acao: 'imprimir' });
      if (imprimir.status !== 409) break;
      assert.equal(imprimir.json.erro, 'etiqueta_em_geracao');
    }
    assert.equal(imprimir.status, 200, imprimir.texto);
    assert.match(imprimir.json.etiqueta_url, /^http:\/\/127\.0\.0\.1:\d+\/imprimir\//);
    assert.equal(me.estado.ultimaImpressao.mode, 'public');
    assert.match(imprimir.json.codigo_rastreio, /^AM\d{9}BR/);

    const rastrear = await envio({ acao: 'rastrear' });
    assert.equal(rastrear.status, 200, rastrear.texto);
    const codigos = carrinho.json.me_ordens.map((o) => me.estado.etiquetas[o].tracking).join(', ');
    assert.equal(rastrear.json.codigo_rastreio, codigos);
    assert.match(rastrear.json.url_rastreio, /^https:\/\/www\.melhorrastreio\.com\.br\/rastreio\/AM\d{9}BR$/);

    banco = await pedidoDoBanco(id);
    assert.equal(banco.etiqueta_url, imprimir.json.etiqueta_url);
    assert.equal(banco.codigo_rastreio, codigos);
    assert.equal(banco.url_rastreio, rastrear.json.url_rastreio);
    const doEnvio = eventos(banco, 'envio');
    assert.ok(doEnvio.length >= 4, 'carrinho, compra, geração e impressão');
    assert.ok(doEnvio.every((e) => e.autor === EMAIL_ADMIN));
  });

  test('POST /api/admin/envio: NF-e com vários pacotes, refazer e etiquetas que não saem do carrinho', async (t) => {
    t.mock.method(console, 'error', () => {});
    const novo = await checkoutOk({ itens: [{ produto_id: P.grande.id, quantidade: 3 }], frete_id: 'me-1' });
    await pagarNaPagina(novo.redirecionar, 'aprovar');
    const { id } = novo.pedido;
    const envio = (corpo) => api('/api/admin/envio', { metodo: 'POST', token: tokenAdmin, corpo: { pedido_id: id, ...corpo } });
    const chave = '15261012345678000199550010000012341000012345';

    const antesInvalida = me.estado.requisicoes.length;
    const invalida = await envio({ acao: 'adicionar_carrinho', chave_nfe: '123' });
    assert.equal(invalida.status, 400);
    assert.equal(invalida.json.erro, 'chave_nfe_invalida');
    assert.equal(me.estado.requisicoes.length, antesInvalida, 'chave inválida nem chega ao Melhor Envio');

    const antes = me.estado.requisicoes.length;
    const nfe = await envio({ acao: 'adicionar_carrinho', chave_nfe: chave });
    assert.equal(nfe.status, 200, nfe.texto);
    assert.equal(nfe.json.me_ordens.length, 2, 'um item de carrinho por pacote');
    const posts = me.estado.requisicoes.slice(antes).filter((q) => q.metodo === 'POST' && q.caminho === '/cart');
    assert.equal(posts.length, 2);
    for (const post of posts) {
      assert.equal(post.corpo.volumes.length, 1);
      assert.equal(post.corpo.options.non_commercial, false);
      assert.deepEqual(post.corpo.options.invoice, { key: chave });
      assert.equal(post.corpo.to.document, CPF_DIGITOS);
    }
    const numerica = (a, b) => a - b;
    assert.deepEqual(posts.map((q) => q.corpo.products[0].quantity).sort(numerica), [1, 2], '3 unidades em 2 pacotes');
    assert.deepEqual(posts.map((q) => q.corpo.options.insurance_value).sort(numerica), [50, 100], 'valor declarado por pacote');
    let banco = await pedidoDoBanco(id);
    assert.deepEqual(banco.me_ordens, nfe.json.me_ordens);
    assert.ok(eventos(banco, 'envio').at(-1).descricao.includes('NF-e'));

    // Refazer: novas etiquetas no pedido e as antigas (não pagas) saem do carrinho.
    const refeito = await envio({ acao: 'adicionar_carrinho', refazer: true });
    assert.equal(refeito.status, 200, refeito.texto);
    assert.equal(refeito.json.me_ordens.length, 2);
    assert.deepEqual([...refeito.json.removidas_do_carrinho].sort(), [...nfe.json.me_ordens].sort());
    assert.deepEqual(refeito.json.carrinho_orfaos, []);
    for (const antiga of nfe.json.me_ordens) assert.ok(!me.estado.carrinho.includes(antiga), 'antiga saiu do carrinho');
    for (const nova of refeito.json.me_ordens) assert.ok(me.estado.carrinho.includes(nova));
    banco = await pedidoDoBanco(id);
    assert.deepEqual(banco.me_ordens, refeito.json.me_ordens);
    const evRefazer = eventos(banco, 'envio').at(-1);
    assert.deepEqual(evRefazer.dados.substituiu, nfe.json.me_ordens);
    assert.equal(evRefazer.dados.nfe, false, 'sem chave: declaração de conteúdo');

    // Refazer com o Melhor Envio recusando a remoção: as novas ficam no pedido e as antigas viram alerta.
    me.estado.forcar(/^\/cart\//, { metodo: 'DELETE', status: 500, vezes: 2 });
    const semRemover = await envio({ acao: 'adicionar_carrinho', refazer: true });
    assert.equal(semRemover.status, 200, semRemover.texto);
    assert.equal(semRemover.json.carrinho_orfaos.length, 2);
    banco = await pedidoDoBanco(id);
    assert.deepEqual(banco.me_ordens, semRemover.json.me_ordens);
    const alerta = eventos(banco, 'alerta').at(-1);
    assert.match(alerta.descricao, /continuam no carrinho/);
    assert.deepEqual(alerta.dados.carrinho_orfaos.map((o) => o.id).sort(), [...refeito.json.me_ordens].sort());
    assert.equal(alerta.autor, EMAIL_ADMIN);

    // Falha no 2º pacote com a 1ª etiqueta presa no carrinho: o pedido não muda e o órfão vira alerta.
    const doPedido = semRemover.json.me_ordens;
    me.estado.ajustesServicos[1] = {
      packages: [
        { price: '20.00', format: 'box', dimensions: { height: 40, width: 20, length: 30 }, weight: '1.00', insurance_value: '50.00', products: [{ id: P.grande.id, quantity: 1 }] },
        { price: '30.00', format: 'box', dimensions: { height: 150, width: 20, length: 30 }, weight: '2.00', insurance_value: '100.00', products: [{ id: P.grande.id, quantity: 2 }] },
      ],
    };
    me.estado.forcar(/^\/cart\//, { metodo: 'DELETE', status: 500, vezes: 1 });
    let falhou;
    try {
      falhou = await envio({ acao: 'adicionar_carrinho', refazer: true });
    } finally {
      delete me.estado.ajustesServicos[1];
      me.estado.forcadas.length = 0;
    }
    assert.ok(falhou.status >= 400 && falhou.status < 600, falhou.texto);
    assert.equal(falhou.json.carrinho_orfaos.length, 1);
    banco = await pedidoDoBanco(id);
    assert.deepEqual(banco.me_ordens, doPedido, 'o pedido continua com as etiquetas anteriores');
    const alertaOrfao = eventos(banco, 'alerta').at(-1);
    assert.match(alertaOrfao.descricao, /após uma falha/);
    assert.equal(alertaOrfao.dados.carrinho_orfaos[0].id, falhou.json.carrinho_orfaos[0].id);
  });

  test('POST /api/admin/pagamento: conferência pelo search escolhe o aprovado', async () => {
    const vazio = await checkoutOk({ frete_id: 'fixo-1' });
    const nada = await api('/api/admin/pagamento', { metodo: 'POST', token: tokenAdmin, corpo: { pedido_id: vazio.pedido.id } });
    assert.equal(nada.status, 200, nada.texto);
    assert.equal(nada.json.encontrado, false);

    const invalido = await api('/api/admin/pagamento', { metodo: 'POST', token: tokenAdmin, corpo: { pedido_id: 'x' } });
    assert.equal(invalido.status, 400);
    const inexistente = await api('/api/admin/pagamento', { metodo: 'POST', token: tokenAdmin, corpo: { pedido_id: randomUUID() } });
    assert.equal(inexistente.status, 404);

    const novo = await checkoutOk({ frete_id: 'fixo-1' });
    const pref = prefIdDe(novo.redirecionar);
    const { aprovado } = await semWebhook(async () => {
      await mp.estado.pagar(pref, 'recusar');
      const { pagamento } = await mp.estado.pagar(pref, 'aprovar');
      await mp.estado.pagar(pref, 'recusar');
      return { aprovado: pagamento };
    });
    assert.equal((await pedidoDoBanco(novo.pedido.id)).status, 'aguardando_pagamento');

    const r = await api('/api/admin/pagamento', { metodo: 'POST', token: tokenAdmin, corpo: { pedido_id: novo.pedido.id } });
    assert.equal(r.status, 200, r.texto);
    assert.equal(r.json.encontrado, true);
    assert.equal(r.json.total_pagamentos, 3);
    assert.equal(String(r.json.pagamento.id), String(aprovado.id));
    assert.equal(r.json.pagamento.status, 'approved');
    assert.equal(r.json.resultado.status_novo, 'pago');
    assert.equal(r.json.resultado.virou_pago, true);
    assert.ok(mp.estado.requisicoes.some((q) => q.caminho.startsWith(`/v1/payments/search?external_reference=${novo.pedido.id}`)));

    const banco = await pedidoDoBanco(novo.pedido.id);
    assert.equal(banco.status, 'pago');
    assert.equal(banco.mp_payment_id, String(aprovado.id));
  });
});
