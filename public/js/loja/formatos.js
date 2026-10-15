// Formatação, máscaras e validações da loja (funções puras: rodam no navegador e no Node).
// As validações repetem as regras de lib/validacao.js — o servidor valida tudo de novo;
// aqui elas só servem para mostrar o erro antes do envio. tests/unit/loja-front.test.js
// confere que as duas versões dão o mesmo resultado.

/** Só os dígitos de um valor qualquer. */
export function somenteDigitos(valor) {
  if (valor === undefined || valor === null) return '';
  return String(valor).replace(/\D+/g, '');
}

const MILHAR = /\B(?=(\d{3})+(?!\d))/g;

/**
 * Centavos → "R$ 1.234,56".
 * Zero vira "R$ 0,00"; com { zeroComoEmProducao: true } vira "R$ 00,00" (produto ainda sem preço,
 * como a AMA pediu para a vitrine). Valor inválido é tratado como zero.
 */
export function formatarPreco(centavos, { zeroComoEmProducao = false } = {}) {
  const numero = Number(centavos);
  const inteiro = Number.isFinite(numero) ? Math.round(numero) : 0;
  if (inteiro === 0 && zeroComoEmProducao) return 'R$ 00,00';
  const absoluto = Math.abs(inteiro);
  const reais = String(Math.floor(absoluto / 100)).replace(MILHAR, '.');
  const centavosTexto = String(absoluto % 100).padStart(2, '0');
  return `${inteiro < 0 ? '-' : ''}R$ ${reais},${centavosTexto}`;
}

/** "66010000" → "66010-000" (progressivo, para máscara de digitação). */
export function mascararCep(valor) {
  const d = somenteDigitos(valor).slice(0, 8);
  return d.length > 5 ? `${d.slice(0, 5)}-${d.slice(5)}` : d;
}

