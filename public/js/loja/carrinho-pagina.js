// Carrinho /loja/carrinho — itens, quantidades, frete por CEP e resumo.
// A cada mudança o carrinho é recotado no servidor (POST /api/loja/cotacao): preços, estoque
// e frete exibidos são sempre os da resposta.

import { cotar } from './api.js';
import {
  definirQuantidade, EVENTO, itensParaCotacao, lerCarrinho, lerPreferencias, removerDoCarrinho,
  salvarPreferencias, sincronizarComCotacao,
} from './carrinho.js';
import {
  aplicarMascara, blocoEstado, el, icone, iniciarPagina, toast, trocarConteudo,
} from './comum.js';
import {
  descreverMotivo, formatarPreco, mascararCep, pluralizar, somenteDigitos, validarCep,
} from './formatos.js';
import {
  avisoFreteGratis, blocoTotais, listaOpcoesFrete, opcaoEscolhida,
} from './resumo.js';
import { urlProduto } from './vitrine.js';

iniciarPagina();

const raiz = document.getElementById('carrinho');
const subtitulo = document.getElementById('carrinho-subtitulo');

const prefs = lerPreferencias();
const estado = {
  itens: lerCarrinho(),
  cotacao: null,
  erro: null,
  carregando: false,
  sequencia: 0,
  cep: prefs.cep,
  freteId: prefs.frete_id,
  freteErro: null,
};

const assinatura = (itens) => itens.map((i) => `${i.produto_id}:${i.quantidade}`).join('|');
let ultimaAssinatura = assinatura(estado.itens);

// Elementos fixos (montados uma vez para não perder foco nem o que foi digitado).
const lista = el('ul', { class: 'carrinho-lista', 'aria-label': 'Produtos no carrinho' });
const alertaItens = el('div', { class: 'carrinho-alerta', role: 'alert', hidden: true });
const areaFrete = el('div', { class: 'resumo-bloco' });
const areaAvisoFrete = el('div', { class: 'resumo-aviso-frete' });
const areaTotais = el('div', { class: 'resumo-totais' });
const areaErro = el('div', { class: 'resumo-erro', hidden: true });
const botaoFinalizar = el('a', { class: 'botao botao--ouro botao--bloco resumo-finalizar', href: '/loja/checkout' }, icone('cadeado'), 'Finalizar compra');
const motivoBloqueio = el('p', { class: 'resumo-bloqueio', id: 'resumo-bloqueio', hidden: true });

const inputCep = el('input', {
  id: 'carrinho-cep', type: 'text', inputmode: 'numeric', autocomplete: 'postal-code', maxlength: '9',
  placeholder: '00000-000', value: estado.cep ? mascararCep(estado.cep) : '', 'aria-describedby': 'carrinho-cep-erro',
});
aplicarMascara(inputCep, mascararCep);
const erroCep = el('p', { class: 'campo-erro', id: 'carrinho-cep-erro', hidden: true });
const opcoesFrete = el('div', { class: 'opcoes-frete opcoes-frete--compacta', role: 'radiogroup', 'aria-label': 'Opções de entrega' });
const formCep = el('form', {
  class: 'frete-cep', novalidate: true,
  onsubmit: (evento) => {
    evento.preventDefault();
    const cep = somenteDigitos(inputCep.value);
    if (!validarCep(cep)) {
      erroCep.textContent = 'Informe um CEP válido com 8 dígitos.';
      erroCep.hidden = false;
      inputCep.setAttribute('aria-invalid', 'true');
      inputCep.focus();
      return;
    }
    erroCep.hidden = true;
    inputCep.removeAttribute('aria-invalid');
    estado.cep = cep;
    salvarPreferencias({ cep });
    cotarAgora();
  },
},
el('label', { for: 'carrinho-cep', class: 'resumo-rotulo' }, icone('caminhao'), 'Entrega'),
el('div', { class: 'campo-com-acao' }, inputCep, el('button', { type: 'submit', class: 'botao botao--fantasma botao--sm' }, 'Calcular')),
erroCep);
areaFrete.append(formCep, opcoesFrete);

