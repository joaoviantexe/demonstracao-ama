/**
 * Mercado Pago falso para testes e desenvolvimento (docs/ARQUITETURA.md §6.0). Sem dependências.
 *
 *   const mp = await iniciar({ porta = 0, segredo = 'segredo-teste', webhookUrl, token, unidadeTs = 'ms' })
 *   → { url, fechar(), estado }
 *
 * Use url como MP_API_BASE. Rotas:
 * - POST /checkout/preferences   exige "Authorization: Bearer <qualquer token>" (ou exatamente `token`, se
 *     informado); valida items (title, quantity inteiro >= 1, unit_price > 0 com no máximo 2 casas,
 *     currency_id BRL), statement_descriptor <= 13, installments 1–36, notification_url https pública,
 *     auto_return só com back_urls.success https pública (como o MP real); back_urls http são aceitas
 *     (desenvolvimento). Guarda e devolve 201 com id e init_point = <url>/pagar/<pref_id>.
 *     Repetir o X-Idempotency-Key devolve a mesma preferência.
 * - GET  /checkout/preferences/:id
 * - GET  /v1/payments/:id        404 se não existe
 * - GET  /v1/payments/search?external_reference=…   { paging: { total, limit, offset }, results } (mais recente primeiro)
 * - GET  /pagar/:pref_id         página HTML com os itens, o total e os botões Aprovar, Pendente e Recusar
 * - POST|GET /pagar/:pref_id/(aprovar|pendente|recusar)
 *     cria o pagamento, envia o webhook assinado (POST <destino>?data.id=<id>&type=payment, corpo
 *     { type:'payment', action:'payment.created', data:{ id } }, cabeçalhos x-signature "ts=…,v1=…" e
 *     x-request-id) para a notification_url da preferência ou, sem ela, para estado.webhookUrl; espera a
 *     resposta (até 10 s) e redireciona (302) para back_urls.success|pending|failure com payment_id,
 *     collection_id, status, collection_status, external_reference, preference_id, payment_type…
 * - GET  /sandbox/:pref_id       410 (sandbox_init_point não deve ser usado)
 *
 * estado:
 * - preferencias: Map<id, preferência>; pagamentos: Map<id (string), pagamento>
 * - webhooks: [{ url, cabecalhos, corpo, pagamento_id, action, status, resposta, erro }]
 * - requisicoes: [{ metodo, caminho, cabecalhos }] (todas as chamadas recebidas)
 * - webhookUrl: destino quando a preferência não tem notification_url (pode mudar a qualquer momento)
 * - segredo, token
 * - falhas: { preferencias, pagamentos, busca } — um status HTTP (ex.: 500) faz a rota responder esse erro
 * - ultimaPreferencia() → preferência | null
 * - pagar(prefId, 'aprovar'|'pendente'|'recusar', extras?) → Promise<{ pagamento, webhook, redirecionar }>
 * - alterarStatus(paymentId, status, extras?) → Promise<{ pagamento, webhook }> (ex.: 'refunded'; reenvia o webhook)
 * - aprovarPagamento(paymentId) → alterarStatus(paymentId, 'approved')
 * - adicionarPagamento(dados) → pagamento (sem webhook; para montar cenários)
 * - enviarWebhook(paymentId, action = 'payment.updated') → Promise<registro>
 * - limpar() → apaga preferências, pagamentos, webhooks e requisições
 *
 * Também exporta assinarNotificacao({ dataId, xRequestId, ts, segredo }) → "ts=…,v1=…" (implementação
 * independente de lib/mercadopago.js, para os testes do webhook).
 */

import http from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';

const COLETOR = '1234567890';
const LIMITE_CORPO = 1_000_000;
const TIMEOUT_WEBHOOK_MS = 10_000;

const DETALHE_PADRAO = {
  approved: 'accredited',
  authorized: 'pending_capture',
  pending: 'pending_waiting_transfer',
  in_process: 'pending_contingency',
  in_mediation: 'in_process',
  rejected: 'cc_rejected_other_reason',
  cancelled: 'expired',
  refunded: 'refunded',
  charged_back: 'settled',
};

