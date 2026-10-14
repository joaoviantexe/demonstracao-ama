/**
 * Dinheiro em centavos inteiros (docs/ARQUITETURA.md §1). Só o Mercado Pago recebe reais.
 *
 * Exportações:
 * - formatarReais(centavos: number) → string
 *     "R$ 1.234,56" (negativos: "-R$ 5,00"). Valor não numérico → "—".
 * - centavosParaReais(centavos: number) → number
 *     2748 → 27.48 (no máximo 2 casas, sem resíduo de ponto flutuante). Lança TypeError se não for inteiro.
 * - reaisParaCentavos(valor: number|string) → number|null
 *     number: arredonda ao centavo (27.48 → 2748; 1.005 → 101).
 *     string: aceita "27.48", "27,48", "27", "R$ 1.234,56", "1,234.56", "1.234.567", "-5,00".
 *     Devolve null quando não dá para ler com segurança ("", "abc", "1.234" ambíguo, "27,485"),
 *     nunca 0 por engano.
 * - garantirCentavos(valor: number, nome = 'valor') → number
 *     Devolve o próprio valor se for inteiro seguro >= 0; senão lança TypeError.
 */

function agruparMilhares(digitos) {
  return digitos.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Formata centavos como "R$ 1.234,56". */
export function formatarReais(centavos) {
  const numero = typeof centavos === 'string' && centavos.trim() !== '' ? Number(centavos) : centavos;
  if (typeof numero !== 'number' || !Number.isFinite(numero)) return '—';
  const inteiro = Math.round(numero);
  const absoluto = Math.abs(inteiro);
  const reais = Math.floor(absoluto / 100);
  const resto = absoluto % 100;
  const sinal = inteiro < 0 ? '-' : '';
  return `${sinal}R$ ${agruparMilhares(String(reais))},${String(resto).padStart(2, '0')}`;
}

/** Centavos (inteiro) → reais com no máximo 2 casas, para o Mercado Pago. */
export function centavosParaReais(centavos) {
  if (!Number.isSafeInteger(centavos)) {
    throw new TypeError(`centavosParaReais: esperado inteiro, recebido ${String(centavos)}`);
  }
  // Divisão IEEE é corretamente arredondada: o resultado é o double mais próximo de N/100,
  // que serializa exatamente como "N/100" (ex.: 2748 / 100 → 27.48).
  return centavos / 100 + 0;
}

// Converte "1234" + "5" → 123450 com checagem de inteiro seguro.
function compor(sinal, inteiro, decimal) {
  const reais = Number(inteiro || '0');
  const cents = Number((decimal || '').padEnd(2, '0') || '0');
  const total = reais * 100 + cents;
  if (!Number.isSafeInteger(total)) return null;
  return sinal * total || 0;
}

// Parte inteira com separador de milhar: "1.234.567" → "1234567" (grupos de 3 obrigatórios).
function semMilhar(parte, separador) {
  if (!parte.includes(separador)) return /^\d+$/.test(parte) ? parte : null;
  const grupos = parte.split(separador);
  if (!/^\d{1,3}$/.test(grupos[0])) return null;
  if (!grupos.slice(1).every((g) => /^\d{3}$/.test(g))) return null;
  return grupos.join('');
}

function lerTexto(texto) {
  let t = texto.replace(/[\s\u00a0]/g, '');
  let sinal = 1;
  if (t.startsWith('-')) { sinal = -1; t = t.slice(1); } else if (t.startsWith('+')) { t = t.slice(1); }
  t = t.replace(/^R\$/i, '');
  if (t.startsWith('-') && sinal === 1) { sinal = -1; t = t.slice(1); }
  if (!t || !/^[\d.,]+$/.test(t) || !/\d/.test(t)) return null;

  const pontos = (t.match(/\./g) || []).length;
  const virgulas = (t.match(/,/g) || []).length;

  if (pontos && virgulas) {
    // O último separador é o decimal; o outro só pode ser de milhar.
    const decimalEhVirgula = t.lastIndexOf(',') > t.lastIndexOf('.');
    const [sepDecimal, sepMilhar] = decimalEhVirgula ? [',', '.'] : ['.', ','];
    const pos = t.lastIndexOf(sepDecimal);
    const inteiro = semMilhar(t.slice(0, pos), sepMilhar);
    const decimal = t.slice(pos + 1);
    if (inteiro === null || t.slice(0, pos).includes(sepDecimal) || !/^\d{1,2}$/.test(decimal)) return null;
    return compor(sinal, inteiro, decimal);
  }

  const separador = pontos ? '.' : virgulas ? ',' : '';
  if (!separador) return compor(sinal, t, '');
  const partes = t.split(separador);
  if (partes.length === 2) {
    const [inteiro, decimal] = partes;
    if (!/^\d*$/.test(inteiro) || !/^\d+$/.test(decimal)) return null;
    if (decimal.length <= 2) return compor(sinal, inteiro, decimal);
    // "1.234" ou "1,234": milhar ou 3 casas decimais? Ambíguo.
    return null;
  }
  // Vários separadores iguais: só pode ser milhar ("1.234.567").
  const inteiro = semMilhar(t, separador);
  return inteiro === null ? null : compor(sinal, inteiro, '');
}

/** Reais (number ou string em formato brasileiro/internacional) → centavos inteiros, ou null. */
export function reaisParaCentavos(valor) {
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor)) return null;
    if (Math.abs(valor) >= 1e13) return null;
    // Usa a representação decimal mais curta (1.005 → "1.005") e arredonda meio para longe do zero.
    const texto = Math.abs(valor) < 1e-6 ? '0' : String(Math.abs(valor));
    const m = texto.match(/^(\d+)(?:\.(\d+))?$/);
    if (!m) return null;
    const inteiro = m[1];
    const decimal = (m[2] || '').padEnd(3, '0');
    let centavos = Number(inteiro) * 100 + Number(decimal.slice(0, 2));
    if (Number(decimal[2]) >= 5) centavos += 1;
    if (!Number.isSafeInteger(centavos)) return null;
    return valor < 0 ? -centavos || 0 : centavos;
  }
  if (typeof valor === 'string') {
    const texto = valor.trim();
    if (!texto || texto.length > 40) return null;
    return lerTexto(texto);
  }
  return null;
}

/** Garante inteiro seguro >= 0 (centavos). Devolve o valor ou lança TypeError. */
export function garantirCentavos(valor, nome = 'valor') {
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new TypeError(`${nome}: esperado inteiro de centavos >= 0, recebido ${String(valor)}`);
  }
  return valor;
}