const resumo = el('aside', { class: 'resumo', 'aria-labelledby': 'resumo-titulo' },
  el('h2', { class: 'resumo-titulo', id: 'resumo-titulo', texto: 'Resumo' }),
  areaFrete, areaAvisoFrete, areaTotais, areaErro, motivoBloqueio, botaoFinalizar,
  el('p', { class: 'resumo-seguro' }, icone('escudo'), 'Pix, cartão ou boleto.'),
  el('a', { class: 'link-seta link-seta--voltar', href: '/loja/' }, icone('voltar'), 'Continuar comprando'));

const layout = el('div', { class: 'carrinho-layout' },
  el('section', { class: 'carrinho-itens', 'aria-label': 'Itens do carrinho' }, alertaItens, lista),
  resumo);

// ---------------------------------------------------------------------------

// Item da última cotação, só se ainda corresponde à quantidade atual (senão a cotação está velha).
function itemCotado(item) {
  const cotado = estado.cotacao && Array.isArray(estado.cotacao.itens)
    ? estado.cotacao.itens.find((i) => i.produto_id === item.produto_id) || null
    : null;
  return cotado && cotado.quantidade === item.quantidade ? cotado : null;
}

function mudarQuantidade(produtoId, quantidade) {
  definirQuantidade(produtoId, quantidade);
}

function linhaItem(item) {
  const cotado = itemCotado(item);
  const indisponivel = cotado && cotado.disponivel === false;
  const nome = (cotado && cotado.nome) || item.nome || 'Produto indisponível';
  const slug = (cotado && cotado.slug) || item.slug;
  const imagem = (cotado && cotado.imagem) || item.imagem;
  const unitario = cotado ? cotado.preco_unitario_centavos : item.preco_centavos;
  const limiteEstoque = cotado && Number.isInteger(cotado.estoque_disponivel) ? cotado.estoque_disponivel : 99;
  const maximo = Math.max(1, Math.min(99, limiteEstoque));
  const semPreco = cotado && cotado.motivo === 'sem_preco';
  const id = item.produto_id;

  const foto = imagem
    ? el('img', { src: imagem, alt: '', loading: 'lazy', decoding: 'async' })
    : el('span', { class: 'cartao-produto-sem-foto' }, icone('folha'));
  const titulo = slug && !(cotado && (cotado.motivo === 'inexistente' || cotado.motivo === 'inativo'))
    ? el('a', { href: urlProduto(slug), class: 'carrinho-item-nome', texto: nome })
    : el('span', { class: 'carrinho-item-nome', texto: nome });

  const quantidade = el('div', { class: 'quantidade quantidade--pequena', role: 'group', 'aria-label': `Quantidade de ${nome}` },
    el('button', {
      type: 'button', class: 'quantidade-botao', 'aria-label': `Diminuir quantidade de ${nome}`, 'data-foco': `menos-${id}`,
      disabled: item.quantidade <= 1,
      onclick: () => mudarQuantidade(id, item.quantidade - 1),
    }, icone('menos')),
    el('input', {
      type: 'number', class: 'quantidade-valor', min: '1', max: String(Math.max(maximo, item.quantidade)), value: String(item.quantidade),
      inputmode: 'numeric', 'aria-label': `Quantidade de ${nome}`, 'data-foco': `qtd-${id}`,
      onchange: (evento) => {
        const n = Math.floor(Number(evento.target.value));
        mudarQuantidade(id, Number.isFinite(n) && n >= 1 ? Math.min(99, n) : 1);
      },
    }),
    el('button', {
      type: 'button', class: 'quantidade-botao', 'aria-label': `Aumentar quantidade de ${nome}`, 'data-foco': `mais-${id}`,
      disabled: item.quantidade >= maximo,
      onclick: () => mudarQuantidade(id, item.quantidade + 1),
    }, icone('mais')));

  const remover = el('button', {
    type: 'button', class: 'carrinho-remover', 'aria-label': `Remover ${nome} do carrinho`,
    onclick: () => {
      removerDoCarrinho(id);
      toast(`${nome} saiu do carrinho.`, { tipo: 'info' });
    },
  }, icone('lixeira'), el('span', { texto: 'Remover' }));

  let aviso = null;
  if (indisponivel) {
    const acoes = [];
    if (cotado.motivo === 'estoque_insuficiente' && cotado.estoque_disponivel > 0) {
      acoes.push(el('button', {
        type: 'button', class: 'botao botao--principal botao--sm', 'data-foco': `ajustar-${id}`,
        onclick: () => mudarQuantidade(id, cotado.estoque_disponivel),
      }, `Ajustar para ${cotado.estoque_disponivel}`));
    }
    aviso = el('div', { class: 'carrinho-item-aviso' },
      icone('alerta'),
      el('p', { texto: descreverMotivo(cotado.motivo, cotado.estoque_disponivel) }),
      acoes.length ? el('div', { class: 'carrinho-item-aviso-acoes' }, ...acoes) : null);
  }

  // Sem quantidade a ajustar quando o produto não pode ser comprado de jeito nenhum.
  const semAjuste = indisponivel && cotado.motivo !== 'estoque_insuficiente';
  const semDados = cotado && (cotado.motivo === 'inexistente' || cotado.motivo === 'inativo');

  const totalLinha = cotado
    ? (cotado.disponivel ? formatarPreco(cotado.total_centavos) : '—')
    : formatarPreco(unitario * item.quantidade);

  return el('li', { class: `carrinho-item${indisponivel ? ' carrinho-item--indisponivel' : ''}` },
    el('div', { class: 'carrinho-item-foto', 'data-quadro-foto': true }, foto),
    el('div', { class: 'carrinho-item-info' },
      titulo,
      semDados ? null : el('p', { class: 'carrinho-item-unitario' },
        el('span', { class: 'sr-only', texto: 'Preço unitário: ' }),
        formatarPreco(unitario, { zeroComoEmProducao: semPreco }),
        el('span', { class: 'carrinho-item-cada', texto: ' cada' }))),
    el('div', { class: 'carrinho-item-controles' }, semAjuste ? null : quantidade, remover),
    el('p', { class: 'carrinho-item-total' }, el('span', { class: 'sr-only', texto: 'Total do item: ' }), totalLinha),
    aviso);
}

