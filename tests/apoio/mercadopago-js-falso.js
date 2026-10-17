/**
 * MercadoPago.js falso (https://sdk.mercadopago.com/js/v2) para os testes no navegador e as capturas.
 * Use com Playwright: contexto.route(URL_SDK, (rota) => rota.fulfill({ contentType: 'application/javascript', body: SCRIPT_SDK })).
 *
 * Imita o cardForm (docs: github.com/mercadopago/sdk-js/blob/main/docs/card-form.md) no que a loja usa:
 * - mount: põe um <input> dentro de cada contêiner de iframe (número, validade, código), preenche o tipo de
 *   documento (CPF, CNPJ), o emissor (um só) e as parcelas (1 a 12, como o MP lista para o cartão);
 *   chama onFormMounted, onIdentificationTypesReceived, onIssuersReceived e onInstallmentsReceived.
 * - submit do formulário: confere os campos (erros no formato do SDK: [{ message }]); com tudo certo gera o
 *   token "ccfalso_<NOME DO TITULAR>_<n>" (o Mercado Pago falso decide o resultado pelo nome, como os
 *   titulares de teste APRO, OTHE, FUND…), chama onFetching('cardToken'), onCardTokenReceived e onSubmit.
 * - getCardFormData, unmount, createCardToken e submit.
 * Também define window.MP_DEVICE_SESSION_ID (o device id do antifraude).
 */

export const URL_SDK = 'https://sdk.mercadopago.com/js/v2';

export const SCRIPT_SDK = `(() => {
  window.MP_DEVICE_SESSION_ID = 'armor.falso0123456789';
  let sequencia = 0;

  function cardForm(opcoes) {
    const f = opcoes.form;
    const cb = opcoes.callbacks || {};
    const pegar = (id) => document.getElementById(id);
    const formulario = pegar(f.id);
    const valor = {};
    let dados = {};
    let montado = false;

    function campoIframe(chave) {
      const caixa = pegar(f[chave].id);
      const entrada = document.createElement('input');
      entrada.name = 'mp-' + chave;
      entrada.placeholder = f[chave].placeholder || '';
      entrada.style.cssText = 'border:0;outline:0;width:100%;height:100%;font-size:16px;background:transparent';
      caixa.replaceChildren(entrada);
      valor[chave] = () => entrada.value.replace(/\\s+/g, '');
    }

    function opcoesDo(select, lista) {
      select.replaceChildren(...lista.map(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; }));
    }

    function erros() {
      const lista = [];
      if (!/^\\d{13,19}$/.test(valor.cardNumber())) lista.push({ field: 'cardNumber', message: 'parameter cardNumber can not be null/empty' });
      if (!/^\\d{2}\\/\\d{2,4}$/.test(valor.expirationDate())) lista.push({ field: 'expirationDate', message: 'invalid expirationDate' });
      if (!/^\\d{3,4}$/.test(valor.securityCode())) lista.push({ field: 'securityCode', message: 'invalid securityCode' });
      if (!pegar(f.cardholderName.id).value.trim()) lista.push({ field: 'cardholderName', message: 'parameter cardholderName can not be null/empty' });
      if (!/^\\d{11,14}$/.test(pegar(f.identificationNumber.id).value)) lista.push({ field: 'identificationNumber', message: 'invalid identificationNumber' });
      return lista;
    }

    async function criarToken() {
      const lista = erros();
      if (lista.length) {
        if (cb.onCardTokenReceived) cb.onCardTokenReceived(lista);
        return null;
      }
      const fim = cb.onFetching ? cb.onFetching('cardToken') : null;
      await new Promise((r) => setTimeout(r, 150));
      sequencia += 1;
      const titular = pegar(f.cardholderName.id).value.trim().toUpperCase().replace(/[^A-Z]/g, '') || 'APRO';
      dados = {
        token: 'ccfalso_' + titular + '_' + sequencia + Date.now().toString(36),
        installments: pegar(f.installments.id).value,
        paymentMethodId: valor.cardNumber().startsWith('4') ? 'visa' : 'master',
        issuerId: pegar(f.issuer.id).value,
        identificationType: pegar(f.identificationType.id).value,
        identificationNumber: pegar(f.identificationNumber.id).value,
        processingMode: 'aggregator',
      };
      if (typeof fim === 'function') fim();
      if (cb.onCardTokenReceived) cb.onCardTokenReceived(null, { token: dados.token });
      return dados.token;
    }

    async function aoEnviar(evento) {
      evento.preventDefault();
      const token = await criarToken();
      if (token && cb.onSubmit) cb.onSubmit(evento);
    }

    function mount() {
      ['cardNumber', 'expirationDate', 'securityCode'].forEach(campoIframe);
      opcoesDo(pegar(f.identificationType.id), [['CPF', 'CPF'], ['CNPJ', 'CNPJ']]);
      opcoesDo(pegar(f.issuer.id), [['24', 'Mastercard']]);
      const total = Number(opcoes.amount);
      const parcelas = Array.from({ length: 12 }, (_, i) => {
        const n = i + 1;
        return [String(n), n + (n === 1 ? ' parcela de R$ ' : ' parcelas de R$ ') + (total / n).toFixed(2).replace('.', ',')];
      });
      opcoesDo(pegar(f.installments.id), parcelas);
      formulario.addEventListener('submit', aoEnviar);
      montado = true;
      if (cb.onIdentificationTypesReceived) cb.onIdentificationTypesReceived(null, [{ id: 'CPF' }, { id: 'CNPJ' }]);
      if (cb.onIssuersReceived) cb.onIssuersReceived(null, [{ id: '24', name: 'Mastercard' }]);
      if (cb.onInstallmentsReceived) cb.onInstallmentsReceived(null, { payer_costs: parcelas.map(([v, t]) => ({ installments: v, recommended_message: t })) });
      if (cb.onFormMounted) cb.onFormMounted();
      if (cb.onReady) cb.onReady();
    }

    if (opcoes.autoMount !== false) setTimeout(mount, 50);

    return {
      mount,
      unmount() {
        if (!montado) return;
        formulario.removeEventListener('submit', aoEnviar);
        montado = false;
        if (cb.onFormUnmounted) cb.onFormUnmounted();
      },
      createCardToken: criarToken,
      getCardFormData: () => ({ ...dados }),
      submit: () => formulario.requestSubmit(),
      update() {},
    };
  }

  window.MercadoPago = class MercadoPago {
    constructor(chave, opcoes) {
      if (!/^(APP_USR|TEST)-/.test(String(chave))) throw new Error('public_key inválida');
      this.chave = chave;
      this.opcoes = opcoes || {};
      window.__mpFalso = { chave, opcoes: this.opcoes };
    }
    cardForm(opcoes) { return cardForm(opcoes); }
  };
})();`;
