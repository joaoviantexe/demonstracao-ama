// Servidor falso do Melhor Envio para testes (docs/ARQUITETURA.md §6.0; docs/pesquisa-apis.json → melhorenvio).
// Use a `url` devolvida como MELHOR_ENVIO_API_BASE: as rotas ficam sob /api/v2/me, como na API real.
//
// iniciar({ porta = 0 } = {}) → Promise<{ url, fechar(), estado }>
//
// estado:
//   requisicoes: [{ metodo, caminho, query, cabecalhos, corpo }]   (caminho sem o prefixo /api/v2/me)
//   carrinho: string[]               ids ainda no carrinho (pendentes de compra)
//   etiquetas: { [id]: etiqueta }    todas as etiquetas criadas (com status, datas, tracking…)
//   compras: [purchase]
//   saldoCentavos: 50000             saldo da carteira (configurável)
//   token: null                      se definido, só esse Bearer é aceito (senão qualquer um não vazio)
//   atrasoGeracaoMs: 400             geração assíncrona: generated_at aparece no 2º GET /orders/{id} depois do
//                                    generate, ou quando esse tempo passar
//   prazoExtraConta: 0               somado em custom_delivery_time (simula customização da conta)
//   ajustesServicos: { [id]: {…} }   campos mesclados no serviço devolvido (ex.: { 2: { custom_price: 'abc' } })
//   ultimaImpressao: { mode, orders } | null
//   forcar(caminho, { status = 500, corpo, bruto, cabecalhos, vezes = 1, atrasoMs = 0 })
//       as próximas `vezes` requisições para `caminho` ('/shipment/calculate', '/balance'… ou '*')
//       recebem essa resposta (corpo JSON ou texto `bruto`). Use para simular 500, 429, lentidão etc.
//   reiniciar()                      limpa requisições, carrinho, etiquetas, compras e respostas forçadas
//
// Rotas: POST /shipment/calculate (products OU volumes; serviços 1 PAC, 2 SEDEX e 17 Mini Envios com price
// em STRING), POST /cart (uma etiqueta; Correios recusam vários volumes), GET|DELETE /cart/{id}, GET /cart,
// POST /shipment/checkout (debita o saldo), POST /shipment/generate (assíncrono), POST /shipment/print
// (url só com todas geradas), GET /orders/{id}, POST /shipment/tracking, POST /shipment/cancel, GET /balance, GET /.
// Sem "Authorization: Bearer …" → 401 Unauthenticated; sem User-Agent "Nome (contato)" → 400.

import http from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';

const PREFIXO = '/api/v2/me';

const CORREIOS = { id: 1, name: 'Correios', picture: 'https://example.invalid/correios.png' };
const MINIMOS = { height: 1, width: 8, length: 13 };

const SERVICOS = {
  1: {
    id: 1, name: 'PAC', company: CORREIOS, baseCentavos: 1850, porKgCentavos: 410, prazo: 8,
    maxKg: 30, maxLado: 100, maxSoma: 200,
  },
  2: {
    id: 2, name: 'SEDEX', company: CORREIOS, baseCentavos: 2990, porKgCentavos: 750, prazo: 3,
    maxKg: 30, maxLado: 100, maxSoma: 200,
  },
  17: {
    id: 17, name: 'Mini Envios', company: CORREIOS, baseCentavos: 1240, porKgCentavos: 0, prazo: 10,
    maxKg: 0.3, maxDims: { height: 4, width: 16, length: 24 }, maxSeguroCentavos: 11670, unico: true,
  },
};
const VOLUME_UNICO = [1, 2, 17];

const reais = (centavos) => (centavos / 100).toFixed(2);
const agora = () => new Date().toISOString();
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const numeroPositivo = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

function enviar(res, status, corpo, cabecalhos = {}) {
  if (res.writableEnded || res.destroyed) return;
  const texto = typeof corpo === 'string' ? corpo : JSON.stringify(corpo);
  res.writeHead(status, {
    'Content-Type': typeof corpo === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    ...cabecalhos,
  });
  res.end(texto);
}

