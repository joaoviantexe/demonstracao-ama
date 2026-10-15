// Catálogo /loja/ — vitrine com filtro por categoria (?categoria=), busca (?busca=) e ordenação (?ordem=).

import { buscarCategorias, buscarProdutos, lojaConfigurada } from './config.js';
import {
  blocoEstado, botaoWhatsapp, definirMeta, el, iniciarPagina, trocarConteudo,
} from './comum.js';
import { pluralizar, validarSlug } from './formatos.js';
import {
  categoriasComProdutos, filtrarProdutos, lerOrdenacao, normalizarProduto, ordenarProdutos,
} from './produtos.js';
import { cartaoProduto, esqueletoCartao } from './vitrine.js';

const { config } = iniciarPagina();

const grade = document.getElementById('grade');
const filtros = document.getElementById('filtros');
const contagem = document.getElementById('catalogo-contagem');
const campoBusca = document.getElementById('busca');
const campoOrdem = document.getElementById('ordem');
const controles = document.querySelector('.catalogo-controles');

const estado = {
  produtos: [],
  categorias: [],
  categoria: '',
  busca: '',
  ordem: 'destaques',
  carregado: false,
};

// Nome e subtítulo da loja vêm de configuracoes.loja.
config.then((cfg) => {
  const titulo = document.querySelector('[data-loja-titulo]');
  const subtitulo = document.querySelector('[data-loja-subtitulo]');
  if (titulo) titulo.textContent = cfg.titulo;
  if (subtitulo) {
    subtitulo.textContent = cfg.subtitulo;
    subtitulo.hidden = !cfg.subtitulo;
  }
  definirMeta({ titulo: `${cfg.titulo} — Associação de Mulheres na Amazônia`, descricao: cfg.subtitulo || undefined });
});

function lerUrl() {
  const p = new URLSearchParams(location.search);
  const categoria = (p.get('categoria') || '').trim().toLowerCase();
  estado.categoria = validarSlug(categoria) ? categoria : '';
  estado.busca = (p.get('busca') || '').slice(0, 60);
  estado.ordem = lerOrdenacao(p.get('ordem'));
  campoBusca.value = estado.busca;
  campoOrdem.value = estado.ordem;
}

function gravarUrl({ empilhar = false } = {}) {
  const p = new URLSearchParams();
  if (estado.categoria) p.set('categoria', estado.categoria);
  if (estado.busca.trim()) p.set('busca', estado.busca.trim());
  if (estado.ordem !== 'destaques') p.set('ordem', estado.ordem);
  const consulta = p.toString();
  const url = `${location.pathname}${consulta ? `?${consulta}` : ''}${location.hash}`;
  if (url === `${location.pathname}${location.search}${location.hash}`) return;
  history[empilhar ? 'pushState' : 'replaceState'](null, '', url);
}

function mostrarEsqueletos() {
  grade.setAttribute('aria-busy', 'true');
  trocarConteudo(grade, Array.from({ length: 8 }, esqueletoCartao));
  contagem.textContent = 'Carregando produtos…';
}

function chip(rotulo, slug, total) {
  const ativo = estado.categoria === slug;
  return el('button', {
    type: 'button',
    class: `chip${ativo ? ' chip--ativo' : ''}`,
    'aria-pressed': ativo ? 'true' : 'false',
    dataset: { categoria: slug },
    onclick: () => {
      if (estado.categoria === slug) return;
      estado.categoria = slug;
      gravarUrl({ empilhar: true });
      renderizarFiltros();
      renderizar();
    },
  }, el('span', { texto: rotulo }), el('span', { class: 'chip-total', texto: String(total) }));
}

function renderizarFiltros() {
  if (estado.categorias.length < 2) {
    filtros.hidden = true;
    return;
  }
  filtros.hidden = false;
  trocarConteudo(filtros,
    chip('Todos', '', estado.produtos.length),
    estado.categorias.map((c) => chip(c.nome, c.slug, c.total)));
  // Deixa o filtro ativo visível na faixa rolável (celular) sem mexer na rolagem da página.
  const ativo = filtros.querySelector('.chip--ativo');
  if (ativo && filtros.scrollWidth > filtros.clientWidth) filtros.scrollLeft = Math.max(0, ativo.offsetLeft - 24);
}

function limparFiltros() {
  estado.categoria = '';
  estado.busca = '';
  campoBusca.value = '';
  gravarUrl({ empilhar: true });
  renderizarFiltros();
  renderizar();
  campoBusca.focus();
}

function textoContagem(total) {
  const nomeCategoria = estado.categoria
    ? (estado.categorias.find((c) => c.slug === estado.categoria) || {}).nome
    : '';
  const busca = estado.busca.trim();
  let texto = pluralizar(total, 'produto', 'produtos');
  if (nomeCategoria) texto += ` em ${nomeCategoria}`;
  if (busca) texto += ` para “${busca}”`;
  return texto;
}

