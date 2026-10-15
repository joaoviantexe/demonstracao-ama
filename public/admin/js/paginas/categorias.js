// #/categorias — categorias da loja (docs/ARQUITETURA.md §4.1 e §8): lista com quantidade de
// produtos, criar/editar em modal, subir/descer (ordem do filtro na loja) e apagar (os produtos
// ficam sem categoria). editarCategoria() também abre pelo atalho "Nova categoria" do produto.
// As funções puras são testadas em tests/unit/painel-produtos.test.js.

import { moverItem } from '../ui.js';
import { gerarSlug, sugerirSlug } from './produtos.js';

export const MAX_NOME_CATEGORIA = 120;
export const MAX_DESCRICAO_CATEGORIA = 500;
const COLUNAS = 'id, nome, slug, descricao, ordem, ativo';

/** Valores do modal → { campo: mensagem } (vazio = tudo certo). Iguais aos checks do banco. */
export function validarCategoria(v) {
  const erros = {};
  const nome = String(v.nome ?? '').trim();
  if (!nome) erros.nome = 'Informe o nome da categoria.';
  else if (nome.length > MAX_NOME_CATEGORIA) erros.nome = `Use no máximo ${MAX_NOME_CATEGORIA} caracteres (agora tem ${nome.length}).`;
  if (String(v.descricao ?? '').trim().length > MAX_DESCRICAO_CATEGORIA) {
    erros.descricao = `Use no máximo ${MAX_DESCRICAO_CATEGORIA} caracteres na descrição.`;
  }
  return erros;
}

/** Valores já validados → registro para insert/update em categorias (o endereço não é editável: sai do nome na criação). */
export function montarCategoria(v) {
  return {
    nome: String(v.nome ?? '').trim(),
    descricao: String(v.descricao ?? '').trim(),
    ativo: v.ativo !== false,
  };
}

/** Ordem para uma categoria nova: depois da última. */
export function proximaOrdem(lista) {
  const ordens = (lista || []).map((c) => Number(c.ordem)).filter(Number.isFinite);
  return ordens.length ? Math.max(...ordens) + 1 : 1;
}

/**
 * Move a categoria de `de` para `para` e numera de novo (1, 2, 3…).
 * → { lista (cópia com a ordem nova), mudancas: [{ id, ordem }] só das que mudaram }.
 */
export function planejarReordenacao(lista, de, para) {
  const movida = moverItem(lista || [], de, para);
  const mudancas = [];
  const nova = movida.map((c, i) => {
    const ordem = i + 1;
    if (Number(c.ordem) !== ordem) mudancas.push({ id: c.id, ordem });
    return { ...c, ordem };
  });
  return { lista: nova, mudancas };
}

/** Quantidade de produtos vinda do PostgREST (produtos(count) → [{ count }]). */
export function quantidadeDeProdutos(categoria) {
  const p = categoria && categoria.produtos;
  if (Array.isArray(p)) return Number(p[0] && p[0].count) || 0;
  return Number(p && p.count) || 0;
}

/** Texto da confirmação ao apagar. */
export function mensagemApagarCategoria(categoria, quantidade) {
  if (!quantidade) return `Apagar a categoria "${categoria.nome}"? Ela não tem produtos. Esta ação não pode ser desfeita.`;
  const produtos = quantidade === 1 ? 'O produto dela continua' : `Os ${quantidade} produtos dela continuam`;
  return `Apagar a categoria "${categoria.nome}"? ${produtos} na loja e no painel, só que sem categoria. Esta ação não pode ser desfeita.`;
}

/**
 * Modal de criar (categoria = null) ou editar uma categoria. opções: { ordem } para a nova.
 * Devolve o controle do modal; controle.resultado resolve com a linha salva ou null.
 */
