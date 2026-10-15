// Testes de integração do banco (docs/ARQUITETURA.md, seção 4) contra o Supabase local:
// RLS, GRANTs, RPCs (cotar_carrinho, criar_pedido, confirmar_pagamento, alterar_status_pedido)
// e o bucket "midia". Exige "supabase start" e a migração aplicada ("supabase db reset").
//
// Re-executável sem "db reset": cada execução cria os próprios dados com um sufixo
// aleatório (produtos, categorias, pedidos, usuários, arquivos) e apaga tudo no after().

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ambienteLocal, argumentosPsql, cliente, clienteLogado, clienteServico, conferirDestino, criarUsuario, removerUsuario,
  sql, sqlJson,
} from '../apoio/supabase-local.js';

const PUBLIC = fileURLToPath(new URL('../../public/', import.meta.url));
const MIGRACAO = fileURLToPath(new URL('../../supabase/migrations/20261009120000_inicial.sql', import.meta.url));

const SUF = randomBytes(4).toString('hex');
const SENHA = `Senha-${SUF}-123`;
const EMAIL_ADMIN = `admin-${SUF}@teste.ama.local`;
const EMAIL_COMUM = `comum-${SUF}@teste.ama.local`;
const EMAIL_EXTRA = `extra-${SUF}@teste.ama.local`;
const EMAIL_CLIENTE = `cliente-${SUF}@exemplo.com.br`;
const PASTA = `site/teste-${SUF}`;
const AUTOR = `painel-${SUF}@ama.local`;

let servico;
let anon;
let comum;
let admin;
let usuarioAdmin;
let usuarioComum;
let usuarioExtra;

let contador = 0;
const seq = () => {
  contador += 1;
  return contador;
};
let ultimoPagamento = 8_000_000_000 + Math.floor(Math.random() * 1_000_000_000);
const novoIdPagamento = () => {
  ultimoPagamento += 1;
  return ultimoPagamento;
};

// --------------------------------------------------------------------------------------
// Apoio
// --------------------------------------------------------------------------------------

async function semErro(promessa, contexto) {
  const { data, error } = await promessa;
  if (error) {
    throw new Error(`${contexto}: ${error.message} (${error.code || error.statusCode || ''}) ${error.details || ''}`);
  }
  return data;
}

/** Literal SQL seguro para os valores (uuids, textos de teste) usados nas consultas. */
function lit(valor) {
  return `'${String(valor).replace(/'/g, "''")}'`;
}

async function criarProduto(campos = {}) {
  const n = seq();
  return semErro(servico.from('produtos').insert({
    nome: `Produto teste ${SUF} ${n}`,
    slug: `teste-${SUF}-${n}`,
    preco_centavos: 1000,
    estoque: 10,
    ativo: true,
    ...campos,
  }).select().single(), 'criar produto');
}

async function criarCategoria(campos = {}) {
  const n = seq();
  return semErro(servico.from('categorias').insert({
    nome: `Categoria teste ${n}`,
    slug: `teste-${SUF}-${n}`,
    ...campos,
  }).select().single(), 'criar categoria');
}

const ENTREGA_FIXO = {
  tipo: 'fixo', id: 'fixo-1', nome: 'Entrega local', empresa: null, prazo_dias: 3, preco_centavos: 1500, servico_id: null,
};
// Frete fixo sem custo: deixa o total igual ao subtotal nos testes de pagamento.
const ENTREGA_GRATIS = {
  tipo: 'fixo', id: 'fixo-gratis', nome: 'Entrega grátis', empresa: null, prazo_dias: 3, preco_centavos: 0, servico_id: null,
};
const ENDERECO_DIRETO = {
  cep: '66010000', logradouro: 'Avenida Presidente Vargas', numero: '100', complemento: '', bairro: 'Campina', cidade: 'Belém', uf: 'PA',
};

function dadosPedido(itens, extra = {}) {
  return {
    itens,
    cliente: { nome: '  Maria   da Silva ', email: EMAIL_CLIENTE.toUpperCase(), telefone: '(91) 98105-6049', cpf: '529.982.247-25' },
    endereco: {
      cep: '66010-000', logradouro: 'Avenida Presidente Vargas', numero: '100', complemento: 'Apto 1',
      bairro: 'Campina', cidade: 'Belém', uf: 'pa',
    },
    entrega: { ...ENTREGA_FIXO },
    observacoes: 'Entregar à tarde',
    ...extra,
  };
}

async function criarPedido(entrada) {
  return semErro(servico.rpc('criar_pedido', { p: entrada }), 'criar_pedido');
}

/** Chama a RPC esperando erro; devolve o erro do PostgREST. */
async function erroRpc(cl, nome, args) {
  const { data, error } = await cl.rpc(nome, args);
  assert.ok(error, `${nome} deveria falhar, mas devolveu ${JSON.stringify(data)}`);
  return error;
}

/** Produto + pedido (frete fixo sem custo) prontos para os testes de pagamento. */
async function cenario({ estoque = 10, quantidade = 2, preco = 2500, controlar = true, itensExtras = [] } = {}) {
  const produto = await criarProduto({ preco_centavos: preco, estoque, controlar_estoque: controlar });
  const pedido = await criarPedido(dadosPedido(
    [{ produto_id: produto.id, quantidade }, ...itensExtras],
    { entrega: { ...ENTREGA_GRATIS } },
  ));
  return { produto, pedido };
}

/** Pagamento no formato de GET /v1/payments/{id} do Mercado Pago. */
function pagamento(pedido, campos = {}) {
  return {
    id: novoIdPagamento(),
    status: 'approved',
    status_detail: 'accredited',
    transaction_amount: pedido.total_centavos / 100,
    payment_type_id: 'credit_card',
    payment_method_id: 'visa',
    date_approved: new Date().toISOString(),
    ...campos,
  };
}

async function confirmar(pedidoId, pag, cl = servico) {
  return semErro(cl.rpc('confirmar_pagamento', { p_pedido_id: pedidoId, p_pagamento: pag }), 'confirmar_pagamento');
}

async function alterarStatus(pedidoId, status, extra = {}) {
  return semErro(servico.rpc('alterar_status_pedido', {
    p_pedido_id: pedidoId, p_status: status, p_autor: AUTOR, ...extra,
  }), 'alterar_status_pedido');
}

async function lerPedido(id) {
  return sqlJson(`select row_to_json(p) from public.pedidos p where p.id = ${lit(id)}`);
}

async function lerEstoque(produtoId) {
  return Number(await sql(`select estoque from public.produtos where id = ${lit(produtoId)}`));
}

async function lerEventos(pedidoId, tipo) {
  const filtro = tipo ? ` and e.tipo = ${lit(tipo)}` : '';
  return sqlJson(`select coalesce(json_agg(e order by e.id), '[]'::json) from public.pedido_eventos e
                   where e.pedido_id = ${lit(pedidoId)}${filtro}`);
}

async function contarPedidosDoCliente() {
  return Number(await sql(`select count(*) from public.pedidos where cliente_email = ${lit(EMAIL_CLIENTE)}`));
}

function recente(iso, segundos = 120) {
  assert.ok(iso, 'data deveria estar preenchida');
  const diferenca = Math.abs(Date.now() - new Date(iso).getTime());
  assert.ok(diferenca < segundos * 1000, `data ${iso} não é recente`);
}

// PNG 1×1 válido.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// --------------------------------------------------------------------------------------
// Preparação e limpeza
// --------------------------------------------------------------------------------------

before(async () => {
  const { serviceKey } = ambienteLocal();
  assert.ok(
    serviceKey,
    'Chave de serviço do Supabase local não encontrada. Rode "scripts/supabase-local.sh start" ou defina '
      + 'SUPABASE_SECRET_KEY (ou SUPABASE_SERVICE_ROLE_KEY).',
  );
  servico = clienteServico();
  anon = cliente();

  usuarioAdmin = await criarUsuario({ email: EMAIL_ADMIN, senha: SENHA, admin: true });
  usuarioComum = await criarUsuario({ email: EMAIL_COMUM, senha: SENHA });
  usuarioExtra = await criarUsuario({ email: EMAIL_EXTRA, senha: SENHA, admin: true });
  admin = await clienteLogado(EMAIL_ADMIN, SENHA);
  comum = await clienteLogado(EMAIL_COMUM, SENHA);
});

after(async () => {
  const falhas = [];
  const tentar = async (descricao, acao) => {
    try {
      await acao();
    } catch (erro) {
      falhas.push(`${descricao}: ${erro.message}`);
    }
  };

  if (servico) {
    await tentar('arquivos', async () => {
      const { data } = await servico.storage.from('midia').list(PASTA, { limit: 1000 });
      const caminhos = (data || []).map((arquivo) => `${PASTA}/${arquivo.name}`);
      if (caminhos.length) await semErro(servico.storage.from('midia').remove(caminhos), 'remover arquivos');
    });
  }
  await tentar('dados', () => sql(`
    delete from public.pedidos where cliente_email = ${lit(EMAIL_CLIENTE)};
    delete from public.produtos where slug like ${lit(`teste-${SUF}-%`)};
    delete from public.categorias where slug like ${lit(`teste-${SUF}-%`)};
    delete from public.configuracoes where chave like ${lit(`teste_${SUF}_%`)};
    delete from public.conteudo_site where chave like ${lit(`teste.${SUF}.%`)};
  `));
  for (const usuario of [usuarioAdmin, usuarioComum, usuarioExtra]) {
    if (usuario) await tentar(`usuário ${usuario.email}`, () => removerUsuario(usuario.id));
  }
  if (falhas.length) throw new Error(`Limpeza incompleta:\n${falhas.join('\n')}`);
});

// --------------------------------------------------------------------------------------
// Trava do apoio contra rodar os testes num Supabase remoto (função pura, sem rede)
// --------------------------------------------------------------------------------------

describe('apoio: os testes só rodam contra o Supabase local', () => {
  const LOCAL_DB = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  const SEM = {};
  const REMOTO = { AMA_TESTES_PERMITIR_REMOTO: '1' };

  test('aceita 127.0.0.1, localhost e ::1 (e misturas entre eles)', () => {
    for (const [url, dbUrl] of [
      ['http://127.0.0.1:54321', LOCAL_DB],
      ['http://localhost:54321', LOCAL_DB],
      ['http://[::1]:54321', 'postgresql://postgres:postgres@[::1]:54322/postgres'],
      ['http://127.0.0.1:54321', 'postgresql://postgres:postgres@localhost:54322/postgres'],
    ]) {
      assert.doesNotThrow(() => conferirDestino({ url, dbUrl }, SEM), `${url} + ${dbUrl}`);
    }
  });

  test('recusa API ou banco remotos sem AMA_TESTES_PERMITIR_REMOTO=1', () => {
    const casos = [
      ['https://abcdefgh.supabase.co', LOCAL_DB, /API aponta para "abcdefgh\.supabase\.co"/],
      ['http://127.0.0.1:54321', 'postgresql://postgres:x@db.abcdefgh.supabase.co:5432/postgres', /banco aponta para/],
      ['https://abcdefgh.supabase.co', 'postgresql://postgres:x@db.abcdefgh.supabase.co:5432/postgres', /AMA_TESTES_PERMITIR_REMOTO/],
      ['http://127.0.0.2:54321', LOCAL_DB, /127\.0\.0\.2/],
      ['http://localhost.exemplo.com:54321', LOCAL_DB, /localhost\.exemplo\.com/],
    ];
    for (const [url, dbUrl, mensagem] of casos) {
      assert.throws(() => conferirDestino({ url, dbUrl }, SEM), mensagem, `${url} + ${dbUrl}`);
    }
    assert.throws(() => conferirDestino({ url: 'https://abcdefgh.supabase.co', dbUrl: LOCAL_DB }, { AMA_TESTES_PERMITIR_REMOTO: 'sim' }));
  });

  test('com AMA_TESTES_PERMITIR_REMOTO=1, API e banco precisam ser do mesmo projeto', () => {
    const api = 'https://abcdefgh.supabase.co';
    for (const dbUrl of [
      'postgresql://postgres:x@db.abcdefgh.supabase.co:5432/postgres',
      'postgresql://postgres.abcdefgh:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres',
    ]) {
      assert.doesNotThrow(() => conferirDestino({ url: api, dbUrl }, REMOTO), dbUrl);
    }
    assert.doesNotThrow(() => conferirDestino({
      url: 'https://supabase.minhaempresa.com.br', dbUrl: 'postgresql://postgres:x@supabase.minhaempresa.com.br:5432/postgres',
    }, REMOTO));
    for (const dbUrl of [
      LOCAL_DB,
      'postgresql://postgres:x@db.outroprojeto.supabase.co:5432/postgres',
      'postgresql://postgres.outroprojeto:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres',
      // Usuário do projeto, mas o banco está em outro servidor (não é o pooler do Supabase).
      'postgresql://postgres.abcdefgh:x@outro-servidor.exemplo.net:5432/postgres',
      'postgresql://postgres.abcdefgh:x@pooler.supabase.com.exemplo.net:6543/postgres',
      // Pooler sem o projeto no usuário, ou com o projeto só como prefixo/sufixo parcial.
      'postgresql://postgres:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres',
      'postgresql://postgres.xabcdefgh:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres',
      'postgresql://.abcdefgh:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres',
      // Subdomínio qualquer do host da API não é o banco dele (só "db." exato).
      'postgresql://postgres:x@x.db.abcdefgh.supabase.co:5432/postgres',
      'postgresql://postgres:x@outro.abcdefgh.supabase.co:5432/postgres',
    ]) {
      assert.throws(() => conferirDestino({ url: api, dbUrl }, REMOTO), /lugares diferentes/, dbUrl);
    }
    for (const [url, dbUrl] of [
      ['http://127.0.0.1:54321', 'postgresql://postgres:x@db.abcdefgh.supabase.co/postgres'],
      // A API não é um projeto <ref>.supabase.co: a regra do usuário do pooler não vale.
      ['https://a.b.supabase.co', 'postgresql://u.a:x@db.zzz.com/postgres'],
      ['https://a.b.supabase.co', 'postgresql://postgres.a:x@aws-0-sa-east-1.pooler.supabase.com:6543/postgres'],
      ['https://supabase.co', 'postgresql://postgres:x@qualquer.supabase.co/postgres'],
      ['https://supabase.minhaempresa.com.br', 'postgresql://postgres:x@banco.minhaempresa.com.br/postgres'],
    ]) {
      assert.throws(() => conferirDestino({ url, dbUrl }, REMOTO), /lugares diferentes/, `${url} + ${dbUrl}`);
    }
  });

  test('psql recebe o host IPv6 sem colchetes (o psql não entende "[::1]")', () => {
    const opcao = ({ args }, nome) => args[args.indexOf(nome) + 1];
    const ipv6 = argumentosPsql('postgresql://postgres:s%40nha@[::1]:54322/postgres', 'select 1');
    assert.equal(opcao(ipv6, '-h'), '::1');
    assert.equal(opcao(ipv6, '-p'), '54322');
    assert.equal(opcao(ipv6, '-U'), 'postgres');
    assert.equal(opcao(ipv6, '-d'), 'postgres');
    assert.equal(opcao(ipv6, '-c'), 'select 1');
    assert.equal(ipv6.senha, 's@nha');
    assert.equal(opcao(argumentosPsql(LOCAL_DB, 'select 1'), '-h'), '127.0.0.1');
    const padrao = argumentosPsql('postgresql://u@localhost/db', 'x');
    assert.equal(opcao(padrao, '-h'), 'localhost');
    assert.equal(opcao(padrao, '-p'), '5432');
    assert.equal(padrao.senha, 'postgres');
    // A trava e o psql enxergam o mesmo host.
    assert.equal(conferirDestino({ url: 'http://[::1]:54321', dbUrl: 'postgresql://p:p@[::1]:54322/postgres' }, SEM).banco,
      opcao(ipv6, '-h'));
  });

  test('URL sem host ou malformada é recusada', () => {
    assert.throws(() => conferirDestino({ url: 'nao-e-url', dbUrl: LOCAL_DB }, SEM), /inválida/);
    assert.throws(() => conferirDestino({ url: 'http://127.0.0.1:54321', dbUrl: 'postgresql:///postgres' }, SEM), /sem host/);
  });

  test('ambienteLocal() aplica a trava (ex.: .env de produção exportado no terminal)', () => {
    const salvo = { url: process.env.SUPABASE_URL, remoto: process.env.AMA_TESTES_PERMITIR_REMOTO };
    const restaurar = (nome, valor) => {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    };
    try {
      process.env.SUPABASE_URL = 'https://abcdefgh.supabase.co';
      delete process.env.AMA_TESTES_PERMITIR_REMOTO;
      assert.throws(() => ambienteLocal(), /só rodam contra o Supabase local/);
      assert.throws(() => cliente(), /só rodam contra o Supabase local/);
    } finally {
      restaurar('SUPABASE_URL', salvo.url);
      restaurar('AMA_TESTES_PERMITIR_REMOTO', salvo.remoto);
    }
    assert.doesNotThrow(() => ambienteLocal());
  });
});

