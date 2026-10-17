// Pagamento no próprio site (Checkout Transparente, docs/ARQUITETURA.md §6.7), na página do pedido.
// - Pix e boleto: gerados no servidor (POST /api/loja/pagamento); o Pix mostra o QR e o copia e cola.
// - Cartão: MercadoPago.js (https://sdk.mercadopago.com/js/v2) com os campos seguros em iframe. O número,
//   a validade e o código do cartão nunca passam pela loja: o navegador manda só o token gerado pelo SDK.
// montarPagamento devolve { elemento, estado(), ocupado(), destruir() }; aoPagar(pagamento) é chamado quando o
// pagamento foi criado (aprovado, em análise ou Pix/boleto gerado) para a página recarregar o pedido;
// aoPagar(null) quando o pedido mudou por outro caminho (409: já pago, em análise ou cancelado).
// estado() = { metodo, erro } é passado como `inicial` quando a página redesenha, para não perder a aba e o aviso.

import { pagar } from './api.js';
import { chavePublicaPagamento } from './config.js';
import { el, icone, trocarConteudo } from './comum.js';
import { formatarData, formatarPreco, somenteDigitos } from './formatos.js';

const SDK_URL = 'https://sdk.mercadopago.com/js/v2';
const ROTULOS = { pix: 'Pix', cartao: 'Cartão', boleto: 'Boleto' };
const ICONES = { pix: 'pix', cartao: 'cartao', boleto: 'boleto' };
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

let promessaSdk = null;

/** Carrega o MercadoPago.js uma vez por página. */
export function carregarSdk() {
  if (globalThis.MercadoPago) return Promise.resolve(globalThis.MercadoPago);
  if (!promessaSdk) {
    promessaSdk = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = SDK_URL;
      script.async = true;
      const falhar = () => {
        promessaSdk = null;
        script.remove();
        reject(new Error('sdk'));
      };
      script.onload = () => (globalThis.MercadoPago ? resolve(globalThis.MercadoPago) : falhar());
      script.onerror = falhar;
      document.head.append(script);
    });
  }
  return promessaSdk;
}

/** UUID novo a cada tentativa (X-Idempotency-Key no servidor). randomUUID só existe em https/localhost. */
function novaChave() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const dispositivo = () => (typeof globalThis.MP_DEVICE_SESSION_ID === 'string' ? globalThis.MP_DEVICE_SESSION_ID : undefined);

/** Erros do MercadoPago.js (mensagens em inglês, por campo) → uma frase em português. */
export function mensagemDoCartao(erros) {
  const lista = Array.isArray(erros) ? erros : [erros];
  const texto = lista.map((e) => `${e && e.field ? e.field : ''} ${e && (e.message || e.cause) ? e.message || e.cause : ''}`).join(' ');
  if (/cardNumber|card_number|E301/i.test(texto)) return 'Confira o número do cartão.';
  if (/expiration|E30[56]|E208|E209/i.test(texto)) return 'Confira a validade do cartão.';
  if (/securityCode|security_code|E302|E224|E225/i.test(texto)) return 'Confira o código de segurança do cartão.';
  if (/cardholderName|cardholder\.name|E221|E316/i.test(texto)) return 'Escreva o nome como está no cartão.';
  if (/identification|E214|E324/i.test(texto)) return 'Confira o CPF do titular do cartão.';
  return 'Confira os dados do cartão.';
}

function botaoCopiar(valor, rotulo) {
  const texto = el('span', { texto: rotulo });
  const botao = el('button', { type: 'button', class: 'botao botao--fantasma botao--sm copia-botao' }, icone('copiar'), texto);
  botao.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(valor);
      texto.textContent = 'Copiado!';
    } catch {
      botao.previousElementSibling?.select?.();
      texto.textContent = 'Selecionado';
    }
    setTimeout(() => { texto.textContent = rotulo; }, 2500);
  });
  return botao;
}

function campoCopia(id, rotulo, valor) {
  const entrada = el('input', { id, type: 'text', readonly: true, value: valor, spellcheck: 'false', autocomplete: 'off' });
  entrada.addEventListener('focus', () => entrada.select());
  return el('div', { class: 'copia' },
    el('label', { for: id, class: 'copia-rotulo', texto: rotulo }),
    el('div', { class: 'copia-linha' }, entrada, botaoCopiar(valor, 'Copiar')));
}

function validade(expiraEm) {
  const quando = formatarData(expiraEm);
  return quando ? el('p', { class: 'pagamento-validade', texto: `Válido até ${quando}` }) : null;
}

const aguardando = () => el('p', { class: 'pagamento-aguardando', role: 'status' },
  el('span', { class: 'girando girando--escuro', 'aria-hidden': 'true' }), 'Aguardando o pagamento');