export function editarCategoria(ctx, categoria, { ordem = 1 } = {}) {
  const { ui, api, supabase } = ctx;
  const { el } = ui;
  const nome = ui.campo({
    rotulo: 'Nome', nome: 'nome', obrigatorio: true, valor: categoria ? categoria.nome : '',
    attrs: { maxlength: String(MAX_NOME_CATEGORIA), autocomplete: 'off' },
  });
  const descricao = ui.campo({
    rotulo: 'Descrição', nome: 'descricao', tipo: 'textarea', linhas: 3, valor: categoria ? categoria.descricao || '' : '',
    attrs: { maxlength: String(MAX_DESCRICAO_CATEGORIA) },
  });
  const ativo = ui.campo({
    rotulo: 'Visível na loja', nome: 'ativo', tipo: 'interruptor', valor: categoria ? categoria.ativo !== false : true,
  });

  const controle = ui.modal({
    titulo: categoria ? 'Editar categoria' : 'Nova categoria',
    classe: 'modal--categoria',
    conteudo: el('div', { class: 'formulario' }, nome.elemento, descricao.elemento, ativo.elemento),
    acoes: [
      { texto: 'Cancelar', valor: null },
      {
        texto: categoria ? 'Salvar' : 'Criar categoria', tipo: 'primario', icone: 'check',
        aoClicar: async () => {
          const valores = { nome: nome.entrada.value, descricao: descricao.entrada.value, ativo: ativo.ler() };
          const erros = validarCategoria(valores);
          const campos = { nome, descricao };
          for (const c of Object.values(campos)) c.definirErro(null);
          if (Object.keys(erros).length) {
            for (const [campo, mensagem] of Object.entries(erros)) campos[campo].definirErro(mensagem);
            controle.corpo.querySelector('[aria-invalid="true"]').focus();
            return false;
          }
          const registro = montarCategoria(valores);
          if (!categoria) registro.ordem = ordem;
          let r;
          if (categoria) {
            r = await api.consultar(supabase.from('categorias').update(registro).eq('id', categoria.id).select(COLUNAS).single());
          } else {
            // O endereço da categoria sai do nome (primeiro livre); se outra categoria pegar o mesmo no meio do caminho, tenta de novo.
            const base = gerarSlug(registro.nome) || 'categoria';
            for (let tentativa = 0; tentativa < 3; tentativa += 1) {
              const raiz = base.replace(/-\d+$/, '');
              const usados = await api.consultar(supabase.from('categorias').select('slug').like('slug', `${raiz}%`).limit(1000));
              const slugs = usados.ok ? (usados.dados || []).map((l) => l.slug) : [];
              r = await api.consultar(supabase.from('categorias').insert({ ...registro, slug: sugerirSlug(base, slugs) }).select(COLUNAS).single());
              if (r.ok || r.erro !== 'duplicado') break;
            }
          }
          if (!r.ok) {
            if (r.erro === 'nao_encontrado') throw new Error('Esta categoria foi apagada enquanto você editava. Feche e atualize a lista.');
            throw new Error(r.mensagem);
          }
          return r.dados;
        },
      },
    ],
  });
  // Enter num campo de uma linha salva (o modal não é um <form>).
  controle.corpo.addEventListener('keydown', (evento) => {
    if (evento.key !== 'Enter' || evento.target.tagName !== 'INPUT' || evento.target.type === 'checkbox') return;
    evento.preventDefault();
    controle.rodape.querySelector('.botao--primario')?.click();
  });
  return controle;
}

// ---------------------------------------------------------------------------
// Página