function renderizarItens() {
  const focoAntes = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.foco : null;
  trocarConteudo(lista, estado.itens.map(linhaItem));
  if (focoAntes) {
    const alvo = lista.querySelector(`[data-foco="${CSS.escape(focoAntes)}"]`);
    if (alvo && !alvo.disabled) alvo.focus();
    else lista.querySelector(`[data-foco="qtd-${CSS.escape(focoAntes.replace(/^(menos|mais|ajustar|qtd)-/, ''))}"]`)?.focus();
  }
  const indisponiveis = estado.cotacao ? estado.cotacao.itens.filter((i) => i.disponivel === false).length : 0;
  alertaItens.hidden = !indisponiveis;
  if (indisponiveis) {
    trocarConteudo(alertaItens, icone('alerta'),
      el('p', { texto: indisponiveis === 1
        ? 'Um item do carrinho está indisponível. Ajuste ou remova para finalizar a compra.'
        : `${indisponiveis} itens do carrinho estão indisponíveis. Ajuste ou remova para finalizar a compra.` }));
  }
  const unidades = estado.itens.reduce((s, i) => s + i.quantidade, 0);
  subtitulo.textContent = pluralizar(unidades, 'item', 'itens');
}

function renderizarResumo() {
  const c = estado.cotacao;
  // Frete
  const opcoes = c && c.frete && Array.isArray(c.frete.opcoes) ? c.frete.opcoes : [];
  const avisos = [];
  if (c && c.frete && c.frete.erro) avisos.push(el('p', { class: 'frete-aviso', texto: c.frete.erro }));
  if (opcoes.length) {
    trocarConteudo(opcoesFrete, listaOpcoesFrete(opcoes, estado.freteId, (id) => {
      estado.freteId = id;
      salvarPreferencias({ frete_id: id });
      renderizarResumo();
      opcoesFrete.querySelector(`input[value="${CSS.escape(id)}"]`)?.focus();
    }, { nome: 'carrinho-frete' }), avisos);
  } else {
    trocarConteudo(opcoesFrete, avisos.length ? avisos : el('p', { class: 'resumo-dica', texto: estado.cep ? '' : 'Informe seu CEP para ver o frete e o prazo.' }));
  }

  trocarConteudo(areaAvisoFrete, avisoFreteGratis(c));

  if (c) {
    const opcao = opcaoEscolhida(c, estado.freteId);
    trocarConteudo(areaTotais, blocoTotais(c, opcao, { semFreteTexto: 'Informe o CEP', atualizando: estado.carregando }));
  } else if (estado.carregando) {
    trocarConteudo(areaTotais, el('div', { class: 'totais-esqueleto', 'aria-hidden': 'true' },
      el('span', { class: 'esqueleto esqueleto-linha' }), el('span', { class: 'esqueleto esqueleto-linha' }),
      el('span', { class: 'esqueleto esqueleto-linha esqueleto-linha--media' })));
  } else {
    trocarConteudo(areaTotais);
  }

  areaErro.hidden = !estado.erro;
  if (estado.erro) {
    trocarConteudo(areaErro, icone('alerta'),
      el('p', { texto: estado.erro.mensagem || 'Não foi possível atualizar o carrinho.' }),
      el('button', { type: 'button', class: 'botao botao--fantasma botao--sm', onclick: () => cotarAgora() }, 'Tentar novamente'));
  }

  const bloqueado = c ? c.itens.some((i) => i.disponivel === false) : false;
  motivoBloqueio.hidden = !bloqueado;
  motivoBloqueio.textContent = bloqueado ? 'Ajuste ou remova os itens indisponíveis para continuar.' : '';
  botaoFinalizar.classList.toggle('botao--desativado', bloqueado);
  if (bloqueado) {
    botaoFinalizar.removeAttribute('href');
    botaoFinalizar.setAttribute('aria-disabled', 'true');
    botaoFinalizar.setAttribute('aria-describedby', 'resumo-bloqueio');
  } else {
    botaoFinalizar.setAttribute('href', '/loja/checkout');
    botaoFinalizar.removeAttribute('aria-disabled');
    botaoFinalizar.removeAttribute('aria-describedby');
  }
}

