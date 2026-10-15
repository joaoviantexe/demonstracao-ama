/**
 * Regras de frete da loja (docs/ARQUITETURA.md §4.1 → configuracoes.frete e §6.2).
 *
 * cotarFrete({ itens, cep, subtotalCentavos, freteGratisCupom, config, descontoCentavos?, timeoutMs? })
 *   → { opcoes: [Opcao], erro: string|null, uf: 'PA'|…|null }
 *   - itens: saída de cotar_carrinho (produto_id, quantidade, preco_unitario_centavos, disponivel, peso_gramas,
 *     altura_cm, largura_cm, comprimento_cm). Itens indisponíveis não entram no peso.
 *   - subtotalCentavos: subtotal JÁ COM o desconto do cupom (ou passe descontoCentavos para subtrair aqui).
 *   - freteGratisCupom: true se o cupom é do tipo frete_gratis.
 *   - config: { loja, frete } de lerConfiguracoes(); faltas usam os padrões da §4.1.
 *   Opcao = { id: 'me-<servico>'|'fixo-…'|'retirada', tipo: 'melhor_envio'|'fixo'|'retirada', nome, empresa,
 *     prazo_dias, prazo_texto, preco_centavos, preco_original_centavos, gratis, servico_id }
 *   Erro do Melhor Envio não derruba: as outras opções voltam e `erro` traz uma mensagem amigável.
 *   CEP inválido (ou fora das faixas dos Correios): só a retirada e `erro`.
 *   timeoutMs (padrão TIMEOUT_COTACAO_MS = 8 s) é o prazo total da chamada ao Melhor Envio.
 *   As cotações do Melhor Envio ficam em cache por CACHE_COTACAO_MS (10 min) na instância; limparCacheCotacoes()
 *   esvazia (testes que mudam o servidor falso entre cotações iguais devem chamá-la).
 *
 * Funções puras exportadas para teste e para a rota de envio do admin:
 * montarProdutosMelhorEnvio, opcaoMelhorEnvio, opcoesFixas, opcaoRetirada, freteGratisAtivo,
 * aplicarFreteGratis, ordenarOpcoes, textoPrazo, normalizarConfigFrete; constantes MINIMOS_CORREIOS, FRETE_PADRAO,
 * TIMEOUT_COTACAO_MS e CACHE_COTACAO_MS.
 */

import { obterAmbiente } from './ambiente.js';
import { centavosParaReais } from './dinheiro.js';
import { normalizarCep, ufDoCep } from './cep.js';
import { calcular, listaServicos, montarCorpoCotacao, urlApi } from './melhorenvio.js';

// Dimensões mínimas aceitas pelos Correios no Melhor Envio (altura x largura x comprimento).
export const MINIMOS_CORREIOS = Object.freeze({ altura_cm: 1, largura_cm: 8, comprimento_cm: 13 });

// Prazo total da cotação no Melhor Envio (inclui a nova tentativa após um 429).
export const TIMEOUT_COTACAO_MS = 8_000;

// Cache em memória das cotações do Melhor Envio (limite de 250 req/min por conta, compartilhado com o admin).
// Vale enquanto a instância estiver quente. Guarda o resultado de calcular() (antes de taxa/prazo extras da
// config) pela chave origem + destino + products + services + base da API. Erros não ficam no cache.
export const CACHE_COTACAO_MS = 10 * 60_000;
const CACHE_MAX_ENTRADAS = 500;
const cacheCotacoes = new Map();

/** Esvazia o cache de cotações (testes, ou depois de mudar a conta do Melhor Envio). */
export function limparCacheCotacoes() {
  cacheCotacoes.clear();
}

function calcularComCache(entrada) {
  const { timeoutMs, ...semPrazo } = entrada;
  const chave = JSON.stringify([urlApi(), montarCorpoCotacao(semPrazo)]);
  const agora = Date.now();
  const achado = cacheCotacoes.get(chave);
  if (achado && achado.expira > agora) return achado.promessa;
  cacheCotacoes.delete(chave);
  // Pedidos iguais simultâneos compartilham a mesma chamada.
  const promessa = calcular(entrada);
  cacheCotacoes.set(chave, { expira: agora + CACHE_COTACAO_MS, promessa });
  promessa.catch(() => {
    if (cacheCotacoes.get(chave)?.promessa === promessa) cacheCotacoes.delete(chave);
  });
  while (cacheCotacoes.size > CACHE_MAX_ENTRADAS) cacheCotacoes.delete(cacheCotacoes.keys().next().value);
  return promessa;
}