function blocoPix(pendente) {
  const imagem = pendente.pix.qr_code_base64 && BASE64.test(pendente.pix.qr_code_base64)
    ? el('img', { class: 'pix-qr', alt: 'QR Code do Pix', width: '200', height: '200' }) : null;
  // data: não passa pelo el() (que só aceita http/https): o base64 já foi conferido acima.
  if (imagem) imagem.src = `data:image/png;base64,${pendente.pix.qr_code_base64}`;
  return el('div', { class: 'pix' },
    imagem,
    el('div', { class: 'pix-info' },
      campoCopia('pix-copia-e-cola', 'Pix copia e cola', pendente.pix.qr_code),
      validade(pendente.expira_em),
      aguardando()));
}

function blocoBoleto(pendente) {
  const { url, linha_digitavel: linha } = pendente.boleto;
  return el('div', { class: 'boleto' },
    url ? el('a', { class: 'botao botao--principal', href: url, target: '_blank', rel: 'noopener' }, icone('boleto'), 'Abrir boleto') : null,
    linha ? campoCopia('boleto-linha', 'Linha digitável', linha) : null,
    validade(pendente.expira_em));
}

// Chave de idempotência por método: repetida enquanto a resposta não chega (rede, tempo esgotado, 5xx), para a
// nova tentativa devolver o mesmo pagamento em vez de cobrar de novo; trocada depois de qualquer resposta.
const chaves = {};

/**
 * Seção "Pagamento" da página do pedido.
 * { pedido (saída de /api/loja/pedido), id, token, aoPagar(pagamento), inicial?: { metodo, erro } }
 * → { elemento, estado(), ocupado(), destruir() }.
 */
