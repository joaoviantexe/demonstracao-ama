/**
 * Regras da loja compartilhadas pelas rotas (docs/ARQUITETURA.md §6.0 a §6.6).
 *
 * Exportações principais (assinaturas fixas da §6.0):
 * - lerConfiguracoes() → { loja, frete, checkout, notificacoes } com os padrões da §4.1 onde faltar.
 *     Cache curto em memória (CACHE_CONFIG_MS) por instância; limparCacheConfiguracoes() esvazia.
 * - cotar({ itens, cep, cupom }, { config?, comFrete? }) → saída de POST /api/loja/cotacao (sem "ok")
 *     { itens, subtotal_centavos, desconto_centavos, cupom, frete: { opcoes, erro } | null, frete_gratis_acima_centavos }
 *     frete é null sem CEP (comFrete: true força a cotação, que sem CEP devolve só a retirada).
 *     O frete grátis por valor mínimo usa o subtotal já com o desconto do cupom.
 * - sincronizarPagamento(pagamento, { siteUrl? }) → retorno de confirmar_pagamento
 *     ({ pedido_id, numero, status_anterior, status_novo, mudou, virou_pago }). Se virou_pago, envia os
 *     e-mails ao cliente e à equipe (notificacoes.email_admin) e registra eventos 'email'. Falha de e-mail
 *     nunca derruba a sincronização.
 *
 * Apoio para as rotas:
 * - erroDaLoja(erro, { itens }) → ErroHttp (ErroSupabase.codigo vira status/mensagem em português)
 * - buscarPedido(id, select) → linha de pedidos | null
 * - registrarEvento(pedidoId, tipo, descricao, dados, autor) → boolean (nunca lança)
 * - atualizarPedido(id, campos) → linha atualizada | null
 * - enviarEmailStatus(pedidoId, { siteUrl, autor }) → boolean (nunca lança)
 * - urlRastreioValida(url), codigoRastreioValido(codigo) → boolean (mesmas regras do banco)
 * - normalizarConfiguracoes(mapa), CONFIG_PADRAO, CACHE_CONFIG_MS, CABECALHOS_SEM_CACHE
 */

import { obterAmbiente } from './ambiente.js';
import { ErroHttp } from './http.js';
import { ErroSupabase, servico } from './supabase.js';
import { cotarFrete, FRETE_PADRAO, normalizarConfigFrete } from './frete.js';
import { emailNovoPedidoAdmin, emailPedidoPago, emailStatusPedido, enviarEmail } from './email.js';
import { validarEmail, validarUuid } from './validacao.js';

export const CABECALHOS_SEM_CACHE = Object.freeze({ 'Cache-Control': 'no-store' });

// Configurações mudam pelo painel: o cache só evita uma consulta por requisição em rajadas.
export const CACHE_CONFIG_MS = 15_000;
const TIMEOUT_EMAIL_MS = 5_000;

export const CONFIG_PADRAO = Object.freeze({
  loja: Object.freeze({
    titulo: 'Loja AMA',
    subtitulo: '',
    whatsapp: '5591981056049',
    instagram: 'oscdemulheres',
    email_contato: '',
    aviso_topo: '',
    frete_gratis_acima_centavos: null,
  }),
  frete: FRETE_PADRAO,
  checkout: Object.freeze({ parcelas_max: 6, aceitar_boleto: true, expiracao_horas: 72 }),
  notificacoes: Object.freeze({ email_admin: '' }),
});

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Erros

const MENSAGENS_CAMPO = {
  'cliente.nome': 'Informe nome e sobrenome.',
  'cliente.email': 'Confira o e-mail informado.',
  'cliente.telefone': 'Confira o telefone informado (DDD + número).',
  'cliente.cpf': 'Confira o CPF informado.',
  endereco: 'Informe o endereço de entrega.',
  'endereco.cep': 'Confira o CEP do endereço.',
  'endereco.logradouro': 'Informe a rua ou avenida.',
  'endereco.numero': 'Informe o número do endereço.',
  'endereco.complemento': 'O complemento pode ter no máximo 100 caracteres.',
  'endereco.bairro': 'Informe o bairro.',
  'endereco.cidade': 'Informe a cidade.',
  'endereco.uf': 'Escolha o estado (UF).',
  observacoes: 'As observações podem ter no máximo 500 caracteres.',
  p_nota: 'A nota pode ter no máximo 2000 caracteres.',
  'p_rastreio.codigo_rastreio': 'Código de rastreio inválido.',
  'p_rastreio.url_rastreio': 'O link de rastreio precisa ser um endereço https:// válido.',
};