const ACOES = {
  aprovar: { status: 'approved', status_detail: 'accredited', payment_type_id: 'credit_card', payment_method_id: 'master' },
  pendente: { status: 'pending', status_detail: 'pending_waiting_transfer', payment_type_id: 'bank_transfer', payment_method_id: 'pix' },
  recusar: { status: 'rejected', status_detail: 'cc_rejected_other_reason', payment_type_id: 'credit_card', payment_method_id: 'visa' },
};

/** x-signature "ts=…,v1=…" para o manifesto id:<dataId>;request-id:<xRequestId>;ts:<ts>; (partes vazias omitidas). */
export function assinarNotificacao({ dataId, xRequestId, ts, segredo = 'segredo-teste' } = {}) {
  let manifesto = '';
  if (dataId !== undefined && dataId !== null && String(dataId) !== '') manifesto += `id:${dataId};`;
  if (xRequestId !== undefined && xRequestId !== null && String(xRequestId) !== '') manifesto += `request-id:${xRequestId};`;
  manifesto += `ts:${ts};`;
  const v1 = createHmac('sha256', segredo).update(manifesto).digest('hex');
  return `ts=${ts},v1=${v1}`;
}

const escapar = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function reais(centavos) {
  const sinal = centavos < 0 ? '-' : '';
  const abs = Math.abs(centavos);
  const inteiro = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sinal}R$ ${inteiro},${String(abs % 100).padStart(2, '0')}`;
}

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function urlPublicaHttps(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return !(host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host) || host === '0.0.0.0');
  } catch {
    return false;
  }
}

const centavosDoItem = (item) => Math.round(item.unit_price * 100) * item.quantity;

function validarPreferencia(corpo) {
  const erros = [];
  if (!ehObjeto(corpo)) return ['corpo inválido'];
  if (!Array.isArray(corpo.items) || corpo.items.length === 0) erros.push('items obrigatório');
  for (const [i, item] of (Array.isArray(corpo.items) ? corpo.items : []).entries()) {
    if (!ehObjeto(item)) { erros.push(`items[${i}] inválido`); continue; }
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 256) erros.push(`items[${i}].title inválido`);
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) erros.push(`items[${i}].quantity inválido`);
    const preco = item.unit_price;
    if (typeof preco !== 'number' || !Number.isFinite(preco) || preco <= 0 || Math.round(preco * 100) / 100 !== preco) {
      erros.push(`items[${i}].unit_price invalid`);
    }
    if (item.currency_id !== undefined && item.currency_id !== 'BRL') erros.push(`items[${i}].currency_id inválido`);
  }
  if (corpo.statement_descriptor !== undefined
    && (typeof corpo.statement_descriptor !== 'string' || corpo.statement_descriptor.length > 13)) {
    erros.push('statement_descriptor com mais de 13 caracteres');
  }
  const parcelas = corpo.payment_methods && corpo.payment_methods.installments;
  if (parcelas !== undefined && (!Number.isSafeInteger(parcelas) || parcelas < 1 || parcelas > 36)) erros.push('installments inválido');
  if (corpo.notification_url !== undefined && !urlPublicaHttps(corpo.notification_url)) erros.push('notification_url precisa ser https pública');
  if (corpo.auto_return !== undefined) {
    const sucesso = corpo.back_urls && corpo.back_urls.success;
    if (!sucesso) erros.push('auto_return invalid. back_url.success must be defined');
    else if (!urlPublicaHttps(sucesso)) erros.push('invalid_back_urls: auto_return exige back_urls.success https pública');
  }
  if (corpo.external_reference !== undefined && String(corpo.external_reference).length > 256) erros.push('external_reference longo demais');
  return erros;
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on('data', (parte) => {
      total += parte.length;
      if (total <= LIMITE_CORPO) partes.push(parte);
    });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, objeto, cabecalhos = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...cabecalhos });
  res.end(JSON.stringify(objeto));
}

function erroMp(res, status, mensagem, erro = 'bad_request') {
  json(res, status, { message: mensagem, error: erro, status, cause: [] });
}

function paginaPagamento(pref) {
  const total = pref.items.reduce((soma, item) => soma + centavosDoItem(item), 0);
  const linhas = pref.items.map((item) => `<tr><td>${escapar(item.title)}</td><td>${item.quantity} × ${escapar(reais(Math.round(item.unit_price * 100)))}</td><td>${escapar(reais(centavosDoItem(item)))}</td></tr>`).join('');
  const base = `/pagar/${encodeURIComponent(pref.id)}`;
  const botao = (acao, rotulo, cor) => `<form method="post" action="${base}/${acao}"><button type="submit" style="background:${cor}">${rotulo}</button></form>`;
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mercado Pago (simulado)</title>
<style>
body{font-family:system-ui,sans-serif;background:#f5f5f5;margin:0;padding:24px;color:#222}
main{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;box-shadow:0 4px 18px rgba(0,0,0,.08)}
table{width:100%;border-collapse:collapse;margin:16px 0}td{padding:6px 0;border-bottom:1px solid #eee}
.total{font-size:22px;font-weight:700}.acoes{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}
button{border:0;border-radius:8px;padding:12px 20px;color:#fff;font-size:16px;cursor:pointer}
</style></head>
<body><main>
<h1>Mercado Pago (simulado)</h1>
<p>Pagamento para <strong>${escapar(pref.statement_descriptor || 'loja')}</strong> — referência <code>${escapar(pref.external_reference || '')}</code></p>
<table>${linhas}</table>
<p class="total" data-total-centavos="${total}">Total: ${escapar(reais(total))}</p>
<div class="acoes">
${botao('aprovar', 'Aprovar', '#00a650')}
${botao('pendente', 'Pendente', '#f59e0b')}
${botao('recusar', 'Recusar', '#e11d48')}
</div>
</main></body></html>`;
}

