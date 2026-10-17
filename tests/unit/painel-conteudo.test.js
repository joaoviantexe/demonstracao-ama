// Testes das funções puras das páginas "Conteúdo do site" e "Mídia" do painel
// (public/admin/js/paginas/conteudo.js e midia.js): normalização por tipo, valores alterados,
// validação, operações de lista, pré-visualização e busca/uso de arquivos da biblioteca.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';

import { aplicarConteudo, extrairEsquema, lerValor } from '../../public/js/cms/aplicar.js';
import * as conteudo from '../../public/admin/js/paginas/conteudo.js';

const {
  LIMITE_ITENS, adicionarItem, chaveVisibilidade, clonarValor, ehMetaDeImagem,
  limiteIdeal, numeroDoLinkWhatsapp, mensagemDoLinkWhatsapp, numeroWhatsappDigitado, formatarNumeroWhatsapp, montarLinkWhatsapp, mapaDeLinhas, montarAlteracoes, moverItem, nomeDoArquivo, normalizarEndereco,
  normalizarHtml, normalizarValor, ordenarGrupos, removerItem, resumirGrupos, resumoDoItem, textoDoHtml,
  validarEndereco, validarValor, valorEfetivo, valoresDoMolde, valoresIguais,
} = conteudo;

const HOME = readFileSync(new URL('../../templates/home.html', import.meta.url), 'utf8');
const analisar = (html) => parseHTML(html).document;
// Documento do linkedom para sanitizarHtml (no navegador é o document da página).
const DOC = analisar('<!doctype html><html><head></head><body></body></html>');

const esquemaDaHome = () => extrairEsquema(analisar(HOME));
const campoDaHome = (chave) => {
  for (const g of esquemaDaHome().grupos) {
    const c = g.campos.find((x) => x.chave === chave);
    if (c) return c;
  }
  throw new Error(`campo ${chave} não existe no template`);
};

// Monta o rascunho como a página faz: valor efetivo de cada campo, com mudanças por cima.
function rascunhoDe(campos, salvos, mudancas = {}) {
  const r = new Map(campos.map((c) => [c.chave, clonarValor(valorEfetivo(c, salvos.get(c.chave)))]));
  for (const [chave, valor] of Object.entries(mudancas)) r.set(chave, valor);
  return r;
}

// ---------------------------------------------------------------------------
// Utilitários

describe('utilitários', () => {
  test('chaveVisibilidade segue o contrato grupo.<id>.visivel', () => {
    assert.equal(chaveVisibilidade('quem-somos'), 'grupo.quem-somos.visivel');
  });

  test('mapaDeLinhas ignora linhas sem chave e guarda a data', () => {
    const mapa = mapaDeLinhas([
      { chave: 'a.b', valor: 'x', atualizado_em: '2026-10-15T10:00:00Z' },
      { chave: 1, valor: 'y' }, null, { valor: 'z' }, { chave: 'c', valor: [] },
    ]);
    assert.deepEqual([...mapa.keys()], ['a.b', 'c']);
    assert.deepEqual(mapa.get('a.b'), { valor: 'x', atualizado_em: '2026-10-15T10:00:00Z' });
    assert.equal(mapa.get('c').atualizado_em, null);
    assert.equal(mapaDeLinhas(null).size, 0);
  });

  test('limiteIdeal lê "até N caracteres" da ajuda', () => {
    assert.equal(limiteIdeal('Aparece na aba. Ideal: até 60 caracteres.'), 60);
    assert.equal(limiteIdeal('Ideal: até 160 caracteres.'), 160);
    assert.equal(limiteIdeal('Sem limite.'), null);
    assert.equal(limiteIdeal(undefined), null);
  });

  test('textoDoHtml tira as tags, decodifica entidades e separa blocos', () => {
    assert.equal(textoDoHtml('<p>Olá <strong>mundo</strong></p><p>A &amp; B&nbsp;C</p>'), 'Olá mundo A & B C');
    assert.equal(textoDoHtml('<ul><li>um</li><li>dois</li></ul>'), 'um dois');
    assert.equal(textoDoHtml(null), '');
  });

  test('nomeDoArquivo pega o último pedaço do endereço, sem consulta', () => {
    assert.equal(nomeDoArquivo('/img/produtos/creme.jpg?v=2'), 'creme.jpg');
    assert.equal(nomeDoArquivo('http://x/storage/v1/object/public/midia/site/2026-10/foto%20nova-a1b2c3.jpg'), 'foto nova-a1b2c3.jpg');
    assert.equal(nomeDoArquivo(''), '');
  });

  test('ehMetaDeImagem reconhece o og:image (e não os outros metas)', () => {
    assert.equal(ehMetaDeImagem({ tipo: 'meta', chave: 'seo.og-imagem' }), true);
    assert.equal(ehMetaDeImagem({ tipo: 'meta', chave: 'seo.descricao' }), false);
    assert.equal(ehMetaDeImagem({ tipo: 'texto', chave: 'x.imagem' }), false);
    assert.equal(ehMetaDeImagem(null), false);
  });
});