export const FRETE_PADRAO = Object.freeze({
  origem: Object.freeze({
    cep: '', nome: 'AMA - Associação de Mulheres na Amazônia', telefone: '', email: '', documento: '',
    endereco: '', numero: '', complemento: '', bairro: '', cidade: 'Ananindeua', uf: 'PA',
  }),
  retirada: Object.freeze({
    ativa: true,
    nome: 'Retirar na sede da AMA',
    endereco: 'Conjunto Uirapuru, Quadra 28, Casa 02, Icuí, Ananindeua - PA',
    prazo_texto: 'Disponível após a confirmação do pagamento',
  }),
  fixo: Object.freeze({ ativo: false, opcoes: Object.freeze([]) }),
  melhor_envio: Object.freeze({ ativo: true, servicos: Object.freeze([1, 2]), seguro: true, prazo_extra_dias: 2, taxa_extra_centavos: 0 }),
  embalagem_padrao: Object.freeze({ peso_gramas: 300, altura_cm: 4, largura_cm: 12, comprimento_cm: 16 }),
});

const MSG_CEP_INVALIDO = 'CEP inválido. Confira os 8 números do CEP.';
const MSG_CEP_DESCONHECIDO = 'Não reconhecemos este CEP. Confira os números ou escolha a retirada.';
const MSG_FALHA_ME = 'Não foi possível calcular o frete das transportadoras agora. Tente de novo em instantes ou escolha outra opção.';
const MSG_ME_SEM_SERVICO = 'As transportadoras não atendem este CEP com este pacote. Veja as outras opções.';
const MSG_SEM_OPCOES = 'Não há forma de entrega disponível para este CEP.';

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function inteiro(valor) {
  const n = typeof valor === 'string' && /^\s*-?\d+\s*$/.test(valor) ? Number(valor) : valor;
  return Number.isSafeInteger(n) ? n : null;
}

const inteiroNaoNegativo = (valor, padrao = null) => {
  const n = inteiro(valor);
  return n !== null && n >= 0 ? n : padrao;
};

function medida(valor, padrao) {
  const n = typeof valor === 'string' && valor.trim() !== '' ? Number(valor) : valor;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : padrao;
}

const texto = (v, padrao = '') => (typeof v === 'string' && v.trim() ? v.trim() : padrao);

/** Config completa de frete (padrões da §4.1 onde faltar). */
export function normalizarConfigFrete(config) {
  const frete = ehObjeto(config) && ehObjeto(config.frete) ? config.frete : {};
  const juntar = (padrao, valor) => ({ ...padrao, ...(ehObjeto(valor) ? valor : {}) });
  return {
    origem: juntar(FRETE_PADRAO.origem, frete.origem),
    retirada: juntar(FRETE_PADRAO.retirada, frete.retirada),
    fixo: juntar(FRETE_PADRAO.fixo, frete.fixo),
    melhor_envio: juntar(FRETE_PADRAO.melhor_envio, frete.melhor_envio),
    embalagem_padrao: juntar(FRETE_PADRAO.embalagem_padrao, frete.embalagem_padrao),
  };
}

/** "até 7 dias úteis" / "até 1 dia útil"; sem prazo → alternativo. */
export function textoPrazo(dias, alternativo = 'Prazo a combinar') {
  const n = inteiroNaoNegativo(dias);
  if (n === null) return texto(alternativo, 'Prazo a combinar');
  if (n === 0) return 'no mesmo dia útil';
  return n === 1 ? 'até 1 dia útil' : `até ${n} dias úteis`;
}

const arredondarCm = (cm) => Math.ceil(cm - 1e-9);

/**
 * Itens do carrinho → `products` da cotação do Melhor Envio (dados unitários + quantity).
 * Peso em kg, dimensões em cm inteiros (para cima) com os mínimos dos Correios garantidos,
 * insurance_value = preço unitário em reais se `seguro`. Dimensão/peso ausente → embalagem padrão.
 */
export function montarProdutosMelhorEnvio(itens, { seguro = true, embalagem } = {}) {
  const emb = { ...FRETE_PADRAO.embalagem_padrao, ...(ehObjeto(embalagem) ? embalagem : {}) };
  const pesoPadrao = medida(emb.peso_gramas, FRETE_PADRAO.embalagem_padrao.peso_gramas);
  const lista = Array.isArray(itens) ? itens : [];
  const produtos = [];
  lista.forEach((item, indice) => {
    if (!ehObjeto(item) || item.disponivel === false) return;
    const quantidade = inteiro(item.quantidade);
    if (quantidade === null || quantidade < 1) return;
    const altura = medida(item.altura_cm, medida(emb.altura_cm, FRETE_PADRAO.embalagem_padrao.altura_cm));
    const largura = medida(item.largura_cm, medida(emb.largura_cm, FRETE_PADRAO.embalagem_padrao.largura_cm));
    const comprimento = medida(item.comprimento_cm, medida(emb.comprimento_cm, FRETE_PADRAO.embalagem_padrao.comprimento_cm));
    const gramas = medida(item.peso_gramas, pesoPadrao);
    const preco = inteiroNaoNegativo(item.preco_unitario_centavos, 0);
    produtos.push({
      id: String(item.produto_id ?? item.id ?? `item-${indice + 1}`),
      width: Math.max(MINIMOS_CORREIOS.largura_cm, arredondarCm(largura)),
      height: Math.max(MINIMOS_CORREIOS.altura_cm, arredondarCm(altura)),
      length: Math.max(MINIMOS_CORREIOS.comprimento_cm, arredondarCm(comprimento)),
      weight: Math.max(1, Math.round(gramas)) / 1000,
      insurance_value: seguro ? centavosParaReais(preco) : 0,
      quantity: quantidade,
    });
  });
  return produtos;
}

