// Testes da página de configurações do painel (public/admin/js/paginas/configuracoes.js): validação de cada
// aba (iguais às regras usadas pelo servidor em lib/frete.js e lib/mercadopago.js), documentos, WhatsApp,
// estados, ids do frete fixo, prazos, e-mails, diagnóstico das formas de entrega e textos das integrações.
// As telas são conferidas no navegador por scripts/capturas-painel-configuracoes.mjs.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import * as config from '../../public/admin/js/paginas/configuracoes.js';
import { normalizarConfigFrete, opcoesFixas } from '../../lib/frete.js';

const {
  PRAZOS_PAGAMENTO_DIAS, SERVICOS_MELHOR_ENVIO, UFS, diagnosticoEntrega, diasDoPrazo, documentoValido, formatarDecimal,
  idOpcaoFixa, lerDecimal, lerEmails, lerInteiro, lerUfs,
  validarCheckout, validarFrete, validarLoja, validarNotificacoes,
} = config;

const ORIGEM_OK = {
  nome: 'AMA', documento: '11.222.333/0001-81', telefone: '(91) 99999-0000', email: 'loja@ama.org.br', cep: '67125-866',
  endereco: 'Conjunto Uirapuru', numero: '02', complemento: '', bairro: 'Icuí', cidade: 'Ananindeua', uf: 'pa',
};
const freteValido = (extra = {}) => ({
  origem: { ...ORIGEM_OK },
  melhor_envio: { ativo: true, servicos: [1, 2], seguro: true, prazo_extra_dias: '2', taxa_extra_centavos: 0 },
  fixo: { ativo: false, opcoes: [] },
  embalagem_padrao: { peso_gramas: '300', altura_cm: '4', largura_cm: '12', comprimento_cm: '16' },
  ...extra,
});

describe('números, documentos e textos', () => {
  test('lerInteiro, lerDecimal e formatarDecimal', () => {
    assert.equal(lerInteiro('12'), 12);
    assert.equal(lerInteiro(' '), null);
    assert.ok(Number.isNaN(lerInteiro('1,5')));
    assert.ok(Number.isNaN(lerInteiro('-1')));
    assert.equal(lerDecimal('4,5'), 4.5);
    assert.equal(lerDecimal('12'), 12);
    assert.equal(lerDecimal(''), null);
    assert.ok(Number.isNaN(lerDecimal('abc')));
    assert.equal(formatarDecimal(4.5), '4,5');
    assert.equal(formatarDecimal(16), '16');
    assert.equal(formatarDecimal(null), '');
  });

  test('CPF e CNPJ com dígitos verificadores', () => {
    assert.equal(documentoValido('529.982.247-25'), true);
    assert.equal(documentoValido('11.222.333/0001-81'), true);
    assert.equal(documentoValido('529.982.247-24'), false);
    assert.equal(documentoValido('11.222.333/0001-82'), false);
    assert.equal(documentoValido('111.111.111-11'), false);
    assert.equal(documentoValido('00000000000000'), false);
    assert.equal(documentoValido('123'), false);
  });

  test('estados e e-mails', () => {
    assert.equal(UFS.length, 27);
    assert.deepEqual(lerUfs('pa, AP;am pa'), { ufs: ['PA', 'AP', 'AM'], invalidas: [] });
    assert.deepEqual(lerUfs('PA XX'), { ufs: ['PA'], invalidas: ['XX'] });
    assert.deepEqual(lerUfs(''), { ufs: [], invalidas: [] });
    assert.deepEqual(lerEmails('A@x.com; b@y.com, a@x.com'), { emails: 'a@x.com, b@y.com', lista: ['a@x.com', 'b@y.com'], invalidos: [] });
    assert.deepEqual(lerEmails('ok@x.com errado@').invalidos, ['errado@']);
    assert.equal(lerEmails('').emails, '');
  });

  test('id das opções de frete fixo: começa com "fixo-" e não repete', () => {
    assert.equal(idOpcaoFixa('Entrega em Ananindeua'), 'fixo-entrega-em-ananindeua');
    assert.equal(idOpcaoFixa('Entrega local', ['fixo-entrega-local']), 'fixo-entrega-local-2');
    assert.equal(idOpcaoFixa(''), 'fixo-opcao');
    assert.match(idOpcaoFixa('x'.repeat(80)), /^fixo-x{40}$/);
  });
});

describe('aba Loja', () => {
  test('válida: normaliza espaços; WhatsApp e e-mail de contato não são mais editados aqui', () => {
    const r = validarLoja({ titulo: '  Produtos  AMA ', subtitulo: '', whatsapp: '(91) 98105-6049', email_contato: 'x' });
    assert.deepEqual(r.erros, {});
    assert.deepEqual(r.valor, { titulo: 'Produtos AMA', subtitulo: '' });
  });

  test('erros por campo', () => {
    const r = validarLoja({ titulo: '', subtitulo: 'x'.repeat(401) });
    assert.deepEqual(Object.keys(r.erros).sort(), ['subtitulo', 'titulo']);
  });
});