// ---------------------------------------------------------------------------
// Endereços

describe('endereços de links', () => {
  test('normalizarEndereco completa o que a pessoa costuma digitar', () => {
    assert.equal(normalizarEndereco('www.instagram.com/oscdemulheres'), 'https://www.instagram.com/oscdemulheres');
    assert.equal(normalizarEndereco('wa.me/5591981056049'), 'https://wa.me/5591981056049');
    assert.equal(normalizarEndereco('ama.org.br/loja'), 'https://ama.org.br/loja');
    assert.equal(normalizarEndereco('contato@ama.org.br'), 'mailto:contato@ama.org.br');
    assert.equal(normalizarEndereco('(91) 98105-6049'), 'tel:91981056049');
    assert.equal(normalizarEndereco('+55 91 98105-6049'), 'tel:+5591981056049');
    assert.equal(normalizarEndereco('  /loja/  '), '/loja/');
    assert.equal(normalizarEndereco('#sobre'), '#sobre');
    assert.equal(normalizarEndereco('https://exemplo.com'), 'https://exemplo.com');
    assert.equal(normalizarEndereco('javascript:alert(1)'), 'javascript:alert(1)'); // não "conserta" esquema perigoso
    assert.equal(normalizarEndereco(''), '');
    assert.equal(normalizarEndereco(null), '');
  });

  test('validarEndereco aceita só esquemas seguros e explica o erro', () => {
    assert.equal(validarEndereco('https://wa.me/5591981056049'), null);
    assert.equal(validarEndereco('/loja/'), null);
    assert.equal(validarEndereco('#depoimentos'), null);
    assert.equal(validarEndereco('mailto:a@b.com'), null);
    assert.equal(validarEndereco('tel:+5591981056049'), null);
    assert.match(validarEndereco(''), /Informe o endereço/);
    assert.equal(validarEndereco('', { obrigatorio: false }), null);
    assert.match(validarEndereco('https://exemplo.com/minha pagina'), /espaços/);
    for (const ruim of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '//evil.com/x']) {
      assert.match(validarEndereco(ruim), /não aceito/, ruim);
    }
  });

});

// ---------------------------------------------------------------------------
// Normalização por tipo