/** "12345678909" → "123.456.789-09" (progressivo). */
export function mascararCpf(valor) {
  const d = somenteDigitos(valor).slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6)}`;
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

/** "91981056049" → "(91) 98105-6049"; "9132221234" → "(91) 3222-1234" (progressivo). */
export function mascararTelefone(valor) {
  const d = somenteDigitos(valor).slice(0, 11);
  if (!d) return '';
  if (d.length <= 2) return `(${d}`;
  const ddd = d.slice(0, 2);
  const resto = d.slice(2);
  if (d.length <= 6) return `(${ddd}) ${resto}`;
  if (d.length <= 10) return `(${ddd}) ${resto.slice(0, 4)}-${resto.slice(4)}`;
  return `(${ddd}) ${resto.slice(0, 5)}-${resto.slice(5)}`;
}

/** Número do WhatsApp da configuração ("5591981056049") → "(91) 98105-6049". */
export function formatarWhatsapp(numero) {
  let d = somenteDigitos(numero);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d.length === 10 || d.length === 11 ? mascararTelefone(d) : d;
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

/** E-mail em formato usual (até 160 caracteres). */
export function validarEmail(email) {
  if (typeof email !== 'string') return false;
  const e = email.trim();
  if (!e || e.length > 160) return false;
  if (!REGEX_EMAIL.test(e)) return false;
  const local = e.slice(0, e.lastIndexOf('@'));
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
}

/** Telefone com DDD: 10 dígitos (fixo) ou 11 (celular, com 9 depois do DDD). */
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

/**
 * Texto limpo: NFC, sem caracteres de controle/invisíveis, espaços colapsados, trim e no máximo
 * `max` caracteres. Igual ao normalizarTexto do servidor.
 */
export function normalizarTexto(texto, max = 200, { multilinha = false } = {}) {
  if (texto === undefined || texto === null) return '';
  if (typeof texto !== 'string' && typeof texto !== 'number') return '';
  let t = String(texto).normalize('NFC').replace(/\r\n?/g, '\n');
  t = t.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]/g, ' ');
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

/** Nome e sobrenome: ao menos duas palavras com letras. */
export function validarNomeCompleto(nome) {
  const n = normalizarTexto(nome, 1000);
  if (n.length < 2 || n.length > 120) return false;
  return n.split(' ').filter((p) => /\p{L}/u.test(p)).length >= 2;
}

/** As 27 unidades federativas. */
export const UFS = Object.freeze([
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA',
  'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
]);

export function validarUf(uf) {
  return typeof uf === 'string' && UFS.includes(uf.trim().toUpperCase());
}

const tamanho = (texto) => Array.from(texto).length;

function textoDe(origem, nome) {
  const valor = origem && typeof origem === 'object' ? origem[nome] : undefined;
  return typeof valor === 'string' || typeof valor === 'number' ? normalizarTexto(valor, 1000) : '';
}

/**
 * Valida os dados do formulário do checkout com as MESMAS regras e mensagens do servidor
 * (validarDadosCheckout, sem os itens). Entrada { cliente, endereco, frete_id }.
 * Devolve { ok, erros } com chaves 'cliente.nome', 'endereco.cep', 'frete_id'...
 */
export function validarFormularioCheckout({ cliente, endereco, frete_id: freteId } = {}) {
  const erros = {};
  const c = cliente && typeof cliente === 'object' ? cliente : {};
  const nome = textoDe(c, 'nome');
  const emailBruto = typeof c.email === 'string' ? c.email.replace(/[\u200b-\u200d\u2060\ufeff]/g, '') : '';
  const email = normalizarTexto(emailBruto, 1000).toLowerCase();
  const telefone = somenteDigitos(typeof c.telefone === 'string' || typeof c.telefone === 'number' ? c.telefone : '');
  const cpf = somenteDigitos(typeof c.cpf === 'string' || typeof c.cpf === 'number' ? c.cpf : '');

  if (!nome) erros['cliente.nome'] = 'Informe seu nome completo.';
  else if (tamanho(nome) > 120) erros['cliente.nome'] = 'O nome pode ter no máximo 120 caracteres.';
  else if (!validarNomeCompleto(nome)) erros['cliente.nome'] = 'Informe nome e sobrenome.';

  if (!email) erros['cliente.email'] = 'Informe seu e-mail.';
  else if (!validarEmail(email)) erros['cliente.email'] = 'Confira o e-mail informado.';

  if (!telefone) erros['cliente.telefone'] = 'Informe um telefone com DDD.';
  else if (!validarTelefone(telefone)) erros['cliente.telefone'] = 'Telefone inválido. Use DDD + número (10 ou 11 dígitos).';

  if (!cpf) erros['cliente.cpf'] = 'Informe seu CPF.';
  else if (!validarCpf(cpf)) erros['cliente.cpf'] = 'CPF inválido.';

  const freteTexto = typeof freteId === 'string' || typeof freteId === 'number' ? String(freteId).trim() : '';
  const frete = /^[A-Za-z0-9_-]{1,60}$/.test(freteTexto) ? freteTexto : '';
  if (!frete) erros.frete_id = 'Escolha uma opção de entrega.';

  if (frete !== 'retirada') {
    const e = endereco && typeof endereco === 'object' && !Array.isArray(endereco) ? endereco : {};
    const cep = somenteDigitos(typeof e.cep === 'string' || typeof e.cep === 'number' ? e.cep : '');
    if (!validarCep(cep)) erros['endereco.cep'] = 'Informe um CEP válido (8 dígitos).';
    const obrigatorios = [
      ['logradouro', 200, 'Informe a rua ou avenida.'],
      ['numero', 20, 'Informe o número (ou "S/N").'],
      ['bairro', 100, 'Informe o bairro.'],
      ['cidade', 100, 'Informe a cidade.'],
    ];
    for (const [campo, max, mensagem] of obrigatorios) {
      const valor = textoDe(e, campo);
      if (!valor) erros[`endereco.${campo}`] = mensagem;
      else if (tamanho(valor) > max) erros[`endereco.${campo}`] = `Use no máximo ${max} caracteres.`;
    }
    if (tamanho(textoDe(e, 'complemento')) > 100) erros['endereco.complemento'] = 'Use no máximo 100 caracteres.';
    if (!validarUf(textoDe(e, 'uf'))) erros['endereco.uf'] = 'Escolha o estado (UF).';
  }
  return { ok: Object.keys(erros).length === 0, erros };
}

const MAPA_HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** Escapa texto para inserir em HTML (conteúdo ou atributo entre aspas). */
export function escaparHtml(texto) {
  return String(texto ?? '').replace(/[&<>"'`]/g, (c) => MAPA_HTML[c]);
}

