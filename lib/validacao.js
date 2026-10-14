/**
 * Validações de dados de clientes e do checkout (docs/ARQUITETURA.md §6.3).
 * Os limites acompanham as checagens de public.criar_pedido na migração.
 *
 * Exportações:
 * - somenteDigitos(valor) → string                      "123.456.789-09" → "12345678909"
 * - validarCpf(cpf) → boolean                           dígitos verificadores; rejeita "111.111.111-11"
 * - validarEmail(email) → boolean                       formato usual, até 160 caracteres
 * - validarTelefone(telefone) → boolean                 10 ou 11 dígitos com DDD (celular: 9 após o DDD)
 * - validarCep(cep) → boolean                           8 dígitos (não aceita "00000000")
 * - validarNomeCompleto(nome) → boolean                 >= 2 palavras com letras, 2–120 caracteres
 * - validarUuid(valor) → boolean                        UUID canônico (qualquer versão)
 * - UFS: readonly string[]                              as 27 siglas
 * - validarUf(uf) → boolean                             sigla válida (maiúsculas ou minúsculas)
 * - normalizarTexto(texto, max = 200, { multilinha = false }) → string
 *     NFC, sem caracteres de controle, espaços colapsados, trim, cortado em `max` caracteres.
 *     multilinha mantém quebras de linha (no máximo uma linha em branco seguida).
 * - validarDadosCheckout(corpo) → { ok, erros, dados }
 *     erros: { 'cliente.nome': 'mensagem', 'endereco.cep': '...', itens: '...', ... } (vazio se ok)
 *     dados: {
 *       cliente: { nome, email (minúsculas), telefone (dígitos), cpf (dígitos) },
 *       endereco: { cep (dígitos), logradouro, numero, complemento, bairro, cidade, uf } | {} na retirada,
 *       observacoes: string | null (até 500 caracteres),
 *       cupom: string em maiúsculas | null,
 *       itens: [{ produto_id (uuid minúsculo), quantidade (1–99) }] (1 a 30 linhas),
 *       frete_id: string ('me-1', 'fixo-1', 'retirada'...)
 *     }
 *     `dados` vem normalizado mesmo quando ok = false (para reexibir o formulário).
 */

/** Só os dígitos de um valor qualquer. */
export function somenteDigitos(valor) {
  if (valor === undefined || valor === null) return '';
  return String(valor).replace(/\D+/g, '');
}

/** CPF com dígitos verificadores corretos (aceita com ou sem máscara). */
export function validarCpf(cpf) {
  const d = somenteDigitos(cpf);
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const digito = (tamanho) => {
    let soma = 0;
    for (let i = 0; i < tamanho; i += 1) soma += Number(d[i]) * (tamanho + 1 - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  return digito(9) === Number(d[9]) && digito(10) === Number(d[10]);
}

const REGEX_EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;

/** E-mail em formato usual (até 160 caracteres, como no banco). */
export function validarEmail(email) {
  if (typeof email !== 'string') return false;
  const e = email.trim();
  if (!e || e.length > 160) return false;
  if (!REGEX_EMAIL.test(e)) return false;
  const local = e.slice(0, e.lastIndexOf('@'));
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
}

/** Telefone brasileiro com DDD: 10 dígitos (fixo) ou 11 (celular, começando com 9 após o DDD). */
export function validarTelefone(telefone) {
  const d = somenteDigitos(telefone);
  if (d.length !== 10 && d.length !== 11) return false;
  if (!/^[1-9]{2}/.test(d)) return false;
  if (d.length === 11 && d[2] !== '9') return false;
  return true;
}

/** CEP com 8 dígitos. */
export function validarCep(cep) {
  const d = somenteDigitos(cep);
  return d.length === 8 && d !== '00000000';
}

/** Nome e sobrenome: ao menos duas palavras com letras. */
export function validarNomeCompleto(nome) {
  const n = normalizarTexto(nome, 1000);
  if (n.length < 2 || n.length > 120) return false;
  const palavras = n.split(' ').filter((p) => /\p{L}/u.test(p));
  return palavras.length >= 2;
}

/** UUID canônico (8-4-4-4-12 hexadecimais). */
export function validarUuid(valor) {
  return typeof valor === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(valor.trim());
}

/** As 27 unidades federativas. */
export const UFS = Object.freeze([
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA',
  'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
]);

/** Sigla de UF válida. */
export function validarUf(uf) {
  return typeof uf === 'string' && UFS.includes(uf.trim().toUpperCase());
}

/**
 * Texto limpo: NFC, sem caracteres de controle/invisíveis, espaços colapsados, trim e no máximo `max`
 * caracteres (conta pontos de código, não corta emoji ao meio).
 */
export function normalizarTexto(texto, max = 200, { multilinha = false } = {}) {
  if (texto === undefined || texto === null) return '';
  if (typeof texto !== 'string' && typeof texto !== 'number') return '';
  let t = String(texto).normalize('NFC').replace(/\r\n?/g, '\n');
  // Controle (menos \n e \t), zero-width e separadores de linha Unicode viram espaço.
  t = t.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\ufeff]/g, ' ');
  if (multilinha) {
    t = t.split('\n').map((linha) => linha.replace(/[^\S\n]+/g, ' ').trim()).join('\n');
    t = t.replace(/\n{3,}/g, '\n\n');
  } else {
    t = t.replace(/\s+/g, ' ');
  }
  t = t.trim();
  const limite = Number.isInteger(max) && max >= 0 ? max : 200;
  const caracteres = Array.from(t);
  if (caracteres.length > limite) t = caracteres.slice(0, limite).join('').trim();
  return t;
}