describe('normalizarValor', () => {
  test('texto e meta: espaços colapsados', () => {
    assert.equal(normalizarValor({ tipo: 'texto' }, '  Quem\n  somos  '), 'Quem somos');
    assert.equal(normalizarValor({ tipo: 'meta' }, ' a   b '), 'a b');
    assert.equal(normalizarValor({ tipo: 'texto' }, undefined), '');
  });

  test('textolongo: mantém as quebras, limpa as pontas de cada linha e as linhas vazias das pontas', () => {
    assert.equal(normalizarValor({ tipo: 'textolongo' }, '\r\n  linha 1  \r\nlinha   2\n\n'), 'linha 1\nlinha 2');
    assert.equal(normalizarValor({ tipo: 'textolongo' }, 'a\n\nb'), 'a\n\nb');
  });

  test('html: SEMPRE sanitizado e em forma canônica', () => {
    const sujo = '<p style="color:red" onclick="x()">Oi <script>alert(1)</script><b>forte</b></p>\n\n<p>&nbsp;</p><img src=x onerror=alert(1)><div>solto</div>';
    const limpo = normalizarHtml(sujo, DOC);
    assert.equal(limpo, '<p>Oi <b>forte</b></p>solto');
    assert.doesNotMatch(limpo, /script|onclick|onerror|style|<img/);
    assert.equal(normalizarValor({ tipo: 'html' }, sujo, DOC), limpo);
    // Links: só href seguro; target _blank ganha rel.
    assert.equal(
      normalizarHtml('<p><a href="javascript:alert(1)">x</a> <a href="https://a.com" target="_blank" class="c">y</a></p>', DOC),
      '<p><a>x</a> <a href="https://a.com" target="_blank" rel="noopener noreferrer">y</a></p>',
    );
    // Quebras sobrando no fim do parágrafo e listas vazias somem.
    assert.equal(normalizarHtml('<p>texto<br><br></p><ul></ul><p> <br> </p>', DOC), '<p>texto</p>');
  });

  test('html: dois jeitos de escrever a mesma coisa dão o mesmo valor', () => {
    const a = '<p>Um</p>\n  <p>Dois</p>';
    const b = '<p>Um</p><p>Dois</p>';
    assert.ok(valoresIguais({ tipo: 'html' }, a, b, DOC));
    assert.ok(!valoresIguais({ tipo: 'html' }, a, '<p>Um</p>', DOC));
  });

  test('imagem, vídeo e link: objeto com as partes certas', () => {
    assert.deepEqual(normalizarValor({ tipo: 'imagem' }, { src: ' /img/a.jpg ', alt: '  Foto  da AMA ', extra: 1 }), { src: '/img/a.jpg', alt: 'Foto da AMA' });
    assert.deepEqual(normalizarValor({ tipo: 'imagem' }, 'texto'), { src: '', alt: '' });
    assert.deepEqual(normalizarValor({ tipo: 'video' }, { src: '/v.mp4' }), { src: '/v.mp4', poster: '' });
    assert.deepEqual(normalizarValor({ tipo: 'link' }, { href: 'wa.me/55', texto: ' Fale  conosco ' }), { href: 'https://wa.me/55', texto: 'Fale conosco' });
  });

  test('url completa o endereço; instagram vira o endereço canônico da publicação', () => {
    assert.equal(normalizarValor({ tipo: 'url' }, 'www.ama.org.br'), 'https://www.ama.org.br');
    assert.equal(
      normalizarValor({ tipo: 'instagram' }, 'https://instagram.com/reel/ABC123xyz/?igsh=abc'),
      'https://www.instagram.com/reel/ABC123xyz/',
    );
    assert.equal(normalizarValor({ tipo: 'instagram' }, ' qualquer coisa '), 'qualquer coisa');
  });

  test('lista: normaliza cada subcampo, descarta itens que não são objetos e campos desconhecidos', () => {
    const campo = { tipo: 'lista', campos: [{ campo: 'nome', tipo: 'texto' }, { campo: 'foto', tipo: 'imagem' }] };
    const valor = [{ nome: '  Ana ', foto: { src: '/a.jpg', alt: 'Ana' }, intruso: 'x' }, 'lixo', null, { nome: 'Bia' }];
    assert.deepEqual(normalizarValor(campo, valor), [
      { nome: 'Ana', foto: { src: '/a.jpg', alt: 'Ana' } },
      { nome: 'Bia', foto: { src: '', alt: '' } },
    ]);
    assert.deepEqual(normalizarValor(campo, 'não é lista'), []);
  });

  test('visível: só false oculta', () => {
    assert.equal(normalizarValor({ tipo: 'visivel' }, false), false);
    assert.equal(normalizarValor({ tipo: 'visivel' }, true), true);
    assert.equal(normalizarValor({ tipo: 'visivel' }, undefined), true);
  });
});

// ---------------------------------------------------------------------------
// Valor efetivo (o que o site mostra hoje)