describe('aba Frete', () => {
  test('válida: monta o valor no formato que lib/frete.js usa', () => {
    const r = validarFrete(freteValido({
      fixo: { ativo: true, opcoes: [{ nome: 'Entrega na Grande Belém', preco_centavos: 1250, prazo_dias: '2', ufs: 'pa' }] },
    }));
    assert.deepEqual(r.erros, {});
    assert.equal(r.frete.origem.documento, '11222333000181');
    assert.equal(r.frete.origem.cep, '67125866');
    assert.equal(r.frete.origem.uf, 'PA');
    assert.deepEqual(r.frete.melhor_envio, { ativo: true, servicos: [1, 2], seguro: true, prazo_extra_dias: 2, taxa_extra_centavos: 0 });
    assert.deepEqual(r.frete.fixo.opcoes, [{ id: 'fixo-entrega-na-grande-belem', nome: 'Entrega na Grande Belém', preco_centavos: 1250, prazo_dias: 2, ufs: ['PA'] }]);
    assert.deepEqual(r.frete.embalagem_padrao, { peso_gramas: 300, altura_cm: 4, largura_cm: 12, comprimento_cm: 16 });
    assert.equal('retirada' in r.frete, false);
    // O servidor entende o que o painel salva.
    const cfg = normalizarConfigFrete({ frete: r.frete });
    const fixas = opcoesFixas({ ...cfg.fixo }, 'PA');
    assert.equal(fixas.length, 1);
    assert.equal(fixas[0].id, 'fixo-entrega-na-grande-belem');
    assert.equal(fixas[0].preco_centavos, 1250);
    assert.deepEqual(opcoesFixas({ ...cfg.fixo }, 'SP'), []);
  });

  test('origem obrigatória só com o Melhor Envio ligado', () => {
    const vazia = { nome: '', documento: '', telefone: '', email: '', cep: '', endereco: '', numero: '', complemento: '', bairro: '', cidade: '', uf: '' };
    const ligado = validarFrete(freteValido({ origem: vazia }));
    for (const campo of ['nome', 'documento', 'telefone', 'cep', 'endereco', 'numero', 'bairro', 'cidade', 'uf']) {
      assert.ok(ligado.erros[`origem.${campo}`], campo);
    }
    assert.equal(ligado.erros['origem.email'], undefined, 'e-mail é opcional');
    const desligado = validarFrete(freteValido({ origem: vazia, melhor_envio: { ativo: false, servicos: [] } }));
    assert.equal(Object.keys(desligado.erros).filter((k) => k.startsWith('origem.')).length, 0);
  });

  test('erros de formato da origem e do Melhor Envio', () => {
    const r = validarFrete(freteValido({
      origem: { ...ORIGEM_OK, cep: '123', documento: '123', telefone: '12', email: 'x', uf: 'XX' },
      melhor_envio: { ativo: true, servicos: [99], prazo_extra_dias: '40', taxa_extra_centavos: Number.NaN },
    }));
    for (const chave of ['origem.cep', 'origem.documento', 'origem.telefone', 'origem.email', 'origem.uf',
      'melhor_envio.servicos', 'melhor_envio.prazo_extra_dias', 'melhor_envio.taxa_extra_centavos']) {
      assert.ok(r.erros[chave], chave);
    }
    assert.deepEqual(SERVICOS_MELHOR_ENVIO.map((s) => s.id), [1, 2, 17]);
  });

  test('frete fixo: erros por opção, ids mantidos e sem repetição', () => {
    const r = validarFrete(freteValido({
      fixo: {
        ativo: true,
        opcoes: [
          { nome: '', preco_centavos: null, prazo_dias: 'x', ufs: 'PA, ZZ' },
          { nome: 'Entrega', preco_centavos: Number.NaN, prazo_dias: '', ufs: '' },
        ],
      },
    }));
    for (const chave of ['fixo.opcoes.0.nome', 'fixo.opcoes.0.preco_centavos', 'fixo.opcoes.0.prazo_dias', 'fixo.opcoes.0.ufs', 'fixo.opcoes.1.preco_centavos']) {
      assert.ok(r.erros[chave], chave);
    }
    assert.ok(validarFrete(freteValido({ fixo: { ativo: true, opcoes: [] } })).erros['fixo.opcoes'], 'ligado sem opções');
    const ids = validarFrete(freteValido({
      fixo: { ativo: true, opcoes: [{ id: 'fixo-1', nome: 'A', preco_centavos: 0, prazo_dias: '' }, { id: 'fixo-1', nome: 'B', preco_centavos: 0, prazo_dias: '' }] },
    })).frete.fixo.opcoes.map((o) => o.id);
    assert.deepEqual(ids, ['fixo-1', 'fixo-b']);
  });

  test('embalagem e frete grátis', () => {
    const r = validarFrete(freteValido({
      embalagem_padrao: { peso_gramas: '0', altura_cm: '200', largura_cm: 'abc', comprimento_cm: '' },
    }));
    for (const chave of ['embalagem_padrao.peso_gramas', 'embalagem_padrao.altura_cm', 'embalagem_padrao.largura_cm', 'embalagem_padrao.comprimento_cm']) {
      assert.ok(r.erros[chave], chave);
    }
  });

  test('diagnóstico das formas de entrega', () => {
    const me = (ativo, cep = '67125866') => ({ melhor_envio: { ativo }, fixo: { ativo: false, opcoes: [] }, origem: { cep } });
    assert.equal(diagnosticoEntrega(me(true), true).ok, true);
    assert.equal(diagnosticoEntrega(me(true), null).ok, true, 'ainda sem saber se está configurado');
    assert.match(diagnosticoEntrega(me(true), false).mensagem, /MELHOR_ENVIO_TOKEN/);
    assert.match(diagnosticoEntrega(me(true, ''), true).mensagem, /CEP/);
    assert.match(diagnosticoEntrega(me(false), true).mensagem, /Nenhuma forma de entrega/);
    assert.equal(diagnosticoEntrega({ melhor_envio: { ativo: false }, fixo: { ativo: true, opcoes: [{}] } }, false).ok, true);
    assert.equal(diagnosticoEntrega({ melhor_envio: { ativo: false }, fixo: { ativo: true, opcoes: [] } }, false).ok, false);
    assert.equal(diagnosticoEntrega(null, null).ok, false);
  });
});