// Comprimento em caracteres (pontos de código), como o length() do Postgres.
const tamanho = (texto) => Array.from(texto).length;

const MAX_ITENS = 30;
const MAX_QUANTIDADE = 99;

function lerQuantidade(valor) {
  if (typeof valor === 'number') return Number.isInteger(valor) ? valor : NaN;
  if (typeof valor === 'string' && /^\s*\d{1,3}\s*$/.test(valor)) return Number(valor);
  return NaN;
}

function validarItens(itens, erros) {
  if (!Array.isArray(itens) || itens.length === 0) {
    erros.itens = 'Seu carrinho está vazio.';
    return [];
  }
  if (itens.length > MAX_ITENS) {
    erros.itens = `O carrinho pode ter no máximo ${MAX_ITENS} produtos diferentes.`;
    return [];
  }
  const saida = [];
  for (const item of itens) {
    const produtoId = item && typeof item === 'object' ? item.produto_id : undefined;
    const quantidade = item && typeof item === 'object' ? lerQuantidade(item.quantidade) : NaN;
    if (!validarUuid(produtoId)) {
      erros.itens = 'Há um produto inválido no carrinho.';
      return [];
    }
    if (!Number.isInteger(quantidade) || quantidade < 1 || quantidade > MAX_QUANTIDADE) {
      erros.itens = `A quantidade de cada produto deve ser de 1 a ${MAX_QUANTIDADE}.`;
      return [];
    }
    saida.push({ produto_id: produtoId.trim().toLowerCase(), quantidade });
  }
  return saida;
}

function campoTexto(origem, nome) {
  const valor = origem && typeof origem === 'object' ? origem[nome] : undefined;
  return typeof valor === 'string' || typeof valor === 'number' ? normalizarTexto(valor, 1000) : '';
}

/**
 * Valida e normaliza o corpo de POST /api/loja/checkout.
 * Endereço completo é exigido, exceto quando frete_id === 'retirada' (aí endereco = {}).
 */