/**
 * Sobe o Mercado Pago falso em 127.0.0.1.
 * @returns {Promise<{ url: string, fechar: () => Promise<void>, estado: object }>}
 */
export async function iniciar({ porta = 0, segredo = 'segredo-teste', webhookUrl = '', token = '', unidadeTs = 'ms' } = {}) {
  let url = '';
  let proximoPagamento = 90_000_001;
  let relogioPagamentos = 0;
  const idempotencia = new Map();

  const estado = {
    preferencias: new Map(),
    pagamentos: new Map(),
    webhooks: [],
    requisicoes: [],
    webhookUrl: webhookUrl || '',
    segredo,
    token,
    falhas: { preferencias: null, pagamentos: null, busca: null },

    ultimaPreferencia() {
      let ultima = null;
      for (const pref of estado.preferencias.values()) ultima = pref;
      return ultima;
    },

    adicionarPagamento(dados = {}) {
      const id = dados.id ?? proximoPagamento++;
      // Datas sempre crescentes, mesmo dentro do mesmo milissegundo.
      relogioPagamentos = Math.max(relogioPagamentos + 1, Date.now());
      const agora = new Date(relogioPagamentos).toISOString();
      const pagamento = {
        id,
        status: 'pending',
        status_detail: 'pending_waiting_transfer',
        transaction_amount: 0,
        transaction_amount_refunded: 0,
        currency_id: 'BRL',
        payment_type_id: 'bank_transfer',
        payment_method_id: 'pix',
        external_reference: null,
        date_created: agora,
        date_last_updated: agora,
        date_approved: null,
        installments: 1,
        live_mode: false,
        statement_descriptor: 'AMA',
        payer: { email: null },
        metadata: {},
        refunds: [],
        ...dados,
      };
      if (pagamento.status === 'approved' && !pagamento.date_approved) pagamento.date_approved = agora;
      estado.pagamentos.set(String(id), pagamento);
      return pagamento;
    },

    async enviarWebhook(paymentId, action = 'payment.updated') {
      const pagamento = estado.pagamentos.get(String(paymentId));
      let pref = pagamento && pagamento.__preferencia ? estado.preferencias.get(pagamento.__preferencia) : null;
      if (pagamento && !pref && pagamento.external_reference) {
        // Pagamento montado com adicionarPagamento: usa a última preferência do mesmo pedido.
        for (const candidata of estado.preferencias.values()) {
          if (String(candidata.external_reference) === String(pagamento.external_reference)) pref = candidata;
        }
      }
      const destino = (pref && pref.notification_url) || estado.webhookUrl;
      const registro = {
        url: null, cabecalhos: null, corpo: null, pagamento_id: String(paymentId), action, status: null, resposta: null, erro: null,
      };
      estado.webhooks.push(registro);
      if (!pagamento) { registro.erro = 'pagamento inexistente'; return registro; }
      if (!destino) { registro.erro = 'sem destino (notification_url ou webhookUrl)'; return registro; }

      const alvo = new URL(destino);
      alvo.searchParams.set('data.id', String(pagamento.id));
      alvo.searchParams.set('type', 'payment');
      const xRequestId = randomUUID();
      const ts = unidadeTs === 's' ? String(Math.floor(Date.now() / 1000)) : String(Date.now());
      const corpo = {
        action,
        api_version: 'v1',
        data: { id: String(pagamento.id) },
        date_created: new Date().toISOString(),
        id: Math.floor(Math.random() * 1e11),
        live_mode: false,
        type: 'payment',
        user_id: Number(COLETOR),
      };
      const cabecalhos = {
        'content-type': 'application/json',
        'x-request-id': xRequestId,
        'x-signature': assinarNotificacao({ dataId: String(pagamento.id), xRequestId, ts, segredo: estado.segredo }),
      };
      Object.assign(registro, { url: alvo.href, cabecalhos, corpo });

      const controle = new AbortController();
      const relogio = setTimeout(() => controle.abort(), TIMEOUT_WEBHOOK_MS);
      try {
        const resposta = await fetch(alvo, {
          method: 'POST', headers: cabecalhos, body: JSON.stringify(corpo), signal: controle.signal,
        });
        registro.status = resposta.status;
        registro.resposta = await resposta.text();
      } catch (erro) {
        registro.erro = controle.signal.aborted ? 'tempo esgotado' : String(erro && erro.message ? erro.message : erro);
      } finally {
        clearTimeout(relogio);
      }
      return registro;
    },

    async pagar(prefId, acao, extras = {}) {
      const pref = estado.preferencias.get(String(prefId));
      if (!pref) throw new Error(`preferência inexistente: ${prefId}`);
      const modelo = ACOES[acao];
      if (!modelo) throw new Error(`ação inválida: ${acao}`);
      const centavos = pref.items.reduce((soma, item) => soma + centavosDoItem(item), 0);
      const pagamento = estado.adicionarPagamento({
        ...modelo,
        transaction_amount: centavos / 100,
        external_reference: pref.external_reference ?? null,
        description: pref.items[0] ? pref.items[0].title : '',
        installments: 1,
        payer: { email: (pref.payer && pref.payer.email) || null, identification: (pref.payer && pref.payer.identification) || null },
        order: { id: Math.floor(Math.random() * 1e10), type: 'mercadopago' },
        ...extras,
      });
      Object.defineProperty(pagamento, '__preferencia', { value: pref.id, enumerable: false });
      const webhook = await estado.enviarWebhook(pagamento.id, 'payment.created');
      return { pagamento, webhook, redirecionar: urlDeRetorno(pref, pagamento) };
    },

    async alterarStatus(paymentId, status, extras = {}) {
      const pagamento = estado.pagamentos.get(String(paymentId));
      if (!pagamento) throw new Error(`pagamento inexistente: ${paymentId}`);
      const agora = new Date().toISOString();
      pagamento.status = status;
      pagamento.status_detail = extras.status_detail ?? DETALHE_PADRAO[status] ?? '';
      pagamento.date_last_updated = agora;
      if ((status === 'approved' || status === 'authorized') && !pagamento.date_approved) pagamento.date_approved = agora;
      if (status === 'refunded' || status === 'charged_back') {
        pagamento.transaction_amount_refunded = pagamento.transaction_amount;
        pagamento.refunds = [{ id: Math.floor(Math.random() * 1e10), amount: pagamento.transaction_amount, date_created: agora }];
      }
      Object.assign(pagamento, extras);
      const webhook = await estado.enviarWebhook(pagamento.id, 'payment.updated');
      return { pagamento, webhook };
    },

    aprovarPagamento(paymentId) {
      return estado.alterarStatus(paymentId, 'approved');
    },

    limpar() {
      estado.preferencias.clear();
      estado.pagamentos.clear();
      estado.webhooks.length = 0;
      estado.requisicoes.length = 0;
      idempotencia.clear();
    },
  };

  function urlDeRetorno(pref, pagamento) {
    const chave = pagamento.status === 'approved' || pagamento.status === 'authorized'
      ? 'success'
      : (pagamento.status === 'pending' || pagamento.status === 'in_process' ? 'pending' : 'failure');
    const destino = pref.back_urls && pref.back_urls[chave];
    if (!destino) return null;
    const alvo = new URL(destino);
    const params = {
      collection_id: String(pagamento.id),
      collection_status: pagamento.status,
      payment_id: String(pagamento.id),
      status: pagamento.status,
      external_reference: pagamento.external_reference ?? 'null',
      payment_type: pagamento.payment_type_id,
      merchant_order_id: String(pagamento.order ? pagamento.order.id : ''),
      preference_id: pref.id,
      site_id: 'MLB',
      processing_mode: 'aggregator',
      merchant_account_id: 'null',
    };
    for (const [nome, valor] of Object.entries(params)) alvo.searchParams.set(nome, valor);
    return alvo.href;
  }

  function autorizado(req) {
    const valor = String(req.headers.authorization || '');
    const achado = /^Bearer\s+(\S+)$/i.exec(valor);
    if (!achado) return false;
    return !estado.token || achado[1] === estado.token;
  }

  async function tratar(req, res) {
    const endereco = new URL(req.url, 'http://localhost');
    const caminho = endereco.pathname.replace(/\/+$/, '') || '/';
    const metodo = req.method.toUpperCase();
    const texto = await lerCorpo(req);
    estado.requisicoes.push({ metodo, caminho: `${endereco.pathname}${endereco.search}`, cabecalhos: { ...req.headers } });

    let m;
    if (caminho === '/checkout/preferences' && metodo === 'POST') {
      if (!autorizado(req)) return erroMp(res, 401, 'invalid access token', 'unauthorized');
      if (estado.falhas.preferencias) return erroMp(res, estado.falhas.preferencias, 'erro simulado', 'internal_error');
      let corpo;
      try {
        corpo = JSON.parse(texto);
      } catch {
        return erroMp(res, 400, 'invalid json');
      }
      const erros = validarPreferencia(corpo);
      if (erros.length) return erroMp(res, 400, erros.join('; '), 'invalid_items');
      const chave = req.headers['x-idempotency-key'];
      if (chave && idempotencia.has(chave)) return json(res, 201, estado.preferencias.get(idempotencia.get(chave)));

      const id = `${COLETOR}-${randomUUID()}`;
      const pref = {
        ...corpo,
        id,
        collector_id: Number(COLETOR),
        client_id: '9876543210',
        site_id: 'MLB',
        operation_type: 'regular_payment',
        date_created: new Date().toISOString(),
        init_point: `${url}/pagar/${encodeURIComponent(id)}`,
        sandbox_init_point: `${url}/sandbox/${encodeURIComponent(id)}`,
      };
      Object.defineProperty(pref, 'cabecalhos', { value: { ...req.headers }, enumerable: false });
      estado.preferencias.set(id, pref);
      if (chave) idempotencia.set(chave, id);
      return json(res, 201, pref);
    }

    if ((m = /^\/checkout\/preferences\/([^/]+)$/.exec(caminho)) && metodo === 'GET') {
      if (!autorizado(req)) return erroMp(res, 401, 'invalid access token', 'unauthorized');
      const pref = estado.preferencias.get(decodeURIComponent(m[1]));
      return pref ? json(res, 200, pref) : erroMp(res, 404, 'preference not found', 'not_found');
    }

    if (caminho === '/v1/payments/search' && metodo === 'GET') {
      if (!autorizado(req)) return erroMp(res, 401, 'invalid access token', 'unauthorized');
      if (estado.falhas.busca) return erroMp(res, estado.falhas.busca, 'erro simulado', 'internal_error');
      const ref = endereco.searchParams.get('external_reference');
      const limite = Math.min(Number(endereco.searchParams.get('limit')) || 30, 50);
      const deslocamento = Number(endereco.searchParams.get('offset')) || 0;
      const crescente = endereco.searchParams.get('criteria') === 'asc';
      let lista = [...estado.pagamentos.values()].filter((p) => ref === null || String(p.external_reference) === ref);
      lista.sort((a, b) => (Date.parse(a.date_created) - Date.parse(b.date_created)) || (Number(a.id) - Number(b.id)));
      if (!crescente) lista.reverse();
      const total = lista.length;
      lista = lista.slice(deslocamento, deslocamento + limite);
      return json(res, 200, { paging: { total, limit: limite, offset: deslocamento }, results: lista });
    }

    if ((m = /^\/v1\/payments\/([^/]+)$/.exec(caminho)) && metodo === 'GET') {
      if (!autorizado(req)) return erroMp(res, 401, 'invalid access token', 'unauthorized');
      if (estado.falhas.pagamentos) return erroMp(res, estado.falhas.pagamentos, 'erro simulado', 'internal_error');
      const pagamento = estado.pagamentos.get(decodeURIComponent(m[1]));
      return pagamento ? json(res, 200, pagamento) : erroMp(res, 404, 'Payment not found', 'not_found');
    }

    if ((m = /^\/pagar\/([^/]+)$/.exec(caminho)) && (metodo === 'GET' || metodo === 'HEAD')) {
      const pref = estado.preferencias.get(decodeURIComponent(m[1]));
      if (!pref) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><title>Não encontrado</title><p>Preferência não encontrada.</p>');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(metodo === 'HEAD' ? undefined : paginaPagamento(pref));
    }

    if ((m = /^\/pagar\/([^/]+)\/(aprovar|pendente|recusar)$/.exec(caminho)) && (metodo === 'POST' || metodo === 'GET')) {
      const prefId = decodeURIComponent(m[1]);
      if (!estado.preferencias.has(prefId)) return erroMp(res, 404, 'preference not found', 'not_found');
      const { pagamento, redirecionar } = await estado.pagar(prefId, m[2]);
      if (redirecionar) {
        res.writeHead(302, { Location: redirecionar, 'Cache-Control': 'no-store' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><title>Pagamento ${escapar(pagamento.status)}</title><p>Pagamento ${escapar(pagamento.id)}: ${escapar(pagamento.status)}</p>`);
    }

    if (/^\/sandbox\//.test(caminho)) {
      res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('sandbox_init_point não existe mais: use init_point.');
    }

    return erroMp(res, 404, `rota inexistente: ${metodo} ${caminho}`, 'not_found');
  }

  const servidor = http.createServer((req, res) => {
    tratar(req, res).catch((erro) => {
      if (!res.headersSent) erroMp(res, 500, String(erro && erro.message ? erro.message : erro), 'internal_error');
      else res.end();
    });
  });
  servidor.keepAliveTimeout = 1_000;

  await new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(porta, '127.0.0.1', () => {
      servidor.off('error', reject);
      resolve();
    });
  });
  url = `http://127.0.0.1:${servidor.address().port}`;

  return {
    url,
    estado,
    fechar() {
      return new Promise((resolve) => {
        servidor.close(() => resolve());
        servidor.closeAllConnections();
      });
    },
  };
}
