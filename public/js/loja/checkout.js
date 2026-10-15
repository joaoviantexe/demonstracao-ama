// Checkout /loja/checkout — dados, entrega (CEP com ViaCEP), frete, observações e resumo.
// "Ir para o pagamento" → POST /api/loja/checkout → Mercado Pago (window.location = redirecionar).
// O navegador só envia produto, quantidade, frete escolhido e dados do cliente: valores
// cobrados são sempre calculados no servidor.

import { cotar, finalizar } from './api.js';
import {
  EVENTO, guardarPedido, itensParaCotacao, lerCarrinho, lerPreferencias, salvarPreferencias,
  sincronizarComCotacao,
} from './carrinho.js';
import { lojaConfigurada } from './config.js';
import {
  aplicarMascara, blocoEstado, el, icone, iniciarPagina, trocarConteudo,
} from './comum.js';
import {
  descreverMotivo, formatarPreco, formatarPrazo, mascararCep, mascararCpf, mascararTelefone,
  normalizarTexto, somenteDigitos, UFS, urlSegura, validarCep, validarFormularioCheckout, validarUf,
} from './formatos.js';
import {
  avisoFreteGratis, blocoTotais, listaOpcoesFrete, opcaoEscolhida, totalExibido,
} from './resumo.js';

iniciarPagina();

const form = document.getElementById('form-checkout');
const areaEstado = document.getElementById('checkout-estado');
const alerta = document.getElementById('alerta-checkout');
const opcoesFrete = document.getElementById('opcoes-frete');
const erroFrete = document.getElementById('erro-frete');
const enderecoCampos = document.getElementById('endereco-campos');
const retiradaInfo = document.getElementById('retirada-info');
const avisoCep = document.getElementById('aviso-cep');
const cepCarregando = document.getElementById('cep-carregando');
const resumoConteudo = document.getElementById('resumo-conteudo');
const resumo = document.getElementById('resumo');
const contadorObs = document.getElementById('contador-observacoes');