export function validarDadosCheckout(corpo) {
  const erros = {};
  const entrada = corpo && typeof corpo === 'object' && !Array.isArray(corpo) ? corpo : {};
  if (entrada !== corpo) erros.corpo = 'Dados do pedido inválidos.';

  // Cliente
  const clienteBruto = entrada.cliente && typeof entrada.cliente === 'object' ? entrada.cliente : {};
  const nome = campoTexto(clienteBruto, 'nome');
  const email = campoTexto(clienteBruto, 'email').replace(/\s+/g, '').toLowerCase();
  const telefone = somenteDigitos(typeof clienteBruto.telefone === 'string' || typeof clienteBruto.telefone === 'number'
    ? clienteBruto.telefone : '');
  const cpf = somenteDigitos(typeof clienteBruto.cpf === 'string' || typeof clienteBruto.cpf === 'number'
    ? clienteBruto.cpf : '');

  if (!nome) erros['cliente.nome'] = 'Informe seu nome completo.';
  else if (tamanho(nome) > 120) erros['cliente.nome'] = 'O nome pode ter no máximo 120 caracteres.';
  else if (!validarNomeCompleto(nome)) erros['cliente.nome'] = 'Informe nome e sobrenome.';

  if (!email) erros['cliente.email'] = 'Informe seu e-mail.';
  else if (!validarEmail(email)) erros['cliente.email'] = 'Confira o e-mail informado.';

  if (!telefone) erros['cliente.telefone'] = 'Informe um telefone com DDD.';
  else if (!validarTelefone(telefone)) erros['cliente.telefone'] = 'Telefone inválido. Use DDD + número (10 ou 11 dígitos).';

  if (!cpf) erros['cliente.cpf'] = 'Informe seu CPF.';
  else if (!validarCpf(cpf)) erros['cliente.cpf'] = 'CPF inválido.';

  // Frete
  const freteBruto = typeof entrada.frete_id === 'string' || typeof entrada.frete_id === 'number'
    ? String(entrada.frete_id).trim() : '';
  const frete_id = /^[A-Za-z0-9_-]{1,60}$/.test(freteBruto) ? freteBruto : '';
  if (!frete_id) erros.frete_id = 'Escolha uma opção de entrega.';
  const retirada = frete_id === 'retirada';

  // Endereço (não se aplica à retirada)
  let endereco = {};
  if (!retirada) {
    const e = entrada.endereco && typeof entrada.endereco === 'object' && !Array.isArray(entrada.endereco)
      ? entrada.endereco : {};
    const cep = somenteDigitos(typeof e.cep === 'string' || typeof e.cep === 'number' ? e.cep : '');
    endereco = {
      cep,
      logradouro: campoTexto(e, 'logradouro'),
      numero: campoTexto(e, 'numero'),
      complemento: campoTexto(e, 'complemento'),
      bairro: campoTexto(e, 'bairro'),
      cidade: campoTexto(e, 'cidade'),
      uf: campoTexto(e, 'uf').toUpperCase(),
    };
    if (!validarCep(cep)) erros['endereco.cep'] = 'Informe um CEP válido (8 dígitos).';
    const obrigatorios = [
      ['logradouro', 200, 'Informe a rua ou avenida.'],
      ['numero', 20, 'Informe o número (ou "S/N").'],
      ['bairro', 100, 'Informe o bairro.'],
      ['cidade', 100, 'Informe a cidade.'],
    ];
    for (const [campo, max, mensagem] of obrigatorios) {
      if (!endereco[campo]) erros[`endereco.${campo}`] = mensagem;
      else if (tamanho(endereco[campo]) > max) erros[`endereco.${campo}`] = `Use no máximo ${max} caracteres.`;
    }
    if (tamanho(endereco.complemento) > 100) erros['endereco.complemento'] = 'Use no máximo 100 caracteres.';
    if (!validarUf(endereco.uf)) erros['endereco.uf'] = 'Escolha o estado (UF).';
  }

  // Observações (opcional; o excesso é cortado)
  const obs = typeof entrada.observacoes === 'string' ? normalizarTexto(entrada.observacoes, 500, { multilinha: true }) : '';
  const observacoes = obs || null;

  // Cupom (opcional)
  let cupom = null;
  if (typeof entrada.cupom === 'string' && entrada.cupom.trim()) {
    cupom = entrada.cupom.trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,30}$/.test(cupom)) erros.cupom = 'Cupom inválido.';
  }

  const itens = validarItens(entrada.itens, erros);

  return {
    ok: Object.keys(erros).length === 0,
    erros,
    dados: {
      cliente: { nome, email, telefone, cpf },
      endereco,
      observacoes,
      cupom,
      itens,
      frete_id,
    },
  };
}