export async function renderizar(ctx) {
  const { ui, api, supabase } = ctx;
  const { el } = ui;
  let categorias = [];
  let modalAberto = null;
  let movendo = false;

  ctx.raiz.append(ui.cabecalhoPagina({
    titulo: 'Categorias',
    descricao: 'Organize os produtos da loja em grupos. A ordem desta lista é a ordem do filtro na loja.',
    acoes: [
      ui.botao({ texto: 'Produtos', icone: 'produtos', href: '#/produtos' }),
      ui.botao({ texto: 'Nova categoria', tipo: 'primario', icone: 'mais', aoClicar: () => abrir(null) }),
    ],
  }));
  const css = ui.carregarCss('produtos');
  const anuncio = el('p', { class: 'sr-only', 'aria-live': 'polite' });
  const corpo = el('div', { class: 'cartao__corpo cartao__corpo--sem-espaco' });
  ctx.raiz.append(el('section', { class: 'cartao categorias-cartao', 'aria-label': 'Lista de categorias' }, corpo), anuncio);

  function celulaNome(c) {
    return el('div', { class: 'categoria-celula' },
      el('span', { class: 'categoria-celula__nome' }, c.nome));
  }

  function celulaProdutos(c) {
    const n = quantidadeDeProdutos(c);
    if (!n) return el('span', { class: 'texto-suave' }, 'Nenhum');
    return el('a', { class: 'categoria-produtos', href: `#/produtos?categoria=${c.id}` }, `${n} ${n === 1 ? 'produto' : 'produtos'}`);
  }

  function celulaOrdem(c, i) {
    return el('div', { class: 'grupo-botoes categoria-ordem' },
      ui.botao({
        tipo: 'fantasma', tamanho: 'pequeno', icone: 'subir', rotulo: `Subir ${c.nome}`,
        attrs: { disabled: i === 0 || movendo, 'data-acao': 'subir', 'data-id': c.id }, aoClicar: () => mover(i, i - 1),
      }),
      ui.botao({
        tipo: 'fantasma', tamanho: 'pequeno', icone: 'descer', rotulo: `Descer ${c.nome}`,
        attrs: { disabled: i === categorias.length - 1 || movendo, 'data-acao': 'descer', 'data-id': c.id }, aoClicar: () => mover(i, i + 1),
      }));
  }

  function celulaAcoes(c) {
    return el('div', { class: 'grupo-botoes categoria-acoes' },
      ui.botao({ texto: 'Editar', tamanho: 'pequeno', icone: 'editar', rotulo: `Editar ${c.nome}`, aoClicar: () => abrir(c) }),
      ui.botao({ tipo: 'fantasma', tamanho: 'pequeno', icone: 'lixeira', rotulo: `Apagar ${c.nome}`, classe: 'categoria-apagar', aoClicar: () => apagar(c) }));
  }

  function desenhar() {
    if (!categorias.length) {
      ui.estadoVazio(corpo, 'Crie a primeira categoria para organizar a loja (por exemplo: Body Splash, Cremes, Biojoias).', {
        titulo: 'Nenhuma categoria ainda', icone: 'categorias', acao: { texto: 'Nova categoria', icone: 'mais', aoClicar: () => abrir(null) },
      });
      return;
    }
    corpo.replaceChildren(ui.tabela({
      legenda: 'Categorias da loja, na ordem do filtro',
      classe: 'categorias-tabela',
      linhas: categorias,
      colunas: [
        { titulo: 'Categoria', principal: true, celula: celulaNome },
        { titulo: 'Descrição', ocultarNoCelular: true, classe: 'categorias-col-descricao', celula: (c) => c.descricao || el('span', { class: 'texto-suave' }, 'Sem descrição') },
        { titulo: 'Produtos', celula: celulaProdutos },
        {
          titulo: 'Na loja',
          celula: (c) => el('span', { class: ['selo', c.ativo ? 'selo--verde' : 'selo--cinza'] }, c.ativo ? 'Visível' : 'Oculta'),
        },
        { titulo: 'Ordem', celula: celulaOrdem, classe: 'categorias-col-ordem' },
        { titulo: 'Ações', alinhar: 'direita', celula: celulaAcoes, classe: 'categorias-col-acoes' },
      ],
    }));
  }

  async function carregar({ silencioso = false } = {}) {
    if (!silencioso) ui.estadoCarregando(corpo, { linhas: 5, tipo: 'tabela', mensagem: 'Carregando categorias…' });
    const [r] = await Promise.all([
      api.consultar(supabase.from('categorias').select(`${COLUNAS}, produtos(count)`).order('ordem').order('nome')),
      css,
    ]);
    if (!ctx.ativo()) return;
    if (!r.ok) {
      ui.estadoErro(corpo, r.mensagem, { titulo: 'Não foi possível carregar as categorias', aoTentarNovamente: () => carregar() });
      return;
    }
    categorias = r.dados || [];
    desenhar();
  }

  function abrir(categoria) {
    if (modalAberto) return;
    modalAberto = editarCategoria(ctx, categoria, { ordem: proximaOrdem(categorias) });
    modalAberto.resultado.then((salva) => {
      modalAberto = null;
      if (!salva || !ctx.ativo()) return;
      ui.toast(categoria ? 'Categoria salva.' : `Categoria "${salva.nome}" criada.`, 'sucesso');
      carregar({ silencioso: true });
    });
  }

  async function mover(de, para) {
    if (movendo) return;
    const plano = planejarReordenacao(categorias, de, para);
    if (!plano.mudancas.length) return;
    const id = categorias[de].id;
    movendo = true;
    desenhar();
    const resultados = await Promise.all(plano.mudancas.map((m) => api.consultar(
      supabase.from('categorias').update({ ordem: m.ordem }).eq('id', m.id),
    )));
    if (!ctx.ativo()) return;
    movendo = false;
    const falha = resultados.find((r) => !r.ok);
    if (falha) {
      ui.toast(falha.mensagem, 'erro');
      await carregar({ silencioso: true });
      return;
    }
    categorias = plano.lista;
    desenhar();
    const posicao = categorias.findIndex((c) => c.id === id);
    anuncio.textContent = `${categorias[posicao].nome} agora é a ${posicao + 1}ª de ${categorias.length}.`;
    const acao = para < de ? 'subir' : 'descer';
    const alvo = corpo.querySelector(`[data-id="${id}"][data-acao="${acao}"]:not([disabled])`)
      || corpo.querySelector(`[data-id="${id}"][data-acao]:not([disabled])`);
    if (alvo) alvo.focus();
  }

  async function apagar(c) {
    const n = quantidadeDeProdutos(c);
    const sim = await ui.confirmar(mensagemApagarCategoria(c, n), { perigo: true, titulo: 'Apagar categoria?', textoConfirmar: 'Apagar categoria' });
    if (!sim || !ctx.ativo()) return;
    const r = await api.consultar(supabase.from('categorias').delete().eq('id', c.id));
    if (!ctx.ativo()) return;
    if (!r.ok) {
      ui.toast(r.mensagem, 'erro');
      return;
    }
    ui.toast(`Categoria "${c.nome}" apagada.`, 'sucesso');
    await carregar({ silencioso: true });
    if (ctx.ativo()) ctx.raiz.querySelector('h1')?.focus();
  }

  const aoVoltar = () => {
    if (document.visibilityState === 'visible' && !movendo && !modalAberto) carregar({ silencioso: true });
  };
  document.addEventListener('visibilitychange', aoVoltar);

  await carregar();

  return () => {
    document.removeEventListener('visibilitychange', aoVoltar);
    if (modalAberto) modalAberto.fechar(null);
  };
}
