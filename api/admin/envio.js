// POST /api/admin/envio — etiquetas do Melhor Envio para um pedido (docs/ARQUITETURA.md §6.6).
// Entrada { pedido_id, acao, chave_nfe?, refazer? }, acao ∈ adicionar_carrinho | comprar | gerar | imprimir | rastrear.
// Só pedidos com entrega.tipo = 'melhor_envio' e status pago, em_separacao ou enviado.
//
// - adicionar_carrinho: recota o serviço entrega.servico_id com os itens do pedido (medidas atuais dos
//   produtos; produto apagado usa a embalagem padrão) e cria UM item de carrinho por pacote, com remetente
//   frete.origem e destinatário do pedido. chave_nfe (44 dígitos) → NF-e; sem ela, declaração de conteúdo.
//   Se o pedido já tem etiquetas, recusa (409) a menos que venha refazer: true (substitui me_ordens).
// - comprar: confere quais etiquetas ainda não foram pagas e o saldo da carteira antes de comprar.
// - gerar: pede a geração (assíncrona no Melhor Envio).
// - imprimir: confere generated_at de cada etiqueta antes (senão 409 'etiqueta_em_geracao') e usa mode "public".
// - rastrear: atualiza codigo_rastreio (vários separados por vírgula) e url_rastreio.
// Salva me_ordens, etiqueta_url e codigo_rastreio no pedido e registra evento 'envio' (autor = e-mail do admin).

import { obterAmbiente } from '../../lib/ambiente.js';
import { exigirAdmin } from '../../lib/admin.js';
import { formatarReais } from '../../lib/dinheiro.js';
import { montarProdutosMelhorEnvio } from '../../lib/frete.js';
import { ErroHttp, exigirMetodo, lerCorpo, responderJson, tratarErro, urlBase } from '../../lib/http.js';
import {
  atualizarPedido, buscarPedido, CABECALHOS_SEM_CACHE, erroDaLoja, lerConfiguracoes, registrarEvento,
} from '../../lib/loja.js';
import {
  adicionarAoCarrinho, aguardarGeracao, calcular, comprar, destinatarioDoPedido, gerar, imprimir, montarItensCarrinho,
  obterEtiqueta, rastrear,
} from '../../lib/melhorenvio.js';
import { servico } from '../../lib/supabase.js';
import { validarUuid } from '../../lib/validacao.js';

export const ACOES_ENVIO = Object.freeze(['adicionar_carrinho', 'comprar', 'gerar', 'imprimir', 'rastrear']);
const STATUS_PERMITIDOS = ['pago', 'em_separacao', 'enviado'];

const SELECT = [
  'id', 'numero', 'status', 'entrega', 'endereco', 'cliente_nome', 'cliente_email', 'cliente_telefone', 'cliente_cpf',
  'me_ordens', 'etiqueta_url', 'codigo_rastreio', 'url_rastreio',
  'pedido_itens(id,produto_id,nome,quantidade,preco_unitario_centavos,total_centavos)',
].join(',');