/** "Creme Hidratante Cupuaçu" → "creme-hidratante-cupuacu". */
export function slugify(texto) {
  return String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/** Texto para comparação na busca: minúsculas, sem acentos e com espaços simples. */
export function normalizarBusca(texto) {
  return String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Slug válido como no banco (^[a-z0-9]+(-[a-z0-9]+)*$, até 120 caracteres). */
export function validarSlug(slug) {
  return typeof slug === 'string' && slug.length <= 120 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}

/**
 * URL segura para src/href vindos do banco ou do servidor: caminho relativo à raiz ("/img/x.jpg")
 * ou http(s) absoluto. Qualquer outra coisa (javascript:, data:, "//host", espaços…) vira ''.
 */
export function urlSegura(valor, { permitirRelativa = true } = {}) {
  if (typeof valor !== 'string') return '';
  const url = valor.trim();
  if (!url || url.length > 2000 || /[\u0000-\u001f\u007f\s\\]/.test(url)) return '';
  if (url.startsWith('/')) {
    return permitirRelativa && !url.startsWith('//') ? url : '';
  }
  try {
    const absoluta = new URL(url);
    return absoluta.protocol === 'https:' || absoluta.protocol === 'http:' ? absoluta.href : '';
  } catch {
    return '';
  }
}

/** Link do WhatsApp (wa.me) com mensagem pronta. Número inválido → ''. */
export function linkWhatsapp(numero, texto = '') {
  const d = somenteDigitos(numero);
  if (d.length < 10 || d.length > 15) return '';
  const mensagem = String(texto ?? '').trim();
  return `https://wa.me/${d}${mensagem ? `?text=${encodeURIComponent(mensagem)}` : ''}`;
}

/** ISO → "15/10/2026 às 14:32" (ou só a data). '' se inválida. */
export function formatarData(iso, { comHora = true } = {}) {
  if (!iso) return '';
  const data = new Date(iso);
  if (Number.isNaN(data.getTime())) return '';
  const dia = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(data);
  if (!comHora) return dia;
  const hora = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(data);
  return `${dia} às ${hora}`;
}

/** 1001 → "#1001". */
export function formatarNumeroPedido(numero) {
  const n = Number(numero);
  return Number.isInteger(n) && n > 0 ? `#${n}` : '';
}

/** "1 item" / "3 itens". */
export function pluralizar(quantidade, singular, plural) {
  return `${quantidade} ${quantidade === 1 ? singular : plural}`;
}

/** Prazo de uma opção de frete: o texto do servidor ou "até N dias úteis". */
export function formatarPrazo(opcao) {
  if (!opcao || typeof opcao !== 'object') return '';
  if (typeof opcao.prazo_texto === 'string' && opcao.prazo_texto.trim()) return opcao.prazo_texto.trim();
  const dias = Number(opcao.prazo_dias);
  if (Number.isInteger(dias) && dias > 0) return `até ${pluralizar(dias, 'dia útil', 'dias úteis')}`;
  return '';
}

/** Texto do motivo de um item indisponível (cotar_carrinho). */
export function descreverMotivo(motivo, estoqueDisponivel) {
  switch (motivo) {
    case 'inexistente': return 'Este produto não está mais na loja.';
    case 'inativo': return 'Este produto saiu da loja por enquanto.';
    case 'sem_preco': return 'O preço deste produto ainda não foi definido. Remova-o do carrinho para continuar a compra.';
    case 'sem_estoque': return 'Esgotado no momento.';
    case 'estoque_insuficiente': {
      const n = Number(estoqueDisponivel);
      return Number.isInteger(n) && n > 0
        ? `Só ${n === 1 ? 'temos 1 unidade' : `temos ${n} unidades`} em estoque.`
        : 'Não temos estoque suficiente.';
    }
    default: return motivo ? 'Este produto está indisponível.' : '';
  }
}
