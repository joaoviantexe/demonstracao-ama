/**
 * Cliente REST do Melhor Envio (docs/ARQUITETURA.md §6.0, §6.2 e §6.6; docs/pesquisa-apis.json → melhorenvio).
 * Só roda no servidor: o token nunca vai para o navegador.
 *
 * Base: obterAmbiente().melhorEnvioApiBase + '/api/v2/me' (produção https://melhorenvio.com.br,
 * sandbox https://sandbox.melhorenvio.com.br; MELHOR_ENVIO_API_BASE nos testes).
 * Cabeçalhos: Accept/Content-Type JSON, Authorization Bearer MELHOR_ENVIO_TOKEN e
 * User-Agent "AMA Loja (<MELHOR_ENVIO_EMAIL>)" (obrigatório na API).
 *
 * Erros (ErroHttp de lib/http.js):
 * - sem MELHOR_ENVIO_TOKEN → 503 'frete_nao_configurado'
 * - HTTP de erro, timeout, rede ou resposta ilegível → 502 'falha_melhor_envio' com mensagem útil e
 *   extra = { status_melhor_envio: number|null, resposta_melhor_envio: '<corpo cru, até 4000 caracteres>' }
 * - 429 → uma nova tentativa após espera curta (Retry-After, no máximo 3 s); se repetir, 502
 * - dados inválidos antes de chamar a API → 400 ('cep_invalido', 'servico_invalido', 'etiqueta_invalida'…)
 *
 * Exportações (todas as funções assíncronas aceitam { timeoutMs } no fim; padrão 15 s):
 * - calcular({ de, para, produtos | volumes, servicos, valorSeguro, opcoes, timeoutMs })
 *     → [{ servico_id, nome, empresa, preco_centavos, prazo_dias, erro, pacotes }]
 *     de/para: CEP (string, número ou { postal_code | cep }).
 *     produtos (preferível): formato da API, dados UNITÁRIOS — [{ id, width, height, length (cm), weight (kg),
 *       insurance_value (reais), quantity }] (ver montarProdutosMelhorEnvio em lib/frete.js).
 *     volumes: [{ width, height, length, weight, insurance? }] — valorSeguro (CENTAVOS, total) preenche
 *       'insurance' (reais) dos volumes que não têm. Com produtos, o seguro vai em insurance_value.
 *     servicos: [1, 2, 17] ou "1,2,17" (opcional: sem ele a API cota todos).
 *     Serviço indisponível vem com erro: 'texto' e preco_centavos null. Preço ilegível ou <= 0 → serviço
 *     descartado (nunca vira frete 0). Usa custom_price/custom_delivery_time quando existem.
 *     pacotes: [{ preco_centavos, peso_kg, altura_cm, largura_cm, comprimento_cm, seguro_centavos, formato,
 *       produtos: [{ id, quantidade }] }]
 * - montarCorpoCotacao(entrada) → corpo JSON do POST /shipment/calculate (puro)
 * - normalizarServicos(resposta) → mesma saída de calcular (puro)
 * - listaServicos([1,'2'] | "1,2") → [1, 2] (puro)
 * - montarItensCarrinho({ servicoId, pacotes, remetente, destinatario, itens, chaveNfe, agencia, tag, urlPedido })
 *     → [corpo do POST /cart], UM por pacote (Correios não aceitam vários volumes por etiqueta). Puro.
 *     remetente = configuracoes.frete.origem; destinatario = destinatarioDoPedido(pedido);
 *     itens = pedido_itens { produto_id, nome, quantidade, preco_unitario_centavos }.
 *     Lança 400 'origem_incompleta' | 'destino_incompleto' | 'documento_obrigatorio' (Correios sem CPF/CNPJ)
 *     | 'chave_nfe_invalida' | 'sem_pacotes' | 'sem_itens'; 422 'pacotes_sem_produtos' | 'pacote_invalido'.
 * - destinatarioDoPedido(pedido) → { nome, documento, telefone, email, cep, logradouro, numero, complemento, bairro, cidade, uf }
 * - adicionarAoCarrinho(dados | dados[]) → { id, protocolo, servico_id, preco_centavos, status, bruto } (ou lista)
 * - comprar(ids, { valorCentavos }) → { compra_id, protocolo, total_centavos, status, ordens, bruto }
 *     Com valorCentavos confere o saldo antes; saldo curto → 409 'saldo_insuficiente'.
 * - gerar(ids) → { [id]: { ok, mensagem } } (a geração é assíncrona: ver aguardarGeracao)
 * - obterEtiqueta(id) → { id, protocolo, status, servico_id, preco_centavos, codigo_rastreio, self_tracking,
 *     gerada, paga, cancelada, generated_at, paid_at, posted_at, delivered_at, canceled_at, expired_at, bruto }
 * - aguardarGeracao(ids, { tentativas = 5, intervaloMs = 1500 }) → { geradas: [id], pendentes: [id], etiquetas: { [id]: … } }
 * - imprimir(ids, { conferirGeracao = true }) → { url } (mode 'public'); etiqueta ainda sem generated_at → 409 'etiqueta_em_geracao'
 * - rastrear(ids) → { [id]: { status, codigo_rastreio, codigo_melhor_envio, url_rastreio, posted_at, delivered_at, bruto } }
 * - saldo() → centavos (inteiro)
 * - cancelar(id, { descricao }) → { cancelada: boolean, bruto }
 * - urlApi() → base com /api/v2/me ; userAgent() → "AMA Loja (email)"
 * - SERVICOS_CORREIOS, SERVICOS_VOLUME_UNICO
 */