describe('valorEfetivo', () => {
  test('sem linha no banco → padrão do template', () => {
    const campo = { chave: 'x', tipo: 'texto', padrao: 'Padrão' };
    assert.equal(valorEfetivo(campo, undefined), 'Padrão');
    assert.equal(valorEfetivo(campo, { valor: 'Salvo' }), 'Salvo');
    assert.equal(valorEfetivo(campo, { valor: 42 }), 'Padrão'); // formato errado: o motor mantém o padrão
  });

  test('imagem com endereço inseguro → padrão inteiro (como o motor faz)', () => {
    const campo = { chave: 'x', tipo: 'imagem', padrao: { src: '/img/a.jpg', alt: 'A' } };
    assert.deepEqual(valorEfetivo(campo, { valor: { src: 'javascript:alert(1)', alt: 'B' } }), { src: '/img/a.jpg', alt: 'A' });
    assert.deepEqual(valorEfetivo(campo, { valor: { alt: 'Só o texto' } }), { src: '/img/a.jpg', alt: 'Só o texto' });
  });

  test('vídeo com poster "" = sem capa; link sem texto mantém o texto do padrão', () => {
    const video = { chave: 'v', tipo: 'video', padrao: { src: '/v.mp4', poster: '/p.jpg' } };
    assert.deepEqual(valorEfetivo(video, { valor: { src: '/n.mp4', poster: '' } }), { src: '/n.mp4', poster: '' });
    const link = { chave: 'l', tipo: 'link', padrao: { href: '/loja/', texto: 'Conhecer a loja' } };
    assert.deepEqual(valorEfetivo(link, { valor: { href: '/loja/?c=1', texto: '' } }), { href: '/loja/?c=1', texto: 'Conhecer a loja' });
  });

  test('instagram inválido no banco → padrão; lista sem itens aproveitáveis → padrão', () => {
    const insta = { chave: 'i', tipo: 'instagram', padrao: 'https://www.instagram.com/p/AAA111/' };
    assert.equal(valorEfetivo(insta, { valor: 'https://exemplo.com' }), insta.padrao);
    const lista = { chave: 'l', tipo: 'lista', campos: [{ campo: 'nome', tipo: 'texto' }], padrao: [{ nome: 'A' }] };
    assert.deepEqual(valorEfetivo(lista, { valor: ['x', 1] }), [{ nome: 'A' }]);
    assert.deepEqual(valorEfetivo(lista, { valor: [] }), []); // lista vazia é válida (remove todos)
    assert.deepEqual(valorEfetivo(lista, { valor: [{ nome: 'B' }, {}] }), [{ nome: 'B' }, { nome: 'A' }]);
  });

  test('visibilidade', () => {
    const campo = { chave: 'grupo.x.visivel', tipo: 'visivel', padrao: true };
    assert.equal(valorEfetivo(campo, undefined), true);
    assert.equal(valorEfetivo(campo, { valor: false }), false);
  });
});

// ---------------------------------------------------------------------------
// Montagem dos valores alterados

