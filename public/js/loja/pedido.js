// Pedido /loja/pedido?id=&token=[&payment_id=&status=…] — acompanhamento do pedido.
// Sem parâmetros: "Meus pedidos neste aparelho" (localStorage ama_pedidos_v1).

import { consultarPedido } from './api.js';
import { guardarPedido, lerPedidosGuardados, limparCarrinho } from './carrinho.js';
import {
  blocoEstado, botaoWhatsapp, definirMeta, el, icone, iniciarPagina, parametros, trocarConteudo,
} from './comum.js';
import {
  formatarData, formatarNumeroPedido, formatarPreco, pluralizar, urlSegura,
} from './formatos.js';

iniciarPagina();

const raiz = document.getElementById('pedido');
const migalha = document.querySelector('[data-migalha-pedido]');

const PAGOS = ['pago', 'em_separacao', 'enviado', 'entregue'];
const AGUARDANDO = ['aguardando_pagamento', 'pagamento_em_analise'];
const ETAPAS = ['aguardando_pagamento', 'pago', 'em_separacao', 'enviado', 'entregue'];

const params = parametros();
const id = (params.get('id') || '').trim();
const token = (params.get('token') || '').trim();
const paymentId = (params.get('payment_id') || params.get('collection_id') || '').trim();
const statusRetorno = (params.get('status') || params.get('collection_status') || '').trim();
const voltouDoPagamento = !!(paymentId || statusRetorno);
const pagamentoFalhou = /^(rejected|null|failure|cancelled)$/i.test(statusRetorno);

let tentativas = 0;
let timerAtualizacao = null;

// ---------------------------------------------------------------------------
// Textos

function rotuloEtapa(etapa, retirada) {
  switch (etapa) {
    case 'aguardando_pagamento': return 'Aguardando pagamento';
    case 'pago': return 'Pago';
    case 'em_separacao': return 'Em separação';
    case 'enviado': return retirada ? 'Pronto para retirada' : 'Enviado';
    case 'entregue': return retirada ? 'Retirado' : 'Entregue';
    default: return etapa;
  }
}

function situacao(pedido) {
  const retirada = pedido.entrega && pedido.entrega.tipo === 'retirada';
  const nome = pedido.primeiro_nome ? `, ${pedido.primeiro_nome}` : '';
  switch (pedido.status) {
    case 'aguardando_pagamento':
      return {
        titulo: `Olá${nome}!`,
        texto: pedido.pode_pagar
          ? 'Recebemos seu pedido. Falta só o pagamento: assim que ele for confirmado, a AMA começa a separar seus produtos.'
          : 'Recebemos seu pedido e estamos aguardando a confirmação do pagamento.',
        tom: 'aguardando',
      };
    case 'pagamento_em_analise':
      return {
        titulo: `Olá${nome}!`,
        texto: 'Seu pagamento está em análise pelo Mercado Pago. Pix costuma ser confirmado em minutos; boleto, em até 3 dias úteis.',
        tom: 'aguardando',
      };
    case 'pago':
      return { titulo: `Obrigada${nome}!`, texto: 'Pagamento confirmado! A AMA já vai separar seus produtos com carinho.', tom: 'ok' };
    case 'em_separacao':
      return { titulo: `Obrigada${nome}!`, texto: 'Seu pedido está sendo separado com carinho pela equipe da AMA.', tom: 'ok' };
    case 'enviado':
      return retirada
        ? { titulo: `Tudo pronto${nome}!`, texto: 'Seu pedido está pronto para retirada na sede da AMA. Combine o dia e o horário pelo WhatsApp.', tom: 'ok' }
        : { titulo: `A caminho${nome}!`, texto: 'Seu pedido foi enviado. Acompanhe a entrega pelo código de rastreio.', tom: 'ok' };
    case 'entregue':
      return { titulo: `Obrigada${nome}!`, texto: retirada ? 'Pedido retirado. Obrigada por comprar na AMA!' : 'Pedido entregue. Obrigada por comprar na AMA!', tom: 'ok' };
    case 'cancelado':
      return { titulo: 'Pedido cancelado', texto: 'Este pedido foi cancelado. Se você tiver dúvidas ou quiser comprar de novo, fale com a AMA.', tom: 'cancelado' };
    case 'reembolsado':
      return { titulo: 'Pagamento reembolsado', texto: 'O pagamento deste pedido foi devolvido. Se tiver dúvidas, fale com a AMA.', tom: 'cancelado' };
    default:
      return { titulo: `Olá${nome}!`, texto: 'Acompanhe aqui o andamento do seu pedido.', tom: 'aguardando' };
  }
}