// --------------------------------------------------------------------------------------
// RLS (tabela 4.3)
// --------------------------------------------------------------------------------------

describe('RLS: matriz da tabela 4.3', () => {
  let pedidoBase;

  before(async () => {
    pedidoBase = await semErro(servico.from('pedidos').insert({
      cliente_nome: 'Cliente RLS', cliente_email: EMAIL_CLIENTE, cliente_telefone: '91981056049',
      cliente_cpf: '52998224725', entrega: ENTREGA_GRATIS, endereco: ENDERECO_DIRETO, subtotal_centavos: 1000, total_centavos: 1000,
    }).select().single(), 'pedido base');
  });

  // busca: coluna que identifica a linha; criar(): cria linhas com a chave de serviço e diz
  // quais passam pelo filtro público; nova(): linha para o teste de insert; patch: alteração.
  const TABELAS = {
    admins: {
      busca: 'user_id',
      criar: async () => ({
        todas: [usuarioAdmin.id, usuarioExtra.id],
        publicas: [],
        alvoUpdate: usuarioExtra.id,
        alvoDelete: usuarioExtra.id,
      }),
      nova: () => ({ user_id: usuarioComum.id, email: EMAIL_COMUM }),
      patch: { email: 'alterado@ama.local' },
      esperado: {
        anon: { select: 'nenhuma', insert: false, update: false, delete: false },
        comum: { select: 'nenhuma', insert: false, update: false, delete: false },
        admin: { select: 'todas', insert: false, update: false, delete: false },
      },
    },
    conteudo_site: {
      busca: 'chave',
      criar: async () => {
        const chaves = [1, 2].map(() => `teste.${SUF}.${seq()}`);
        await semErro(servico.from('conteudo_site').insert(chaves.map((chave) => ({ chave, valor: { texto: 'Olá' } }))), 'conteúdo');
        return { todas: chaves, publicas: chaves, alvoUpdate: chaves[0], alvoDelete: chaves[1] };
      },
      nova: () => ({ chave: `teste.${SUF}.${seq()}`, valor: { texto: 'novo' } }),
      patch: { valor: { texto: 'alterado' } },
      esperado: {
        anon: { select: 'todas', insert: false, update: false, delete: false },
        comum: { select: 'todas', insert: false, update: false, delete: false },
        admin: { select: 'todas', insert: true, update: true, delete: true },
      },
    },
    configuracoes: {
      busca: 'chave',
      criar: async () => {
        const [a, b, c] = [1, 2, 3].map(() => `teste_${SUF}_${seq()}`);
        await semErro(servico.from('configuracoes').insert([
          { chave: a, valor: { x: 1 }, publico: true },
          { chave: b, valor: { x: 2 }, publico: true },
          { chave: c, valor: { x: 3 }, publico: false },
        ]), 'configurações');
        return { todas: [a, b, c], publicas: [a, b], alvoUpdate: a, alvoDelete: b };
      },
      nova: () => ({ chave: `teste_${SUF}_${seq()}`, valor: { novo: true }, publico: true }),
      patch: { valor: { alterado: true } },
      esperado: {
        anon: { select: 'publicas', insert: false, update: false, delete: false },
        comum: { select: 'publicas', insert: false, update: false, delete: false },
        admin: { select: 'todas', insert: true, update: true, delete: true },
      },
    },
    categorias: {
      busca: 'id',
      criar: async () => {
        const a = await criarCategoria();
        const b = await criarCategoria();
        const c = await criarCategoria({ ativo: false });
        return { todas: [a.id, b.id, c.id], publicas: [a.id, b.id], alvoUpdate: a.id, alvoDelete: b.id };
      },
      nova: () => ({ id: randomUUID(), nome: 'Nova categoria', slug: `teste-${SUF}-${seq()}` }),
      patch: { nome: 'Categoria alterada' },
      esperado: {
        anon: { select: 'publicas', insert: false, update: false, delete: false },
        comum: { select: 'publicas', insert: false, update: false, delete: false },
        admin: { select: 'todas', insert: true, update: true, delete: true },
      },
    },
    produtos: {
      busca: 'id',
      criar: async () => {
        const a = await criarProduto();
        const b = await criarProduto();
        const c = await criarProduto({ ativo: false });
        return { todas: [a.id, b.id, c.id], publicas: [a.id, b.id], alvoUpdate: a.id, alvoDelete: b.id };
      },
      nova: () => ({ id: randomUUID(), nome: 'Novo produto', slug: `teste-${SUF}-${seq()}`, preco_centavos: 500, ativo: true }),
      patch: { nome: 'Produto alterado', preco_centavos: 1 },
      esperado: {
        anon: { select: 'publicas', insert: false, update: false, delete: false },
        comum: { select: 'publicas', insert: false, update: false, delete: false },
        admin: { select: 'todas', insert: true, update: true, delete: true },
      },
    },
    pedidos: {
      busca: 'id',
      criar: async () => {
        const linhas = [1, 2].map(() => ({
          id: randomUUID(), cliente_nome: 'Cliente RLS', cliente_email: EMAIL_CLIENTE, cliente_telefone: '91981056049',
          cliente_cpf: '52998224725', entrega: ENTREGA_GRATIS, endereco: ENDERECO_DIRETO, subtotal_centavos: 1000, total_centavos: 1000,
        }));
        await semErro(servico.from('pedidos').insert(linhas), 'pedidos');
        const ids = linhas.map((l) => l.id);
        return { todas: ids, publicas: [], alvoUpdate: ids[0], alvoDelete: ids[1] };
      },
      nova: () => ({
        id: randomUUID(), cliente_nome: 'Intruso', cliente_email: EMAIL_CLIENTE, cliente_telefone: '91981056049',
        cliente_cpf: '52998224725', entrega: ENTREGA_GRATIS, endereco: ENDERECO_DIRETO, subtotal_centavos: 1000, total_centavos: 1000,
      }),
      patch: { notas_internas: 'alterado', status: 'cancelado' },
      esperado: {
        anon: { select: 'nenhuma', insert: false, update: false, delete: false },
        comum: { select: 'nenhuma', insert: false, update: false, delete: false },
        admin: { select: 'todas', insert: false, update: true, delete: true },
      },
    },
    pedido_itens: {
      busca: 'nome',
      criar: async () => {
        const nomes = [1, 2].map(() => `item-${SUF}-${seq()}`);
        await semErro(servico.from('pedido_itens').insert(nomes.map((nome) => ({
          pedido_id: pedidoBase.id, nome, preco_unitario_centavos: 500, quantidade: 2, total_centavos: 1000,
        }))), 'itens');
        return { todas: nomes, publicas: [], alvoUpdate: nomes[0], alvoDelete: nomes[1] };
      },
      nova: () => ({
        pedido_id: pedidoBase.id, nome: `item-${SUF}-${seq()}`, preco_unitario_centavos: 1, quantidade: 1, total_centavos: 1,
      }),
      patch: { imagem: '/img/alterada.jpg', quantidade: 9 },
      esperado: {
        anon: { select: 'nenhuma', insert: false, update: false, delete: false },
        comum: { select: 'nenhuma', insert: false, update: false, delete: false },
        admin: { select: 'todas', insert: false, update: true, delete: true },
      },
    },
    pedido_eventos: {
      busca: 'descricao',
      criar: async () => {
        const descricoes = [1, 2].map(() => `evento-${SUF}-${seq()}`);
        await semErro(servico.from('pedido_eventos').insert(descricoes.map((descricao) => ({
          pedido_id: pedidoBase.id, tipo: 'nota', descricao, autor: 'sistema',
        }))), 'eventos');
        return { todas: descricoes, publicas: [], alvoUpdate: descricoes[0], alvoDelete: descricoes[1] };
      },
      nova: () => ({ pedido_id: pedidoBase.id, tipo: 'nota', descricao: `nota-${SUF}-${seq()}`, autor: EMAIL_ADMIN }),
      patch: { autor: 'alterado' },
      esperado: {
        anon: { select: 'nenhuma', insert: false, update: false, delete: false },
        comum: { select: 'nenhuma', insert: false, update: false, delete: false },
        admin: { select: 'todas', insert: true, update: true, delete: true },
      },
    },
  };

  const clientes = () => ({ anon, comum, admin });

  async function linhaPeloServico(tabela, coluna, valor, colunas = '*') {
    const dados = await semErro(servico.from(tabela).select(colunas).eq(coluna, valor), `ler ${tabela}`);
    return dados[0] || null;
  }

  for (const [tabela, def] of Object.entries(TABELAS)) {
    for (const papel of ['anon', 'comum', 'admin']) {
      const esperado = def.esperado[papel];
      const resumo = Object.entries(esperado).map(([op, v]) => `${op}=${v}`).join(' ');
      test(`${tabela} como ${papel}: ${resumo}`, async () => {
        const cl = clientes()[papel];
        const linhas = await def.criar();

        // select
        const { data: vistos, error: erroSelect } = await cl.from(tabela).select(def.busca).in(def.busca, linhas.todas);
        assert.ifError(erroSelect);
        const esperados = { todas: linhas.todas, publicas: linhas.publicas, nenhuma: [] }[esperado.select];
        assert.deepEqual(vistos.map((l) => l[def.busca]).sort(), [...esperados].sort(), 'select');

        // insert
        const nova = def.nova();
        const { error: erroInsert } = await cl.from(tabela).insert(nova);
        const inserida = await linhaPeloServico(tabela, def.busca, nova[def.busca]);
        if (esperado.insert) {
          assert.ifError(erroInsert);
          assert.ok(inserida, 'linha deveria ter sido inserida');
        } else {
          assert.ok(erroInsert, 'insert deveria falhar');
          assert.equal(erroInsert.code, '42501', `insert: ${erroInsert.message}`);
          // admins: a linha do usuário comum não pode existir (ele não é admin).
          assert.equal(inserida, null, 'linha não deveria existir');
        }

        // update (sem permissão, a RLS só filtra: nenhuma linha muda e não há erro)
        const antes = await linhaPeloServico(tabela, def.busca, linhas.alvoUpdate);
        const { error: erroUpdate } = await cl.from(tabela).update(def.patch).eq(def.busca, linhas.alvoUpdate);
        assert.ifError(erroUpdate);
        const depois = await linhaPeloServico(tabela, def.busca, linhas.alvoUpdate);
        for (const [coluna, valor] of Object.entries(def.patch)) {
          if (esperado.update) assert.deepEqual(depois[coluna], valor, `update de ${coluna}`);
          else assert.deepEqual(depois[coluna], antes[coluna], `${coluna} não deveria mudar`);
        }

        // delete
        const { error: erroDelete } = await cl.from(tabela).delete().eq(def.busca, linhas.alvoDelete);
        assert.ifError(erroDelete);
        const restante = await linhaPeloServico(tabela, def.busca, linhas.alvoDelete);
        if (esperado.delete) assert.equal(restante, null, 'linha deveria ter sido apagada');
        else assert.ok(restante, 'linha não deveria ter sido apagada');
      });
    }
  }

  test('anon e comum leem só produtos e categorias ativos e só configurações públicas (dados reais)', async () => {
    for (const cl of [anon, comum]) {
      const produtos = await semErro(cl.from('produtos').select('slug, ativo'), 'produtos');
      assert.ok(produtos.length > 0, 'deveria haver produtos ativos (seed)');
      assert.ok(produtos.every((p) => p.ativo === true));
      const categorias = await semErro(cl.from('categorias').select('slug, ativo'), 'categorias');
      assert.ok(categorias.every((c) => c.ativo === true));
      const configuracoes = await semErro(cl.from('configuracoes').select('chave, publico'), 'configurações');
      const chaves = configuracoes.map((c) => c.chave);
      assert.ok(chaves.includes('loja'));
      for (const privada of ['frete', 'checkout', 'notificacoes']) assert.ok(!chaves.includes(privada), privada);
      assert.ok(configuracoes.every((c) => c.publico === true));
      for (const tabela of ['pedidos', 'pedido_itens', 'pedido_eventos', 'admins']) {
        assert.deepEqual(await semErro(cl.from(tabela).select('*').limit(5), tabela), [], tabela);
      }
    }
    // Os valores podem ser editados no painel; o formato (as chaves do §4.1) não muda.
    const loja = await semErro(anon.from('configuracoes').select('valor').eq('chave', 'loja').single(), 'loja');
    for (const chave of ['titulo', 'subtitulo', 'whatsapp', 'instagram', 'email_contato', 'aviso_topo', 'frete_gratis_acima_centavos']) {
      assert.ok(Object.hasOwn(loja.valor, chave), `loja.${chave}`);
    }
  });

  test('admin lê configurações privadas, produtos inativos e pedidos', async () => {
    const configuracoes = await semErro(admin.from('configuracoes').select('chave'), 'configurações');
    const chaves = configuracoes.map((c) => c.chave);
    for (const chave of ['loja', 'frete', 'checkout', 'notificacoes']) assert.ok(chaves.includes(chave), chave);
    const inativo = await criarProduto({ ativo: false });
    const lidos = await semErro(admin.from('produtos').select('id').eq('id', inativo.id), 'produto inativo');
    assert.equal(lidos.length, 1);
    const pedidos = await semErro(admin.from('pedidos').select('id').eq('id', pedidoBase.id), 'pedido');
    assert.equal(pedidos.length, 1);
  });

  test('admin salva conteúdo com upsert e o gatilho registra autor e data', async () => {
    const chave = `teste.${SUF}.${seq()}`;
    await semErro(admin.from('conteudo_site').upsert({ chave, valor: { texto: 'v1' } }, { onConflict: 'chave' }), 'upsert 1');
    const primeira = await sqlJson(`select row_to_json(c) from public.conteudo_site c where chave = ${lit(chave)}`);
    assert.equal(primeira.atualizado_por, usuarioAdmin.id);
    await semErro(admin.from('conteudo_site').upsert({ chave, valor: { texto: 'v2' } }, { onConflict: 'chave' }), 'upsert 2');
    const segunda = await sqlJson(`select row_to_json(c) from public.conteudo_site c where chave = ${lit(chave)}`);
    assert.deepEqual(segunda.valor, { texto: 'v2' });
    assert.ok(new Date(segunda.atualizado_em) >= new Date(primeira.atualizado_em));
    const { error } = await admin.from('conteudo_site').insert({ chave: 'Chave Inválida!', valor: {} });
    assert.equal(error?.code, '23514', 'check da chave');
  });

  test('admin registra nota em pedido_eventos; ninguém além do service_role cria pedidos', async () => {
    const descricao = `Nota interna ${SUF}`;
    const evento = await semErro(admin.from('pedido_eventos').insert({
      pedido_id: pedidoBase.id, tipo: 'nota', descricao, autor: EMAIL_ADMIN,
    }).select().single(), 'nota');
    assert.equal(evento.tipo, 'nota');
    assert.ok(Number.isInteger(evento.id));

    for (const cl of [anon, comum, admin]) {
      const { error } = await cl.from('pedidos').insert({
        cliente_nome: 'X', cliente_email: EMAIL_CLIENTE, cliente_telefone: '91981056049', cliente_cpf: '52998224725',
        entrega: ENTREGA_GRATIS, endereco: ENDERECO_DIRETO, subtotal_centavos: 1, total_centavos: 1,
      });
      assert.equal(error?.code, '42501');
    }
    const direto = await semErro(servico.from('pedidos').insert({
      cliente_nome: 'Serviço', cliente_email: EMAIL_CLIENTE, cliente_telefone: '91981056049', cliente_cpf: '52998224725',
      entrega: ENTREGA_GRATIS, endereco: ENDERECO_DIRETO, subtotal_centavos: 1, total_centavos: 1,
    }).select('numero, token_acesso').single(), 'pedido pelo serviço');
    assert.ok(direto.numero >= 1001);
    assert.match(direto.token_acesso, /^[0-9a-f]{64}$/);
  });

  test('admin só insere notas em pedido_eventos (pagamento, status, alerta… são recusados)', async () => {
    for (const tipo of ['pagamento', 'status', 'alerta', 'criado', 'envio', 'email']) {
      const descricao = `evento-${tipo}-${SUF}-${seq()}`;
      const { error } = await admin.from('pedido_eventos').insert({
        pedido_id: pedidoBase.id, tipo, descricao, autor: 'mercadopago',
        dados: { payment_id: '901', status: 'approved' },
      });
      assert.equal(error?.code, '42501', `${tipo}: ${error?.message}`);
      assert.equal(await sql(`select count(*) from public.pedido_eventos where descricao = ${lit(descricao)}`), '0', tipo);
    }
    const policies = await sqlJson(`select json_object_agg(policyname, cmd) from pg_policies
                                     where schemaname = 'public' and tablename = 'pedido_eventos'`);
    assert.deepEqual(policies, {
      pedido_eventos_admin_select: 'SELECT', pedido_eventos_admin_insert: 'INSERT',
      pedido_eventos_admin_update: 'UPDATE', pedido_eventos_admin_delete: 'DELETE',
    });
  });

  test('admin só altera notas em pedido_eventos: não troca o tipo nem mexe em eventos do servidor', async () => {
    const { produto, pedido } = await cenario({ estoque: 10, quantidade: 2 });
    const pag = pagamento(pedido);
    const lerEvento = (id) => sqlJson(`select row_to_json(e) from public.pedido_eventos e where e.id = ${Number(id)}`);

    // Ataque: criar uma nota "do Mercado Pago" e trocar o tipo para 'pagamento' (with check recusa).
    const nota = await semErro(admin.from('pedido_eventos').insert({
      pedido_id: pedido.id, tipo: 'nota', descricao: `nota-${SUF}-${seq()}`, autor: 'mercadopago',
    }).select().single(), 'nota');
    for (const patch of [
      { tipo: 'pagamento', dados: { payment_id: String(pag.id), status: 'approved' } },
      { tipo: 'alerta' },
    ]) {
      const { error } = await admin.from('pedido_eventos').update(patch).eq('id', nota.id);
      assert.equal(error?.code, '42501', `${JSON.stringify(patch)}: ${error?.message}`);
    }
    const notaDepois = await lerEvento(nota.id);
    assert.equal(notaDepois.tipo, 'nota');
    assert.equal(notaDepois.dados, null);

    // O pagamento real continua sendo processado (não parece repetido).
    const r = await confirmar(pedido.id, pag);
    assert.equal(r.virou_pago, true);
    assert.equal(await lerEstoque(produto.id), 8);

    // Eventos gravados pelo servidor ficam fora do alcance do update do admin (a RLS filtra: 0 linhas).
    for (const tipo of ['criado', 'pagamento']) {
      const [evento] = await lerEventos(pedido.id, tipo);
      const { data, error } = await admin.from('pedido_eventos')
        .update({ tipo: 'nota', descricao: 'apagado', dados: { payment_id: '1', status: 'pending' } })
        .eq('id', evento.id)
        .select();
      assert.ifError(error);
      assert.deepEqual(data, [], tipo);
      assert.deepEqual(await lerEvento(evento.id), evento, tipo);
    }

    // Editar o texto da nota continua liberado.
    const editada = await semErro(admin.from('pedido_eventos').update({ descricao: 'Nota corrigida' })
      .eq('id', nota.id).select().single(), 'editar nota');
    assert.equal(editada.descricao, 'Nota corrigida');

    const politica = await sqlJson(`select json_build_object('qual', qual, 'with_check', with_check) from pg_policies
                                     where schemaname = 'public' and policyname = 'pedido_eventos_admin_update'`);
    assert.match(politica.qual, /tipo = 'nota'/);
    assert.match(politica.with_check, /tipo = 'nota'/);
  });

  test('a numeração dos pedidos começa em 1001 (pg_sequence)', async () => {
    const inicio = await sql(`select seqstart from pg_sequence where seqrelid = 'public.pedidos_numero_seq'::regclass`);
    assert.equal(inicio, '1001');
  });
});