const IDS = ['nome', 'email', 'telefone', 'cpf', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf', 'observacoes'];
const campo = Object.fromEntries(IDS.map((id) => [id, document.getElementById(id)]));

// Chave do servidor → id do campo (na ordem em que aparecem na página).
const CAMPOS_ERRO = [
  ['cliente.nome', 'nome'], ['cliente.email', 'email'], ['cliente.telefone', 'telefone'], ['cliente.cpf', 'cpf'],
  ['endereco.cep', 'cep'], ['frete_id', 'frete'], ['endereco.logradouro', 'logradouro'], ['endereco.numero', 'numero'],
  ['endereco.complemento', 'complemento'], ['endereco.bairro', 'bairro'], ['endereco.cidade', 'cidade'], ['endereco.uf', 'uf'],
];

const prefs = lerPreferencias();
const estado = {
  itens: lerCarrinho(),
  cotacao: null,
  carregando: false,
  sequencia: 0,
  freteId: prefs.frete_id,
  cepCotado: '',
  cepBuscado: '',
  erroCotacao: null,
  enviando: false,
  tocados: new Set(),
};

// ---------------------------------------------------------------------------
// Rascunho do formulário na sessão (sem o CPF), para quem volta do pagamento.

const CHAVE_RASCUNHO = 'ama_checkout_rascunho_v1';
const CAMPOS_RASCUNHO = ['nome', 'email', 'telefone', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf', 'observacoes'];

function restaurarRascunho() {
  let dados = null;
  try {
    dados = JSON.parse(sessionStorage.getItem(CHAVE_RASCUNHO) || 'null');
  } catch {
    dados = null;
  }
  if (dados && typeof dados === 'object') {
    for (const id of CAMPOS_RASCUNHO) {
      if (typeof dados[id] === 'string' && !campo[id].value) campo[id].value = dados[id].slice(0, 500);
    }
  }
  if (!campo.cep.value && prefs.cep) campo.cep.value = prefs.cep;
}

let esperaRascunho = null;
function salvarRascunho() {
  clearTimeout(esperaRascunho);
  esperaRascunho = setTimeout(() => {
    try {
      const dados = Object.fromEntries(CAMPOS_RASCUNHO.map((id) => [id, campo[id].value]));
      sessionStorage.setItem(CHAVE_RASCUNHO, JSON.stringify(dados));
    } catch {
      // sem sessionStorage: segue sem rascunho
    }
  }, 300);
}

// ---------------------------------------------------------------------------
// Erros por campo

function elementoErro(id) {
  return document.getElementById(`erro-${id}`);
}

function mostrarErroCampo(id, mensagem) {
  const erro = elementoErro(id);
  const entrada = id === 'frete' ? null : campo[id];
  if (erro) {
    erro.textContent = mensagem || '';
    erro.hidden = !mensagem;
  }
  if (entrada) {
    if (mensagem) entrada.setAttribute('aria-invalid', 'true');
    else entrada.removeAttribute('aria-invalid');
    entrada.closest('.campo')?.classList.toggle('campo--erro', !!mensagem);
  }
}

function limparErros() {
  for (const [, id] of CAMPOS_ERRO) mostrarErroCampo(id, '');
}

function alvoDoErro(id) {
  if (id === 'frete') return opcoesFrete.querySelector('input[type="radio"]') || campo.cep;
  return campo[id];
}

/** Mostra os erros (chaves do servidor) e leva o foco ao primeiro. Devolve quantos mostrou. */
function mostrarErros(erros) {
  let primeiro = null;
  let total = 0;
  for (const [chave, id] of CAMPOS_ERRO) {
    const mensagem = erros[chave];
    mostrarErroCampo(id, mensagem || '');
    if (mensagem) {
      total += 1;
      if (!primeiro) primeiro = alvoDoErro(id);
    }
  }
  if (primeiro && !primeiro.disabled) {
    primeiro.focus({ preventScroll: true });
    primeiro.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  return total;
}

function opcaoAtual() {
  return opcaoEscolhida(estado.cotacao, estado.freteId);
}

function ehRetirada() {
  const opcao = opcaoAtual();
  return !!(opcao && opcao.tipo === 'retirada');
}

function coletarDados() {
  const retirada = ehRetirada();
  return {
    cliente: {
      nome: campo.nome.value,
      email: campo.email.value,
      telefone: somenteDigitos(campo.telefone.value),
      cpf: somenteDigitos(campo.cpf.value),
    },
    endereco: retirada ? {} : {
      cep: somenteDigitos(campo.cep.value),
      logradouro: campo.logradouro.value,
      numero: campo.numero.value,
      complemento: campo.complemento.value,
      bairro: campo.bairro.value,
      cidade: campo.cidade.value,
      uf: campo.uf.value,
    },
    frete_id: estado.freteId && opcaoAtual() ? estado.freteId : '',
    observacoes: campo.observacoes.value,
  };
}

/** Revalida só um campo (depois que a pessoa já passou por ele). */
function validarCampo(id) {
  if (!estado.tocados.has(id)) return;
  const { erros } = validarFormularioCheckout(coletarDados());
  const chave = (CAMPOS_ERRO.find(([, i]) => i === id) || [])[0];
  if (chave) mostrarErroCampo(id, erros[chave] || '');
}

// ---------------------------------------------------------------------------
// Alerta no topo do formulário

function mostrarAlerta(tipo, ...conteudo) {
  alerta.className = `alerta-checkout alerta-checkout--${tipo}`;
  alerta.setAttribute('role', 'alert');
  trocarConteudo(alerta, ...conteudo);
  alerta.hidden = false;
  alerta.focus({ preventScroll: true });
  alerta.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function esconderAlerta() {
  alerta.hidden = true;
  alerta.removeAttribute('role');
  trocarConteudo(alerta);
}

// ---------------------------------------------------------------------------
// Entrega: opções de frete e retirada

function aplicarTipoEntrega() {
  const opcao = opcaoAtual();
  const retirada = !!(opcao && opcao.tipo === 'retirada');
  enderecoCampos.hidden = retirada;
  enderecoCampos.querySelectorAll('input, select').forEach((entrada) => { entrada.disabled = retirada; });
  retiradaInfo.hidden = !retirada;
  if (retirada) {
    trocarConteudo(retiradaInfo,
      el('span', { class: 'retirada-icone' }, icone('local')),
      el('div', {},
        el('strong', { texto: opcao.nome }),
        el('p', { texto: formatarPrazo(opcao) || 'Disponível após a confirmação do pagamento.' }),
        el('p', { class: 'retirada-nota', texto: 'Não precisa informar endereço. Depois do pagamento, acompanhe pela página do pedido quando ele estiver pronto para retirada.' })));
  }
}

function renderizarOpcoesFrete() {
  const c = estado.cotacao;
  const opcoes = c && c.frete && Array.isArray(c.frete.opcoes) ? c.frete.opcoes : [];
  const cepValido = validarCep(somenteDigitos(campo.cep.value));
  if (estado.carregando && cepValido && (!c || estado.cepCotado !== somenteDigitos(campo.cep.value))) {
    trocarConteudo(opcoesFrete,
      el('span', { class: 'esqueleto esqueleto-opcao' }), el('span', { class: 'esqueleto esqueleto-opcao' }));
    opcoesFrete.setAttribute('aria-busy', 'true');
    return;
  }
  opcoesFrete.setAttribute('aria-busy', 'false');
  if (!opcoes.length) {
    trocarConteudo(opcoesFrete,
      el('p', { class: 'opcoes-frete-vazio' }, icone('caminhao'),
        c && c.frete && c.frete.erro ? c.frete.erro : 'Informe o CEP para ver as opções de entrega e o prazo.'));
    aplicarTipoEntrega();
    return;
  }
  trocarConteudo(opcoesFrete,
    listaOpcoesFrete(opcoes, estado.freteId, (id) => {
      estado.freteId = id;
      salvarPreferencias({ frete_id: id });
      mostrarErroCampo('frete', '');
      renderizarOpcoesFrete();
      renderizarResumo();
      opcoesFrete.querySelector(`input[value="${CSS.escape(id)}"]`)?.focus();
    }, { nome: 'frete' }),
    c.frete.erro ? el('p', { class: 'frete-aviso', texto: c.frete.erro }) : null);
  aplicarTipoEntrega();
}

// ---------------------------------------------------------------------------
// Resumo

const botaoPagar = el('button', { type: 'submit', class: 'botao botao--ouro botao--bloco resumo-finalizar', id: 'botao-pagar' },
  icone('cadeado'), el('span', { class: 'botao-texto', texto: 'Ir para o pagamento' }));
const notaPagamento = el('p', { class: 'resumo-seguro' }, icone('escudo'),
  'Na próxima etapa você paga com Pix, cartão ou boleto, em ambiente seguro.');
const motivoBloqueio = el('p', { class: 'resumo-bloqueio', hidden: true });
resumo.append(motivoBloqueio, botaoPagar, notaPagamento);

function itemResumo(item, cotado) {
  const nome = (cotado && cotado.nome) || item.nome || 'Produto';
  const imagem = (cotado && cotado.imagem) || item.imagem;
  const indisponivel = cotado && cotado.disponivel === false;
  return el('li', { class: `resumo-item${indisponivel ? ' resumo-item--indisponivel' : ''}` },
    el('span', { class: 'resumo-item-foto', 'data-quadro-foto': true },
      imagem ? el('img', { src: imagem, alt: '', loading: 'lazy', decoding: 'async' }) : icone('folha'),
      el('span', { class: 'resumo-item-qtd', 'aria-hidden': 'true', texto: String(item.quantidade) })),
    el('span', { class: 'resumo-item-info' },
      el('span', { class: 'resumo-item-nome', texto: nome }),
      el('span', { class: 'resumo-item-detalhe', texto: indisponivel
        ? descreverMotivo(cotado.motivo, cotado.estoque_disponivel)
        : `${item.quantidade} × ${formatarPreco(cotado ? cotado.preco_unitario_centavos : item.preco_centavos)}` })),
    el('span', { class: 'resumo-item-total', texto: cotado ? (cotado.disponivel ? formatarPreco(cotado.total_centavos) : '—') : '' }));
}

function renderizarResumo() {
  const c = estado.cotacao;
  const porId = new Map((c && Array.isArray(c.itens) ? c.itens : []).map((i) => [i.produto_id, i]));
  const itens = el('ul', { class: 'resumo-itens' }, estado.itens.map((item) => itemResumo(item, porId.get(item.produto_id))));
  let totais;
  if (c) {
    totais = blocoTotais(c, opcaoAtual(), { semFreteTexto: 'Informe o CEP', atualizando: estado.carregando });
  } else if (estado.erroCotacao) {
    totais = el('div', { class: 'resumo-erro' }, icone('alerta'),
      el('p', { texto: estado.erroCotacao.mensagem || 'Não foi possível calcular o pedido.' }),
      el('button', { type: 'button', class: 'botao botao--fantasma botao--sm', onclick: () => cotarAgora() }, 'Tentar novamente'));
  } else {
    totais = el('div', { class: 'totais-esqueleto', 'aria-hidden': 'true' },
      el('span', { class: 'esqueleto esqueleto-linha' }), el('span', { class: 'esqueleto esqueleto-linha' }),
      el('span', { class: 'esqueleto esqueleto-linha esqueleto-linha--media' }));
  }
  trocarConteudo(resumoConteudo,
    itens,
    el('a', { class: 'link-seta resumo-editar', href: '/loja/carrinho' }, 'Editar carrinho'),
    avisoFreteGratis(c),
    totais);

  const indisponivel = c ? c.itens.some((i) => i.disponivel === false) : false;
  motivoBloqueio.hidden = !indisponivel;
  motivoBloqueio.textContent = indisponivel ? 'Há itens indisponíveis. Volte ao carrinho para ajustar.' : '';
  if (!estado.enviando) botaoPagar.disabled = indisponivel;
}

// ---------------------------------------------------------------------------
// Cotação

let esperaCotacao = null;

async function cotarAgora() {
  clearTimeout(esperaCotacao);
  const sequencia = ++estado.sequencia;
  const cep = somenteDigitos(campo.cep.value);
  const cepValido = validarCep(cep);
  estado.carregando = true;
  renderizarOpcoesFrete();
  renderizarResumo();
  try {
    const cotacao = await cotar({ itens: itensParaCotacao(estado.itens), cep: cepValido ? cep : undefined });
    if (sequencia !== estado.sequencia) return;
    estado.cotacao = cotacao;
    estado.erroCotacao = null;
    estado.cepCotado = cepValido ? cep : '';
    if (cepValido) salvarPreferencias({ cep });
    const opcoes = cotacao.frete && Array.isArray(cotacao.frete.opcoes) ? cotacao.frete.opcoes : [];
    if (opcoes.length && !opcoes.some((o) => o.id === estado.freteId)) {
      estado.freteId = opcoes[0].id;
      salvarPreferencias({ frete_id: estado.freteId });
    }
    estado.itens = sincronizarComCotacao(cotacao.itens);
    const indisponiveis = cotacao.itens.filter((i) => i.disponivel === false);
    if (indisponiveis.length) avisarIndisponiveis();
  } catch (erro) {
    if (sequencia !== estado.sequencia) return;
    estado.erroCotacao = erro;
    if (erro.erro === 'carrinho_vazio') {
      renderizarVazio();
      return;
    }
  } finally {
    if (sequencia === estado.sequencia) {
      estado.carregando = false;
      renderizarOpcoesFrete();
      renderizarResumo();
    }
  }
}

function avisarIndisponiveis() {
  mostrarAlerta('aviso',
    icone('alerta'),
    el('div', {},
      el('strong', { texto: 'Alguns itens mudaram' }),
      el('p', { texto: 'Um ou mais produtos ficaram indisponíveis ou mudaram de estoque. Confira o carrinho antes de pagar.' }),
      el('a', { class: 'botao botao--principal botao--sm', href: '/loja/carrinho' }, 'Revisar carrinho')));
}

// ---------------------------------------------------------------------------
// CEP: ViaCEP + nova cotação

async function buscarViaCep(cep) {
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), 6000);
  try {
    const resposta = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: controle.signal, headers: { Accept: 'application/json' } });
    if (!resposta.ok) return { erro: 'falha' };
    const dados = await resposta.json();
    if (!dados || typeof dados !== 'object' || dados.erro === true || dados.erro === 'true') return { erro: 'nao_encontrado' };
    return {
      logradouro: normalizarTexto(dados.logradouro, 200),
      bairro: normalizarTexto(dados.bairro, 100),
      cidade: normalizarTexto(dados.localidade, 100),
      uf: validarUf(dados.uf) ? dados.uf.trim().toUpperCase() : '',
    };
  } catch {
    return { erro: 'falha' };
  } finally {
    clearTimeout(timer);
  }
}

