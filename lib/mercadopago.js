/**
 * Mercado Pago Checkout Pro via API REST, sem SDK (docs/ARQUITETURA.md §6.0, §6.3, §6.4 e §6.5;
 * docs/pesquisa-apis.json → mercadopago). Só roda no servidor: o Access Token nunca vai para o navegador.
 *
 * Base: obterAmbiente().mpApiBase (https://api.mercadopago.com; MP_API_BASE nos testes).
 * Cabeçalhos: Authorization Bearer MP_ACCESS_TOKEN, Accept/Content-Type JSON.
 *
 * Erros (ErroHttp de lib/http.js):
 * - sem MP_ACCESS_TOKEN → 503 'pagamento_indisponivel'
 * - HTTP de erro, tempo esgotado, rede ou resposta ilegível → 502 'falha_mercado_pago'.
 *   O corpo cru da resposta (para log) fica em erro.detalhes = { status_mercado_pago, resposta_mercado_pago },
 *   fora de erro.extra, para não ir ao cliente. A falha também é registrada com console.error.
 *
 * Exportações:
 * - montarPreferencia({ pedido, itens, cliente, entrega, config, siteUrl, agora }) → corpo do
 *   POST /checkout/preferences (PURA, sem rede). Regras da §6.3:
 *     pedido   saída de criar_pedido ou linha de `pedidos`: { id, numero, token_acesso | token,
 *              subtotal_centavos, desconto_centavos, frete_centavos, total_centavos, cupom_codigo?, endereco?, itens? }
 *     itens    [{ produto_id, nome, quantidade, preco_unitario_centavos, total_centavos?, imagem? }]
 *              (padrão: pedido.itens)
 *     cliente  { nome, email, telefone, cpf } (padrão: pedido.cliente_*)
 *     entrega  { tipo, nome, preco_centavos, ... } (padrão: pedido.entrega)
 *     config   configuração `checkout` ({ parcelas_max, aceitar_boleto, expiracao_horas })
 *              ou o objeto inteiro de lerConfiguracoes() (usa config.checkout)
 *     siteUrl  URL pública do site (http ou https)
 *     agora    Date opcional (testes)
 *   - itens com unit_price em reais (2 casas); com desconto, um único item "Pedido #N — AMA" com o valor
 *     já descontado; frete como item "Frete — <nome>" quando > 0. A soma dos itens é sempre exatamente
 *     total_centavos (se os itens não fecharem com o total, também vira um item único).
 *   - notification_url (<siteUrl>/api/webhooks/mercadopago?source_news=webhooks) e auto_return 'approved'
 *     só quando siteUrl é https e não é localhost/IP local; back_urls (as três) sempre.
 *   - statement_descriptor 'AMA'; installments = min(parcelas_max, 12); exclui 'ticket' (boleto) se
 *     aceitar_boleto === false; expires true, expiration_date_to = agora + max(expiracao_horas, 72) h
 *     (no máximo 720 h), em ISO com fuso -03:00.
 * - criarPreferencia({ pedido, itens, cliente, entrega, config, siteUrl }, { timeoutMs }) → { id, init_point }
 *     Envia X-Idempotency-Key = pedido.id. Usa sempre init_point (sandbox_init_point não existe mais).
 * - obterPagamento(id, { timeoutMs }) → objeto de GET /v1/payments/{id} | null (404 ou id não numérico, sem chamar a API)
 * - buscarPagamentosPorReferencia(referencia, { timeoutMs }) → [pagamento] do mais recente ao mais antigo
 *     (GET /v1/payments/search?external_reference=…; só os de external_reference idêntica)
 * - validarAssinatura({ xSignature, xRequestId, dataId, segredo, toleranciaSegundos?, agora? }) → boolean
 *     HMAC-SHA256 hex do manifesto "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" (partes ausentes
 *     omitidas; ts literal), comparação em tempo constante. Nunca lança: entrada malformada → false.
 *     data.id com maiúsculas é aceito tanto literal (SDKs) quanto em minúsculas (documentação).
 *     toleranciaSegundos (opcional) liga o anti-replay; ts > 1e12 é tratado como milissegundos.
 * - montarManifesto({ dataId, xRequestId, ts }) → string (pura)
 * - ehUrlPublicaHttps(url) → boolean (https e host que não é localhost nem IP local)
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { obterAmbiente } from './ambiente.js';
import { ErroHttp } from './http.js';
import { centavosParaReais } from './dinheiro.js';

const TIMEOUT_PADRAO_MS = 15_000;
const LIMITE_CORPO_LOG = 4_000;
const PARCELAS_PADRAO = 6;
const PARCELAS_TETO = 12;
const EXPIRACAO_MIN_HORAS = 72;
const EXPIRACAO_MAX_HORAS = 720;
const DESCRITOR_FATURA = 'AMA';
const LIMITE_TITULO = 256;
// Ananindeua/Belém: UTC-3 o ano inteiro (sem horário de verão).
const FUSO_MINUTOS = -180;
const FUSO_TEXTO = '-03:00';

// ---------------------------------------------------------------------------
// Infraestrutura HTTP

const erroNaoConfigurado = () => new ErroHttp(503, 'pagamento_indisponivel',
  'O pagamento online ainda não está disponível. Tente novamente mais tarde ou fale com a AMA pelo WhatsApp.');

function exigirToken() {
  const ambiente = obterAmbiente();
  if (!ambiente.mpAccessToken) throw erroNaoConfigurado();
  return ambiente;
}

function falha(acao, status, texto, motivo) {
  const corpo = String(texto ?? '').slice(0, LIMITE_CORPO_LOG);
  const erro = new ErroHttp(502, 'falha_mercado_pago',
    'Não foi possível falar com o Mercado Pago agora. Tente novamente em instantes.');
  // Fica fora de `extra` para não ir na resposta ao cliente.
  erro.detalhes = { status_mercado_pago: status ?? null, resposta_mercado_pago: corpo, motivo };
  console.error(`[mercadopago] falha ao ${acao}: ${motivo}`
    + (status ? ` (HTTP ${status})` : '') + (corpo ? ` — ${corpo.slice(0, 1000)}` : ''));
  return erro;
}

async function requisitar(metodo, caminho, {
  corpo, cabecalhos = {}, timeoutMs = TIMEOUT_PADRAO_MS, acao = 'consultar o Mercado Pago', aceitar404 = false,
} = {}) {
  const ambiente = exigirToken();
  const url = `${ambiente.mpApiBase}${caminho}`;
  const init = {
    method: metodo,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${ambiente.mpAccessToken}`,
      ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...cabecalhos,
    },
  };
  if (corpo !== undefined) init.body = JSON.stringify(corpo);

  const limite = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : TIMEOUT_PADRAO_MS;
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), limite);
  let status;
  let texto;
  try {
    const resposta = await fetch(url, { ...init, signal: controle.signal });
    status = resposta.status;
    texto = await resposta.text();
  } catch (erro) {
    if (controle.signal.aborted) throw falha(acao, null, '', 'tempo esgotado');
    throw falha(acao, null, '', `erro de rede (${erro && erro.message ? erro.message : 'desconhecido'})`);
  } finally {
    clearTimeout(relogio);
  }

  if (status === 404 && aceitar404) return null;
  if (status === 401 || status === 403) throw falha(acao, status, texto, 'Access Token inválido ou sem permissão');
  if (status < 200 || status >= 300) throw falha(acao, status, texto, 'resposta de erro');
  try {
    return texto.trim() ? JSON.parse(texto) : null;
  } catch {
    throw falha(acao, status, texto, 'resposta ilegível');
  }
}

// ---------------------------------------------------------------------------
// Preferência (pura)

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const digitos = (v) => (v === undefined || v === null ? '' : String(v).replace(/\D+/g, ''));
const textoLimpo = (v) => (v === undefined || v === null ? '' : String(v)).replace(/[\u0000-\u001f\u007f]+/g, ' ')
  .replace(/\s+/g, ' ').trim();

function cortar(texto, max) {
  const letras = Array.from(texto);
  return letras.length <= max ? texto : `${letras.slice(0, max - 1).join('')}…`;
}

function centavosObrigatorios(valor, nome) {
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new TypeError(`montarPreferencia: ${nome} deve ser inteiro de centavos >= 0 (recebido ${String(valor)})`);
  }
  return valor;
}

const centavosOuZero = (valor) => (Number.isSafeInteger(valor) && valor >= 0 ? valor : 0);

/** true se a URL é https e o host não é localhost nem IP local (o Mercado Pago recusa esses). */
export function ehUrlPublicaHttps(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (host === '::1' || host === '::' || host === '0.0.0.0') return false;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)) return false;
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return false;
  return true;
}