export function montarPagamento({ pedido, id, token, aoPagar, inicial = {} }) {
  const info = pedido.pagamento;
  const pendente = info.pendente && (info.pendente.pix || info.pendente.boleto) ? info.pendente : null;
  const metodos = info.metodos.filter((m) => ROTULOS[m]);
  // Boleto gerado antes de o painel desligar o boleto: continua aparecendo até vencer.
  if (pendente && ROTULOS[pendente.metodo] && !metodos.includes(pendente.metodo)) metodos.push(pendente.metodo);
  let escolhido = metodos.includes(inicial.metodo) ? inicial.metodo : (pendente ? pendente.metodo : metodos[0]);
  let formularioCartao = null;
  let destruido = false;
  let enviandoAgora = false;
  const limpezas = [];

  const paineis = {};
  const erroGeral = el('p', { class: 'pagamento-erro', role: 'alert', hidden: true });

  function mostrarErro(mensagem) {
    erroGeral.textContent = mensagem || '';
    erroGeral.hidden = !mensagem;
  }

  async function enviar(metodo, extra, botao) {
    mostrarErro('');
    botao.disabled = true;
    botao.classList.add('botao--carregando');
    enviandoAgora = true;
    if (!chaves[metodo]) chaves[metodo] = novaChave();
    try {
      const { pagamento } = await pagar({ id, token, metodo, chave: chaves[metodo], dispositivo: dispositivo(), ...extra });
      delete chaves[metodo];
      if (destruido) return;
      if (pagamento.status === 'rejected') {
        mostrarErro(pagamento.mensagem || 'O pagamento foi recusado. Tente outra forma de pagamento.');
        // O Pix/boleto em aberto foi cancelado antes da tentativa: a página atualiza (mantendo aba e aviso).
        if (pendente) aoPagar(null);
        return;
      }
      aoPagar(pagamento);
    } catch (erro) {
      if (erro.status !== 0 && !(erro.status >= 500)) delete chaves[metodo];
      if (destruido) return;
      if (erro.status === 409) {
        aoPagar(null);
        return;
      }
      mostrarErro(erro.mensagem || 'Não foi possível concluir o pagamento. Tente de novo.');
    } finally {
      enviandoAgora = false;
      botao.disabled = false;
      botao.classList.remove('botao--carregando');
    }
  }

  function botaoGerar(metodo, texto) {
    const botao = el('button', { type: 'button', class: 'botao botao--ouro botao--bloco pagamento-gerar' },
      icone(ICONES[metodo]), el('span', { texto }));
    botao.addEventListener('click', () => enviar(metodo, {}, botao));
    return botao;
  }

  function painelPix() {
    if (pendente && pendente.metodo === 'pix') return blocoPix(pendente);
    return botaoGerar('pix', `Pagar ${formatarPreco(pedido.total_centavos)} com Pix`);
  }

  function painelBoleto() {
    if (pendente && pendente.metodo === 'boleto') return blocoBoleto(pendente);
    return botaoGerar('boleto', `Gerar boleto de ${formatarPreco(pedido.total_centavos)}`);
  }

  // --- cartão (MercadoPago.js cardForm)
  function painelCartao() {
    const area = el('div', { class: 'pagamento-cartao' },
      el('p', { class: 'pagamento-carregando', role: 'status' }, el('span', { class: 'girando girando--escuro', 'aria-hidden': 'true' }), 'Carregando…'));
    montarCartao(area);
    return area;
  }

  async function montarCartao(area) {
    const chave = chavePublicaPagamento();
    let MercadoPago = null;
    try {
      if (!chave) throw new Error('sem chave');
      MercadoPago = await carregarSdk();
    } catch {
      if (destruido) return;
      const tentar = el('button', { type: 'button', class: 'botao botao--fantasma botao--sm' }, 'Tentar de novo');
      tentar.addEventListener('click', () => {
        trocarConteudo(area, el('p', { class: 'pagamento-carregando', role: 'status' },
          el('span', { class: 'girando girando--escuro', 'aria-hidden': 'true' }), 'Carregando…'));
        montarCartao(area);
      });
      trocarConteudo(area, el('div', { class: 'pagamento-indisponivel' },
        el('p', { texto: 'O pagamento com cartão não carregou. Tente de novo ou pague com Pix.' }), chave ? tentar : null));
      return;
    }
    if (destruido) return;

    const campoIframe = (idCampo, rotulo, classe = '') => el('div', { class: `campo ${classe}`.trim() },
      el('span', { class: 'rotulo', id: `${idCampo}-rotulo`, texto: rotulo }),
      el('div', { class: 'campo-mp', id: idCampo, 'aria-labelledby': `${idCampo}-rotulo` }));
    const tipoDocumento = el('select', { id: 'mp-tipo-documento', hidden: true, 'aria-hidden': 'true', tabindex: '-1' });
    const documento = el('input', { id: 'mp-documento', type: 'text', inputmode: 'numeric', autocomplete: 'off', maxlength: '14', placeholder: '000.000.000-00' });
    documento.addEventListener('input', () => { documento.value = somenteDigitos(documento.value).slice(0, 14); });
    const emissor = el('select', { id: 'mp-emissor' });
    const campoEmissor = el('div', { class: 'campo', hidden: true }, el('label', { for: 'mp-emissor', texto: 'Banco emissor' }), emissor);
    const parcelas = el('select', { id: 'mp-parcelas' });
    const pagarBotao = el('button', { type: 'submit', class: 'botao botao--ouro botao--bloco pagamento-gerar' },
      icone('cadeado'), el('span', { texto: `Pagar ${formatarPreco(pedido.total_centavos)}` }));
    const form = el('form', { id: 'mp-form-cartao', class: 'pagamento-form', novalidate: true },
      el('div', { class: 'campos' },
        campoIframe('mp-numero', 'Número do cartão', 'campo--largo'),
        campoIframe('mp-validade', 'Validade'),
        campoIframe('mp-cvv', 'Código de segurança'),
        el('div', { class: 'campo campo--largo' },
          el('label', { for: 'mp-titular', texto: 'Nome impresso no cartão' }),
          el('input', { id: 'mp-titular', type: 'text', autocomplete: 'cc-name', maxlength: '80' })),
        el('div', { class: 'campo' }, el('label', { for: 'mp-documento', texto: 'CPF do titular' }), documento, tipoDocumento),
        el('div', { class: 'campo' }, el('label', { for: 'mp-parcelas', texto: 'Parcelas' }), parcelas),
        campoEmissor),
      pagarBotao);
    // Sem o MercadoPago.js montado, "Pagar" não pode recarregar a página (o SDK trata o envio por conta própria).
    form.addEventListener('submit', (evento) => evento.preventDefault());
    trocarConteudo(area, form);

    // Só as parcelas permitidas no painel (o MercadoPago.js lista todas as que o cartão aceita).
    const podar = () => {
      for (const opcao of [...parcelas.options]) {
        if (Number(opcao.value) > info.parcelas_max) opcao.remove();
      }
    };
    const observador = new MutationObserver(() => {
      podar();
      campoEmissor.hidden = emissor.options.length <= 1;
    });
    observador.observe(parcelas, { childList: true });
    observador.observe(emissor, { childList: true });
    limpezas.push(() => observador.disconnect());

    let enviando = false;
    const ocupar = (sim) => {
      pagarBotao.disabled = sim;
      pagarBotao.classList.toggle('botao--carregando', sim);
    };
    const estilo = { fontSize: '16px', color: '#1A2A1E', placeholderColor: '#8A938B' };
    try {
      const mp = new MercadoPago(chave, { locale: 'pt-BR' });
      formularioCartao = mp.cardForm({
        amount: String(pedido.total_centavos / 100),
        iframe: true,
        form: {
          id: 'mp-form-cartao',
          cardNumber: { id: 'mp-numero', placeholder: '0000 0000 0000 0000', style: estilo },
          expirationDate: { id: 'mp-validade', placeholder: 'MM/AA', style: estilo },
          securityCode: { id: 'mp-cvv', placeholder: 'CVV', style: estilo },
          cardholderName: { id: 'mp-titular' },
          issuer: { id: 'mp-emissor' },
          installments: { id: 'mp-parcelas' },
          identificationType: { id: 'mp-tipo-documento' },
          identificationNumber: { id: 'mp-documento' },
        },
        callbacks: {
          onFormMounted: (erro) => {
            if (erro && !destruido) mostrarErro('O pagamento com cartão não carregou. Recarregue a página ou pague com Pix.');
          },
          onInstallmentsReceived: () => { setTimeout(podar, 0); },
          onFetching: (recurso) => {
            if (recurso !== 'cardToken') return undefined;
            ocupar(true);
            return () => { if (!enviando) ocupar(false); };
          },
          onCardTokenReceived: (erro) => {
            if (erro && !destruido) {
              ocupar(false);
              mostrarErro(mensagemDoCartao(erro));
            }
          },
          onError: (erro) => {
            if (!destruido && !enviando) mostrarErro(mensagemDoCartao(erro));
          },
          onSubmit: async (evento) => {
            evento.preventDefault();
            if (enviando || destruido) return;
            const dados = formularioCartao.getCardFormData();
            if (!dados || !dados.token) {
              mostrarErro('Confira os dados do cartão.');
              ocupar(false);
              return;
            }
            enviando = true;
            try {
              await enviar('cartao', {
                cartao: {
                  token: dados.token,
                  payment_method_id: dados.paymentMethodId,
                  issuer_id: dados.issuerId,
                  parcelas: Number(dados.installments) || 1,
                  tipo_documento: dados.identificationType || 'CPF',
                  documento: dados.identificationNumber,
                },
              }, pagarBotao);
            } finally {
              enviando = false;
            }
          },
        },
      });
    } catch {
      mostrarErro('O pagamento com cartão não carregou. Recarregue a página ou pague com Pix.');
    }
  }

  // --- abas: cada painel é montado uma vez e só escondido (tirar do DOM recarregaria os iframes do cartão)
  const MONTAR = { pix: painelPix, cartao: painelCartao, boleto: painelBoleto };
  const conteudo = el('div', { class: 'pagamento-painel' });

  function mostrar(metodo) {
    escolhido = metodo;
    mostrarErro('');
    if (!paineis[metodo]) {
      paineis[metodo] = el('div', { class: 'pagamento-aba', dataset: { metodo } });
      conteudo.append(paineis[metodo]);
      paineis[metodo].append(MONTAR[metodo]());
    }
    for (const [nome, painel] of Object.entries(paineis)) painel.hidden = nome !== metodo;
  }

  const opcoes = el('div', { class: 'pagamento-metodos', role: 'radiogroup', 'aria-label': 'Forma de pagamento' },
    metodos.map((metodo) => {
      const entrada = el('input', { type: 'radio', name: 'metodo-pagamento', value: metodo, checked: metodo === escolhido });
      entrada.addEventListener('change', () => { if (entrada.checked) mostrar(metodo); });
      return el('label', { class: 'pagamento-metodo' }, entrada, icone(ICONES[metodo]), el('span', { texto: ROTULOS[metodo] }));
    }));

  const elemento = el('section', { class: 'cartao-pedido pagamento', id: 'pagamento', 'aria-labelledby': 'pagamento-titulo' },
    el('h2', { class: 'cartao-pedido-titulo', id: 'pagamento-titulo', tabindex: '-1', texto: 'Pagamento' }),
    opcoes, conteudo, erroGeral);
  mostrar(escolhido);
  if (inicial.erro) mostrarErro(inicial.erro);
  // O antifraude do Mercado Pago (device id) roda junto com o SDK: carrega já, sem esperar o cartão.
  if (chavePublicaPagamento()) carregarSdk().catch(() => {});

  return {
    elemento,
    estado: () => ({ metodo: escolhido, erro: erroGeral.hidden ? '' : erroGeral.textContent }),
    ocupado: () => enviandoAgora,
    destruir() {
      destruido = true;
      for (const limpar of limpezas.splice(0)) limpar();
      try {
        if (formularioCartao && typeof formularioCartao.unmount === 'function') formularioCartao.unmount();
      } catch {
        // já desmontado
      }
    },
  };
}