function mostrarAvisoCep(tipo, texto) {
  avisoCep.className = `aviso-cep aviso-cep--${tipo}`;
  avisoCep.textContent = texto;
  avisoCep.hidden = !texto;
}

async function aoMudarCep({ forcar = false } = {}) {
  const cep = somenteDigitos(campo.cep.value);
  if (!validarCep(cep)) return;
  if (!forcar && cep === estado.cepBuscado) return;
  estado.cepBuscado = cep;
  mostrarErroCampo('cep', '');
  cotarAgora();
  cepCarregando.hidden = false;
  const endereco = await buscarViaCep(cep);
  cepCarregando.hidden = true;
  if (somenteDigitos(campo.cep.value) !== cep) return;
  if (endereco.erro === 'nao_encontrado') {
    mostrarAvisoCep('erro', 'Não encontramos este CEP. Confira o número ou preencha o endereço abaixo.');
    return;
  }
  if (endereco.erro) {
    mostrarAvisoCep('info', 'Não foi possível buscar o endereço automaticamente. Preencha os campos abaixo.');
    return;
  }
  for (const id of ['logradouro', 'bairro', 'cidade', 'uf']) {
    if (endereco[id]) {
      campo[id].value = endereco[id];
      mostrarErroCampo(id, '');
    }
  }
  mostrarAvisoCep('ok', endereco.logradouro
    ? 'Endereço encontrado. Confira e informe o número.'
    : 'Cidade encontrada. Informe a rua, o número e o bairro.');
  salvarRascunho();
  if (!enderecoCampos.hidden) {
    const proximo = endereco.logradouro ? campo.numero : campo.logradouro;
    if (document.activeElement === campo.cep || document.activeElement === document.body) proximo.focus();
  }
}

