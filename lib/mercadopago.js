/**
 * Mercado Pago via API REST, sem SDK (docs/ARQUITETURA.md §6.0, §6.3, §6.4, §6.5 e §6.7;
 * docs/pesquisa-apis.json → mercadopago). Só roda no servidor: o Access Token nunca vai para o navegador.
 * Dois jeitos de cobrar: Checkout Pro (preferência + página do Mercado Pago) e Checkout Transparente
 * (pagamento criado aqui, com Pix, boleto ou o token do cartão gerado pelo MercadoPago.js no navegador).
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
 *              subtotal_centavos, frete_centavos, total_centavos, endereco?, itens? }
 *     itens    [{ produto_id, nome, quantidade, preco_unitario_centavos, total_centavos?, imagem? }]
 *              (padrão: pedido.itens)
 *     cliente  { nome, email, telefone, cpf } (padrão: pedido.cliente_*)
 *     entrega  { tipo, nome, preco_centavos, ... } (padrão: pedido.entrega)
 *     config   configuração `checkout` ({ parcelas_max, aceitar_boleto, expiracao_horas })
 *              ou o objeto inteiro de lerConfiguracoes() (usa config.checkout)
 *     siteUrl  URL pública do site (http ou https)
 *     agora    Date opcional (testes)
 *   - itens com unit_price em reais (2 casas); frete como item "Frete — <nome>" quando > 0. A soma dos
 *     itens é sempre exatamente total_centavos (se os itens não fecharem com o total, vira um item único
 *     "Pedido #N — AMA" com o valor dos produtos).
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
 *
 * Checkout Transparente (POST /v1/payments):
 * - montarPagamento({ pedido, metodo, cartao, config, siteUrl, agora }) → corpo do POST (PURA, sem rede)
 *     pedido   linha de `pedidos` com pedido_itens (cliente_*, endereco, entrega, totais)
 *     metodo   'pix' | 'boleto' | 'cartao'
 *     cartao   { token, payment_method_id, issuer_id, parcelas, tipo_documento, documento } (só no cartão;
 *              os dados vêm do MercadoPago.js, já conferidos pela rota)
 *   - transaction_amount = total do pedido (do banco, nunca do navegador); external_reference = pedido.id;
 *     itens, comprador e endereço em additional_info (ajudam a análise antifraude).
 *   - Pix e boleto vencem em agora + max(expiracao_horas, 72) h (no máximo 720 h); o boleto leva o endereço
 *     completo do comprador (exigência do Mercado Pago).
 *   - notification_url só com siteUrl https pública (como na preferência).
 * - criarPagamento(corpo, { chaveIdempotencia, sessaoDispositivo, timeoutMs }) → pagamento (objeto do MP)
 *     X-Idempotency-Key obrigatório; X-Meli-Session-Id quando o navegador mandou o device id.
 *     Pagamento recusado volta normalmente (status 'rejected'); dados que o Mercado Pago não aceita
 *     (HTTP 400, ex.: token de cartão vencido) → ErroHttp 400 'pagamento_nao_processado'.
 * - cancelarPagamento(id, { timeoutMs }) → pagamento (PUT status 'cancelled'; só pendentes)
 * - resumoDoPagamento(pagamento) → { id, status, status_detail, metodo, expira_em, pix?, boleto?, mensagem? }
 *     (PURA) só o que a página do pedido mostra: QR e copia e cola do Pix, link e linha digitável do boleto,
 *     motivo da recusa do cartão em português.
 * - mensagemDaRecusa(status_detail) → texto para o cliente
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
  erroCliente = '',
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
  if (erroCliente && (status === 400 || status === 422)) {
    // Dados recusados pelo Mercado Pago (ex.: token do cartão vencido): o cliente pode corrigir e tentar de novo.
    const corpoLog = String(texto ?? '').slice(0, LIMITE_CORPO_LOG);
    console.warn(`[mercadopago] ${acao}: dados recusados (HTTP ${status}) — ${corpoLog.slice(0, 1000)}`);
    const erro = new ErroHttp(400, 'pagamento_nao_processado', erroCliente);
    erro.detalhes = { status_mercado_pago: status, resposta_mercado_pago: corpoLog, motivo: 'dados recusados' };
    throw erro;
  }
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

/** Regras de `checkout` com padrões e limites: { parcelas (1–12), aceitarBoleto, horas (72–720) }. */
export function configuracaoCheckout(config) {
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
 * Itens no formato do Mercado Pago. A soma é sempre produtos + frete: itens que não fecham com o valor dos
 * produtos viram um item único "Pedido #N — AMA"; o frete entra como item "Frete — <nome>" quando > 0.
 */
function montarItens({ listaItens, produtos, frete, nomeEntrega, base, numero, id, rotulo }) {
  const itensMp = [];
  if (produtos > 0) {
    const lidos = lerItens(listaItens);
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
      // Itens que não fecham com o total: um item só, com o valor final dos produtos.
      const resumo = resumoDosItens(listaItens);
      const itemMp = {
        id: cortar(numero ? `pedido-${numero}` : `pedido-${id}`, LIMITE_TITULO),
        title: rotulo,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: centavosParaReais(produtos),
      };
      if (resumo) itemMp.description = cortar(resumo, LIMITE_TITULO);
      itensMp.push(itemMp);
    }
  }
  if (frete > 0) {
    itensMp.push({
      id: 'frete',
      title: cortar(`Frete — ${textoLimpo(nomeEntrega) || 'Entrega'}`, LIMITE_TITULO),
      quantity: 1,
      currency_id: 'BRL',
      unit_price: centavosParaReais(frete),
    });
  }
  return itensMp;
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
  const produtos = total - frete;

  const base = baseDoSite(siteUrl);
  const publica = ehUrlPublicaHttps(base);
  const numero = pedido.numero === undefined || pedido.numero === null ? '' : textoLimpo(pedido.numero);
  const rotulo = numero ? `Pedido #${numero} — AMA` : 'Pedido — AMA';
  const listaItens = Array.isArray(itens) ? itens : (Array.isArray(pedido.itens) ? pedido.itens : []);

  const itensMp = montarItens({
    listaItens, produtos, frete, nomeEntrega: dadosEntrega.nome, base, numero, id, rotulo,
  });

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
// Checkout Transparente (POST /v1/payments)

export const METODOS_PAGAMENTO = Object.freeze(['pix', 'cartao', 'boleto']);
const METODO_BOLETO = 'bolbradesco';
const TIMEOUT_PAGAMENTO_MS = 25_000;
const LIMITE_QR = 100_000;
const MSG_DADOS_RECUSADOS = 'O Mercado Pago não aceitou estes dados de pagamento. Confira e tente de novo.';

function nomeEmPartes(nome) {
  const limpo = textoLimpo(nome);
  if (!limpo) return {};
  const [primeiro, ...resto] = limpo.split(' ');
  const partes = { first_name: cortar(primeiro, 120) };
  if (resto.length) partes.last_name = cortar(resto.join(' '), 120);
  return partes;
}

function telefoneMp(valor) {
  let telefone = digitos(valor);
  if ((telefone.length === 12 || telefone.length === 13) && telefone.startsWith('55')) telefone = telefone.slice(2);
  return telefone.length === 10 || telefone.length === 11
    ? { area_code: telefone.slice(0, 2), number: telefone.slice(2) } : null;
}

/** Endereço do pedido no formato do Mercado Pago (o número vai como texto; sem número, "S/N"). */
function enderecoMp(endereco) {
  const e = ehObjeto(endereco) ? endereco : {};
  return {
    cep: digitos(e.cep),
    rua: cortar(textoLimpo(e.logradouro), 200),
    numero: cortar(textoLimpo(e.numero), 20) || 'S/N',
    complemento: cortar(textoLimpo(e.complemento), 100),
    bairro: cortar(textoLimpo(e.bairro), 100),
    cidade: cortar(textoLimpo(e.cidade), 100),
    uf: textoLimpo(e.uf).toUpperCase().slice(0, 2),
  };
}

/**
 * Corpo do POST /v1/payments (sem rede). Ver o cabeçalho do arquivo.
 * @returns {object}
 */
export function montarPagamento({ pedido, metodo, cartao, config, siteUrl, agora } = {}) {
  if (!ehObjeto(pedido)) throw new TypeError('montarPagamento: pedido ausente');
  const id = pedido.id === undefined || pedido.id === null ? '' : String(pedido.id).trim();
  if (!id) throw new TypeError('montarPagamento: pedido.id ausente');
  if (!METODOS_PAGAMENTO.includes(metodo)) throw new TypeError(`montarPagamento: método inválido (${String(metodo)})`);
  const total = centavosObrigatorios(pedido.total_centavos, 'pedido.total_centavos');
  if (total <= 0) throw new TypeError('montarPagamento: o total do pedido precisa ser maior que zero');
  const frete = Number.isSafeInteger(pedido.frete_centavos) ? centavosObrigatorios(pedido.frete_centavos, 'pedido.frete_centavos') : 0;
  if (frete > total) throw new TypeError('montarPagamento: frete maior que o total do pedido');

  const base = baseDoSite(siteUrl);
  const numero = pedido.numero === undefined || pedido.numero === null ? '' : textoLimpo(pedido.numero);
  const rotulo = numero ? `Pedido #${numero} — AMA` : 'Pedido — AMA';
  const listaItens = Array.isArray(pedido.pedido_itens) ? pedido.pedido_itens : (Array.isArray(pedido.itens) ? pedido.itens : []);
  const entrega = ehObjeto(pedido.entrega) ? pedido.entrega : {};
  const itens = montarItens({
    listaItens, produtos: total - frete, frete, nomeEntrega: entrega.nome, base, numero, id, rotulo,
  }).map(({ currency_id: _moeda, ...item }) => item);

  const nome = nomeEmPartes(pedido.cliente_nome);
  const email = textoLimpo(pedido.cliente_email);
  const cpf = digitos(pedido.cliente_cpf);
  const telefone = telefoneMp(pedido.cliente_telefone);
  const end = enderecoMp(pedido.endereco);
  const enderecoCurto = end.cep.length === 8 && end.rua
    ? { zip_code: end.cep, street_name: end.rua, street_number: end.numero } : null;

  const infoComprador = { ...nome };
  if (telefone) infoComprador.phone = telefone;
  if (enderecoCurto) infoComprador.address = enderecoCurto;
  const adicional = { items: itens, payer: infoComprador };
  if (enderecoCurto) {
    const destino = { ...enderecoCurto, city_name: end.cidade, state_name: end.uf };
    if (end.complemento) destino.apartment = end.complemento;
    adicional.shipments = { receiver_address: destino };
  }

  const corpo = {
    transaction_amount: centavosParaReais(total),
    description: rotulo,
    external_reference: id,
    statement_descriptor: DESCRITOR_FATURA,
    metadata: { pedido_id: id, pedido_numero: numero || null },
    payer: { email },
    additional_info: adicional,
  };
  if (ehUrlPublicaHttps(base)) corpo.notification_url = `${base}/api/webhooks/mercadopago?source_news=webhooks`;

  if (metodo === 'cartao') {
    const c = ehObjeto(cartao) ? cartao : {};
    const token = typeof c.token === 'string' ? c.token.trim() : '';
    if (!token) throw new TypeError('montarPagamento: token do cartão ausente');
    corpo.token = token;
    corpo.installments = Number.isSafeInteger(c.parcelas) && c.parcelas >= 1 ? c.parcelas : 1;
    corpo.payment_method_id = textoLimpo(c.payment_method_id);
    const emissor = digitos(c.issuer_id);
    if (emissor) corpo.issuer_id = Number(emissor);
    const documento = digitos(c.documento);
    const tipo = c.tipo_documento === 'CNPJ' ? 'CNPJ' : 'CPF';
    if (documento) corpo.payer.identification = { type: tipo, number: documento };
    else if (cpf.length === 11) corpo.payer.identification = { type: 'CPF', number: cpf };
    return corpo;
  }

  Object.assign(corpo.payer, nome);
  if (cpf.length === 11) corpo.payer.identification = { type: 'CPF', number: cpf };
  const { horas } = configuracaoCheckout(config);
  const inicio = agora instanceof Date && Number.isFinite(agora.getTime()) ? agora : new Date();
  corpo.date_of_expiration = isoComFuso(new Date(inicio.getTime() + horas * 3_600_000));
  if (metodo === 'pix') {
    corpo.payment_method_id = 'pix';
  } else {
    corpo.payment_method_id = METODO_BOLETO;
    corpo.payer.address = {
      zip_code: end.cep,
      street_name: end.rua,
      street_number: end.numero,
      neighborhood: end.bairro,
      city: end.cidade,
      federal_unit: end.uf,
    };
  }
  return corpo;
}

// Device id do antifraude (MP_DEVICE_SESSION_ID do MercadoPago.js): só o formato esperado vai no cabeçalho.
const SESSAO_DISPOSITIVO = /^[A-Za-z0-9:_.-]{8,200}$/;

function conferirPagamento(resposta, acao) {
  const id = ehObjeto(resposta) && (typeof resposta.id === 'number' || typeof resposta.id === 'string')
    ? String(resposta.id) : '';
  if (!ID_VALIDO.test(id) || typeof resposta.status !== 'string' || !resposta.status) {
    throw falha(acao, null, JSON.stringify(resposta ?? null), 'resposta sem id ou status');
  }
  return resposta;
}

/** POST /v1/payments. Devolve o pagamento (inclusive recusado). */
export async function criarPagamento(corpo, { chaveIdempotencia, sessaoDispositivo, timeoutMs = TIMEOUT_PAGAMENTO_MS } = {}) {
  exigirToken();
  const chave = typeof chaveIdempotencia === 'string' ? chaveIdempotencia.trim() : '';
  if (!chave || chave.length > 200) throw new TypeError('criarPagamento: chaveIdempotencia obrigatória');
  const cabecalhos = { 'X-Idempotency-Key': chave };
  if (typeof sessaoDispositivo === 'string' && SESSAO_DISPOSITIVO.test(sessaoDispositivo)) {
    cabecalhos['X-Meli-Session-Id'] = sessaoDispositivo;
  }
  const resposta = await requisitar('POST', '/v1/payments', {
    corpo, cabecalhos, timeoutMs, acao: 'criar o pagamento', erroCliente: MSG_DADOS_RECUSADOS,
  });
  return conferirPagamento(resposta, 'criar o pagamento');
}

/** PUT /v1/payments/{id} com status 'cancelled' (Pix ou boleto ainda não pago). Devolve o pagamento. */
export async function cancelarPagamento(id, { timeoutMs } = {}) {
  exigirToken();
  const texto = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : (typeof id === 'string' ? id.trim() : '');
  if (!ID_VALIDO.test(texto)) throw new TypeError(`cancelarPagamento: id inválido (${String(id)})`);
  const resposta = await requisitar('PUT', `/v1/payments/${encodeURIComponent(texto)}`, {
    corpo: { status: 'cancelled' }, timeoutMs, acao: `cancelar o pagamento ${texto}`,
  });
  return conferirPagamento(resposta, `cancelar o pagamento ${texto}`);
}

const RECUSAS = {
  cc_rejected_bad_filled_card_number: 'Confira o número do cartão.',
  cc_rejected_bad_filled_date: 'Confira a validade do cartão.',
  cc_rejected_bad_filled_security_code: 'Confira o código de segurança do cartão.',
  cc_rejected_bad_filled_other: 'Confira os dados do cartão.',
  cc_rejected_call_for_authorize: 'O banco do cartão pediu autorização. Ligue para o banco, libere o pagamento e tente de novo.',
  cc_rejected_card_disabled: 'O cartão não está ativo. Ligue para o banco ou use outro cartão.',
  cc_rejected_insufficient_amount: 'O cartão não tem limite suficiente. Use outro cartão ou pague com Pix.',
  cc_rejected_duplicated_payment: 'Um pagamento igual acabou de ser feito. Para pagar de novo, use outro cartão ou o Pix.',
  cc_rejected_max_attempts: 'Limite de tentativas com este cartão. Use outro cartão ou pague com Pix.',
  cc_rejected_invalid_installments: 'O cartão não aceita esse número de parcelas. Escolha outra opção.',
  cc_rejected_card_type_not_allowed: 'Este cartão não é aceito. Use outro cartão.',
};
const RECUSA_PADRAO = 'O pagamento foi recusado. Use outro cartão ou pague com Pix.';

/** Motivo da recusa do cartão em português (padrão genérico para os demais códigos). */
export function mensagemDaRecusa(statusDetail) {
  return RECUSAS[String(statusDetail ?? '')] || RECUSA_PADRAO;
}

function dataValida(valor) {
  return typeof valor === 'string' && Number.isFinite(Date.parse(valor)) ? valor : null;
}

// Link do boleto: https (o Mercado Pago falso dos testes e do desenvolvimento responde em http://127.0.0.1).
function urlDoBoleto(valor) {
  if (typeof valor !== 'string') return null;
  try {
    const u = new URL(valor.trim());
    const local = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    return u.protocol === 'https:' || local ? u.href : null;
  } catch {
    return null;
  }
}

const textoSeguro = (valor, max) => (typeof valor === 'string' && valor.trim() && valor.length <= max
  && !/[\u0000-\u001f\u007f]/.test(valor) ? valor.trim() : null);

/** Só o que a página do pedido precisa de um pagamento (ver o cabeçalho do arquivo). */
export function resumoDoPagamento(pagamento) {
  if (!ehObjeto(pagamento)) return null;
  const tipo = String(pagamento.payment_type_id ?? '');
  const meio = String(pagamento.payment_method_id ?? '');
  let metodo = 'outro';
  if (meio === 'pix' || tipo === 'bank_transfer') metodo = 'pix';
  else if (tipo === 'ticket') metodo = 'boleto';
  else if (/_card$/.test(tipo)) metodo = 'cartao';

  const resumo = {
    id: String(pagamento.id ?? ''),
    status: String(pagamento.status ?? ''),
    status_detail: String(pagamento.status_detail ?? ''),
    metodo,
    expira_em: dataValida(pagamento.date_of_expiration),
  };
  if (metodo === 'pix') {
    const dados = ehObjeto(pagamento.point_of_interaction) && ehObjeto(pagamento.point_of_interaction.transaction_data)
      ? pagamento.point_of_interaction.transaction_data : {};
    const codigo = textoSeguro(dados.qr_code, 2_000);
    const imagem = typeof dados.qr_code_base64 === 'string' && dados.qr_code_base64.length <= LIMITE_QR
      && /^[A-Za-z0-9+/]+={0,2}$/.test(dados.qr_code_base64) ? dados.qr_code_base64 : null;
    if (codigo) resumo.pix = { qr_code: codigo, qr_code_base64: imagem };
  } else if (metodo === 'boleto') {
    const detalhes = ehObjeto(pagamento.transaction_details) ? pagamento.transaction_details : {};
    const barras = ehObjeto(pagamento.barcode) ? pagamento.barcode : (ehObjeto(detalhes.barcode) ? detalhes.barcode : {});
    const url = urlDoBoleto(detalhes.external_resource_url);
    const linha = textoSeguro(detalhes.digitable_line, 200) || textoSeguro(barras.content, 200);
    if (url || linha) resumo.boleto = { url, linha_digitavel: linha };
  }
  if (resumo.status === 'rejected') resumo.mensagem = mensagemDaRecusa(resumo.status_detail);
  return resumo;
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