function renderizarVazio() {
  subtitulo.textContent = '';
  trocarConteudo(raiz, blocoEstado({
    icone: 'carrinho',
    titulo: 'Seu carrinho está vazio',
    texto: 'Conheça os cosméticos Ama Bioessência e as biojoias feitas por mulheres da Amazônia.',
    acoes: [el('a', { class: 'botao botao--principal', href: '/loja/' }, 'Conhecer a loja', icone('seta'))],
  }));
}

function renderizar() {
  if (!estado.itens.length) {
    renderizarVazio();
    return;
  }
  if (!raiz.contains(layout)) trocarConteudo(raiz, layout);
  renderizarItens();
  renderizarResumo();
}

// ---------------------------------------------------------------------------
// Cotação

let esperaCotacao = null;

function agendarCotacao() {
  clearTimeout(esperaCotacao);
  esperaCotacao = setTimeout(() => cotarAgora(), 350);
}

async function cotarAgora() {
  clearTimeout(esperaCotacao);
  const sequencia = ++estado.sequencia;
  const itens = itensParaCotacao(estado.itens);
  if (!itens.length) {
    estado.cotacao = null;
    renderizar();
    return;
  }
  estado.carregando = true;
  renderizarResumo();
  try {
    const cotacao = await cotar({ itens, cep: estado.cep });
    if (sequencia !== estado.sequencia) return;
    estado.cotacao = cotacao;
    estado.erro = null;
    const opcoes = cotacao.frete && Array.isArray(cotacao.frete.opcoes) ? cotacao.frete.opcoes : [];
    if (opcoes.length && !opcoes.some((o) => o.id === estado.freteId)) {
      estado.freteId = opcoes[0].id;
      salvarPreferencias({ frete_id: estado.freteId });
    }
    estado.itens = sincronizarComCotacao(cotacao.itens);
    ultimaAssinatura = assinatura(estado.itens);
  } catch (erro) {
    if (sequencia !== estado.sequencia) return;
    estado.erro = erro;
    if (erro.erro === 'carrinho_vazio') estado.cotacao = null;
  } finally {
    if (sequencia === estado.sequencia) {
      estado.carregando = false;
      renderizar();
    }
  }
}

// Mudanças no carrinho (desta página ou de outra aba): redesenha na hora e recota.
window.addEventListener(EVENTO, () => {
  estado.itens = lerCarrinho();
  const nova = assinatura(estado.itens);
  if (nova === ultimaAssinatura) return;
  ultimaAssinatura = nova;
  renderizar();
  if (estado.itens.length) agendarCotacao();
});

renderizar();
if (estado.itens.length) cotarAgora();