// ---------------------------------------------------------------------------
// Envio

function definirEnviando(enviando) {
  estado.enviando = enviando;
  botaoPagar.disabled = enviando;
  botaoPagar.classList.toggle('botao--carregando', enviando);
  botaoPagar.querySelector('.botao-texto').textContent = enviando ? 'Indo para o pagamento…' : 'Ir para o pagamento';
  form.setAttribute('aria-busy', enviando ? 'true' : 'false');
}

function tratarErroEnvio(erro, dados) {
  const extra = erro.dados || {};
  if (erro.status === 503 && erro.erro === 'pagamento_indisponivel') {
    mostrarAlerta('config',
      icone('cartao'),
      el('div', {},
        el('strong', { texto: 'Pagamento online em configuração' }),
        el('p', { texto: 'O pagamento pelo site ainda está sendo configurado pela AMA. Tente novamente mais tarde: seu carrinho fica guardado neste aparelho.' })));
    return;
  }
  if (erro.status === 409 && erro.erro === 'item_indisponivel') {
    if (Array.isArray(extra.itens) && estado.cotacao) {
      estado.cotacao = { ...estado.cotacao, itens: extra.itens };
      estado.itens = sincronizarComCotacao(extra.itens);
    }
    renderizarResumo();
    mostrarAlerta('aviso', icone('alerta'),
      el('div', {},
        el('strong', { texto: 'Seu carrinho mudou' }),
        el('p', { texto: erro.mensagem }),
        el('a', { class: 'botao botao--principal botao--sm', href: '/loja/carrinho' }, 'Revisar carrinho')));
    cotarAgora();
    return;
  }
  if (erro.status === 409 && erro.erro === 'frete_indisponivel') {
    if (extra.frete && Array.isArray(extra.frete.opcoes) && estado.cotacao) {
      estado.cotacao = { ...estado.cotacao, frete: extra.frete };
    }
    estado.freteId = '';
    salvarPreferencias({ frete_id: '' });
    renderizarOpcoesFrete();
    renderizarResumo();
    mostrarAlerta('aviso', icone('caminhao'), el('div', {}, el('strong', { texto: 'Escolha outra entrega' }), el('p', { texto: erro.mensagem })));
    mostrarErroCampo('frete', 'Escolha uma opção de entrega.');
    cotarAgora();
    return;
  }
  if (erro.status === 400 && extra.erros && typeof extra.erros === 'object') {
    const total = mostrarErros(extra.erros);
    if (total) return;
  }
  if (erro.erro === 'carrinho_vazio') {
    renderizarVazio();
    return;
  }
  mostrarAlerta('erro', icone('alerta'),
    el('div', {},
      el('strong', { texto: 'Não foi possível ir para o pagamento' }),
      el('p', { texto: erro.mensagem || 'Tente novamente em instantes. Nenhuma cobrança foi feita.' }),
      el('div', { class: 'alerta-acoes' },
        el('button', { type: 'button', class: 'botao botao--principal botao--sm', onclick: () => form.requestSubmit(botaoPagar) }, 'Tentar novamente'))));
}