const invalido = (res, errors, message = 'The given data was invalid.') => enviar(res, 422, { message, errors });

function lerCorpo(req) {
  return new Promise((resolve) => {
    const partes = [];
    req.on('data', (p) => partes.push(p));
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

// Unidades → pacotes (empilha alturas; abre outro pacote ao passar do peso ou da altura máxima).
function empacotar(unidades, servico) {
  const pacotes = [];
  let atual = null;
  for (const u of unidades) {
    const limiteAltura = servico.maxDims ? servico.maxDims.height : servico.maxLado;
    if (!atual || atual.weight + u.weight > servico.maxKg + 1e-9 || atual.height + u.height > limiteAltura) {
      if (servico.unico && atual) return null;
      atual = { height: 0, width: 0, length: 0, weight: 0, seguroCentavos: 0, produtos: new Map() };
      pacotes.push(atual);
    }
    atual.height += u.height;
    atual.width = Math.max(atual.width, u.width);
    atual.length = Math.max(atual.length, u.length);
    atual.weight += u.weight;
    atual.seguroCentavos += u.seguroCentavos;
    if (u.id !== undefined) atual.produtos.set(u.id, (atual.produtos.get(u.id) || 0) + 1);
  }
  return pacotes;
}

// Problema de um volume para o serviço, ou null.
function problemaDoVolume(v, servico) {
  if (v.height < MINIMOS.height || v.width < MINIMOS.width || v.length < MINIMOS.length) {
    return `Dimensões abaixo do mínimo dos Correios (${MINIMOS.height} x ${MINIMOS.width} x ${MINIMOS.length} cm).`;
  }
  if (v.weight > servico.maxKg + 1e-9) return 'Peso excede o limite do serviço.';
  if (servico.maxDims) {
    const d = servico.maxDims;
    if (v.height > d.height || v.width > d.width || v.length > d.length) return 'Dimensões excedem o limite do serviço.';
  } else if (Math.max(v.height, v.width, v.length) > servico.maxLado || v.height + v.width + v.length > servico.maxSoma) {
    return 'Dimensões excedem o limite do serviço.';
  }
  if (servico.maxSeguroCentavos && v.seguroCentavos > servico.maxSeguroCentavos) return 'Valor segurado acima do limite do serviço.';
  return null;
}

const precoPacote = (p, servico) => servico.baseCentavos
  + servico.porKgCentavos * Math.max(1, Math.ceil(p.weight - 1e-9))
  + Math.round(p.seguroCentavos * 0.01);

function cotarServico(servico, unidades, volumes, estado) {
  let pacotes;
  if (volumes) {
    pacotes = volumes.map((v) => ({ ...v, produtos: new Map() }));
    if (servico.unico && pacotes.length > 1) return { id: servico.id, name: servico.name, error: 'Serviço aceita um único volume.' };
  } else {
    for (const u of unidades) {
      const problema = problemaDoVolume(u, servico);
      if (problema) return { id: servico.id, name: servico.name, error: problema };
    }
    pacotes = empacotar(unidades, servico);
    if (!pacotes) return { id: servico.id, name: servico.name, error: 'Os produtos não cabem em um pacote deste serviço.' };
  }
  for (const p of pacotes) {
    const problema = problemaDoVolume(p, servico);
    if (problema) return { id: servico.id, name: servico.name, error: problema };
  }
  const precos = pacotes.map((p) => precoPacote(p, servico));
  const total = precos.reduce((a, b) => a + b, 0);
  const prazo = servico.prazo;
  const resposta = {
    id: servico.id,
    name: servico.name,
    price: reais(total),
    custom_price: reais(total),
    discount: '0.00',
    currency: 'R$',
    delivery_time: prazo,
    delivery_range: { min: prazo - 1, max: prazo },
    custom_delivery_time: prazo + estado.prazoExtraConta,
    custom_delivery_range: { min: prazo - 1 + estado.prazoExtraConta, max: prazo + estado.prazoExtraConta },
    packages: pacotes.map((p, i) => ({
      price: reais(precos[i]),
      discount: '0.00',
      format: 'box',
      dimensions: { height: Math.ceil(p.height), width: Math.ceil(p.width), length: Math.ceil(p.length) },
      weight: p.weight.toFixed(2),
      insurance_value: reais(p.seguroCentavos),
      products: [...p.produtos].map(([id, quantity]) => ({ id, quantity })),
    })),
    additional_services: { receipt: false, own_hand: false, collect: false },
    company: { ...servico.company },
  };
  return { ...resposta, ...(estado.ajustesServicos[servico.id] || {}) };
}

function rotaCalcular(corpo, res, estado) {
  const erros = {};
  for (const lado of ['from', 'to']) {
    const cep = ehObjeto(corpo[lado]) ? corpo[lado].postal_code : undefined;
    if (typeof cep !== 'string' || !/^\d{8}$/.test(cep)) erros[`${lado}.postal_code`] = [`O campo ${lado}.postal_code deve ter 8 dígitos.`];
  }
  const temProdutos = corpo.products !== undefined;
  const temVolumes = corpo.volumes !== undefined;
  if (temProdutos && temVolumes) erros.products = ['Envie products ou volumes, não os dois.'];
  if (!temProdutos && !temVolumes) erros.products = ['Informe products ou volumes.'];
  if (corpo.services !== undefined && typeof corpo.services !== 'string') erros.services = ['services deve ser uma string separada por vírgulas.'];

  let unidades = null;
  let volumes = null;
  if (temProdutos && !temVolumes) {
    if (!Array.isArray(corpo.products) || !corpo.products.length) erros.products = ['products deve ser uma lista.'];
    else {
      unidades = [];
      corpo.products.forEach((p, i) => {
        if (!ehObjeto(p) || !['width', 'height', 'length', 'weight'].every((k) => numeroPositivo(p[k]))
          || !Number.isInteger(p.quantity) || p.quantity < 1) {
          erros[`products.${i}`] = ['Produto sem dimensões, peso ou quantidade válidos.'];
          return;
        }
        const seguro = Math.round((Number(p.insurance_value) || 0) * 100);
        for (let q = 0; q < p.quantity; q += 1) {
          unidades.push({ id: p.id, width: p.width, height: p.height, length: p.length, weight: p.weight, seguroCentavos: seguro });
        }
      });
    }
  } else if (temVolumes && !temProdutos) {
    const lista = Array.isArray(corpo.volumes) ? corpo.volumes : [corpo.volumes];
    volumes = [];
    lista.forEach((v, i) => {
      if (!ehObjeto(v) || !['width', 'height', 'length', 'weight'].every((k) => numeroPositivo(v[k]))) {
        erros[`volumes.${i}`] = ['Volume sem dimensões ou peso válidos.'];
        return;
      }
      volumes.push({ width: v.width, height: v.height, length: v.length, weight: v.weight, seguroCentavos: Math.round((Number(v.insurance) || 0) * 100) });
    });
  }
  if (Object.keys(erros).length) return invalido(res, erros);

  const pedidos = typeof corpo.services === 'string' && corpo.services.trim()
    ? corpo.services.split(',').map((s) => Number(s.trim()))
    : Object.keys(SERVICOS).map(Number);
  const resposta = [];
  for (const id of pedidos) {
    const servico = SERVICOS[id];
    if (!servico) {
      resposta.push({ id, name: `Serviço ${id}`, error: 'Serviço indisponível para o trecho.' });
      continue;
    }
    resposta.push(cotarServico(servico, unidades, volumes, estado));
  }
  // A API devolve um objeto quando só um serviço é cotado.
  return enviar(res, 200, resposta.length === 1 ? resposta[0] : resposta);
}

function validarPessoa(pessoa, lado, erros, exigirDocumento) {
  if (!ehObjeto(pessoa)) {
    erros[lado] = [`O campo ${lado} é obrigatório.`];
    return;
  }
  if (typeof pessoa.postal_code !== 'string' || !/^\d{8}$/.test(pessoa.postal_code)) erros[`${lado}.postal_code`] = ['CEP deve ter 8 dígitos.'];
  if (!pessoa.name) erros[`${lado}.name`] = ['O nome é obrigatório.'];
  if (exigirDocumento && !pessoa.document && !pessoa.company_document) erros[`${lado}.document`] = ['CPF ou CNPJ é obrigatório nos Correios.'];
  if (pessoa.phone !== undefined && !/^\d*$/.test(String(pessoa.phone))) erros[`${lado}.phone`] = ['Telefone só com dígitos.'];
}

function rotaCarrinho(corpo, res, estado) {
  const erros = {};
  if (typeof corpo.service !== 'number' || !Number.isInteger(corpo.service)) erros.service = ['O serviço deve ser um número inteiro.'];
  const servico = SERVICOS[corpo.service];
  if (!erros.service && !servico) erros.service = ['Serviço inexistente.'];
  const correios = VOLUME_UNICO.includes(corpo.service);
  validarPessoa(corpo.from, 'from', erros, correios);
  validarPessoa(corpo.to, 'to', erros, correios);
  if (!Array.isArray(corpo.products) || !corpo.products.length) erros.products = ['Informe os produtos (declaração de conteúdo).'];
  const volumes = Array.isArray(corpo.volumes) ? corpo.volumes : corpo.volumes ? [corpo.volumes] : [];
  if (!volumes.length) erros.volumes = ['Informe o volume.'];
  if (Object.keys(erros).length) return invalido(res, erros);
  if (correios && volumes.length > 1) {
    return invalido(res, { volumes: ['Correios não aceitam vários volumes na mesma etiqueta.'] }, 'Correios não aceitam vários volumes na mesma etiqueta.');
  }
  const v = volumes[0];
  if (!['width', 'height', 'length', 'weight'].every((k) => numeroPositivo(v[k]))) {
    return invalido(res, { volumes: ['Volume sem dimensões ou peso válidos.'] });
  }
  const seguro = Math.round((Number(ehObjeto(corpo.options) ? corpo.options.insurance_value : 0) || 0) * 100);
  const volume = { width: v.width, height: v.height, length: v.length, weight: v.weight, seguroCentavos: seguro };
  const problema = problemaDoVolume(volume, servico);
  if (problema) return invalido(res, { volumes: [problema] }, problema);

  const precoCentavos = precoPacote(volume, servico);
  const id = randomUUID();
  const etiqueta = {
    id,
    protocol: `ORD-${new Date().getFullYear()}${String(randomInt(1e8)).padStart(8, '0')}`,
    service_id: servico.id,
    agency_id: corpo.agency ?? null,
    price: precoCentavos / 100,
    discount: 0,
    insurance_value: seguro / 100,
    status: 'pending',
    tracking: null,
    self_tracking: `ME${String(randomInt(1e10)).padStart(10, '0')}`,
    from: corpo.from,
    to: corpo.to,
    products: corpo.products,
    volumes,
    options: corpo.options || {},
    created_at: agora(),
    paid_at: null,
    generated_at: null,
    posted_at: null,
    delivered_at: null,
    canceled_at: null,
    expired_at: null,
  };
  Object.defineProperty(etiqueta, 'geracao', { value: null, writable: true, enumerable: false });
  estado.etiquetas[id] = etiqueta;
  estado.carrinho.push(id);
  return enviar(res, 201, etiqueta);
}

function listaOrders(corpo) {
  return Array.isArray(corpo.orders) ? corpo.orders.filter((o) => typeof o === 'string' && o) : [];
}

function rotaCheckout(corpo, res, estado) {
  const orders = listaOrders(corpo);
  if (!orders.length) return invalido(res, { orders: ['Informe as etiquetas.'] });
  for (const id of orders) {
    if (!estado.carrinho.includes(id)) return invalido(res, { orders: [`A etiqueta ${id} não está no carrinho.`] }, `A etiqueta ${id} não está no carrinho.`);
  }
  const totalCentavos = orders.reduce((soma, id) => soma + Math.round(estado.etiquetas[id].price * 100), 0);
  if (estado.saldoCentavos < totalCentavos) {
    return invalido(res, { wallet: ['Saldo insuficiente na carteira para esta compra.'] }, 'Saldo insuficiente.');
  }
  estado.saldoCentavos -= totalCentavos;
  const pagoEm = agora();
  for (const id of orders) {
    Object.assign(estado.etiquetas[id], { status: 'released', paid_at: pagoEm });
  }
  estado.carrinho = estado.carrinho.filter((id) => !orders.includes(id));
  const purchase = {
    id: randomUUID(),
    protocol: `PUR-${new Date().getFullYear()}${String(randomInt(1e8)).padStart(8, '0')}`,
    total: totalCentavos / 100,
    discount: 0,
    status: 'paid',
    paid_at: pagoEm,
    orders: orders.map((id) => {
      const e = estado.etiquetas[id];
      return { id, protocol: e.protocol, service_id: e.service_id, self_tracking: e.self_tracking, status: e.status };
    }),
  };
  estado.compras.push(purchase);
  return enviar(res, 200, { purchase });
}

// Conclui a geração quando o atraso passou ou (em consulta) quando já houve um GET anterior.
function atualizarGeracao(etiqueta, estado, { consulta = false } = {}) {
  if (!etiqueta.geracao || etiqueta.generated_at) return;
  const passou = Date.now() - etiqueta.geracao.pedidaEm >= estado.atrasoGeracaoMs;
  if (passou || (consulta && etiqueta.geracao.consultas >= 1)) {
    etiqueta.generated_at = agora();
    etiqueta.tracking = `AM${String(randomInt(1e9)).padStart(9, '0')}BR`;
    return;
  }
  if (consulta) etiqueta.geracao.consultas += 1;
}

function rotaGerar(corpo, res, estado) {
  const orders = listaOrders(corpo);
  if (!orders.length) return invalido(res, { orders: ['Informe as etiquetas.'] });
  const resposta = {};
  for (const id of orders) {
    const e = estado.etiquetas[id];
    if (!e) resposta[id] = { status: false, message: 'Etiqueta não encontrada.' };
    else if (!e.paid_at) resposta[id] = { status: false, message: 'A etiqueta ainda não foi paga.' };
    else if (e.geracao || e.generated_at) resposta[id] = { status: false, message: 'O envio já está gerado.' };
    else {
      e.geracao = { pedidaEm: Date.now(), consultas: 0 };
      resposta[id] = { status: true, message: 'Envio gerado com sucesso.' };
    }
  }
  return enviar(res, 200, resposta);
}

function rotaImprimir(corpo, res, estado, baseUrl) {
  const orders = listaOrders(corpo);
  if (!orders.length) return invalido(res, { orders: ['Informe as etiquetas.'] });
  for (const id of orders) {
    const e = estado.etiquetas[id];
    if (e) atualizarGeracao(e, estado);
    if (!e || !e.generated_at) {
      return invalido(res, { orders: [`A etiqueta ${id} ainda não foi gerada.`] }, 'Existem etiquetas que ainda não foram geradas.');
    }
  }
  estado.ultimaImpressao = { mode: corpo.mode ?? null, orders };
  return enviar(res, 200, { url: `${baseUrl}/imprimir/${randomUUID()}` });
}

function rotaRastrear(corpo, res, estado) {
  const orders = listaOrders(corpo);
  if (!orders.length) return invalido(res, { orders: ['Informe as etiquetas.'] });
  const resposta = {};
  for (const id of orders) {
    const e = estado.etiquetas[id];
    if (!e) continue;
    atualizarGeracao(e, estado);
    resposta[id] = {
      id,
      protocol: e.protocol,
      status: e.status,
      tracking: e.tracking,
      melhorenvio_tracking: e.self_tracking,
      created_at: e.created_at,
      paid_at: e.paid_at,
      generated_at: e.generated_at,
      posted_at: e.posted_at,
      delivered_at: e.delivered_at,
      canceled_at: e.canceled_at,
      expired_at: e.expired_at,
    };
  }
  return enviar(res, 200, resposta);
}

function rotaCancelar(corpo, res, estado) {
  const pedido = ehObjeto(corpo.order) ? corpo.order : {};
  const e = estado.etiquetas[pedido.id];
  if (!e) return invalido(res, { 'order.id': ['Etiqueta não encontrada.'] });
  if (pedido.reason_id !== 2) return invalido(res, { 'order.reason_id': ['reason_id deve ser 2.'] });
  if (e.paid_at && !e.canceled_at) estado.saldoCentavos += Math.round(e.price * 100);
  Object.assign(e, { status: 'canceled', canceled_at: e.canceled_at || agora() });
  estado.carrinho = estado.carrinho.filter((id) => id !== e.id);
  return enviar(res, 200, { [e.id]: { canceled: true } });
}

function criarEstado() {
  const estado = {
    requisicoes: [],
    carrinho: [],
    etiquetas: {},
    compras: [],
    saldoCentavos: 50_000,
    token: null,
    atrasoGeracaoMs: 400,
    prazoExtraConta: 0,
    ajustesServicos: {},
    ultimaImpressao: null,
    forcadas: [],
    forcar(caminho, { status = 500, corpo, bruto, cabecalhos = {}, vezes = 1, atrasoMs = 0 } = {}) {
      estado.forcadas.push({
        caminho, status, corpo: corpo === undefined && bruto === undefined ? { message: 'Server Error' } : corpo, bruto, cabecalhos, vezes, atrasoMs,
      });
    },
    reiniciar() {
      estado.requisicoes.length = 0;
      estado.carrinho = [];
      estado.etiquetas = {};
      estado.compras = [];
      estado.forcadas = [];
      estado.ultimaImpressao = null;
      estado.ajustesServicos = {};
      estado.saldoCentavos = 50_000;
      estado.prazoExtraConta = 0;
    },
  };
  return estado;
}

/** Sobe o servidor falso em 127.0.0.1. */
export async function iniciar({ porta = 0 } = {}) {
  const estado = criarEstado();
  let baseUrl = '';

  const servidor = http.createServer(async (req, res) => {
    const endereco = new URL(req.url, 'http://127.0.0.1');
    const texto = await lerCorpo(req);

    if (req.method === 'GET' && endereco.pathname.startsWith('/imprimir/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Etiqueta</title><p>Etiqueta de teste do Melhor Envio falso.</p>');
      return;
    }
    if (endereco.pathname !== PREFIXO && !endereco.pathname.startsWith(`${PREFIXO}/`)) {
      enviar(res, 404, { message: 'Not Found' });
      return;
    }
    const caminho = endereco.pathname.slice(PREFIXO.length).replace(/\/+$/, '') || '/';
    let corpo = {};
    let corpoInvalido = false;
    if (texto.trim()) {
      try {
        corpo = JSON.parse(texto);
      } catch {
        corpoInvalido = true;
        corpo = texto;
      }
    }
    estado.requisicoes.push({
      metodo: req.method,
      caminho,
      query: Object.fromEntries(endereco.searchParams),
      cabecalhos: { ...req.headers },
      corpo,
    });

    const autorizacao = String(req.headers.authorization || '');
    const token = /^Bearer\s+(\S+)$/i.exec(autorizacao);
    if (!token || (estado.token !== null && token[1] !== estado.token)) {
      enviar(res, 401, { message: 'Unauthenticated.' });
      return;
    }
    if (!/^\S.*\(\S.*\)\s*$/.test(String(req.headers['user-agent'] || ''))) {
      enviar(res, 400, { message: 'User-Agent obrigatório no formato "Aplicação (email@contato)".' });
      return;
    }

    const indice = estado.forcadas.findIndex((f) => f.caminho === '*' || f.caminho === caminho);
    if (indice >= 0) {
      const f = estado.forcadas[indice];
      f.vezes -= 1;
      if (f.vezes <= 0) estado.forcadas.splice(indice, 1);
      if (f.atrasoMs) await new Promise((r) => { setTimeout(r, f.atrasoMs); });
      enviar(res, f.status, f.bruto !== undefined ? String(f.bruto) : f.corpo, f.cabecalhos);
      return;
    }
    if (corpoInvalido || (texto.trim() && !ehObjeto(corpo))) {
      enviar(res, 400, { message: 'JSON inválido.' });
      return;
    }

    const metodo = req.method;
    const idCarrinho = /^\/cart\/([\w-]+)$/.exec(caminho);
    const idOrdem = /^\/orders\/([\w-]+)$/.exec(caminho);

    if (metodo === 'POST' && caminho === '/shipment/calculate') return rotaCalcular(corpo, res, estado);
    if (metodo === 'POST' && caminho === '/cart') return rotaCarrinho(corpo, res, estado);
    if (metodo === 'GET' && caminho === '/cart') {
      return enviar(res, 200, { data: estado.carrinho.map((id) => estado.etiquetas[id]) });
    }
    if (idCarrinho && metodo === 'GET') {
      const e = estado.carrinho.includes(idCarrinho[1]) ? estado.etiquetas[idCarrinho[1]] : null;
      return e ? enviar(res, 200, e) : enviar(res, 404, { message: 'Not Found' });
    }
    if (idCarrinho && metodo === 'DELETE') {
      if (!estado.carrinho.includes(idCarrinho[1])) return enviar(res, 404, { message: 'Not Found' });
      estado.carrinho = estado.carrinho.filter((id) => id !== idCarrinho[1]);
      delete estado.etiquetas[idCarrinho[1]];
      res.writeHead(204);
      res.end();
      return undefined;
    }
    if (metodo === 'POST' && caminho === '/shipment/checkout') return rotaCheckout(corpo, res, estado);
    if (metodo === 'POST' && caminho === '/shipment/generate') return rotaGerar(corpo, res, estado);
    if (metodo === 'POST' && caminho === '/shipment/print') return rotaImprimir(corpo, res, estado, baseUrl);
    if (metodo === 'POST' && caminho === '/shipment/tracking') return rotaRastrear(corpo, res, estado);
    if (metodo === 'POST' && caminho === '/shipment/cancel') return rotaCancelar(corpo, res, estado);
    if (idOrdem && metodo === 'GET') {
      const e = estado.etiquetas[idOrdem[1]];
      if (!e) return enviar(res, 404, { message: 'Not Found' });
      atualizarGeracao(e, estado, { consulta: true });
      return enviar(res, 200, e);
    }
    if (metodo === 'GET' && caminho === '/balance') {
      return enviar(res, 200, { balance: estado.saldoCentavos / 100, reserved: 0, debts: 0 });
    }
    if (metodo === 'GET' && caminho === '/') {
      return enviar(res, 200, { id: 1, firstname: 'AMA', lastname: 'Teste', email: 'loja@ama.local' });
    }
    return enviar(res, 404, { message: 'Not Found' });
  });

  await new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(porta, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${servidor.address().port}`;

  return {
    url: baseUrl,
    estado,
    fechar() {
      return new Promise((resolve) => {
        servidor.closeAllConnections?.();
        servidor.close(() => resolve());
      });
    },
  };
}