/** Serviço normalizado de melhorenvio.calcular → Opcao (com prazo e taxa extras da config). */
export function opcaoMelhorEnvio(servico, melhorEnvio = {}) {
  const taxa = inteiroNaoNegativo(melhorEnvio.taxa_extra_centavos, 0);
  const diasExtra = inteiroNaoNegativo(melhorEnvio.prazo_extra_dias, 0);
  const preco = servico.preco_centavos + taxa;
  const prazo = servico.prazo_dias === null || servico.prazo_dias === undefined ? null : servico.prazo_dias + diasExtra;
  return {
    id: `me-${servico.servico_id}`,
    tipo: 'melhor_envio',
    nome: servico.nome,
    empresa: servico.empresa ?? null,
    prazo_dias: prazo,
    prazo_texto: textoPrazo(prazo),
    preco_centavos: preco,
    preco_original_centavos: preco,
    gratis: false,
    servico_id: servico.servico_id,
  };
}

function idFixo(valor, indice) {
  const limpo = String(valor ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!limpo || limpo === 'fixo') return `fixo-${indice + 1}`;
  return limpo.startsWith('fixo-') ? limpo : `fixo-${limpo}`;
}

/** Opções de frete fixo que atendem a UF (lista `ufs` vazia = todas as UFs). */
export function opcoesFixas(fixo, uf) {
  if (!ehObjeto(fixo) || fixo.ativo !== true || !Array.isArray(fixo.opcoes)) return [];
  const usados = new Set();
  const saida = [];
  fixo.opcoes.forEach((op, indice) => {
    if (!ehObjeto(op) || op.ativo === false) return;
    const preco = inteiroNaoNegativo(op.preco_centavos);
    if (preco === null) return;
    const ufs = Array.isArray(op.ufs)
      ? op.ufs.map((u) => String(u ?? '').trim().toUpperCase()).filter(Boolean)
      : [];
    if (ufs.length && (!uf || !ufs.includes(uf))) return;
    let id = idFixo(op.id, indice);
    if (usados.has(id)) id = `${id}-${indice + 1}`;
    usados.add(id);
    const prazo = inteiroNaoNegativo(op.prazo_dias);
    saida.push({
      id,
      tipo: 'fixo',
      nome: texto(op.nome, 'Entrega'),
      empresa: texto(op.empresa, '') || null,
      prazo_dias: prazo,
      prazo_texto: textoPrazo(prazo, op.prazo_texto),
      preco_centavos: preco,
      preco_original_centavos: preco,
      gratis: false,
      servico_id: null,
    });
  });
  return saida;
}

/** Opção de retirada na sede (preço 0) ou null se desativada. */
export function opcaoRetirada(retirada) {
  const r = { ...FRETE_PADRAO.retirada, ...(ehObjeto(retirada) ? retirada : {}) };
  if (r.ativa === false) return null;
  return {
    id: 'retirada',
    tipo: 'retirada',
    nome: texto(r.nome, FRETE_PADRAO.retirada.nome),
    empresa: null,
    prazo_dias: null,
    prazo_texto: texto(r.prazo_texto, FRETE_PADRAO.retirada.prazo_texto),
    preco_centavos: 0,
    preco_original_centavos: 0,
    gratis: false,
    servico_id: null,
  };
}

/** Cupom frete_gratis, ou subtotal (já com desconto) >= limite configurado (> 0). */
export function freteGratisAtivo({ freteGratisCupom = false, subtotalCentavos = 0, limiteCentavos = null } = {}) {
  if (freteGratisCupom === true) return true;
  const limite = inteiro(limiteCentavos);
  const subtotal = inteiro(subtotalCentavos);
  return limite !== null && limite > 0 && subtotal !== null && subtotal >= limite;
}