form.addEventListener('submit', async (evento) => {
  evento.preventDefault();
  if (estado.enviando) return;
  esconderAlerta();
  CAMPOS_ERRO.forEach(([, id]) => estado.tocados.add(id));
  const dados = coletarDados();
  const { ok, erros } = validarFormularioCheckout(dados);
  if (!ok) {
    mostrarErros(erros);
    return;
  }
  limparErros();
  if (!estado.cotacao || estado.carregando) {
    mostrarAlerta('aviso', icone('relogio'), el('p', { texto: 'Aguarde: ainda estamos calculando o seu pedido.' }));
    if (!estado.carregando) cotarAgora();
    return;
  }
  if (estado.cotacao.itens.some((i) => i.disponivel === false)) {
    avisarIndisponiveis();
    return;
  }

  definirEnviando(true);
  try {
    const resposta = await finalizar({
      itens: itensParaCotacao(estado.itens),
      frete_id: dados.frete_id,
      cliente: dados.cliente,
      endereco: dados.endereco,
      observacoes: normalizarTexto(dados.observacoes, 500, { multilinha: true }) || undefined,
    });
    const destino = urlSegura(resposta.redirecionar, { permitirRelativa: false });
    const pedido = resposta.pedido || {};
    guardarPedido({ id: pedido.id, token: pedido.token, numero: pedido.numero, criado_em: new Date().toISOString() });
    if (!destino) {
      // Sem link de pagamento: mostra o pedido, que tem o botão "Pagar agora" quando possível.
      location.assign(`/loja/pedido?id=${encodeURIComponent(pedido.id || '')}&token=${encodeURIComponent(pedido.token || '')}`);
      return;
    }
    location.assign(destino);
  } catch (erro) {
    definirEnviando(false);
    tratarErroEnvio(erro, dados);
  }
});