// --------------------------------------------------------------------------------------
// Catálogo inicial criado pela migração (§4.5)
// --------------------------------------------------------------------------------------

describe('catálogo inicial (seção 10 da migração, rodada isolada numa transação desfeita no fim)', () => {
  const CATEGORIAS = [
    ['body-splash', 'Body Splash'],
    ['cremes-hidratantes', 'Cremes Hidratantes'],
    ['sabonete-liquido-intimo', 'Sabonete Líquido Íntimo'],
    ['sabonete-solido', 'Sabonete Sólido'],
    ['biojoias', 'Biojoias'],
  ];
  // [slug, nome, categoria] na ordem da vitrine.
  const AMA = [
    ['body-splash-raiz', 'Body Splash Raiz', 'body-splash'],
    ['body-splash-bruma', 'Body Splash Bruma', 'body-splash'],
    ['body-splash-orvalho', 'Body Splash Orvalho', 'body-splash'],
    ['body-splash-ambar', 'Body Splash Âmbar', 'body-splash'],
    ['creme-hidratante-ameixa-negra', 'Creme Hidratante Ameixa Negra', 'cremes-hidratantes'],
    ['creme-hidratante-cupuacu', 'Creme Hidratante Cupuaçu', 'cremes-hidratantes'],
    ['creme-hidratante-cumaru', 'Creme Hidratante Cumaru', 'cremes-hidratantes'],
    ['creme-hidratante-capim-limao', 'Creme Hidratante Capim-Limão', 'cremes-hidratantes'],
    ['sabonete-liquido-intimo-barbatimao-andiroba', 'Sabonete Líquido Íntimo Barbatimão & Andiroba', 'sabonete-liquido-intimo'],
    ['sabonete-solido-manteiga-cupuacu', 'Sabonete Sólido Manteiga de Cupuaçu', 'sabonete-solido'],
  ];
  const BIOJOIAS = ['biojoia-01', 'biojoia-02', 'biojoia-03', 'biojoia-04', 'biojoia-05', 'biojoia-06'];
  const SLUGS = [...AMA.map(([slug]) => slug), ...BIOJOIAS];
  const SLUGS_SQL = SLUGS.map(lit).join(',');
  const CATEGORIAS_SQL = CATEGORIAS.map(([slug]) => lit(slug)).join(',');
  const SEED = fileURLToPath(new URL('../../supabase/seed.sql', import.meta.url));

  function trecho(texto, regex, nome) {
    const achados = texto.match(new RegExp(regex.source, 'g')) || [];
    assert.equal(achados.length, 1, `${nome}: esperado 1 trecho, achados ${achados.length}`);
    return achados[0];
  }

  // Estado dos 16 produtos e 5 categorias + a cotação de 1 unidade de cada um.
  const FOTO = `json_build_object(
    'categorias', (select json_agg(json_build_object('slug', c.slug, 'nome', c.nome, 'ativo', c.ativo, 'ordem', c.ordem)
                                   order by c.ordem, c.slug)
                     from public.categorias c where c.slug in (${CATEGORIAS_SQL})),
    'produtos', (select json_agg(json_build_object(
                   'id', p.id, 'slug', p.slug, 'nome', p.nome, 'descricao', p.descricao, 'categoria', c.slug,
                   'preco', p.preco_centavos, 'promocional', p.preco_promocional_centavos, 'estoque', p.estoque,
                   'ativo', p.ativo, 'destaque', p.destaque, 'controlar', p.controlar_estoque,
                   'imagens', p.imagens, 'ordem', p.ordem, 'peso', p.peso_gramas) order by p.ordem, p.slug)
                   from public.produtos p left join public.categorias c on c.id = p.categoria_id
                  where p.slug in (${SLUGS_SQL})),
    'cotacao', public.cotar_carrinho(jsonb_build_object('itens',
                 (select jsonb_agg(jsonb_build_object('produto_id', p.id, 'quantidade', 1) order by p.ordem)
                    from public.produtos p where p.slug in (${SLUGS_SQL}))))
  )`;

  let fotos;
  before(async () => {
    const migracao = readFileSync(MIGRACAO, 'utf8');
    const categorias = trecho(migracao, /insert into public\.categorias \(nome, slug, descricao, ordem\) values[\s\S]*?on conflict \(slug\) do nothing;/, 'categorias');
    const produtos = trecho(migracao, /insert into public\.produtos \(nome, slug, descricao, preco_centavos[\s\S]*?on conflict \(slug\) do nothing;/, 'produtos');
    const precosTeste = trecho(migracao, /update public\.produtos p\s+set preco_centavos = v\.preco,[\s\S]*?and p\.estoque = 0;/, 'preços de teste');
    const seed = trecho(readFileSync(SEED, 'utf8'), /update public\.produtos p[\s\S]*?where p\.slug = v\.slug;/, 'seed');
    // Tudo numa transação desfeita no fim: não depende do seed já aplicado nem do que o painel ou os E2E editaram.
    fotos = await sqlJson(`
      begin;
      create temp table _foto (etapa text primary key, dados json) on commit drop;
      delete from public.produtos where slug in (${SLUGS_SQL});
      delete from public.categorias where slug in (${CATEGORIAS_SQL});
      ${categorias}
      ${produtos}
      insert into _foto select 'migracao', ${FOTO};
      ${seed}
      insert into _foto select 'seed', ${FOTO};
      -- A AMA edita no painel; rodar a migração de novo não desfaz nem duplica nada.
      update public.produtos set nome = 'Colar Semente Verde', preco_centavos = 8900, ativo = false where slug = 'biojoia-01';
      update public.categorias set nome = 'Biojoias da AMA', ativo = false where slug = 'biojoias';
      ${categorias}
      ${produtos}
      ${precosTeste}
      insert into _foto select 'reexecucao', ${FOTO};
      -- Projeto criado com a versão antiga (preço 0 e estoque 0): o update preenche só o que continua zerado.
      update public.produtos set preco_centavos = 0, preco_promocional_centavos = null, estoque = 0 where slug in (${SLUGS_SQL});
      update public.produtos set estoque = 5 where slug = 'biojoia-02';
      update public.produtos set preco_centavos = 1000 where slug = 'biojoia-03';
      ${precosTeste}
      insert into _foto select 'projeto_antigo', ${FOTO};
      select json_object_agg(etapa, dados) from _foto;
      rollback;
    `);
  });

  // Preços de teste (placeholder) por categoria, em centavos.
  const PRECO_TESTE = {
    'body-splash': 5990, 'cremes-hidratantes': 6990, 'sabonete-liquido-intimo': 4990, 'sabonete-solido': 2490, biojoias: 8990,
  };

  test('a migração cria as 5 categorias e os 16 produtos ATIVOS, com preços e estoque de teste, nas categorias certas', () => {
    const { categorias, produtos, cotacao } = fotos.migracao;
    assert.deepEqual(categorias, CATEGORIAS.map(([slug, nome], i) => ({ slug, nome, ativo: true, ordem: i + 1 })));
    assert.deepEqual(produtos.map((p) => p.slug), SLUGS);
    assert.deepEqual(produtos.map((p) => p.ordem), SLUGS.map((_, i) => i + 1));
    for (const p of produtos) {
      assert.equal(p.ativo, true, `${p.slug} ativo`);
      assert.equal(p.preco, PRECO_TESTE[p.categoria], `${p.slug} preço`);
      assert.equal(p.promocional, null, `${p.slug} promocional`);
      assert.equal(p.estoque, 10, `${p.slug} estoque`);
      assert.equal(p.controlar, true, `${p.slug} controlar_estoque`);
      assert.equal(p.destaque, false, `${p.slug} destaque`);
      assert.ok(p.peso > 0, `${p.slug} peso`);
    }
    for (const [slug, nome, categoria] of AMA) {
      const p = produtos.find((x) => x.slug === slug);
      assert.equal(p.nome, nome, slug);
      assert.equal(p.categoria, categoria, slug);
      assert.ok(p.descricao.length > 100 && !/em produção/i.test(p.descricao), `${slug}: descrição real`);
      assert.equal(p.imagens[0].src, `/img/produtos/${slug}.jpg`, slug);
    }
    for (const slug of BIOJOIAS) {
      const p = produtos.find((x) => x.slug === slug);
      assert.equal(p.nome, 'Nome em Produção', slug);
      assert.equal(p.descricao, 'Descrição em Produção', slug);
      assert.equal(p.categoria, 'biojoias', slug);
    }
    // Todos podem ser comprados nos testes de funcionamento.
    assert.equal(cotacao.itens.length, 16);
    for (const item of cotacao.itens) {
      const p = produtos.find((x) => x.id === item.produto_id);
      assert.equal(item.disponivel, true, p.slug);
      assert.equal(item.motivo, null, p.slug);
      assert.equal(item.nome, p.nome, p.slug);
      assert.equal(item.preco_unitario_centavos, PRECO_TESTE[p.categoria], p.slug);
    }
    assert.equal(cotacao.subtotal_centavos, 4 * 5990 + 4 * 6990 + 4990 + 2490 + 6 * 8990);
  });

  test('projeto antigo (catálogo com preço 0 e estoque 0): o update preenche só o que continua zerado', () => {
    const { produtos } = fotos.projeto_antigo;
    for (const p of produtos) {
      if (p.slug === 'biojoia-02') assert.deepEqual([p.preco, p.estoque], [0, 5], 'estoque editado: não muda');
      else if (p.slug === 'biojoia-03') assert.deepEqual([p.preco, p.estoque], [1000, 0], 'preço editado: não muda');
      else assert.deepEqual([p.preco, p.estoque], [PRECO_TESTE[p.categoria], 10], p.slug);
    }
  });

  test('cada produto tem uma foto com texto alternativo e o arquivo existe em public/', () => {
    for (const p of fotos.migracao.produtos) {
      assert.equal(p.imagens.length, 1, p.slug);
      const [{ src, alt }] = p.imagens;
      assert.match(src, /^\/img\/[a-z0-9/-]+\.jpg$/, p.slug);
      assert.ok(alt && alt.length > 10, `${p.slug}: alt`);
      assert.ok(existsSync(`${PUBLIC}${src.slice(1)}`), `falta public${src}`);
    }
    const migracao = readFileSync(MIGRACAO, 'utf8');
    const doArquivo = [...new Set(migracao.match(/'\/img\/[^']+'/g).map((s) => s.slice(1, -1)))];
    assert.equal(doArquivo.length, 16, `fotos na migração: ${doArquivo.length}`);
    // O catálogo antigo (Cosméticos, Body Splash 200mL, Colar 01–06) saiu da migração.
    for (const antigo of ["'cosmeticos'", 'body-splash-200ml', 'colar-01', 'Colar 06']) {
      assert.ok(!migracao.includes(antigo), antigo);
    }
  });

  test('seed (dev): 1 promoção e 2–3 destaques na coleção Ama Bioessência; biojoias com os preços de teste', () => {
    const { produtos, cotacao } = fotos.seed;
    const ama = produtos.filter((p) => !BIOJOIAS.includes(p.slug));
    for (const p of ama) {
      assert.ok(p.preco > 0, `${p.slug} preço`);
      assert.equal(p.estoque, 10, `${p.slug} estoque`);
      assert.equal(p.ativo, true, `${p.slug} ativo`);
    }
    const promocoes = ama.filter((p) => p.promocional !== null);
    assert.equal(promocoes.length, 1);
    assert.ok(promocoes[0].promocional > 0 && promocoes[0].promocional < promocoes[0].preco);
    const destaques = ama.filter((p) => p.destaque).length;
    assert.ok(destaques >= 2 && destaques <= 3, `destaques: ${destaques}`);
    for (const p of produtos.filter((x) => BIOJOIAS.includes(x.slug))) {
      assert.deepEqual([p.preco, p.estoque, p.ativo, p.nome], [8990, 10, true, 'Nome em Produção'], p.slug);
    }
    for (const item of cotacao.itens) {
      const p = produtos.find((x) => x.id === item.produto_id);
      assert.equal(item.disponivel, true, p.slug);
      assert.equal(item.preco_unitario_centavos, p.promocional ?? p.preco, p.slug);
    }
  });

  test('rodar a migração de novo não duplica nem desfaz o que a AMA editou', () => {
    const { categorias, produtos } = fotos.reexecucao;
    assert.equal(produtos.length, 16);
    assert.equal(categorias.length, 5);
    const colar = produtos.find((p) => p.slug === 'biojoia-01');
    assert.deepEqual([colar.nome, colar.preco, colar.ativo], ['Colar Semente Verde', 8900, false]);
    const biojoias = categorias.find((c) => c.slug === 'biojoias');
    assert.deepEqual([biojoias.nome, biojoias.ativo], ['Biojoias da AMA', false]);
    // O resto continua como o seed deixou (mesmo id, preço, estoque e promoção).
    const semColar = (lista) => lista.filter((p) => p.slug !== 'biojoia-01');
    assert.deepEqual(semColar(produtos), semColar(fotos.seed.produtos));
  });
});

// --------------------------------------------------------------------------------------
// GRANTs, EXECUTE e definição das funções
// --------------------------------------------------------------------------------------

describe('GRANTs e permissões de execução', () => {
  const TABELAS = ['admins', 'conteudo_site', 'configuracoes', 'categorias', 'produtos', 'pedidos', 'pedido_itens', 'pedido_eventos'];
  const RPCS_SERVICO = ['cotar_carrinho', 'criar_pedido', 'confirmar_pagamento', 'alterar_status_pedido'];

  test('sistema de cupons removido: sem tabela cupons e sem colunas de cupom/desconto em pedidos', async () => {
    assert.equal(await sql(`select to_regclass('public.cupons') is null`), 't');
    const colunas = await sqlJson(`select coalesce(json_agg(column_name), '[]'::json) from information_schema.columns
                                    where table_schema = 'public' and table_name = 'pedidos'
                                      and column_name in ('cupom_codigo', 'desconto_centavos')`);
    assert.deepEqual(colunas, []);
  });

  test('RLS ativada em todas as tabelas de public', async () => {
    const semRls = await sqlJson(`select coalesce(json_agg(relname), '[]'::json) from pg_class
                                   where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity`);
    assert.deepEqual(semRls, []);
  });

  test('GRANT explícito de select/insert/update/delete para anon, authenticated e service_role (sem truncate)', async () => {
    const linhas = await sqlJson(`
      select json_agg(json_build_object(
        't', t, 'r', r,
        'ok', has_table_privilege(r, 'public.' || t, 'select') and has_table_privilege(r, 'public.' || t, 'insert')
              and has_table_privilege(r, 'public.' || t, 'update') and has_table_privilege(r, 'public.' || t, 'delete'),
        'truncate', has_table_privilege(r, 'public.' || t, 'truncate')))
        from unnest(array[${TABELAS.map(lit).join(',')}]) t,
             unnest(array['anon', 'authenticated', 'service_role']) r`);
    for (const l of linhas) {
      assert.equal(l.ok, true, `${l.r} em ${l.t}`);
      if (l.r !== 'service_role') assert.equal(l.truncate, false, `truncate de ${l.r} em ${l.t}`);
    }
    const sequencias = await sqlJson(`
      select json_agg(has_sequence_privilege(r, s, 'usage'))
        from unnest(array['public.pedidos_numero_seq', 'public.pedido_itens_id_seq', 'public.pedido_eventos_id_seq']) s,
             unnest(array['anon', 'authenticated', 'service_role']) r`);
    assert.ok(sequencias.every(Boolean), 'usage nas sequências');
  });

  test('funções RPC: security definer e search_path vazio', async () => {
    const funcoes = await sqlJson(`
      select json_object_agg(proname, json_build_object('definer', prosecdef, 'config', proconfig))
        from pg_proc where pronamespace = 'public'::regnamespace
         and proname in ('eh_admin', ${RPCS_SERVICO.map(lit).join(',')})`);
    assert.equal(Object.keys(funcoes).length, 5);
    for (const [nome, f] of Object.entries(funcoes)) {
      assert.equal(f.definer, true, `${nome} security definer`);
      assert.ok(f.config.includes('search_path=""'), `${nome} search_path: ${f.config}`);
    }
  });

  test('EXECUTE: eh_admin para anon/authenticated; RPCs só service_role; _privadas para ninguém', async () => {
    const FUNCOES = ['eh_admin', '_formatar_reais', '_rotulo_status', '_baixar_estoque', '_repor_estoque', ...RPCS_SERVICO];
    const matriz = await sqlJson(`
      select json_object_agg(p.oid::regprocedure::text || '/' || r,
                             has_function_privilege(r, p.oid, 'execute'))
        from pg_proc p, unnest(array['anon', 'authenticated', 'service_role']) r
       where p.pronamespace = 'public'::regnamespace
         and p.proname in (${FUNCOES.map(lit).join(',')})`);
    assert.equal(Object.keys(matriz).length, FUNCOES.length * 3);
    for (const [chave, pode] of Object.entries(matriz)) {
      const [funcao, papel] = chave.split('/');
      let esperado;
      if (funcao.startsWith('eh_admin')) esperado = true;
      else if (funcao.startsWith('_')) esperado = false;
      else esperado = papel === 'service_role';
      assert.equal(pode, esperado, `${papel} → ${funcao}`);
    }
    // PUBLIC (todos os papéis): nenhuma dessas funções pode ter o EXECUTE padrão.
    // proacl NULL significa o padrão do Postgres, que libera EXECUTE para PUBLIC.
    const comPublic = await sqlJson(`
      select coalesce(json_agg(p.oid::regprocedure::text), '[]'::json)
        from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.pronamespace = 'public'::regnamespace
         and p.proname in (${FUNCOES.map(lit).join(',')})
         and a.grantee = 0 and a.privilege_type = 'EXECUTE'`);
    assert.deepEqual(comPublic, []);
  });

  test('anon, comum e admin não chamam as RPCs restritas nem as _privadas pela API', async () => {
    const { pedido, produto } = await cenario({ estoque: 5, quantidade: 1 });
    const chamadas = [
      ['cotar_carrinho', { p: { itens: [{ produto_id: produto.id, quantidade: 1 }] } }],
      ['criar_pedido', { p: dadosPedido([{ produto_id: produto.id, quantidade: 1 }]) }],
      ['confirmar_pagamento', { p_pedido_id: pedido.id, p_pagamento: pagamento(pedido) }],
      ['alterar_status_pedido', { p_pedido_id: pedido.id, p_status: 'pago', p_autor: 'intruso' }],
      ['_baixar_estoque', { p_pedido_id: pedido.id }],
      ['_repor_estoque', { p_pedido_id: pedido.id }],
      ['_formatar_reais', { p_centavos: 100 }],
      ['_rotulo_status', { p_status: 'pago' }],
    ];
    const pedidosAntes = await contarPedidosDoCliente();
    for (const [papel, cl] of Object.entries({ anon, comum, admin })) {
      for (const [nome, args] of chamadas) {
        const erro = await erroRpc(cl, nome, args);
        assert.equal(erro.code, '42501', `${papel} → ${nome}: ${erro.message}`);
      }
    }
    // O service_role também não chama as funções internas diretamente.
    for (const [nome, args] of chamadas.filter(([nome]) => nome.startsWith('_'))) {
      const erro = await erroRpc(servico, nome, args);
      assert.equal(erro.code, '42501', `service_role → ${nome}`);
    }
    const depois = await lerPedido(pedido.id);
    assert.equal(depois.status, 'aguardando_pagamento');
    assert.equal(depois.estoque_baixado, false);
    assert.equal(await lerEstoque(produto.id), 5);
    assert.equal(await contarPedidosDoCliente(), pedidosAntes);
  });

  test('eh_admin: anon false, comum false, admin true', async () => {
    assert.equal(await semErro(anon.rpc('eh_admin'), 'anon'), false);
    assert.equal(await semErro(comum.rpc('eh_admin'), 'comum'), false);
    assert.equal(await semErro(admin.rpc('eh_admin'), 'admin'), true);
  });
});

// --------------------------------------------------------------------------------------
// cotar_carrinho
// --------------------------------------------------------------------------------------

describe('cotar_carrinho', () => {
  const p = {};
  const cotar = (entrada) => semErro(servico.rpc('cotar_carrinho', { p: entrada }), 'cotar_carrinho');
  const item = (produto, quantidade) => ({ produto_id: produto.id ?? produto, quantidade });

  before(async () => {
    p.a = await criarProduto({
      preco_centavos: 4500, estoque: 3, imagens: [{ src: '/img/teste-a.jpg', alt: 'A' }, { src: '/img/teste-b.jpg', alt: 'B' }],
      peso_gramas: 250, altura_cm: 5, largura_cm: 11.5, comprimento_cm: 17,
    });
    p.promo = await criarProduto({ preco_centavos: 10000, preco_promocional_centavos: 7490, estoque: 10 });
    p.livre = await criarProduto({ preco_centavos: 1000, estoque: 0, controlar_estoque: false });
    p.inativo = await criarProduto({ preco_centavos: 1000, estoque: 5, ativo: false });
    p.precoZero = await criarProduto({ preco_centavos: 0, estoque: 5 });
    p.promoZero = await criarProduto({ preco_centavos: 1000, preco_promocional_centavos: 0, estoque: 5 });
    p.semEstoque = await criarProduto({ preco_centavos: 1000, estoque: 0 });
    p.pouco = await criarProduto({ preco_centavos: 1000, estoque: 2 });
    p.inativoZero = await criarProduto({ preco_centavos: 0, estoque: 0, ativo: false });
    p.zeroSemEstoque = await criarProduto({ preco_centavos: 0, estoque: 0, imagens: [{ src: '/img/teste-zero.jpg', alt: 'Z' }] });
    p.quebrado = await criarProduto({ preco_centavos: 4999, estoque: 50 });
  });

  test('item disponível: formato completo da saída', async () => {
    const r = await cotar({ itens: [item(p.a, 2)] });
    assert.deepEqual(r, {
      itens: [{
        produto_id: p.a.id, nome: p.a.nome, slug: p.a.slug, imagem: '/img/teste-a.jpg',
        preco_unitario_centavos: 4500, quantidade: 2, total_centavos: 9000, estoque_disponivel: 3,
        disponivel: true, motivo: null, peso_gramas: 250, altura_cm: 5, largura_cm: 11.5, comprimento_cm: 17,
      }],
      subtotal_centavos: 9000,
    });
  });

  test('junta linhas repetidas do mesmo produto (inclusive id em maiúsculas e com espaços)', async () => {
    const r = await cotar({
      itens: [item(p.a, 1), item(p.promo, 1), { produto_id: ` ${p.a.id.toUpperCase()} `, quantidade: 1 }],
    });
    assert.deepEqual(r.itens.map((i) => [i.produto_id, i.quantidade]), [[p.a.id, 2], [p.promo.id, 1]]);
    assert.equal(r.subtotal_centavos, 2 * 4500 + 7490);
  });

  test('ignora quantidade <= 0 e lixo; aceita quantidade em texto e trunca decimais', async () => {
    const r = await cotar({
      itens: [
        item(p.a, 0), item(p.a, -3), null, 7, 'texto', [], { quantidade: 2 }, { produto_id: 12345, quantidade: 1 },
        item(p.promo, 'abc'), item(p.promo, true), item(p.promo, null), { produto_id: p.promo.id },
        item(p.livre, '3'), item(p.quebrado, 2.9), { produto_id: '', quantidade: 1 }, { produto_id: '   ', quantidade: 1 },
      ],
    });
    assert.deepEqual(r.itens.map((i) => [i.produto_id, i.quantidade]), [[p.livre.id, 3], [p.quebrado.id, 2]]);
    assert.equal(r.subtotal_centavos, 3 * 1000 + 2 * 4999);
  });

  test('limita a 99 unidades por linha (também depois de juntar)', async () => {
    for (const itens of [[item(p.livre, 150)], [item(p.livre, 60), item(p.livre, 60)], [item(p.livre, 1e12)]]) {
      const r = await cotar({ itens });
      assert.equal(r.itens.length, 1);
      assert.equal(r.itens[0].quantidade, 99);
      assert.equal(r.itens[0].total_centavos, 99 * 1000);
    }
  });

  test('limita a 30 linhas, na ordem em que chegaram', async () => {
    const ids = Array.from({ length: 31 }, () => randomUUID());
    const r = await cotar({ itens: ids.map((id) => item(id, 1)) });
    assert.equal(r.itens.length, 30);
    assert.deepEqual(r.itens.map((i) => i.produto_id), ids.slice(0, 30));
    assert.ok(r.itens.every((i) => i.motivo === 'inexistente' && i.disponivel === false));
    assert.equal(r.subtotal_centavos, 0);
  });

  test('motivos de indisponibilidade; itens indisponíveis não somam', async () => {
    const r = await cotar({
      itens: [
        item(p.a, 1), item(randomUUID(), 1), item('nao-e-uuid', 1), item(p.inativo, 1), item(p.precoZero, 1),
        item(p.promoZero, 1), item(p.semEstoque, 1), item(p.pouco, 3),
      ],
    });
    assert.deepEqual(r.itens.map((i) => i.motivo),
      [null, 'inexistente', 'inexistente', 'inativo', 'sem_preco', 'sem_preco', 'sem_estoque', 'estoque_insuficiente']);
    assert.deepEqual(r.itens.map((i) => i.disponivel), [true, false, false, false, false, false, false, false]);
    for (const indisponivel of r.itens.slice(1)) assert.equal(indisponivel.total_centavos, 0);
    assert.equal(r.itens[7].estoque_disponivel, 2);
    assert.equal(r.itens[6].estoque_disponivel, 0);
    assert.equal(r.subtotal_centavos, 4500);
  });

  test('inexistente e inativo não expõem dados do produto', async () => {
    const fantasma = randomUUID();
    const r = await cotar({ itens: [item(fantasma, 2), item('nao-e-uuid', 1), item(p.inativo, 3)] });
    const oculto = (produtoId, quantidade, motivo) => ({
      produto_id: produtoId, nome: null, slug: null, imagem: null, preco_unitario_centavos: 0,
      quantidade, total_centavos: 0, estoque_disponivel: null, disponivel: false, motivo,
      peso_gramas: null, altura_cm: null, largura_cm: null, comprimento_cm: null,
    });
    assert.deepEqual(r.itens, [
      oculto(fantasma, 2, 'inexistente'),
      oculto('nao-e-uuid', 1, 'inexistente'),
      oculto(p.inativo.id, 3, 'inativo'),
    ]);
    assert.equal(r.subtotal_centavos, 0);
  });

  test('sem_preco (ativo com preço efetivo 0) expõe os dados da vitrine', async () => {
    const r = await cotar({ itens: [item(p.precoZero, 1), item(p.promoZero, 2)] });
    const [zero, promoZero] = r.itens;
    assert.deepEqual(zero, {
      produto_id: p.precoZero.id, nome: p.precoZero.nome, slug: p.precoZero.slug, imagem: null,
      preco_unitario_centavos: 0, quantidade: 1, total_centavos: 0, estoque_disponivel: 5, disponivel: false,
      motivo: 'sem_preco', peso_gramas: 300, altura_cm: 4, largura_cm: 12, comprimento_cm: 16,
    });
    assert.equal(promoZero.motivo, 'sem_preco');
    assert.equal(promoZero.nome, p.promoZero.nome);
    assert.equal(promoZero.preco_unitario_centavos, 0);
    assert.equal(r.subtotal_centavos, 0);
  });

  test('ordem dos motivos: inexistente → inativo → sem_preco → sem_estoque → estoque_insuficiente', async () => {
    const r = await cotar({ itens: [item(p.inativoZero, 1), item(p.zeroSemEstoque, 1), item(p.inativo, 99)] });
    assert.deepEqual(r.itens.map((i) => i.motivo), ['inativo', 'sem_preco', 'inativo']);
    assert.equal(r.itens[1].imagem, '/img/teste-zero.jpg');
    assert.equal(r.itens[1].estoque_disponivel, 0);
  });

  test('preço promocional; controlar_estoque=false → estoque_disponivel null', async () => {
    const r = await cotar({ itens: [item(p.promo, 2), item(p.livre, 5)] });
    const [promo, livre] = r.itens;
    assert.equal(promo.preco_unitario_centavos, 7490);
    assert.equal(promo.total_centavos, 14980);
    assert.equal(promo.estoque_disponivel, 10);
    assert.equal(livre.estoque_disponivel, null);
    assert.equal(livre.disponivel, true);
    assert.equal(livre.motivo, null);
    assert.equal(r.subtotal_centavos, 14980 + 5000);
  });

  test('campo cupom (removido) é ignorado: sem desconto e saída só com itens e subtotal', async () => {
    for (const cupom of ['AMA10', '  ama10 ', 123, {}, ['AMA10']]) {
      const r = await cotar({ itens: [item(p.quebrado, 1)], cupom });
      assert.deepEqual(Object.keys(r).sort(), ['itens', 'subtotal_centavos'], JSON.stringify(cupom));
      assert.equal(r.subtotal_centavos, 4999);
    }
  });

  test('entradas malformadas não quebram', async () => {
    const vazio = { itens: [], subtotal_centavos: 0 };
    for (const entrada of [null, [], 'texto', 42, true, {}, { itens: 'abc' }, { itens: {} }, { itens: null, cupom: [] }, { itens: [[]] }]) {
      assert.deepEqual(await cotar(entrada), vazio, JSON.stringify(entrada));
    }
  });
});

// --------------------------------------------------------------------------------------
// criar_pedido
// --------------------------------------------------------------------------------------

describe('criar_pedido', () => {
  let pB;
  let pB2;
  let pInd;

  before(async () => {
    pB = await criarProduto({ preco_centavos: 3000, estoque: 10, imagens: [{ src: '/img/b.jpg', alt: 'B' }] });
    pB2 = await criarProduto({ preco_centavos: 1990, estoque: 10 });
    pInd = await criarProduto({ preco_centavos: 1000, ativo: false });
  });

  const erroCriar = (entrada) => erroRpc(servico, 'criar_pedido', { p: entrada });

  test('sucesso: grava pedido, itens e evento "criado" sem mexer no estoque', async () => {
    const r = await criarPedido(dadosPedido([{ produto_id: pB.id, quantidade: 2 }, { produto_id: pB2.id, quantidade: 1 }]));
    assert.ok(Number.isInteger(r.numero) && r.numero >= 1001, `numero ${r.numero}`);
    assert.match(r.token_acesso, /^[0-9a-f]{64}$/);
    assert.equal(r.subtotal_centavos, 7990);
    assert.equal(r.frete_centavos, 1500);
    assert.equal(r.total_centavos, 9490);
    assert.equal('desconto_centavos' in r, false);
    assert.equal('cupom_codigo' in r, false);
    assert.deepEqual(r.itens.map((i) => [i.produto_id, i.quantidade, i.total_centavos]), [[pB.id, 2, 6000], [pB2.id, 1, 1990]]);

    const pedido = await lerPedido(r.id);
    assert.equal(pedido.numero, r.numero);
    assert.equal(pedido.token_acesso, r.token_acesso);
    assert.equal(pedido.status, 'aguardando_pagamento');
    assert.equal(pedido.cliente_nome, 'Maria da Silva');
    assert.equal(pedido.cliente_email, EMAIL_CLIENTE);
    assert.equal(pedido.cliente_telefone, '91981056049');
    assert.equal(pedido.cliente_cpf, '52998224725');
    assert.deepEqual(pedido.endereco, {
      cep: '66010000', logradouro: 'Avenida Presidente Vargas', numero: '100', complemento: 'Apto 1',
      bairro: 'Campina', cidade: 'Belém', uf: 'PA',
    });
    assert.deepEqual(pedido.entrega, ENTREGA_FIXO);
    assert.equal(pedido.subtotal_centavos, 7990);
    assert.equal(pedido.total_centavos, 9490);
    assert.equal('cupom_codigo' in pedido, false);
    assert.equal('desconto_centavos' in pedido, false);
    assert.equal(pedido.observacoes, 'Entregar à tarde');
    assert.equal(pedido.estoque_baixado, false);
    assert.equal(pedido.pago_em, null);
    assert.deepEqual(pedido.me_ordens, []);

    const itens = await sqlJson(`select json_agg(json_build_object('produto_id', produto_id, 'nome', nome, 'imagem', imagem,
      'preco', preco_unitario_centavos, 'quantidade', quantidade, 'total', total_centavos) order by id)
      from public.pedido_itens where pedido_id = ${lit(r.id)}`);
    assert.deepEqual(itens, [
      { produto_id: pB.id, nome: pB.nome, imagem: '/img/b.jpg', preco: 3000, quantidade: 2, total: 6000 },
      { produto_id: pB2.id, nome: pB2.nome, imagem: null, preco: 1990, quantidade: 1, total: 1990 },
    ]);
    const eventos = await lerEventos(r.id);
    assert.equal(eventos.length, 1);
    assert.equal(eventos[0].tipo, 'criado');
    assert.equal(eventos[0].autor, 'sistema');
    assert.equal(eventos[0].dados.total_centavos, 9490);
    assert.equal(await lerEstoque(pB.id), 10);

    const outro = await criarPedido(dadosPedido([{ produto_id: pB.id, quantidade: 1 }]));
    assert.ok(outro.numero > r.numero);
    assert.notEqual(outro.token_acesso, r.token_acesso);
  });

  test('total = subtotal + frete; campo cupom (removido) é ignorado', async () => {
    const r = await criarPedido(dadosPedido(
      [{ produto_id: pB.id, quantidade: 2 }, { produto_id: pB2.id, quantidade: 1 }],
      { cupom: 'AMA10' },
    ));
    assert.equal(r.subtotal_centavos, 7990);
    assert.equal(r.frete_centavos, 1500);
    assert.equal(r.total_centavos, 7990 + 1500);
    const [criado] = await lerEventos(r.id, 'criado');
    assert.equal('cupom' in criado.dados, false);
  });

  test('carrinho_vazio', async () => {
    for (const itens of [[], undefined, 'lixo', [{ produto_id: pB.id, quantidade: 0 }], [{ produto_id: pB.id, quantidade: -1 }]]) {
      const erro = await erroCriar(dadosPedido(itens));
      assert.equal(erro.message, 'carrinho_vazio', JSON.stringify(itens));
      assert.equal(erro.code, 'P0001');
    }
  });

  test('item_indisponivel (inativo, inexistente ou estoque insuficiente) com os itens no detail', async () => {
    const erro1 = await erroCriar(dadosPedido([{ produto_id: pB.id, quantidade: 1 }, { produto_id: pInd.id, quantidade: 1 }]));
    assert.equal(erro1.message, 'item_indisponivel');
    assert.deepEqual(JSON.parse(erro1.details), [{ produto_id: pInd.id, motivo: 'inativo' }]);
    const fantasma = randomUUID();
    const erro2 = await erroCriar(dadosPedido([{ produto_id: fantasma, quantidade: 1 }]));
    assert.equal(erro2.message, 'item_indisponivel');
    assert.deepEqual(JSON.parse(erro2.details), [{ produto_id: fantasma, motivo: 'inexistente' }]);
    const erro3 = await erroCriar(dadosPedido([{ produto_id: pB.id, quantidade: 11 }]));
    assert.equal(erro3.message, 'item_indisponivel');
    assert.deepEqual(JSON.parse(erro3.details), [{ produto_id: pB.id, motivo: 'estoque_insuficiente' }]);
  });

  test('produto ativo sem preço ("Em breve") não pode ser comprado: item_indisponivel/sem_preco', async () => {
    const antes = await contarPedidosDoCliente();
    const emBreve = await criarProduto({ preco_centavos: 0, estoque: 10 });
    const erro = await erroCriar(dadosPedido([{ produto_id: pB.id, quantidade: 1 }, { produto_id: emBreve.id, quantidade: 1 }]));
    assert.equal(erro.message, 'item_indisponivel');
    assert.deepEqual(JSON.parse(erro.details), [{ produto_id: emBreve.id, motivo: 'sem_preco' }]);
    assert.equal(await contarPedidosDoCliente(), antes);
  });

  test('dados_invalidos com o campo no detail; nenhum pedido é criado', async () => {
    const base = () => dadosPedido([{ produto_id: pB.id, quantidade: 1 }]);
    const com = (alterar) => {
      const d = base();
      alterar(d);
      return d;
    };
    const casos = [
      ['corpo', 'texto'],
      ['corpo', [1, 2]],
      ['cliente', com((d) => { delete d.cliente; })],
      ['cliente', com((d) => { d.cliente = 'Maria'; })],
      ['cliente.nome', com((d) => { d.cliente.nome = 'A'; })],
      ['cliente.nome', com((d) => { d.cliente.nome = 123; })],
      ['cliente.email', com((d) => { d.cliente.email = 'sem-arroba'; })],
      ['cliente.email', com((d) => { d.cliente.email = 'a@b'; })],
      ['cliente.telefone', com((d) => { d.cliente.telefone = '1234'; })],
      ['cliente.telefone', com((d) => { d.cliente.telefone = '919810560491234'; })],
      ['cliente.cpf', com((d) => { d.cliente.cpf = '123.456'; })],
      ['cliente.cpf', com((d) => { d.cliente.cpf = 52998224725; })],
      ['entrega', com((d) => { delete d.entrega; })],
      ['entrega.tipo', com((d) => { d.entrega.tipo = 'drone'; })],
      ['entrega.id', com((d) => { delete d.entrega.id; })],
      ['entrega.nome', com((d) => { d.entrega.nome = ''; })],
      ['entrega.empresa', com((d) => { d.entrega.empresa = 42; })],
      ['entrega.prazo_dias', com((d) => { d.entrega.prazo_dias = -1; })],
      ['entrega.prazo_dias', com((d) => { d.entrega.prazo_dias = 2.5; })],
      ['entrega.preco_centavos', com((d) => { d.entrega.preco_centavos = -1; })],
      ['entrega.preco_centavos', com((d) => { d.entrega.preco_centavos = '1500'; })],
      ['entrega.preco_centavos', com((d) => { d.entrega.preco_centavos = 15.5; })],
      ['entrega.preco_centavos', com((d) => { delete d.entrega.preco_centavos; })],
      ['entrega.servico_id', com((d) => { d.entrega.servico_id = 0; })],
      ['entrega.servico_id', com((d) => { d.entrega.servico_id = 'pac'; })],
      ['endereco', com((d) => { delete d.endereco; })],
      ['endereco.cep', com((d) => { d.endereco.cep = '660'; })],
      ['endereco.logradouro', com((d) => { d.endereco.logradouro = '  '; })],
      ['endereco.numero', com((d) => { delete d.endereco.numero; })],
      ['endereco.complemento', com((d) => { d.endereco.complemento = 7; })],
      ['endereco.bairro', com((d) => { d.endereco.bairro = ''; })],
      ['endereco.cidade', com((d) => { delete d.endereco.cidade; })],
      ['endereco.uf', com((d) => { d.endereco.uf = 'Pará'; })],
      ['observacoes', com((d) => { d.observacoes = 'x'.repeat(501); })],
      ['observacoes', com((d) => { d.observacoes = { texto: 'oi' }; })],
    ];
    const antes = await contarPedidosDoCliente();
    for (const [campo, entrada] of casos) {
      const erro = await erroCriar(entrada);
      assert.equal(erro.message, 'dados_invalidos', `${campo}: ${erro.message}`);
      assert.equal(erro.details, campo);
    }
    assert.equal(await contarPedidosDoCliente(), antes);
  });

  test('total_invalido quando o total passa do limite do int', async () => {
    const antes = await contarPedidosDoCliente();
    const erro = await erroCriar(dadosPedido(
      [{ produto_id: pB2.id, quantidade: 1 }],
      { entrega: { ...ENTREGA_FIXO, preco_centavos: 2147483647 } },
    ));
    assert.equal(erro.message, 'total_invalido');
    assert.equal(await contarPedidosDoCliente(), antes);
  });

  test('retirada na sede não existe mais: tipo recusado e endereço sempre obrigatório', async () => {
    const antes = await contarPedidosDoCliente();
    const retirada = { tipo: 'retirada', id: 'retirada', nome: 'Retirar na sede da AMA', empresa: null, prazo_dias: null, preco_centavos: 0, servico_id: null };
    const erro = await erroCriar(dadosPedido([{ produto_id: pB.id, quantidade: 1 }], { entrega: retirada, endereco: undefined }));
    assert.equal(erro.message, 'dados_invalidos');
    assert.equal(erro.details, 'entrega.tipo');
    for (const endereco of [undefined, 'lixo']) {
      const semEndereco = await erroCriar(dadosPedido([{ produto_id: pB.id, quantidade: 1 }], { entrega: { ...ENTREGA_GRATIS }, endereco }));
      assert.equal(semEndereco.details, 'endereco');
    }
    assert.equal(await contarPedidosDoCliente(), antes);
    // Gravação direta com tipo retirada também é recusada pelo check da tabela.
    const { error } = await servico.from('pedidos').insert({
      cliente_nome: 'Cliente', cliente_email: EMAIL_CLIENTE, cliente_telefone: '91981056049', cliente_cpf: '52998224725',
      entrega: retirada, endereco: {}, subtotal_centavos: 1000, total_centavos: 1000,
    });
    assert.equal(error?.code, '23514');
  });

  test('melhor_envio exige servico_id', async () => {
    const entrega = { tipo: 'melhor_envio', id: 'me-1', nome: 'PAC', empresa: 'Correios', prazo_dias: 7, preco_centavos: 2350 };
    const erro = await erroCriar(dadosPedido([{ produto_id: pB.id, quantidade: 1 }], { entrega }));
    assert.equal(erro.message, 'dados_invalidos');
    assert.equal(erro.details, 'entrega.servico_id');
    const r = await criarPedido(dadosPedido([{ produto_id: pB.id, quantidade: 1 }], { entrega: { ...entrega, servico_id: 1 } }));
    assert.equal(r.total_centavos, 3000 + 2350);
    const pedido = await lerPedido(r.id);
    assert.deepEqual(pedido.entrega, { ...entrega, servico_id: 1 });
  });
});

// --------------------------------------------------------------------------------------
// confirmar_pagamento
// --------------------------------------------------------------------------------------

describe('confirmar_pagamento', () => {
  test('approved → pago, pago_em, dados do pagamento, evento e estoque baixado', async () => {
    const { produto, pedido } = await cenario({ estoque: 10, quantidade: 2 });
    const pag = pagamento(pedido);
    const r = await confirmar(pedido.id, pag);
    assert.deepEqual(r, {
      pedido_id: pedido.id, numero: pedido.numero, status_anterior: 'aguardando_pagamento', status_novo: 'pago',
      mudou: true, virou_pago: true,
    });
    const p = await lerPedido(pedido.id);
    assert.equal(p.status, 'pago');
    recente(p.pago_em);
    assert.equal(p.status_pagamento, 'approved');
    assert.equal(p.status_pagamento_detalhe, 'accredited');
    assert.equal(p.mp_payment_id, String(pag.id));
    assert.equal(p.metodo_pagamento, 'credit_card');
    assert.equal(p.estoque_baixado, true);
    assert.equal(await lerEstoque(produto.id), 8);
    const eventos = await lerEventos(pedido.id, 'pagamento');
    assert.equal(eventos.length, 1);
    assert.equal(eventos[0].autor, 'mercadopago');
    assert.equal(eventos[0].dados.payment_id, String(pag.id));
    assert.equal(eventos[0].dados.status, 'approved');
    assert.deepEqual(await lerEventos(pedido.id, 'alerta'), []);
  });

  test('chamadas repetidas são idempotentes (status, estoque e evento)', async () => {
    const { produto, pedido } = await cenario({ estoque: 10, quantidade: 3 });
    const pag = pagamento(pedido);
    const primeira = await confirmar(pedido.id, pag);
    const pagoEm = (await lerPedido(pedido.id)).pago_em;
    for (let i = 0; i < 3; i += 1) {
      const r = await confirmar(pedido.id, { ...pag });
      assert.equal(r.status_novo, 'pago');
      assert.equal(r.mudou, false);
      assert.equal(r.virou_pago, false);
    }
    assert.equal(primeira.virou_pago, true);
    const p = await lerPedido(pedido.id);
    assert.equal(p.status, 'pago');
    assert.equal(p.pago_em, pagoEm);
    assert.equal(await lerEstoque(produto.id), 7);
    assert.equal((await lerEventos(pedido.id, 'pagamento')).length, 1);
  });

  test('PARALELO: 10 chamadas simultâneas baixam o estoque uma única vez', async () => {
    const { produto, pedido } = await cenario({ estoque: 10, quantidade: 3 });
    const pag = pagamento(pedido);
    const { serviceKey } = ambienteLocal();
    const clientes = Array.from({ length: 10 }, () => cliente(serviceKey));
    const resultados = await Promise.all(clientes.map((cl) => cl.rpc('confirmar_pagamento', {
      p_pedido_id: pedido.id, p_pagamento: pag,
    })));
    for (const r of resultados) assert.ifError(r.error);
    assert.equal(resultados.filter((r) => r.data.virou_pago).length, 1);
    assert.ok(resultados.every((r) => r.data.status_novo === 'pago'));
    assert.equal(await lerEstoque(produto.id), 7);
    assert.equal((await lerEventos(pedido.id, 'pagamento')).length, 1);
    assert.equal((await lerPedido(pedido.id)).estoque_baixado, true);
  });

  test('PARALELO: com o pedido travado, 10 chamadas esperam juntas no banco e só uma baixa o estoque', async () => {
    const { produto, pedido } = await cenario({ estoque: 10, quantidade: 2 });
    const pag = pagamento(pedido);
    const { serviceKey } = ambienteLocal();
    // Sessões esperando por trava numa chamada de confirmar_pagamento.
    const contarEsperando = async () => Number(await sql(`select count(*) from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and query like '%confirmar_pagamento%'`));
    // A sessão que segura a trava (o texto da consulta dela contém o id do pedido).
    const travaAtiva = async () => Number(await sql(`select count(*) from pg_stat_activity
      where wait_event = 'PgSleep' and query like ${lit(`%${pedido.id}%`)}`)) > 0;

    // Outra sessão trava a linha do pedido por 2 s (como um webhook demorado).
    const trava = sql(`begin; select id from public.pedidos where id = ${lit(pedido.id)} for update;
                       select pg_sleep(2); commit;`);
    let travado = false;
    for (let i = 0; i < 100 && !travado; i += 1) travado = await travaAtiva();
    assert.ok(travado, 'a sessão que trava o pedido não começou');

    const chamadas = Promise.all(Array.from({ length: 10 }, () => cliente(serviceKey).rpc('confirmar_pagamento', {
      p_pedido_id: pedido.id, p_pagamento: pag,
    })));
    let maximo = 0;
    while (maximo < 8 && await travaAtiva()) maximo = Math.max(maximo, await contarEsperando());
    const resultados = await chamadas;
    await trava;
    assert.ok(maximo >= 8, `só ${maximo} chamadas chegaram a esperar ao mesmo tempo`);
    for (const r of resultados) assert.ifError(r.error);
    assert.equal(resultados.filter((r) => r.data.virou_pago).length, 1);
    assert.equal(await lerEstoque(produto.id), 8);
    assert.equal((await lerEventos(pedido.id, 'pagamento')).length, 1);
  });

  test('PARALELO: dois pagamentos aprovados diferentes ao mesmo tempo baixam o estoque uma vez', async () => {
    const { produto, pedido } = await cenario({ estoque: 10, quantidade: 4 });
    const pagamentos = [pagamento(pedido), pagamento(pedido)];
    const { serviceKey } = ambienteLocal();
    const resultados = await Promise.all(Array.from({ length: 8 }, (_, i) => cliente(serviceKey).rpc('confirmar_pagamento', {
      p_pedido_id: pedido.id, p_pagamento: pagamentos[i % 2],
    })));
    for (const r of resultados) assert.ifError(r.error);
    assert.equal(resultados.filter((r) => r.data.virou_pago).length, 1);
    assert.equal(await lerEstoque(produto.id), 6);
    assert.equal((await lerEventos(pedido.id, 'pagamento')).length, 2);
  });

  test('valor divergente → pagamento_em_analise + alerta, sem baixar estoque', async () => {
    const { produto, pedido } = await cenario({ estoque: 10, quantidade: 2 });
    const pag = pagamento(pedido, { transaction_amount: pedido.total_centavos / 100 - 0.5 });
    const r = await confirmar(pedido.id, pag);
    assert.equal(r.status_novo, 'pagamento_em_analise');
    assert.equal(r.virou_pago, false);
    const p = await lerPedido(pedido.id);
    assert.equal(p.status, 'pagamento_em_analise');
    assert.equal(p.estoque_baixado, false);
    assert.equal(p.pago_em, null);
    assert.equal(await lerEstoque(produto.id), 10);
    const alertas = await lerEventos(pedido.id, 'alerta');
    assert.equal(alertas.length, 1);
    assert.match(alertas[0].descricao, /valor divergente/i);
    assert.equal(alertas[0].dados.valor_centavos, pedido.total_centavos - 50);
    // Repetir não duplica o alerta.
    await confirmar(pedido.id, pag);
    assert.equal((await lerEventos(pedido.id, 'alerta')).length, 1);
    // Sem transaction_amount também é divergente.
    const sem = await cenario({ estoque: 10, quantidade: 1 });
    const r2 = await confirmar(sem.pedido.id, pagamento(sem.pedido, { transaction_amount: undefined }));
    assert.equal(r2.status_novo, 'pagamento_em_analise');
    assert.equal(await lerEstoque(sem.produto.id), 10);
  });

  test('diferença de até 1 centavo (arredondamento) é aceita; 2 centavos já é divergente', async () => {
    const { produto, pedido } = await cenario({ estoque: 10, quantidade: 1, preco: 3333 });
    const r = await confirmar(pedido.id, pagamento(pedido, { transaction_amount: '33.32' }));
    assert.equal(r.status_novo, 'pago');
    assert.equal(await lerEstoque(produto.id), 9);

    const dois = await cenario({ estoque: 10, quantidade: 1, preco: 3333 });
    const r2 = await confirmar(dois.pedido.id, pagamento(dois.pedido, { transaction_amount: 33.31 }));
    assert.equal(r2.status_novo, 'pagamento_em_analise');
    assert.equal(r2.virou_pago, false);
    assert.equal(await lerEstoque(dois.produto.id), 10);
    const [alerta] = await lerEventos(dois.pedido.id, 'alerta');
    assert.equal(alerta.dados.valor_centavos, 3331);
    assert.equal(alerta.dados.total_centavos, 3333);
  });

  test('authorized → pago, com baixa de estoque', async () => {
    const { produto, pedido } = await cenario({ estoque: 10, quantidade: 3 });
    const r = await confirmar(pedido.id, pagamento(pedido, { status: 'authorized', status_detail: 'pending_capture' }));
    assert.equal(r.status_novo, 'pago');
    assert.equal(r.virou_pago, true);
    const p = await lerPedido(pedido.id);
    assert.equal(p.status_pagamento, 'authorized');
    assert.equal(p.estoque_baixado, true);
    recente(p.pago_em);
    assert.equal(await lerEstoque(produto.id), 7);
    // O approved do mesmo pagamento (captura) não baixa de novo.
    const pagoEm = p.pago_em;
    const r2 = await confirmar(pedido.id, pagamento(pedido, { id: Number(p.mp_payment_id), status: 'approved' }));
    assert.equal(r2.mudou, false);
    assert.equal(r2.virou_pago, false);
    assert.equal(await lerEstoque(produto.id), 7);
    assert.equal((await lerPedido(pedido.id)).pago_em, pagoEm);
  });

  test('in_mediation: aguardando → pagamento_em_analise; sobre pago, nada muda', async () => {
    const a = await cenario();
    const r1 = await confirmar(a.pedido.id, pagamento(a.pedido, { status: 'in_mediation', status_detail: null }));
    assert.equal(r1.status_novo, 'pagamento_em_analise');
    assert.equal(r1.mudou, true);
    assert.equal((await lerPedido(a.pedido.id)).status_pagamento, 'in_mediation');
    assert.equal(await lerEstoque(a.produto.id), 10);

    const b = await cenario({ estoque: 10, quantidade: 2 });
    const aprovado = pagamento(b.pedido);
    await confirmar(b.pedido.id, aprovado);
    const r2 = await confirmar(b.pedido.id, { ...aprovado, status: 'in_mediation', status_detail: null });
    assert.equal(r2.status_anterior, 'pago');
    assert.equal(r2.status_novo, 'pago');
    assert.equal(r2.mudou, false);
    assert.equal(r2.virou_pago, false);
    const p = await lerPedido(b.pedido.id);
    assert.equal(p.status, 'pago');
    assert.equal(p.estoque_baixado, true);
    assert.equal(await lerEstoque(b.produto.id), 8);
  });

  test('pending/in_process → pagamento_em_analise só a partir de aguardando_pagamento', async () => {
    const a = await cenario();
    const r1 = await confirmar(a.pedido.id, pagamento(a.pedido, { status: 'pending', status_detail: 'pending_waiting_transfer' }));
    assert.equal(r1.status_novo, 'pagamento_em_analise');
    assert.equal((await lerPedido(a.pedido.id)).status_pagamento, 'pending');
    assert.equal(await lerEstoque(a.produto.id), 10);
    // in_process sobre pagamento_em_analise: continua igual.
    const r2 = await confirmar(a.pedido.id, pagamento(a.pedido, { status: 'in_process' }));
    assert.equal(r2.mudou, false);

    const b = await cenario();
    await confirmar(b.pedido.id, pagamento(b.pedido));
    const r3 = await confirmar(b.pedido.id, pagamento(b.pedido, { status: 'in_process' }));
    assert.equal(r3.status_novo, 'pago');

    const c = await cenario();
    await alterarStatus(c.pedido.id, 'cancelado');
    const r4 = await confirmar(c.pedido.id, pagamento(c.pedido, { status: 'pending' }));
    assert.equal(r4.status_novo, 'cancelado');
  });

  test('rejected/cancelled não mudam o status, só registram', async () => {
    const { produto, pedido } = await cenario();
    for (const status of ['rejected', 'cancelled']) {
      const r = await confirmar(pedido.id, pagamento(pedido, { status, status_detail: 'cc_rejected_other_reason' }));
      assert.equal(r.status_novo, 'aguardando_pagamento');
      assert.equal(r.mudou, false);
    }
    const p = await lerPedido(pedido.id);
    assert.equal(p.status, 'aguardando_pagamento');
    assert.equal(p.status_pagamento, 'cancelled');
    assert.equal((await lerEventos(pedido.id, 'pagamento')).length, 2);
    assert.equal(await lerEstoque(produto.id), 10);
    // Depois de recusado, o cliente pode tentar de novo e pagar.
    const r = await confirmar(pedido.id, pagamento(pedido));
    assert.equal(r.virou_pago, true);
  });

  test('pendente que expira ou é recusado devolve o pedido para aguardando_pagamento', async () => {
    for (const [pendente, final, detalhe] of [
      ['pending', 'cancelled', 'expired'],
      ['in_process', 'rejected', 'cc_rejected_high_risk'],
      ['in_mediation', 'cancelled', 'by_admin'],
    ]) {
      const { produto, pedido } = await cenario();
      const pag = pagamento(pedido, { status: pendente, status_detail: 'pending_waiting_payment' });
      assert.equal((await confirmar(pedido.id, pag)).status_novo, 'pagamento_em_analise', pendente);
      const r = await confirmar(pedido.id, { ...pag, status: final, status_detail: detalhe });
      assert.equal(r.status_anterior, 'pagamento_em_analise');
      assert.equal(r.status_novo, 'aguardando_pagamento', `${pendente} → ${final}`);
      assert.equal(r.mudou, true);
      const p = await lerPedido(pedido.id);
      assert.equal(p.status, 'aguardando_pagamento');
      assert.equal(p.status_pagamento, final);
      assert.equal(p.status_pagamento_detalhe, detalhe);
      assert.equal(p.mp_payment_id, String(pag.id));
      assert.equal(await lerEstoque(produto.id), 10);
      // O cliente pode pagar de novo com outra tentativa.
      assert.equal((await confirmar(pedido.id, pagamento(pedido))).virou_pago, true);
    }
  });

  test('recusa de OUTRO pagamento não tira o pedido da análise', async () => {
    // Pix pendente; um cartão de outra tentativa é recusado: o Pix continua valendo.
    const a = await cenario();
    const pix = pagamento(a.pedido, { status: 'pending', payment_type_id: 'bank_transfer', payment_method_id: 'pix' });
    await confirmar(a.pedido.id, pix);
    const r1 = await confirmar(a.pedido.id, pagamento(a.pedido, { status: 'rejected' }));
    assert.equal(r1.status_novo, 'pagamento_em_analise');
    assert.equal(r1.mudou, false);

    // Dois pendentes (Pix e boleto): o primeiro expira e o pedido segue em análise por causa do segundo;
    // quando o segundo também expira, volta para aguardando_pagamento.
    const b = await cenario();
    const primeiro = pagamento(b.pedido, { status: 'pending' });
    const segundo = pagamento(b.pedido, { status: 'pending', payment_type_id: 'ticket' });
    await confirmar(b.pedido.id, primeiro);
    await confirmar(b.pedido.id, segundo);
    const r2 = await confirmar(b.pedido.id, { ...primeiro, status: 'cancelled', status_detail: 'expired' });
    assert.equal(r2.status_novo, 'pagamento_em_analise');
    const r3 = await confirmar(b.pedido.id, { ...segundo, status: 'cancelled', status_detail: 'expired' });
    assert.equal(r3.status_novo, 'aguardando_pagamento');

    // Em análise por valor divergente: uma recusa (de qualquer pagamento) não esconde o alerta.
    const c = await cenario();
    const divergente = pagamento(c.pedido, { transaction_amount: 1 });
    await confirmar(c.pedido.id, divergente);
    const r4 = await confirmar(c.pedido.id, pagamento(c.pedido, { status: 'rejected' }));
    assert.equal(r4.status_novo, 'pagamento_em_analise');

    // Em análise por decisão manual, sem pagamento pendente: continua em análise.
    const d = await cenario();
    await alterarStatus(d.pedido.id, 'pagamento_em_analise');
    const r5 = await confirmar(d.pedido.id, pagamento(d.pedido, { status: 'rejected' }));
    assert.equal(r5.status_novo, 'pagamento_em_analise');
  });

  test('estorno de pagamento em dobro mantém o pedido pago e grava alerta', async () => {
    for (const estorno of ['refunded', 'charged_back']) {
      const { produto, pedido } = await cenario({ estoque: 10, quantidade: 2 });
      const a = pagamento(pedido);
      const b = pagamento(pedido, { payment_type_id: 'bank_transfer', payment_method_id: 'pix' });
      await confirmar(pedido.id, a);
      await confirmar(pedido.id, b);
      assert.equal(await lerEstoque(produto.id), 8);

      // A AMA devolve o pagamento em dobro (B): o pedido continua pago, ligado ao A.
      const r = await confirmar(pedido.id, { ...b, status: estorno });
      assert.equal(r.status_novo, 'pago', estorno);
      assert.equal(r.mudou, false);
      let p = await lerPedido(pedido.id);
      assert.equal(p.status, 'pago');
      assert.equal(p.estoque_baixado, true);
      assert.equal(p.mp_payment_id, String(a.id));
      assert.equal(p.status_pagamento, 'approved');
      assert.equal(p.status_pagamento_detalhe, 'accredited');
      assert.equal(p.metodo_pagamento, 'credit_card');
      assert.equal(await lerEstoque(produto.id), 8);
      const alertas = await lerEventos(pedido.id, 'alerta');
      assert.equal(alertas.length, 1);
      assert.match(alertas[0].descricao, /pagamento duplicado estornado/i);
      assert.equal(alertas[0].dados.payment_id, String(b.id));
      assert.equal(alertas[0].dados.payment_id_aprovado, String(a.id));
      // Repetir o estorno não duplica o alerta.
      await confirmar(pedido.id, { ...b, status: estorno });
      assert.equal((await lerEventos(pedido.id, 'alerta')).length, 1);

      // Depois, o estorno do último pagamento aprovado reembolsa e devolve o estoque.
      const r2 = await confirmar(pedido.id, { ...a, status: estorno });
      assert.equal(r2.status_novo, 'reembolsado');
      p = await lerPedido(pedido.id);
      assert.equal(p.estoque_baixado, false);
      assert.equal(p.mp_payment_id, String(a.id));
      assert.equal(p.status_pagamento, estorno);
      assert.equal(await lerEstoque(produto.id), 10);
    }
  });

  test('estorno do único pagamento integral reembolsa, mesmo com outro aprovado a menor', async () => {
    // A: aprovado com R$ 1,00 (divergente); B: aprovado com o total; B estornado.
    const { produto, pedido } = await cenario({ estoque: 10, quantidade: 2 });
    const menor = pagamento(pedido, { transaction_amount: 1 });
    const integral = pagamento(pedido);
    assert.equal((await confirmar(pedido.id, menor)).status_novo, 'pagamento_em_analise');
    assert.equal((await confirmar(pedido.id, integral)).status_novo, 'pago');
    assert.equal(await lerEstoque(produto.id), 8);

    const r = await confirmar(pedido.id, { ...integral, status: 'refunded' });
    assert.equal(r.status_novo, 'reembolsado');
    const p = await lerPedido(pedido.id);
    assert.equal(p.status, 'reembolsado');
    assert.equal(p.estoque_baixado, false);
    assert.equal(p.mp_payment_id, String(integral.id));
    assert.equal(p.status_pagamento, 'refunded');
    assert.equal(await lerEstoque(produto.id), 10);
    const alertas = await lerEventos(pedido.id, 'alerta');
    assert.ok(!alertas.some((a) => /duplicado/i.test(a.descricao)), 'não é estorno de pagamento em dobro');

    // Com 1 centavo a menos (arredondamento), o outro pagamento ainda conta como integral e segura o pedido.
    const b = await cenario({ estoque: 10, quantidade: 2 });
    const quase = pagamento(b.pedido, { transaction_amount: (b.pedido.total_centavos - 1) / 100 });
    const dobro = pagamento(b.pedido);
    await confirmar(b.pedido.id, quase);
    await confirmar(b.pedido.id, dobro);
    const r2 = await confirmar(b.pedido.id, { ...dobro, status: 'charged_back' });
    assert.equal(r2.status_novo, 'pago');
    assert.equal(await lerEstoque(b.produto.id), 8);
    const [alerta] = await lerEventos(b.pedido.id, 'alerta');
    assert.match(alerta.descricao, /pagamento duplicado estornado/i);
    assert.equal(alerta.dados.payment_id_aprovado, String(quase.id));
    assert.equal((await lerPedido(b.pedido.id)).mp_payment_id, String(quase.id));
  });

  test('eventos "pagamento" que não vieram do Mercado Pago não seguram o pedido (estorno e recusa)', async () => {
    // Linhas inseridas à mão pelo service_role (o admin não consegue: RLS só deixa 'nota').
    const eventoManual = (pedidoId, dados) => semErro(servico.from('pedido_eventos').insert({
      pedido_id: pedidoId, tipo: 'pagamento', descricao: 'Inserido à mão', autor: EMAIL_ADMIN, dados,
    }), 'evento manual');

    // Estorno: um "approved" manual de outro payment_id não vira "pagamento duplicado".
    const a = await cenario({ estoque: 10, quantidade: 2 });
    const real = pagamento(a.pedido);
    await confirmar(a.pedido.id, real);
    await eventoManual(a.pedido.id, {
      payment_id: String(novoIdPagamento()), status: 'approved', transaction_amount: a.pedido.total_centavos / 100,
    });
    const r1 = await confirmar(a.pedido.id, { ...real, status: 'refunded' });
    assert.equal(r1.status_novo, 'reembolsado');
    assert.equal(await lerEstoque(a.produto.id), 10);
    assert.deepEqual(await lerEventos(a.pedido.id, 'alerta'), []);

    // Recusa: um "pending" manual de outro payment_id não segura o pedido em análise.
    const b = await cenario();
    const pix = pagamento(b.pedido, { status: 'pending', payment_type_id: 'bank_transfer', payment_method_id: 'pix' });
    await confirmar(b.pedido.id, pix);
    await eventoManual(b.pedido.id, { payment_id: String(novoIdPagamento()), status: 'pending' });
    const r2 = await confirmar(b.pedido.id, { ...pix, status: 'cancelled', status_detail: 'expired' });
    assert.equal(r2.status_novo, 'aguardando_pagamento');

    // Recusa: um evento manual mais novo do MESMO pagamento não esconde que ele estava pendente.
    const c = await cenario();
    const boleto = pagamento(c.pedido, { status: 'pending', payment_type_id: 'ticket', payment_method_id: 'bolbradesco' });
    await confirmar(c.pedido.id, boleto);
    await eventoManual(c.pedido.id, { payment_id: String(boleto.id), status: 'approved' });
    const r3 = await confirmar(c.pedido.id, { ...boleto, status: 'cancelled', status_detail: 'expired' });
    assert.equal(r3.status_novo, 'aguardando_pagamento');
  });

  test('evento "pagamento" que não veio do Mercado Pago não faz o pagamento real parecer repetido', async () => {
    const { produto, pedido } = await cenario({ estoque: 10, quantidade: 2 });
    const pag = pagamento(pedido);
    // Linha inserida à mão (a RLS já impede isso pelo painel; aqui entra pelo service_role).
    await semErro(servico.from('pedido_eventos').insert({
      pedido_id: pedido.id, tipo: 'pagamento', descricao: 'Inserido à mão', autor: EMAIL_ADMIN,
      dados: { payment_id: String(pag.id), status: 'approved' },
    }), 'evento manual');
    const r = await confirmar(pedido.id, pag);
    assert.equal(r.status_novo, 'pago');
    assert.equal(r.virou_pago, true);
    assert.equal(await lerEstoque(produto.id), 8);
    const doMp = (await lerEventos(pedido.id, 'pagamento')).filter((e) => e.autor === 'mercadopago');
    assert.equal(doMp.length, 1);
  });

  test('pagamento recusado de outra tentativa não apaga os dados do aprovado', async () => {
    const { pedido } = await cenario();
    const aprovado = pagamento(pedido);
    await confirmar(pedido.id, aprovado);
    await confirmar(pedido.id, pagamento(pedido, { status: 'rejected', payment_type_id: 'ticket' }));
    const p = await lerPedido(pedido.id);
    assert.equal(p.status, 'pago');
    assert.equal(p.status_pagamento, 'approved');
    assert.equal(p.mp_payment_id, String(aprovado.id));
    assert.equal(p.metodo_pagamento, 'credit_card');
  });

  test('refunded/charged_back → reembolsado e devolvem o estoque', async () => {
    for (const status of ['refunded', 'charged_back']) {
      const { produto, pedido } = await cenario({ estoque: 10, quantidade: 2 });
      const pag = pagamento(pedido);
      await confirmar(pedido.id, pag);
      assert.equal(await lerEstoque(produto.id), 8);
      const r = await confirmar(pedido.id, { ...pag, status });
      assert.equal(r.status_novo, 'reembolsado', status);
      const p = await lerPedido(pedido.id);
      assert.equal(p.status, 'reembolsado');
      assert.equal(p.estoque_baixado, false);
      assert.equal(await lerEstoque(produto.id), 10);
      // Repetir o estorno não devolve de novo.
      await confirmar(pedido.id, { ...pag, status });
      assert.equal(await lerEstoque(produto.id), 10);
    }
  });

  test('nunca regride em_separacao/enviado/entregue', async () => {
    const { produto, pedido } = await cenario({ estoque: 10, quantidade: 1 });
    const pag = pagamento(pedido);
    await confirmar(pedido.id, pag);
    for (const status of ['em_separacao', 'enviado', 'entregue']) {
      await alterarStatus(pedido.id, status);
      for (const pagamentoStatus of ['approved', 'pending', 'in_process', 'rejected']) {
        const r = await confirmar(pedido.id, pagamento(pedido, { status: pagamentoStatus }));
        assert.equal(r.status_novo, status, `${pagamentoStatus} sobre ${status}`);
        assert.equal(r.virou_pago, false);
      }
    }
    assert.equal(await lerEstoque(produto.id), 9);
  });

  test('pedido cancelado que recebe approved vira pago e baixa o estoque', async () => {
    const { produto, pedido } = await cenario({ estoque: 10, quantidade: 2 });
    await alterarStatus(pedido.id, 'cancelado');
    const r = await confirmar(pedido.id, pagamento(pedido));
    assert.equal(r.status_anterior, 'cancelado');
    assert.equal(r.status_novo, 'pago');
    assert.equal(r.virou_pago, true);
    const p = await lerPedido(pedido.id);
    recente(p.pago_em);
    assert.equal(p.estoque_baixado, true);
    assert.equal(await lerEstoque(produto.id), 8);
  });

  test('reenvio de um pagamento já processado não desfaz o cancelamento manual', async () => {
    const { produto, pedido } = await cenario({ estoque: 10, quantidade: 2 });
    const pag = pagamento(pedido);
    await confirmar(pedido.id, pag);
    await alterarStatus(pedido.id, 'cancelado', { p_repor_estoque: true });
    assert.equal(await lerEstoque(produto.id), 10);
    // Webhook repetido ou cliente recarregando a página de retorno.
    const r = await confirmar(pedido.id, { ...pag });
    assert.equal(r.status_novo, 'cancelado');
    assert.equal(r.virou_pago, false);
    assert.equal(await lerEstoque(produto.id), 10);
    assert.equal((await lerPedido(pedido.id)).estoque_baixado, false);
  });

  test('estoque insuficiente na confirmação gera alerta e não fica negativo', async () => {
    const extra = await criarProduto({ preco_centavos: 500, estoque: 10 });
    const { produto, pedido } = await cenario({ estoque: 5, quantidade: 3, itensExtras: [{ produto_id: extra.id, quantidade: 1 }] });
    await semErro(servico.from('produtos').update({ estoque: 1 }).eq('id', produto.id), 'reduzir estoque');
    const r = await confirmar(pedido.id, pagamento(pedido));
    assert.equal(r.status_novo, 'pago');
    assert.equal(await lerEstoque(produto.id), 0);
    assert.equal(await lerEstoque(extra.id), 9);
    const alertas = await lerEventos(pedido.id, 'alerta');
    assert.equal(alertas.length, 1);
    assert.match(alertas[0].descricao, /estoque insuficiente/i);
    assert.deepEqual(alertas[0].dados.itens.map((i) => [i.produto_id, i.quantidade, i.estoque]), [[produto.id, 3, 1]]);
  });

  test('produto sem controle de estoque não é alterado', async () => {
    const { produto, pedido } = await cenario({ estoque: 0, quantidade: 5, controlar: false });
    await confirmar(pedido.id, pagamento(pedido));
    assert.equal(await lerEstoque(produto.id), 0);
    assert.deepEqual(await lerEventos(pedido.id, 'alerta'), []);
  });

  test('pedido inexistente → pedido_nao_encontrado; pagamento sem status → dados_invalidos', async () => {
    const erro = await erroRpc(servico, 'confirmar_pagamento', {
      p_pedido_id: randomUUID(), p_pagamento: { id: 1, status: 'approved', transaction_amount: 10 },
    });
    assert.equal(erro.message, 'pedido_nao_encontrado');
    const { pedido } = await cenario();
    for (const pag of [{ id: 1 }, { id: 1, status: '  ' }, null]) {
      const e = await erroRpc(servico, 'confirmar_pagamento', { p_pedido_id: pedido.id, p_pagamento: pag });
      assert.equal(e.message, 'dados_invalidos');
    }
    assert.equal((await lerPedido(pedido.id)).status, 'aguardando_pagamento');
  });
});

// --------------------------------------------------------------------------------------
// alterar_status_pedido
// --------------------------------------------------------------------------------------

describe('alterar_status_pedido', () => {
  const URLS_RASTREIO_INVALIDAS = [
    'javascript:alert(1)', 'ftp://exemplo.com/x', 'rastreio', 'https://', 'https://exemplo.com/a b',
    'http://inseguro.example/x', 'HTTP://inseguro.example/x', '//exemplo.com/x',
    'https://x"><img/src=x/onerror=alert(1)>', "https://exemplo.com/x'onmouseover='alert(1)",
    'https://exemplo.com/<b>', 'https://exemplo.com/`x`', 'https://exemplo.com/x\\y', 'https://exemplo.com/a\tb',
    'https://user@exemplo.com/x', 'https://-exemplo.com/x', `https://exemplo.com/${'a'.repeat(500)}`,
  ];
  const URLS_RASTREIO_VALIDAS = [
    'https://rastreamento.correios.com.br/app/index.php?objeto=AA123456789BR',
    'https://www.melhorrastreio.com.br/rastreio/AA123456789BR',
    'https://app.melhorenvio.com.br:443/rastreio/ME-123#detalhes',
    'HTTPS://Rastreio.Exemplo.com?codigo=AB%20123&x=1',
    'https://exemplo.com',
  ];
  const CODIGOS_RASTREIO_INVALIDOS = ['<b>AA</b>', 'AA"123', "AA'123", 'AA`123`', 'AA>1', 'AA\n1', 'A'.repeat(201)];

  test('marcar manualmente como pago baixa o estoque; evento "status" com autor', async () => {
    const { produto, pedido } = await cenario({ estoque: 10, quantidade: 2 });
    const r = await alterarStatus(pedido.id, 'pago', { p_nota: 'Pagou em dinheiro na sede' });
    assert.equal(r.status_anterior, 'aguardando_pagamento');
    assert.equal(r.status_novo, 'pago');
    assert.equal(r.estoque_baixado, true);
    const p = await lerPedido(pedido.id);
    recente(p.pago_em);
    assert.equal(p.estoque_baixado, true);
    assert.equal(await lerEstoque(produto.id), 8);
    const [evento] = await lerEventos(pedido.id, 'status');
    assert.equal(evento.autor, AUTOR);
    assert.equal(evento.dados.status_anterior, 'aguardando_pagamento');
    assert.equal(evento.dados.status_novo, 'pago');
    assert.equal(evento.dados.nota, 'Pagou em dinheiro na sede');
    assert.match(evento.descricao, /Estoque baixado/);
    // Avançar para separação não baixa de novo.
    await alterarStatus(pedido.id, 'em_separacao');
    assert.equal(await lerEstoque(produto.id), 8);
    assert.equal((await lerPedido(pedido.id)).pago_em, p.pago_em);
  });

  test('enviado com rastreio e entregue ajustam as datas', async () => {
    const { pedido } = await cenario();
    await confirmar(pedido.id, pagamento(pedido));
    const rastreio = {
      codigo_rastreio: 'AA123456789BR',
      url_rastreio: 'https://rastreamento.correios.com.br/app/index.php?objeto=AA123456789BR',
    };
    const r = await alterarStatus(pedido.id, 'enviado', { p_rastreio: rastreio });
    assert.equal(r.status_novo, 'enviado');
    const enviado = await lerPedido(pedido.id);
    recente(enviado.enviado_em);
    assert.equal(enviado.entregue_em, null);
    assert.equal(enviado.codigo_rastreio, rastreio.codigo_rastreio);
    assert.equal(enviado.url_rastreio, rastreio.url_rastreio);
    const [evento] = await lerEventos(pedido.id, 'status');
    assert.equal(evento.dados.codigo_rastreio, rastreio.codigo_rastreio);
    assert.match(evento.descricao, /AA123456789BR/);

    await alterarStatus(pedido.id, 'entregue');
    const entregue = await lerPedido(pedido.id);
    recente(entregue.entregue_em);
    assert.equal(entregue.enviado_em, enviado.enviado_em);
    assert.equal(entregue.pago_em, enviado.pago_em);
    assert.equal(entregue.codigo_rastreio, rastreio.codigo_rastreio);

    // Rastreio vazio apaga; sem p_rastreio, mantém.
    await alterarStatus(pedido.id, 'entregue', { p_rastreio: { codigo_rastreio: '' } });
    const limpo = await lerPedido(pedido.id);
    assert.equal(limpo.codigo_rastreio, null);
    assert.equal(limpo.url_rastreio, rastreio.url_rastreio);
  });

  test('URL de rastreio inválida → dados_invalidos e nada muda', async () => {
    const { pedido } = await cenario();
    for (const url of URLS_RASTREIO_INVALIDAS) {
      const erro = await erroRpc(servico, 'alterar_status_pedido', {
        p_pedido_id: pedido.id, p_status: 'enviado', p_autor: AUTOR, p_rastreio: { url_rastreio: url },
      });
      assert.equal(erro.message, 'dados_invalidos', url);
      assert.equal(erro.details, 'p_rastreio.url_rastreio', url);
    }
    for (const codigo of [123, ...CODIGOS_RASTREIO_INVALIDOS]) {
      const erro = await erroRpc(servico, 'alterar_status_pedido', {
        p_pedido_id: pedido.id, p_status: 'enviado', p_autor: AUTOR, p_rastreio: { codigo_rastreio: codigo },
      });
      assert.equal(erro.message, 'dados_invalidos', String(codigo));
      assert.equal(erro.details, 'p_rastreio.codigo_rastreio', String(codigo));
    }
    const p = await lerPedido(pedido.id);
    assert.equal(p.status, 'aguardando_pagamento');
    assert.equal(p.url_rastreio, null);
    assert.equal(p.codigo_rastreio, null);
    assert.deepEqual(await lerEventos(pedido.id, 'status'), []);
  });

  test('URLs de rastreio https comuns são aceitas', async () => {
    const { pedido } = await cenario();
    for (const url of URLS_RASTREIO_VALIDAS) {
      await alterarStatus(pedido.id, 'enviado', { p_rastreio: { codigo_rastreio: 'AA123456789BR', url_rastreio: url } });
      assert.equal((await lerPedido(pedido.id)).url_rastreio, url);
    }
  });

  test('rastreio gravado direto na tabela (admin pela API ou serviço) segue as mesmas regras: check 23514', async () => {
    const { pedido } = await cenario();
    const invalidos = [
      ...[...URLS_RASTREIO_INVALIDAS, '', ' https://exemplo.com'].map((url) => ['url_rastreio', url]),
      ...[...CODIGOS_RASTREIO_INVALIDOS, '"><img src=x onerror=alert(1)>'].map((codigo) => ['codigo_rastreio', codigo]),
    ];
    for (const [rotulo, cl] of [['admin', admin], ['serviço', servico]]) {
      for (const [coluna, valor] of invalidos) {
        const { error } = await cl.from('pedidos').update({ [coluna]: valor }).eq('id', pedido.id);
        assert.equal(error?.code, '23514', `${rotulo} ${coluna}=${JSON.stringify(valor)}: ${error?.message}`);
      }
    }
    let p = await lerPedido(pedido.id);
    assert.equal(p.url_rastreio, null);
    assert.equal(p.codigo_rastreio, null);

    // O que alterar_status_pedido aceita também passa direto (inclusive vários códigos separados por vírgula).
    for (const url of URLS_RASTREIO_VALIDAS) {
      await semErro(admin.from('pedidos').update({ url_rastreio: url, codigo_rastreio: 'AA1BR, BB2BR' }).eq('id', pedido.id), url);
      p = await lerPedido(pedido.id);
      assert.equal(p.url_rastreio, url);
      assert.equal(p.codigo_rastreio, 'AA1BR, BB2BR');
    }
    await semErro(admin.from('pedidos').update({ url_rastreio: null, codigo_rastreio: null }).eq('id', pedido.id), 'limpar');

    const checks = await sqlJson(`select json_agg(conname order by conname) from pg_constraint
                                   where conrelid = 'public.pedidos'::regclass and conname like '%rastreio%'`);
    assert.deepEqual(checks, ['pedidos_codigo_rastreio_check', 'pedidos_url_rastreio_check']);
  });

  test('status inválido → status_invalido; pedido inexistente → pedido_nao_encontrado', async () => {
    const { pedido } = await cenario();
    for (const status of ['perdido', '', null, 'PAGO; drop table']) {
      const erro = await erroRpc(servico, 'alterar_status_pedido', { p_pedido_id: pedido.id, p_status: status, p_autor: AUTOR });
      assert.equal(erro.message, 'status_invalido', String(status));
    }
    const erro = await erroRpc(servico, 'alterar_status_pedido', { p_pedido_id: randomUUID(), p_status: 'pago', p_autor: AUTOR });
    assert.equal(erro.message, 'pedido_nao_encontrado');
  });

  test('cancelado com repor_estoque devolve o estoque só quando estava baixado', async () => {
    // Pago e cancelado com reposição: devolve uma vez.
    const a = await cenario({ estoque: 10, quantidade: 3 });
    await confirmar(a.pedido.id, pagamento(a.pedido));
    assert.equal(await lerEstoque(a.produto.id), 7);
    const r = await alterarStatus(a.pedido.id, 'cancelado', { p_repor_estoque: true });
    assert.equal(r.estoque_reposto, true);
    const cancelado = await lerPedido(a.pedido.id);
    recente(cancelado.cancelado_em);
    assert.equal(cancelado.estoque_baixado, false);
    assert.equal(await lerEstoque(a.produto.id), 10);
    const [evento] = (await lerEventos(a.pedido.id, 'status')).slice(-1);
    assert.match(evento.descricao, /Estoque devolvido/);
    await alterarStatus(a.pedido.id, 'cancelado', { p_repor_estoque: true });
    assert.equal(await lerEstoque(a.produto.id), 10);

    // Nunca baixado: nada a devolver.
    const b = await cenario({ estoque: 10, quantidade: 3 });
    const rb = await alterarStatus(b.pedido.id, 'cancelado', { p_repor_estoque: true });
    assert.equal(rb.estoque_reposto, false);
    assert.equal(await lerEstoque(b.produto.id), 10);

    // Sem p_repor_estoque: o estoque continua baixado.
    const c = await cenario({ estoque: 10, quantidade: 3 });
    await confirmar(c.pedido.id, pagamento(c.pedido));
    await alterarStatus(c.pedido.id, 'cancelado');
    assert.equal(await lerEstoque(c.produto.id), 7);
    assert.equal((await lerPedido(c.pedido.id)).estoque_baixado, true);

    // Reembolsado com reposição também devolve.
    const d = await cenario({ estoque: 10, quantidade: 3 });
    await alterarStatus(d.pedido.id, 'pago');
    await alterarStatus(d.pedido.id, 'reembolsado', { p_repor_estoque: true });
    assert.equal(await lerEstoque(d.produto.id), 10);
  });

  test('reabrir um pedido cancelado limpa cancelado_em; pagar de novo baixa o estoque de novo', async () => {
    const { produto, pedido } = await cenario({ estoque: 10, quantidade: 2 });
    await alterarStatus(pedido.id, 'pago');
    await alterarStatus(pedido.id, 'cancelado', { p_repor_estoque: true });
    await alterarStatus(pedido.id, 'aguardando_pagamento');
    const reaberto = await lerPedido(pedido.id);
    assert.equal(reaberto.cancelado_em, null);
    assert.equal(reaberto.pago_em, null);
    assert.equal(await lerEstoque(produto.id), 10);
    await alterarStatus(pedido.id, 'pago');
    assert.equal(await lerEstoque(produto.id), 8);
  });
});

// --------------------------------------------------------------------------------------
// Storage (bucket midia)
// --------------------------------------------------------------------------------------

describe('storage: bucket midia', () => {
  const caminho = `${PASTA}/imagem-${SUF}.png`;
  const midia = (cl) => cl.storage.from('midia');

  async function baixarPublico(arquivo) {
    const url = midia(anon).getPublicUrl(arquivo).data.publicUrl;
    const resposta = await fetch(url);
    return { status: resposta.status, corpo: Buffer.from(await resposta.arrayBuffer()) };
  }

  test('bucket existe, é público, limite de 50 MB e tipos de imagem/vídeo', async () => {
    const bucket = await semErro(servico.storage.getBucket('midia'), 'bucket');
    assert.equal(bucket.public, true);
    assert.equal(bucket.file_size_limit, 50 * 1024 * 1024);
    assert.deepEqual([...bucket.allowed_mime_types].sort(), ['image/*', 'video/mp4', 'video/webm']);
    const politicas = await sqlJson(`select json_agg(policyname order by policyname) from pg_policies
                                      where schemaname = 'storage' and tablename = 'objects' and policyname like 'ama_midia_%'`);
    assert.deepEqual(politicas, ['ama_midia_admin_delete', 'ama_midia_admin_insert', 'ama_midia_admin_select', 'ama_midia_admin_update']);
  });

  test('admin envia, lista, sobrescreve e apaga em site/; leitura pública sem login', async () => {
    const enviado = await semErro(midia(admin).upload(caminho, PNG, { contentType: 'image/png' }), 'upload');
    assert.equal(enviado.path, caminho);

    const lista = await semErro(midia(admin).list(PASTA), 'listar');
    assert.ok(lista.some((arquivo) => arquivo.name === `imagem-${SUF}.png`));

    const publico = await baixarPublico(caminho);
    assert.equal(publico.status, 200);
    assert.deepEqual(publico.corpo, PNG);

    // Enviar de novo sem upsert falha; com upsert sobrescreve.
    const { error: duplicado } = await midia(admin).upload(caminho, PNG, { contentType: 'image/png' });
    assert.ok(duplicado, 'upload repetido sem upsert deveria falhar');
    const novo = Buffer.concat([PNG, Buffer.from('versao-2')]);
    await semErro(midia(admin).upload(caminho, novo, { contentType: 'image/png', upsert: true }), 'upsert');
    const sobrescrito = await baixarPublico(caminho);
    assert.deepEqual(sobrescrito.corpo, novo);

    // Vídeo mp4 também é aceito.
    const video = `${PASTA}/video-${SUF}.mp4`;
    await semErro(midia(admin).upload(video, Buffer.from('mp4-falso'), { contentType: 'video/mp4' }), 'vídeo');

    const removidos = await semErro(midia(admin).remove([caminho, video]), 'remover');
    assert.equal(removidos.length, 2);
    assert.notEqual((await baixarPublico(caminho)).status, 200);
  });

  test('usuário comum e anônimo não enviam, não sobrescrevem e não apagam', async () => {
    const existente = `${PASTA}/fixo-${SUF}.png`;
    await semErro(midia(servico).upload(existente, PNG, { contentType: 'image/png' }), 'upload pelo serviço');
    for (const [papel, cl] of Object.entries({ anon, comum })) {
      const novo = `${PASTA}/${papel}-${SUF}.png`;
      const { error: erroUpload } = await midia(cl).upload(novo, PNG, { contentType: 'image/png' });
      assert.ok(erroUpload, `${papel} não deveria enviar`);
      assert.equal((await baixarPublico(novo)).status === 200, false);

      const { error: erroUpsert } = await midia(cl).upload(existente, Buffer.from('invasao'), { contentType: 'image/png', upsert: true });
      assert.ok(erroUpsert, `${papel} não deveria sobrescrever`);

      await midia(cl).remove([existente]);
      const depois = await baixarPublico(existente);
      assert.equal(depois.status, 200, `${papel} não deveria apagar`);
      assert.deepEqual(depois.corpo, PNG);

      const { data: lista } = await midia(cl).list(PASTA);
      assert.deepEqual(lista || [], [], `${papel} não lista`);
    }
  });

  test('tipo não permitido (text/plain) é recusado', async () => {
    const arquivo = `${PASTA}/nota-${SUF}.txt`;
    const { error } = await midia(admin).upload(arquivo, Buffer.from('texto'), { contentType: 'text/plain' });
    assert.ok(error, 'text/plain deveria ser recusado');
    assert.match(error.message, /mime type/i);
    const { error: erroHtml } = await midia(admin).upload(`${PASTA}/pagina-${SUF}.html`, Buffer.from('<script>'), { contentType: 'text/html' });
    assert.ok(erroHtml, 'text/html deveria ser recusado');
  });
});