describe('abas Pagamento e Avisos', () => {
  test('validarCheckout e prazos', () => {
    assert.deepEqual(validarCheckout({ parcelas_max: '3', aceitar_boleto: false, prazo_dias: '5' }), {
      erros: {}, valor: { parcelas_max: 3, aceitar_boleto: false, expiracao_horas: 120 },
    });
    const r = validarCheckout({ parcelas_max: '13', prazo_dias: '2' });
    assert.ok(r.erros.parcelas_max && r.erros.prazo_dias);
    assert.ok(PRAZOS_PAGAMENTO_DIAS.every((d) => d >= 3), 'o Mercado Pago pede no mínimo 72 h');
    assert.equal(diasDoPrazo(72), 3);
    assert.equal(diasDoPrazo(120), 5);
    assert.equal(diasDoPrazo(144), 5, 'o mais próximo da lista');
    assert.equal(diasDoPrazo(24), 3);
    assert.equal(diasDoPrazo(undefined), 3);
    assert.equal(diasDoPrazo(10000), 30);
  });

  test('validarNotificacoes', () => {
    assert.deepEqual(validarNotificacoes({ email_admin: 'Equipe@AMA.org.br; loja@ama.org.br' }), { erros: {}, valor: { email_admin: 'equipe@ama.org.br, loja@ama.org.br' } });
    assert.deepEqual(validarNotificacoes({ email_admin: '' }), { erros: {}, valor: { email_admin: '' } });
    assert.ok(validarNotificacoes({ email_admin: 'a@b.com, x' }).erros.email_admin);
    assert.ok(validarNotificacoes({ email_admin: Array.from({ length: 6 }, (_, i) => `e${i}@x.com`).join(',') }).erros.email_admin);
  });
});

describe('arquivos da página', () => {
  test('configuracoes.css existe, é carregado e só estiliza dentro da página', () => {
    const css = new URL('../../public/admin/css/configuracoes.css', import.meta.url);
    assert.ok(existsSync(css));
    const fonte = readFileSync(new URL('../../public/admin/js/paginas/configuracoes.js', import.meta.url), 'utf8');
    assert.match(fonte, /carregarCss\('configuracoes'\)/);
    assert.doesNotMatch(fonte, /innerHTML|insertAdjacentHTML|outerHTML/);
    assert.doesNotMatch(fonte, /['"`]retirada['"`]|\.retirada\b|retirada:/, 'não existe retirada na sede');
    const seletores = readFileSync(css, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('}')
      .map((bloco) => bloco.split('{').slice(-2, -1)[0] || '').map((s) => s.trim()).filter((s) => s && !s.startsWith('@'));
    for (const sel of seletores) {
      for (const parte of sel.split(',')) assert.match(parte.trim(), /^\.pagina\[data-pagina="configuracoes"\]/, parte);
    }
  });
});
