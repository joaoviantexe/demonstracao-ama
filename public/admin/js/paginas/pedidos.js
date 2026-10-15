// #/pedidos e #/pedidos/<id> — pedidos da loja (docs/ARQUITETURA.md §4.1, §6.6 e §8).
// Lista com busca, filtro por situação e páginas; detalhe com itens, cliente, entrega, pagamento,
// linha do tempo, notas internas, mudança de status (/api/admin/pedido-status), conferência do
// pagamento (/api/admin/pagamento) e o assistente de envio do Melhor Envio (/api/admin/envio).
// As funções puras do começo do arquivo são testadas em tests/unit/painel-pedidos.test.js.

import { formatarPreco, rotuloStatusPedido, STATUS_PEDIDO } from '../ui.js';

// ---------------------------------------------------------------------------
// Filtros e busca da lista

export const TAMANHO_PAGINA = 20;

/** Filtros de situação da lista. `status` null = todos. */
export const FILTROS_STATUS = Object.freeze([
  { id: '', rotulo: 'Todos os pedidos', status: null },
  { id: 'para_enviar', rotulo: 'Para enviar (pagos e em separação)', status: ['pago', 'em_separacao'] },
  { id: 'aguardando', rotulo: 'Aguardando pagamento (inclui em análise)', status: ['aguardando_pagamento', 'pagamento_em_analise'] },
  ...STATUS_PEDIDO.map((s) => ({ id: s, rotulo: rotuloStatusPedido(s), status: [s], individual: true })),
]);

/** Filtro da URL (?status=) → id conhecido, senão '' (todos). */
export function filtroDaUrl(valor) {
  const id = typeof valor === 'string' ? valor.trim() : '';
  return FILTROS_STATUS.some((f) => f.id === id) ? id : '';
}

/** Lista de status de um filtro (null = sem filtro). */
export function statusDoFiltro(id) {
  const filtro = FILTROS_STATUS.find((f) => f.id === id);
  return filtro && filtro.status ? [...filtro.status] : null;
}

/**
 * Texto digitado na busca → { numero } (#1042 ou 1042), { digitos } (telefone ou CPF, 10–11 dígitos),
 * { texto } (nome ou e-mail, sem os caracteres que quebrariam o filtro do PostgREST) ou null.
 */
