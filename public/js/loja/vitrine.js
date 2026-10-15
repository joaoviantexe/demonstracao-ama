// Cartão de produto da vitrine (catálogo e "você também pode gostar") e o esqueleto de carregamento.

import { adicionarAoCarrinho } from './carrinho.js';
import { formatarPreco } from './formatos.js';
import { analisarProduto, imagemPrincipal } from './produtos.js';
import {
  ajustarFoto, el, icone, toast,
} from './comum.js';

export const urlProduto = (slug) => `/loja/produto?slug=${encodeURIComponent(slug)}`;

/** Selos do produto: Promoção, Esgotado, Em breve. */
export function selosDoProduto(situacao) {
  const selos = [];
  if (situacao.emBreve) selos.push(el('span', { class: 'selo selo--em-breve', texto: 'Em breve' }));
  if (situacao.promocao) selos.push(el('span', { class: 'selo selo--promocao', texto: 'Promoção' }));
  if (situacao.esgotado) selos.push(el('span', { class: 'selo selo--esgotado', texto: 'Esgotado' }));
  return selos;
}

/** Preço com o valor antigo riscado na promoção e "R$ 00,00" para produto sem preço. */
export function blocoPreco(situacao, { classe = 'preco' } = {}) {
  return el('p', { class: classe },
    situacao.precoOriginal !== null
      ? el('s', { class: 'preco-antigo' }, el('span', { class: 'sr-only', texto: 'De ' }), formatarPreco(situacao.precoOriginal))
      : null,
    el('span', { class: 'preco-atual' },
      situacao.precoOriginal !== null ? el('span', { class: 'sr-only', texto: 'por ' }) : null,
      formatarPreco(situacao.preco, { zeroComoEmProducao: true })));
}

/** Adiciona 1 unidade e avisa com um toast. */
export function adicionarComAviso(produto, quantidade = 1) {
  const situacao = analisarProduto(produto);
  const img = imagemPrincipal(produto);
  const resultado = adicionarAoCarrinho({
    id: produto.id, nome: produto.nome, slug: produto.slug, preco_centavos: situacao.preco, imagem: img ? img.src : '',
  }, quantidade, { maximo: situacao.maxQuantidade });
  if (resultado.ok && !resultado.limitado) {
    toast(`${produto.nome} foi adicionado ao carrinho.`, { tipo: 'sucesso', acao: { texto: 'Ver carrinho', href: '/loja/carrinho' } });
  } else if (resultado.ok) {
    toast(`Adicionamos até o limite disponível: ${resultado.quantidade} no carrinho.`, { tipo: 'info', acao: { texto: 'Ver carrinho', href: '/loja/carrinho' } });
  } else if (resultado.motivo === 'maximo') {
    toast(`Você já tem a quantidade máxima disponível de ${produto.nome} no carrinho.`, { tipo: 'info', acao: { texto: 'Ver carrinho', href: '/loja/carrinho' } });
  } else if (resultado.motivo === 'limite_linhas') {
    toast('Seu carrinho chegou ao limite de 30 produtos diferentes. Finalize esta compra para continuar.', { tipo: 'erro' });
  } else {
    toast('Não foi possível adicionar este produto.', { tipo: 'erro' });
  }
  if (resultado.ok) {
    document.querySelectorAll('.topo-carrinho').forEach((link) => {
      link.classList.remove('topo-carrinho--pulso');
      void link.offsetWidth;
      link.classList.add('topo-carrinho--pulso');
    });
  }
  return resultado;
}

/** Cartão de produto (article). `nivel` é a tag do título (h2/h3). */
export function cartaoProduto(produto, { nivel = 'h3', carregamento = 'lazy' } = {}) {
  const situacao = analisarProduto(produto);
  const img = imagemPrincipal(produto);
  const href = urlProduto(produto.slug);
  const classes = ['cartao-produto'];
  if (situacao.emBreve) classes.push('cartao-produto--em-breve');
  if (situacao.esgotado) classes.push('cartao-produto--esgotado');

  let foto = null;
  if (img) {
    foto = el('img', {
      src: img.src, alt: img.alt || produto.nome, loading: carregamento, decoding: 'async',
    });
    ajustarFoto(foto);
  } else {
    foto = el('span', { class: 'cartao-produto-sem-foto' }, icone('folha'));
  }

  let acao;
  if (situacao.emBreve) {
    acao = el('button', { type: 'button', class: 'botao botao--principal botao--bloco botao--sm cartao-produto-botao', disabled: true }, 'Em breve');
  } else if (situacao.esgotado) {
    acao = el('button', { type: 'button', class: 'botao botao--principal botao--bloco botao--sm cartao-produto-botao', disabled: true }, 'Esgotado');
  } else {
    acao = el('button', {
      type: 'button', class: 'botao botao--principal botao--bloco botao--sm cartao-produto-botao',
      'aria-label': `Adicionar ao carrinho: ${produto.nome}`,
      onclick: () => adicionarComAviso(produto, 1),
    }, icone('carrinho'), el('span', { class: 'rotulo-longo', texto: 'Adicionar ao carrinho' }), el('span', { class: 'rotulo-curto', texto: 'Adicionar' }));
  }

  return el('article', { class: classes.join(' ') },
    el('div', { class: 'cartao-produto-midia', 'data-quadro-foto': true },
      foto,
      el('div', { class: 'cartao-produto-selos' }, ...selosDoProduto(situacao))),
    el('div', { class: 'cartao-produto-corpo' },
      produto.categoria ? el('p', { class: 'cartao-produto-categoria', texto: produto.categoria.nome }) : null,
      el(nivel, { class: 'cartao-produto-nome' }, el('a', { href, class: 'cartao-produto-link', texto: produto.nome })),
      blocoPreco(situacao, { classe: 'preco cartao-produto-preco' }),
      el('div', { class: 'cartao-produto-acao' }, acao)));
}

/** Cartão "fantasma" enquanto os produtos carregam. */
export function esqueletoCartao() {
  return el('div', { class: 'cartao-produto cartao-produto--esqueleto', 'aria-hidden': 'true' },
    el('div', { class: 'cartao-produto-midia esqueleto' }),
    el('div', { class: 'cartao-produto-corpo' },
      el('span', { class: 'esqueleto esqueleto-linha esqueleto-linha--curta' }),
      el('span', { class: 'esqueleto esqueleto-linha' }),
      el('span', { class: 'esqueleto esqueleto-linha esqueleto-linha--media' }),
      el('span', { class: 'esqueleto esqueleto-botao' })));
}