function baseDoSite(siteUrl) {
  let u;
  try {
    u = new URL(String(siteUrl ?? ''));
  } catch {
    throw new TypeError(`montarPreferencia: siteUrl inválida (${String(siteUrl)})`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new TypeError(`montarPreferencia: siteUrl precisa ser http(s) (${String(siteUrl)})`);
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** Data em ISO 8601 com o fuso de Belém: 2026-10-10T23:59:59.000-03:00 */
function isoComFuso(data) {
  const local = new Date(data.getTime() + FUSO_MINUTOS * 60_000);
  return local.toISOString().replace('Z', FUSO_TEXTO);
}

function configuracaoCheckout(config) {
  const c = ehObjeto(config) && ehObjeto(config.checkout) ? config.checkout : (ehObjeto(config) ? config : {});
  const parcelasLidas = Number(c.parcelas_max);
  const parcelas = Number.isFinite(parcelasLidas) && parcelasLidas >= 1
    ? Math.min(Math.floor(parcelasLidas), PARCELAS_TETO)
    : PARCELAS_PADRAO;
  const horasLidas = Number(c.expiracao_horas);
  const horas = Number.isFinite(horasLidas)
    ? Math.min(Math.max(horasLidas, EXPIRACAO_MIN_HORAS), EXPIRACAO_MAX_HORAS)
    : EXPIRACAO_MIN_HORAS;
  return { parcelas, aceitarBoleto: c.aceitar_boleto !== false, horas };
}

function montarPagador(cliente, endereco) {
  const pagador = {};
  const nome = textoLimpo(cliente.nome);
  if (nome) {
    const [primeiro, ...resto] = nome.split(' ');
    pagador.name = cortar(primeiro, 120);
    if (resto.length) pagador.surname = cortar(resto.join(' '), 120);
  }
  const email = textoLimpo(cliente.email);
  if (email) pagador.email = email;

  let telefone = digitos(cliente.telefone);
  if ((telefone.length === 12 || telefone.length === 13) && telefone.startsWith('55')) telefone = telefone.slice(2);
  if (telefone.length === 10 || telefone.length === 11) {
    pagador.phone = { area_code: telefone.slice(0, 2), number: telefone.slice(2) };
  }
  const cpf = digitos(cliente.cpf);
  if (cpf.length === 11) pagador.identification = { type: 'CPF', number: cpf };

  if (ehObjeto(endereco)) {
    const cep = digitos(endereco.cep);
    const rua = textoLimpo(endereco.logradouro);
    const numero = digitos(endereco.numero);
    if (cep.length === 8 && rua) {
      pagador.address = { zip_code: cep, street_name: cortar(rua, 200) };
      // O tipo do campo é numérico: "s/n" e "12A" ficam de fora.
      if (numero && numero === String(endereco.numero).trim() && Number(numero) > 0) {
        pagador.address.street_number = Number(numero);
      }
    }
  }
  return pagador;
}

function urlDaImagem(imagem, base) {
  const texto = typeof imagem === 'string' ? imagem.trim() : '';
  if (!texto) return null;
  try {
    const url = new URL(texto, `${base}/`);
    return ehUrlPublicaHttps(url.href) ? url.href : null;
  } catch {
    return null;
  }
}

function lerItens(itens) {
  if (!Array.isArray(itens)) return null;
  const lidos = [];
  for (const item of itens) {
    if (!ehObjeto(item)) return null;
    const quantidade = item.quantidade;
    const preco = item.preco_unitario_centavos;
    if (!Number.isSafeInteger(quantidade) || quantidade < 1) return null;
    if (!Number.isSafeInteger(preco) || preco <= 0) return null;
    const total = preco * quantidade;
    if (item.total_centavos !== undefined && item.total_centavos !== null && item.total_centavos !== total) return null;
    lidos.push({ ...item, total });
  }
  return lidos;
}

function resumoDosItens(itens) {
  if (!Array.isArray(itens)) return '';
  const partes = itens
    .filter((item) => ehObjeto(item) && textoLimpo(item.nome))
    .map((item) => `${Number.isSafeInteger(item.quantidade) ? item.quantidade : 1}× ${textoLimpo(item.nome)}`);
  return partes.join('; ');
}

/**
 * Corpo do POST /checkout/preferences (sem rede). Ver o cabeçalho do arquivo.
 * @returns {object}
 */
export function montarPreferencia({ pedido, itens, cliente, entrega, config, siteUrl, agora } = {}) {
  if (!ehObjeto(pedido)) throw new TypeError('montarPreferencia: pedido ausente');
  const id = pedido.id === undefined || pedido.id === null ? '' : String(pedido.id).trim();
  if (!id) throw new TypeError('montarPreferencia: pedido.id ausente');
  const token = String(pedido.token_acesso ?? pedido.token ?? '').trim();
  if (!token) throw new TypeError('montarPreferencia: token do pedido ausente');

  const total = centavosObrigatorios(pedido.total_centavos, 'pedido.total_centavos');
  if (total <= 0) throw new TypeError('montarPreferencia: o total do pedido precisa ser maior que zero');

  const dadosEntrega = ehObjeto(entrega) ? entrega : (ehObjeto(pedido.entrega) ? pedido.entrega : {});
  const frete = Number.isSafeInteger(pedido.frete_centavos)
    ? centavosObrigatorios(pedido.frete_centavos, 'pedido.frete_centavos')
    : centavosOuZero(dadosEntrega.preco_centavos);
  if (frete > total) throw new TypeError('montarPreferencia: frete maior que o total do pedido');
  const desconto = centavosOuZero(pedido.desconto_centavos);
  const produtos = total - frete;

  const base = baseDoSite(siteUrl);
  const publica = ehUrlPublicaHttps(base);
  const numero = pedido.numero === undefined || pedido.numero === null ? '' : textoLimpo(pedido.numero);
  const rotulo = numero ? `Pedido #${numero} — AMA` : 'Pedido — AMA';
  const listaItens = Array.isArray(itens) ? itens : (Array.isArray(pedido.itens) ? pedido.itens : []);

  const itensMp = [];
  if (produtos > 0) {
    const lidos = desconto === 0 ? lerItens(listaItens) : null;
    const somaItens = lidos ? lidos.reduce((soma, item) => soma + item.total, 0) : -1;
    if (lidos && lidos.length && somaItens === produtos) {
      lidos.forEach((item, indice) => {
        const itemMp = {
          id: cortar(textoLimpo(item.produto_id) || `item-${indice + 1}`, LIMITE_TITULO),
          title: cortar(textoLimpo(item.nome) || 'Produto AMA', LIMITE_TITULO),
          quantity: item.quantidade,
          currency_id: 'BRL',
          unit_price: centavosParaReais(item.preco_unitario_centavos),
        };
        const imagem = urlDaImagem(item.imagem, base);
        if (imagem) itemMp.picture_url = imagem;
        itensMp.push(itemMp);
      });
    } else {
      // Desconto (ou itens que não fecham com o total): um item só, já com o valor final dos produtos.
      const resumo = resumoDosItens(listaItens);
      const cupom = textoLimpo(pedido.cupom_codigo);
      const partes = [];
      if (resumo) partes.push(resumo);
      if (desconto > 0) partes.push(cupom ? `Desconto do cupom ${cupom} já aplicado` : 'Desconto já aplicado');
      const itemMp = {
        id: cortar(numero ? `pedido-${numero}` : `pedido-${id}`, LIMITE_TITULO),
        title: rotulo,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: centavosParaReais(produtos),
      };
      if (partes.length) itemMp.description = cortar(partes.join(' · '), LIMITE_TITULO);
      itensMp.push(itemMp);
    }
  }
  if (frete > 0) {
    const nomeFrete = textoLimpo(dadosEntrega.nome) || 'Entrega';
    itensMp.push({
      id: 'frete',
      title: cortar(`Frete — ${nomeFrete}`, LIMITE_TITULO),
      quantity: 1,
      currency_id: 'BRL',
      unit_price: centavosParaReais(frete),
    });
  }

  const dadosCliente = ehObjeto(cliente) ? cliente : {
    nome: pedido.cliente_nome, email: pedido.cliente_email, telefone: pedido.cliente_telefone, cpf: pedido.cliente_cpf,
  };
  const { parcelas, aceitarBoleto, horas } = configuracaoCheckout(config);
  const inicio = agora instanceof Date && Number.isFinite(agora.getTime()) ? agora : new Date();
  const fim = new Date(inicio.getTime() + horas * 3_600_000);
  const retorno = `${base}/loja/pedido?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;

  const preferencia = {
    items: itensMp,
    payer: montarPagador(dadosCliente, pedido.endereco),
    external_reference: id,
    back_urls: { success: retorno, pending: retorno, failure: retorno },
    statement_descriptor: DESCRITOR_FATURA,
    payment_methods: {
      installments: parcelas,
      excluded_payment_types: aceitarBoleto ? [] : [{ id: 'ticket' }],
      excluded_payment_methods: [],
    },
    expires: true,
    expiration_date_from: isoComFuso(inicio),
    expiration_date_to: isoComFuso(fim),
    metadata: { pedido_id: id, pedido_numero: numero || null },
  };
  // HTTPS obrigatório e localhost recusado: em desenvolvimento só as back_urls vão.
  if (publica) {
    preferencia.notification_url = `${base}/api/webhooks/mercadopago?source_news=webhooks`;
    preferencia.auto_return = 'approved';
  }
  return preferencia;
}

// ---------------------------------------------------------------------------
// Chamadas à API

/**
 * Cria a preferência de pagamento do pedido. Devolve { id, init_point }.
 * @param {{ pedido: object, itens?: object[], cliente?: object, entrega?: object, config?: object, siteUrl: string }} dados
 */
export async function criarPreferencia({ pedido, itens, cliente, entrega, config, siteUrl } = {}, { timeoutMs } = {}) {
  exigirToken();
  const corpo = montarPreferencia({ pedido, itens, cliente, entrega, config, siteUrl });
  const resposta = await requisitar('POST', '/checkout/preferences', {
    corpo,
    cabecalhos: { 'X-Idempotency-Key': String(pedido.id) },
    timeoutMs,
    acao: 'criar a preferência de pagamento',
  });
  const id = ehObjeto(resposta) && (typeof resposta.id === 'string' || typeof resposta.id === 'number')
    ? String(resposta.id) : '';
  const initPoint = ehObjeto(resposta) && typeof resposta.init_point === 'string' ? resposta.init_point : '';
  let urlValida = false;
  try {
    const u = new URL(initPoint);
    urlValida = u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    urlValida = false;
  }
  if (!id || !urlValida) {
    throw falha('criar a preferência de pagamento', null, JSON.stringify(resposta ?? null), 'resposta sem id ou init_point');
  }
  return { id, init_point: initPoint };
}

// Ids de pagamento da Payments API são numéricos.
const ID_VALIDO = /^\d{1,20}$/;

/** GET /v1/payments/{id}. null quando o Mercado Pago responde 404 (ou o id não é numérico). */
export async function obterPagamento(id, { timeoutMs } = {}) {
  exigirToken();
  const texto = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : (typeof id === 'string' ? id.trim() : '');
  if (!ID_VALIDO.test(texto)) return null;
  const pagamento = await requisitar('GET', `/v1/payments/${encodeURIComponent(texto)}`, {
    timeoutMs, aceitar404: true, acao: `consultar o pagamento ${texto}`,
  });
  return ehObjeto(pagamento) ? pagamento : null;
}

const momento = (pagamento) => {
  const t = Date.parse(pagamento && (pagamento.date_created || pagamento.date_last_updated));
  return Number.isFinite(t) ? t : 0;
};

function compararIds(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
    const dx = BigInt(x);
    const dy = BigInt(y);
    return dx === dy ? 0 : (dx > dy ? 1 : -1);
  }
  return x.localeCompare(y);
}

/** Pagamentos com external_reference = referencia, do mais recente ao mais antigo. */
export async function buscarPagamentosPorReferencia(referencia, { timeoutMs } = {}) {
  exigirToken();
  const ref = typeof referencia === 'string' ? referencia.trim() : (typeof referencia === 'number' ? String(referencia) : '');
  if (!ref || ref.length > 256) return [];
  const query = new URLSearchParams({
    external_reference: ref, sort: 'date_created', criteria: 'desc', limit: '50', offset: '0',
  });
  const resposta = await requisitar('GET', `/v1/payments/search?${query}`, {
    timeoutMs, acao: 'buscar os pagamentos do pedido',
  });
  const resultados = ehObjeto(resposta) && Array.isArray(resposta.results) ? resposta.results : [];
  return resultados
    .filter((p) => ehObjeto(p) && String(p.external_reference ?? '') === ref)
    .sort((a, b) => (momento(b) - momento(a)) || compararIds(b.id, a.id));
}

// ---------------------------------------------------------------------------
// Assinatura dos webhooks

function valorDoCabecalho(valor) {
  const v = Array.isArray(valor) ? valor[0] : valor;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' ? v.trim() : '';
}

/** "id:<data.id>;request-id:<x-request-id>;ts:<ts>;" com as partes ausentes omitidas. */
export function montarManifesto({ dataId, xRequestId, ts } = {}) {
  const partes = [];
  const id = valorDoCabecalho(dataId);
  const pedido = valorDoCabecalho(xRequestId);
  if (id) partes.push(`id:${id}`);
  if (pedido) partes.push(`request-id:${pedido}`);
  partes.push(`ts:${valorDoCabecalho(ts)}`);
  return `${partes.join(';')};`;
}

function lerXSignature(texto) {
  let ts = null;
  const v1 = [];
  for (const parte of texto.split(',')) {
    const igual = parte.indexOf('=');
    if (igual < 0) continue;
    const chave = parte.slice(0, igual).trim().toLowerCase();
    const valor = parte.slice(igual + 1).trim();
    if (chave === 'ts') {
      if (ts !== null) return null; // ts repetido: ambíguo
      ts = valor;
    } else if (chave === 'v1') {
      v1.push(valor.toLowerCase());
    }
  }
  return { ts, v1 };
}

/**
 * Valida o x-signature de um webhook do Mercado Pago. Nunca lança.
 * @returns {boolean}
 */
export function validarAssinatura(entrada) {
  try {
    if (!ehObjeto(entrada)) return false;
    const { xSignature, xRequestId, dataId, segredo, toleranciaSegundos, agora } = entrada;
    if (typeof segredo !== 'string' || !segredo) return false;
    const assinatura = valorDoCabecalho(xSignature);
    if (!assinatura || assinatura.length > 1024) return false;

    const lido = lerXSignature(assinatura);
    if (!lido || !lido.ts || !/^\d{1,16}$/.test(lido.ts)) return false;
    const recebidas = lido.v1.filter((v) => /^[0-9a-f]{64}$/.test(v)).map((v) => Buffer.from(v, 'hex'));
    if (!recebidas.length) return false;

    if (Number.isFinite(toleranciaSegundos) && toleranciaSegundos > 0) {
      const numero = Number(lido.ts);
      const tsMs = numero > 1e12 ? numero : numero * 1000;
      const agoraMs = Number.isFinite(agora) ? agora : (agora instanceof Date ? agora.getTime() : Date.now());
      if (Math.abs(agoraMs - tsMs) > toleranciaSegundos * 1000) return false;
    }

    const id = valorDoCabecalho(dataId);
    const variantes = id && id !== id.toLowerCase() ? [id, id.toLowerCase()] : [id];
    let valida = false;
    for (const variante of variantes) {
      const manifesto = montarManifesto({ dataId: variante, xRequestId, ts: lido.ts });
      const esperada = createHmac('sha256', segredo).update(manifesto).digest();
      for (const recebida of recebidas) {
        if (recebida.length === esperada.length && timingSafeEqual(recebida, esperada)) valida = true;
      }
    }
    return valida;
  } catch {
    return false;
  }
}
