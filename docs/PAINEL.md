# Painel AMA — guia do núcleo para criar páginas

Este documento descreve **o que existe hoje** no núcleo do painel `/admin/`:
`public/admin/index.html`, `public/admin/js/app.js`, `ui.js`, `api.js`, `midia.js` e `public/admin/admin.css`.
Com ele dá para escrever uma página nova sem abrir esses arquivos. Tabelas, RPCs, RLS e rotas de API ficam
em `docs/ARQUITETURA.md` (§4, §5, §6.6 e §8); aqui só entra o que a página precisa saber para usá-los.

Público do painel: mulheres da AMA, sem formação técnica, muitas vezes no **celular**. Tudo o que vem abaixo
(botões grandes, confirmações, mensagens que dizem o que fazer) existe para isso.

## Sumário

1. [Regras rápidas](#1-regras-rápidas)
2. [Arquivos e carregamento](#2-arquivos-e-carregamento)
3. [Contrato das páginas e `ctx`](#3-contrato-das-páginas-e-ctx)
4. [Exemplo completo de página](#4-exemplo-completo-de-página)
5. [Roteamento](#5-roteamento)
6. [Alterações não salvas](#6-alterações-não-salvas)
7. [Sessão, login e permissões](#7-sessão-login-e-permissões)
8. [`ui.js` — referência completa](#8-uijs--referência-completa)
9. [`api.js` — referência completa](#9-apijs--referência-completa)
10. [`midia.js` — referência completa](#10-midiajs--referência-completa)
11. [`admin.css` — sistema de design](#11-admincss--sistema-de-design)
12. [Como testar uma página](#12-como-testar-uma-página)
13. [Armadilhas e pendências conhecidas do núcleo](#13-armadilhas-e-pendências-conhecidas-do-núcleo)

---

## 1. Regras rápidas

- Uma página = um arquivo `public/admin/js/paginas/<nome>.js`, com `<nome>` igual ao campo `pagina` da rota
  (§5). Ele exporta `export async function renderizar(ctx)`.
- Use o que vem no `ctx` (`ctx.ui`, `ctx.api`, `ctx.midia`, `ctx.supabase`). Não importe `app.js`.
- Não edite os arquivos do núcleo. Estilos da página vão em `public/admin/css/<nome>.css`, carregados com
  `await ctx.ui.carregarCss('<nome>')` e escritos dentro de `.pagina[data-pagina="<nome>"]` (§3.5).
- Dado vindo do banco ou digitado vai para a tela **só como texto**: `ui.el(...)`, `textContent`, `ui.escapar`.
  Nunca `innerHTML` com dado. `ui.el` recusa `on*`, `innerHTML`, `srcdoc` e URLs perigosas.
- Dinheiro sempre em **centavos inteiros**: campo `ui.campo({ tipo: 'preco' })`, `ui.lerPreco`, `ui.formatarPreco`.
- Toda área que carrega dados passa por: carregando (`ui.estadoCarregando`) → vazio (`ui.estadoVazio`) **ou**
  erro com "Tentar novamente" (`ui.estadoErro`) **ou** conteúdo.
- Depois de **cada `await`**, confira `if (!ctx.ativo()) return;` antes de mexer na tela, mostrar toast ou navegar.
- Formulários: `novalidate`, erro ao lado do campo com `campo.definirErro(msg)`, `ctx.marcarAlterado(true)` em
  `input`/`change`, `ctx.marcarAlterado(false)` depois de salvar e **antes** de `ctx.navegar`.
- Apagar só depois de `await ui.confirmar(msg, { perigo: true, textoConfirmar: 'Apagar …' })`.
- Botão que salva/envia: `await ui.ocupado(botao, async () => { … })` (spinner e bloqueio de clique duplo).
- Mensagens: frases curtas que dizem o que fazer. `r.mensagem` de `api`/`midia` já vem pronta em português.
- Comece pelo celular (360–390 px) e confira que não há rolagem horizontal.

---

## 2. Arquivos e carregamento

| Arquivo | Papel |
|---|---|
| `public/admin/index.html` | Fontes (Fraunces, Manrope, Baloo 2), `/admin/admin.css`, depois em ordem: `/api/config` (define `window.AMA_CONFIG`), `/vendor/supabase-2.116.0.js` (define `window.supabase`) e o módulo `/admin/js/app.js`. `<div id="app">` começa com `.tela-carregando`. |
| `public/admin/js/app.js` | Cliente do Supabase, telas de login/recuperação de senha, verificação de admin (`rpc('eh_admin')`), layout (topo + menu lateral/gaveta), roteador por hash, aviso de alterações não salvas, carregamento das páginas. |
| `public/admin/js/ui.js` | Construção de elementos, formatação, ícones, componentes (botões, campos, tabelas, abas, estados, avisos, toasts, modais). |
| `public/admin/js/api.js` | `chamarApi` (rotas `/api/admin/*` com o JWT), `consultar` (normaliza consultas do supabase-js), erros em português. |
| `public/admin/js/midia.js` | Bucket `midia` do Storage: enviar, listar, apagar, otimizar imagem, área de upload, seletor de mídia. |
| `public/admin/admin.css` | Sistema de design (tokens, layout, componentes). |
| `public/admin/js/paginas/visao-geral.js` | Página real que serve de exemplo (métricas, tabela, avisos, integrações). |
| `public/admin/js/paginas/em-breve.js` | Página provisória usada quando `paginas/<nome>.js` ainda não existe. |
| `public/admin/css/<nome>.css` | CSS próprio de cada página (criado pela trilha da página; §3.5). |

Na inicialização o `app.js` confere `window.AMA_CONFIG` (`configurado`, `supabaseUrl`, `supabaseAnonKey`). Sem ela
mostra "Painel em configuração" ou "Não foi possível abrir o painel"; nenhuma página roda. O cliente é criado com
`persistSession`, `autoRefreshToken` e `detectSessionInUrl` ligados.

---

## 3. Contrato das páginas e `ctx`

### 3.1 Assinatura

```js
// public/admin/js/paginas/<nome>.js
export async function renderizar(ctx) {
  // monta a tela dentro de ctx.raiz
  return () => { /* limpeza opcional */ };
}
```

- Pode ser `async`: o app espera a promessa terminar.
- O retorno, se for função (síncrona ou `async`), é a **limpeza** (§3.4). Outro retorno é ignorado.
- Se `renderizar` lançar erro (ou a promessa rejeitar), o app troca a página por um `ui.estadoErro`
  ("Esta seção encontrou um erro inesperado…") com "Tentar novamente", que renderiza a rota de novo, e registra o
  erro no console. Trate os erros esperados (rede, banco) na própria página; deixe o lançamento para bugs.

### 3.2 O objeto `ctx`

O `docs/ARQUITETURA.md` §8 lista só uma parte; este é o `ctx` completo criado em `criarCtx` (`app.js`).

| Propriedade | Tipo | O que é |
|---|---|---|
| `raiz` | `HTMLDivElement` | `<div class="pagina" data-pagina="<nome>">`, já **vazia**, dentro de `<main id="conteudo-principal" class="principal">`. Coloque tudo aqui. Os filhos diretos ficam em coluna, com 20 px de espaço (24 px a partir de 1024 px) e largura máxima de 1240 px. |
| `supabase` | cliente supabase-js 2.116.0 | Já logado como a administradora (RLS de admin, §7). É o mesmo de `api.obterSupabase()`. |
| `usuario` | `{ id, email }` | Cópia dos dados de quem está logada. |
| `params` | objeto | Parâmetros do caminho: `{ id }` em produtos/pedidos, `{ grupo }` em conteúdo, `{}` nas demais (§5.1). |
| `consulta` | objeto de textos | O que vem depois do `?` no hash: `#/pedidos?status=pago` → `{ status: 'pago' }`. Cópia feita na hora da renderização. |
| `rota` | texto | Nome da página (`'produtos'`). |
| `hash` | texto | Hash completo na hora da renderização (`'#/produtos/novo'`). |
| `titulo` | texto | Título da rota na tabela de rotas (`'Produto'`). |
| `sinal` | `AbortSignal` | Abortado quando a rota troca (antes da limpeza). Passe para `chamarApi`, `enviarArquivo`, `fetch`. |
| `ui` | módulo `ui.js` | §8. |
| `api` | módulo `api.js` | §9. |
| `midia` | módulo `midia.js` | §10. |
| `ativo()` | `() => boolean` | `true` enquanto esta renderização é a atual; vira `false` quando a rota troca, quando a mesma rota é renderizada de novo ou quando a pessoa sai do painel. |
| `navegar(destino, opcoes)` | função | Vai para outra rota (§5.3). Não faz nada se `ativo()` for `false`. |
| `marcarAlterado(sim = true)` | função | Liga/desliga o aviso de alterações não salvas (§6). Não faz nada se inativo. |
| `definirTitulo(texto)` | função | Troca o título da aba do navegador para `"<texto> · Painel AMA"` (vazio → `"Painel AMA"`). Não mexe no `<h1>`. Não faz nada se inativo. Ex.: `ctx.definirTitulo('Pedido #1042')`. |
| `atualizarContadores()` | `() => Promise` | Reconta na hora o número ao lado de "Pedidos" no menu (pedidos com status `pago` ou `em_separacao`). Chame depois de mudar o status de um pedido. |

### 3.3 O que acontece numa troca de rota

1. `hashchange` (link, menu, botão Voltar) ou `ctx.navegar`. Se há alterações não salvas, aparece a confirmação
   "Descartar alterações?"; em "Continuar editando" a URL volta e nada muda (§6).
2. Limpeza da página anterior: `ctx.sinal` é abortado, a função de limpeza é chamada (erros dela só vão para o console)
   e os modais que ainda estiverem abertos são fechados com `null` (`ui.fecharModais()`).
3. O aviso de alterações é zerado, a gaveta do menu fecha, o item do menu é marcado, o título da aba vira
   `"<título da rota> · Painel AMA"`, uma `raiz` nova substitui a anterior e a janela rola para o topo.
4. Caminho desconhecido → "Página não encontrada" (nenhum módulo é carregado).
5. Enquanto `import('./paginas/<pagina>.js')` carrega, a raiz mostra `ui.estadoCarregando` ("Carregando <título>…").
   Arquivo inexistente (404) → carrega `em-breve.js`. Falha de rede → `ui.estadoErro` com "Tentar novamente".
6. A raiz é esvaziada e `renderizar(ctx)` é chamada e aguardada.
7. Se a rota mudou enquanto `renderizar` rodava, a limpeza que ela devolver é chamada na hora.
8. O foco vai para o primeiro `<h1>` da raiz (recebe `tabindex="-1"`); sem `<h1>`, para o `<main>`.
   Por isso: **todo cabeçalho com `ui.cabecalhoPagina`** (ele cria o `<h1>`), anexado antes do primeiro `await`.
9. O contador do menu é atualizado (no máximo uma vez a cada 30 s).

O `import()` é cacheado pelo navegador: variáveis no topo do módulo **sobrevivem** entre visitas. Guarde o estado
dentro de `renderizar`.

### 3.4 Limpeza

A função devolvida por `renderizar` é chamada quando a rota troca (inclusive quando a mesma rota é renderizada de
novo) e quando a pessoa clica em "Sair". **Não** é chamada quando a sessão expira: nesse caso a página fica viva
por baixo da tela de login (§7).

Use para: `clearInterval`/`clearTimeout`, `removeEventListener` em `window`/`document` e `debounce(...).cancelar()`.
Modais não precisam ser fechados aqui: logo depois da limpeza o app fecha todos os que ficaram abertos (inclusive o
`seletorDeMidia`), e cada `resultado` resolve com `null` — por isso confira `ctx.ativo()` depois de esperar um modal.
Feche na limpeza só se quiser resolver o modal com outro valor.

### 3.5 CSS próprio da página

```js
await ctx.ui.carregarCss('produtos'); // insere <link href="/admin/css/produtos.css"> uma única vez
```

- Só chame se o arquivo existir (um 404 aparece como erro no console e reprova as verificações automáticas).
- Escreva os seletores dentro de `.pagina[data-pagina="produtos"] …` para não vazar para outras páginas.
- Modais e toasts ficam no `<body>`, fora da raiz: para estilizar o conteúdo de um modal, passe
  `classe: 'modal--produto'` em `ui.modal` e use `.modal--produto …`.
- Use os tokens de cor/espaço de `admin.css` (§11.1) em vez de valores soltos.

---

## 4. Exemplo completo de página

Página mínima mas completa: lista com carregando/vazio/erro, criar e editar num modal com validação, apagar com
confirmação, recarregar e limpeza. Usa a tabela `categorias` (`id, nome, slug, descricao, ordem, ativo`) só como
ilustração; a página real de categorias é de outra trilha.

```js
// public/admin/js/paginas/<nome>.js
export async function renderizar(ctx) {
  const { ui, api, supabase } = ctx;
  const { el } = ui;
  // await ui.carregarCss('<nome>'); // só se public/admin/css/<nome>.css existir

  const corpo = el('div', { class: 'cartao__corpo cartao__corpo--sem-espaco' });
  ctx.raiz.append(
    ui.cabecalhoPagina({
      titulo: 'Categorias',
      descricao: 'Organize os produtos da loja em grupos.',
      acoes: [ui.botao({ texto: 'Nova categoria', tipo: 'primario', icone: 'mais', aoClicar: () => editar(null) })],
    }),
    el('section', { class: 'cartao', 'aria-label': 'Lista de categorias' }, corpo),
  );

  let modalAberto = null;

  async function carregar() {
    ui.estadoCarregando(corpo, { linhas: 4, tipo: 'tabela', mensagem: 'Carregando categorias…' });
    const r = await api.consultar(supabase.from('categorias').select('id, nome, slug, ativo, ordem').order('ordem').order('nome'));
    if (!ctx.ativo()) return;
    if (!r.ok) {
      ui.estadoErro(corpo, r.mensagem, { aoTentarNovamente: carregar });
      return;
    }
    if (!r.dados.length) {
      ui.estadoVazio(corpo, 'Crie a primeira categoria para organizar a loja.', {
        titulo: 'Nenhuma categoria ainda', icone: 'categorias',
        acao: { texto: 'Nova categoria', icone: 'mais', aoClicar: () => editar(null) },
      });
      return;
    }
    corpo.replaceChildren(ui.tabela({
      legenda: 'Categorias',
      linhas: r.dados,
      colunas: [
        { titulo: 'Nome', principal: true, chave: 'nome' },
        { titulo: 'Endereço', celula: (c) => el('span', { class: 'mono' }, c.slug), ocultarNoCelular: true },
        { titulo: 'Situação', celula: (c) => el('span', { class: ['selo', c.ativo ? 'selo--verde' : 'selo--cinza'] }, c.ativo ? 'Visível' : 'Oculta') },
        {
          titulo: 'Ações', alinhar: 'direita',
          celula: (c) => el('div', { class: 'grupo-botoes', style: { justifyContent: 'flex-end' } },
            ui.botao({ tipo: 'fantasma', tamanho: 'pequeno', icone: 'editar', rotulo: `Editar ${c.nome}`, aoClicar: () => editar(c) }),
            ui.botao({ tipo: 'fantasma', tamanho: 'pequeno', icone: 'lixeira', rotulo: `Apagar ${c.nome}`, aoClicar: () => apagar(c) })),
        },
      ],
    }));
  }

  function editar(categoria) {
    const nome = ui.campo({ rotulo: 'Nome', nome: 'nome', obrigatorio: true, valor: categoria ? categoria.nome : '', attrs: { maxlength: '120' } });
    const ativo = ui.campo({
      rotulo: 'Visível na loja', nome: 'ativo', tipo: 'interruptor', valor: categoria ? categoria.ativo : true,
      ajuda: 'Desligada, a categoria some do filtro da loja.',
    });
    modalAberto = ui.modal({
      titulo: categoria ? 'Editar categoria' : 'Nova categoria',
      conteudo: el('div', { class: 'formulario' }, nome.elemento, ativo.elemento),
      acoes: [
        { texto: 'Cancelar', valor: null },
        {
          texto: 'Salvar', tipo: 'primario', icone: 'check',
          aoClicar: async () => {
            const texto = nome.ler().trim();
            if (!texto) {
              nome.definirErro('Informe o nome da categoria.');
              nome.entrada.focus();
              return false; // false = o modal continua aberto
            }
            const dados = { nome: texto, ativo: ativo.ler() };
            if (!categoria) {
              dados.slug = ui.slugify(texto);
              if (!dados.slug) {
                nome.definirErro('Use pelo menos uma letra ou um número no nome.');
                return false;
              }
            }
            const r = await api.consultar(categoria
              ? supabase.from('categorias').update(dados).eq('id', categoria.id)
              : supabase.from('categorias').insert(dados));
            if (!r.ok) {
              if (r.erro === 'duplicado') {
                nome.definirErro('Já existe uma categoria com esse nome.');
                return false;
              }
              throw new Error(r.mensagem); // vira toast de erro; o modal continua aberto
            }
            return true; // fecha o modal; controle.resultado resolve com true
          },
        },
      ],
    });
    modalAberto.resultado.then((salvou) => {
      modalAberto = null;
      if (salvou && ctx.ativo()) {
        ui.toast('Categoria salva.', 'sucesso');
        carregar();
      }
    });
  }

  async function apagar(categoria) {
    const sim = await ui.confirmar(`Apagar a categoria "${categoria.nome}"? Os produtos dela continuam na loja, só que sem categoria.`, {
      perigo: true, titulo: 'Apagar categoria?', textoConfirmar: 'Apagar categoria',
    });
    if (!sim || !ctx.ativo()) return;
    const r = await api.consultar(supabase.from('categorias').delete().eq('id', categoria.id));
    if (!ctx.ativo()) return;
    if (!r.ok) {
      ui.toast(r.mensagem, 'erro');
      return;
    }
    ui.toast('Categoria apagada.', 'sucesso');
    carregar();
  }

  // Recarrega quando a aba do navegador volta a ficar visível.
  const aoVoltar = () => { if (document.visibilityState === 'visible') carregar(); };
  document.addEventListener('visibilitychange', aoVoltar);

  await carregar();

  return () => {
    document.removeEventListener('visibilitychange', aoVoltar);
    if (modalAberto) modalAberto.fechar(null);
  };
}
```

### 4.1 Formulário na própria página (com alterações não salvas)

```js
export async function renderizar(ctx) {
  const { ui, api, supabase } = ctx;
  const { el } = ui;
  const corpo = el('div', { class: 'pilha' });
  ctx.raiz.append(ui.cabecalhoPagina({ titulo: 'Avisos por e-mail', descricao: 'Quem recebe o aviso de pedido novo.' }), corpo);
  ui.estadoCarregando(corpo, { linhas: 2 });

  const r = await api.consultar(supabase.from('configuracoes').select('valor').eq('chave', 'notificacoes').maybeSingle());
  if (!ctx.ativo()) return;
  if (!r.ok) {
    ui.estadoErro(corpo, r.mensagem, { aoTentarNovamente: () => ctx.navegar(window.location.hash) });
    return;
  }
  const valor = (r.dados && r.dados.valor) || {};
  const email = ui.campo({
    rotulo: 'E-mail da equipe', nome: 'email_admin', tipo: 'email', valor: valor.email_admin || '',
    ajuda: 'Deixe vazio para não receber.', attrs: { autocomplete: 'email', inputmode: 'email' },
  });
  const salvar = ui.botao({ texto: 'Salvar', tipo: 'primario', icone: 'check', tipoHtml: 'submit' });
  // O formulário envolve os cartões e termina na barra de ações (último bloco da página: §11.20).
  const form = el('form', { class: 'pilha', novalidate: true },
    el('section', { class: 'cartao' }, el('div', { class: 'cartao__corpo' }, email.elemento)),
    el('div', { class: 'barra-acoes' }, ui.botao({ texto: 'Voltar', href: '#/configuracoes' }), salvar));
  corpo.replaceChildren(form);

  form.addEventListener('input', () => ctx.marcarAlterado(true));
  form.addEventListener('change', () => ctx.marcarAlterado(true));
  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    const texto = email.ler().trim();
    if (texto && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(texto)) {
      email.definirErro('Confira o e-mail: parece incompleto.');
      email.entrada.focus();
      return;
    }
    await ui.ocupado(salvar, async () => {
      const r2 = await api.consultar(supabase.from('configuracoes')
        .update({ valor: { ...valor, email_admin: texto } }).eq('chave', 'notificacoes'));
      if (!ctx.ativo()) return;
      if (!r2.ok) {
        ui.toast(r2.mensagem, 'erro');
        return;
      }
      ctx.marcarAlterado(false);
      ui.toast('Salvo.', 'sucesso');
    });
  });
}
```

---

## 5. Roteamento

### 5.1 Rotas (`ROTAS` em `app.js`)

| Hash | Arquivo em `paginas/` | `ctx.params` | Título | Item do menu |
|---|---|---|---|---|
| `#/` | `visao-geral.js` | `{}` | Visão geral | inicio |
| `#/conteudo` | `conteudo.js` | `{}` | Conteúdo do site | conteudo |
| `#/conteudo/<grupo>` | `conteudo.js` | `{ grupo }` (`[a-z0-9][a-z0-9_-]*`) | Conteúdo do site | conteudo |
| `#/produtos` | `produtos.js` | `{}` | Produtos | produtos |
| `#/produtos/novo` | `produtos.js` | `{ id: 'novo' }` | Produto | produtos |
| `#/produtos/<uuid>` | `produtos.js` | `{ id }` (uuid em minúsculas) | Produto | produtos |
| `#/categorias` | `categorias.js` | `{}` | Categorias | categorias |
| `#/pedidos` | `pedidos.js` | `{}` | Pedidos | pedidos |
| `#/pedidos/<uuid>` | `pedidos.js` | `{ id }` (uuid em minúsculas) | Pedido | pedidos |
| `#/configuracoes` | `configuracoes.js` | `{}` | Configurações | configuracoes |

- O mesmo arquivo atende lista e detalhe: decida por `ctx.params.id` (`undefined` = lista, `'novo'` = criação, uuid = edição).
- Barra no fim é ignorada (`#/produtos/` = `#/produtos`). Uuid em maiúsculas é aceito e chega em minúsculas.
  Qualquer outra coisa (`#/produtos/abc`, `#/Produtos`) cai em "Página não encontrada".
- Um id válido que não existe no banco é problema da página: mostre `ui.estadoVazio` com um botão de volta para a lista.
- Não há página de mídia: enviar e escolher arquivos é feito pelo seletor (`ctx.midia.seletorDeMidia`) dentro das páginas de conteúdo e de produtos.
- Hash que não começa com `#/` (âncora comum, como `#secao`) não é rota: o app devolve a URL para a rota atual.
  Não use âncoras para navegar dentro da página; use `elemento.scrollIntoView()`.

### 5.2 Menu lateral (`MENU` em `app.js`)

Seções e itens, na ordem: **Site**: Identidade (a logo do topo, do menu do celular e do rodapé) e um item por parte da página inicial (Cabeçalho e menu, Quem somos, Postagens destacadas, Nossos projetos, História, Banner da Loja, Depoimentos, Colaborações e parcerias, Rodapé, WhatsApp, Google) · **Loja**: Pedidos,
Produtos, Categorias, Configurações. Cada link tem `data-menu="<id>"` e
`aria-current="page"` quando ativo. Só o item "Pedidos" tem contador (pedidos `pago` + `em_separacao`).
O rodapé do menu tem "Ver loja" (`/loja/`, nova aba) e, só na gaveta do celular, o e-mail, "Ver site" e "Sair".
No desktop (≥ 1024 px) o menu fica fixo à esquerda; abaixo disso vira gaveta aberta pelo botão "Abrir menu" do topo
(que só aparece abaixo de 1024 px). O topo tem ainda o e-mail (≥ 720 px), "Ver site" e "Sair" (≥ 640 px; abaixo
disso o "Sair" fica só na gaveta).

### 5.3 `ctx.navegar(destino, opcoes)`

```js
ctx.navegar('#/produtos/novo');   // também aceita 'produtos/novo' e '/produtos/novo'
ctx.navegar(`#/pedidos?${new URLSearchParams({ status: 'pago' })}`);
```

| Opção | Efeito |
|---|---|
| *(nenhuma)* | Cria entrada no histórico e renderiza a rota. Se o destino é **o hash atual**, renderiza a página de novo. |
| `{ substituir: true }` | Troca a entrada atual do histórico (sem criar outra) e renderiza — também quando o destino é o hash atual. Use depois de criar algo (de `#/produtos/novo` para `#/produtos/<id>`) e no "Tentar novamente" de uma página inteira. |
| `{ silencioso: true }` | Só troca a URL (sem histórico, sem renderizar, sem confirmação). Para guardar filtros, página da lista ou aba atual na URL. `ctx.consulta` e `ctx.hash` **não** mudam: a página mantém o próprio estado. |

- Para renderizar a página atual de novo (ex.: "Tentar novamente" de uma página inteira):
  `ctx.navegar(window.location.hash)` (cria entrada no histórico só se o hash mudou) ou
  `ctx.navegar(ctx.hash, { substituir: true })` (volta ao hash da renderização, descartando filtros gravados com
  `silencioso`). A visão geral usa a segunda forma.
- Trocar de rota fecha os modais abertos (§3.3), inclusive pelo botão Voltar do navegador.
- Com alterações não salvas, `navegar` (sem `silencioso`) pede a confirmação de descarte. Depois de salvar,
  chame `ctx.marcarAlterado(false)` **antes** de navegar.
- Links comuns funcionam: `<a href="#/pedidos/<id>">` ou `ui.botao({ texto: 'Ver', href: '#/pedidos/<id>' })`.

---

## 6. Alterações não salvas

```js
form.addEventListener('input', () => ctx.marcarAlterado(true));
form.addEventListener('change', () => ctx.marcarAlterado(true));
// … depois de salvar com sucesso:
ctx.marcarAlterado(false);
```

Com o aviso ligado:

- o topo mostra a pílula "Alterações não salvas" (no celular, só o ponto dourado);
- trocar de rota (menu, link, botão Voltar, `ctx.navegar`) abre a confirmação **"Descartar alterações?"** com
  "Descartar e sair" e "Continuar editando"; continuar devolve a URL e mantém tudo o que foi digitado;
- o botão "Sair" pergunta "Você tem alterações não salvas. Sair do painel mesmo assim?";
- fechar ou recarregar a aba do navegador mostra o aviso nativo do navegador.

O aviso é desligado automaticamente a cada renderização de rota. `marcarAlterado()` sem argumento liga.

---

## 7. Sessão, login e permissões

- Só quem está em `admins` (`rpc('eh_admin')` = `true`) vê o painel; os demais recebem "Sem permissão…" e saem.
- `ctx.supabase` usa o JWT da administradora. Pela RLS (ARQUITETURA §4.3) ela pode tudo em `conteudo_site`,
  `configuracoes`, `categorias` e `produtos`; em `pedidos`/`pedido_itens` pode ler, alterar e apagar;
  em `pedido_eventos` pode ler e apagar, e criar/alterar só eventos com `tipo = 'nota'`; em `admins`, só ler.
  As RPCs `alterar_status_pedido` e `confirmar_pagamento` são só do servidor: use `/api/admin/*` (§9.5).
- **Sessão expirada**: quando `chamarApi` recebe 401 (mesmo depois de renovar o token) ou `erroSupabase` vê JWT
  vencido, o app abre o login **por cima** da página, que fica inerte e preservada. Se a mesma pessoa entra de novo,
  volta exatamente para onde estava, com o que tinha digitado (a página **não** é renderizada de novo e a limpeza
  não é chamada). A página só precisa mostrar `r.mensagem` ("Sua sessão expirou. Entre novamente.") e seguir.
  Modais abertos são fechados com `null` quando o login aparece (um `<dialog>` modal deixaria a tela de login
  inerte); o que estava digitado **dentro** do modal se perde, o da página fica.
- "Sair": confirma se houver alterações, chama a limpeza da página e desmonta o painel.
- Recuperação de senha, convite e links vencidos são tratados no `app.js`; nenhuma página mexe nisso.

---

## 8. `ui.js` — referência completa

Todas as 35 exportações. As de 8.1 são puras (rodam no Node, sem `document`); as demais criam elementos.
Testes em `tests/unit/painel-ui.test.js` (as que criam elementos rodam num DOM do linkedom).

### 8.1 Formatação e utilitários (puros)

**`STATUS_PEDIDO`** — lista congelada dos status, na ordem do fluxo (a mesma do banco):

| Status | `rotuloStatusPedido` | `corStatusPedido` (classe `selo--<cor>`) |
|---|---|---|
| `aguardando_pagamento` | Aguardando pagamento | ambar |
| `pagamento_em_analise` | Pagamento em análise | azul |
| `pago` | Pago | verde |
| `em_separacao` | Em separação | ouro |
| `enviado` | Enviado | roxo |
| `entregue` | Entregue | floresta |
| `cancelado` | Cancelado | cinza |
| `reembolsado` | Reembolsado | vermelho |

**`rotuloStatusPedido(status) → texto`** — status desconhecido volta como veio; vazio → `"Desconhecido"`.

**`corStatusPedido(status) → texto`** — desconhecido → `"cinza"`.

**`escapar(txt) → texto`** — escapa `& < > " '`; `null`/`undefined` → `""`.
`ui.escapar('<b>"Oi"</b>')` → `&lt;b&gt;&quot;Oi&quot;&lt;/b&gt;`. Prefira `el()`, que nunca interpreta HTML.

**`formatarPreco(centavos, { simbolo = true }) → texto`**
`formatarPreco(123456)` → `"R$ 1.234,56"`; `formatarPreco(4590, { simbolo: false })` → `"45,90"` (valor para campo);
`null`, `''` ou inválido → `"—"` (ou `""` sem símbolo). Negativos ganham `-` na frente.

**`lerPreco(texto) → centavos | null`** — texto digitado para centavos (número também é aceito: `12.5` → 1250).

| Entrada | Saída |
|---|---|
| `"12,50"` | 1250 |
| `"1.234,56"` | 123456 |
| `"12"` | 1200 |
| `"R$ 0,99"` | 99 |
| `"12.5"` (ponto com 1 ou 2 casas = decimal) | 1250 |
| `"1.234"` (ponto com 3 casas = milhar) | 123400 |
| `""`, `"-3"`, `"1,234"` (3 casas), texto | `null` |

Valores acima de 2.147.483.647 centavos (limite do `int` do Postgres) → `null`. Para separar "vazio" de "inválido":
`entrada.value.trim() !== '' && ui.lerPreco(entrada.value) === null` é inválido.

**`formatarData(valor, { hora = true }) → texto`** — ISO ou `Date`, no fuso `America/Belem`.
`formatarData('2026-10-15T17:30:00Z')` → `"15/10/2026 14:30"`; com `{ hora: false }` → `"15/10/2026"`;
`'2026-10-15'` (só data) não sofre fuso → `"15/10/2026"`; vazio/inválido → `"—"`.

**`tempoRelativo(valor, agora = Date.now()) → texto`** — `"agora"` (< 1 min), `"há 5 min"`, `"há 3 h"`, `"ontem"`,
`"há 4 dias"` (até 7 dias); depois disso a data (`"15/10/2026"`). Inválido → `"—"`.
Use com `el('time', { datetime: iso, title: ui.formatarData(iso) }, ui.tempoRelativo(iso))`.

**`formatarNumeroPedido(numero) → texto`** — `1042` → `"#1042"`; vazio → `"#—"`.

**`formatarBytes(bytes) → texto`** — `512` → `"512 B"`, `15360` → `"15 KB"`, `2400000` → `"2,3 MB"`; inválido → `"—"`.

**`slugify(txt, { max = 80 }) → texto`** — só `a-z`, `0-9` e hífen simples (casa com o check de `slug` do banco).
`"Creme de Cupuaçu & Cia!"` → `"creme-de-cupuacu-e-cia"`. Sem nada aproveitável → `""` (trate antes de salvar).

**`moverItem(lista, de, para) → nova lista`** — cópia com o item movido; índices fora da lista são limitados às pontas.
`moverItem(['a','b','c'], 0, 2)` → `['b','c','a']`. Base para as listas reordenáveis (§11.15).

**`debounce(fn, ms = 250) → função`** — só chama `fn` depois de `ms` sem novas chamadas; `.cancelar()` descarta a pendente.
```js
const buscar = ui.debounce(() => carregar(campoBusca.value), 300);
campoBusca.addEventListener('input', buscar);
// na limpeza: buscar.cancelar();
```

**`urlPermitida(valor, { midia = false }) → texto | null`** — o filtro de URL usado por `el()` em `href`, `src`,
`action`, `poster` etc. Aceita relativa, `http(s):`, `mailto:`, `tel:`; com `{ midia: true }` também `blob:` e
`data:image/(png|jpeg|gif|webp|avif)`. Outros esquemas (`javascript:`, `data:text/html` …) → `null`.
(Para validar endereços digitados no CMS existe `urlSegura` em `/js/cms/aplicar.js`; para mídia,
`midia.enderecoDeMidiaValido`, §10.2.)

### 8.2 Construção de elementos

**`el(tag, attrs, ...filhos) → HTMLElement`** — cria um elemento **sem nunca interpretar HTML**.

- `filhos`: texto e números viram nós de texto; elementos são anexados; arrays são achatados; `null`, `undefined`,
  `false` e `true` são **ignorados**.
- `attrs` pode ser omitido: `el('p', 'texto')` e `el('div', [filhos])` funcionam.
- `class`: texto ou lista (itens falsos são descartados): `{ class: ['selo', ativo && 'selo--verde'] }`.
- `dataset`: `{ dataset: { id: p.id } }` → `data-id`.
- `style`: texto ou objeto (`{ justifyContent: 'flex-end', '--cor': '#fff' }`).
- `eventos`: `{ eventos: { click: fn, input: fn } }`.
- `value`, `checked`, `selected`, `indeterminate` viram propriedades (em `<textarea>`, `value` vira o texto; em
  `<select>`, `value` é aplicado depois das opções).
- Booleanos: `true` → atributo vazio (`hidden: true`, `disabled: true`); `false`/`null`/`undefined` → **omitido**.
  Em `aria-*` o booleano vira texto: `'aria-expanded': false` → `aria-expanded="false"`, `'aria-hidden': true` →
  `aria-hidden="true"` (`null`/`undefined` continuam omitindo). `data-*` com `false` é omitido.
- Demais atributos → `setAttribute` (números viram texto).
- Lança `TypeError` para `on*` (`onclick`…), `srcdoc`, `innerHTML`, `outerHTML`, tag ou nome de atributo inválido.
- URL recusada por `urlPermitida` em `href/src/action/formaction/poster/cite/data/background/xlink:href`, ou
  `srcset` com URL ruim: o atributo é descartado e sai um aviso no console.
- Não cria SVG (use `icone`).

```js
const { el } = ctx.ui;
el('a', { class: 'cartao__link', href: `#/pedidos/${p.id}` }, 'Ver pedido ', ctx.ui.icone('avancar'));
el('img', { src: produto.imagens[0]?.src, alt: produto.nome, loading: 'lazy' });
el('input', { type: 'checkbox', checked: produto.ativo, eventos: { change: aoMudar } });
```

**`icone(nome, { rotulo = '', classe = '', tamanho }) → SVGElement`** — `<svg class="icone …">` 24×24 de traço
(`currentColor`). Decorativo (`aria-hidden="true"`) por padrão; com `rotulo` vira `role="img"` com `<title>`.
`tamanho` define `width`/`height`; sem ele o tamanho vem do CSS (`.icone` = 1,25 em). Nome desconhecido → ícone `info`.

**`ICONES`** — nomes aceitos (47):
`inicio, conteudo, midia, produtos, categorias, pedidos, configuracoes, sair, externo, menu, fechar, olho,
olho-fechado, mais, lixeira, editar, subir, descer, copiar, duplicar, arrastar, upload, busca, check, alerta, info,
sucesso, erro, voltar, avancar, video, loja, caminhao, relogio, dinheiro, atualizar, link, caixa, usuario, cadeado,
email, cartao, banco, escudo, imagem, grafico, estrela`.

**`novoId(prefixo = 'ui') → texto`** — id único (`"prefixo-12"`) para ligar `label`/`aria-labelledby`/`aria-describedby`.

### 8.3 Componentes

**`botao(opcoes) → <button> | <a>`**

| Opção | Padrão | Efeito |
|---|---|---|
| `texto` | `''` | Texto visível. Sem texto = botão só de ícone (`botao--icone`). |
| `tipo` | `'secundario'` | Vira a classe `botao--<tipo>`: `primario`, `secundario`, `perigo`, `perigo-suave`, `fantasma`, `ouro`. |
| `tamanho` | — | `pequeno` ou `grande`. |
| `icone` / `iconeDireita` | — | Nome do ícone antes / depois do texto. |
| `rotulo` | — | `aria-label` (e `title` quando não há texto). **Obrigatório** em botão só de ícone. |
| `aoClicar` | — | Ouvinte de `click`. |
| `href` | — | Cria `<a class="botao …">` em vez de `<button>`. |
| `tipoHtml` | `'button'` | `type` do `<button>` (`'submit'` em formulários). |
| `bloco` | `false` | Largura total (`botao--bloco`). |
| `classe` | — | Classe extra. |
| `attrs` | `{}` | Atributos extras (`id`, `disabled: true`, `target`, `rel`, `'aria-controls'`…). Sobrescrevem os gerados — não passe `class` aqui, use `classe`. |

```js
ui.botao({ texto: 'Salvar produto', tipo: 'primario', icone: 'check', tipoHtml: 'submit' });
ui.botao({ tipo: 'fantasma', tamanho: 'pequeno', icone: 'lixeira', rotulo: 'Remover foto', aoClicar: remover });
ui.botao({ texto: 'Ver na loja', iconeDireita: 'externo', href: `/loja/produto?slug=${slug}`, attrs: { target: '_blank', rel: 'noopener' } });
```

**`ocupado(alvo, tarefa) → Promise<resultado da tarefa | undefined>`** — põe `aria-busy="true"` e `disabled` no
botão (o CSS troca o conteúdo por um spinner), executa `tarefa()` e restaura no fim (inclusive com erro, que é
relançado). Clique enquanto ocupado → devolve `undefined` sem executar de novo. Sem `alvo`, só executa.

```js
await ui.ocupado(botaoSalvar, async () => { … });
```

**`campo(opcoes) → { elemento, entrada, ler(), definirErro(msg | null) }`** — campo completo: rótulo, entrada,
ajuda e erro ligados por `for`/`aria-describedby`.

| Opção | Efeito |
|---|---|
| `rotulo` | Texto do `<label>`. |
| `nome` | `name` da entrada (também entra no id gerado). |
| `tipo` | `text` (padrão), `email`, `url`, `number`, `password`, `search`, `tel`, `date`, `textarea`, `select`, `preco`, `senha`, `checkbox`, `interruptor`. |
| `valor` | Valor inicial (`preco`: centavos; `checkbox`/`interruptor`: booleano; `select`: valor da opção; `date`: `'aaaa-mm-dd'`). |
| `ajuda` | Texto de ajuda abaixo da entrada. |
| `obrigatorio` | `required`, `aria-required="true"` e asterisco vermelho no rótulo (não vale para `checkbox`/`interruptor`). |
| `placeholder` | Exemplo dentro da entrada (`preco` usa `0,00` por padrão). |
| `opcoes` | `select`: textos ou `{ valor, rotulo, desativado }`. |
| `linhas` | `textarea`: linhas (padrão 4). |
| `prefixo` / `sufixo` | Texto colado à entrada (`entrada-grupo`), ex.: `sufixo: 'g'`, `sufixo: '%'`. `preco` usa `prefixo: 'R$'`. |
| `id` | Id da entrada (padrão gerado: `campo-<nome>-<n>`; ajuda = `<id>-ajuda`, erro = `<id>-erro`). |
| `classe` | Classe extra no `.campo`. |
| `attrs` | Atributos extras **da entrada**: `maxlength`, `min`, `max`, `step`, `inputmode`, `autocomplete`, `disabled`, `readonly`… |

Detalhes por tipo:

- `preco`: `<input type="text" inputmode="decimal">` com `R$` à esquerda; `ler()` → centavos ou `null`.
- `number`: `ler()` → número (aceita vírgula) ou `null` se vazio/inválido.
- `senha`: `password` com botão "Mostrar senha"/"Ocultar senha" (`entrada-grupo__botao`).
- `checkbox`: caixa de marcar (`.caixa`); `interruptor`: chave liga/desliga com `role="switch"`. `ler()` → booleano.
- `select`: `valor` seleciona a opção; sem `valor`, fica a primeira.
- Demais: `ler()` → `entrada.value` **sem `trim`**.
- `definirErro('texto')` mostra o erro, põe `aria-invalid="true"` e a classe `campo--erro`; `definirErro(null)` limpa.
  O erro some sozinho quando a pessoa corrige (evento `input`, ou `change` em select/checkbox/interruptor).
- `obrigatorio` liga a validação nativa do navegador: use `<form novalidate>` e valide você mesma(o).

```js
const preco = ui.campo({ rotulo: 'Preço', nome: 'preco', tipo: 'preco', valor: 4590, obrigatorio: true });
const promo = ui.campo({ rotulo: 'Preço promocional', nome: 'promo', tipo: 'preco', ajuda: 'Vazio = sem promoção.' });
const categoria = ui.campo({ rotulo: 'Categoria', nome: 'categoria', tipo: 'select', valor: produto.categoria_id ?? '',
  opcoes: [{ valor: '', rotulo: 'Sem categoria' }, ...categorias.map((c) => ({ valor: c.id, rotulo: c.nome }))] });
const peso = ui.campo({ rotulo: 'Peso', nome: 'peso', tipo: 'number', valor: 300, sufixo: 'g', attrs: { min: '1', step: '1' } });
const ativo = ui.campo({ rotulo: 'Visível na loja', nome: 'ativo', tipo: 'interruptor', valor: true });

if (promo.ler() !== null && promo.ler() >= preco.ler()) promo.definirErro('A promoção precisa ser menor que o preço.');
```

**`cabecalhoPagina({ titulo, descricao, voltar, acoes = [] }) → <header class="pagina-cabecalho">`** —
`<h1 tabindex="-1">` com o título (recebe o foco ao trocar de rota), descrição opcional, link de volta opcional
(`voltar: { href, texto = 'Voltar' }`) e botões à direita (`acoes`, lista de elementos). No celular (< 480 px)
as ações ocupam a largura toda.

```js
ui.cabecalhoPagina({
  titulo: `Pedido ${ui.formatarNumeroPedido(p.numero)}`,
  descricao: `Feito ${ui.tempoRelativo(p.criado_em)}`,
  voltar: { href: '#/pedidos', texto: 'Pedidos' },
  acoes: [ui.seloStatusPedido(p.status)],
});
```

**`seloStatusPedido(status) → <span class="selo selo--<cor>">rótulo</span>`**.

**`tabela(opcoes) → <div class="tabela-container">`** (ou um `.estado-vazio` se não houver linhas) — tabela que
vira lista de cartões abaixo de 720 px.

| Opção | Efeito |
|---|---|
| `colunas` | `[{ titulo, chave?, celula?(linha, i), alinhar?, principal?, classe?, ocultarNoCelular? }]`. `celula` devolve elemento, texto, número ou lista; sem `celula`, usa `linha[chave]`. `alinhar`: `'direita'` (valores, números tabulares) ou `'centro'`. |
| `linhas` | Lista de objetos. |
| `link` | `(linha) => hash`: a coluna principal (ou a primeira) vira `<a class="tabela__link">` que cobre a linha inteira. Células com botão, link ou entrada ficam por cima (ver abaixo). |
| `vazio` | Texto do estado vazio (padrão `"Nada por aqui ainda."`). |
| `legenda` | `<caption>` só para leitores de tela. |
| `classe` | Classe extra no container. |

- Célula `null`, `undefined` ou `''` mostra `"—"`; booleano mostra `"Sim"`/`"Não"` (para outra palavra, devolva
  texto ou um selo); `0` aparece como `"0"`.
- `principal: true`: negrito; no celular aparece sem rótulo e maior. Ponha a coluna principal primeiro.
- Cada `<td>` recebe `data-rotulo="<titulo>"`, usado como rótulo no celular.
- `ocultarNoCelular: true`: coluna some abaixo de 720 px.
- Com `link`, o link cobre a linha, mas toda célula (fora a do link) que tem `a[href]`, `button`, `input`,
  `select`, `textarea`, `label` ou `[tabindex]` recebe `tabela__celula--interativa` e fica por cima: caixas de
  marcar, links e botões funcionam normalmente; clicar no resto dessa célula não abre a linha. Não ponha outros
  controles na célula do link.

**`abas({ abas, ativa, aoTrocar, rotulo = 'Seções' }) → { elemento, ativar(id, { focar }), ativa() }`** — abas
acessíveis (`role="tablist"`, setas ←/→, Home/End). Cada aba: `{ id, rotulo, icone?, conteudo }`; `conteudo` pode
ser elemento ou função (criado só na primeira vez que a aba abre). `ativa`: id inicial (padrão: a primeira).
`aoTrocar(id)` é chamado nas trocas (não na abertura).

```js
const abas = ui.abas({
  rotulo: 'Partes do produto',
  ativa: ctx.consulta.aba,
  aoTrocar: (id) => ctx.navegar(`${ctx.hash.split('?')[0]}?aba=${id}`, { silencioso: true }),
  abas: [
    { id: 'dados', rotulo: 'Dados', icone: 'produtos', conteudo: formDados },
    { id: 'fotos', rotulo: 'Fotos', icone: 'imagem', conteudo: () => montarFotos() },
  ],
});
ctx.raiz.append(abas.elemento);
```

### 8.4 Estados e avisos

As três funções de estado **substituem todo o conteúdo** de `container` e devolvem o elemento criado
(`container = null` só cria, para você anexar).

**`estadoCarregando(container, { linhas = 3, tipo = 'lista', mensagem = 'Carregando…' }) → elemento`** —
esqueleto animado com `role="status"` e a mensagem para leitores de tela. `tipo`: `'lista'` (linhas finas de
larguras variadas), `'tabela'` (linhas altas), `'cartoes'` (quadrados em grade).

**`estadoVazio(container, msg, { titulo, icone = 'caixa', acao }) → elemento`** — ícone em círculo, título opcional,
texto e botão opcional `acao: { texto, href?, aoClicar?, icone?, tipo = 'primario' }`.

**`estadoErro(container, msg, { titulo = 'Algo deu errado', aoTentarNovamente }) → elemento`** — versão de erro
(`role="alert"`, ícone vermelho) com botão "Tentar novamente" quando `aoTentarNovamente` é passado.

```js
ui.estadoCarregando(lista, { linhas: 5, tipo: 'tabela' });
ui.estadoVazio(lista, 'Quando alguém comprar na loja, o pedido aparece aqui.', { titulo: 'Nenhum pedido ainda', icone: 'pedidos' });
ui.estadoErro(lista, r.mensagem, { aoTentarNovamente: carregar });
```

**`aviso(mensagem, tipo = 'info', { titulo }) → <div class="aviso aviso--<tipo>">`** — caixa fixa na página.
`tipo`: `info`, `sucesso`, `alerta` (ou `aviso`, o mesmo âmbar), `erro` (só `erro` recebe `role="alert"`);
desconhecido vira `info`. `mensagem` pode ser texto ou elemento.

```js
ui.aviso('As mudanças aparecem no site em até 15 segundos.', 'info');
ui.aviso('3 produtos estão sem preço: aparecem na loja com R$ 00,00 e ninguém consegue finalizar a compra até você definir o preço.', 'alerta', { titulo: 'Sem preço' });
```

### 8.5 Toasts, modais e confirmação

**`toast(msg, tipo = 'info', { duracao }) → fechar()`** — mensagem passageira no canto inferior direito (no
celular, faixa inferior). `tipo`: `info`, `sucesso`, `erro`, `aviso` (ou `alerta`: os dois nomes valem aqui e em `ui.aviso`; tipo
desconhecido vira `info`). Duração: erro 8 s, demais 4,5 s; `duracao: 0` só fecha no X. Pausa com o
mouse em cima. No máximo 4 na tela. Aparece por cima de modais abertos.

**`modal(opcoes) → controle`** — `<dialog>` nativo: fundo inerte, Esc, foco preso dentro e devolvido ao elemento
que estava focado ao fechar. No celular (< 600 px) vira folha que sobe do rodapé.

| Opção | Padrão | Efeito |
|---|---|---|
| `titulo` | `''` | `<h2>` do modal (`aria-labelledby`). |
| `descricao` | — | Parágrafo inicial ligado por `aria-describedby`. |
| `conteudo` | — | Elemento, lista de elementos ou texto (texto vira `<p>`). |
| `acoes` | `[]` | Botões do rodapé, na ordem: `{ texto, tipo = 'secundario', icone, valor, aoClicar(controle), fechar, autofoco }`. |
| `tamanho` | `'medio'` | `pequeno` (460 px), `medio` (640 px), `grande` (1040 px), `cheio` (tela quase toda). |
| `fecharComEsc` | `true` | Esc fecha com `null`. |
| `fecharAoClicarFora` | `true` | Clique no fundo fecha com `null`. |
| `classe` | — | Classe extra no `<dialog>` (para CSS da página). |
| `aoAbrir` | — | `aoAbrir(controle)` logo depois de abrir. |

Regras das ações:

- Sem `aoClicar`: fecha e `resultado` resolve com `valor` (ou `null`).
- Com `aoClicar`: o botão fica ocupado (e Esc/X/fundo desligados) até a promessa terminar. Devolver `false` ou ter
  `fechar: false` mantém o modal aberto. **Lançar erro** mostra `toast(erro.message, 'erro')` e mantém aberto.
  Senão fecha com `valor` (se definido) ou com o que `aoClicar` devolveu.
- Foco inicial: elemento com `autofocus` no conteúdo → ação com `autofoco: true` → primeira entrada do conteúdo →
  botão primário/perigo → X.
- Troca de rota (link, menu, `ctx.navegar`, botão Voltar) e login por cima (sessão expirada) fecham o modal com
  `null` (§3.3, §7).

`controle = { elemento, corpo, rodape, resultado: Promise, fechar(valor = null), definirTitulo(texto), definirOcupado(bool) }`.
`definirOcupado(true)` bloqueia Esc, X e clique fora (use durante um envio feito fora das ações).

```js
const controle = ui.modal({
  titulo: 'Nova nota no pedido',
  conteudo: el('div', { class: 'formulario' }, nota.elemento),
  acoes: [
    { texto: 'Cancelar', valor: null },
    { texto: 'Salvar nota', tipo: 'primario', aoClicar: async () => { …; return true; } },
  ],
});
const salvou = await controle.resultado; // true, null (cancelou/Esc/X) ou o valor da ação
```

Enter dentro do modal não envia nada sozinho (o conteúdo não é um `<form>`).

**`fecharModais(valor = null) → número`** — fecha todos os modais abertos (o mais recente primeiro; cada
`resultado` resolve com `valor`, e `confirmar` com `false`) e devolve quantos fechou. O app já chama na troca de
rota e quando o login aparece; a página raramente precisa (ex.: fechar o `seletorDeMidia`, que não devolve o
controle).

**`confirmar(msg, { perigo = false, titulo, textoConfirmar, textoCancelar = 'Cancelar' }) → Promise<boolean>`** —
modal pequeno de sim/não. `msg` é sempre texto (seguro com dado do banco). Com `perigo`: título padrão
"Tem certeza?", botão vermelho "Sim, continuar" (troque por `textoConfirmar`) e foco inicial em "Cancelar". Sem
`perigo`: "Confirmar" e botão primário. Esc/X/fundo → `false`.

```js
if (!(await ui.confirmar(`Excluir a categoria ${c.nome}? Esta ação não pode ser desfeita.`, { perigo: true, textoConfirmar: 'Excluir categoria' }))) return;
```

### 8.6 Diversos

**`carregarCss(nome) → Promise<void>`** — insere `<link rel="stylesheet" href="/admin/css/<nome>.css">` uma única
vez (chamadas seguintes devolvem a mesma promessa). `nome` só `a-z`, `0-9` e hífen, senão a promessa rejeita com
`TypeError`. Se o arquivo falhar, resolve mesmo assim (aviso no console) e a próxima chamada tenta de novo.

**`copiarTexto(texto, { mensagem = 'Copiado!' }) → Promise<boolean>`** — copia para a área de transferência e mostra
toast de sucesso (ou de erro: "Não foi possível copiar. Selecione e copie manualmente.").

```js
ui.botao({ texto: 'Copiar código', icone: 'copiar', aoClicar: () => ui.copiarTexto(p.codigo_rastreio, { mensagem: 'Código copiado.' }) });
```

---

## 9. `api.js` — referência completa

Nada em `api.js` lança erro para quem chama: tudo volta como `{ ok: true, … }` ou
`{ ok: false, erro: 'codigo', mensagem: 'Texto em português', status, … }`. Mostre `mensagem` direto para a pessoa;
use `erro` (e `campo`, quando vier) para decidir o que fazer.

### 9.1 `chamarApi(caminho, { metodo, corpo, sinal, timeoutMs = 30000 })`

Chama uma rota do próprio site com `Authorization: Bearer <jwt da sessão>`.

- `caminho`: `'/api/admin/status'` ou `'admin/status'` (vira `/api/admin/status`). URL absoluta, `//…` ou caminho
  fora de `/api/` → `{ ok: false, erro: 'caminho_invalido' }` (o token nunca vai para outro domínio).
- `metodo`: padrão `GET` sem `corpo`, `POST` com `corpo`. `corpo` (objeto) vai como JSON.
- `sinal`: passe `ctx.sinal` para cancelar quando a rota trocar.
- 401: renova o token e tenta mais uma vez; se continuar 401, o app abre o login por cima (§7).

Resultado:

| Situação | Retorno |
|---|---|
| 2xx com JSON (objeto) e `ok !== false` | `{ ...json, ok: true, status }` |
| Resposta com JSON de erro | `{ ...json, ok: false, erro: json.erro ou 'http_<status>', mensagem: json.mensagem ou padrão do status, status }` — extras como `campo` vêm junto |
| Erro sem JSON | `{ ok: false, erro: 'http_<status>', mensagem: padrão do status, status }` |
| 2xx sem JSON | `{ ok: false, erro: 'resposta_invalida', mensagem: 'Resposta inesperada do servidor.', status }` |
| Sem rede | `{ ok: false, erro: 'sem_conexao', mensagem, status: 0, detalhe }` |
| Passou de `timeoutMs` | `{ ok: false, erro: 'tempo_esgotado', status: 0 }` |
| `sinal` abortado | `{ ok: false, erro: 'cancelado', mensagem: 'Operação cancelada.', status: 0 }` — ignore em silêncio |

Mensagens padrão por status (`mensagemHttp`): 0 sem conexão, 400 "Alguns dados não foram aceitos…", 401 "Sua sessão
expirou…", 403 "Você não tem permissão…", 404 "Não encontrado.", 405, 409 "A operação não pôde ser concluída no estado
atual.", 413, 429 "Muitas tentativas seguidas…", 500, 502 "Um serviço externo não respondeu…", 503 "Esta integração
ainda não está configurada.", 504; outros ≥ 500 usam a de 500.

```js
const r = await ctx.api.chamarApi('/api/admin/pedido-status', {
  corpo: { pedido_id: pedido.id, status: 'enviado', codigo_rastreio: codigo.ler().trim(), notificar_cliente: true },
  sinal: ctx.sinal,
});
if (!ctx.ativo() || r.erro === 'cancelado') return;
if (!r.ok) {
  if (r.campo === 'codigo_rastreio') codigo.definirErro(r.mensagem);
  else ctx.ui.toast(r.mensagem, 'erro');
  return;
}
ctx.ui.toast(r.email_enviado ? 'Status alterado e cliente avisado por e-mail.' : 'Status alterado.', 'sucesso');
ctx.atualizarContadores();
```

### 9.2 `consultar(construtor)`

Executa uma consulta do supabase-js e normaliza:
`{ ok: true, dados, total, status }` ou o erro de `erroSupabase`. `total` é o `count` (quando a consulta pede
`{ count: 'exact' }`), senão `null`; `dados` é `null` em consultas `head: true`.

```js
const r = await api.consultar(supabase.from('produtos').select('id, nome, preco_centavos', { count: 'exact' }).range(0, 19));
if (!r.ok) return ui.estadoErro(lista, r.mensagem, { aoTentarNovamente: carregar });
// r.dados (linhas), r.total (total sem paginação)
```

`.single()` sem linha → `erro: 'nao_encontrado'`; prefira `.maybeSingle()` (`dados: null`) quando "não existe" é normal.

### 9.3 `erroSupabase(erro, status) → { ok: false, erro, mensagem, status, detalhe, … }`

Converte erros do PostgREST, Auth e Storage. `detalhe` guarda a mensagem original (para o console, não para a tela).

| Origem | `erro` | `mensagem` |
|---|---|---|
| JWT vencido (`PGRST301`/`PGRST303`, "jwt expired", status 401) | `nao_autenticado` | "Sua sessão expirou. Entre novamente." — e o app abre o login |
| Falha de rede | `sem_conexao` | "Não foi possível falar com o servidor. Verifique sua internet e tente de novo." |
| RLS / `42501` / 403 | `sem_permissao` | "Você não tem permissão para esta ação." |
| `23505` (único) | `duplicado` + `campo` | "Já existe um registro com este endereço (slug)." (`slug`, `codigo` → código, `nome`, `sku` → SKU, `chave`, `email` → e-mail; outros: "Já existe um registro igual.") |
| `23503` (chave estrangeira) | `em_uso` | "Este item está ligado a outros registros e não pode ser removido." |
| `23502` (não nulo) | `campo_obrigatorio` + `campo` | "Preencha os campos obrigatórios." |
| `23514`, `22P02`, `22003`, `22001` (check, formato, número, tamanho) | `dados_invalidos` + `restricao` (nome do check, ex. `produtos_preco_promocional_check`) | "Algum valor não foi aceito. Confira os campos e tente de novo." |
| `PGRST116` | `nao_encontrado` | "Registro não encontrado." |
| 413 / arquivo grande | `muito_grande` | "O arquivo passa do limite de 50 MB." |
| Tipo de arquivo recusado | `tipo_nao_aceito` | "Tipo de arquivo não aceito. Use JPG, PNG, WebP, GIF, AVIF, MP4 ou WebM." |
| 429 | `muitas_tentativas` | "Muitas tentativas seguidas…" |
| Outro | `erro_supabase` | "Não foi possível concluir a operação. Tente de novo." |

Use `restricao` para pôr o erro no campo certo (ex.: `produtos_preco_promocional_check` → campo "preço promocional").

### 9.4 Outras exportações

| Função | Uso |
|---|---|
| `obterSupabase()` | O mesmo cliente de `ctx.supabase` (lança se o painel não iniciou). |
| `obterConfigSupabase()` | `{ supabaseUrl, supabaseAnonKey }` públicos. |
| `obterToken({ forcarRenovacao = false }) → Promise<jwt \| null>` | JWT atual (renovado se pedido). Raramente necessário: `chamarApi` e `enviarArquivo` já usam. |
| `mensagemHttp(status)` | Mensagem padrão de um status HTTP (tabela em 9.1). |
| `configurarApi(…)` | **Só o `app.js` chama.** |

### 9.5 Rotas `/api/admin/*` (resumo)

Todas exigem admin: sem token/expirado → 401 `nao_autenticado`; não admin → 403 `sem_permissao`; servidor sem
Supabase → 503 `supabase_nao_configurado`; Auth/banco fora → 502 `falha_supabase` ou `falha_banco`; método errado →
405 `metodo_nao_permitido`; inesperado → 500 `erro_interno`. Entrada e saída completas no cabeçalho de cada arquivo
em `api/admin/` e em ARQUITETURA §6.6.

| Rota | Corpo | Resposta `ok` | Erros próprios |
|---|---|---|---|
| `GET /api/admin/status` | — | `{ integracoes: { supabase, mercadopago, melhor_envio, email, webhook_assinatura, site_url } }` | — |
| `POST /api/admin/pedido-status` | `{ pedido_id, status, codigo_rastreio?, url_rastreio?, nota?, repor_estoque?, notificar_cliente? }` | `{ pedido_id, numero, status_anterior, status_novo, mudou, estoque_reposto, estoque_baixado, email_enviado }` | 400 `dados_invalidos` com `campo` (`pedido_id`, `codigo_rastreio`, `url_rastreio`, `nota`), 400 `status_invalido`, 404 `pedido_nao_encontrado` |
| `POST /api/admin/envio` | `{ pedido_id, acao, chave_nfe?, refazer? }`, `acao`: `adicionar_carrinho`, `comprar`, `gerar`, `imprimir`, `rastrear` | `{ acao, … }` | 400 `acao_invalida`, `chave_nfe_invalida`, `origem_incompleta`; 404 `pedido_nao_encontrado`; 409 `envio_indisponivel`, `status_nao_permite_envio`, `sem_etiquetas`, `etiquetas_existentes`, `etiquetas_pagas`, `etiquetas_canceladas`, `etiqueta_nao_gerada`, `etiqueta_em_geracao`, `servico_invalido`, `servico_indisponivel`; 503 `frete_nao_configurado` |
| `POST /api/admin/pagamento` | `{ pedido_id }` | `{ encontrado, total_pagamentos, pagamento, resultado, mensagem? }` | 400 `dados_invalidos`; 404 `pedido_nao_encontrado`; 503 `pagamento_indisponivel` |

---

## 10. `midia.js` — referência completa

### 10.1 Bucket, pastas e nomes

| Constante | Valor |
|---|---|
| `BUCKET` | `'midia'` (público para leitura; só admins gravam/apagam) |
| `PASTAS` | `['site', 'produtos', 'videos']` — `site/` = CMS, `produtos/` = fotos de produto, `videos/` = vídeos |
| `ROTULOS_PASTAS` | `{ site: 'Site', produtos: 'Produtos', videos: 'Vídeos' }` |
| `LIMITE_BYTES` | 50 MB (limite do bucket) |
| `IMAGEM_RECOMENDADA_BYTES` | 2 MB (acima disso: aviso) |
| `VIDEO_RECOMENDADO_BYTES` | 20 MB (acima disso: aviso) |
| `LADO_MAXIMO_PX` | 2000 (lado máximo da imagem otimizada) |
| `TIPOS_ACEITOS` | `imagem`: jpeg, png, webp, gif, avif · `video`: mp4, webm (SVG fica de fora de propósito) |

Nome no bucket: `<pasta>/<aaaa-mm>/<slug-do-nome>-<6 hex>.<ext>`, por exemplo
`produtos/2026-10/foto-do-creme-1-a1b2c3.jpg`. A URL pública é
`<supabaseUrl>/storage/v1/object/public/midia/<caminho>`.

**`ErroMidia`** — `Error` com `message` em português (mostre direto) e `.codigo`: `sem_arquivo`, `arquivo_invalido`,
`nao_autenticado`, `sem_conexao`, `cancelado` (ignore), `duplicado`, `pasta_invalida`, `caminho_invalido`,
`nao_encontrado`, ou um código de `erroSupabase` (`muito_grande`, `tipo_nao_aceito`, `sem_permissao`, `erro_supabase`…).

### 10.2 Funções puras

**`tipoDoArquivo(arquivo) → mime | ''`** — pelo `type` do arquivo; se vazio, pela extensão (`.JFIF` → `image/jpeg`).

**`categoriaDoTipo(mimeOuNome) → 'imagem' | 'video' | null`** — `'video/webm'` → `video`, `'foto.png'` → `imagem`, `'x.pdf'` → `null`.

**`validarArquivo(arquivo, { tipo }) → { ok, erro?, avisos: [texto], tipo, categoria }`** — confere tipo (só
`'imagem'`, só `'video'` ou, sem `tipo`, os dois), vazio e limite de 50 MB; `avisos` traz o aviso de imagem > 2 MB ou
vídeo > 20 MB. `erro` é a frase pronta ("Tipo de arquivo não aceito. Use JPG, PNG, WebP, GIF ou AVIF.").

**`nomeSeguroArquivo(nomeOriginal, pasta = 'site', { tipo, data = new Date(), sufixo }) → caminho`** — gera o nome
do bucket. `pasta` só `a-z0-9` e hífens (sem `/`), senão **`TypeError`**. Extensão pelo MIME `tipo` (ou pelo nome;
`jpeg` → `jpg`; desconhecida → `bin`). Nome vazio depois do slug → `arquivo`.

**`enderecoDeMidiaValido(texto) → boolean`** — aceita `https://…` ou caminho do próprio site (`/img/…`); recusa
`http://`, `//…` e textos com espaço/aspas/`<>`.

### 10.3 Storage

**`enviarArquivo(arquivo, pasta = 'site', { otimizar = true, aoProgresso, sinal }) → Promise<{ url, caminho, tamanho, tipo, nome, otimizado, avisos }>`**
— valida (imagem **ou** vídeo, qualquer pasta: para aceitar só imagem, chame `validarArquivo(arquivo, { tipo: 'imagem' })`
antes), otimiza imagens JPEG/PNG/WebP (`otimizarImagem`), envia direto ao Storage com o JWT e `x-upsert: false`
(nome repetido: tenta uma vez com outro sufixo). `aoProgresso({ enviados, total, fracao })` acompanha o envio (não a
otimização). `sinal` cancela (lança `ErroMidia` `cancelado`). `avisos` só vem preenchido quando não otimizou.
Lança `ErroMidia` em qualquer falha, inclusive `pasta_invalida` (pasta fora de `a-z0-9-`, antes de otimizar ou
enviar; `pasta` vazia vira `'site'`). Só a função pura `nomeSeguroArquivo` lança `TypeError`.

**`listarArquivos(pasta) → Promise<[{ nome, caminho, pasta, url, tamanho, tipo, categoria, criado_em }]>`** —
arquivos de `'site'`, `'produtos'`, `'videos'` ou de uma subpasta (`'site/2026-10'`); sem `pasta`, de todas.
Desce um nível (as pastas `aaaa-mm`), até 1000 itens por pasta, mais novos primeiro. `pasta` no resultado é a raiz
(`'site'`). Lança `ErroMidia`.

**`apagarArquivo(caminho) → Promise<true>`** — apaga pelo caminho no bucket. Caminho inválido → `caminho_invalido`;
nada apagado → `nao_encontrado` ("Arquivo não encontrado (ou sem permissão para apagar).").

**`urlPublica(caminho) → url`** e **`caminhoDaUrl(url) → caminho | null`** — conversão entre os dois; `caminhoDaUrl`
devolve `null` para URLs que não são do bucket `midia` deste projeto (ex.: `/img/…`), útil antes de `apagarArquivo`.

**`otimizarImagem(arquivo, { maxLado = 2000, qualidade = 0.85 }) → Promise<{ arquivo, otimizado, largura, altura, larguraOriginal, alturaOriginal }>`**
— reduz para no máximo `maxLado` px e comprime em JPEG (WebP, ou PNG, se tiver transparência). Só JPEG/PNG/WebP;
GIF/AVIF voltam iguais. Se não ficar menor nem precisar reduzir, devolve o original (`otimizado: false`).

### 10.4 Componentes

**`escolherArquivos({ tipo, multiplo = false }) → Promise<File[]>`** — abre o seletor de arquivos do sistema
(filtrado por `tipo`); cancelar → `[]`.

**`criarAreaUpload({ tipo, multiplo = false, aoEscolher, texto }) → { elemento, definirProgresso(fracao | null, texto), desativar(bool) }`**
— área "Arraste o arquivo para cá ou [Escolher arquivo]" com formatos aceitos, barra de progresso e texto de
progresso. **Não valida nem envia**: só entrega os `File` para `aoEscolher(arquivos)` (um só se `multiplo` for falso).
`definirProgresso(0.42, 'Enviando… 42%')` mostra a barra; `definirProgresso(null, 'Arquivo enviado.')` esconde a
barra e deixa o texto. `desativar(true)` bloqueia novas escolhas.

```js
const imagens = [...produto.imagens];
const area = ctx.midia.criarAreaUpload({
  tipo: 'imagem', multiplo: true, texto: 'Arraste as fotos do produto para cá',
  aoEscolher: async (arquivos) => {
    area.desativar(true);
    try {
      for (const [i, arquivo] of arquivos.entries()) {
        const v = ctx.midia.validarArquivo(arquivo, { tipo: 'imagem' });
        if (!v.ok) { ctx.ui.toast(`${arquivo.name}: ${v.erro}`, 'erro'); continue; }
        area.definirProgresso(0, `Preparando ${arquivo.name}…`);
        try {
          const r = await ctx.midia.enviarArquivo(arquivo, 'produtos', {
            sinal: ctx.sinal,
            aoProgresso: ({ fracao }) => area.definirProgresso(fracao, `Enviando ${i + 1} de ${arquivos.length}… ${Math.round(fracao * 100)}%`),
          });
          imagens.push({ src: r.url, alt: '' });
          ctx.marcarAlterado(true);
          desenharFotos();
        } catch (erro) {
          if (erro.codigo === 'cancelado') return;
          ctx.ui.toast(erro.message, 'erro');
        }
      }
    } finally {
      area.definirProgresso(null, '');
      area.desativar(false);
    }
  },
});
```

**`miniatura(arquivo, { alt = '' }) → elemento`** — quadrado com a imagem (`loading="lazy"`) ou, para
`categoria === 'video'`, o vídeo parado em 0,5 s com selo de vídeo. `arquivo` precisa de `{ url, categoria }`.

**`seletorDeMidia({ tipo = 'imagem', pasta, titulo, permitirEndereco = true, atual }) → Promise<url | null>`** —
modal grande com (envio e biblioteca lado a lado a partir de 880 px; empilhados no celular):

- envio de arquivo novo (área de upload; para imagem, interruptor "Otimizar a imagem antes de enviar",
  ligado) para `pasta` (padrão `'site'` para imagem, `'videos'` para vídeo);
- a biblioteca do bucket inteiro (todas as pastas), filtrada pelo `tipo`, com busca pelo nome e filtro de
  pasta; clique seleciona, duplo clique escolhe e fecha;
- embaixo (se `permitirEndereco`), o campo "Ou use o endereço de uma imagem" (`https://…` ou `/img/…`);
- `atual`: URL já escolhida (fica selecionada na biblioteca, ou preenchida no campo de endereço se não for do bucket).

Resolve com a URL escolhida ("Usar esta imagem"/"Usar este vídeo"), ou `null` se cancelar. O arquivo enviado
ali já fica selecionado. Fechar no meio do envio cancela o upload. A troca de rota fecha o modal (resolve com
`null`); para fechá-lo por fora, use `ui.fecharModais()`.

```js
const url = await ctx.midia.seletorDeMidia({ tipo: 'imagem', pasta: 'produtos', titulo: 'Foto do produto', atual: foto.src });
if (url === null || !ctx.ativo()) return;
foto.src = url;
ctx.marcarAlterado(true);
```

---

## 11. `admin.css` — sistema de design

Mobile-first (360 px) até 1440 px. Todos os componentes abaixo existem em `admin.css`; os exemplos de marcação
mostram a estrutura que o CSS espera (quando há função em `ui.js`, prefira a função).

### 11.1 Tokens (`:root`)

| Grupo | Variáveis |
|---|---|
| Verdes | `--verde-950 #0B2A1C` (principal escuro), `--verde-900`, `--verde-800`, `--verde-700`, `--verde-600 #1F4F33` (links), `--verde-400`, `--verde-200`, `--verde-100`, `--verde-50` |
| Ouro | `--ouro-700`, `--ouro-600`, `--ouro-500 #C9982B` (destaque, foco), `--ouro-400`, `--ouro-200`, `--ouro-100` |
| Creme e texto | `--creme-50`, `--creme-100`, `--creme-200`, `--tinta #1A2A1E` (texto), `--tinta-suave #4B5A4E` (texto secundário), `--placeholder` |
| Superfícies | `--fundo #F6F2E9` (fundo da página), `--superficie #FFF`, `--superficie-2 #FAF7F0`, `--linha`, `--linha-forte` |
| Estados | `--perigo`, `--perigo-escuro`, `--perigo-fundo`, `--sucesso`, `--sucesso-fundo`, `--alerta`, `--alerta-fundo`, `--info`, `--info-fundo` |
| Fontes | `--serif` (Fraunces: `h1`–`h4`, títulos), `--sans` (Manrope: texto), `--display` (Baloo 2: botões, cabeçalhos de tabela, seções do menu) |
| Forma | `--raio-pequeno 6px`, `--raio 10px`, `--raio-grande 16px`, `--sombra-1`, `--sombra-2`, `--sombra-modal`, `--anel-foco` |
| Layout | `--menu-largura 260px`, `--topo-altura 64px`, `--gutter` (16 px; 24 px ≥ 720; 40 px ≥ 1280), `--alvo-toque 44px` |

### 11.2 Pontos de quebra usados

480 px (ações do cabeçalho e listas reordenáveis), 600 px (modais e toasts), 640 px (topo), **720 px**
(tabelas viram cartões, `oculto-celular`/`so-celular`, barra de ações fixa, espaçamentos), 880 px (seletor de mídia
em 2 colunas), 900 px (métricas em 4 colunas), **1024 px** (menu fixo × gaveta), 1100 px (`grade--painel` em 2
colunas), 1280 px (gutter 40 px). `lista-dados--colunas` muda pela largura dela mesma (4 colunas a partir de
36 rem), não da tela. Em telas de toque (`pointer: coarse`) os
botões têm no mínimo 44 px.

### 11.3 Utilitários

| Classe | Efeito |
|---|---|
| `sr-only` | Só para leitores de tela. |
| `texto-suave` / `texto-pequeno` | Cor secundária / 0,875 rem. |
| `texto-direita`, `alinhar-direita`, `alinhar-centro` | Alinhamento. |
| `truncar` | Uma linha com reticências (precisa de largura limitada). |
| `oculto-celular` | Some abaixo de 720 px. |
| `so-celular` | Some a partir de 720 px. |
| `mono` (e `code`) | Fonte monoespaçada (códigos, slugs, URLs). |
| `icone` | Tamanho padrão dos ícones (1,25 em). |
| `botao-link` | Botão com cara de link sublinhado, alvo de toque de 44 px. |
| `grupo-botoes` | Botões lado a lado com quebra e espaço de 10 px. |

### 11.4 Layout (do núcleo — não estilize nem reutilize)

`.painel` (grade topo + menu + principal; `.painel--menu-aberto` com a gaveta aberta), `.topo` e `.topo__*`
(fixo no alto, 64 px, `z-index` 30), `.menu-lateral` e `.menu-lateral__*` (60), `.menu-fundo` (55), `.principal`
(`<main>`, padding lateral = gutter, 56 px embaixo; 72 px ≥ 1024), `.pagina` (a `ctx.raiz`), `.acesso*` (telas de
login, 80), `.tela-carregando`, `.pular` (link "Pular para o conteúdo"), `.sem-js`, e as classes em `<html>`
`acesso-aberto`, `menu-aberto`, `modal-aberto` (travam a rolagem).

### 11.5 Cabeçalho de página

Gerado por `ui.cabecalhoPagina`:

```html
<header class="pagina-cabecalho">
  <a class="pagina-cabecalho__voltar" href="#/pedidos"><svg class="icone">…</svg>Pedidos</a>
  <div class="pagina-cabecalho__linha">
    <div class="pagina-cabecalho__textos">
      <h1 class="pagina-cabecalho__titulo" tabindex="-1">Pedido #1042</h1>
      <p class="pagina-cabecalho__descricao">Feito há 3 h</p>
    </div>
    <div class="pagina-cabecalho__acoes">…botões…</div>
  </div>
</header>
```

### 11.6 Botões

```html
<button type="button" class="botao botao--primario"><svg class="icone">…</svg><span class="botao__texto">Salvar</span></button>
<a class="botao botao--secundario botao--pequeno" href="#/produtos">Cancelar</a>
<button type="button" class="botao botao--fantasma botao--icone" aria-label="Editar" title="Editar"><svg class="icone">…</svg></button>
```

| Classe | Aparência |
|---|---|
| `botao` | Pílula, 42 px de altura, fonte Baloo 2. |
| `botao--primario` | Verde escuro, texto creme (ação principal; uma por área). |
| `botao--secundario` | Branco com borda (ações comuns, "Cancelar"). |
| `botao--perigo` | Vermelho (confirmar exclusão). |
| `botao--perigo-suave` | Contorno vermelho (botão que **abre** a confirmação de exclusão). |
| `botao--fantasma` | Sem fundo (ícones em listas e tabelas). |
| `botao--ouro` | Dourado (destaque raro). |
| `botao--pequeno` / `botao--grande` | 34 px / 50 px de altura. Em tela de toque todo botão tem no mínimo 44 px, e o pequeno 40 px. |
| `botao--icone` | Quadrado só com ícone (42 × 42; 34 × 34 com `--pequeno`). Exige `aria-label`. |
| `botao--bloco` | Largura total. |
| `[disabled]`, `[aria-disabled="true"]` | Esmaecido. Em `<a>`, use `aria-disabled="true"`. |
| `[aria-busy="true"]` | Conteúdo some e aparece um spinner (é o que `ui.ocupado` faz). |

### 11.7 Formulários e campos

```html
<form class="formulario" novalidate>
  <fieldset class="formulario__secao">
    <legend>Dados do produto</legend>
    <div class="campo">
      <label class="campo__rotulo" for="c-nome">Nome<span class="campo__obrigatorio" aria-hidden="true"> *</span></label>
      <input id="c-nome" name="nome" class="entrada" required aria-required="true" aria-describedby="c-nome-ajuda">
      <p class="campo__ajuda" id="c-nome-ajuda">Aparece na loja, no carrinho e no pedido.</p>
      <p class="campo__erro" id="c-nome-erro" hidden></p>
    </div>
    <div class="formulario__linha">…campos lado a lado…</div>
  </fieldset>
  <fieldset class="formulario__secao">…</fieldset>
</form>
```

| Classe | Efeito |
|---|---|
| `formulario` | Grade com 18 px entre blocos. |
| `formulario__linha` | Campos lado a lado (mínimo 220 px cada; empilham no celular). |
| `formulario__secao` | `<fieldset>` sem borda; `<legend>` vira título; seções seguidas ganham uma linha separadora. |
| `campo` | Coluna rótulo → entrada → ajuda → erro. |
| `campo__rotulo`, `campo__obrigatorio`, `campo__ajuda`, `campo__erro` | Rótulo em negrito; asterisco vermelho; ajuda em cinza; erro vermelho com "!" em círculo. |
| `campo--erro` | Borda vermelha na entrada (junto com `aria-invalid="true"` na entrada e o id do erro no `aria-describedby`). |
| `entrada` | `input`, `select` e `textarea` (44 px, fonte 16 px para o iPhone não dar zoom, anel dourado no foco). `textarea.entrada` mínimo 96 px; `select.entrada` com seta própria. |
| `entrada-grupo` | Entrada com texto ou botão colado: `<div class="entrada-grupo"><span class="entrada-grupo__extra" aria-hidden="true">R$</span><input class="entrada">…</div>`; botão dentro: `entrada-grupo__botao`. |

### 11.8 Caixa de marcar e interruptor

```html
<div class="campo campo--marcar">
  <label class="interruptor" for="c-ativo">
    <input type="checkbox" role="switch" id="c-ativo" class="interruptor__entrada" checked>
    <span class="interruptor__trilho" aria-hidden="true"></span>
    <span class="interruptor__texto">Visível na loja</span>
  </label>
  <p class="campo__ajuda">Desligado, o produto fica como rascunho.</p>
</div>

<div class="campo campo--marcar">
  <label class="caixa" for="c-destaque">
    <input type="checkbox" id="c-destaque" class="caixa__entrada">
    <span class="caixa__texto">Mostrar entre os destaques</span>
  </label>
</div>
```

`campo--marcar` alinha ajuda e erro com o texto (recuo de 34 px na caixa, 58 px no interruptor). Use
**interruptor** para ligar/desligar algo que vale na hora de salvar (visível, ativo) e **caixa** para opções.

### 11.9 Cartões

```html
<section class="cartao" aria-labelledby="t-fotos">
  <div class="cartao__cabecalho">
    <h2 class="cartao__titulo" id="t-fotos">Fotos</h2>
    <a class="cartao__link" href="#/categorias">Ver categorias <svg class="icone">…</svg></a>
    <p class="cartao__subtitulo">A primeira foto é a da vitrine.</p>
  </div>
  <div class="cartao__corpo">…</div>
  <div class="cartao__rodape">…botões…</div>
</section>
```

| Classe | Efeito |
|---|---|
| `cartao` | Caixa branca, borda, raio 16 px, sombra leve. |
| `cartao__cabecalho` | Título à esquerda, link/ações à direita, linha embaixo. |
| `cartao__titulo` / `cartao__subtitulo` / `cartao__link` | Título serifado / linha cinza abaixo do título / link "Ver todos →". |
| `cartao__corpo` | Padding 18 px (22 px ≥ 720), coluna com 14 px de espaço. |
| `cartao__corpo--sem-espaco` | Sem padding: para tabelas e listas encostadas nas bordas. |
| `cartao__rodape` | Faixa inferior creme com botões à direita. |
| `cartao--destaque` | Borda dourada com faixa à esquerda. |
| `cartao--plano` | Sem sombra, fundo creme claro. |

### 11.10 Métricas

```html
<div class="metricas">
  <a class="metrica metrica--destaque" href="#/pedidos?status=pago">
    <span class="metrica__rotulo"><svg class="icone">…</svg>Pedidos para enviar</span>
    <span class="metrica__valor">3</span>
    <span class="metrica__detalhe">Pagos, aguardando separação ou envio</span>
  </a>
  <div class="metrica metrica--carregando">…esqueletos…</div>
</div>
```

`metricas`: 2 colunas (4 a partir de 900 px). `metrica` pode ser `<a>` (realça no hover) ou `<div>`;
`metrica--destaque` (dourada) chama atenção; `metrica--carregando` mantém a altura enquanto carrega.

### 11.11 Tabelas responsivas

Gerada por `ui.tabela`; à mão:

```html
<div class="tabela-container">
  <table class="tabela tabela--responsiva">
    <caption class="sr-only">Últimos pedidos</caption>
    <thead><tr><th scope="col">Pedido</th><th scope="col" class="alinhar-direita">Total</th><th scope="col" class="oculto-celular">Quando</th></tr></thead>
    <tbody>
      <tr class="tabela__linha--link">
        <td data-rotulo="Pedido" class="tabela__principal"><a class="tabela__link" href="#/pedidos/…">#1042</a></td>
        <td data-rotulo="Total" class="alinhar-direita">R$ 134,50</td>
        <td data-rotulo="Quando" class="oculto-celular">há 1 h</td>
      </tr>
    </tbody>
  </table>
</div>
```

- `tabela-container` rola na horizontal se a tabela for larga (desktop).
- Abaixo de 720 px, `tabela--responsiva` esconde o `<thead>` e transforma cada linha em cartão: cada célula mostra
  `data-rotulo` à esquerda e o valor à direita; `tabela__principal` aparece sem rótulo, maior.
- `tabela__linha--link` + `tabela__link`: a linha inteira é clicável. `tabela__celula--interativa` (posta pelo
  `ui.tabela`, ou automática via `:has` nos navegadores que têm) deixa a célula por cima da camada do link (§8.3).
- `td.truncar` limita a 220 px com reticências no desktop.

### 11.12 Selos de status

```html
<span class="selo selo--verde">Pago</span>
<span class="selo selo--cinza selo--sem-ponto">Rascunho</span>
```

Pílula pequena com ponto colorido. Cores: `selo--verde` (= `selo--sucesso`), `selo--floresta` (verde escuro com
ponto dourado), `selo--ambar` (= `selo--aviso`), `selo--azul` (= `selo--info`), `selo--ouro`, `selo--roxo`,
`selo--cinza` (= `selo--neutro`; também o padrão sem cor), `selo--vermelho` (= `selo--perigo`).
`selo--sem-ponto` tira o ponto. Status de pedido: use `ui.seloStatusPedido` (tabela de cores em §8.1).

### 11.13 Avisos

Gerado por `ui.aviso`:

```html
<div class="aviso aviso--alerta">
  <svg class="icone">…</svg>
  <div class="aviso__texto"><strong class="aviso__titulo">Sem preço</strong><div>3 produtos estão sem preço.</div></div>
</div>
```

Tipos: `aviso--info` (azul), `aviso--sucesso` (verde), `aviso--alerta` (âmbar), `aviso--erro` (vermelho).
`ui.aviso(msg, 'aviso')` também gera `aviso--alerta`.

### 11.14 Abas

Gerada por `ui.abas`:

```html
<div class="abas-container">
  <div class="abas" role="tablist" aria-label="Partes do produto">
    <button type="button" class="aba" role="tab" id="abas-1-aba-0" aria-controls="abas-1-painel-0" aria-selected="true" tabindex="0">Dados</button>
    <button type="button" class="aba" role="tab" id="abas-1-aba-1" aria-controls="abas-1-painel-1" aria-selected="false" tabindex="-1">Fotos</button>
  </div>
  <div class="abas__paineis">
    <div class="aba-painel" role="tabpanel" id="abas-1-painel-0" aria-labelledby="abas-1-aba-0" tabindex="0">…</div>
    <div class="aba-painel" role="tabpanel" id="abas-1-painel-1" aria-labelledby="abas-1-aba-1" tabindex="0" hidden>…</div>
  </div>
</div>
```

A aba ativa (`aria-selected="true"`) ganha sublinhado dourado. No celular a faixa de abas vai até as bordas da tela
(margem negativa igual ao gutter) e rola na horizontal; fica bem direto na página ou dentro de `.cartao__corpo`.

### 11.15 Listas reordenáveis

O núcleo tem o visual; a lógica de reordenar é da página (com `ui.moverItem`). Botões "Subir"/"Descer" são
obrigatórios (teclado e celular); arrastar é opcional.

```html
<ul class="lista-ordenavel" aria-label="Fotos do produto">
  <li class="lista-ordenavel__item">
    <button type="button" class="lista-ordenavel__alca" aria-label="Arrastar para reordenar"><svg class="icone">…arrastar…</svg></button>
    <div class="lista-ordenavel__miniatura"><img src="…" alt=""></div>
    <div class="lista-ordenavel__conteudo">
      <p class="lista-ordenavel__titulo">Foto principal</p>
      <p class="lista-ordenavel__detalhe">body-splash-raiz.jpg</p>
    </div>
    <div class="lista-ordenavel__acoes">…botões fantasma pequenos: subir, descer, lixeira…</div>
  </li>
</ul>
```

| Classe | Efeito |
|---|---|
| `lista-ordenavel__item--aberto` | Item expandido (ex.: editor de um item de lista do CMS): alinha no topo e ganha sombra. |
| `lista-ordenavel__item--arrastando` | Item sendo arrastado (esmaecido). |
| `lista-ordenavel__item--alvo` | Destino do arraste (contorno tracejado dourado). |
| Abaixo de 480 px | As ações descem para uma linha própria, à direita. |

```js
function mover(de, para) {
  fotos = ui.moverItem(fotos, de, para);
  ctx.marcarAlterado(true);
  desenhar();
  const item = lista.children[Math.max(0, Math.min(para, fotos.length - 1))];
  if (item) item.querySelector('.lista-ordenavel__acoes button:not([disabled])')?.focus(); // devolve o foco
}
// nos botões: ui.botao({ tipo: 'fantasma', tamanho: 'pequeno', icone: 'subir', rotulo: 'Subir', attrs: { disabled: i === 0 }, aoClicar: () => mover(i, i - 1) })
```

### 11.16 Upload e progresso

Gerado por `midia.criarAreaUpload`:

```html
<div class="area-upload">
  <div class="area-upload__icone"><svg class="icone">…</svg></div>
  <p class="area-upload__texto">Arraste o arquivo para cá<span class="texto-suave"> ou </span></p>
  <button type="button" class="botao botao--secundario">…Escolher arquivo</button>
  <p class="area-upload__formatos">JPG, PNG, WebP, GIF ou AVIF, até 50 MB</p>
  <div class="progresso" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="42"><div class="progresso__barra" style="width:42%"></div></div>
  <p class="progresso__texto" aria-live="polite">Enviando foto.jpg… 42%</p>
</div>
```

Estados: `area-upload--ativa` (arquivo sendo arrastado por cima), `area-upload--enviando`, `area-upload--desativada`.
`progresso` + `progresso__barra` também servem fora da área; `progresso__texto` vazio some.

### 11.17 Miniaturas e biblioteca de mídia

```html
<div class="grade-midia" role="listbox" aria-label="Biblioteca de mídia">
  <button type="button" class="midia-item midia-item--selecionado" role="option" aria-selected="true" title="logo-a1b2c3.webp">
    <div class="miniatura"><img src="…" alt="" loading="lazy"></div>
    <span class="midia-item__nome">logo-a1b2c3.webp</span>
    <span class="midia-item__info">Site · 45 KB</span>
  </button>
</div>
```

`miniatura` (quadrado com fundo xadrez; `miniatura--video` + `miniatura__selo` para vídeo), `grade-midia`
(colunas automáticas de 104 px; 132 px ≥ 720), `midia-item` (`--selecionado` ou `aria-selected="true"` = borda
dourada), `seletor-midia`, `seletor-midia__envio`, `seletor-midia__biblioteca` (layout do modal do seletor),
`modal--midia`.

### 11.18 Filtros e paginação

```html
<div class="filtros">
  <div class="filtros__busca"><svg class="icone">…busca…</svg><input type="search" class="entrada" placeholder="Buscar pelo nome…" aria-label="Buscar"></div>
  <select class="entrada" aria-label="Status">…</select>
</div>

<div class="paginacao">
  <button type="button" class="botao botao--secundario botao--pequeno">Anterior</button>
  <span class="paginacao__info">Página 2 de 5</span>
  <button type="button" class="botao botao--secundario botao--pequeno">Próxima</button>
</div>
```

`filtros`: linha que quebra; a busca ocupa mais espaço (lupa dentro da entrada). `paginacao`: centralizada.

### 11.19 Grade e espaçamento

| Classe | Efeito |
|---|---|
| `grade` | Grade com 16 px (20 px ≥ 720) entre itens. |
| `grade--2` / `grade--3` / `grade--4` | Colunas automáticas de no mínimo 320 / 260 / 200 px. |
| `grade--painel` | 1 coluna; a partir de 1100 px, principal larga (1,65 fr) + lateral (mín. 300 px). O primeiro filho já é a coluna larga. |
| `grade__largo` | Item que ocupa a linha inteira da grade (`grid-column: 1 / -1`), em qualquer `grade`. |
| `pilha` | Coluna com 16 px (20 px ≥ 720). `pilha--estreita`: 10 px. |
| `linha` | Itens lado a lado, centralizados, com quebra e 10 px. `linha--entre`: espaçados nas pontas. |
| `empurrar` | `margin-left: auto` (empurra o item para a direita numa `linha`). |
| `divisor` | `<hr>` fino. |

### 11.20 Barra de ações

```html
<div class="barra-acoes">
  <p class="barra-acoes__info">As mudanças aparecem na loja na hora.</p>
  <a class="botao botao--secundario" href="#/produtos">Cancelar</a>
  <button type="submit" class="botao botao--primario">Salvar produto</button>
</div>
```

No desktop: linha alinhada à direita. Abaixo de 720 px: **gruda no rodapé da tela** (`position: sticky; bottom: 0`)
enquanto o bloco que a contém estiver visível, vai de borda a borda (margens negativas do gutter), botões dividem a
largura, o texto `barra-acoes__info` fica centralizado em cima, e ela tem `margin-bottom: -56px` para compensar o
espaço inferior do `<main>`. Por isso foi pensada para ser **o último bloco da página**: deixe o `<form>` envolver
os cartões e termine-o com a barra (exemplo em §4.1).

### 11.21 Lista de dados

```html
<dl class="lista-dados">
  <div><dt>Subtotal</dt><dd>R$ 120,00</dd></div>
  <div><dt>Frete</dt><dd>R$ 14,50</dd></div>
</dl>
```

Rótulo à esquerda, valor em negrito à direita, linha entre itens. `lista-dados--colunas`: blocos com número grande,
como "À venda / Rascunhos" da visão geral: 2 colunas, ou 4 quando a própria lista tem 36 rem (576 px) ou mais — num
cartão estreito (a lateral da `grade--painel`) continua em 2 em qualquer tela. Pensada para 2 ou 4 itens.

### 11.22 Atalhos e integrações (visão geral)

```html
<div class="atalhos">
  <a class="atalho" href="#/produtos/novo">
    <span class="atalho__icone"><svg class="icone">…</svg></span>
    <span class="atalho__textos"><span class="atalho__titulo">Novo produto</span><span class="atalho__detalhe">Cadastrar um item na loja</span></span>
    <svg class="icone atalho__seta">…avancar…</svg>
  </a>
</div>

<ul class="integracoes">
  <li class="integracao">
    <span class="integracao__icone integracao__icone--verde"><svg class="icone">…</svg></span>
    <div class="integracao__textos">
      <p class="integracao__nome">Pagamentos (Mercado Pago)<span class="selo selo--verde">Ativo</span></p>
      <p class="integracao__texto">Pix, cartão e boleto pelo Checkout do Mercado Pago.</p>
    </div>
  </li>
</ul>
```

`atalho`: link de 64 px com ícone em quadrado verde claro (bom dentro de `cartao__corpo--sem-espaco`).
`integracao__icone--verde`, `--ambar`, `--vermelho` (sem modificador: cinza). `integracoes__site`: linha extra abaixo.

### 11.23 Estados vazio, erro e carregando

```html
<div class="estado-vazio">
  <div class="estado-vazio__icone"><svg class="icone">…</svg></div>
  <p class="estado-vazio__titulo">Nenhuma categoria ainda</p>
  <p class="estado-vazio__texto">Crie a primeira categoria para organizar a loja.</p>
  <button type="button" class="botao botao--primario">Nova categoria</button>
</div>

<div class="carregando carregando--lista" role="status" aria-live="polite" aria-busy="true">
  <span class="sr-only">Carregando…</span>
  <div class="esqueleto esqueleto--linha" style="width:92%"></div>
</div>
```

| Classe | Efeito |
|---|---|
| `estado-vazio` | Centralizado com ícone em círculo creme. Direto em `.pagina` ou `.cartao`, ganha fundo branco e borda tracejada. |
| `estado-vazio--erro` | Ícone em círculo vermelho. |
| `carregando` | Coluna de esqueletos. `carregando--cartoes`: grade de quadrados. `carregando--tabela`: linhas altas com padding. |
| `esqueleto` | Bloco com brilho animado. Formas: `--linha` (14 px), `--alta` (40 px), `--titulo` (30 px, 45%), `--bloco` (quadrado), `--circulo` (40 px). |
| `girador` | Spinner redondo (30 px) para esperas curtas fora de botões. |

### 11.24 Modais

Gerado por `ui.modal`:

```html
<dialog class="modal modal--medio" aria-labelledby="modal-3-titulo">
  <div class="modal__caixa">
    <div class="modal__cabecalho"><h2 class="modal__titulo" id="modal-3-titulo">Nova categoria</h2><button class="botao botao--fantasma botao--icone modal__fechar" aria-label="Fechar">…</button></div>
    <div class="modal__corpo"><p class="modal__descricao">…</p>…</div>
    <div class="modal__rodape">…botões…</div>
  </div>
</dialog>
```

Tamanhos `modal--pequeno` (460 px), `modal--medio` (640 px), `modal--grande` (1040 px), `modal--cheio`. O corpo rola
se for alto; cabeçalho e rodapé ficam fixos. `modal--confirmar` + `modal__mensagem`: confirmação.
`dialog[data-ocupado]`: X esmaecido. Abaixo de 600 px: folha que sobe do rodapé (92% da altura), botões do rodapé
dividem a largura.

### 11.25 Toasts

Gerados por `ui.toast` numa região `.toasts` (`popover="manual"`, por cima de tudo, inclusive modais):
`toast` (verde escuro com faixa dourada), `toast--sucesso`, `toast--erro` (vinho), `toast--aviso`, `toast--info`;
`toast__texto`, `toast__fechar`, `toast--saindo` (animação de saída).

### 11.26 Movimento reduzido

Com `prefers-reduced-motion: reduce` animações e transições são praticamente zeradas (spinners continuam girando
devagar). Não crie animações que dependam de terminar para a página funcionar.

---

## 12. Como testar uma página

- **Funções puras**: `ui.js` (§8.1) e as puras de `midia.js` importam no Node:
  `node -e "import('./public/admin/js/ui.js').then((ui) => console.log(ui.lerPreco('12,50')))"`.
  Testes unitários vão em `tests/unit/**/*.test.js` (`node --test`, via `npm test`). Os do núcleo estão em
  `tests/unit/painel-ui.test.js`: funções puras de `ui.js`/`midia.js`, `el`, `tabela`, avisos, toasts e modais num
  DOM do linkedom (`parseHTML` + `globalThis.document`), `enviarArquivo` com pasta inválida e o roteador
  (`resolverRota`, `normalizarHash`). Use o mesmo modelo para testar a lógica de uma página.
- **No navegador**: `scripts/capturas-painel.mjs` é o modelo de Playwright com login. O essencial:
  - sobe o servidor com o Supabase local: `subirServidor({ ...AMBIENTE_VAZIO, SUPABASE_URL: local.url, SUPABASE_ANON_KEY: local.anonKey, SUPABASE_SERVICE_ROLE_KEY: local.serviceKey })`
    (`tests/apoio/servidor.js` e `ambienteLocal()` de `tests/apoio/supabase-local.js`);
  - `chromium.launch({ proxy })` com o proxy do ambiente e `bypass: '127.0.0.1,localhost'` (veja `proxyDoAmbiente`);
    Chromium já instalado em `/opt/pw-browsers` (nunca rode `playwright install`);
  - abre `<url>/admin/#/<rota>`, preenche `.acesso input[name="email"]` e `.acesso input[name="senha"]`
    (`admin@ama.local` / `admin123456`), clica no botão "Entrar" e espera `.pagina[data-pagina="<nome>"]`;
    depois do login a rota pedida é mantida;
  - falha com erro no console/página e com rolagem horizontal (função `semRolagemHorizontal`);
  - para upload: `page.waitForEvent('filechooser')` + `setFiles(...)`; apague do bucket o que enviou.
- O próprio `capturas-painel.mjs` injeta uma "vitrine de componentes" no lugar de `paginas/categorias.js`
  (`page.route`; a página real de categorias é testada por `capturas-painel-produtos.mjs`):
  `node scripts/capturas-painel.mjs --larguras 390,1440 --saida <pasta>`. Ele também confere as correções do
  §13 no navegador (botões do topo por largura, "Tentar novamente" da visão geral com falha simulada,
  `navegar` com `substituir` no mesmo hash, modal fechado pelo botão Voltar e pelo login, caixa de marcar numa
  tabela com `link`).
- Dados de teste: crie com sufixo aleatório e apague no fim; não altere o seed. Nada de `db reset`.

---

## 13. Armadilhas e pendências conhecidas do núcleo

Problemas encontrados no núcleo, conferidos no código e no navegador. **Todos corrigidos em 15/10/2026**; cada
item diz o que mudou, para quem escreveu uma página contornando o comportamento antigo. As regressões são
cobertas por `tests/unit/painel-ui.test.js` e pelo `scripts/capturas-painel.mjs` (§12).

1. **Corrigido — `ctx.navegar(hashAtual, { substituir: true })` não fazia nada** (o roteador ignorava destino
   igual ao hash atual). Agora `substituir` sempre renderiza, inclusive no mesmo hash; o "Tentar novamente" do
   cartão "Últimos pedidos" (e o novo do cartão "Catálogo") da visão geral voltou a funcionar (§5.3).
   O contorno `ctx.navegar(window.location.hash)` continua valendo.
2. **Corrigido — modal aberto + botão Voltar do navegador**: o modal ficava por cima da página nova. Agora o app
   fecha todos os modais abertos (resolvem com `null`) logo depois da limpeza da página, e também quando o login
   aparece por cima (antes, um modal aberto deixava a tela de login inerte). Nova função `ui.fecharModais()`
   (§8.5), que também fecha o `seletorDeMidia`. Fechar os próprios modais na limpeza continua permitido.
3. **Corrigido — tabela com `link`**: `<input>` e `<a>` comuns nas células ficavam por baixo da camada do link.
   Agora as células com controles recebem `tabela__celula--interativa` (e há uma regra `:has` para conteúdo
   trocado depois) e ficam por cima (§8.3, §11.11).
4. **Corrigido — booleanos**: célula booleana de `ui.tabela` saía vazia; agora mostra "Sim"/"Não". Em `el`,
   `aria-*` com `true`/`false` vira `"true"`/`"false"` (antes `false` sumia e `true` virava `aria-hidden=""`).
   Filhos `true`/`false` continuam ignorados de propósito (`cond && el(...)`), como documentado (§8.2).
5. **Corrigido — nomes do tipo âmbar**: `ui.toast` e `ui.aviso` aceitam `'aviso'` e `'alerta'` (mesma cor).
6. **Corrigido — `enviarArquivo` com pasta inválida** lançava `TypeError`; agora rejeita com `ErroMidia`
   `pasta_invalida` antes de otimizar ou enviar (§10.3).
7. **Corrigido — CSS do topo**: `.botao { display: inline-flex }` vinha depois e vencia, então o ícone "Abrir menu"
   aparecia no desktop (sem função) e o "Sair" aparecia no topo do celular além da gaveta. As regras agora são
   `.topo .topo__menu` / `.topo .topo__sair` (mais específicas).
8. **Corrigido — `.grade__largo`** era usada na visão geral sem existir no CSS. Agora existe (ocupa a linha
   inteira de qualquer `grade`, §11.19) e saiu da visão geral, onde o cartão já é a coluna larga.
9. **Corrigido — testes do núcleo**: `tests/unit/painel-ui.test.js` cobre `lerPreco`, `formatarPreco`,
   `slugify`, `escapar`, rótulos/cores de status (conferidos com o banco, a API e o `admin.css`), datas, `el`
   seguro, `tabela`, avisos, toasts, modais, `nomeSeguroArquivo`, `validarArquivo`, `enviarArquivo` com pasta
   inválida, `caminhoDaUrl` e o roteador.
10. **Corrigido — `lista-dados--colunas`** (visto nas capturas): passava para 4 colunas pela largura da tela
    (≥ 1300 px) mesmo no cartão estreito da lateral da visão geral, e "Rascunhos" estourava a caixa. Agora muda
    pela largura da própria lista (§11.21).

Ainda vale saber:

- ARQUITETURA §8 descreve um `ctx` menor; o `ctx` completo é o da §3.2 deste documento.
- Um toast mostrado com um modal aberto aparece por cima, mas o botão X dele não recebe clique enquanto o modal
  estiver aberto (o `<dialog>` modal deixa o resto da página inerte); ele some sozinho no tempo normal.
