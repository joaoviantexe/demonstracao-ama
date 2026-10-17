// Chamadas às APIs da loja (docs/ARQUITETURA.md §6.2–§6.4).
// Todas devolvem o JSON de sucesso ({ ok: true, ... }) ou lançam ErroApi com
// { status, erro, mensagem, dados } — status 0 = sem resposta (rede ou tempo esgotado).

export class ErroApi extends Error {
  constructor({ status = 0, erro = 'desconhecido', mensagem = '', dados = {} } = {}) {
    super(mensagem || 'Algo deu errado. Tente novamente.');
    this.name = 'ErroApi';
    this.status = status;
    this.erro = erro;
    this.mensagem = this.message;
    this.dados = dados && typeof dados === 'object' ? dados : {};
  }
}

const MENSAGENS = {
  0: 'Não foi possível falar com a loja. Confira sua conexão e tente novamente.',
  400: 'Confira os dados informados.',
  404: 'Não encontrado.',
  409: 'Seu carrinho mudou. Confira os itens.',
  429: 'Muitas tentativas seguidas. Aguarde um instante e tente de novo.',
  500: 'Erro inesperado na loja. Tente novamente em instantes.',
  502: 'Um serviço externo não respondeu. Tente novamente em instantes.',
  503: 'Este recurso ainda está em configuração.',
};

function mensagemPadrao(status) {
  if (MENSAGENS[status]) return MENSAGENS[status];
  return status >= 500 ? MENSAGENS[500] : MENSAGENS[400];
}

async function chamar(caminho, { metodo = 'GET', corpo, timeoutMs = 20000 } = {}) {
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), timeoutMs);
  try {
    let resposta;
    try {
      resposta = await fetch(caminho, {
        method: metodo,
        headers: corpo === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: corpo === undefined ? undefined : JSON.stringify(corpo),
        signal: controle.signal,
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch (erro) {
      const tempo = erro && erro.name === 'AbortError';
      throw new ErroApi({
        status: 0,
        erro: tempo ? 'tempo_esgotado' : 'rede',
        mensagem: tempo ? 'A loja demorou demais para responder. Tente novamente.' : MENSAGENS[0],
      });
    }
    let json = null;
    try {
      json = await resposta.json();
    } catch {
      json = null;
    }
    const objeto = json && typeof json === 'object' && !Array.isArray(json) ? json : null;
    if (!resposta.ok || !objeto || objeto.ok !== true) {
      throw new ErroApi({
        status: resposta.status,
        erro: objeto && typeof objeto.erro === 'string' ? objeto.erro : `http_${resposta.status}`,
        mensagem: objeto && typeof objeto.mensagem === 'string' && objeto.mensagem ? objeto.mensagem : mensagemPadrao(resposta.status),
        dados: objeto || {},
      });
    }
    return objeto;
  } finally {
    clearTimeout(timer);
  }
}

/** POST /api/loja/cotacao — { itens: [{produto_id, quantidade}], cep? }. */
export function cotar({ itens, cep } = {}) {
  const corpo = { itens: Array.isArray(itens) ? itens : [] };
  if (cep) corpo.cep = cep;
  return chamar('/api/loja/cotacao', { metodo: 'POST', corpo, timeoutMs: 25000 });
}

/** POST /api/loja/checkout — devolve { pedido: { id, numero, token }, redirecionar }. */
export function finalizar(dados) {
  return chamar('/api/loja/checkout', { metodo: 'POST', corpo: dados, timeoutMs: 45000 });
}

/** GET /api/loja/pedido?id=&token=[&payment_id=] — devolve { pedido }. */
export function consultarPedido({ id, token, paymentId } = {}) {
  const params = new URLSearchParams({ id: String(id || ''), token: String(token || '') });
  if (paymentId) params.set('payment_id', String(paymentId));
  return chamar(`/api/loja/pedido?${params}`, { timeoutMs: 25000 });
}

/**
 * POST /api/loja/pagamento (Checkout Transparente) — { id, token, metodo, chave, cartao?, dispositivo? }.
 * Devolve { pagamento: { id, status, metodo, pix?, boleto?, mensagem? } }.
 */
export function pagar(dados) {
  return chamar('/api/loja/pagamento', { metodo: 'POST', corpo: dados, timeoutMs: 45000 });
}