describe('montarAlteracoes', () => {
  test('nada mudou em nenhum grupo do template → nada para salvar', () => {
    for (const grupo of esquemaDaHome().grupos) {
      const campos = grupo.campos;
      const r = montarAlteracoes({ campos, rascunho: rascunhoDe(campos, new Map()), salvos: new Map(), documento: DOC });
      assert.equal(r.total, 0, grupo.id);
    }
  });

  test('só as chaves alteradas, com o valor normalizado', () => {
    const titulo = campoDaHome('quem-somos.titulo');
    const texto = campoDaHome('quem-somos.texto');
    const video = campoDaHome('quem-somos.video');
    const campos = [titulo, video, texto];
    const rascunho = rascunhoDe(campos, new Map(), { 'quem-somos.titulo': '  Quem   somos nós ' });
    const r = montarAlteracoes({ campos, rascunho, salvos: new Map(), documento: DOC });
    assert.deepEqual(r, { salvar: [{ chave: 'quem-somos.titulo', valor: 'Quem somos nós' }], apagar: [], total: 1 });
  });

  test('mudança só de espaços ou de formatação equivalente não conta', () => {
    const texto = campoDaHome('quem-somos.texto');
    const rascunho = new Map([[texto.chave, `\n  ${texto.padrao.replace(/<\/p><p>/g, '</p>\n\n<p>')}  `]]);
    assert.equal(montarAlteracoes({ campos: [texto], rascunho, salvos: new Map(), documento: DOC }).total, 0);
  });

  test('voltar ao padrão com linha no banco → apagar a linha', () => {
    const titulo = campoDaHome('quem-somos.titulo');
    const salvos = new Map([[titulo.chave, { valor: 'Outro título' }]]);
    const rascunho = new Map([[titulo.chave, titulo.padrao]]);
    assert.deepEqual(montarAlteracoes({ campos: [titulo], rascunho, salvos, documento: DOC }),
      { salvar: [], apagar: ['quem-somos.titulo'], total: 1 });
  });

  test('linha no banco igual ao rascunho → nada; diferente → upsert', () => {
    const titulo = campoDaHome('quem-somos.titulo');
    const salvos = new Map([[titulo.chave, { valor: 'Outro título' }]]);
    assert.equal(montarAlteracoes({ campos: [titulo], rascunho: rascunhoDe([titulo], salvos), salvos, documento: DOC }).total, 0);
    const r = montarAlteracoes({ campos: [titulo], rascunho: new Map([[titulo.chave, 'Terceiro']]), salvos, documento: DOC });
    assert.deepEqual(r.salvar, [{ chave: 'quem-somos.titulo', valor: 'Terceiro' }]);
  });

  test('ocultar e mostrar de novo uma seção', () => {
    const vis = { chave: chaveVisibilidade('depoimentos'), tipo: 'visivel', padrao: true };
    const ocultar = montarAlteracoes({ campos: [vis], rascunho: new Map([[vis.chave, false]]), salvos: new Map(), documento: DOC });
    assert.deepEqual(ocultar.salvar, [{ chave: 'grupo.depoimentos.visivel', valor: false }]);
    const salvos = new Map([[vis.chave, { valor: false }]]);
    const mostrar = montarAlteracoes({ campos: [vis], rascunho: new Map([[vis.chave, true]]), salvos, documento: DOC });
    assert.deepEqual(mostrar, { salvar: [], apagar: ['grupo.depoimentos.visivel'], total: 1 });
  });

  test('lista: editar um depoimento salva a lista inteira normalizada', () => {
    const lista = campoDaHome('depoimentos.itens');
    const itens = clonarValor(lista.padrao);
    itens[1].nome = '  Breno  Aquino Jr. ';
    const r = montarAlteracoes({ campos: [lista], rascunho: new Map([[lista.chave, itens]]), salvos: new Map(), documento: DOC });
    assert.equal(r.salvar.length, 1);
    assert.equal(r.salvar[0].valor.length, 3);
    assert.equal(r.salvar[0].valor[1].nome, 'Breno Aquino Jr.');
    assert.deepEqual(r.salvar[0].valor[0], normalizarValor(lista, lista.padrao, DOC)[0]);
  });

  test('o valor salvo, aplicado no template, mostra a mudança (e o resto continua igual)', () => {
    const lista = campoDaHome('depoimentos.itens');
    const titulo = campoDaHome('quem-somos.titulo');
    const itens = moverItem(clonarValor(lista.padrao), 2, 0);
    itens[0].texto = 'Linha 1\nLinha 2';
    const rascunho = new Map([[lista.chave, itens], [titulo.chave, 'Quem somos (teste)']]);
    const r = montarAlteracoes({ campos: [titulo, lista], rascunho, salvos: new Map(), documento: DOC });
    const doc = analisar(HOME);
    aplicarConteudo(doc, Object.fromEntries(r.salvar.map((s) => [s.chave, s.valor])));
    assert.equal(doc.querySelector('[data-cms="quem-somos.titulo"]').textContent, 'Quem somos (teste)');
    const nomes = Array.from(doc.querySelectorAll('.depoimento [data-cms-campo="nome"]'), (e) => e.textContent);
    assert.deepEqual(nomes, ['Maria Rita', 'Doraci Silva', 'Breno Aquino']);
    assert.equal(lerValor(doc.querySelector('.depoimento [data-cms-campo="texto"]'), 'textolongo'), 'Linha 1\nLinha 2');
    assert.equal(doc.querySelector('[data-cms="projetos.titulo"]').textContent, 'Nossos projetos');
  });
});