// ---------------------------------------------------------------------------
// Estados da página e início

function renderizarVazio() {
  form.hidden = true;
  trocarConteudo(areaEstado, blocoEstado({
    icone: 'carrinho',
    titulo: 'Seu carrinho está vazio',
    texto: 'Escolha seus produtos na loja para finalizar a compra.',
    acoes: [el('a', { class: 'botao botao--principal', href: '/loja/' }, 'Conhecer a loja', icone('seta'))],
  }));
}

function renderizarNaoConfigurada() {
  form.hidden = true;
  trocarConteudo(areaEstado, blocoEstado({
    icone: 'folha',
    titulo: 'Loja em configuração',
    texto: 'A compra pelo site ainda não está disponível. Volte em breve.',
    acoes: [el('a', { class: 'botao botao--principal', href: '/loja/' }, 'Ver os produtos')],
  }));
}

function iniciarFormulario() {
  campo.uf.append(...UFS.map((uf) => el('option', { value: uf, texto: uf })));
  restaurarRascunho();
  aplicarMascara(campo.telefone, mascararTelefone);
  aplicarMascara(campo.cpf, mascararCpf);
  aplicarMascara(campo.cep, mascararCep);

  for (const id of IDS) {
    const entrada = campo[id];
    entrada.addEventListener('blur', () => {
      if (entrada.value.trim()) estado.tocados.add(id);
      validarCampo(id);
    });
    entrada.addEventListener('input', () => {
      if (entrada.getAttribute('aria-invalid') === 'true') validarCampo(id);
      salvarRascunho();
    });
  }
  campo.uf.addEventListener('change', () => {
    estado.tocados.add('uf');
    validarCampo('uf');
  });
  campo.cep.addEventListener('input', () => {
    const cep = somenteDigitos(campo.cep.value);
    if (cep.length === 8) aoMudarCep();
    else mostrarAvisoCep('info', '');
  });
  campo.cep.addEventListener('blur', () => {
    const cep = somenteDigitos(campo.cep.value);
    if (cep && !validarCep(cep)) mostrarErroCampo('cep', 'Informe um CEP válido (8 dígitos).');
  });
  const atualizarContador = () => {
    contadorObs.textContent = `${campo.observacoes.value.length}/500`;
  };
  campo.observacoes.addEventListener('input', atualizarContador);
  atualizarContador();

  form.hidden = false;
  renderizarOpcoesFrete();
  renderizarResumo();
  const cep = somenteDigitos(campo.cep.value);
  if (validarCep(cep)) {
    estado.cepBuscado = cep;
    // Endereço salvo do rascunho: só completa o que faltar.
    if (!campo.cidade.value) aoMudarCep({ forcar: true });
    else cotarAgora();
  } else {
    cotarAgora();
  }
}

window.addEventListener(EVENTO, () => {
  if (estado.enviando) return;
  const itens = lerCarrinho();
  const antes = estado.itens.map((i) => `${i.produto_id}:${i.quantidade}`).join('|');
  const depois = itens.map((i) => `${i.produto_id}:${i.quantidade}`).join('|');
  estado.itens = itens;
  if (antes === depois) return;
  if (!itens.length) {
    renderizarVazio();
    return;
  }
  clearTimeout(esperaCotacao);
  esperaCotacao = setTimeout(() => cotarAgora(), 300);
});

// Voltar do Mercado Pago pelo botão "voltar" do navegador: reabilita o botão.
window.addEventListener('pageshow', (evento) => {
  if (evento.persisted && estado.enviando) definirEnviando(false);
});

if (!lojaConfigurada()) renderizarNaoConfigurada();
else if (!estado.itens.length) renderizarVazio();
else iniciarFormulario();