import { obterAmbiente } from './ambiente.js';
import { ErroHttp } from './http.js';
import { centavosParaReais, formatarReais, reaisParaCentavos } from './dinheiro.js';
import { normalizarCep } from './cep.js';

const PREFIXO = '/api/v2/me';
const TIMEOUT_PADRAO_MS = 15_000;
const ESPERA_429_PADRAO_MS = 500;
const ESPERA_429_MAX_MS = 3_000;
const LIMITE_CORPO_LOG = 4_000;

export const SERVICOS_CORREIOS = Object.freeze([1, 2, 17]);
// Correios, Jadlog .Package Centralizado (27), Loggi (31, 32) e J&T (33): uma etiqueta por volume.
export const SERVICOS_VOLUME_UNICO = Object.freeze([1, 2, 17, 27, 31, 32, 33]);

// ---------------------------------------------------------------------------
// Infraestrutura

/** URL base da API com o prefixo /api/v2/me. */
export function urlApi() {
  const base = obterAmbiente().melhorEnvioApiBase.replace(/\/+$/, '');
  return base.endsWith(PREFIXO) ? base : `${base}${PREFIXO}`;
}

/** User-Agent exigido pela API: "AMA Loja (<e-mail técnico>)". */
export function userAgent(ambiente = obterAmbiente()) {
  const limpar = (texto) => String(texto || '').replace(/[^\w.@+-]/g, '');
  let contato = limpar(ambiente.melhorEnvioEmail);
  if (!contato) {
    const achado = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(ambiente.emailRemetente || '');
    if (achado) contato = limpar(achado[0]);
  }
  return `AMA Loja (${contato || 'contato'})`;
}

const erroNaoConfigurado = () => new ErroHttp(503, 'frete_nao_configurado',
  'O Melhor Envio não está configurado (falta MELHOR_ENVIO_TOKEN).');

function exigirToken() {
  const ambiente = obterAmbiente();
  if (!ambiente.melhorEnvioToken) throw erroNaoConfigurado();
  return ambiente;
}

const extraErro = (status, texto) => ({
  status_melhor_envio: status ?? null,
  resposta_melhor_envio: String(texto ?? '').slice(0, LIMITE_CORPO_LOG),
});

const falha = (mensagem, status, texto) => new ErroHttp(502, 'falha_melhor_envio', mensagem, extraErro(status, texto));

// Junta message, error e errors de um corpo de erro da API num texto curto.
function detalheDoCorpo(texto) {
  let json;
  try {
    json = JSON.parse(texto);
  } catch {
    const limpo = String(texto || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return limpo.length <= 200 ? limpo : '';
  }
  if (!json || typeof json !== 'object') return '';
  const partes = [];
  const adicionar = (valor, campo) => {
    if (typeof valor !== 'string' || !valor.trim()) return;
    const msg = valor.trim();
    partes.push(campo && !msg.includes(campo) ? `${campo}: ${msg}` : msg);
  };
  adicionar(json.message);
  adicionar(json.error);
  if (json.errors && typeof json.errors === 'object') {
    for (const [campo, lista] of Object.entries(json.errors)) {
      for (const msg of Array.isArray(lista) ? lista : [lista]) adicionar(msg, Array.isArray(json.errors) ? '' : campo);
    }
  }
  return [...new Set(partes)].join(' ').slice(0, 500);
}

function mensagemDeStatus(status) {
  if (status === 401) return 'O token do Melhor Envio é inválido, venceu ou é de outro ambiente (produção x sandbox).';
  if (status === 403) return 'O token do Melhor Envio não tem permissão para esta ação (confira os escopos do token).';
  if (status === 404) return 'O Melhor Envio não encontrou o recurso pedido.';
  if (status === 422 || status === 400) return 'O Melhor Envio recusou os dados enviados.';
  if (status === 429) return 'Muitas requisições ao Melhor Envio. Tente novamente em instantes.';
  if (status >= 500) return `O Melhor Envio está instável no momento (HTTP ${status}).`;
  return `O Melhor Envio respondeu com erro (HTTP ${status}).`;
}

function erroDeResposta(status, texto, acao) {
  const detalhe = detalheDoCorpo(texto);
  const mensagem = `Falha ao ${acao}: ${mensagemDeStatus(status)}${detalhe ? ` Detalhe: ${detalhe}` : ''}`;
  return falha(mensagem, status, texto);
}

function esperaDo429(cabecalhos) {
  const valor = cabecalhos.get('retry-after');
  const segundos = valor === null ? NaN : Number(valor);
  if (Number.isFinite(segundos) && segundos >= 0) return Math.min(ESPERA_429_MAX_MS, segundos * 1000);
  return ESPERA_429_PADRAO_MS;
}

const esperar = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Uma chamada HTTP com timeout cobrindo a conexão e a leitura do corpo.
async function chamar(url, init, timeoutMs, acao) {
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), timeoutMs);
  try {
    const resposta = await fetch(url, { ...init, signal: controle.signal });
    const texto = await resposta.text();
    return { status: resposta.status, ok: resposta.ok, cabecalhos: resposta.headers, texto };
  } catch (erro) {
    if (controle.signal.aborted) {
      throw falha(`Falha ao ${acao}: o Melhor Envio não respondeu a tempo. Tente novamente em instantes.`, null, '');
    }
    throw falha(`Falha ao ${acao}: não foi possível conectar ao Melhor Envio (${erro && erro.message ? erro.message : 'erro de rede'}).`, null, '');
  } finally {
    clearTimeout(relogio);
  }
}

