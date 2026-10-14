/**
 * CEP: normalização e UF pela tabela oficial de faixas de CEP dos Correios (sem rede).
 * Usado pelo frete fixo por UF (docs/ARQUITETURA.md §6.2).
 *
 * Exportações:
 * - normalizarCep(cep: string|number) → string (8 dígitos) | null
 *     Aceita "66000-000", "66.000-000", " 66000000 " e número (1310100 → "01310100").
 *     Recusa letras, tamanho diferente de 8 e "00000000".
 * - formatarCep(cep) → "66000-000" | ''
 * - ufDoCep(cep) → 'PA' | … | null (null se o CEP é inválido ou não está em nenhuma faixa)
 * - FAIXAS_CEP: readonly [{ uf, inicio, fim }] (inteiros de 8 dígitos, em ordem crescente)
 */

// Tabela "Faixas de CEP por UF" dos Correios. DF/GO e AM/RR são descontínuos.
// 00000-000 a 00999-999 e 78900-000 a 78999-999 (faixa antiga de Rondônia) não pertencem a nenhuma UF.
const FAIXAS = [
  ['SP', '01000000', '19999999'],
  ['RJ', '20000000', '28999999'],
  ['ES', '29000000', '29999999'],
  ['MG', '30000000', '39999999'],
  ['BA', '40000000', '48999999'],
  ['SE', '49000000', '49999999'],
  ['PE', '50000000', '56999999'],
  ['AL', '57000000', '57999999'],
  ['PB', '58000000', '58999999'],
  ['RN', '59000000', '59999999'],
  ['CE', '60000000', '63999999'],
  ['PI', '64000000', '64999999'],
  ['MA', '65000000', '65999999'],
  ['PA', '66000000', '68899999'],
  ['AP', '68900000', '68999999'],
  ['AM', '69000000', '69299999'],
  ['RR', '69300000', '69399999'],
  ['AM', '69400000', '69899999'],
  ['AC', '69900000', '69999999'],
  ['DF', '70000000', '72799999'],
  ['GO', '72800000', '72999999'],
  ['DF', '73000000', '73699999'],
  ['GO', '73700000', '76799999'],
  ['RO', '76800000', '76999999'],
  ['TO', '77000000', '77999999'],
  ['MT', '78000000', '78899999'],
  ['MS', '79000000', '79999999'],
  ['PR', '80000000', '87999999'],
  ['SC', '88000000', '89999999'],
  ['RS', '90000000', '99999999'],
];

export const FAIXAS_CEP = Object.freeze(FAIXAS.map(([uf, inicio, fim]) => Object.freeze({
  uf,
  inicio: Number(inicio),
  fim: Number(fim),
})));

/** CEP com 8 dígitos (string) ou null. */
export function normalizarCep(cep) {
  if (typeof cep === 'number') {
    if (!Number.isSafeInteger(cep) || cep <= 0 || cep > 99_999_999) return null;
    return String(cep).padStart(8, '0');
  }
  if (typeof cep !== 'string') return null;
  const texto = cep.trim();
  // Só dígitos com pontos, hífens ou espaços como separadores.
  if (!texto || texto.length > 20 || !/^[\d.\s-]+$/.test(texto)) return null;
  const digitos = texto.replace(/\D+/g, '');
  if (digitos.length !== 8 || digitos === '00000000') return null;
  return digitos;
}

/** "66000000" → "66000-000"; inválido → ''. */
export function formatarCep(cep) {
  const d = normalizarCep(cep);
  return d ? `${d.slice(0, 5)}-${d.slice(5)}` : '';
}

/** UF do CEP pela tabela de faixas, ou null. */
export function ufDoCep(cep) {
  const d = normalizarCep(cep);
  if (!d) return null;
  const numero = Number(d);
  // Busca binária: as faixas estão em ordem crescente e não se sobrepõem.
  let baixo = 0;
  let alto = FAIXAS_CEP.length - 1;
  while (baixo <= alto) {
    const meio = (baixo + alto) >> 1;
    const faixa = FAIXAS_CEP[meio];
    if (numero < faixa.inicio) alto = meio - 1;
    else if (numero > faixa.fim) baixo = meio + 1;
    else return faixa.uf;
  }
  return null;
}