// ---------------------------------------------------------------------------
// Validação

describe('validarValor', () => {
  test('os padrões do template são todos válidos', () => {
    for (const grupo of esquemaDaHome().grupos) {
      for (const campo of grupo.campos) {
        assert.deepEqual(validarValor(campo, normalizarValor(campo, campo.padrao, DOC)), [], campo.chave);
      }
    }
  });

  test('texto vazio ou longo demais', () => {
    assert.match(validarValor({ tipo: 'texto' }, '')[0].mensagem, /não pode ficar vazio/);
    assert.match(validarValor({ tipo: 'texto' }, 'x'.repeat(501))[0].mensagem, /no máximo 500/);
    assert.deepEqual(validarValor({ tipo: 'texto' }, 'ok'), []);
    assert.match(validarValor({ tipo: 'html' }, '')[0].mensagem, /não pode ficar vazio/);
  });

  test('imagem: precisa de endereço seguro e de texto alternativo', () => {
    assert.equal(validarValor({ tipo: 'imagem' }, { src: '', alt: 'x' })[0].parte, 'src');
    assert.equal(validarValor({ tipo: 'imagem' }, { src: 'javascript:alert(1)', alt: 'x' })[0].parte, 'src');
    const semAlt = validarValor({ tipo: 'imagem' }, { src: '/img/a.jpg', alt: '' });
    assert.equal(semAlt[0].parte, 'alt');
    assert.match(semAlt[0].mensagem, /texto alternativo/);
    assert.deepEqual(validarValor({ tipo: 'imagem' }, { src: '/img/a.jpg', alt: 'Foto' }), []);
  });

  test('vídeo: endereço obrigatório; capa opcional mas segura', () => {
    assert.equal(validarValor({ tipo: 'video' }, { src: '', poster: '' })[0].parte, 'src');
    assert.deepEqual(validarValor({ tipo: 'video' }, { src: '/v.mp4', poster: '' }), []);
    assert.equal(validarValor({ tipo: 'video' }, { src: '/v.mp4', poster: 'data:image/png;base64,AA' })[0].parte, 'poster');
  });

  test('link: endereço seguro; texto obrigatório só se o padrão tem texto', () => {
    const comTexto = { tipo: 'link', padrao: { href: '/loja/', texto: 'Loja' } };
    assert.equal(validarValor(comTexto, { href: 'javascript:x', texto: 'Loja' })[0].parte, 'href');
    assert.equal(validarValor(comTexto, { href: '/loja/', texto: '' })[0].parte, 'texto');
    const semTexto = { tipo: 'link', padrao: { href: '/', texto: '' } };
    assert.deepEqual(validarValor(semTexto, { href: 'https://wa.me/55', texto: '' }), []);
  });

  test('instagram: só endereço de publicação', () => {
    assert.match(validarValor({ tipo: 'instagram' }, 'https://www.instagram.com/oscdemulheres/')[0].mensagem, /Copiar link/);
    assert.deepEqual(validarValor({ tipo: 'instagram' }, 'https://www.instagram.com/p/ABC123/'), []);
  });

  test('meta de imagem (og:image) precisa de endereço seguro', () => {
    const og = { tipo: 'meta', chave: 'seo.og-imagem' };
    assert.deepEqual(validarValor(og, '/img/logo-ama.png'), []);
    assert.deepEqual(validarValor(og, 'https://ama.org.br/img/logo.png'), []);
    assert.match(validarValor(og, 'javascript:alert(1)')[0].mensagem, /Escolher imagem/);
    assert.deepEqual(validarValor({ tipo: 'meta', chave: 'seo.descricao' }, 'javascript: texto qualquer'), []);
  });

  test('lista: erros apontam o item e o subcampo; limite de itens', () => {
    const lista = campoDaHome('depoimentos.itens');
    const itens = clonarValor(lista.padrao);
    itens[2].nome = '';
    itens[2].foto = { src: '/img/x.png', alt: '' };
    const erros = validarValor(lista, normalizarValor(lista, itens, DOC));
    assert.deepEqual(erros.map((e) => [e.indice, e.campo, e.parte]), [[2, 'foto', 'alt'], [2, 'nome', null]]);
    const muitos = Array.from({ length: LIMITE_ITENS + 1 }, () => clonarValor(lista.padrao[0]));
    assert.match(validarValor(lista, muitos)[0].mensagem, /no máximo 200/);
  });

  test('conteúdo grande demais para uma linha do banco', () => {
    const erros = validarValor({ tipo: 'textolongo' }, 'á'.repeat(100_000));
    assert.match(erros[0].mensagem, /grande demais/);
  });
});

