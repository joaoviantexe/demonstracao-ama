// Página do produto /loja/produto?slug= — galeria, preço, quantidade, carrinho, frete e relacionados.

import { cotar } from './api.js';
import { lerCarrinho, lerPreferencias, salvarPreferencias, definirQuantidade } from './carrinho.js';
import { buscarProdutoPorSlug, buscarRelacionados, lojaConfigurada } from './config.js';
import {
  ajustarFoto, aplicarMascara, blocoEstado, definirMeta, el, icone, iniciarPagina,
  parametros, trocarConteudo,
} from './comum.js';
import {
  formatarPreco, formatarPrazo, mascararCep, somenteDigitos, validarCep,
} from './formatos.js';
import {
  analisarProduto, imagemPrincipal, normalizarProduto,
} from './produtos.js';
import {
  adicionarComAviso, blocoPreco, cartaoProduto, esqueletoCartao, selosDoProduto,
} from './vitrine.js';

iniciarPagina();

const raiz = document.getElementById('produto');
const migalhaCategoria = document.querySelector('[data-migalha-categoria]');
const migalhaProduto = document.querySelector('[data-migalha-produto]');
const secaoRelacionados = document.getElementById('relacionados');
const gradeRelacionados = document.getElementById('relacionados-grade');
const tituloRelacionados = document.getElementById('relacionados-titulo');

function esqueletoFicha() {
  return el('div', { class: 'ficha ficha--esqueleto', 'aria-hidden': 'true' },
    el('div', { class: 'ficha-galeria' }, el('div', { class: 'galeria-principal esqueleto' })),
    el('div', { class: 'ficha-info' },
      el('span', { class: 'esqueleto esqueleto-linha esqueleto-linha--curta' }),
      el('span', { class: 'esqueleto esqueleto-titulo' }),
      el('span', { class: 'esqueleto esqueleto-linha esqueleto-linha--media' }),
      el('span', { class: 'esqueleto esqueleto-bloco' }),
      el('span', { class: 'esqueleto esqueleto-botao' })));
}