/** A opção PAGA mais barata (fora a retirada) fica com preço 0 e gratis: true. Devolve cópias. */
export function aplicarFreteGratis(opcoes) {
  const copia = (Array.isArray(opcoes) ? opcoes : []).map((o) => ({ ...o }));
  let escolhida = null;
  for (const opcao of copia) {
    if (opcao.tipo === 'retirada' || !(opcao.preco_centavos > 0)) continue;
    if (!escolhida
      || opcao.preco_centavos < escolhida.preco_centavos
      || (opcao.preco_centavos === escolhida.preco_centavos && compararPrazo(opcao, escolhida) < 0)) {
      escolhida = opcao;
    }
  }
  if (escolhida) {
    escolhida.preco_original_centavos = escolhida.preco_centavos;
    escolhida.preco_centavos = 0;
    escolhida.gratis = true;
  }
  return copia;
}

function compararPrazo(a, b) {
  const pa = Number.isSafeInteger(a.prazo_dias) ? a.prazo_dias : Infinity;
  const pb = Number.isSafeInteger(b.prazo_dias) ? b.prazo_dias : Infinity;
  return pa === pb ? 0 : pa < pb ? -1 : 1;
}

/** Retirada por último; as demais por preço, depois prazo e nome. Devolve um novo array. */
export function ordenarOpcoes(opcoes) {
  return [...(Array.isArray(opcoes) ? opcoes : [])].sort((a, b) => {
    const ra = a.tipo === 'retirada' ? 1 : 0;
    const rb = b.tipo === 'retirada' ? 1 : 0;
    if (ra !== rb) return ra - rb;
    if (a.preco_centavos !== b.preco_centavos) return a.preco_centavos - b.preco_centavos;
    const prazo = compararPrazo(a, b);
    if (prazo) return prazo;
    return String(a.nome).localeCompare(String(b.nome), 'pt-BR');
  });
}

async function opcoesDoMelhorEnvio({ frete, itens, cep, timeoutMs }) {
  const me = frete.melhor_envio;
  if (!obterAmbiente().melhorEnvioConfigurado || me.ativo !== true) return { opcoes: [], erro: null };
  const origem = normalizarCep(frete.origem.cep);
  const servicos = listaServicos(me.servicos);
  if (!origem || !servicos.length) return { opcoes: [], erro: null };
  const produtos = montarProdutosMelhorEnvio(itens, { seguro: me.seguro !== false, embalagem: frete.embalagem_padrao });
  if (!produtos.length) return { opcoes: [], erro: null };

  let lista;
  try {
    lista = await calcularComCache({ de: origem, para: cep, produtos, servicos, timeoutMs: timeoutMs ?? TIMEOUT_COTACAO_MS });
  } catch (erro) {
    console.warn('[frete] Melhor Envio falhou:', erro && (erro.mensagem || erro.message), erro && erro.extra ? erro.extra : '');
    return { opcoes: [], erro: MSG_FALHA_ME };
  }
  const vistos = new Set();
  const opcoes = [];
  for (const servico of lista) {
    if (servico.erro || !servicos.includes(servico.servico_id) || vistos.has(servico.servico_id)) continue;
    if (!Number.isSafeInteger(servico.preco_centavos) || servico.preco_centavos <= 0) continue;
    vistos.add(servico.servico_id);
    opcoes.push(opcaoMelhorEnvio(servico, me));
  }
  return { opcoes, erro: opcoes.length ? null : MSG_ME_SEM_SERVICO };
}

/** Cotação de frete da loja (§6.2). */
export async function cotarFrete({
  itens = [], cep, subtotalCentavos = 0, freteGratisCupom = false, config = {}, descontoCentavos = 0, timeoutMs,
} = {}) {
  const frete = normalizarConfigFrete(config);
  const retirada = opcaoRetirada(frete.retirada);
  const soRetirada = retirada ? [retirada] : [];

  const destino = normalizarCep(cep);
  if (!destino) return { opcoes: soRetirada, erro: MSG_CEP_INVALIDO, uf: null };
  const uf = ufDoCep(destino);
  if (!uf) return { opcoes: soRetirada, erro: MSG_CEP_DESCONHECIDO, uf: null };

  const me = await opcoesDoMelhorEnvio({ frete, itens, cep: destino, timeoutMs });
  let opcoes = [...me.opcoes, ...opcoesFixas(frete.fixo, uf), ...soRetirada];

  const loja = ehObjeto(config) && ehObjeto(config.loja) ? config.loja : {};
  const subtotal = (inteiro(subtotalCentavos) ?? 0) - (inteiroNaoNegativo(descontoCentavos, 0));
  if (freteGratisAtivo({ freteGratisCupom, subtotalCentavos: subtotal, limiteCentavos: loja.frete_gratis_acima_centavos })) {
    opcoes = aplicarFreteGratis(opcoes);
  }
  opcoes = ordenarOpcoes(opcoes);

  let erro = me.erro;
  if (!opcoes.length && !erro) erro = MSG_SEM_OPCOES;
  return { opcoes, erro, uf };
}