export const MSG_ITEM_INDISPONIVEL = 'Alguns itens do carrinho mudaram de preço ou não estão mais disponíveis. Confira o carrinho atualizado.';
const MSG_FALHA_BANCO = 'Não foi possível acessar a loja agora. Tente novamente em instantes.';

const ehErroHttp = (erro) => erro instanceof ErroHttp
  || (erro && erro.name === 'ErroHttp' && Number.isInteger(erro.status) && typeof erro.erro === 'string');

/**
 * Converte erros do banco (ErroSupabase) em ErroHttp com mensagem para o cliente.
 * ErroHttp passa direto; outros erros também (tratarErro responde 500).
 */
export function erroDaLoja(erro, { itens } = {}) {
  if (ehErroHttp(erro)) return erro;
  if (!(erro instanceof ErroSupabase)) return erro;
  const detalhe = typeof erro.detalhes === 'string' ? erro.detalhes : '';
  switch (erro.codigo) {
    case 'item_indisponivel':
      return new ErroHttp(409, 'item_indisponivel', MSG_ITEM_INDISPONIVEL, Array.isArray(itens) ? { itens } : {});
    case 'cupom_invalido':
      return new ErroHttp(400, 'cupom_invalido', detalhe ? `${detalhe}.`.replace(/\.\.$/, '.') : 'Cupom inválido.');
    case 'dados_invalidos':
      return new ErroHttp(400, 'dados_invalidos', MENSAGENS_CAMPO[detalhe] || 'Confira os dados informados.',
        detalhe ? { campo: detalhe } : {});
    case 'carrinho_vazio':
      return new ErroHttp(400, 'carrinho_vazio', 'Seu carrinho está vazio.');
    case 'total_invalido':
      return new ErroHttp(400, 'total_invalido', 'O total do pedido precisa ser maior que zero.');
    case 'pedido_nao_encontrado':
      return new ErroHttp(404, 'pedido_nao_encontrado', 'Pedido não encontrado.');
    case 'status_invalido':
      return new ErroHttp(400, 'status_invalido', 'Status de pedido inválido.');
    default:
      break;
  }
  if (erro.status === 502 || erro.status === 504 || erro.status >= 500) {
    console.error(`[loja] banco indisponível: ${erro.status} ${erro.codigo}`);
    return new ErroHttp(502, 'falha_banco', MSG_FALHA_BANCO);
  }
  console.error('[loja] erro inesperado do banco:', erro.status, erro.codigo, erro.detalhes, erro.dica);
  return new ErroHttp(500, 'erro_interno', 'Erro interno. Tente novamente em instantes.');
}

// ---------------------------------------------------------------------------
// Rastreio (mesmas regras dos checks de pedidos e de alterar_status_pedido na migração)