// ---------------------------------------------------------------------------
// Blocos

function linhaDoTempo(pedido) {
  const retirada = pedido.entrega && pedido.entrega.tipo === 'retirada';
  const indice = pedido.status === 'pagamento_em_analise' ? 0 : ETAPAS.indexOf(pedido.status);
  const datas = { aguardando_pagamento: pedido.criado_em, pago: pedido.pago_em, enviado: pedido.enviado_em };
  return el('ol', { class: 'linha-tempo', 'aria-label': 'Andamento do pedido' },
    ETAPAS.map((etapa, i) => {
      // A etapa do status atual fica em destaque; se ela é um marco já cumprido (pago, enviado…)
      // aparece com o "check". Só "aguardando pagamento" é uma etapa ainda em andamento.
      const atual = i === indice;
      const feito = i < indice || (atual && !AGUARDANDO.includes(pedido.status));
      const classes = ['etapa'];
      if (feito) classes.push('etapa--feita');
      if (atual) classes.push('etapa--atual');
      if (!feito && !atual) classes.push('etapa--futura');
      if (i <= indice) classes.push('etapa--alcancada');
      if (i < indice) classes.push('etapa--antes');
      let detalhe = datas[etapa] && (feito || atual) ? formatarData(datas[etapa]) : '';
      if (atual && pedido.status === 'pagamento_em_analise') detalhe = 'Pagamento em análise';
      return el('li', { class: classes.join(' '), 'aria-current': atual ? 'step' : null },
        el('span', { class: 'etapa-marca', 'aria-hidden': 'true' }, feito ? icone('check') : atual ? icone('relogio') : String(i + 1)),
        el('span', { class: 'etapa-texto' },
          el('span', { class: 'etapa-rotulo', texto: rotuloEtapa(etapa, retirada) }),
          el('span', { class: 'sr-only', texto: feito ? ' (concluído)' : atual ? ' (etapa atual)' : ' (próxima etapa)' }),
          detalhe ? el('span', { class: 'etapa-data', texto: detalhe }) : null));
    }));
}

function blocoItens(pedido) {
  return el('section', { class: 'cartao-pedido', 'aria-labelledby': 'itens-titulo' },
    el('h2', { class: 'cartao-pedido-titulo', id: 'itens-titulo', texto: `Itens (${pedido.itens.reduce((s, i) => s + i.quantidade, 0)})` }),
    el('ul', { class: 'pedido-itens' }, pedido.itens.map((item) => {
      const imagem = urlSegura(item.imagem);
      return el('li', { class: 'pedido-item' },
        el('span', { class: 'pedido-item-foto', 'data-quadro-foto': true },
          imagem ? el('img', { src: imagem, alt: '', loading: 'lazy', decoding: 'async' }) : icone('folha')),
        el('span', { class: 'pedido-item-info' },
          el('span', { class: 'pedido-item-nome', texto: item.nome }),
          el('span', { class: 'pedido-item-detalhe', texto: `${item.quantidade} × ${formatarPreco(item.preco_unitario_centavos)}` })),
        el('span', { class: 'pedido-item-total', texto: formatarPreco(item.total_centavos) }));
    })));
}

function blocoTotais(pedido) {
  const retirada = pedido.entrega && pedido.entrega.tipo === 'retirada';
  const linha = (rotulo, valor, classe = '') => el('div', { class: `totais-linha${classe ? ` ${classe}` : ''}` }, el('dt', { texto: rotulo }), el('dd', { texto: valor }));
  return el('section', { class: 'cartao-pedido', 'aria-labelledby': 'totais-titulo' },
    el('h2', { class: 'cartao-pedido-titulo', id: 'totais-titulo', texto: 'Resumo' }),
    el('dl', { class: 'totais' },
      linha('Subtotal', formatarPreco(pedido.subtotal_centavos)),
      pedido.desconto_centavos > 0 ? linha('Desconto', `− ${formatarPreco(pedido.desconto_centavos)}`, 'totais-linha--desconto') : null,
      linha('Frete', pedido.frete_centavos > 0 ? formatarPreco(pedido.frete_centavos) : (retirada ? 'Sem custo' : 'Grátis'),
        pedido.frete_centavos > 0 ? '' : 'totais-linha--gratis'),
      linha('Total', formatarPreco(pedido.total_centavos), 'totais-linha--total')));
}