// ---------------------------------------------------------------------------
// Operações de lista

describe('operações de lista', () => {
  const base = [{ n: 1 }, { n: 2 }, { n: 3 }];

  test('adicionar copia o item (o molde não é compartilhado)', () => {
    const molde = { nome: 'A', foto: { src: '/a.jpg', alt: 'A' } };
    const lista = adicionarItem(base, molde);
    assert.equal(lista.length, 4);
    lista[3].foto.src = '/b.jpg';
    assert.equal(molde.foto.src, '/a.jpg');
    assert.equal(base.length, 3);
    assert.deepEqual(adicionarItem(undefined, { a: 1 }), [{ a: 1 }]);
  });

  test('remover e mover devolvem listas novas', () => {
    assert.deepEqual(removerItem(base, 0).map((i) => i.n), [2, 3]);
    assert.deepEqual(removerItem(base, 5).map((i) => i.n), [1, 2, 3]);
    assert.deepEqual(moverItem(base, 0, 2).map((i) => i.n), [2, 3, 1]);
    assert.deepEqual(moverItem(base, 2, 0).map((i) => i.n), [3, 1, 2]);
    assert.deepEqual(moverItem(base, 1, 99).map((i) => i.n), [1, 3, 2]);
    assert.deepEqual(moverItem(base, -1, 0).map((i) => i.n), [1, 2, 3]);
    assert.deepEqual(base.map((i) => i.n), [1, 2, 3]);
  });

  test('item novo nasce com os valores do molde (primeiro item do template)', () => {
    const lista = campoDaHome('depoimentos.itens');
    const molde = valoresDoMolde(lista);
    assert.deepEqual(Object.keys(molde).sort(), ['foto', 'nome', 'texto']);
    assert.equal(molde.nome, 'Doraci Silva');
    assert.deepEqual(molde.foto, { src: '/img/avatar-usuario.png', alt: 'Doraci Silva' });
    molde.foto.alt = 'mudado';
    assert.equal(lista.padrao[0].foto.alt, 'Doraci Silva');
    // Lista sem itens no padrão: valores vazios por tipo.
    assert.deepEqual(valoresDoMolde({ padrao: [], campos: [{ campo: 'a', tipo: 'imagem' }, { campo: 'b', tipo: 'link' }, { campo: 'c', tipo: 'texto' }] }),
      { a: { src: '', alt: '' }, b: { href: '', texto: '' }, c: '' });
  });

  test('resumoDoItem: título e detalhe para o cartão recolhido', () => {
    const dep = campoDaHome('depoimentos.itens');
    const r = resumoDoItem(dep.padrao[0], dep.campos, 0, dep.itemRotulo);
    assert.equal(r.titulo, 'Doraci Silva');
    assert.match(r.detalhe, /^O curso de artesanato/);
    assert.ok(r.detalhe.length <= 90);
    assert.equal(r.imagem, '/img/avatar-usuario.png');

    const menu = campoDaHome('cabecalho.menu');
    assert.deepEqual(resumoDoItem(menu.padrao[3], menu.campos, 3, menu.itemRotulo), { titulo: 'Cosméticos', detalhe: '/loja/', imagem: '' });

    const logos = campoDaHome('parcerias.logos');
    assert.equal(resumoDoItem(logos.padrao[2], logos.campos, 2, logos.itemRotulo).titulo, 'SENAR');

    const posts = campoDaHome('postagens.publicacoes');
    const p = resumoDoItem(posts.padrao[0], posts.campos, 0, posts.itemRotulo);
    assert.equal(p.titulo, 'Publicação 1');
    assert.match(p.detalhe, /^https:\/\/www\.instagram\.com\/reel\//);
  });
});

// ---------------------------------------------------------------------------
// Visão geral e pré-visualização

describe('visão geral dos grupos', () => {
  test('WhatsApp: número digitado + mensagem padrão viram o link wa.me', () => {
    assert.equal(numeroWhatsappDigitado('(91) 98105-6049'), '5591981056049');
    assert.equal(numeroWhatsappDigitado('+55 91 98105-6049'), '5591981056049');
    assert.equal(numeroWhatsappDigitado('9132221234'), '559132221234');
    assert.equal(numeroWhatsappDigitado('1234'), '');
    assert.equal(numeroWhatsappDigitado(''), '');
    assert.equal(numeroWhatsappDigitado('5491981056049'), '', 'outro país');
    assert.equal(formatarNumeroWhatsapp('5591981056049'), '(91) 98105-6049');
    assert.equal(formatarNumeroWhatsapp('559132221234'), '(91) 3222-1234');
    assert.equal(montarLinkWhatsapp('(91) 98105-6049', ''), 'https://wa.me/5591981056049');
    assert.equal(montarLinkWhatsapp('91981056049', ' Olá!  Quero saber mais '), 'https://wa.me/5591981056049?text=Ol%C3%A1!%20Quero%20saber%20mais');
    assert.equal(montarLinkWhatsapp('123', 'oi'), '');
    assert.equal(numeroDoLinkWhatsapp('https://wa.me/5591981056049?text=oi'), '5591981056049');
    assert.equal(numeroDoLinkWhatsapp('https://exemplo.com/5591981056049'), '');
    assert.equal(mensagemDoLinkWhatsapp(montarLinkWhatsapp('91981056049', 'Olá, tudo bem?')), 'Olá, tudo bem?');
    assert.equal(mensagemDoLinkWhatsapp('https://wa.me/5591981056049'), '');
    assert.match(validarValor({ tipo: 'link', editor: 'whatsapp', padrao: { href: '', texto: 'Falar' } }, { href: '', texto: 'Falar' })[0].mensagem, /número do WhatsApp/);
    assert.deepEqual(validarValor({ tipo: 'link', editor: 'whatsapp', padrao: { href: '', texto: 'Falar' } }, { href: 'https://wa.me/5591981056049', texto: 'Falar' }), []);
  });

  test('Identidade vem primeiro, SEO vai para o fim; a ordem dos demais é a do template', () => {
    const ids = ordenarGrupos(esquemaDaHome().grupos).map((g) => g.id);
    assert.equal(ids.at(-1), 'seo');
    assert.deepEqual(ids.slice(0, 4), ['identidade', 'cabecalho', 'quem-somos', 'postagens']);
  });

  test('resumo: campos e visibilidade', () => {
    const salvos = mapaDeLinhas([
      { chave: 'quem-somos.titulo', valor: 'X', atualizado_em: '2026-10-14T10:00:00Z' },
      { chave: 'quem-somos.texto', valor: '<p>Y</p>', atualizado_em: '2026-10-15T10:00:00Z' },
      { chave: 'grupo.depoimentos.visivel', valor: false, atualizado_em: '2026-10-13T10:00:00Z' },
      { chave: 'grupo.cabecalho.visivel', valor: false }, // grupo não ocultável: ignorado
    ]);
    const resumos = new Map(resumirGrupos(esquemaDaHome(), salvos).map((r) => [r.id, r]));
    const qs = resumos.get('quem-somos');
    assert.equal(qs.totalCampos, 3);
    assert.equal(qs.visivel, true);
    assert.equal(qs.ocultavel, true);
    const dep = resumos.get('depoimentos');
    assert.equal(dep.visivel, false);
    assert.equal(resumos.get('cabecalho').visivel, true);
    assert.equal(resumos.get('cabecalho').ocultavel, false);
    assert.deepEqual(resumos.get('whatsapp').rotulosCampos, ['WhatsApp do site']);
  });
});