const URL_RASTREIO = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?([/?#][^\s\u0000-\u001f\u007f-\u009f"'<>`\\]*)?$/i;
const PROIBIDOS_CODIGO = /[\u0000-\u001f\u007f-\u009f<>"'`]/;

/** Link de rastreio aceito pelo banco: https:// com host, até 500 caracteres, sem espaços, aspas, < > crase ou \. */
export function urlRastreioValida(url) {
  return typeof url === 'string' && url.length <= 500 && URL_RASTREIO.test(url);
}

/** Código de rastreio aceito pelo banco: até 200 caracteres, sem controles, < >, aspas ou crase. */
export function codigoRastreioValido(codigo) {
  return typeof codigo === 'string' && codigo.length <= 200 && !PROIBIDOS_CODIGO.test(codigo);
}

// ---------------------------------------------------------------------------
// Configurações

function inteiroPositivoOuNull(valor) {
  const n = typeof valor === 'string' && /^\s*\d+\s*$/.test(valor) ? Number(valor) : valor;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** { loja, frete, checkout, notificacoes } (valores do banco por chave) → configuração completa. */
export function normalizarConfiguracoes(mapa = {}) {
  const m = ehObjeto(mapa) ? mapa : {};
  const valor = (chave) => (ehObjeto(m[chave]) ? m[chave] : {});
  const loja = { ...CONFIG_PADRAO.loja, ...valor('loja') };
  loja.frete_gratis_acima_centavos = inteiroPositivoOuNull(loja.frete_gratis_acima_centavos);
  const notificacoes = { ...CONFIG_PADRAO.notificacoes, ...valor('notificacoes') };
  notificacoes.email_admin = typeof notificacoes.email_admin === 'string' ? notificacoes.email_admin.trim() : '';
  return structuredClone({
    loja,
    frete: normalizarConfigFrete({ frete: valor('frete') }),
    checkout: { ...CONFIG_PADRAO.checkout, ...valor('checkout') },
    notificacoes,
  });
}

let cacheConfig = null;

/** Esvazia o cache de lerConfiguracoes (testes, ou logo depois de salvar no painel). */
export function limparCacheConfiguracoes() {
  cacheConfig = null;
}

async function buscarConfiguracoes() {
  const linhas = await servico().select('configuracoes', {
    select: 'chave,valor',
    chave: 'in.(loja,frete,checkout,notificacoes)',
  });
  const mapa = {};
  for (const linha of linhas) if (linha && typeof linha.chave === 'string') mapa[linha.chave] = linha.valor;
  return normalizarConfiguracoes(mapa);
}

/** Configurações da loja com os padrões da §4.1. Lança ErroHttp (503 sem Supabase, 502 banco fora). */
export async function lerConfiguracoes() {
  const { supabaseUrl } = obterAmbiente();
  const agora = Date.now();
  if (!cacheConfig || cacheConfig.chave !== supabaseUrl || cacheConfig.expira <= agora) {
    const entrada = { chave: supabaseUrl, expira: agora + CACHE_CONFIG_MS, promessa: buscarConfiguracoes() };
    cacheConfig = entrada;
    entrada.promessa.catch(() => {
      if (cacheConfig === entrada) cacheConfig = null;
    });
  }
  try {
    return structuredClone(await cacheConfig.promessa);
  } catch (erro) {
    throw erroDaLoja(erro);
  }
}

// ---------------------------------------------------------------------------
// Cotação

const MAX_LINHAS_ENTRADA = 100;

function lerQuantidade(valor) {
  if (typeof valor === 'number') return Number.isFinite(valor) ? Math.trunc(valor) : 0;
  if (typeof valor === 'string' && /^\s*-?\d{1,9}\s*$/.test(valor)) return Number(valor);
  return 0;
}

// Linhas do carrinho para cotar_carrinho (que junta repetidos, ignora quantidade <= 0 e limita 30 x 99).
function itensDaEntrada(itens) {
  if (itens === undefined || itens === null || (Array.isArray(itens) && itens.length === 0)) {
    throw new ErroHttp(400, 'carrinho_vazio', 'Seu carrinho está vazio.');
  }
  if (!Array.isArray(itens)) {
    throw new ErroHttp(400, 'dados_invalidos', 'Envie os itens do carrinho.', { campo: 'itens' });
  }
  if (itens.length > MAX_LINHAS_ENTRADA) {
    throw new ErroHttp(400, 'dados_invalidos', 'O carrinho tem itens demais.', { campo: 'itens' });
  }
  const linhas = [];
  for (const item of itens) {
    if (!ehObjeto(item) || typeof item.produto_id !== 'string') continue;
    const produtoId = item.produto_id.trim().toLowerCase().slice(0, 64);
    if (!produtoId) continue;
    linhas.push({ produto_id: produtoId, quantidade: lerQuantidade(item.quantidade) });
  }
  return linhas;
}

function cupomDaEntrada(cupom) {
  if (typeof cupom !== 'string') return null;
  const codigo = cupom.trim().toUpperCase().slice(0, 60);
  return codigo || null;
}

const temCep = (cep) => (typeof cep === 'string' && cep.trim() !== '') || (typeof cep === 'number' && Number.isFinite(cep));

/**
 * Cotação completa do carrinho (§6.2): itens e cupom pelo banco (cotar_carrinho) e frete por lib/frete.js.
 * @param {{ itens: object[], cep?: string, cupom?: string }} entrada
 * @param {{ config?: object, comFrete?: boolean }} [opcoes]
 */
export async function cotar({ itens, cep, cupom } = {}, { config, comFrete = false } = {}) {
  const linhas = itensDaEntrada(itens);
  const codigo = cupomDaEntrada(cupom);
  let cotacao;
  let cfg;
  try {
    [cotacao, cfg] = await Promise.all([
      servico().rpc('cotar_carrinho', { p: { itens: linhas, cupom: codigo } }),
      config ? Promise.resolve(config) : lerConfiguracoes(),
    ]);
  } catch (erro) {
    throw erroDaLoja(erro);
  }
  if (!ehObjeto(cotacao) || !Array.isArray(cotacao.itens)) {
    console.error('[loja] cotar_carrinho devolveu um formato inesperado:', cotacao);
    throw new ErroHttp(502, 'falha_banco', MSG_FALHA_BANCO);
  }
  if (!cotacao.itens.length) throw new ErroHttp(400, 'carrinho_vazio', 'Seu carrinho está vazio.');

  const subtotal = Number.isSafeInteger(cotacao.subtotal_centavos) ? cotacao.subtotal_centavos : 0;
  const desconto = Number.isSafeInteger(cotacao.desconto_centavos) ? cotacao.desconto_centavos : 0;

  let frete = null;
  if (temCep(cep) || comFrete) {
    const resultado = await cotarFrete({
      itens: cotacao.itens,
      cep: temCep(cep) ? cep : '',
      // Frete grátis por valor mínimo olha o subtotal JÁ com o desconto do cupom (§6.2).
      subtotalCentavos: Math.max(0, subtotal - desconto),
      freteGratisCupom: cotacao.frete_gratis_cupom === true,
      config: cfg,
    });
    frete = { opcoes: resultado.opcoes, erro: resultado.erro };
  }

  return {
    itens: cotacao.itens,
    subtotal_centavos: subtotal,
    desconto_centavos: desconto,
    cupom: ehObjeto(cotacao.cupom) ? cotacao.cupom : null,
    frete,
    frete_gratis_acima_centavos: cfg.loja.frete_gratis_acima_centavos ?? null,
  };
}

// ---------------------------------------------------------------------------
// Pedidos e eventos

/** Linha de pedidos (com o select pedido) ou null. Id que não é UUID → null sem consultar. */
export async function buscarPedido(id, select = '*') {
  if (!validarUuid(id)) return null;
  const query = { select, id: `eq.${id.trim().toLowerCase()}`, limit: 1 };
  if (/pedido_itens\(/.test(select)) query['pedido_itens.order'] = 'id.asc';
  try {
    const [linha] = await servico().select('pedidos', query);
    return linha || null;
  } catch (erro) {
    throw erroDaLoja(erro);
  }
}

/** UPDATE em pedidos. Lança ErroHttp em falha. */
export async function atualizarPedido(id, campos) {
  try {
    const [linha] = await servico().update('pedidos', { id: `eq.${id}` }, campos);
    return linha || null;
  } catch (erro) {
    throw erroDaLoja(erro);
  }
}

/** Grava um evento na linha do tempo do pedido. Nunca lança (só registra no log). */
export async function registrarEvento(pedidoId, tipo, descricao, dados = null, autor = 'sistema') {
  try {
    await servico().insert('pedido_eventos', {
      pedido_id: pedidoId,
      tipo,
      descricao: String(descricao).slice(0, 5000),
      dados,
      autor,
    }, { retornar: false });
    return true;
  } catch (erro) {
    console.error(`[loja] falha ao registrar o evento "${tipo}" do pedido ${pedidoId}:`, erro && (erro.codigo || erro.message));
    return false;
  }
}

// ---------------------------------------------------------------------------
// E-mails

const SELECT_PEDIDO_EMAIL = '*,pedido_itens(nome,quantidade,preco_unitario_centavos,total_centavos)';

async function dadosParaEmail(pedidoId, siteUrl) {
  const [pedido, config] = await Promise.all([buscarPedido(pedidoId, SELECT_PEDIDO_EMAIL), lerConfiguracoes()]);
  if (!pedido) return null;
  const opcoes = { siteUrl, whatsapp: config.loja.whatsapp, retirada: config.frete.retirada };
  const contato = validarEmail(config.loja.email_contato) ? config.loja.email_contato : undefined;
  return { pedido, config, opcoes, contato };
}

// E-mails de pagamento confirmado (cliente e equipe). Nunca lança.
async function notificarPagamentoConfirmado(pedidoId, { siteUrl } = {}) {
  if (!obterAmbiente().emailConfigurado) return { cliente: false, equipe: false };
  try {
    const dados = await dadosParaEmail(pedidoId, siteUrl);
    if (!dados) return { cliente: false, equipe: false };
    const { pedido, config, opcoes, contato } = dados;

    const modeloCliente = emailPedidoPago(pedido, opcoes);
    const destinoEquipe = config.notificacoes.email_admin;
    const modeloEquipe = destinoEquipe ? emailNovoPedidoAdmin(pedido, opcoes) : null;

    const [cliente, equipe] = await Promise.all([
      enviarEmail({
        para: pedido.cliente_email,
        ...modeloCliente,
        responderPara: contato,
        idempotencia: `pedido-pago-${pedido.id}`,
        timeoutMs: TIMEOUT_EMAIL_MS,
      }),
      modeloEquipe
        ? enviarEmail({
          para: destinoEquipe,
          ...modeloEquipe,
          responderPara: pedido.cliente_email,
          idempotencia: `pedido-pago-equipe-${pedido.id}`,
          timeoutMs: TIMEOUT_EMAIL_MS,
        })
        : Promise.resolve(false),
    ]);

    const eventos = [];
    if (cliente) {
      eventos.push(registrarEvento(pedido.id, 'email', `E-mail "${modeloCliente.assunto}" enviado ao cliente`,
        { modelo: 'pedido_pago', destino: 'cliente' }));
    }
    if (equipe) {
      eventos.push(registrarEvento(pedido.id, 'email', `E-mail "${modeloEquipe.assunto}" enviado à equipe`,
        { modelo: 'novo_pedido_admin', destino: 'equipe' }));
    }
    await Promise.all(eventos);
    return { cliente, equipe };
  } catch (erro) {
    console.error(`[loja] falha ao preparar os e-mails do pedido ${pedidoId}:`, erro && (erro.mensagem || erro.message));
    return { cliente: false, equipe: false };
  }
}

/**
 * E-mail ao cliente conforme o status atual do pedido (enviado, entregue, cancelado…).
 * Registra evento 'email' quando o Resend aceita. Nunca lança; devolve true se enviou.
 */
export async function enviarEmailStatus(pedidoId, { siteUrl, autor = 'sistema' } = {}) {
  if (!obterAmbiente().emailConfigurado) return false;
  try {
    const dados = await dadosParaEmail(pedidoId, siteUrl);
    if (!dados) return false;
    const { pedido, opcoes, contato } = dados;
    const modelo = emailStatusPedido(pedido, opcoes);
    if (!modelo) return false;
    const enviado = await enviarEmail({
      para: pedido.cliente_email, ...modelo, responderPara: contato, timeoutMs: TIMEOUT_EMAIL_MS,
    });
    if (enviado) {
      await registrarEvento(pedido.id, 'email', `E-mail "${modelo.assunto}" enviado ao cliente`,
        { modelo: `status_${pedido.status}`, destino: 'cliente' }, autor);
    }
    return enviado;
  } catch (erro) {
    console.error(`[loja] falha ao enviar o e-mail de status do pedido ${pedidoId}:`, erro && (erro.mensagem || erro.message));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pagamento

const CAMPOS_PAGAMENTO = ['id', 'status', 'status_detail', 'transaction_amount', 'payment_type_id', 'payment_method_id', 'date_approved'];

/**
 * Sincroniza o pedido (external_reference) com um pagamento de GET /v1/payments/{id} via confirmar_pagamento.
 * Lança ErroHttp: 400 'referencia_invalida' (external_reference não é UUID), 404 'pedido_nao_encontrado',
 * 502 'falha_banco'.
 */
export async function sincronizarPagamento(pagamento, { siteUrl } = {}) {
  if (!ehObjeto(pagamento)) throw new ErroHttp(400, 'pagamento_invalido', 'Pagamento inválido.');
  const referencia = pagamento.external_reference === undefined || pagamento.external_reference === null
    ? '' : String(pagamento.external_reference).trim();
  if (!validarUuid(referencia)) {
    throw new ErroHttp(400, 'referencia_invalida', 'O pagamento não pertence a um pedido da loja.');
  }
  const pedidoId = referencia.toLowerCase();
  const dados = {};
  for (const campo of CAMPOS_PAGAMENTO) dados[campo] = pagamento[campo] ?? null;

  let resultado;
  try {
    resultado = await servico().rpc('confirmar_pagamento', { p_pedido_id: pedidoId, p_pagamento: dados });
  } catch (erro) {
    throw erroDaLoja(erro);
  }
  if (ehObjeto(resultado) && resultado.virou_pago === true) {
    await notificarPagamentoConfirmado(pedidoId, { siteUrl });
  }
  return resultado;
}