function blocoEntrega(pedido) {
  const entrega = pedido.entrega || {};
  const retirada = entrega.tipo === 'retirada';
  const numero = formatarNumeroPedido(pedido.numero);
  const conteudo = [];
  conteudo.push(el('p', { class: 'entrega-nome' },
    icone(retirada ? 'local' : 'caminhao'),
    el('span', {}, el('strong', { texto: entrega.nome || (retirada ? 'Retirada na sede da AMA' : 'Entrega') }),
      entrega.empresa ? el('span', { class: 'entrega-empresa', texto: ` · ${entrega.empresa}` }) : null)));
  if (retirada) {
    conteudo.push(el('p', { class: 'entrega-texto', texto: 'Retire na sede da AMA, em Ananindeua (PA). Combine o dia e o horário pelo WhatsApp.' }));
    conteudo.push(botaoWhatsapp('Combinar a retirada', `Olá, AMA! Quero combinar a retirada do pedido ${numero}.`, { classe: 'botao botao--whatsapp botao--sm' }));
  } else if (Number.isInteger(entrega.prazo_dias) && entrega.prazo_dias > 0) {
    conteudo.push(el('p', { class: 'entrega-texto', texto: `Prazo estimado: até ${pluralizar(entrega.prazo_dias, 'dia útil', 'dias úteis')} após o envio.` }));
  }
  const codigos = String(pedido.codigo_rastreio || '').split(',').map((c) => c.trim()).filter(Boolean);
  if (codigos.length) {
    const link = urlSegura(pedido.url_rastreio, { permitirRelativa: false });
    conteudo.push(el('div', { class: 'rastreio' },
      el('p', { class: 'rastreio-rotulo', texto: codigos.length > 1 ? 'Códigos de rastreio' : 'Código de rastreio' }),
      el('ul', { class: 'rastreio-codigos' }, codigos.map((codigo) => el('li', {}, el('code', { texto: codigo })))),
      link && link.startsWith('https://')
        ? el('a', { class: 'botao botao--principal botao--sm', href: link, target: '_blank', rel: 'noopener' }, icone('caminhao'), 'Acompanhar entrega')
        : null));
  }
  return el('section', { class: 'cartao-pedido', 'aria-labelledby': 'entrega-titulo' },
    el('h2', { class: 'cartao-pedido-titulo', id: 'entrega-titulo', texto: retirada ? 'Retirada' : 'Entrega' }),
    ...conteudo);
}

// ---------------------------------------------------------------------------
// Página do pedido

