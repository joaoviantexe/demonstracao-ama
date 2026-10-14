// lib/cep.js: normalização e UF pela tabela de faixas de CEP dos Correios (sem rede).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FAIXAS_CEP, formatarCep, normalizarCep, ufDoCep } from '../../lib/cep.js';
import { UFS } from '../../lib/validacao.js';

describe('normalizarCep', () => {
  test('aceita máscara, pontos, espaços e número', () => {
    assert.equal(normalizarCep('66000-000'), '66000000');
    assert.equal(normalizarCep('66.000-000'), '66000000');
    assert.equal(normalizarCep(' 67125866 '), '67125866');
    assert.equal(normalizarCep('67125 866'), '67125866');
    assert.equal(normalizarCep(67125866), '67125866');
    // Número perde o zero à esquerda: volta com padStart.
    assert.equal(normalizarCep(1310100), '01310100');
  });

  test('recusa o que não é CEP', () => {
    for (const valor of ['', '   ', '6600000', '660000000', 'abc', '66000-00a', 'CEP 66000000', '00000000', '00000-000',
      null, undefined, {}, [], 0, -66000000, 1.5, 123456789, '66000000'.repeat(3)]) {
      assert.equal(normalizarCep(valor), null, `deveria recusar ${JSON.stringify(valor)}`);
    }
  });

  test('formatarCep', () => {
    assert.equal(formatarCep('66000000'), '66000-000');
    assert.equal(formatarCep(1310100), '01310-100');
    assert.equal(formatarCep('x'), '');
  });
});

describe('ufDoCep', () => {
  test('capitais das 27 UFs', () => {
    const capitais = {
      AC: '69900-000', AL: '57020-000', AM: '69005-000', AP: '68900-000', BA: '40020-000', CE: '60025-000',
      DF: '70040-000', ES: '29010-000', GO: '74000-000', MA: '65010-000', MG: '30130-000', MS: '79002-000',
      MT: '78005-000', PA: '66010-000', PB: '58010-000', PE: '50030-000', PI: '64000-000', PR: '80010-000',
      RJ: '20040-020', RN: '59020-000', RO: '76801-000', RR: '69301-000', RS: '90010-000', SC: '88010-000',
      SE: '49010-000', SP: '01310-100', TO: '77001-000',
    };
    assert.deepEqual(Object.keys(capitais).sort(), [...UFS].sort());
    for (const [uf, cep] of Object.entries(capitais)) assert.equal(ufDoCep(cep), uf, `${cep} deveria ser ${uf}`);
  });

  test('Pará (inclusive Ananindeua) e bordas com o Amapá', () => {
    assert.equal(ufDoCep('66000-000'), 'PA');
    assert.equal(ufDoCep('67030-000'), 'PA'); // Ananindeua
    assert.equal(ufDoCep('67125866'), 'PA'); // origem do seed
    assert.equal(ufDoCep('68899-999'), 'PA');
    assert.equal(ufDoCep('68900-000'), 'AP');
    assert.equal(ufDoCep('68999-999'), 'AP');
    assert.equal(ufDoCep('65999-999'), 'MA');
  });

  test('faixas descontínuas: AM/RR e DF/GO', () => {
    assert.equal(ufDoCep('69000-000'), 'AM');
    assert.equal(ufDoCep('69299-999'), 'AM');
    assert.equal(ufDoCep('69300-000'), 'RR');
    assert.equal(ufDoCep('69399-999'), 'RR');
    assert.equal(ufDoCep('69400-000'), 'AM');
    assert.equal(ufDoCep('69899-999'), 'AM');
    assert.equal(ufDoCep('69900-000'), 'AC');
    assert.equal(ufDoCep('69999-999'), 'AC');

    assert.equal(ufDoCep('70000-000'), 'DF');
    assert.equal(ufDoCep('72799-999'), 'DF');
    assert.equal(ufDoCep('72800-000'), 'GO');
    assert.equal(ufDoCep('72999-999'), 'GO');
    assert.equal(ufDoCep('73000-000'), 'DF');
    assert.equal(ufDoCep('73699-999'), 'DF');
    assert.equal(ufDoCep('73700-000'), 'GO');
    assert.equal(ufDoCep('76799-999'), 'GO');
    assert.equal(ufDoCep('76800-000'), 'RO');
    assert.equal(ufDoCep('76999-999'), 'RO');
    assert.equal(ufDoCep('77000-000'), 'TO');
    assert.equal(ufDoCep('77999-999'), 'TO');
    assert.equal(ufDoCep('78000-000'), 'MT');
    assert.equal(ufDoCep('78899-999'), 'MT');
    assert.equal(ufDoCep('79000-000'), 'MS');
  });

  test('bordas de outras regiões', () => {
    const casos = {
      '01000-000': 'SP', '19999-999': 'SP', '20000-000': 'RJ', '28999-999': 'RJ', '29000-000': 'ES', '29999-999': 'ES',
      '30000-000': 'MG', '39999-999': 'MG', '40000-000': 'BA', '48999-999': 'BA', '49000-000': 'SE', '49999-999': 'SE',
      '50000-000': 'PE', '56999-999': 'PE', '57000-000': 'AL', '57999-999': 'AL', '58000-000': 'PB', '58999-999': 'PB',
      '59000-000': 'RN', '59999-999': 'RN', '60000-000': 'CE', '63999-999': 'CE', '64000-000': 'PI', '64999-999': 'PI',
      '65000-000': 'MA', '80000-000': 'PR', '87999-999': 'PR', '88000-000': 'SC', '89999-999': 'SC',
      '90000-000': 'RS', '99999-999': 'RS', '53990-000': 'PE', // Fernando de Noronha
    };
    for (const [cep, uf] of Object.entries(casos)) assert.equal(ufDoCep(cep), uf, `${cep} deveria ser ${uf}`);
  });

  test('fora das faixas ou inválido → null', () => {
    assert.equal(ufDoCep('00999-999'), null);
    assert.equal(ufDoCep('00100-000'), null);
    assert.equal(ufDoCep('78900-000'), null); // faixa antiga de Rondônia, sem UF na tabela atual
    assert.equal(ufDoCep('123'), null);
    assert.equal(ufDoCep(''), null);
    assert.equal(ufDoCep(null), null);
  });

  test('tabela: 27 UFs, faixas ordenadas e sem sobreposição', () => {
    assert.deepEqual([...new Set(FAIXAS_CEP.map((f) => f.uf))].sort(), [...UFS].sort());
    for (let i = 0; i < FAIXAS_CEP.length; i += 1) {
      const f = FAIXAS_CEP[i];
      assert.ok(f.inicio <= f.fim, `${f.uf} invertida`);
      if (i > 0) assert.ok(FAIXAS_CEP[i - 1].fim < f.inicio, `${FAIXAS_CEP[i - 1].uf} sobrepõe ${f.uf}`);
    }
    assert.ok(Object.isFrozen(FAIXAS_CEP));
  });
});