// Mesma regra do check pedidos_url_rastreio_check da migração.
const URL_RASTREIO_VALIDA = /^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?([/?#][^\s\u0000-\u001f\u007f"'<>`\\]*)?$/i;
const CODIGO_VALIDO = /^[A-Za-z0-9._-]{1,60}$/;

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

function idsDe(meOrdens) {
  return (Array.isArray(meOrdens) ? meOrdens : [])
    .map((id) => (typeof id === 'string' || typeof id === 'number' ? String(id).trim() : ''))
    .filter(Boolean);
}

function exigirEtiquetas(pedido) {
  const ids = idsDe(pedido.me_ordens);
  if (!ids.length) {
    throw new ErroHttp(409, 'sem_etiquetas', 'Este pedido ainda não tem etiquetas no Melhor Envio. Comece por "adicionar ao carrinho".');
  }
  return ids;
}

// Itens do pedido com as medidas atuais dos produtos (para recotar e montar o carrinho).
async function itensComMedidas(pedido) {
  const itens = Array.isArray(pedido.pedido_itens) ? pedido.pedido_itens : [];
  const ids = [...new Set(itens.map((i) => i.produto_id).filter((id) => validarUuid(id)))];
  let produtos = [];
  if (ids.length) {
    try {
      produtos = await servico().select('produtos', {
        select: 'id,peso_gramas,altura_cm,largura_cm,comprimento_cm',
        id: `in.(${ids.join(',')})`,
      });
    } catch (erro) {
      throw erroDaLoja(erro);
    }
  }
  const medidas = new Map(produtos.map((p) => [p.id, p]));
  return itens.map((item) => {
    const m = medidas.get(item.produto_id) || {};
    return {
      // Produto apagado: identificador próprio do item (as funções casam por produto_id ?? id).
      id: `item-${item.id}`,
      produto_id: item.produto_id || null,
      nome: item.nome,
      quantidade: item.quantidade,
      preco_unitario_centavos: item.preco_unitario_centavos,
      disponivel: true,
      peso_gramas: m.peso_gramas,
      altura_cm: m.altura_cm,
      largura_cm: m.largura_cm,
      comprimento_cm: m.comprimento_cm,
    };
  });
}

async function salvar(pedido, campos, contexto) {
  try {
    return await atualizarPedido(pedido.id, campos);
  } catch (erro) {
    console.error(`[envio] pedido #${pedido.numero}: falha ao salvar (${contexto}):`, erro && (erro.mensagem || erro.message));
    throw new ErroHttp(502, 'falha_banco',
      `A ação foi feita no Melhor Envio (${contexto}), mas não foi possível salvar no pedido. Anote e tente "rastrear" em instantes.`);
  }
}

async function acaoAdicionarCarrinho({ pedido, corpo, autor, siteUrl }) {
  const atuais = idsDe(pedido.me_ordens);
  if (atuais.length && corpo.refazer !== true) {
    throw new ErroHttp(409, 'etiquetas_existentes',
      `Este pedido já tem ${plural(atuais.length, 'etiqueta', 'etiquetas')} no Melhor Envio. Siga com comprar, gerar, imprimir ou rastrear.`,
      { me_ordens: atuais });
  }
  const { frete } = await lerConfiguracoes();
  const servicoId = Number(pedido.entrega && pedido.entrega.servico_id);
  if (!Number.isSafeInteger(servicoId) || servicoId <= 0) {
    throw new ErroHttp(409, 'servico_invalido', 'O pedido não informa o serviço do Melhor Envio escolhido pelo cliente.');
  }
  if (!frete.origem.cep) {
    throw new ErroHttp(400, 'origem_incompleta', 'Preencha o CEP de origem nas configurações de frete.');
  }
  const chaveNfe = typeof corpo.chave_nfe === 'string' && corpo.chave_nfe.trim() ? corpo.chave_nfe.trim() : undefined;

  const itens = await itensComMedidas(pedido);
  const produtos = montarProdutosMelhorEnvio(itens, {
    seguro: frete.melhor_envio.seguro !== false,
    embalagem: frete.embalagem_padrao,
  });
  const cotacao = await calcular({
    de: frete.origem.cep,
    para: pedido.endereco && pedido.endereco.cep,
    produtos,
    servicos: [servicoId],
  });
  const cotado = cotacao.find((s) => s.servico_id === servicoId);
  if (!cotado || cotado.erro) {
    const motivo = cotado && cotado.erro ? ` Motivo: ${cotado.erro}` : '';
    throw new ErroHttp(409, 'servico_indisponivel',
      `O serviço ${(pedido.entrega && pedido.entrega.nome) || servicoId} não está disponível para este pedido agora.${motivo}`);
  }

  const corpos = montarItensCarrinho({
    servicoId,
    pacotes: cotado.pacotes,
    remetente: frete.origem,
    destinatario: destinatarioDoPedido(pedido),
    itens,
    chaveNfe,
    tag: `Pedido #${pedido.numero}`,
    urlPedido: `${siteUrl}/admin/#/pedidos/${pedido.id}`,
  });

  let criados;
  try {
    criados = await adicionarAoCarrinho(corpos);
  } catch (erro) {
    const orfaos = erro && erro.extra && Array.isArray(erro.extra.carrinho_orfaos) ? erro.extra.carrinho_orfaos : [];
    if (orfaos.length) {
      await registrarEvento(pedido.id, 'alerta',
        `Etiquetas ficaram no carrinho do Melhor Envio após uma falha: ${orfaos.map((o) => o.protocolo || o.id).join(', ')}. Remova-as no painel do Melhor Envio antes de tentar de novo.`,
        { carrinho_orfaos: orfaos }, autor);
    }
    throw erro;
  }

  const meOrdens = criados.map((c) => c.id);
  const etiquetas = criados.map((c) => ({
    id: c.id, protocolo: c.protocolo, servico_id: c.servico_id, preco_centavos: c.preco_centavos,
  }));
  const total = etiquetas.reduce((soma, e) => soma + (Number.isSafeInteger(e.preco_centavos) ? e.preco_centavos : 0), 0);
  await salvar(pedido, { me_ordens: meOrdens, etiqueta_url: null },
    `etiquetas ${etiquetas.map((e) => e.protocolo || e.id).join(', ')} no carrinho`);
  await registrarEvento(pedido.id, 'envio',
    `${plural(etiquetas.length, 'etiqueta adicionada', 'etiquetas adicionadas')} ao carrinho do Melhor Envio (${cotado.nome}, ${formatarReais(total)})`
      + `${chaveNfe ? ' com NF-e' : ' com declaração de conteúdo'}`,
    { acao: 'adicionar_carrinho', servico_id: servicoId, etiquetas, substituiu: atuais.length ? atuais : undefined, nfe: Boolean(chaveNfe) },
    autor);
  return { me_ordens: meOrdens, etiquetas, total_centavos: total };
}

async function acaoComprar({ pedido, autor }) {
  const ids = exigirEtiquetas(pedido);
  const etiquetas = [];
  for (const id of ids) etiquetas.push(await obterEtiqueta(id));
  const vivas = etiquetas.filter((e) => !e.cancelada);
  if (!vivas.length) {
    throw new ErroHttp(409, 'etiquetas_canceladas',
      'As etiquetas deste pedido foram canceladas no Melhor Envio. Adicione ao carrinho de novo (refazer).');
  }
  const pendentes = vivas.filter((e) => !e.paga);
  if (!pendentes.length) {
    return { me_ordens: ids, compra: null, mensagem: 'As etiquetas deste pedido já estavam pagas.' };
  }
  const precos = pendentes.map((e) => e.preco_centavos);
  const valor = precos.every((p) => Number.isSafeInteger(p) && p > 0) ? precos.reduce((a, b) => a + b, 0) : undefined;
  const compra = await comprar(pendentes.map((e) => e.id), { valorCentavos: valor });
  const totalCompra = compra.total_centavos ?? valor ?? null;
  await registrarEvento(pedido.id, 'envio',
    `${plural(pendentes.length, 'etiqueta comprada', 'etiquetas compradas')} no Melhor Envio${totalCompra !== null ? ` (${formatarReais(totalCompra)})` : ''}`,
    {
      acao: 'comprar', compra_id: compra.compra_id, protocolo: compra.protocolo, total_centavos: totalCompra,
      etiquetas: pendentes.map((e) => e.id),
    },
    autor);
  return {
    me_ordens: ids,
    compra: { compra_id: compra.compra_id, protocolo: compra.protocolo, total_centavos: totalCompra, status: compra.status },
  };
}

async function acaoGerar({ pedido, autor }) {
  const ids = exigirEtiquetas(pedido);
  const resultado = await gerar(ids);
  const falhas = Object.entries(resultado).filter(([, r]) => !r.ok);
  if (falhas.length === ids.length) {
    const motivos = [...new Set(falhas.map(([, r]) => r.mensagem).filter(Boolean))].join(' ');
    throw new ErroHttp(409, 'etiqueta_nao_gerada',
      `O Melhor Envio não gerou as etiquetas.${motivos ? ` ${motivos}` : ''} Confira se já foram compradas.`, { resultado });
  }
  await registrarEvento(pedido.id, 'envio',
    `Geração ${ids.length === 1 ? 'da etiqueta solicitada' : 'das etiquetas solicitada'} ao Melhor Envio`
      + (falhas.length ? ` (${plural(falhas.length, 'falhou', 'falharam')})` : ''),
    { acao: 'gerar', resultado }, autor);
  return { me_ordens: ids, resultado };
}

function juntarCodigos(lista) {
  const codigos = [...new Set(lista.filter((c) => typeof c === 'string' && CODIGO_VALIDO.test(c.trim())).map((c) => c.trim()))];
  const texto = codigos.join(', ');
  return texto && texto.length <= 200 ? texto : null;
}

async function acaoImprimir({ pedido, autor }) {
  const ids = exigirEtiquetas(pedido);
  // A geração é assíncrona: só imprime com generated_at preenchido em todas.
  const { pendentes, etiquetas } = await aguardarGeracao(ids, { tentativas: 2, intervaloMs: 800 });
  if (pendentes.length) {
    throw new ErroHttp(409, 'etiqueta_em_geracao',
      'O Melhor Envio ainda está gerando a etiqueta. Aguarde alguns instantes e tente imprimir de novo.', { pendentes });
  }
  const { url } = await imprimir(ids, { conferirGeracao: false });
  const codigos = juntarCodigos(ids.map((id) => etiquetas[id] && etiquetas[id].codigo_rastreio));
  const campos = { etiqueta_url: url };
  if (codigos) campos.codigo_rastreio = codigos;
  await salvar(pedido, campos, 'link de impressão gerado');
  await registrarEvento(pedido.id, 'envio',
    `${ids.length === 1 ? 'Etiqueta pronta' : 'Etiquetas prontas'} para impressão${codigos ? `. Rastreio: ${codigos}` : ''}`,
    { acao: 'imprimir', etiqueta_url: url, codigo_rastreio: codigos }, autor);
  return { me_ordens: ids, etiqueta_url: url, codigo_rastreio: codigos || pedido.codigo_rastreio || null };
}

async function acaoRastrear({ pedido, autor }) {
  const ids = exigirEtiquetas(pedido);
  const dados = await rastrear(ids);
  const lista = ids.map((id) => dados[id]).filter(Boolean);
  const codigos = juntarCodigos(lista.map((r) => r.codigo_rastreio));
  const url = lista.map((r) => r.url_rastreio).find((u) => typeof u === 'string' && u.length <= 500 && URL_RASTREIO_VALIDA.test(u)) || null;

  const campos = {};
  if (codigos && codigos !== pedido.codigo_rastreio) campos.codigo_rastreio = codigos;
  if (url && url !== pedido.url_rastreio) campos.url_rastreio = url;
  if (Object.keys(campos).length) {
    await salvar(pedido, campos, 'rastreio consultado');
    await registrarEvento(pedido.id, 'envio',
      codigos ? `Rastreio atualizado: ${codigos}` : 'Link de rastreio atualizado',
      { acao: 'rastrear', ...campos }, autor);
  }
  const etiquetas = {};
  for (const id of ids) {
    const r = dados[id];
    etiquetas[id] = r
      ? {
        status: r.status, codigo_rastreio: r.codigo_rastreio, url_rastreio: r.url_rastreio, posted_at: r.posted_at, delivered_at: r.delivered_at,
      }
      : null;
  }
  return {
    me_ordens: ids,
    codigo_rastreio: codigos || pedido.codigo_rastreio || null,
    url_rastreio: url || pedido.url_rastreio || null,
    etiquetas,
  };
}

const ACOES = {
  adicionar_carrinho: acaoAdicionarCarrinho,
  comprar: acaoComprar,
  gerar: acaoGerar,
  imprimir: acaoImprimir,
  rastrear: acaoRastrear,
};

export default async function handler(req, res) {
  if (!exigirMetodo(req, res, ['POST'])) return;
  const admin = await exigirAdmin(req, res);
  if (!admin) return;
  try {
    const corpo = await lerCorpo(req);
    const pedidoId = typeof corpo.pedido_id === 'string' ? corpo.pedido_id.trim().toLowerCase() : '';
    if (!validarUuid(pedidoId)) throw new ErroHttp(400, 'dados_invalidos', 'Pedido inválido.', { campo: 'pedido_id' });
    const acao = typeof corpo.acao === 'string' ? corpo.acao.trim() : '';
    if (!ACOES_ENVIO.includes(acao)) {
      throw new ErroHttp(400, 'acao_invalida', `Ação inválida. Use: ${ACOES_ENVIO.join(', ')}.`, { campo: 'acao' });
    }
    if (!obterAmbiente().melhorEnvioConfigurado) {
      throw new ErroHttp(503, 'frete_nao_configurado', 'O Melhor Envio não está configurado (falta MELHOR_ENVIO_TOKEN).');
    }

    const pedido = await buscarPedido(pedidoId, SELECT);
    if (!pedido) throw new ErroHttp(404, 'pedido_nao_encontrado', 'Pedido não encontrado.');
    if (!pedido.entrega || pedido.entrega.tipo !== 'melhor_envio') {
      throw new ErroHttp(409, 'envio_indisponivel', 'Este pedido não usa o Melhor Envio (frete fixo ou retirada).');
    }
    if (!STATUS_PERMITIDOS.includes(pedido.status)) {
      throw new ErroHttp(409, 'status_nao_permite_envio',
        'Só é possível cuidar das etiquetas de pedidos pagos, em separação ou enviados.');
    }

    const resultado = await ACOES[acao]({ pedido, corpo, autor: admin.email || 'admin', siteUrl: urlBase(req) });
    responderJson(res, 200, { ok: true, acao, ...resultado }, CABECALHOS_SEM_CACHE);
  } catch (erro) {
    tratarErro(res, erroDaLoja(erro));
  }
}