async function requisitar(metodo, caminho, corpo, { timeoutMs = TIMEOUT_PADRAO_MS, acao = 'consultar o Melhor Envio' } = {}) {
  const ambiente = exigirToken();
  const url = `${urlApi()}${caminho}`;
  const init = {
    method: metodo,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ambiente.melhorEnvioToken}`,
      'User-Agent': userAgent(ambiente),
    },
  };
  if (corpo !== undefined) init.body = JSON.stringify(corpo);

  const limite = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : TIMEOUT_PADRAO_MS;
  for (let tentativa = 1; ; tentativa += 1) {
    const resposta = await chamar(url, init, limite, acao);
    if (resposta.status === 429 && tentativa === 1) {
      await esperar(esperaDo429(resposta.cabecalhos));
      continue;
    }
    if (!resposta.ok) throw erroDeResposta(resposta.status, resposta.texto, acao);
    if (!resposta.texto.trim()) return null;
    try {
      return JSON.parse(resposta.texto);
    } catch {
      throw falha(`Falha ao ${acao}: o Melhor Envio devolveu uma resposta ilegível.`, resposta.status, resposta.texto);
    }
  }
}

// ---------------------------------------------------------------------------
// Conversões e validações

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function inteiroPositivo(valor) {
  const n = typeof valor === 'string' && /^\s*\d+\s*$/.test(valor) ? Number(valor) : valor;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function numeroPositivo(valor) {
  const n = typeof valor === 'string' && valor.trim() !== '' ? Number(valor) : valor;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

// Preço em reais (string ou número) → centavos > 0, ou null.
function lerPreco(valor) {
  const centavos = reaisParaCentavos(valor);
  return Number.isSafeInteger(centavos) && centavos > 0 ? centavos : null;
}

const presente = (v) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '');

function lerPrazo(...valores) {
  for (const valor of valores) {
    const n = typeof valor === 'string' && /^\s*\d+\s*$/.test(valor) ? Number(valor) : valor;
    if (Number.isSafeInteger(n) && n >= 0) return n;
  }
  return null;
}

function cepDaEntrada(valor) {
  if (ehObjeto(valor)) return valor.postal_code ?? valor.cep;
  return valor;
}

function exigirCep(valor, nome) {
  const bruto = cepDaEntrada(valor);
  const cep = normalizarCep(typeof bruto === 'number' ? bruto : String(bruto ?? ''));
  if (!cep) throw new ErroHttp(400, 'cep_invalido', `CEP ${nome} inválido.`);
  return cep;
}

/** [1, '2', '1'] ou "1,2" → [1, 2] (inteiros positivos, sem repetição). */
export function listaServicos(servicos) {
  let lista = [];
  if (Array.isArray(servicos)) lista = servicos;
  else if (typeof servicos === 'string') lista = servicos.split(',');
  else if (Number.isSafeInteger(servicos)) lista = [servicos];
  const ids = [];
  for (const item of lista) {
    const id = inteiroPositivo(typeof item === 'string' ? item.trim() : item);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function listaIds(ids) {
  const lista = (Array.isArray(ids) ? ids : [ids])
    .map((id) => (typeof id === 'string' || typeof id === 'number' ? String(id).trim() : ''));
  if (!lista.length || lista.some((id) => !/^[\w-]{1,80}$/.test(id))) {
    throw new ErroHttp(400, 'etiqueta_invalida', 'Informe os ids das etiquetas do Melhor Envio.');
  }
  return [...new Set(lista)];
}

const somenteDigitos = (v) => (v === undefined || v === null ? '' : String(v).replace(/\D+/g, ''));
const textoLimpo = (v, max = 200) => (typeof v === 'string' || typeof v === 'number'
  ? String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  : '');

const reais = (centavos) => centavosParaReais(Math.max(0, Math.round(centavos)));

// ---------------------------------------------------------------------------
// Cotação

function produtoParaApi(produto, indice) {
  if (!ehObjeto(produto)) throw new ErroHttp(400, 'produto_invalido', 'Produto inválido para cotar o frete.');
  const width = numeroPositivo(produto.width);
  const height = numeroPositivo(produto.height);
  const length = numeroPositivo(produto.length);
  const weight = numeroPositivo(produto.weight);
  const quantity = inteiroPositivo(produto.quantity ?? 1);
  if (!width || !height || !length || !weight || !quantity) {
    throw new ErroHttp(400, 'produto_invalido', 'Peso, dimensões e quantidade dos produtos são obrigatórios para cotar o frete.');
  }
  const seguro = Number(produto.insurance_value ?? 0);
  return {
    id: String(produto.id ?? `item-${indice + 1}`),
    width,
    height,
    length,
    weight,
    insurance_value: Number.isFinite(seguro) && seguro > 0 ? seguro : 0,
    quantity,
  };
}

function volumesParaApi(volumes, valorSeguroCentavos) {
  const lista = Array.isArray(volumes) ? volumes : [volumes];
  const convertidos = lista.map((volume) => {
    if (!ehObjeto(volume)) throw new ErroHttp(400, 'volume_invalido', 'Volume inválido para cotar o frete.');
    const width = numeroPositivo(volume.width);
    const height = numeroPositivo(volume.height);
    const length = numeroPositivo(volume.length);
    const weight = numeroPositivo(volume.weight);
    if (!width || !height || !length || !weight) {
      throw new ErroHttp(400, 'volume_invalido', 'Peso e dimensões dos volumes são obrigatórios para cotar o frete.');
    }
    const convertido = { width, height, length, weight };
    const seguro = Number(volume.insurance);
    if (Number.isFinite(seguro) && seguro > 0) convertido.insurance = seguro;
    return convertido;
  });
  // Na cotação por volumes a chave do seguro é "insurance" (insurance_value é ignorado pela API).
  const semSeguro = convertidos.filter((v) => v.insurance === undefined);
  if (Number.isSafeInteger(valorSeguroCentavos) && valorSeguroCentavos > 0 && semSeguro.length) {
    const parte = Math.floor(valorSeguroCentavos / semSeguro.length);
    const resto = valorSeguroCentavos - parte * semSeguro.length;
    semSeguro.forEach((volume, i) => { volume.insurance = reais(parte + (i === 0 ? resto : 0)); });
  }
  return convertidos;
}

/** Corpo do POST /shipment/calculate. Lança ErroHttp 400 para entrada inválida. */
export function montarCorpoCotacao({ de, para, produtos, volumes, servicos, valorSeguro, opcoes } = {}) {
  const corpo = {
    from: { postal_code: exigirCep(de, 'de origem') },
    to: { postal_code: exigirCep(para, 'de destino') },
  };
  // Nunca products e volumes juntos.
  if (Array.isArray(produtos) && produtos.length) {
    corpo.products = produtos.map(produtoParaApi);
  } else if (volumes && (!Array.isArray(volumes) || volumes.length)) {
    corpo.volumes = volumesParaApi(volumes, valorSeguro);
  } else {
    throw new ErroHttp(400, 'sem_volumes', 'Informe os produtos ou volumes para cotar o frete.');
  }
  corpo.options = { receipt: false, own_hand: false, ...(ehObjeto(opcoes) ? opcoes : {}) };
  const ids = listaServicos(servicos);
  if (ids.length) corpo.services = ids.join(',');
  return corpo;
}

function normalizarPacote(pacote) {
  const p = ehObjeto(pacote) ? pacote : {};
  const dim = ehObjeto(p.dimensions) ? p.dimensions : {};
  const seguro = reaisParaCentavos(p.insurance_value);
  return {
    preco_centavos: lerPreco(p.price),
    peso_kg: numeroPositivo(p.weight),
    altura_cm: numeroPositivo(dim.height),
    largura_cm: numeroPositivo(dim.width),
    comprimento_cm: numeroPositivo(dim.length),
    seguro_centavos: Number.isSafeInteger(seguro) && seguro > 0 ? seguro : 0,
    formato: typeof p.format === 'string' ? p.format : null,
    produtos: Array.isArray(p.products)
      ? p.products
        .filter(ehObjeto)
        .map((x) => ({ id: String(x.id ?? ''), quantidade: inteiroPositivo(x.quantity) || 1 }))
        .filter((x) => x.id)
      : [],
  };
}

/** Resposta do /shipment/calculate → lista normalizada (serviços com erro mantidos com erro preenchido). */
export function normalizarServicos(resposta) {
  let lista = [];
  if (Array.isArray(resposta)) lista = resposta;
  else if (ehObjeto(resposta) && 'id' in resposta) lista = [resposta]; // cotação de um serviço só
  else if (ehObjeto(resposta)) lista = Object.values(resposta);

  const saida = [];
  for (const servico of lista) {
    if (!ehObjeto(servico)) continue;
    const servicoId = inteiroPositivo(servico.id);
    if (!servicoId) continue;
    const nome = textoLimpo(servico.name, 80) || `Serviço ${servicoId}`;
    const empresa = ehObjeto(servico.company) && textoLimpo(servico.company.name, 80)
      ? textoLimpo(servico.company.name, 80)
      : null;

    if (presente(servico.error)) {
      const erro = typeof servico.error === 'string' ? servico.error : JSON.stringify(servico.error);
      saida.push({ servico_id: servicoId, nome, empresa, preco_centavos: null, prazo_dias: null, erro: textoLimpo(erro, 300) || 'Serviço indisponível.', pacotes: [] });
      continue;
    }

    // custom_price, quando existe, é o valor final da conta: se não der para ler, descarta (não volta ao price).
    const preco = presente(servico.custom_price) ? lerPreco(servico.custom_price) : lerPreco(servico.price);
    if (preco === null) continue;

    const faixaCustom = ehObjeto(servico.custom_delivery_range) ? servico.custom_delivery_range : {};
    const faixa = ehObjeto(servico.delivery_range) ? servico.delivery_range : {};
    const prazo = lerPrazo(servico.custom_delivery_time, servico.delivery_time, faixaCustom.max, faixa.max);

    saida.push({
      servico_id: servicoId,
      nome,
      empresa,
      preco_centavos: preco,
      prazo_dias: prazo,
      erro: null,
      pacotes: Array.isArray(servico.packages) ? servico.packages.map(normalizarPacote) : [],
    });
  }
  return saida;
}

/** POST /shipment/calculate → serviços normalizados. */
export async function calcular({ de, para, volumes, produtos, servicos, valorSeguro, opcoes, timeoutMs } = {}) {
  exigirToken();
  const corpo = montarCorpoCotacao({ de, para, volumes, produtos, servicos, valorSeguro, opcoes });
  const resposta = await requisitar('POST', '/shipment/calculate', corpo, { timeoutMs, acao: 'calcular o frete' });
  return normalizarServicos(resposta);
}

// ---------------------------------------------------------------------------
// Carrinho, compra, geração, impressão e rastreio

function pessoaParaApi(pessoa, { remetente = false } = {}) {
  const p = ehObjeto(pessoa) ? pessoa : {};
  const documento = somenteDigitos(p.documento ?? p.cpf ?? p.cnpj);
  const saida = {
    name: textoLimpo(p.nome, 100),
    phone: somenteDigitos(p.telefone),
    email: textoLimpo(p.email, 160),
    address: textoLimpo(p.logradouro ?? p.endereco, 200),
    complement: textoLimpo(p.complemento, 100),
    number: textoLimpo(p.numero, 20),
    district: textoLimpo(p.bairro, 100),
    city: textoLimpo(p.cidade, 100),
    state_abbr: textoLimpo(p.uf, 2).toUpperCase(),
    country_id: 'BR',
    postal_code: exigirCep(p.cep, remetente ? 'de origem' : 'de destino'),
  };
  if (documento.length === 14) saida.company_document = documento;
  else if (documento) saida.document = documento;
  if (remetente) {
    const ie = textoLimpo(p.inscricao_estadual ?? p.state_register, 30);
    if (ie) saida.state_register = ie;
  }
  return saida;
}

/** Linha de `pedidos` → destinatário de montarItensCarrinho. */
export function destinatarioDoPedido(pedido) {
  const p = ehObjeto(pedido) ? pedido : {};
  const endereco = ehObjeto(p.endereco) ? p.endereco : {};
  return {
    nome: p.cliente_nome,
    documento: p.cliente_cpf,
    telefone: p.cliente_telefone,
    email: p.cliente_email,
    cep: endereco.cep,
    logradouro: endereco.logradouro,
    numero: endereco.numero,
    complemento: endereco.complemento,
    bairro: endereco.bairro,
    cidade: endereco.cidade,
    uf: endereco.uf,
  };
}

/**
 * Corpos do POST /cart para um pedido: um por pacote devolvido pela cotação.
 * - pacotes: `pacotes` do serviço em calcular() (cada um com produtos [{ id, quantidade }] quando a cotação foi por produtos)
 * - remetente: frete.origem { cep, nome, telefone, email, documento, endereco, numero, complemento, bairro, cidade, uf }
 * - destinatario: { nome, documento|cpf, telefone, email, cep, logradouro, numero, complemento, bairro, cidade, uf }
 * - itens: [{ produto_id, nome, quantidade, preco_unitario_centavos }] (itens do pedido)
 * - chaveNfe: 44 dígitos → options.invoice.key e non_commercial false; sem ela, declaração de conteúdo.
 * O valor declarado (options.insurance_value) é o total dos produtos de cada etiqueta.
 */
export function montarItensCarrinho({
  servicoId, pacotes, remetente, destinatario, itens, chaveNfe, agencia, tag, urlPedido, plataforma = 'AMA Loja',
} = {}) {
  const servico = inteiroPositivo(servicoId);
  if (!servico) throw new ErroHttp(400, 'servico_invalido', 'Serviço do Melhor Envio inválido.');
  const listaPacotes = (Array.isArray(pacotes) ? pacotes : []).filter(ehObjeto);
  if (!listaPacotes.length) throw new ErroHttp(400, 'sem_pacotes', 'A cotação não devolveu pacotes para este serviço.');
  const listaItens = (Array.isArray(itens) ? itens : []).filter((i) => ehObjeto(i) && inteiroPositivo(i.quantidade));
  if (!listaItens.length) throw new ErroHttp(400, 'sem_itens', 'O pedido não tem itens para enviar.');
  const chave = somenteDigitos(chaveNfe);
  if (chaveNfe && chave.length !== 44) throw new ErroHttp(400, 'chave_nfe_invalida', 'A chave da NF-e deve ter 44 dígitos.');

  const from = pessoaParaApi(remetente, { remetente: true });
  const to = pessoaParaApi(destinatario);
  if (!from.name || !from.address || !from.city || !from.state_abbr) {
    throw new ErroHttp(400, 'origem_incompleta',
      'Complete o endereço de origem do frete nas configurações (nome, endereço, número, bairro, cidade, UF e CEP).');
  }
  if (!to.name || !to.address || !to.city || !to.state_abbr) {
    throw new ErroHttp(400, 'destino_incompleto', 'O endereço de entrega do pedido está incompleto.');
  }
  // Nos Correios, CPF/CNPJ do remetente e do destinatário são obrigatórios em toda etiqueta.
  if (SERVICOS_CORREIOS.includes(servico)) {
    if (!from.document && !from.company_document) {
      throw new ErroHttp(400, 'documento_obrigatorio', 'Os Correios exigem o CPF ou CNPJ do remetente: preencha o documento da AMA nas configurações de frete.');
    }
    if (!to.document && !to.company_document) {
      throw new ErroHttp(400, 'documento_obrigatorio', 'Os Correios exigem o CPF ou CNPJ do destinatário.');
    }
  }

  return listaPacotes.map((pacote, indice) => {
    let doPacote;
    if (Array.isArray(pacote.produtos) && pacote.produtos.length) {
      doPacote = pacote.produtos.map(({ id, quantidade }) => {
        const item = listaItens.find((i) => String(i.produto_id ?? i.id) === String(id));
        return item ? { ...item, quantidade } : null;
      }).filter(Boolean);
    } else if (listaPacotes.length === 1) {
      doPacote = listaItens;
    } else {
      doPacote = [];
    }
    if (!doPacote.length) {
      throw new ErroHttp(422, 'pacotes_sem_produtos', `Não foi possível saber quais produtos vão no pacote ${indice + 1}. Cote o frete novamente.`);
    }

    const products = doPacote.map((item) => ({
      name: textoLimpo(item.nome, 120) || 'Produto AMA',
      quantity: inteiroPositivo(item.quantidade),
      unitary_value: reais(Number(item.preco_unitario_centavos) || 0),
    }));
    const totalCentavos = doPacote.reduce(
      (soma, item) => soma + Math.max(0, Math.round(Number(item.preco_unitario_centavos) || 0)) * inteiroPositivo(item.quantidade), 0);

    const volume = {
      height: pacote.altura_cm,
      width: pacote.largura_cm,
      length: pacote.comprimento_cm,
      weight: pacote.peso_kg,
    };
    if (!numeroPositivo(volume.height) || !numeroPositivo(volume.width) || !numeroPositivo(volume.length) || !numeroPositivo(volume.weight)) {
      throw new ErroHttp(422, 'pacote_invalido', `O pacote ${indice + 1} da cotação veio sem peso ou dimensões.`);
    }

    const options = {
      insurance_value: reais(totalCentavos),
      receipt: false,
      own_hand: false,
      collect: false,
      reverse: false,
      non_commercial: !chave,
      platform: textoLimpo(plataforma, 60) || 'AMA Loja',
    };
    if (chave) options.invoice = { key: chave };
    const tagTexto = textoLimpo(tag, 60);
    if (tagTexto) {
      const url = typeof urlPedido === 'string' && /^https?:\/\//i.test(urlPedido) ? urlPedido : null;
      options.tags = [{ tag: listaPacotes.length > 1 ? `${tagTexto}-${indice + 1}` : tagTexto, url }];
    }

    const corpo = { service: servico, from: { ...from }, to: { ...to }, products, volumes: [volume], options };
    const agency = inteiroPositivo(agencia);
    if (agency) corpo.agency = agency;
    return corpo;
  });
}

function normalizarItemCarrinho(json) {
  if (!ehObjeto(json) || !presente(json.id)) {
    throw falha('Falha ao adicionar ao carrinho: o Melhor Envio não devolveu o id da etiqueta.', 200, JSON.stringify(json));
  }
  return {
    id: String(json.id),
    protocolo: typeof json.protocol === 'string' ? json.protocol : null,
    servico_id: inteiroPositivo(json.service_id),
    preco_centavos: lerPreco(json.price),
    status: typeof json.status === 'string' ? json.status : null,
    bruto: json,
  };
}

/** POST /cart (uma etiqueta). Aceita uma lista: adiciona em sequência e devolve a lista. */
export async function adicionarAoCarrinho(dados, { timeoutMs } = {}) {
  exigirToken();
  if (Array.isArray(dados)) {
    const saida = [];
    for (const item of dados) saida.push(await adicionarAoCarrinho(item, { timeoutMs }));
    return saida;
  }
  if (!ehObjeto(dados)) throw new ErroHttp(400, 'dados_invalidos', 'Dados do carrinho do Melhor Envio inválidos.');
  const service = inteiroPositivo(dados.service);
  if (!service) throw new ErroHttp(400, 'servico_invalido', 'Serviço do Melhor Envio inválido.');
  const corpo = { ...dados, service };
  if (dados.volumes !== undefined) {
    corpo.volumes = Array.isArray(dados.volumes) ? dados.volumes : [dados.volumes];
    if (corpo.volumes.length > 1 && SERVICOS_VOLUME_UNICO.includes(service)) {
      throw new ErroHttp(400, 'volumes_demais', 'Este serviço aceita um volume por etiqueta: crie um item de carrinho por pacote.');
    }
  }
  for (const lado of ['from', 'to']) {
    if (ehObjeto(dados[lado])) {
      const pessoa = { ...dados[lado] };
      pessoa.postal_code = exigirCep(pessoa.postal_code, lado === 'from' ? 'do remetente' : 'do destinatário');
      if (pessoa.phone !== undefined) pessoa.phone = somenteDigitos(pessoa.phone);
      if (pessoa.document !== undefined) pessoa.document = somenteDigitos(pessoa.document);
      if (pessoa.company_document !== undefined) pessoa.company_document = somenteDigitos(pessoa.company_document);
      corpo[lado] = pessoa;
    }
  }
  const json = await requisitar('POST', '/cart', corpo, { timeoutMs, acao: 'adicionar a etiqueta ao carrinho' });
  return normalizarItemCarrinho(json);
}

/** GET /balance → saldo em centavos. */
export async function saldo({ timeoutMs } = {}) {
  const json = await requisitar('GET', '/balance', undefined, { timeoutMs, acao: 'consultar o saldo' });
  const valor = ehObjeto(json) ? json.balance : undefined;
  const centavos = reaisParaCentavos(valor);
  if (!Number.isSafeInteger(centavos)) {
    throw falha('Falha ao consultar o saldo: o Melhor Envio devolveu um saldo ilegível.', 200, JSON.stringify(json));
  }
  return centavos;
}

const pareceFaltaDeSaldo = (texto) => /saldo|insuficiente|insufficient|balance|carteira|wallet/i.test(texto);

/** POST /shipment/checkout: paga as etiquetas com o saldo da carteira. */
export async function comprar(ids, { valorCentavos, timeoutMs } = {}) {
  exigirToken();
  const orders = listaIds(ids);
  if (Number.isSafeInteger(valorCentavos) && valorCentavos > 0) {
    const disponivel = await saldo({ timeoutMs });
    if (disponivel < valorCentavos) {
      throw new ErroHttp(409, 'saldo_insuficiente',
        `Saldo insuficiente no Melhor Envio: disponível ${formatarReais(disponivel)}, necessário ${formatarReais(valorCentavos)}. Adicione saldo na carteira do Melhor Envio.`,
        { saldo_centavos: disponivel, necessario_centavos: valorCentavos });
    }
  }
  let json;
  try {
    json = await requisitar('POST', '/shipment/checkout', { orders }, { timeoutMs, acao: 'comprar as etiquetas' });
  } catch (erro) {
    const status = erro && erro.extra ? erro.extra.status_melhor_envio : null;
    if (status >= 400 && status < 500 && status !== 429 && pareceFaltaDeSaldo(erro.extra.resposta_melhor_envio)) {
      throw new ErroHttp(409, 'saldo_insuficiente', `Saldo insuficiente no Melhor Envio. ${detalheDoCorpo(erro.extra.resposta_melhor_envio)}`.trim(), erro.extra);
    }
    throw erro;
  }
  const compra = ehObjeto(json) && ehObjeto(json.purchase) ? json.purchase : null;
  if (!compra) {
    throw falha(`Falha ao comprar as etiquetas: ${detalheDoCorpo(JSON.stringify(json ?? '')) || 'resposta sem a compra.'}`, 200, JSON.stringify(json));
  }
  const total = reaisParaCentavos(compra.total);
  return {
    compra_id: presente(compra.id) ? String(compra.id) : null,
    protocolo: typeof compra.protocol === 'string' ? compra.protocol : null,
    total_centavos: Number.isSafeInteger(total) ? total : null,
    status: typeof compra.status === 'string' ? compra.status : null,
    ordens: Array.isArray(compra.orders)
      ? compra.orders.filter(ehObjeto).map((o) => ({
        id: String(o.id),
        protocolo: typeof o.protocol === 'string' ? o.protocol : null,
        servico_id: inteiroPositivo(o.service_id),
        self_tracking: typeof o.self_tracking === 'string' ? o.self_tracking : null,
      }))
      : [],
    bruto: json,
  };
}

/** POST /shipment/generate. A geração termina depois: confira generated_at (obterEtiqueta/aguardarGeracao). */
export async function gerar(ids, { timeoutMs } = {}) {
  exigirToken();
  const orders = listaIds(ids);
  const json = await requisitar('POST', '/shipment/generate', { orders }, { timeoutMs, acao: 'gerar as etiquetas' });
  const saida = {};
  for (const id of orders) {
    const r = ehObjeto(json) && ehObjeto(json[id]) ? json[id] : null;
    const mensagem = r && typeof r.message === 'string' ? r.message : '';
    // Gerar de novo devolve status false com "O envio já está gerado": para nós, está ok.
    const jaGerada = /j[áa]\s+(est[áa]\s+)?gerad/i.test(mensagem);
    saida[id] = { ok: Boolean(r && (r.status === true || jaGerada)), mensagem: mensagem || (r ? '' : 'Sem resposta para esta etiqueta.') };
  }
  return saida;
}

const dataOuNull = (v) => (typeof v === 'string' && v.trim() ? v : null);

function normalizarEtiqueta(json) {
  return {
    id: String(json.id),
    protocolo: typeof json.protocol === 'string' ? json.protocol : null,
    status: typeof json.status === 'string' ? json.status : null,
    servico_id: inteiroPositivo(json.service_id),
    preco_centavos: lerPreco(json.price),
    codigo_rastreio: typeof json.tracking === 'string' && json.tracking.trim() ? json.tracking.trim() : null,
    self_tracking: typeof json.self_tracking === 'string' ? json.self_tracking : null,
    gerada: Boolean(dataOuNull(json.generated_at)),
    paga: Boolean(dataOuNull(json.paid_at)),
    cancelada: Boolean(dataOuNull(json.canceled_at)) || json.status === 'canceled',
    generated_at: dataOuNull(json.generated_at),
    paid_at: dataOuNull(json.paid_at),
    posted_at: dataOuNull(json.posted_at),
    delivered_at: dataOuNull(json.delivered_at),
    canceled_at: dataOuNull(json.canceled_at),
    expired_at: dataOuNull(json.expired_at),
    bruto: json,
  };
}

/** GET /orders/{id}: dados e datas da etiqueta (generated_at diz se já pode imprimir). */
export async function obterEtiqueta(id, { timeoutMs } = {}) {
  exigirToken();
  const [valido] = listaIds(id);
  const json = await requisitar('GET', `/orders/${encodeURIComponent(valido)}`, undefined, { timeoutMs, acao: 'consultar a etiqueta' });
  if (!ehObjeto(json) || !presente(json.id)) {
    throw falha('Falha ao consultar a etiqueta: resposta sem id.', 200, JSON.stringify(json));
  }
  return normalizarEtiqueta(json);
}

/** Consulta GET /orders/{id} até todas terem generated_at ou acabarem as tentativas. */
export async function aguardarGeracao(ids, { tentativas = 5, intervaloMs = 1500, timeoutMs } = {}) {
  const lista = listaIds(ids);
  const etiquetas = {};
  let pendentes = lista;
  const maximo = Math.max(1, Math.floor(tentativas) || 1);
  for (let rodada = 1; rodada <= maximo && pendentes.length; rodada += 1) {
    if (rodada > 1) await esperar(Math.max(0, intervaloMs));
    const ainda = [];
    for (const id of pendentes) {
      const etiqueta = await obterEtiqueta(id, { timeoutMs });
      etiquetas[id] = etiqueta;
      if (!etiqueta.gerada) ainda.push(id);
    }
    pendentes = ainda;
  }
  return { geradas: lista.filter((id) => !pendentes.includes(id)), pendentes, etiquetas };
}

/** POST /shipment/print com mode "public" → { url }. Confere antes se todas já foram geradas. */
export async function imprimir(ids, { conferirGeracao = true, timeoutMs } = {}) {
  exigirToken();
  const orders = listaIds(ids);
  if (conferirGeracao) {
    const pendentes = [];
    for (const id of orders) {
      const etiqueta = await obterEtiqueta(id, { timeoutMs });
      if (!etiqueta.gerada) pendentes.push(id);
    }
    if (pendentes.length) {
      throw new ErroHttp(409, 'etiqueta_em_geracao',
        'O Melhor Envio ainda está gerando a etiqueta. Aguarde alguns instantes e tente imprimir de novo.',
        { pendentes });
    }
  }
  const json = await requisitar('POST', '/shipment/print', { mode: 'public', orders }, { timeoutMs, acao: 'imprimir as etiquetas' });
  const url = ehObjeto(json) && typeof json.url === 'string' ? json.url : '';
  if (!/^https?:\/\//i.test(url)) {
    throw new ErroHttp(409, 'etiqueta_em_geracao',
      'O Melhor Envio não devolveu o link de impressão (a etiqueta pode ainda estar sendo gerada).',
      extraErro(200, JSON.stringify(json)));
  }
  return { url };
}

// Link público de rastreio. Só https, sem caracteres que a RPC alterar_status_pedido recusa.
function urlRastreio(registro, codigo) {
  const informada = typeof registro.tracking_url === 'string' ? registro.tracking_url.trim() : '';
  if (/^https:\/\/[^\s"'<>`]+$/i.test(informada)) return informada;
  const chave = codigo || (typeof registro.melhorenvio_tracking === 'string' ? registro.melhorenvio_tracking.trim() : '');
  return chave ? `https://www.melhorrastreio.com.br/rastreio/${encodeURIComponent(chave)}` : null;
}

