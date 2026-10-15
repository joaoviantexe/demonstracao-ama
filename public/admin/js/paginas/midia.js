// #/midia — biblioteca do bucket "midia" (docs/ARQUITETURA.md §4.4 e §8): as pastas site/, produtos/ e
// videos/ em abas, grade com miniaturas, envio de vários arquivos (arrastar ou escolher), busca pelo
// nome, copiar endereço, abrir e apagar com confirmação (dizendo onde o arquivo está em uso).
// As funções puras exportadas rodam no Node (tests/unit/painel-conteudo.test.js).

import { extrairEsquema } from '../../../js/cms/aplicar.js';

export const PASTAS_DA_BIBLIOTECA = Object.freeze([
  { id: 'site', rotulo: 'Site', tipo: 'imagem', icone: 'conteudo', descricao: 'Fotos da página inicial, usadas em "Conteúdo do site".' },
  { id: 'produtos', rotulo: 'Produtos', tipo: 'imagem', icone: 'produtos', descricao: 'Fotos dos produtos da loja.' },
  {
    id: 'videos', rotulo: 'Vídeos', tipo: 'video', icone: 'video',
    descricao: 'Vídeos do site. Prefira vídeos curtos, de até 20 MB: vídeos pesados deixam o site lento no celular.',
  },
]);

export const ORDENS = Object.freeze([
  { id: 'recentes', rotulo: 'Mais recentes primeiro' },
  { id: 'antigos', rotulo: 'Mais antigos primeiro' },
  { id: 'nome', rotulo: 'Nome (A a Z)' },
  { id: 'maiores', rotulo: 'Maiores primeiro' },
]);

// ---------------------------------------------------------------------------
// Funções puras

/** "foto-do-creme-a1b2c3.jpg" → "foto-do-creme.jpg" (tira o sufixo aleatório do nome no bucket). */
export function nomeAmigavel(nome) {
  return String(nome || '').replace(/-[0-9a-f]{6}(\.[a-z0-9]{1,8})$/i, '$1');
}