export function termoBusca(texto) {
  const limpo = String(texto ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!limpo) return null;
  const numero = limpo.match(/^#\s*(\d{1,9})$/) || limpo.match(/^(\d{1,9})$/);
  if (numero) return { numero: Number(numero[1]) };
  if (/^[\d\s().+-]+$/.test(limpo)) {
    let digitos = limpo.replace(/\D/g, '');
    if (digitos.length === 13 && digitos.startsWith('55')) digitos = digitos.slice(2);
    if (digitos.length >= 10 && digitos.length <= 11) return { digitos };
  }
  const seguro = limpo.replace(/[,()*%\\"'`:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return seguro ? { texto: seguro } : null;
}

/** Filtro `or` do PostgREST para uma busca por texto ou dígitos (valores entre aspas: e-mail tem ponto). */
export function filtroOuDaBusca(termo) {
  if (!termo) return null;
  if (termo.digitos) return `cliente_telefone.eq.${termo.digitos},cliente_cpf.eq.${termo.digitos}`;
  if (termo.texto) return `cliente_nome.ilike."*${termo.texto}*",cliente_email.ilike."*${termo.texto}*"`;
  return null;
}

/** Total de páginas (mínimo 1). */
export function totalDePaginas(total, tamanho = TAMANHO_PAGINA) {
  const n = Number(total);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n / tamanho) : 1;
}

// ---------------------------------------------------------------------------
// Textos de pagamento, cliente e entrega

const STATUS_PAGAMENTO = Object.freeze({
  approved: 'Aprovado',
  authorized: 'Autorizado',
  pending: 'Pendente',
  in_process: 'Em análise',
  in_mediation: 'Em disputa',
  rejected: 'Recusado',
  cancelled: 'Cancelado',
  refunded: 'Devolvido',
  charged_back: 'Contestado pela cliente (chargeback)',
});

/** Status do pagamento no Mercado Pago em português. Vazio → "Sem pagamento ainda". */
export function rotuloPagamento(status) {
  if (!status) return 'Sem pagamento ainda';
  return STATUS_PAGAMENTO[status] || String(status);
}

const METODOS = Object.freeze({
  credit_card: 'Cartão de crédito',
  debit_card: 'Cartão de débito',
  prepaid_card: 'Cartão pré-pago',
  bank_transfer: 'Pix',
  ticket: 'Boleto',
  account_money: 'Saldo no Mercado Pago',
  digital_currency: 'Linha de crédito do Mercado Pago',
  digital_wallet: 'Carteira digital',
});

/** Meio de pagamento (payment_type_id) em português. */
export function rotuloMetodo(tipo) {
  if (!tipo) return '—';
  return METODOS[tipo] || String(tipo);
}

const digitosDe = (v) => String(v ?? '').replace(/\D+/g, '');

/** '52998224725' → '529.982.247-25' (outros formatos voltam como vieram). */
export function formatarCpf(cpf) {
  const d = digitosDe(cpf);
  return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : String(cpf ?? '');
}

/** '91981056049' → '(91) 98105-6049'; '9132221234' → '(91) 3222-1234'. */
export function formatarTelefone(telefone) {
  const d = digitosDe(telefone);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return String(telefone ?? '');
}

/** Link do WhatsApp para um telefone brasileiro com DDD (null se não tiver 10–11 dígitos). */
export function linkWhatsapp(telefone) {
  const d = digitosDe(telefone);
  return d.length === 10 || d.length === 11 ? `https://wa.me/55${d}` : null;
}

/** Endereço do pedido em linhas: ['Rua A, 10 — Apto 1', 'Bairro, Cidade/UF', 'CEP 66010-000']. */
export function linhasEndereco(endereco) {
  const e = endereco && typeof endereco === 'object' ? endereco : {};
  const txt = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
  const linhas = [];
  const rua = [txt(e.logradouro), txt(e.numero)].filter(Boolean).join(', ');
  if (rua) linhas.push(txt(e.complemento) ? `${rua} — ${txt(e.complemento)}` : rua);
  const cidade = [txt(e.cidade), txt(e.uf).toUpperCase()].filter(Boolean).join('/');
  const bairro = [txt(e.bairro), cidade].filter(Boolean).join(', ');
  if (bairro) linhas.push(bairro);
  const cep = digitosDe(e.cep);
  if (cep.length === 8) linhas.push(`CEP ${cep.slice(0, 5)}-${cep.slice(5)}`);
  return linhas;
}

/** Nome da forma de entrega: "PAC (Correios)", "Entrega local" ou "Entrega". */
export function nomeEntrega(entrega) {
  const e = entrega && typeof entrega === 'object' ? entrega : {};
  const nome = String(e.nome ?? '').trim();
  const empresa = String(e.empresa ?? '').trim();
  if (nome && empresa && nome !== empresa) return `${nome} (${empresa})`;
  return nome || empresa || 'Entrega';
}

/** Autor de um evento para exibir. */
export function rotuloAutor(autor) {
  const a = String(autor ?? '').trim();
  if (!a || a === 'sistema') return 'Sistema';
  if (a === 'mercadopago') return 'Mercado Pago';
  return a;
}

/** Ícone e cor (classe) de cada tipo de evento da linha do tempo. */
export const VISUAL_EVENTO = Object.freeze({
  criado: { icone: 'pedidos', cor: 'verde', rotulo: 'Pedido' },
  pagamento: { icone: 'dinheiro', cor: 'azul', rotulo: 'Pagamento' },
  status: { icone: 'atualizar', cor: 'ouro', rotulo: 'Situação' },
  envio: { icone: 'caminhao', cor: 'roxo', rotulo: 'Envio' },
  email: { icone: 'email', cor: 'cinza', rotulo: 'E-mail' },
  nota: { icone: 'editar', cor: 'creme', rotulo: 'Nota da equipe' },
  alerta: { icone: 'alerta', cor: 'vermelho', rotulo: 'Atenção' },
});

export function visualEvento(tipo) {
  return VISUAL_EVENTO[tipo] || { icone: 'info', cor: 'cinza', rotulo: 'Registro' };
}

/** Eventos em ordem cronológica (data e, no empate, id). */
export function ordenarEventos(eventos) {
  return [...(Array.isArray(eventos) ? eventos : [])].sort((a, b) => {
    const ta = Date.parse(a.criado_em) || 0;
    const tb = Date.parse(b.criado_em) || 0;
    return ta - tb || (Number(a.id) || 0) - (Number(b.id) || 0);
  });
}

// ---------------------------------------------------------------------------
// Situação, próxima ação e mudança de status

const ESPERANDO_PAGAMENTO = ['aguardando_pagamento', 'pagamento_em_analise'];
const PAGOS = ['pago', 'em_separacao', 'enviado', 'entregue'];
const STATUS_COM_EMAIL = ['enviado', 'entregue', 'cancelado'];

/**
 * O que a equipe deve fazer agora com o pedido.
 * → { tipo: 'info'|'sucesso'|'alerta', titulo, texto, proximo?: status sugerido, botao?: texto, conferir?: bool }
 */
export function proximaAcao(pedido) {
  const p = pedido || {};
  const melhorEnvio = p.entrega && p.entrega.tipo === 'melhor_envio';
  switch (p.status) {
    case 'aguardando_pagamento':
      return {
        tipo: 'info', titulo: 'Aguardando o pagamento',
        texto: 'A cliente ainda não pagou. Pix e cartão costumam confirmar em minutos; boleto, em até 3 dias úteis. A confirmação chega sozinha.',
        conferir: true,
      };
    case 'pagamento_em_analise':
      return {
        tipo: 'info', titulo: 'Pagamento em análise',
        texto: 'O Mercado Pago está analisando o pagamento. Quando aprovar, o pedido muda para "Pago" sozinho.',
        conferir: true,
      };
    case 'pago':
      return {
        tipo: 'alerta', titulo: 'Pagamento confirmado: separe os produtos',
        texto: 'Separe os produtos e embale. Marque "Em separação" para a equipe saber que alguém já está cuidando.',
        proximo: 'em_separacao', botao: 'Marcar como em separação',
      };
    case 'em_separacao':
      return {
        tipo: 'alerta', titulo: 'Em separação: hora de enviar',
        texto: melhorEnvio
          ? 'Faça a etiqueta no Melhor Envio (passo a passo abaixo), poste o pacote e marque como enviado.'
          : 'Quando o pedido sair para entrega, marque como enviado. Se tiver um código ou link de acompanhamento, informe.',
        proximo: 'enviado', botao: 'Marcar como enviado',
      };
    case 'enviado':
      return {
        tipo: 'info', titulo: 'Enviado',
        texto: 'O pedido está a caminho. Quando a cliente receber, marque como entregue.',
        proximo: 'entregue', botao: 'Marcar como entregue',
      };
    case 'entregue':
      return { tipo: 'sucesso', titulo: 'Pedido entregue', texto: 'Tudo certo com este pedido.' };
    case 'cancelado':
      return { tipo: 'info', titulo: 'Pedido cancelado', texto: 'Este pedido foi cancelado.' };
    case 'reembolsado':
      return { tipo: 'info', titulo: 'Pagamento devolvido', texto: 'O pagamento deste pedido foi devolvido à cliente.' };
    default:
      return { tipo: 'info', titulo: 'Situação desconhecida', texto: 'Confira a linha do tempo deste pedido.' };
  }
}

/**
 * Campos e avisos do formulário "Mudar situação" para o status escolhido.
 * → { rastreio, notificar, reporEstoque, avisos: [texto] }
 */
export function opcoesDoStatus(statusNovo, pedido) {
  const p = pedido || {};
  const avisos = [];
  if (PAGOS.includes(statusNovo) && !PAGOS.includes(p.status)) {
    avisos.push('Este pedido não tem pagamento confirmado pelo Mercado Pago. Só continue se você conferiu que o dinheiro entrou. O estoque dos produtos será baixado.');
  }
  if (ESPERANDO_PAGAMENTO.includes(statusNovo) && PAGOS.includes(p.status)) {
    avisos.push('Voltar para "aguardando pagamento" não devolve o estoque nem o dinheiro. Para desistir do pedido, use "Cancelado".');
  }
  if (statusNovo === 'cancelado' && (p.pago_em || PAGOS.includes(p.status))) {
    avisos.push('Se a cliente já pagou, faça a devolução do dinheiro no painel do Mercado Pago (o painel da AMA não devolve sozinho).');
  }
  return {
    rastreio: statusNovo === 'enviado',
    notificar: STATUS_COM_EMAIL.includes(statusNovo),
    reporEstoque: ['cancelado', 'reembolsado'].includes(statusNovo) && p.estoque_baixado === true,
    avisos,
  };
}

/** Confere código e link de rastreio digitados (mesmas regras do banco). → { codigo?, url? } com as mensagens. */
export function errosRastreio(codigo, url) {
  const erros = {};
  const c = String(codigo ?? '').trim();
  const u = String(url ?? '').trim();
  if (c && (c.length > 200 || /[\u0000-\u001f\u007f<>"'`]/.test(c))) {
    erros.codigo = 'Use até 200 caracteres, sem aspas nem < >. Separe vários códigos com vírgula.';
  }
  if (u && (u.length > 500 || !/^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?([/?#][^\s"'<>`\\]*)?$/i.test(u))) {
    erros.url = 'O link precisa começar com https:// e não pode ter espaços nem aspas.';
  }
  return erros;
}

/** Pedido que pode ser apagado: sem estoque baixado e sem pagamento confirmado (ex.: pedidos de teste). */
export function podeApagar(pedido) {
  const p = pedido || {};
  return p.estoque_baixado !== true && ['aguardando_pagamento', 'cancelado', 'reembolsado'].includes(p.status);
}

// ---------------------------------------------------------------------------
// Assistente de envio do Melhor Envio

export const ETAPAS_ENVIO = Object.freeze(['carrinho', 'compra', 'geracao', 'impressao', 'postagem']);
const STATUS_ENVIO = ['pago', 'em_separacao', 'enviado'];

/**
 * O assistente de envio vale para este pedido?
 * → { usa: bool (é Melhor Envio), liberado: bool, motivo: texto | null }
 */
export function envioDisponivel(pedido) {
  const p = pedido || {};
  const usa = Boolean(p.entrega && p.entrega.tipo === 'melhor_envio');
  if (!usa) return { usa, liberado: false, motivo: null };
  if (STATUS_ENVIO.includes(p.status)) return { usa, liberado: true, motivo: null };
  if (ESPERANDO_PAGAMENTO.includes(p.status)) {
    return { usa, liberado: false, motivo: 'A etiqueta fica disponível depois que o pagamento for confirmado.' };
  }
  if (p.status === 'entregue') return { usa, liberado: false, motivo: 'Pedido entregue: o envio já foi concluído.' };
  return { usa, liberado: false, motivo: 'Pedido cancelado ou devolvido: não há envio a fazer.' };
}

const idsEtiquetas = (pedido) => (Array.isArray(pedido && pedido.me_ordens) ? pedido.me_ordens : [])
  .filter((id) => typeof id === 'string' || typeof id === 'number')
  .map(String).filter(Boolean);

/** Último evento "adicionar ao carrinho" (com as etiquetas e o valor), ou null. */
export function ultimoCarrinho(eventos) {
  const lista = ordenarEventos(eventos).filter((e) => e.tipo === 'envio' && e.dados && e.dados.acao === 'adicionar_carrinho');
  return lista.length ? lista[lista.length - 1] : null;
}

/**
 * Etapas do envio pelo Melhor Envio, a partir do pedido e dos eventos 'envio' (dados.acao).
 * Só contam as ações feitas depois do último "adicionar ao carrinho" (refazer recomeça o passo a passo).
 * → [{ id, feito, atual }] (atual = a primeira que falta)
 */
export function etapasEnvio(pedido, eventos) {
  const p = pedido || {};
  const temEtiquetas = idsEtiquetas(p).length > 0;
  const envios = ordenarEventos(eventos).filter((e) => e.tipo === 'envio' && e.dados && typeof e.dados.acao === 'string');
  let inicio = -1;
  envios.forEach((e, i) => { if (e.dados.acao === 'adicionar_carrinho') inicio = i; });
  const depois = envios.slice(inicio + 1);
  const fez = (acao) => temEtiquetas && depois.some((e) => e.dados.acao === acao);
  const feito = {
    carrinho: temEtiquetas,
    compra: fez('comprar'),
    geracao: fez('gerar'),
    impressao: temEtiquetas && Boolean(p.etiqueta_url),
    postagem: ['enviado', 'entregue'].includes(p.status),
  };
  // Cada etapa só acontece depois da anterior: a impressão prova a geração e a compra.
  if (feito.impressao) feito.geracao = true;
  if (feito.geracao) feito.compra = true;
  if (feito.compra) feito.carrinho = true;
  const atual = ETAPAS_ENVIO.find((id) => !feito[id]) || null;
  return ETAPAS_ENVIO.map((id) => ({ id, feito: feito[id], atual: id === atual }));
}

/** Chave da NF-e digitada: '' (sem nota) ou 44 dígitos. → mensagem de erro ou null. */
export function erroChaveNfe(texto) {
  const t = String(texto ?? '').trim();
  if (!t) return null;
  return t.replace(/\D/g, '').length === 44 && /^[\d\s.\-/]+$/.test(t)
    ? null : 'A chave da NF-e tem 44 números (fica no alto da nota). Deixe vazio para usar a declaração de conteúdo.';
}

/** Itens do pedido: total de unidades. */
export function totalUnidades(itens) {
  return (Array.isArray(itens) ? itens : []).reduce((soma, i) => soma + (Number(i.quantidade) || 0), 0);
}

// ---------------------------------------------------------------------------
// Página

/** replaceChildren que ignora null/undefined/false (o nativo os escreveria como texto). */
function trocar(container, ...filhos) {
  container.replaceChildren(...filhos.flat().filter((f) => f !== null && f !== undefined && f !== false));
}

const COLUNAS_LISTA = 'id, numero, cliente_nome, cliente_email, total_centavos, status, criado_em, entrega';
const COLUNAS_ITENS = 'pedido_itens(id, produto_id, nome, imagem, preco_unitario_centavos, quantidade, total_centavos)';
const COLUNAS_EVENTOS = 'id, tipo, descricao, dados, autor, criado_em';

export async function renderizar(ctx) {
  if (ctx.params.id) return renderizarDetalhe(ctx);
  return renderizarLista(ctx);
}

// ---------------------------------------------------------------------------
// Lista #/pedidos

async function renderizarLista(ctx) {
  const { ui, api, supabase } = ctx;
  const { el } = ui;
  const consulta = ctx.consulta || {};
  const estado = {
    filtro: filtroDaUrl(consulta.status),
    busca: typeof consulta.busca === 'string' ? consulta.busca : '',
    pagina: Math.max(1, Number.parseInt(consulta.pagina, 10) || 1),
  };
  let carregado = false;
  let sequencia = 0;

  const botaoAtualizar = ui.botao({ texto: 'Atualizar', icone: 'atualizar', aoClicar: () => carregar({ silencioso: true, botao: botaoAtualizar }) });
  ctx.raiz.append(ui.cabecalhoPagina({
    titulo: 'Pedidos',
    descricao: 'Acompanhe o pagamento, a separação e o envio de cada pedido da loja.',
    acoes: [botaoAtualizar],
  }));
  const css = ui.carregarCss('pedidos');

  const busca = el('input', {
    type: 'search', class: 'entrada', placeholder: 'Buscar por número, nome, e-mail ou telefone…', 'aria-label': 'Buscar pedidos',
    value: estado.busca, enterkeyhint: 'search', autocomplete: 'off',
  });
  const selFiltro = el('select', { class: 'entrada', 'aria-label': 'Filtrar por situação' },
    FILTROS_STATUS.filter((f) => !f.individual).map((f) => el('option', { value: f.id }, f.rotulo)),
    el('optgroup', { label: 'Uma situação' }, FILTROS_STATUS.filter((f) => f.individual).map((f) => el('option', { value: f.id }, f.rotulo))));
  selFiltro.value = estado.filtro;
  const contador = el('p', { class: 'pedidos-contador', 'aria-live': 'polite' });
  const avisos = el('div', { class: 'pedidos-avisos' });
  const corpo = el('div', { class: 'cartao__corpo cartao__corpo--sem-espaco' });
  const paginacao = el('nav', { class: 'paginacao', 'aria-label': 'Páginas da lista de pedidos', hidden: true });
  ctx.raiz.append(
    avisos,
    el('section', { class: 'cartao', 'aria-label': 'Lista de pedidos' },
      el('div', { class: 'cartao__corpo pedidos-filtros' },
        el('div', { class: 'filtros' }, el('div', { class: 'filtros__busca' }, ui.icone('busca'), busca), selFiltro),
        contador),
      corpo),
    paginacao,
  );

  function guardarNaUrl() {
    const p = new URLSearchParams();
    if (estado.filtro) p.set('status', estado.filtro);
    if (estado.busca.trim()) p.set('busca', estado.busca.trim());
    if (estado.pagina > 1) p.set('pagina', String(estado.pagina));
    const texto = p.toString();
    ctx.navegar(`#/pedidos${texto ? `?${texto}` : ''}`, { silencioso: true });
  }

  function limparFiltros() {
    Object.assign(estado, { filtro: '', busca: '', pagina: 1 });
    busca.value = '';
    selFiltro.value = '';
    guardarNaUrl();
    carregar();
    busca.focus();
  }

  function desenharAvisos(paraEnviar) {
    if (!paraEnviar || estado.filtro === 'para_enviar') {
      trocar(avisos);
      return;
    }
    const ver = ui.botao({
      texto: 'Ver quais', tamanho: 'pequeno', classe: 'pedidos-avisos__botao',
      aoClicar: () => {
        Object.assign(estado, { filtro: 'para_enviar', pagina: 1 });
        selFiltro.value = 'para_enviar';
        guardarNaUrl();
        carregar();
      },
    });
    const texto = paraEnviar === 1 ? '1 pedido pago está esperando separação ou envio.' : `${paraEnviar} pedidos pagos estão esperando separação ou envio.`;
    trocar(avisos, ui.aviso(el('div', { class: 'pedidos-avisos__texto' }, el('span', {}, texto), ver), 'alerta', { titulo: 'Pedidos para enviar' }));
  }

  function celulaPedido(p) {
    return el('span', { class: 'pedido-celula' },
      el('span', { class: 'pedido-celula__numero' }, ui.formatarNumeroPedido(p.numero)),
      el('span', { class: 'pedido-celula__data' }, ui.formatarData(p.criado_em)));
  }

  function celulaCliente(p) {
    return el('span', { class: 'pedido-cliente' },
      el('span', { class: 'pedido-cliente__nome' }, p.cliente_nome || '—'),
      p.cliente_email ? el('span', { class: 'pedido-cliente__email oculto-celular' }, p.cliente_email) : null);
  }

  function desenharPaginacao(total) {
    const paginas = totalDePaginas(total);
    paginacao.hidden = paginas <= 1;
    if (paginas <= 1) {
      trocar(paginacao);
      return;
    }
    const ir = (n) => {
      estado.pagina = n;
      guardarNaUrl();
      carregar();
      ctx.raiz.querySelector('h1')?.scrollIntoView({ block: 'start' });
    };
    trocar(paginacao, 
      ui.botao({ texto: 'Anterior', tamanho: 'pequeno', icone: 'voltar', attrs: { disabled: estado.pagina <= 1 }, aoClicar: () => ir(estado.pagina - 1) }),
      el('span', { class: 'paginacao__info' }, `Página ${estado.pagina} de ${paginas}`),
      ui.botao({ texto: 'Próxima', tamanho: 'pequeno', iconeDireita: 'avancar', attrs: { disabled: estado.pagina >= paginas }, aoClicar: () => ir(estado.pagina + 1) }),
    );
  }

  function montarConsulta() {
    let q = supabase.from('pedidos').select(COLUNAS_LISTA, { count: 'exact' });
    const status = statusDoFiltro(estado.filtro);
    if (status) q = q.in('status', status);
    const termo = termoBusca(estado.busca);
    if (termo && termo.numero !== undefined) q = q.eq('numero', termo.numero);
    else if (termo) q = q.or(filtroOuDaBusca(termo));
    const inicio = (estado.pagina - 1) * TAMANHO_PAGINA;
    return q.order('criado_em', { ascending: false }).order('numero', { ascending: false }).range(inicio, inicio + TAMANHO_PAGINA - 1);
  }

  async function carregar({ silencioso = false, botao = null } = {}) {
    const minha = ++sequencia;
    if (!silencioso) ui.estadoCarregando(corpo, { linhas: 6, tipo: 'tabela', mensagem: 'Carregando pedidos…' });
    const tarefa = () => Promise.all([
      api.consultar(montarConsulta()),
      api.consultar(supabase.from('pedidos').select('id', { count: 'exact', head: true }).in('status', ['pago', 'em_separacao'])),
      css,
    ]);
    const [r, rEnviar] = botao ? await ui.ocupado(botao, tarefa) || [] : await tarefa();
    if (!ctx.ativo() || minha !== sequencia || !r) return;
    if (!r.ok) {
      // Página que não existe mais (a lista encolheu): volta para a primeira.
      if (estado.pagina > 1 && r.status === 416) {
        estado.pagina = 1;
        guardarNaUrl();
        carregar({ silencioso });
        return;
      }
      if (silencioso && carregado) {
        ui.toast(r.mensagem, 'erro');
        return;
      }
      contador.textContent = '';
      paginacao.hidden = true;
      ui.estadoErro(corpo, r.mensagem, { titulo: 'Não foi possível carregar os pedidos', aoTentarNovamente: () => carregar() });
      return;
    }
    carregado = true;
    desenharAvisos(rEnviar && rEnviar.ok ? rEnviar.total || 0 : 0);
    const pedidos = r.dados || [];
    const total = r.total ?? pedidos.length;
    if (!pedidos.length && total > 0 && estado.pagina > 1) {
      estado.pagina = totalDePaginas(total);
      guardarNaUrl();
      carregar({ silencioso });
      return;
    }
    const filtrando = Boolean(estado.filtro || estado.busca.trim());
    contador.textContent = total ? `${total} ${total === 1 ? 'pedido' : 'pedidos'}${filtrando ? ' encontrados' : ''}` : '';
    desenharPaginacao(total);
    if (!pedidos.length) {
      if (filtrando) {
        ui.estadoVazio(corpo, 'Nenhum pedido encontrado com esses filtros. Confira a busca ou limpe os filtros.', {
          titulo: 'Nada encontrado', icone: 'busca', acao: { texto: 'Limpar filtros', tipo: 'secundario', icone: 'fechar', aoClicar: limparFiltros },
        });
      } else {
        ui.estadoVazio(corpo, 'Quando alguém comprar na loja, o pedido aparece aqui.', { titulo: 'Nenhum pedido ainda', icone: 'pedidos' });
      }
      return;
    }
    corpo.replaceChildren(ui.tabela({
      legenda: 'Pedidos da loja',
      classe: 'pedidos-tabela',
      linhas: pedidos,
      link: (p) => `#/pedidos/${p.id}`,
      colunas: [
        { titulo: 'Pedido', principal: true, celula: celulaPedido },
        { titulo: 'Cliente', celula: celulaCliente },
        { titulo: 'Total', alinhar: 'direita', celula: (p) => el('strong', { class: 'pedido-total' }, formatarPreco(p.total_centavos)) },
        { titulo: 'Situação', celula: (p) => ui.seloStatusPedido(p.status) },
        { titulo: 'Entrega', ocultarNoCelular: true, celula: (p) => nomeEntrega(p.entrega) },
        {
          titulo: 'Quando', ocultarNoCelular: true,
          celula: (p) => el('time', { datetime: p.criado_em, title: ui.formatarData(p.criado_em) }, ui.tempoRelativo(p.criado_em)),
        },
      ],
    }));
  }

  function aplicarFiltros() {
    buscar.cancelar();
    estado.busca = busca.value;
    estado.filtro = selFiltro.value;
    estado.pagina = 1;
    guardarNaUrl();
    carregar();
  }
  const buscar = ui.debounce(aplicarFiltros, 350);
  busca.addEventListener('input', buscar);
  busca.addEventListener('keydown', (evento) => {
    if (evento.key === 'Enter') {
      evento.preventDefault();
      aplicarFiltros();
    }
  });
  selFiltro.addEventListener('change', aplicarFiltros);

  const aoVoltar = () => {
    if (document.visibilityState === 'visible' && carregado) carregar({ silencioso: true });
  };
  document.addEventListener('visibilitychange', aoVoltar);

  await carregar();

  return () => {
    buscar.cancelar();
    document.removeEventListener('visibilitychange', aoVoltar);
  };
}

// ---------------------------------------------------------------------------
// Detalhe #/pedidos/<id>

async function renderizarDetalhe(ctx) {
  const { ui, api, supabase } = ctx;
  const { el } = ui;
  const id = ctx.params.id;

  const botaoAtualizar = ui.botao({ texto: 'Atualizar', icone: 'atualizar', aoClicar: () => recarregar({ botao: botaoAtualizar }) });
  const cabecalho = ui.cabecalhoPagina({
    titulo: 'Pedido',
    descricao: 'Carregando…',
    voltar: { href: '#/pedidos', texto: 'Pedidos' },
    acoes: [botaoAtualizar],
  });
  const corpo = el('div', { class: 'pilha' });
  ctx.raiz.append(cabecalho, corpo);
  ui.estadoCarregando(corpo, { linhas: 8, mensagem: 'Carregando o pedido…' });
  const titulo = cabecalho.querySelector('h1');
  const descricaoTopo = cabecalho.querySelector('.pagina-cabecalho__descricao');
  const acoesTopo = cabecalho.querySelector('.pagina-cabecalho__acoes');

  let pedido = null;
  let eventos = [];
  let integracoes = null; // de /api/admin/status (null enquanto não respondeu ou se falhou)
  let erroEnvio = null;
  let montado = false;
  let carregando = false;

  async function buscarDados() {
    const [rp, re] = await Promise.all([
      api.consultar(supabase.from('pedidos').select(`*, ${COLUNAS_ITENS}`).eq('id', id).maybeSingle()),
      api.consultar(supabase.from('pedido_eventos').select(COLUNAS_EVENTOS).eq('pedido_id', id).order('criado_em').order('id')),
    ]);
    return { rp, re };
  }

  // Situação das integrações (e-mail, Melhor Envio e saldo): não segura a página.
  async function consultarIntegracoes() {
    const r = await api.chamarApi('/api/admin/status', { sinal: ctx.sinal });
    if (!ctx.ativo() || r.erro === 'cancelado') return;
    integracoes = r.ok && r.integracoes ? r.integracoes : null;
    if (montado) desenharEnvio();
  }
  consultarIntegracoes();

  const [{ rp, re }] = await Promise.all([buscarDados(), ui.carregarCss('pedidos')]);
  if (!ctx.ativo()) return undefined;
  if (!rp.ok) {
    descricaoTopo.textContent = '';
    ui.estadoErro(corpo, rp.mensagem, { titulo: 'Não foi possível abrir o pedido', aoTentarNovamente: () => ctx.navegar(window.location.hash) });
    return undefined;
  }
  if (!rp.dados) {
    titulo.textContent = 'Pedido não encontrado';
    descricaoTopo.textContent = '';
    ui.estadoVazio(corpo, 'Este pedido não existe mais (pode ter sido apagado). Volte para a lista para ver os pedidos atuais.', {
      titulo: 'Pedido não encontrado', icone: 'pedidos', acao: { texto: 'Ver pedidos', href: '#/pedidos', icone: 'voltar' },
    });
    return undefined;
  }
  pedido = rp.dados;
  eventos = re.ok ? re.dados || [] : [];
  if (!re.ok) ui.toast(`Não foi possível carregar a linha do tempo: ${re.mensagem}`, 'erro');

  // --- Áreas da página (montadas uma vez; desenhar() troca o conteúdo) -----
  const cartao = (idTitulo, tituloTexto, ...conteudo) => el('section', { class: ['cartao', `pedido-bloco--${idTitulo.slice(3)}`], 'aria-labelledby': idTitulo },
    el('div', { class: 'cartao__cabecalho' }, el('h2', { class: 'cartao__titulo', id: idTitulo }, tituloTexto)),
    el('div', { class: 'cartao__corpo' }, ...conteudo));

  const areaProxima = el('div', { class: 'pedido-proxima' });
  const areaItens = el('div', { class: 'pilha pilha--estreita' });
  const areaEnvio = el('div', { class: 'pilha' });
  const tituloEnvio = el('h2', { class: 'cartao__titulo', id: 'pd-envio' }, 'Envio');
  const subtituloEnvio = el('p', { class: 'cartao__subtitulo' });
  const cartaoEnvio = el('section', { class: 'cartao pedido-envio pedido-bloco--envio', 'aria-labelledby': 'pd-envio' },
    el('div', { class: 'cartao__cabecalho' }, tituloEnvio, subtituloEnvio),
    el('div', { class: 'cartao__corpo' }, areaEnvio));
  const listaEventos = el('ol', { class: 'pedido-eventos', 'aria-label': 'Linha do tempo do pedido (mais recentes primeiro)' });
  const areaSituacao = el('div', { class: 'pilha pilha--estreita' });
  const areaPagamento = el('div', { class: 'pilha pilha--estreita' });
  const areaCliente = el('div', { class: 'pilha pilha--estreita' });
  const areaEntrega = el('div', { class: 'pilha pilha--estreita' });
  const areaMais = el('div', { class: 'pilha pilha--estreita' });
  // Nota interna (fica fora de desenhar() para não perder o que foi digitado).
  const nota = ui.campo({
    rotulo: 'Nova nota da equipe', nome: 'nota', tipo: 'textarea', linhas: 3,
    ajuda: 'Só a equipe vê. Ex.: "Cliente pediu para entregar depois das 14 h".', attrs: { maxlength: '2000' },
  });
  const botaoNota = ui.botao({ texto: 'Adicionar nota', icone: 'mais', tipoHtml: 'submit' });
  const formNota = el('form', { class: 'pedido-nota', novalidate: true, 'aria-label': 'Adicionar nota interna' },
    nota.elemento, el('div', { class: 'grupo-botoes pedido-nota__acoes' }, botaoNota));
  formNota.addEventListener('input', () => ctx.marcarAlterado(nota.ler().trim() !== ''));
  formNota.addEventListener('submit', (evento) => {
    evento.preventDefault();
    adicionarNota();
  });

  corpo.replaceChildren(
    areaProxima,
    // No celular os blocos das duas colunas se intercalam (ordem em pedidos.css).
    el('div', { class: 'grade grade--painel pedido-colunas' },
      el('div', { class: 'pilha' },
        cartao('pd-itens', 'Itens', areaItens),
        cartaoEnvio,
        cartao('pd-tempo', 'Linha do tempo', formNota, listaEventos)),
      el('div', { class: 'pilha' },
        cartao('pd-situacao', 'Situação', areaSituacao),
        cartao('pd-pagamento', 'Pagamento', areaPagamento),
        cartao('pd-cliente', 'Cliente', areaCliente),
        cartao('pd-entrega', 'Entrega', areaEntrega),
        cartao('pd-mais', 'Mais ações', areaMais))),
  );
  montado = true;

  // --- Desenho ---------------------------------------------------------------
  const linhaDado = (rotulo, ...valor) => el('div', {}, el('dt', {}, rotulo), el('dd', {}, ...valor));

  function desenharCabecalho() {
    const numero = ui.formatarNumeroPedido(pedido.numero);
    titulo.textContent = `Pedido ${numero}`;
    ctx.definirTitulo(`Pedido ${numero}`);
    descricaoTopo.textContent = `Feito em ${ui.formatarData(pedido.criado_em)} (${ui.tempoRelativo(pedido.criado_em)}) por ${pedido.cliente_nome || 'cliente'}`;
    trocar(acoesTopo, ui.seloStatusPedido(pedido.status), botaoAtualizar);
  }

  function desenharProxima() {
    const acao = proximaAcao(pedido);
    const botoes = [];
    if (acao.proximo) {
      botoes.push(ui.botao({ texto: acao.botao, tipo: 'primario', icone: 'check', aoClicar: () => abrirStatus(acao.proximo) }));
    }
    if (acao.conferir) {
      const b = ui.botao({ texto: 'Conferir pagamento', icone: 'atualizar', aoClicar: () => conferirPagamento(b) });
      botoes.push(b);
    }
    trocar(areaProxima, ui.aviso(el('div', { class: 'pedido-proxima__conteudo' },
      el('p', {}, acao.texto),
      botoes.length ? el('div', { class: 'grupo-botoes' }, botoes) : null), acao.tipo, { titulo: acao.titulo }));
  }

  function desenharItens() {
    const itens = Array.isArray(pedido.pedido_itens) ? [...pedido.pedido_itens].sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0)) : [];
    const lista = el('ul', { class: 'pedido-itens', 'aria-label': 'Itens do pedido' }, itens.map((item) => el('li', { class: 'pedido-item' },
      el('div', { class: 'pedido-item__foto' },
        item.imagem ? el('img', { src: item.imagem, alt: '', loading: 'lazy', decoding: 'async' }) : ui.icone('produtos')),
      el('div', { class: 'pedido-item__textos' },
        item.produto_id
          ? el('a', { class: 'pedido-item__nome', href: `#/produtos/${item.produto_id}` }, item.nome)
          : el('span', { class: 'pedido-item__nome' }, item.nome),
        el('span', { class: 'pedido-item__detalhe' }, `${item.quantidade} × ${formatarPreco(item.preco_unitario_centavos)}`)),
      el('strong', { class: 'pedido-item__total' }, formatarPreco(item.total_centavos)))));
    const unidades = totalUnidades(itens);
    trocar(areaItens, 
      lista,
      el('dl', { class: 'lista-dados pedido-totais' },
        linhaDado(`Produtos (${unidades} ${unidades === 1 ? 'unidade' : 'unidades'})`, formatarPreco(pedido.subtotal_centavos)),
        linhaDado(`Frete — ${nomeEntrega(pedido.entrega)}`, pedido.frete_centavos > 0 ? formatarPreco(pedido.frete_centavos) : 'Grátis'),
        el('div', { class: 'pedido-totais__total' }, el('dt', {}, 'Total pago pela cliente'), el('dd', {}, formatarPreco(pedido.total_centavos)))),
    );
  }

  function desenharSituacao() {
    const datas = [
      ['Pago em', pedido.pago_em], ['Enviado em', pedido.enviado_em], ['Entregue em', pedido.entregue_em], ['Cancelado em', pedido.cancelado_em],
    ].filter(([, data]) => data);
    trocar(areaSituacao, 
      el('p', { class: 'pedido-situacao' }, ui.seloStatusPedido(pedido.status)),
      datas.length ? el('dl', { class: 'lista-dados' }, datas.map(([rotulo, data]) => linhaDado(rotulo, ui.formatarData(data)))) : null,
      pedido.estoque_baixado
        ? el('p', { class: 'texto-pequeno texto-suave' }, 'Os produtos deste pedido já saíram do estoque.')
        : null,
      ui.botao({ texto: 'Mudar situação', icone: 'editar', bloco: true, aoClicar: () => abrirStatus(pedido.status) }),
    );
  }

  function desenharPagamento() {
    const linhas = [
      linhaDado('Situação', rotuloPagamento(pedido.status_pagamento)),
      linhaDado('Meio', rotuloMetodo(pedido.metodo_pagamento)),
    ];
    if (pedido.mp_payment_id) linhas.push(linhaDado('Pagamento no Mercado Pago', el('span', { class: 'mono' }, String(pedido.mp_payment_id))));
    if (pedido.pago_em) linhas.push(linhaDado('Confirmado em', ui.formatarData(pedido.pago_em)));
    const conferir = ui.botao({ texto: 'Conferir no Mercado Pago', icone: 'atualizar', bloco: true, aoClicar: () => conferirPagamento(conferir) });
    const copiarLink = pedido.status === 'aguardando_pagamento' && pedido.mp_init_point
      ? ui.botao({
        texto: 'Copiar link de pagamento', icone: 'copiar', bloco: true,
        aoClicar: () => ui.copiarTexto(pedido.mp_init_point, { mensagem: 'Link de pagamento copiado. Envie para a cliente se ela precisar pagar de novo.' }),
      })
      : null;
    trocar(areaPagamento, 
      el('dl', { class: 'lista-dados' }, linhas),
      el('p', { class: 'texto-pequeno texto-suave' }, 'A confirmação chega sozinha. Use "Conferir" se a cliente disser que pagou e o pedido não mudou.'),
      conferir,
      copiarLink,
    );
  }

  function desenharCliente() {
    const whatsapp = linkWhatsapp(pedido.cliente_telefone);
    const email = String(pedido.cliente_email || '');
    trocar(areaCliente, 
      el('p', { class: 'pedido-cliente-nome' }, pedido.cliente_nome || '—'),
      el('dl', { class: 'lista-dados' },
        linhaDado('E-mail', email
          ? el('a', { href: `mailto:${encodeURIComponent(email).replace(/%40/g, '@')}`, class: 'pedido-quebra' }, email) : '—'),
        linhaDado('Telefone', whatsapp
          ? el('a', { href: whatsapp, target: '_blank', rel: 'noopener noreferrer' }, formatarTelefone(pedido.cliente_telefone), ' ', ui.icone('externo'))
          : formatarTelefone(pedido.cliente_telefone) || '—'),
        linhaDado('CPF', el('span', { class: 'mono' }, formatarCpf(pedido.cliente_cpf) || '—'))),
      whatsapp ? ui.botao({ texto: 'Conversar no WhatsApp', icone: 'externo', bloco: true, href: whatsapp, attrs: { target: '_blank', rel: 'noopener noreferrer' } }) : null,
    );
  }

  function desenharEntrega() {
    const entrega = pedido.entrega || {};
    const endereco = linhasEndereco(pedido.endereco);
    const codigos = String(pedido.codigo_rastreio || '').split(',').map((c) => c.trim()).filter(Boolean);
    const prazo = Number.isInteger(entrega.prazo_dias) && entrega.prazo_dias > 0
      ? `até ${entrega.prazo_dias} ${entrega.prazo_dias === 1 ? 'dia útil' : 'dias úteis'} após a postagem` : null;
    trocar(areaEntrega, 
      el('p', { class: 'pedido-entrega-nome' }, ui.icone('caminhao'), nomeEntrega(entrega)),
      el('p', { class: 'texto-pequeno texto-suave' },
        entrega.tipo === 'melhor_envio' ? 'Pelo Melhor Envio' : entrega.tipo === 'fixo' ? 'Frete fixo (a AMA combina a entrega)' : 'Forma de entrega antiga',
        prazo ? ` · ${prazo}` : ''),
      endereco.length
        ? el('address', { class: 'pedido-endereco' }, endereco.map((linha) => el('span', {}, linha)))
        : el('p', { class: 'texto-suave' }, 'Sem endereço.'),
      codigos.length || pedido.url_rastreio
        ? el('div', { class: 'pedido-rastreio' },
          el('p', { class: 'pedido-rastreio__rotulo' }, codigos.length > 1 ? 'Códigos de rastreio' : 'Rastreio'),
          codigos.length ? el('p', { class: 'mono pedido-quebra' }, codigos.join(', ')) : null,
          pedido.url_rastreio
            ? el('a', { href: pedido.url_rastreio, target: '_blank', rel: 'noopener noreferrer' }, 'Acompanhar a entrega ', ui.icone('externo'))
            : null)
        : null,
    );
  }

  function desenharMais() {
    const linkCliente = `${window.location.origin}/loja/pedido?id=${encodeURIComponent(pedido.id)}&token=${encodeURIComponent(pedido.token_acesso || '')}`;
    const apagavel = podeApagar(pedido);
    trocar(areaMais, 
      ui.botao({ texto: 'Ver como a cliente vê', icone: 'externo', bloco: true, href: linkCliente, attrs: { target: '_blank', rel: 'noopener' } }),
      ui.botao({
        texto: 'Copiar link do pedido', icone: 'copiar', bloco: true,
        aoClicar: () => ui.copiarTexto(linkCliente, { mensagem: 'Link copiado. Com ele a cliente acompanha o pedido.' }),
      }),
      el('hr', { class: 'divisor' }),
      apagavel
        ? el('p', { class: 'texto-pequeno texto-suave' }, 'Apagar tira o pedido do painel para sempre (útil para pedidos de teste).')
        : null,
      apagavel ? ui.botao({ texto: 'Apagar pedido', tipo: 'perigo-suave', icone: 'lixeira', bloco: true, aoClicar: apagarPedido }) : null,
    );
  }

  function desenharEventos() {
    const lista = ordenarEventos(eventos).reverse();
    if (!lista.length) {
      trocar(listaEventos, el('li', { class: 'pedido-evento pedido-evento--vazio' }, 'Nenhum registro ainda.'));
      return;
    }
    trocar(listaEventos, ...lista.map((e) => {
      const visual = visualEvento(e.tipo);
      return el('li', { class: ['pedido-evento', `pedido-evento--${e.tipo}`] },
        el('span', { class: ['pedido-evento__icone', `pedido-evento__icone--${visual.cor}`] }, ui.icone(visual.icone)),
        el('div', { class: 'pedido-evento__textos' },
          el('p', { class: 'pedido-evento__tipo' }, visual.rotulo),
          el('p', { class: 'pedido-evento__descricao' }, e.descricao),
          el('p', { class: 'pedido-evento__meta' },
            el('time', { datetime: e.criado_em, title: ui.formatarData(e.criado_em) }, ui.formatarData(e.criado_em)),
            ` · ${rotuloAutor(e.autor)}`)),
        e.tipo === 'nota'
          ? ui.botao({ tipo: 'fantasma', tamanho: 'pequeno', icone: 'lixeira', rotulo: 'Apagar esta nota', aoClicar: () => apagarNota(e) })
          : null);
    }));
  }

  // --- Envio -----------------------------------------------------------------
  const TEXTO_ETAPA = {
    carrinho: {
      titulo: 'Colocar a etiqueta no carrinho',
      texto: 'O Melhor Envio calcula de novo o frete com as medidas dos produtos e guarda a etiqueta no carrinho da conta da AMA.',
    },
    compra: { titulo: 'Pagar a etiqueta', texto: 'O valor sai do saldo da carteira do Melhor Envio.' },
    geracao: { titulo: 'Gerar a etiqueta', texto: 'O Melhor Envio prepara o arquivo da etiqueta. Leva alguns segundos.' },
    impressao: { titulo: 'Imprimir', texto: 'Abra o PDF da etiqueta, imprima e cole no pacote.' },
    postagem: {
      titulo: 'Postar e avisar a cliente',
      texto: 'Leve o pacote aos Correios ou à transportadora. Depois busque o rastreio e marque o pedido como enviado: a cliente recebe o código por e-mail.',
    },
  };

  const chaveNfe = ui.campo({
    rotulo: 'Chave da nota fiscal (NF-e)', nome: 'chave_nfe', placeholder: '44 números (opcional)',
    ajuda: 'Opcional. Sem nota fiscal, a etiqueta vai com declaração de conteúdo.', attrs: { inputmode: 'numeric', autocomplete: 'off', maxlength: '60' },
  });

  function botaoEnvio(texto, acao, { tipo = 'primario', icone = 'check', extra } = {}) {
    const b = ui.botao({ texto, tipo, icone, tamanho: 'pequeno' });
    b.addEventListener('click', () => executarEnvio(acao, b, typeof extra === 'function' ? extra() : extra));
    return b;
  }

  function resumoCarrinho() {
    const evento = ultimoCarrinho(eventos);
    const etiquetas = evento && Array.isArray(evento.dados.etiquetas) ? evento.dados.etiquetas : [];
    const total = etiquetas.reduce((s, e) => s + (Number.isSafeInteger(e.preco_centavos) ? e.preco_centavos : 0), 0);
    const n = etiquetas.length || (Array.isArray(pedido.me_ordens) ? pedido.me_ordens.length : 0);
    if (!n) return null;
    return `${n} ${n === 1 ? 'etiqueta' : 'etiquetas'}${total ? ` · ${formatarPreco(total)}` : ''}${evento && evento.dados.nfe ? ' · com NF-e' : ' · declaração de conteúdo'}`;
  }

  function conteudoEtapa(etapa) {
    const blocos = [];
    if (etapa.id === 'carrinho') {
      if (etapa.feito) {
        const resumo = resumoCarrinho();
        if (resumo) blocos.push(el('p', { class: 'envio-etapa__feito' }, resumo));
        const refazer = el('button', { type: 'button', class: 'botao-link' }, ui.icone('atualizar'), 'Refazer as etiquetas');
        refazer.addEventListener('click', () => refazerEtiquetas(refazer));
        blocos.push(refazer);
      } else {
        blocos.push(chaveNfe.elemento, el('div', { class: 'grupo-botoes' },
          botaoEnvio('Adicionar ao carrinho', 'adicionar_carrinho', { icone: 'mais', extra: () => ({ chave_nfe: chaveNfe.ler().replace(/\D/g, '') || undefined }) })));
      }
    } else if (etapa.id === 'compra' && etapa.atual) {
      const me = integracoes && integracoes.melhor_envio;
      if (me) {
        blocos.push(el('p', { class: 'texto-pequeno' }, typeof me.saldo_centavos === 'number'
          ? `Saldo na carteira do Melhor Envio: ${formatarPreco(me.saldo_centavos)}`
          : 'Não foi possível consultar o saldo agora.'));
      }
      blocos.push(el('div', { class: 'grupo-botoes' }, botaoEnvio('Pagar etiqueta', 'comprar', { icone: 'dinheiro' })));
    } else if (etapa.id === 'geracao' && etapa.atual) {
      blocos.push(el('div', { class: 'grupo-botoes' }, botaoEnvio('Gerar etiqueta', 'gerar', { icone: 'atualizar' })));
    } else if (etapa.id === 'impressao') {
      if (etapa.feito && pedido.etiqueta_url) {
        blocos.push(el('div', { class: 'grupo-botoes' },
          ui.botao({ texto: 'Abrir etiqueta para imprimir', tipo: etapa.atual ? 'primario' : 'secundario', icone: 'externo', tamanho: 'pequeno', href: pedido.etiqueta_url, attrs: { target: '_blank', rel: 'noopener noreferrer' } })));
      } else if (etapa.atual) {
        blocos.push(el('div', { class: 'grupo-botoes' }, botaoEnvio('Preparar a impressão', 'imprimir', { icone: 'externo' })));
      }
    } else if (etapa.id === 'postagem' && (etapa.atual || etapa.feito)) {
      const botoes = [botaoEnvio('Buscar rastreio', 'rastrear', { tipo: 'secundario', icone: 'busca' })];
      if (!etapa.feito) botoes.push(ui.botao({ texto: 'Marcar como enviado', tipo: 'primario', icone: 'check', tamanho: 'pequeno', aoClicar: () => abrirStatus('enviado') }));
      blocos.push(el('div', { class: 'grupo-botoes' }, botoes));
    }
    return blocos;
  }

  function desenharEnvio() {
    const entrega = pedido.entrega || {};
    const disponivel = envioDisponivel(pedido);
    if (!disponivel.usa) {
      tituloEnvio.textContent = 'Envio';
      subtituloEnvio.textContent = nomeEntrega(entrega);
      const podeEnviar = ['pago', 'em_separacao'].includes(pedido.status);
      trocar(areaEnvio, 
        el('p', {}, entrega.tipo === 'fixo'
          ? 'Frete fixo: a AMA faz a entrega por conta própria (ou combina com um entregador). Quando o pedido sair, marque como enviado e, se tiver, informe um código ou link de acompanhamento.'
          : 'Este pedido usa uma forma de entrega que não existe mais na loja. Combine a entrega com a cliente.'),
        podeEnviar ? el('div', { class: 'grupo-botoes' }, ui.botao({ texto: 'Marcar como enviado', icone: 'caminhao', aoClicar: () => abrirStatus('enviado') })) : null,
      );
      return;
    }
    tituloEnvio.textContent = 'Envio pelo Melhor Envio';
    subtituloEnvio.textContent = `${nomeEntrega(entrega)} — siga os passos na ordem.`;
    if (!disponivel.liberado) {
      trocar(areaEnvio, el('p', { class: 'texto-suave' }, disponivel.motivo));
      return;
    }
    const etapas = etapasEnvio(pedido, eventos);
    const semToken = integracoes && integracoes.melhor_envio && integracoes.melhor_envio.configurado === false;
    trocar(areaEnvio, 
      semToken ? ui.aviso('O Melhor Envio não está configurado (falta o MELHOR_ENVIO_TOKEN na Vercel). Sem ele não dá para gerar a etiqueta por aqui.', 'alerta', { titulo: 'Melhor Envio desligado' }) : null,
      erroEnvio ? ui.aviso(erroEnvio, 'erro', { titulo: 'O Melhor Envio não concluiu a ação' }) : null,
      el('ol', { class: 'envio-etapas', 'aria-label': 'Passos do envio pelo Melhor Envio' }, etapas.map((etapa, i) => {
        const textos = TEXTO_ETAPA[etapa.id];
        const situacao = etapa.feito ? 'concluído' : etapa.atual ? 'próximo passo' : 'depois';
        return el('li', {
          class: ['envio-etapa', etapa.feito && 'envio-etapa--feita', etapa.atual && 'envio-etapa--atual'],
          'aria-current': etapa.atual ? 'step' : null,
        },
        el('span', { class: 'envio-etapa__marca', 'aria-hidden': 'true' }, etapa.feito ? ui.icone('check') : String(i + 1)),
        el('div', { class: 'envio-etapa__corpo' },
          el('p', { class: 'envio-etapa__titulo' }, textos.titulo, el('span', { class: 'sr-only' }, ` (${situacao})`)),
          etapa.atual || !etapa.feito ? el('p', { class: 'envio-etapa__texto' }, textos.texto) : null,
          ...conteudoEtapa(etapa)));
      })),
    );
  }

  const MENSAGEM_SUCESSO_ENVIO = {
    adicionar_carrinho: (r) => `Etiqueta no carrinho do Melhor Envio${r.total_centavos ? ` (${formatarPreco(r.total_centavos)})` : ''}. Próximo passo: pagar.`,
    comprar: (r) => r.mensagem || 'Etiqueta paga. Próximo passo: gerar.',
    gerar: () => 'Geração pedida. Em alguns segundos dá para imprimir.',
    imprimir: () => 'Etiqueta pronta. Use "Abrir etiqueta para imprimir".',
    rastrear: (r) => (r.codigo_rastreio ? `Rastreio: ${r.codigo_rastreio}` : 'Ainda sem código de rastreio. Tente de novo depois que o pacote for postado.'),
  };

  async function executarEnvio(acao, botao, extra = {}) {
    if (acao === 'adicionar_carrinho') {
      const erro = erroChaveNfe(chaveNfe.ler());
      if (erro) {
        chaveNfe.definirErro(erro);
        chaveNfe.entrada.focus();
        return;
      }
    }
    erroEnvio = null;
    const r = await ui.ocupado(botao, () => api.chamarApi('/api/admin/envio', { corpo: { pedido_id: pedido.id, acao, ...extra }, sinal: ctx.sinal }));
    if (!r || !ctx.ativo() || r.erro === 'cancelado') return;
    if (!r.ok) {
      if (r.campo === 'chave_nfe') {
        chaveNfe.definirErro(r.mensagem);
        chaveNfe.entrada.focus();
        return;
      }
      erroEnvio = r.mensagem;
      ui.toast(r.mensagem, 'erro');
      // Etiqueta criada no Melhor Envio mas não salva, órfãs etc.: o pedido pode ter mudado.
      await recarregar({ silencioso: true });
      return;
    }
    if (acao === 'adicionar_carrinho') chaveNfe.entrada.value = '';
    if (acao === 'comprar') consultarIntegracoes();
    ui.toast(MENSAGEM_SUCESSO_ENVIO[acao](r), acao === 'rastrear' && !r.codigo_rastreio ? 'info' : 'sucesso');
    await recarregar({ silencioso: true });
  }

  async function refazerEtiquetas(botao) {
    const sim = await ui.confirmar('As etiquetas atuais saem do carrinho do Melhor Envio e novas são criadas com o frete calculado de novo. Só funciona se elas ainda não foram pagas (etiqueta paga precisa ser cancelada no site do Melhor Envio antes).', {
      titulo: 'Refazer as etiquetas?', textoConfirmar: 'Refazer etiquetas',
    });
    if (!sim || !ctx.ativo()) return;
    await executarEnvio('adicionar_carrinho', botao, { refazer: true, chave_nfe: chaveNfe.ler().replace(/\D/g, '') || undefined });
  }

  // --- Ações -----------------------------------------------------------------
  async function conferirPagamento(botao) {
    const r = await ui.ocupado(botao, () => api.chamarApi('/api/admin/pagamento', { corpo: { pedido_id: pedido.id }, sinal: ctx.sinal }));
    if (!r || !ctx.ativo() || r.erro === 'cancelado') return;
    if (!r.ok) {
      ui.toast(r.mensagem, 'erro');
      return;
    }
    if (!r.encontrado) {
      ui.toast(r.mensagem || 'Nenhum pagamento deste pedido foi encontrado no Mercado Pago.', 'info');
    } else {
      const situacao = rotuloPagamento(r.pagamento && r.pagamento.status);
      const mudou = r.resultado && r.resultado.mudou;
      ui.toast(mudou
        ? `Pagamento ${situacao.toLowerCase()}. O pedido agora está: ${rotuloStatusPedido(r.resultado.status_novo)}.`
        : `Pagamento ${situacao.toLowerCase()}. O pedido já estava atualizado.`, mudou ? 'sucesso' : 'info');
      ctx.atualizarContadores();
    }
    await recarregar({ silencioso: true });
  }

  function abrirStatus(inicial) {
    const status = ui.campo({
      rotulo: 'Nova situação', nome: 'status', tipo: 'select', valor: inicial,
      opcoes: STATUS_PEDIDO.map((s) => ({ valor: s, rotulo: s === pedido.status ? `${rotuloStatusPedido(s)} (atual)` : rotuloStatusPedido(s) })),
    });
    const codigo = ui.campo({
      rotulo: 'Código de rastreio', nome: 'codigo_rastreio', valor: pedido.codigo_rastreio || '',
      ajuda: 'Opcional. Vários códigos: separe com vírgula.', attrs: { maxlength: '200', autocomplete: 'off', spellcheck: 'false' },
    });
    const url = ui.campo({
      rotulo: 'Link para acompanhar a entrega', nome: 'url_rastreio', tipo: 'url', valor: pedido.url_rastreio || '',
      placeholder: 'https://…', ajuda: 'Opcional. Começa com https://.', attrs: { maxlength: '500', autocomplete: 'off', inputmode: 'url' },
    });
    const emailLigado = !(integracoes && integracoes.email && integracoes.email.configurado === false);
    const notificar = ui.campo({
      rotulo: 'Avisar a cliente por e-mail', nome: 'notificar', tipo: 'checkbox', valor: emailLigado,
      ajuda: emailLigado
        ? 'Ela recebe um e-mail com a nova situação (e o rastreio, se tiver).'
        : 'Os e-mails da loja estão desligados (falta configurar o envio de e-mails). A cliente acompanha pela página do pedido.',
      attrs: { disabled: !emailLigado },
    });
    const repor = ui.campo({
      rotulo: 'Devolver os produtos ao estoque', nome: 'repor', tipo: 'checkbox', valor: true,
      ajuda: 'Desmarque se os produtos não voltam para a venda (por exemplo, já foram entregues).',
    });
    const notaStatus = ui.campo({
      rotulo: 'Observação (opcional)', nome: 'nota_status', tipo: 'textarea', linhas: 2,
      ajuda: 'Fica na linha do tempo. A cliente não vê.', attrs: { maxlength: '2000' },
    });
    const avisos = el('div', { class: 'pilha pilha--estreita' });
    const blocoRastreio = el('div', { class: 'pilha pilha--estreita' }, codigo.elemento, url.elemento);

    function atualizarCampos() {
      const o = opcoesDoStatus(status.ler(), pedido);
      blocoRastreio.hidden = !o.rastreio;
      notificar.elemento.hidden = !o.notificar;
      repor.elemento.hidden = !o.reporEstoque;
      trocar(avisos, ...o.avisos.map((texto) => ui.aviso(texto, 'alerta')));
    }
    status.entrada.addEventListener('change', atualizarCampos);
    atualizarCampos();

    const controle = ui.modal({
      titulo: `Mudar situação do pedido ${ui.formatarNumeroPedido(pedido.numero)}`,
      classe: 'modal--pedido-status',
      conteudo: el('div', { class: 'formulario' }, status.elemento, avisos, blocoRastreio, repor.elemento, notificar.elemento, notaStatus.elemento),
      acoes: [
        { texto: 'Cancelar', valor: null },
        {
          texto: 'Salvar situação', tipo: 'primario', icone: 'check',
          aoClicar: async () => {
            const novo = status.ler();
            const o = opcoesDoStatus(novo, pedido);
            const corpoReq = { pedido_id: pedido.id, status: novo };
            if (o.rastreio) {
              const erros = errosRastreio(codigo.ler(), url.ler());
              if (erros.codigo) codigo.definirErro(erros.codigo);
              if (erros.url) url.definirErro(erros.url);
              if (erros.codigo || erros.url) {
                (erros.codigo ? codigo : url).entrada.focus();
                return false;
              }
              corpoReq.codigo_rastreio = codigo.ler().trim();
              corpoReq.url_rastreio = url.ler().trim();
            }
            if (o.notificar) corpoReq.notificar_cliente = notificar.ler();
            if (o.reporEstoque) corpoReq.repor_estoque = repor.ler();
            const texto = notaStatus.ler().trim();
            if (texto) corpoReq.nota = texto;
            const r = await api.chamarApi('/api/admin/pedido-status', { corpo: corpoReq, sinal: ctx.sinal });
            if (r.erro === 'cancelado') return null;
            if (!r.ok) {
              const alvo = { codigo_rastreio: codigo, url_rastreio: url, nota: notaStatus }[r.campo];
              if (alvo) {
                alvo.definirErro(r.mensagem);
                alvo.entrada.focus();
                return false;
              }
              throw new Error(r.mensagem);
            }
            return r;
          },
        },
      ],
    });
    controle.resultado.then(async (r) => {
      if (!r || !ctx.ativo()) return;
      let mensagem = r.mudou === false && r.status_novo === r.status_anterior
        ? 'Pedido atualizado.'
        : `Situação alterada para "${rotuloStatusPedido(r.status_novo)}".`;
      if (r.email_enviado === true) mensagem += ' A cliente foi avisada por e-mail.';
      if (r.email_enviado === false) mensagem += ' O e-mail para a cliente não foi enviado (confira a configuração de e-mail).';
      if (r.estoque_reposto) mensagem += ' Os produtos voltaram ao estoque.';
      ui.toast(mensagem, r.email_enviado === false ? 'aviso' : 'sucesso');
      ctx.atualizarContadores();
      await recarregar({ silencioso: true });
    });
  }

  async function adicionarNota() {
    const texto = nota.ler().trim();
    if (!texto) {
      nota.definirErro('Escreva a nota antes de adicionar.');
      nota.entrada.focus();
      return;
    }
    await ui.ocupado(botaoNota, async () => {
      const r = await api.consultar(supabase.from('pedido_eventos').insert({
        pedido_id: pedido.id, tipo: 'nota', descricao: texto, autor: ctx.usuario.email || 'equipe',
      }));
      if (!ctx.ativo()) return;
      if (!r.ok) {
        ui.toast(r.mensagem, 'erro');
        return;
      }
      nota.entrada.value = '';
      ctx.marcarAlterado(false);
      ui.toast('Nota adicionada.', 'sucesso');
      await recarregar({ silencioso: true });
    });
  }

  async function apagarNota(evento) {
    const sim = await ui.confirmar(`Apagar a nota "${String(evento.descricao).slice(0, 120)}"?`, {
      perigo: true, titulo: 'Apagar nota?', textoConfirmar: 'Apagar nota',
    });
    if (!sim || !ctx.ativo()) return;
    const r = await api.consultar(supabase.from('pedido_eventos').delete().eq('id', evento.id).eq('tipo', 'nota'));
    if (!ctx.ativo()) return;
    if (!r.ok) {
      ui.toast(r.mensagem, 'erro');
      return;
    }
    ui.toast('Nota apagada.', 'sucesso');
    await recarregar({ silencioso: true });
  }

  async function apagarPedido() {
    const avisoPagamento = pedido.status === 'aguardando_pagamento'
      ? ' Se a cliente ainda pagar este pedido, o pagamento não vai aparecer no painel.' : '';
    const sim = await ui.confirmar(`Apagar o pedido ${ui.formatarNumeroPedido(pedido.numero)} de ${pedido.cliente_nome}? Ele some do painel para sempre.${avisoPagamento}`, {
      perigo: true, titulo: 'Apagar pedido?', textoConfirmar: 'Apagar pedido',
    });
    if (!sim || !ctx.ativo()) return;
    const r = await api.consultar(supabase.from('pedidos').delete().eq('id', pedido.id).select('id'));
    if (!ctx.ativo()) return;
    if (!r.ok) {
      ui.toast(r.mensagem, 'erro');
      return;
    }
    if (!r.dados || !r.dados.length) {
      ui.toast('O pedido não foi apagado (talvez já não exista). A página foi atualizada.', 'aviso');
      await recarregar({ silencioso: true });
      return;
    }
    ui.toast(`Pedido ${ui.formatarNumeroPedido(pedido.numero)} apagado.`, 'sucesso');
    ctx.marcarAlterado(false);
    ctx.atualizarContadores();
    ctx.navegar('#/pedidos', { substituir: true });
  }

  function desenhar() {
    if (!montado) return;
    desenharCabecalho();
    desenharProxima();
    desenharItens();
    desenharEnvio();
    desenharSituacao();
    desenharPagamento();
    desenharCliente();
    desenharEntrega();
    desenharMais();
    desenharEventos();
  }

  async function recarregar({ silencioso = true, botao = null } = {}) {
    if (carregando) return;
    carregando = true;
    try {
      const { rp: r1, re: r2 } = botao ? (await ui.ocupado(botao, buscarDados)) || {} : await buscarDados();
      if (!ctx.ativo() || !r1) return;
      if (!r1.ok) {
        if (!silencioso) ui.toast(r1.mensagem, 'erro');
        else ui.toast(`Não foi possível atualizar o pedido: ${r1.mensagem}`, 'erro');
        return;
      }
      if (!r1.dados) {
        ui.toast('Este pedido não existe mais.', 'aviso');
        ctx.marcarAlterado(false);
        ctx.navegar('#/pedidos', { substituir: true });
        return;
      }
      pedido = r1.dados;
      if (r2.ok) eventos = r2.dados || [];
      desenhar();
    } finally {
      carregando = false;
    }
  }

  desenhar();

  const aoVoltar = () => {
    if (document.visibilityState === 'visible') recarregar({ silencioso: true });
  };
  document.addEventListener('visibilitychange', aoVoltar);

  return () => {
    document.removeEventListener('visibilitychange', aoVoltar);
  };
}