/** Texto com quebras de linha → parágrafos (linhas em branco) e <br> (quebras simples). */
function paragrafos(texto) {
  const blocos = String(texto || '').replace(/\r\n?/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocos.map((bloco) => {
    const p = el('p');
    bloco.split('\n').forEach((linha, i) => {
      if (i) p.append(el('br'));
      p.append(linha);
    });
    return p;
  });
}

// ---------------------------------------------------------------------------
// Galeria

function galeria(produto, situacao) {
  const imagens = produto.imagens;
  const principal = el('div', { class: 'galeria-principal', 'data-quadro-foto': true });
  const selos = el('div', { class: 'cartao-produto-selos galeria-selos' }, ...selosDoProduto(situacao));
  let foto;
  if (imagens.length) {
    foto = el('img', { src: imagens[0].src, alt: imagens[0].alt || produto.nome, decoding: 'async', fetchpriority: 'high' });
    ajustarFoto(foto);
    principal.append(foto, selos);
  } else {
    principal.append(el('span', { class: 'cartao-produto-sem-foto' }, icone('folha')), selos);
  }
  const blocos = [principal];
  if (imagens.length > 1) {
    const miniaturas = el('div', { class: 'galeria-miniaturas', role: 'group', 'aria-label': 'Fotos do produto' });
    imagens.forEach((img, i) => {
      const botao = el('button', {
        type: 'button',
        class: 'galeria-miniatura',
        'aria-label': `Ver foto ${i + 1} de ${imagens.length}`,
        'aria-pressed': i === 0 ? 'true' : 'false',
        onclick: () => {
          miniaturas.querySelectorAll('.galeria-miniatura').forEach((b) => b.setAttribute('aria-pressed', 'false'));
          botao.setAttribute('aria-pressed', 'true');
          principal.classList.remove('foto--paisagem');
          principal.style.removeProperty('--fundo-foto');
          foto.setAttribute('src', img.src);
          foto.setAttribute('alt', img.alt || produto.nome);
          ajustarFoto(foto);
        },
      }, el('img', { src: img.src, alt: '', loading: 'lazy', decoding: 'async' }));
      miniaturas.append(botao);
    });
    blocos.push(miniaturas);
  }
  return el('div', { class: 'ficha-galeria' }, ...blocos);
}

// ---------------------------------------------------------------------------
// Quantidade, compra e frete

function seletorQuantidade(maximo, aoMudar) {
  const input = el('input', {
    id: 'quantidade', type: 'number', min: '1', max: String(maximo), value: '1', inputmode: 'numeric',
    class: 'quantidade-valor', 'aria-describedby': 'quantidade-ajuda',
  });
  const menos = el('button', { type: 'button', class: 'quantidade-botao', 'aria-label': 'Diminuir quantidade' }, icone('menos'));
  const mais = el('button', { type: 'button', class: 'quantidade-botao', 'aria-label': 'Aumentar quantidade' }, icone('mais'));
  const ler = () => {
    const n = Math.floor(Number(input.value));
    return Number.isFinite(n) ? Math.min(maximo, Math.max(1, n)) : 1;
  };
  const definir = (n) => {
    input.value = String(Math.min(maximo, Math.max(1, n)));
    menos.disabled = Number(input.value) <= 1;
    mais.disabled = Number(input.value) >= maximo;
    aoMudar(Number(input.value));
  };
  menos.addEventListener('click', () => definir(ler() - 1));
  mais.addEventListener('click', () => definir(ler() + 1));
  input.addEventListener('change', () => definir(ler()));
  definir(1);
  return {
    elemento: el('div', { class: 'quantidade' }, menos, input, mais),
    ler,
  };
}

function calculadoraFrete(produto, lerQuantidade) {
  const prefs = lerPreferencias();
  const input = el('input', {
    id: 'frete-cep', type: 'text', inputmode: 'numeric', autocomplete: 'postal-code', maxlength: '9',
    placeholder: '00000-000', value: prefs.cep ? mascararCep(prefs.cep) : '', 'aria-describedby': 'frete-resultado',
  });
  aplicarMascara(input, mascararCep);
  const botao = el('button', { type: 'submit', class: 'botao botao--fantasma botao--sm' }, 'Calcular');
  const resultado = el('div', { class: 'frete-resultado', id: 'frete-resultado', 'aria-live': 'polite' });

  const calcular = async () => {
    const cep = somenteDigitos(input.value);
    if (!validarCep(cep)) {
      trocarConteudo(resultado, el('p', { class: 'campo-erro', texto: 'Informe um CEP válido com 8 dígitos.' }));
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    input.removeAttribute('aria-invalid');
    salvarPreferencias({ cep });
    botao.disabled = true;
    trocarConteudo(resultado, el('p', { class: 'frete-carregando', texto: 'Calculando…' }));
    try {
      const cotacao = await cotar({ itens: [{ produto_id: produto.id, quantidade: lerQuantidade() }], cep });
      const opcoes = cotacao.frete && Array.isArray(cotacao.frete.opcoes) ? cotacao.frete.opcoes : [];
      const lista = el('ul', { class: 'frete-opcoes-lista' }, opcoes.map((o) => el('li', { class: 'frete-opcao-linha' },
        el('span', { class: 'frete-opcao-nome' },
          el('strong', { texto: o.nome }),
          o.empresa ? el('span', { class: 'frete-opcao-empresa', texto: o.empresa }) : null,
          el('span', { class: 'frete-opcao-prazo', texto: formatarPrazo(o) })),
        el('span', { class: `frete-opcao-preco${o.gratis ? ' frete-opcao-preco--gratis' : ''}` },
          o.gratis || o.preco_centavos === 0 ? (o.tipo === 'retirada' ? 'Sem custo' : 'Grátis') : formatarPreco(o.preco_centavos)))));
      trocarConteudo(resultado,
        opcoes.length ? lista : null,
        cotacao.frete && cotacao.frete.erro ? el('p', { class: 'frete-aviso', texto: cotacao.frete.erro }) : null,
        !opcoes.length && !(cotacao.frete && cotacao.frete.erro)
          ? el('p', { class: 'frete-aviso', texto: 'Nenhuma opção de entrega para este CEP. Confira o CEP digitado.' }) : null);
    } catch (erro) {
      trocarConteudo(resultado, el('p', { class: 'campo-erro', texto: erro.mensagem || 'Não foi possível calcular o frete agora.' }));
    } finally {
      botao.disabled = false;
    }
  };

  const form = el('form', {
    class: 'frete-calculo', novalidate: true,
    onsubmit: (evento) => {
      evento.preventDefault();
      calcular();
    },
  },
  el('label', { for: 'frete-cep', class: 'frete-calculo-rotulo' }, icone('caminhao'), 'Calcular frete e prazo'),
  el('div', { class: 'frete-calculo-linha' }, input, botao),
  el('a', {
    class: 'frete-calculo-ajuda', href: 'https://buscacepinter.correios.com.br/app/endereco/index.php', target: '_blank', rel: 'noopener',
  }, 'Não sei meu CEP'),
  resultado);
  return form;
}

function areaCompra(produto, situacao) {
  const blocos = [];
  if (situacao.vendavel) {
    let quantidadeAtual = 1;
    const ajuda = el('p', { class: 'quantidade-ajuda', id: 'quantidade-ajuda' });
    const seletor = seletorQuantidade(situacao.maxQuantidade, (n) => { quantidadeAtual = n; });
    if (produto.controlar_estoque && produto.estoque <= 5) {
      ajuda.textContent = produto.estoque === 1 ? 'Última unidade!' : `Últimas ${produto.estoque} unidades`;
    } else {
      ajuda.hidden = true;
    }
    const adicionar = el('button', {
      type: 'button', class: 'botao botao--principal ficha-botao',
      onclick: () => adicionarComAviso(produto, seletor.ler()),
    }, icone('carrinho'), 'Adicionar ao carrinho');
    const comprar = el('button', {
      type: 'button', class: 'botao botao--ouro ficha-botao',
      onclick: () => {
        // Garante pelo menos a quantidade escolhida no carrinho e segue para o checkout.
        const linha = lerCarrinho().find((i) => i.produto_id === produto.id);
        if (linha) {
          if (linha.quantidade < seletor.ler()) definirQuantidade(produto.id, Math.min(situacao.maxQuantidade, seletor.ler()));
        } else {
          const r = adicionarComAviso(produto, seletor.ler());
          if (!r.ok) return;
        }
        location.assign('/loja/checkout');
      },
    }, 'Comprar agora', icone('seta'));
    blocos.push(
      el('div', { class: 'ficha-compra' },
        el('div', { class: 'ficha-quantidade' },
          el('label', { for: 'quantidade', class: 'ficha-rotulo', texto: 'Quantidade' }),
          seletor.elemento,
          ajuda),
        el('div', { class: 'ficha-botoes' }, adicionar, comprar)),
    );
    blocos.push(calculadoraFrete(produto, () => quantidadeAtual));
  } else {
    blocos.push(
      el('div', { class: 'ficha-aviso ficha-aviso--esgotado' },
        icone('info'),
        el('div', {},
          el('strong', { texto: 'Esgotado no momento' }),
          el('p', { texto: 'Este produto acabou. Volte em breve para conferir a reposição.' }))),
      el('div', { class: 'ficha-botoes' },
        el('button', { type: 'button', class: 'botao botao--principal ficha-botao', disabled: true }, icone('carrinho'), 'Adicionar ao carrinho'),
        el('button', { type: 'button', class: 'botao botao--ouro ficha-botao', disabled: true }, 'Comprar agora')),
    );
  }
  return blocos;
}

// ---------------------------------------------------------------------------

function renderizarProduto(produto) {
  const situacao = analisarProduto(produto);
  const img = imagemPrincipal(produto);
  definirMeta({
    titulo: `${produto.nome} — Cosméticos`,
    descricao: produto.descricao || `${produto.nome} na loja virtual da AMA — Associação de Mulheres na Amazônia.`,
  });
  if (img) document.querySelector('meta[property="og:image"]')?.setAttribute('content', img.src);
  migalhaProduto.textContent = produto.nome;
  if (produto.categoria) {
    trocarConteudo(migalhaCategoria, el('a', { href: `/loja/?categoria=${encodeURIComponent(produto.categoria.slug)}`, texto: produto.categoria.nome }));
    migalhaCategoria.hidden = false;
  }

  let estoque = null;
  if (situacao.vendavel) {
    estoque = el('p', { class: 'ficha-estoque ficha-estoque--ok' }, el('span', { class: 'ponto', 'aria-hidden': 'true' }), 'Em estoque');
  } else if (situacao.esgotado) {
    estoque = el('p', { class: 'ficha-estoque ficha-estoque--fora' }, el('span', { class: 'ponto', 'aria-hidden': 'true' }), 'Esgotado');
  }

  const economia = situacao.promocao
    ? el('p', { class: 'ficha-economia', texto: `Você economiza ${formatarPreco(situacao.precoOriginal - situacao.preco)} (${situacao.descontoPercentual}%)` })
    : null;

  const descricao = produto.descricao.trim()
    ? paragrafos(produto.descricao)
    : [el('p', { texto: 'Descrição em Produção' })];

  trocarConteudo(raiz,
    el('article', { class: 'ficha', 'aria-labelledby': 'ficha-nome' },
      galeria(produto, situacao),
      el('div', { class: 'ficha-info' },
        produto.categoria
          ? el('a', { class: 'ficha-categoria', href: `/loja/?categoria=${encodeURIComponent(produto.categoria.slug)}`, texto: produto.categoria.nome })
          : null,
        el('h1', { class: 'ficha-nome', id: 'ficha-nome', texto: produto.nome }),
        el('div', { class: 'ficha-preco-bloco' },
          blocoPreco(situacao, { classe: 'preco ficha-preco' }),
          economia,
          situacao.vendavel ? el('p', { class: 'ficha-parcelas', texto: 'Pague com Pix, cartão ou boleto' }) : null),
        estoque,
        ...areaCompra(produto, situacao),
        el('ul', { class: 'ficha-garantias' },
          el('li', {}, icone('escudo'), 'Compra segura'),
          el('li', {}, icone('coracao'), 'Feito por mulheres da Amazônia')))),
    el('section', { class: 'ficha-descricao', 'aria-labelledby': 'descricao-titulo' },
      el('h2', { id: 'descricao-titulo', texto: 'Sobre o produto' }),
      el('div', { class: 'ficha-descricao-texto' }, ...descricao)));
  raiz.setAttribute('aria-busy', 'false');
}

function renderizarNaoEncontrado() {
  definirMeta({ titulo: 'Produto não encontrado — Cosméticos' });
  migalhaProduto.textContent = 'Produto não encontrado';
  raiz.setAttribute('aria-busy', 'false');
  trocarConteudo(raiz, blocoEstado({
    icone: 'busca',
    nivel: 'h1',
    titulo: 'Produto não encontrado',
    texto: 'Este produto não está disponível. Ele pode ter saído da loja ou o endereço pode estar incompleto.',
    acoes: [
      el('a', { class: 'botao botao--principal', href: '/loja/' }, 'Ver todos os produtos'),
    ],
  }));
}

function renderizarErro(erro) {
  raiz.setAttribute('aria-busy', 'false');
  trocarConteudo(raiz, blocoEstado({
    tipo: 'erro',
    icone: 'alerta',
    nivel: 'h1',
    titulo: 'Não foi possível carregar o produto',
    texto: erro && erro.message ? erro.message : 'Tente novamente em instantes.',
    acoes: [
      el('button', { type: 'button', class: 'botao botao--principal', onclick: carregar }, 'Tentar novamente'),
      el('a', { class: 'botao botao--fantasma', href: '/loja/' }, 'Voltar à loja'),
    ],
  }));
}

async function carregarRelacionados(produto) {
  try {
    let linhas = [];
    if (produto && produto.categoria_id) {
      linhas = await buscarRelacionados({ categoriaId: produto.categoria_id, slug: produto.slug, limite: 4 });
    }
    let titulo = 'Você também pode gostar';
    if (!linhas.length) titulo = produto ? 'Conheça outros produtos' : 'Conheça nossos produtos';
    if (linhas.length < 4) {
      // Completa a vitrine com outros produtos da loja (os da mesma categoria vêm primeiro).
      const outros = await buscarRelacionados({ slug: produto ? produto.slug : '', limite: 8 });
      const vistos = new Set(linhas.map((p) => p.slug));
      linhas = linhas.concat(outros.filter((p) => !vistos.has(p.slug))).slice(0, 4);
    }
    const relacionados = linhas.map(normalizarProduto).filter(Boolean);
    if (!relacionados.length) return;
    tituloRelacionados.textContent = titulo;
    trocarConteudo(gradeRelacionados, relacionados.map((p) => cartaoProduto(p, { nivel: 'h3' })));
    secaoRelacionados.hidden = false;
  } catch {
    secaoRelacionados.hidden = true;
  }
}

async function carregar() {
  if (!lojaConfigurada()) {
    raiz.setAttribute('aria-busy', 'false');
    trocarConteudo(raiz, blocoEstado({
      icone: 'folha',
      nivel: 'h1',
      titulo: 'Loja em configuração',
      texto: 'Os produtos aparecem aqui assim que a AMA terminar de configurar a loja virtual.',
    }));
    return;
  }
  const slug = (parametros().get('slug') || '').trim().toLowerCase();
  trocarConteudo(raiz, esqueletoFicha());
  trocarConteudo(gradeRelacionados, Array.from({ length: 4 }, esqueletoCartao));
  raiz.setAttribute('aria-busy', 'true');
  try {
    const bruto = slug ? await buscarProdutoPorSlug(slug) : null;
    const produto = normalizarProduto(bruto);
    if (!produto) {
      renderizarNaoEncontrado();
      carregarRelacionados(null);
      return;
    }
    renderizarProduto(produto);
    carregarRelacionados(produto);
  } catch (erro) {
    renderizarErro(erro);
  }
}

carregar();