/** Texto para comparar na busca: minúsculas, sem acentos, só letras e números separados por espaço. */
export function chaveDeBusca(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Arquivos cujo nome tem todas as palavras da busca (em qualquer ordem). */
export function filtrarArquivos(arquivos, busca) {
  const palavras = chaveDeBusca(busca).split(' ').filter(Boolean);
  const lista = Array.isArray(arquivos) ? arquivos : [];
  if (!palavras.length) return [...lista];
  return lista.filter((a) => {
    const alvo = chaveDeBusca(a && a.nome);
    return palavras.every((p) => alvo.includes(p));
  });
}

const tempo = (a) => {
  const t = Date.parse(a && a.criado_em);
  return Number.isNaN(t) ? 0 : t;
};

/** Ordena uma cópia: 'recentes' (padrão), 'antigos', 'nome' ou 'maiores'. */
export function ordenarArquivos(arquivos, criterio = 'recentes') {
  const lista = [...(Array.isArray(arquivos) ? arquivos : [])];
  const porNome = (a, b) => nomeAmigavel(a.nome).localeCompare(nomeAmigavel(b.nome), 'pt-BR', { numeric: true, sensitivity: 'base' });
  switch (criterio) {
    case 'antigos': return lista.sort((a, b) => tempo(a) - tempo(b) || porNome(a, b));
    case 'nome': return lista.sort(porNome);
    case 'maiores': return lista.sort((a, b) => (Number(b.tamanho) || 0) - (Number(a.tamanho) || 0) || porNome(a, b));
    default: return lista.sort((a, b) => tempo(b) - tempo(a) || porNome(a, b));
  }
}

/** { quantidade, bytes } de uma lista de arquivos. */
export function resumoDosArquivos(arquivos) {
  const lista = Array.isArray(arquivos) ? arquivos : [];
  return { quantidade: lista.length, bytes: lista.reduce((soma, a) => soma + (Number(a && a.tamanho) || 0), 0) };
}

/** Nome de um grupo do conteúdo: do esquema (rotulos: Map id → rótulo) ou derivado do id. */
export function rotuloDoGrupo(id, rotulos) {
  if (rotulos && rotulos.get && rotulos.get(id)) return rotulos.get(id);
  const texto = String(id || '').replace(/[-_]+/g, ' ').trim();
  return texto ? texto.charAt(0).toUpperCase() + texto.slice(1) : 'Geral';
}

/**
 * Onde o arquivo aparece: linhas de conteudo_site ({ chave, valor }) e produtos ({ id, nome, imagens }).
 * → [{ tipo: 'site', id: grupo, rotulo } | { tipo: 'produto', id, rotulo }]
 */
export function usosDoArquivo(arquivo, { conteudo = [], produtos = [], rotulos } = {}) {
  const alvos = [arquivo && arquivo.url, arquivo && arquivo.caminho ? `/midia/${arquivo.caminho}` : null].filter(Boolean);
  if (!alvos.length) return [];
  const contem = (valor) => {
    let json;
    try { json = JSON.stringify(valor); } catch { return false; }
    return typeof json === 'string' && alvos.some((a) => json.includes(a));
  };
  const grupos = [];
  for (const linha of conteudo || []) {
    if (!linha || typeof linha.chave !== 'string' || !contem(linha.valor)) continue;
    const grupo = linha.chave.split('.')[0];
    if (grupo !== 'grupo' && !grupos.includes(grupo)) grupos.push(grupo);
  }
  const usos = grupos.map((g) => ({ tipo: 'site', id: g, rotulo: rotuloDoGrupo(g, rotulos) }));
  for (const p of produtos || []) {
    if (p && contem(p.imagens)) usos.push({ tipo: 'produto', id: p.id, rotulo: String(p.nome || 'sem nome') });
  }
  return usos;
}

/** ['a', 'b', 'c'] → 'a, b e c'. */
export function listaPorExtenso(itens) {
  const lista = (itens || []).filter(Boolean);
  if (lista.length <= 1) return lista.join('');
  return `${lista.slice(0, -1).join(', ')} e ${lista[lista.length - 1]}`;
}

/** Texto da confirmação de apagar. usos = resultado de usosDoArquivo, ou null se não deu para conferir. */
export function mensagemApagar(arquivo, usos) {
  const video = arquivo && arquivo.categoria === 'video';
  const coisa = video ? 'o vídeo' : 'a imagem';
  const partes = [`Apagar "${nomeAmigavel(arquivo && arquivo.nome)}"?`];
  if (usos === null || usos === undefined) {
    partes.push(`Não foi possível conferir se ${coisa} está em uso. Se estiver no site ou em algum produto, vai sumir de lá.`);
  } else if (usos.length) {
    const site = usos.filter((u) => u.tipo === 'site').map((u) => `"${u.rotulo}"`);
    const produtos = usos.filter((u) => u.tipo === 'produto').map((u) => `"${u.rotulo}"`);
    const onde = [
      site.length ? `no site (${listaPorExtenso(site)})` : null,
      produtos.length ? `${produtos.length === 1 ? 'no produto' : 'nos produtos'} ${listaPorExtenso(produtos)}` : null,
    ].filter(Boolean).join(' e ');
    partes.push(`Atenção: ${coisa} está em uso ${onde}. Se apagar, ${video ? 'ele some' : 'ela some'} desses lugares.`);
  } else {
    partes.push(`${video ? 'O vídeo não foi encontrado' : 'A imagem não foi encontrada'} no conteúdo do site nem nos produtos, mas, se o endereço foi usado em outro lugar, vai parar de abrir.`);
  }
  partes.push('Esta ação não pode ser desfeita.');
  return partes.join(' ');
}

// ---------------------------------------------------------------------------
// Página

export async function renderizar(ctx) {
  const { ui, midia } = ctx;
  const { el } = ui;
  const estilo = ui.carregarCss('midia');
  const limpezas = new Set();
  const pastaPorId = new Map(PASTAS_DA_BIBLIOTECA.map((p) => [p.id, p]));
  const inicial = pastaPorId.has(ctx.consulta.pasta) ? ctx.consulta.pasta : 'site';
  const estados = new Map(PASTAS_DA_BIBLIOTECA.map((p) => [p.id, {
    arquivos: null, carregando: null, busca: '', ordem: 'recentes', enviando: false, ui: null,
  }]));
  let rotulosCache = null;

  ctx.raiz.append(ui.cabecalhoPagina({
    titulo: 'Mídia',
    descricao: 'Fotos e vídeos do site e da loja. Envie arquivos novos, copie o endereço ou apague o que não usa mais.',
  }));

  function montarPainel(pasta) {
    const estado = estados.get(pasta.id);
    const area = midia.criarAreaUpload({
      tipo: pasta.tipo, multiplo: true,
      texto: pasta.tipo === 'video' ? 'Arraste os vídeos para cá' : 'Arraste as fotos para cá',
      aoEscolher: (arquivos) => enviar(pasta.id, arquivos),
    });
    const otimizar = pasta.tipo === 'imagem' ? ui.campo({
      tipo: 'interruptor', nome: `otimizar-${pasta.id}`, rotulo: 'Otimizar as fotos antes de enviar (recomendado)', valor: true,
      ajuda: 'Reduz para no máximo 2000 px e comprime. O site fica mais rápido no celular.',
    }) : null;
    const busca = el('input', {
      type: 'search', class: 'entrada', placeholder: 'Buscar pelo nome…', 'aria-label': `Buscar em ${pasta.rotulo}`, autocomplete: 'off',
    });
    const ordem = el('select', { class: 'entrada midia-ordem', 'aria-label': 'Ordem dos arquivos' },
      ORDENS.map((o) => el('option', { value: o.id }, o.rotulo)));
    const atualizar = ui.botao({ tipo: 'secundario', icone: 'atualizar', rotulo: 'Atualizar a lista', aoClicar: () => carregar(pasta.id) });
    const contador = el('p', { class: 'midia-contador', 'aria-live': 'polite' });
    const grade = el('div', { class: 'midia-grade' });
    const buscar = ui.debounce(() => {
      estado.busca = busca.value;
      desenhar(pasta.id);
    }, 200);
    limpezas.add(() => buscar.cancelar());
    busca.addEventListener('input', buscar);
    ordem.addEventListener('change', () => {
      estado.ordem = ordem.value;
      desenhar(pasta.id);
    });
    estado.ui = { area, otimizar, busca, ordem, contador, grade };
    return el('div', { class: 'pilha midia-painel', 'data-pasta': pasta.id },
      el('p', { class: 'midia-painel__descricao' }, pasta.descricao),
      el('section', { class: 'cartao midia-envio', 'aria-label': `Enviar arquivos para ${pasta.rotulo}` },
        el('div', { class: 'cartao__corpo' }, area.elemento, otimizar ? otimizar.elemento : null)),
      el('section', { class: 'cartao midia-arquivos', 'aria-label': `Arquivos em ${pasta.rotulo}` },
        el('div', { class: 'cartao__corpo' },
          el('div', { class: 'filtros' }, el('div', { class: 'filtros__busca' }, ui.icone('busca'), busca), ordem, atualizar),
          contador,
          grade)));
  }

  async function carregar(id) {
    const estado = estados.get(id);
    if (!estado.ui) return;
    const { grade, contador } = estado.ui;
    ui.estadoCarregando(grade, { linhas: 6, tipo: 'cartoes', mensagem: 'Carregando os arquivos…' });
    contador.textContent = '';
    try {
      const arquivos = await midia.listarArquivos(id);
      if (!ctx.ativo()) return;
      estado.arquivos = arquivos;
      desenhar(id);
    } catch (erro) {
      if (!ctx.ativo()) return;
      ui.estadoErro(grade, erro && erro.message ? erro.message : 'Não foi possível carregar os arquivos. Tente de novo.', {
        aoTentarNovamente: () => carregar(id),
      });
    }
  }

  function garantirCarregada(id) {
    const estado = estados.get(id);
    if (estado.arquivos || estado.carregando) return estado.carregando || Promise.resolve();
    estado.carregando = carregar(id).finally(() => { estado.carregando = null; });
    return estado.carregando;
  }

  function cartaoDoArquivo(pastaId, arquivo) {
    const nome = nomeAmigavel(arquivo.nome);
    const data = arquivo.criado_em ? ui.formatarData(arquivo.criado_em, { hora: false }) : '';
    const info = [arquivo.tamanho ? ui.formatarBytes(arquivo.tamanho) : null, data && data !== '—' ? data : null].filter(Boolean).join(' · ');
    const apagarBotao = ui.botao({
      texto: 'Apagar', tipo: 'fantasma', tamanho: 'pequeno', icone: 'lixeira', rotulo: `Apagar ${nome}`, classe: 'midia-cartao__apagar',
      aoClicar: () => apagar(pastaId, arquivo, apagarBotao),
    });
    return el('li', { class: 'midia-cartao', 'data-caminho': arquivo.caminho },
      el('a', { class: 'midia-cartao__previa', href: arquivo.url, target: '_blank', rel: 'noopener', tabindex: '-1', 'aria-hidden': 'true' },
        midia.miniatura(arquivo)),
      el('div', { class: 'midia-cartao__textos' },
        el('p', { class: 'midia-cartao__nome', title: arquivo.nome }, nome),
        el('p', { class: 'midia-cartao__info' }, info || ' ')),
      el('div', { class: 'midia-cartao__acoes' },
        ui.botao({
          texto: 'Copiar', tipo: 'fantasma', tamanho: 'pequeno', icone: 'copiar', rotulo: `Copiar o endereço de ${nome}`, classe: 'midia-cartao__copiar',
          aoClicar: () => ui.copiarTexto(arquivo.url, { mensagem: 'Endereço copiado. Agora é só colar onde precisar.' }),
        }),
        ui.botao({
          texto: 'Abrir', tipo: 'fantasma', tamanho: 'pequeno', icone: 'externo', rotulo: `Abrir ${nome} em outra aba`, href: arquivo.url,
          classe: 'midia-cartao__abrir', attrs: { target: '_blank', rel: 'noopener' },
        }),
        apagarBotao));
  }

  function desenhar(id, { focarCaminho } = {}) {
    const estado = estados.get(id);
    if (!estado.ui) return;
    const pasta = pastaPorId.get(id);
    const { grade, contador, busca } = estado.ui;
    const todos = estado.arquivos || [];
    const visiveis = ordenarArquivos(filtrarArquivos(todos, estado.busca), estado.ordem);
    const total = resumoDosArquivos(todos);
    if (!todos.length) contador.textContent = '';
    else if (estado.busca.trim()) contador.textContent = `${visiveis.length} de ${total.quantidade} ${total.quantidade === 1 ? 'arquivo' : 'arquivos'}`;
    else contador.textContent = `${total.quantidade} ${total.quantidade === 1 ? 'arquivo' : 'arquivos'} · ${ui.formatarBytes(total.bytes)}`;
    if (!todos.length) {
      ui.estadoVazio(grade, pasta.tipo === 'video'
        ? 'Envie o primeiro vídeo: toque em "Escolher arquivos" ou arraste o arquivo para a área de envio.'
        : 'Envie a primeira foto: toque em "Escolher arquivos" ou arraste o arquivo para a área de envio.', {
        titulo: `Nenhum arquivo em ${pasta.rotulo} ainda`, icone: pasta.tipo === 'video' ? 'video' : 'imagem',
      });
      return;
    }
    if (!visiveis.length) {
      ui.estadoVazio(grade, `Nenhum arquivo com "${estado.busca.trim()}" no nome.`, {
        titulo: 'Nada encontrado', icone: 'busca',
        acao: {
          texto: 'Limpar a busca', tipo: 'secundario', icone: 'fechar',
          aoClicar: () => {
            busca.value = '';
            estado.busca = '';
            desenhar(id);
            busca.focus();
          },
        },
      });
      return;
    }
    grade.replaceChildren(el('ul', { class: 'midia-biblioteca', 'aria-label': `Arquivos em ${pasta.rotulo}` },
      visiveis.map((a) => cartaoDoArquivo(id, a))));
    if (focarCaminho) {
      const alvo = Array.from(grade.querySelectorAll('.midia-cartao')).find((c) => c.dataset.caminho === focarCaminho);
      const botao = alvo && alvo.querySelector('.midia-cartao__apagar');
      if (botao) botao.focus();
    }
  }

  async function enviar(id, arquivos) {
    const estado = estados.get(id);
    const pasta = pastaPorId.get(id);
    if (!estado.ui || estado.enviando) {
      if (estado.enviando) ui.toast('Espere terminar o envio em andamento.', 'aviso');
      return;
    }
    const { area, otimizar } = estado.ui;
    const validos = [];
    for (const arquivo of arquivos) {
      const v = midia.validarArquivo(arquivo, { tipo: pasta.tipo });
      if (v.ok) validos.push({ arquivo, avisos: v.avisos });
      else ui.toast(`${arquivo.name}: ${v.erro}`, 'erro');
    }
    if (!validos.length) return;
    estado.enviando = true;
    area.desativar(true);
    const novos = [];
    try {
      for (const [i, { arquivo, avisos }] of validos.entries()) {
        const prefixo = validos.length > 1 ? `${i + 1} de ${validos.length}: ` : '';
        const otimizarAgora = otimizar ? otimizar.ler() : false;
        area.definirProgresso(0, otimizarAgora ? `${prefixo}preparando ${arquivo.name}…` : `${prefixo}enviando ${arquivo.name}…`);
        try {
          const r = await midia.enviarArquivo(arquivo, id, {
            otimizar: otimizarAgora,
            sinal: ctx.sinal,
            aoProgresso: ({ fracao }) => area.definirProgresso(fracao, `${prefixo}enviando ${arquivo.name}… ${Math.round(fracao * 100)}%`),
          });
          novos.push({
            nome: r.nome, caminho: r.caminho, pasta: id, url: r.url, tamanho: r.tamanho, tipo: r.tipo,
            categoria: midia.categoriaDoTipo(r.tipo), criado_em: new Date().toISOString(),
          });
          if (!r.otimizado) for (const aviso of avisos) ui.toast(`${arquivo.name}: ${aviso}`, 'aviso');
        } catch (erro) {
          if (erro && erro.codigo === 'cancelado') return;
          if (ctx.ativo()) ui.toast(`${arquivo.name}: ${erro && erro.message ? erro.message : 'não foi possível enviar.'}`, 'erro');
        }
      }
    } finally {
      estado.enviando = false;
      if (ctx.ativo()) {
        area.desativar(false);
        area.definirProgresso(null, novos.length
          ? `${novos.length === 1 ? '1 arquivo enviado' : `${novos.length} arquivos enviados`}.`
          : '');
      }
    }
    if (!ctx.ativo() || !novos.length) return;
    if (estado.arquivos) {
      estado.arquivos = [...novos, ...estado.arquivos];
      desenhar(id);
    } else {
      await garantirCarregada(id);
    }
    ui.toast(novos.length === 1 ? 'Arquivo enviado.' : `${novos.length} arquivos enviados.`, 'sucesso');
  }

  async function rotulosDosGrupos() {
    if (rotulosCache) return rotulosCache;
    try {
      const r = await fetch('/api/render?modelo=1', { cache: 'no-store', signal: ctx.sinal, credentials: 'same-origin' });
      if (!r.ok) return new Map();
      const documento = new DOMParser().parseFromString(await r.text(), 'text/html');
      rotulosCache = new Map(extrairEsquema(documento).grupos.map((g) => [g.id, g.rotulo]));
      return rotulosCache;
    } catch {
      return new Map();
    }
  }

  async function procurarUsos(arquivo) {
    const [conteudo, produtos, rotulos] = await Promise.all([
      ctx.api.consultar(ctx.supabase.from('conteudo_site').select('chave, valor')),
      ctx.api.consultar(ctx.supabase.from('produtos').select('id, nome, imagens')),
      rotulosDosGrupos(),
    ]);
    if (!conteudo.ok || !produtos.ok) return null;
    return usosDoArquivo(arquivo, { conteudo: conteudo.dados, produtos: produtos.dados, rotulos });
  }

  async function apagar(id, arquivo, botao) {
    const usos = await ui.ocupado(botao, () => procurarUsos(arquivo));
    if (!ctx.ativo() || usos === undefined) return;
    const sim = await ui.confirmar(mensagemApagar(arquivo, usos), {
      perigo: true, titulo: 'Apagar arquivo?', textoConfirmar: 'Apagar arquivo',
    });
    if (!sim || !ctx.ativo()) return;
    try {
      await ui.ocupado(botao, () => midia.apagarArquivo(arquivo.caminho));
    } catch (erro) {
      if (ctx.ativo()) ui.toast(erro && erro.message ? erro.message : 'Não foi possível apagar agora. Tente de novo.', 'erro');
      return;
    }
    if (!ctx.ativo()) return;
    const estado = estados.get(id);
    const visiveis = ordenarArquivos(filtrarArquivos(estado.arquivos || [], estado.busca), estado.ordem);
    const posicao = visiveis.findIndex((a) => a.caminho === arquivo.caminho);
    const vizinho = visiveis[posicao + 1] || visiveis[posicao - 1] || null;
    estado.arquivos = (estado.arquivos || []).filter((a) => a.caminho !== arquivo.caminho);
    desenhar(id, { focarCaminho: vizinho ? vizinho.caminho : null });
    if (!vizinho) estado.ui.busca.focus();
    ui.toast('Arquivo apagado.', 'sucesso');
  }

  const abas = ui.abas({
    rotulo: 'Pastas da biblioteca',
    ativa: inicial,
    aoTrocar: (id) => {
      ctx.navegar(`#/midia?pasta=${id}`, { silencioso: true });
      garantirCarregada(id);
    },
    abas: PASTAS_DA_BIBLIOTECA.map((p) => ({ id: p.id, rotulo: p.rotulo, icone: p.icone, conteudo: () => montarPainel(p) })),
  });
  ctx.raiz.append(abas.elemento);
  ui.estadoCarregando(estados.get(inicial).ui.grade, { linhas: 6, tipo: 'cartoes', mensagem: 'Carregando os arquivos…' });

  await estilo;
  if (ctx.ativo()) await garantirCarregada(inicial);

  // A confirmação de apagar aberta é fechada pelo próprio app na troca de rota.
  return () => {
    for (const fn of limpezas) {
      try { fn(); } catch (erro) { console.error('[midia] erro na limpeza:', erro); }
    }
  };
}