function renderizar() {
  if (!estado.carregado) return;
  const lista = ordenarProdutos(filtrarProdutos(estado.produtos, estado), estado.ordem);
  grade.setAttribute('aria-busy', 'false');
  if (!estado.produtos.length) {
    contagem.textContent = '';
    controles.hidden = true;
    trocarConteudo(grade, blocoEstado({
      icone: 'folha',
      titulo: 'Novidades a caminho',
      texto: 'Os produtos da AMA aparecem aqui em breve. Enquanto isso, encomende pelo WhatsApp.',
      acoes: [botaoWhatsapp('Encomendar pelo WhatsApp', 'Olá, AMA! Quero conhecer os produtos da loja.')],
    }));
    return;
  }
  controles.hidden = false;
  contagem.textContent = textoContagem(lista.length);
  if (!lista.length) {
    trocarConteudo(grade, blocoEstado({
      icone: 'busca',
      titulo: 'Nenhum produto encontrado',
      texto: 'Tente outra palavra ou veja todos os produtos da loja.',
      acoes: [el('button', { type: 'button', class: 'botao botao--principal', onclick: limparFiltros }, 'Ver todos os produtos')],
    }));
    return;
  }
  trocarConteudo(grade, lista.map((p, i) => cartaoProduto(p, { nivel: 'h3', carregamento: i < 4 ? 'eager' : 'lazy' })));
}

function renderizarErro(erro) {
  grade.setAttribute('aria-busy', 'false');
  contagem.textContent = '';
  filtros.hidden = true;
  trocarConteudo(grade, blocoEstado({
    tipo: 'erro',
    icone: 'alerta',
    titulo: 'Não foi possível carregar os produtos',
    texto: erro && erro.message ? erro.message : 'Tente novamente em instantes.',
    acoes: [
      el('button', { type: 'button', class: 'botao botao--principal', onclick: carregar }, 'Tentar novamente'),
      botaoWhatsapp('Comprar pelo WhatsApp', 'Olá, AMA! Quero fazer um pedido.', { classe: 'botao botao--fantasma' }),
    ],
  }));
}

function renderizarNaoConfigurada() {
  grade.setAttribute('aria-busy', 'false');
  controles.hidden = true;
  filtros.hidden = true;
  contagem.textContent = '';
  trocarConteudo(grade, blocoEstado({
    icone: 'folha',
    titulo: 'Loja em configuração',
    texto: 'Os produtos aparecem aqui assim que a AMA terminar de configurar a loja virtual. Enquanto isso, faça seu pedido pelo WhatsApp.',
    acoes: [botaoWhatsapp('Encomendar pelo WhatsApp', 'Olá, AMA! Quero conhecer os produtos da loja.')],
  }));
}

async function carregar() {
  if (!lojaConfigurada()) {
    renderizarNaoConfigurada();
    return;
  }
  mostrarEsqueletos();
  try {
    const [produtos, categorias] = await Promise.all([buscarProdutos(), buscarCategorias().catch(() => [])]);
    estado.produtos = (Array.isArray(produtos) ? produtos : []).map(normalizarProduto).filter(Boolean);
    estado.categorias = categoriasComProdutos(Array.isArray(categorias) ? categorias : [], estado.produtos);
    if (estado.categoria && !estado.categorias.some((c) => c.slug === estado.categoria)) {
      estado.categoria = '';
      gravarUrl();
    }
    estado.carregado = true;
    renderizarFiltros();
    renderizar();
  } catch (erro) {
    renderizarErro(erro);
  }
}

// Busca com pequena espera para não redesenhar a cada tecla.
let esperaBusca = null;
campoBusca.addEventListener('input', () => {
  clearTimeout(esperaBusca);
  esperaBusca = setTimeout(() => {
    estado.busca = campoBusca.value.slice(0, 60);
    gravarUrl();
    renderizar();
  }, 180);
});
campoBusca.addEventListener('keydown', (evento) => {
  if (evento.key === 'Enter') {
    evento.preventDefault();
    clearTimeout(esperaBusca);
    estado.busca = campoBusca.value.slice(0, 60);
    gravarUrl();
    renderizar();
  }
});
campoOrdem.addEventListener('change', () => {
  estado.ordem = lerOrdenacao(campoOrdem.value);
  gravarUrl();
  renderizar();
});
window.addEventListener('popstate', () => {
  lerUrl();
  renderizarFiltros();
  renderizar();
});

// "Ver a coleção" volta para todos os produtos antes de rolar até a vitrine.
document.querySelector('[data-ver-colecao]')?.addEventListener('click', () => {
  if (estado.categoria && estado.carregado) {
    estado.categoria = '';
    gravarUrl({ empilhar: true });
    renderizarFiltros();
    renderizar();
  }
});

lerUrl();
carregar();