/** POST /shipment/tracking (a API guarda em cache por até 1 h). */
export async function rastrear(ids, { timeoutMs } = {}) {
  exigirToken();
  const orders = listaIds(ids);
  const json = await requisitar('POST', '/shipment/tracking', { orders }, { timeoutMs, acao: 'rastrear as etiquetas' });
  const saida = {};
  for (const id of orders) {
    const r = ehObjeto(json) && ehObjeto(json[id]) ? json[id] : null;
    if (!r) {
      saida[id] = { status: null, codigo_rastreio: null, codigo_melhor_envio: null, url_rastreio: null, posted_at: null, delivered_at: null, bruto: null };
      continue;
    }
    const codigo = typeof r.tracking === 'string' && r.tracking.trim() ? r.tracking.trim() : null;
    saida[id] = {
      status: typeof r.status === 'string' ? r.status : null,
      codigo_rastreio: codigo,
      codigo_melhor_envio: typeof r.melhorenvio_tracking === 'string' ? r.melhorenvio_tracking : null,
      url_rastreio: urlRastreio(r, codigo),
      posted_at: dataOuNull(r.posted_at),
      delivered_at: dataOuNull(r.delivered_at),
      bruto: r,
    };
  }
  return saida;
}

/** POST /shipment/cancel (reason_id sempre 2). */
export async function cancelar(id, { descricao = 'Cancelado pela loja', timeoutMs } = {}) {
  exigirToken();
  const [valido] = listaIds(id);
  const json = await requisitar('POST', '/shipment/cancel',
    { order: { id: valido, reason_id: 2, description: textoLimpo(descricao, 200) || 'Cancelado pela loja' } },
    { timeoutMs, acao: 'cancelar a etiqueta' });
  const r = ehObjeto(json) && ehObjeto(json[valido]) ? json[valido] : null;
  return { cancelada: Boolean(r && r.canceled === true), bruto: json };
}