function renderizarPedido(pedido) {
  const numero = formatarNumeroPedido(pedido.numero);
  const info = situacao(pedido);
  definirMeta({ titulo: `Pedido ${numero} — Loja AMA` });
  migalha.textContent = `Pedido ${numero}`;

  const acoes = [];
  const link = pedido.pode_pagar ? urlSegura(pedido.link_pagamento, { permitirRelativa: false }) : '';
  if (link) {
    acoes.push(el('a', { class: 'botao botao--ouro', href: link }, icone('cadeado'), 'Pagar agora'));
  }
  acoes.push(botaoWhatsapp('Falar com a AMA', `Olá, AMA! Tenho uma dúvida sobre o pedido ${numero}.`,
    { classe: link ? 'botao botao--whatsapp-contorno' : 'botao botao--whatsapp' }));

  let avisoRetorno = null;
  if (voltouDoPagamento && pedido.status === 'aguardando_pagamento' && pagamentoFalhou) {
    avisoRetorno = el('p', { class: 'pedido-aviso pedido-aviso--erro', role: 'alert' }, icone('alerta'),
      'O pagamento não foi concluído. Nenhum valor foi cobrado: você pode tentar de novo com outra forma de pagamento.');
  } else if (timerAtualizacao) {
    avisoRetorno = el('p', { class: 'pedido-aviso' }, el('span', { class: 'girando', 'aria-hidden': 'true' }),
      'Estamos acompanhando a confirmação do pagamento. Esta página se atualiza sozinha.');
  }

  trocarConteudo(raiz,
    el('header', { class: `pedido-cabecalho pedido-cabecalho--${info.tom}` },
      el('div', { class: 'pedido-cabecalho-texto' },
        el('p', { class: 'pedido-numero' }, el('span', { texto: `Pedido ${numero}` }),
          pedido.criado_em ? el('span', { class: 'pedido-data', texto: ` · feito em ${formatarData(pedido.criado_em)}` }) : null),
        el('h1', { class: 'pedido-titulo', texto: info.titulo }),
        el('p', { class: 'pedido-texto', texto: info.texto }),
        avisoRetorno,
        el('div', { class: 'pedido-acoes' }, ...acoes)),
      el('span', { class: 'pedido-selo-status', texto: pedido.status === 'pagamento_em_analise' ? 'Pagamento em análise' : rotuloEtapa(pedido.status, pedido.entrega && pedido.entrega.tipo === 'retirada') })),
    el('div', { class: 'pedido-layout' },
      el('div', { class: 'pedido-principal' },
        ['cancelado', 'reembolsado'].includes(pedido.status)
          ? el('section', { class: 'cartao-pedido cartao-pedido--cancelado' },
            el('h2', { class: 'cartao-pedido-titulo', texto: 'Andamento' }),
            el('p', { class: 'pedido-cancelado' }, icone('info'),
              pedido.status === 'cancelado' ? 'Pedido cancelado.' : 'Pagamento reembolsado.'))
          : el('section', { class: 'cartao-pedido', 'aria-labelledby': 'andamento-titulo' },
            el('h2', { class: 'cartao-pedido-titulo', id: 'andamento-titulo', texto: 'Andamento' }),
            linhaDoTempo(pedido)),
        blocoItens(pedido)),
      el('div', { class: 'pedido-lateral' }, blocoTotais(pedido), blocoEntrega(pedido))),
    el('p', { class: 'pedido-rodape' },
      el('a', { class: 'link-seta link-seta--voltar', href: '/loja/' }, icone('voltar'), 'Voltar à loja'),
      el('a', { class: 'link-seta', href: '/loja/pedido' }, 'Meus pedidos neste aparelho')));
  raiz.setAttribute('aria-busy', 'false');
}

function renderizarNaoEncontrado() {
  definirMeta({ titulo: 'Pedido não encontrado — Loja AMA' });
  migalha.textContent = 'Pedido não encontrado';
  raiz.setAttribute('aria-busy', 'false');
  const guardados = lerPedidosGuardados().filter((p) => p.id !== id.toLowerCase());
  trocarConteudo(raiz,
    blocoEstado({
      icone: 'recibo',
      nivel: 'h1',
      titulo: 'Não encontramos este pedido',
      texto: 'O link pode estar incompleto. Use o link do e-mail de confirmação ou fale com a AMA pelo WhatsApp informando o número do pedido.',
      acoes: [
        botaoWhatsapp('Falar com a AMA', 'Olá, AMA! Não consegui abrir a página do meu pedido.'),
        el('a', { class: 'botao botao--fantasma', href: '/loja/' }, 'Voltar à loja'),
      ],
    }),
    guardados.length ? listaPedidos(guardados, 'Pedidos feitos neste aparelho') : null);
}

function renderizarErro(erro) {
  raiz.setAttribute('aria-busy', 'false');
  trocarConteudo(raiz, blocoEstado({
    tipo: 'erro',
    icone: 'alerta',
    nivel: 'h1',
    titulo: 'Não foi possível carregar o pedido',
    texto: erro && erro.mensagem ? erro.mensagem : 'Tente novamente em instantes.',
    acoes: [
      el('button', { type: 'button', class: 'botao botao--principal', onclick: () => carregar() }, 'Tentar novamente'),
      botaoWhatsapp('Falar com a AMA', 'Olá, AMA! Não consegui abrir a página do meu pedido.', { classe: 'botao botao--fantasma' }),
    ],
  }));
}

function esqueleto() {
  return el('div', { class: 'pedido-esqueleto', 'aria-hidden': 'true' },
    el('span', { class: 'esqueleto esqueleto-linha esqueleto-linha--curta' }),
    el('span', { class: 'esqueleto esqueleto-titulo' }),
    el('span', { class: 'esqueleto esqueleto-linha' }),
    el('span', { class: 'esqueleto esqueleto-bloco' }));
}

function agendarAtualizacao(pedido) {
  clearTimeout(timerAtualizacao);
  timerAtualizacao = null;
  if (!voltouDoPagamento || pagamentoFalhou || !AGUARDANDO.includes(pedido.status) || tentativas >= 10) return;
  timerAtualizacao = setTimeout(() => {
    tentativas += 1;
    carregar({ silencioso: true });
  }, 6000);
}

async function carregar({ silencioso = false } = {}) {
  if (!silencioso) {
    raiz.setAttribute('aria-busy', 'true');
    trocarConteudo(raiz, esqueleto());
  }
  try {
    // payment_id só na primeira consulta: sincroniza o pagamento mesmo sem webhook.
    const resposta = await consultarPedido({ id, token, paymentId: tentativas === 0 ? paymentId : '' });
    const pedido = resposta.pedido;
    guardarPedido({ id, token, numero: pedido.numero, criado_em: pedido.criado_em });
    if (voltouDoPagamento && (PAGOS.includes(pedido.status) || (statusRetorno === 'approved' && pedido.status !== 'cancelado'))) {
      limparCarrinho();
    }
    if (tentativas === 0 && voltouDoPagamento) {
      // Tira payment_id/status da barra de endereço (recarregar não sincroniza de novo).
      history.replaceState(null, '', `/loja/pedido?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`);
    }
    agendarAtualizacao(pedido);
    renderizarPedido(pedido);
  } catch (erro) {
    if (erro.status === 404) renderizarNaoEncontrado();
    else if (!silencioso) renderizarErro(erro);
  }
}

// ---------------------------------------------------------------------------
// Meus pedidos neste aparelho

function listaPedidos(pedidos, titulo) {
  return el('section', { class: 'meus-pedidos', 'aria-labelledby': 'meus-pedidos-titulo' },
    el('h2', { id: 'meus-pedidos-titulo', class: 'meus-pedidos-titulo', texto: titulo }),
    el('ul', { class: 'meus-pedidos-lista' }, pedidos.map((p) => el('li', {},
      el('a', { class: 'meu-pedido', href: `/loja/pedido?id=${encodeURIComponent(p.id)}&token=${encodeURIComponent(p.token)}` },
        el('span', { class: 'meu-pedido-icone' }, icone('recibo')),
        el('span', { class: 'meu-pedido-texto' },
          el('strong', { texto: p.numero ? `Pedido ${formatarNumeroPedido(p.numero)}` : 'Pedido' }),
          p.criado_em ? el('span', { texto: `Feito em ${formatarData(p.criado_em)}` }) : null),
        el('span', { class: 'meu-pedido-ver' }, 'Ver pedido', icone('seta')))))));
}

function renderizarMeusPedidos() {
  definirMeta({ titulo: 'Meus pedidos — Loja AMA' });
  raiz.setAttribute('aria-busy', 'false');
  const pedidos = lerPedidosGuardados();
  const cabecalho = el('header', { class: 'pagina-cabecalho' },
    el('h1', { texto: 'Meus pedidos' }),
    el('p', { class: 'pagina-subtitulo', texto: 'Pedidos feitos neste aparelho. O link de cada pedido também vai no e-mail de confirmação.' }));
  if (!pedidos.length) {
    trocarConteudo(raiz, cabecalho, blocoEstado({
      icone: 'recibo',
      titulo: 'Nenhum pedido por aqui ainda',
      texto: 'Quando você fizer uma compra neste aparelho, ela aparece aqui para você acompanhar.',
      acoes: [el('a', { class: 'botao botao--principal', href: '/loja/' }, 'Conhecer a loja', icone('seta'))],
    }));
    return;
  }
  trocarConteudo(raiz, cabecalho, listaPedidos(pedidos, pluralizar(pedidos.length, 'pedido', 'pedidos')));
}

if (!id || !token) renderizarMeusPedidos();
else carregar();
