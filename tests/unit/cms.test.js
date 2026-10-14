// Testes do motor do CMS (public/js/cms/aplicar.js), contrato em docs/ARQUITETURA.md §5.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import * as cms from '../../public/js/cms/aplicar.js';

const {
  TIPOS_CAMPO, extrairEsquema, aplicarConteudo, lerValor,
  sanitizarHtml, urlSegura, instagramParaEmbed, embedParaInstagram
} = cms;

const lerArquivo = (caminho) => readFileSync(new URL(caminho, import.meta.url), 'utf8');
const FIXTURE = lerArquivo('./fixtures/cms-completo.html');
const HOME = lerArquivo('../../templates/home.html');

function montar(conteudo) {
  const html = /^\s*<!doctype/i.test(conteudo)
    ? conteudo
    : `<!doctype html><html><head></head><body>${conteudo}</body></html>`;
  return parseHTML(html).document;
}

const serializar = (doc) => doc.toString();
const reparsear = (doc) => montar(serializar(doc));
const $ = (raiz, seletor) => raiz.querySelector(seletor);
const $$ = (raiz, seletor) => Array.from(raiz.querySelectorAll(seletor));
const elementosFilhos = (el) => Array.from(el.childNodes).filter((no) => no.nodeType === 1);

// Aplica e confirma que o HTML não mudou (padrão mantido).
function assertSemMudanca(doc, conteudo, mensagem) {
  const antes = serializar(doc);
  assert.doesNotThrow(() => aplicarConteudo(doc, conteudo), mensagem);
  assert.equal(serializar(doc), antes, mensagem);
}

// Valores padrão do fixture, como o painel deve vê-los.
const PADROES = {
  'seo.titulo': 'AMA - Associação de Mulheres na Amazônia',
  'seo.descricao': 'Descrição padrão da AMA.',
  'cabecalho.logo-link': '/',
  'cabecalho.logo': { src: '/img/logo.png', alt: 'Logo da AMA' },
  'cabecalho.menu': [
    { link: { href: '#inicio', texto: 'Início' } },
    { link: { href: '#quem-somos', texto: 'Quem somos' } },
    { link: { href: '/loja/', texto: 'Loja' } }
  ],
  'quem-somos.titulo': 'Quem somos',
  'quem-somos.texto': 'Primeira linha\nSegunda linha',
  'quem-somos.corpo': '<p>Somos uma <strong>associação</strong> de mulheres.</p>',
  'quem-somos.foto': { src: '/img/sobre.jpg', alt: 'Mulheres da AMA reunidas' },
  'quem-somos.video': { src: '/img/sobre.mp4', poster: '/img/sobre-poster.jpg' },
  'quem-somos.botao': { href: '/contato', texto: 'Fale conosco' },
  'postagens.post-1': 'https://www.instagram.com/p/AAA111bbb/',
  'postagens.perfil': 'https://www.instagram.com/ama/',
  'depoimentos.titulo': 'Depoimentos',
  'depoimentos.itens': [
    { foto: { src: '/img/maria.jpg', alt: 'Maria' }, texto: 'A AMA mudou\na minha vida.', nome: 'Maria' },
    { foto: { src: '/img/joana.jpg', alt: 'Joana' }, texto: 'Aprendi um ofício.', nome: 'Joana' }
  ],
  'rodape.direitos': '© AMA. Todos os direitos reservados.',
  'rodape.whatsapp': { href: 'https://wa.me/5591999999999', texto: 'Fale pelo WhatsApp' },
  'aviso': 'Aviso geral do site'
};

// Valores novos (já na forma canônica, para a ida e volta).
const NOVOS = {
  'seo.titulo': 'Novo título da AMA',
  'seo.descricao': 'Nova descrição "com aspas" & símbolos <ok>',
  'cabecalho.logo-link': '/inicio',
  'cabecalho.logo': { src: 'https://cdn.exemplo.com/logo.svg', alt: 'Novo logo' },
  'cabecalho.menu': [
    { link: { href: '/loja/', texto: 'Loja' } },
    { link: { href: '#contato', texto: 'Contato' } }
  ],
  'quem-somos.titulo': 'Quem nós somos',
  'quem-somos.texto': 'Linha A\nLinha B\n\nLinha C',
  'quem-somos.corpo': '<p>Novo <em>corpo</em> com <a href="https://ama.org.br" target="_blank" rel="noopener noreferrer">link</a>.</p><ul><li>um</li></ul>',
  'quem-somos.foto': { src: '/img/nova.jpg', alt: 'Nova foto' },
  'quem-somos.video': { src: '/img/novo.mp4', poster: '/img/novo-poster.jpg' },
  'quem-somos.botao': { href: 'mailto:contato@ama.org.br', texto: 'Escreva para nós' },
  'postagens.post-1': 'https://www.instagram.com/reel/CCC333ddd/',
  'postagens.perfil': 'https://www.instagram.com/ama.oficial/',
  'depoimentos.titulo': 'O que dizem',
  'depoimentos.itens': [
    { foto: { src: '/img/ana.jpg', alt: 'Ana' }, texto: 'Primeira\nSegunda', nome: 'Ana' },
    { foto: { src: '/img/joana.jpg', alt: 'Joana' }, texto: 'Aprendi um ofício.', nome: 'Joana' },
    { foto: { src: '/img/bia.jpg', alt: 'Bia' }, texto: 'Terceira', nome: 'Bia' }
  ],
  'rodape.direitos': '© 2026 AMA',
  'rodape.whatsapp': { href: 'tel:+5591988887777', texto: 'Ligue para nós' },
  'aviso': 'Aviso novo'
};

// Tudo o que um painel comprometido poderia mandar.
const MALICIOSOS = {
  'seo.titulo': '</title><script>alert(1)</script>',
  'seo.descricao': '"><script>alert(1)</script>',
  'cabecalho.logo-link': 'javascript:alert(1)',
  'cabecalho.logo': { src: 'javascript:alert(1)', alt: 'x" onerror="alert(1)' },
  'cabecalho.menu': [
    { link: { href: ' JAVASCRIPT:alert(1)', texto: '<img src=x onerror=alert(1)>' } },
    { link: { href: '/ok" onmouseover="alert(1)', texto: '<script>alert(1)</script>' } }
  ],
  'quem-somos.titulo': '<script>alert(1)</script>',
  'quem-somos.texto': '<img src=x onerror=alert(1)>\n<script>alert(2)</script>',
  'quem-somos.corpo': '<img src=x onerror=alert(1)><script>alert(1)</script>' +
    '<a href="javascript:alert(1)" onclick="alert(1)">x</a><iframe src="javascript:alert(1)"></iframe>' +
    '<svg onload=alert(1)><circle></circle></svg><p style="x" onmouseover="alert(1)">ok</p>',
  'quem-somos.foto': { src: 'data:image/svg+xml,<svg onload=alert(1)>', alt: 'x' },
  'quem-somos.video': { src: 'vbscript:msgbox(1)', poster: '/ok.jpg' },
  'quem-somos.botao': { href: '\tjavascript:alert(1)', texto: '<b>x</b>' },
  'postagens.post-1': 'javascript:alert(1)//instagram.com/p/AAA111bbb/',
  'postagens.perfil': 'java\nscript:alert(1)',
  'depoimentos.titulo': '<iframe src="javascript:alert(1)">',
  'depoimentos.itens': [
    { foto: { src: 'javascript&colon;alert(1)', alt: 'a' }, texto: '<svg onload=alert(1)>', nome: '"><img src=x onerror=alert(1)>' },
    { foto: { src: '/img/ok.jpg', alt: '" onerror="alert(1)" x="' }, nome: '<script>alert(1)</script>' }
  ],
  'rodape.direitos': '<a href="javascript:alert(1)">clique</a>',
  'rodape.whatsapp': { href: '&#106;avascript:alert(1)', texto: 'oi' },
  'aviso': '<script>alert(1)</script>'
};

const TAGS_SANITIZADAS = new Set([
  'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'h3', 'h4', 'span'
]);

// Confere a estrutura do HTML sanitizado reanalisando-o.
function assertHtmlLimpo(saida, entrada) {
  const caixa = montar(`<div id="caixa">${saida}</div>`).getElementById('caixa');
  for (const el of $$(caixa, '*')) {
    const tag = el.localName;
    assert.ok(TAGS_SANITIZADAS.has(tag), `tag <${tag}> não permitida em ${JSON.stringify(entrada)} → ${saida}`);
    for (const nome of el.getAttributeNames()) {
      const permitido = tag === 'a' && ['href', 'target', 'rel'].includes(nome);
      assert.ok(permitido, `atributo ${nome} em <${tag}> para ${JSON.stringify(entrada)} → ${saida}`);
    }
    if (tag === 'a' && el.hasAttribute('href')) {
      assert.notEqual(urlSegura(el.getAttribute('href')), null, `href inseguro: ${saida}`);
    }
    if (tag === 'a' && el.hasAttribute('target')) {
      assert.equal(el.getAttribute('target'), '_blank');
      assert.equal(el.getAttribute('rel'), 'noopener noreferrer');
    }
  }
  assert.doesNotMatch(saida, /<\s*(script|style|iframe|object|embed|svg|math|template|noscript|img)/i);
}

// Confere que um documento renderizado não tem nada executável além do que o template já tinha.
function assertDocumentoSeguro(doc, scriptsEsperados) {
  const reanalisado = reparsear(doc);
  assert.equal($$(reanalisado, 'script').length, scriptsEsperados, 'quantidade de <script>');
  assert.equal($$(reanalisado, 'title').length, 1, 'quantidade de <title>');
  for (const tag of ['svg', 'math', 'object', 'embed', 'base', 'form']) {
    assert.equal($$(reanalisado, tag).length, 0, `<${tag}> inesperado`);
  }
  for (const el of $$(reanalisado, '*')) {
    for (const nome of el.getAttributeNames()) {
      assert.ok(!/^on/i.test(nome), `atributo ${nome} em <${el.localName}>`);
      if (['href', 'src', 'poster', 'action', 'formaction'].includes(nome)) {
        assert.notEqual(urlSegura(el.getAttribute(nome)), null, `${nome}="${el.getAttribute(nome)}" em <${el.localName}>`);
        assert.ok(!/script:|data:/i.test(el.getAttribute(nome)), `${nome}="${el.getAttribute(nome)}"`);
      }
    }
  }
}

// ---------------------------------------------------------------------------

describe('contrato do módulo', () => {
  test('exporta exatamente os nomes do contrato (§5.4)', () => {
    assert.deepEqual(Object.keys(cms).sort(), [
      'TIPOS_CAMPO', 'aplicarConteudo', 'embedParaInstagram', 'extrairEsquema',
      'instagramParaEmbed', 'lerValor', 'sanitizarHtml', 'urlSegura'
    ]);
  });

  test('assinaturas das funções', () => {
    const aridade = {
      extrairEsquema: 1, aplicarConteudo: 2, lerValor: 2, sanitizarHtml: 2,
      urlSegura: 1, instagramParaEmbed: 1, embedParaInstagram: 1
    };
    for (const [nome, n] of Object.entries(aridade)) {
      assert.equal(typeof cms[nome], 'function', nome);
      assert.equal(cms[nome].length, n, `${nome}.length`);
    }
  });

  test('TIPOS_CAMPO lista os tipos da tabela 5.3 e não pode ser alterado', () => {
    assert.deepEqual([...TIPOS_CAMPO], [
      'texto', 'textolongo', 'html', 'imagem', 'video', 'link', 'url', 'instagram', 'meta', 'lista'
    ]);
    assert.ok(Object.isFrozen(TIPOS_CAMPO));
  });

  test('o código-fonte não tem caracteres invisíveis literais (use escapes como \\u00a0)', () => {
    for (const caminho of ['../../public/js/cms/aplicar.js', './cms.test.js']) {
      const invisiveis = lerArquivo(caminho).match(/[\u00a0\u00ad\u200b-\u200f\u2028\u2029\u2060\ufeff]/g);
      assert.equal(invisiveis, null, caminho);
    }
  });
});

describe('urlSegura', () => {
  test('aceita relativos, http, https, mailto e tel', () => {
    const aceitas = [
      '/x', '/img/foto.jpg', './x', '../x', 'x/y.jpg', 'foto.jpg', '#ancora', '#', '?q=1', '?q',
      'http://exemplo.com', 'https://exemplo.com/a/b?c=1&d=2#e', 'HTTPS://EXEMPLO.COM/X',
      'mailto:contato@ama.org.br', 'MailTo:contato@ama.org.br', 'tel:+5591999999999',
      'x/y:z', '/a?b=javascript:alert(1)', '#javascript:x'
    ];
    for (const url of aceitas) assert.equal(urlSegura(url), url, url);
  });

  test('tira espaços das pontas e devolve a URL limpa', () => {
    assert.equal(urlSegura('  https://exemplo.com/x  '), 'https://exemplo.com/x');
    assert.equal(urlSegura('\n/img/a.jpg\t'), '/img/a.jpg');
    assert.equal(urlSegura('https://exe\tmplo.com/\nx'), 'https://exemplo.com/x');
  });

  test('rejeita outros esquemas, inclusive disfarçados', () => {
    const rejeitadas = [
      'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)',
      '\tjavascript:alert(1)', '\njavascript:alert(1)', '\u0000javascript:alert(1)', '\u0001javascript:alert(1)',
      '\u001fjavascript:alert(1)', '\u00a0javascript:alert(1)', '\ufeffjavascript:alert(1)',
      'java\tscript:alert(1)', 'java\nscript:alert(1)', 'java\rscript:alert(1)', 'java\u0000script:alert(1)',
      'javascript\u0000:alert(1)', 'javascript :alert(1)',
      'javascript&colon;alert(1)', '&#106;avascript:alert(1)', 'jav&#x09;ascript:alert(1)',
      'javascript&#58;alert(1)', '&#x6A;avascript&#x3A;alert(1)',
      'data:text/html,<script>alert(1)</script>', 'DATA:image/png;base64,AAAA', ' data:image/svg+xml,<svg>',
      'vbscript:msgbox(1)', 'VBScript:msgbox(1)', 'file:///etc/passwd', 'ftp://exemplo.com/x',
      'blob:https://exemplo.com/1', 'about:blank', 'livescript:x', 'ｊavascript:alert(1)',
      '//evil.com/x.js', '\\\\evil.com', '/\\evil.com', '\\/evil.com',
      '', '   ', '\t\n'
    ];
    for (const url of rejeitadas) assert.equal(urlSegura(url), null, JSON.stringify(url));
  });

  test('não lança e devolve null para o que não é string', () => {
    for (const valor of [null, undefined, 42, true, {}, [], ['/x'], { toString: () => '/x' }]) {
      assert.equal(urlSegura(valor), null);
    }
  });

  test('limite de 4096 caracteres', () => {
    const limite = '/' + 'a'.repeat(4095);
    assert.equal(urlSegura(limite), limite);
    assert.equal(urlSegura(limite + 'a'), null);
    assert.equal(urlSegura(`  ${limite}  `), limite);
    const longa = 'https://www.instagram.com/p/ABC123xyz/?x=' + 'a'.repeat(4096);
    assert.equal(instagramParaEmbed(longa), null);
    assert.equal(embedParaInstagram(longa), null);
  });
});

describe('Instagram', () => {
  test('instagramParaEmbed normaliza p, reel e tv, com ou sem www, query, fragmento e barra final', () => {
    const casos = [
      ['https://www.instagram.com/p/ABC123xyz/', 'https://www.instagram.com/p/ABC123xyz/embed/captioned/'],
      ['https://instagram.com/p/ABC123xyz', 'https://www.instagram.com/p/ABC123xyz/embed/captioned/'],
      ['https://www.instagram.com/p/ABC123xyz/?utm_source=ig_web_copy_link&igsh=abc', 'https://www.instagram.com/p/ABC123xyz/embed/captioned/'],
      ['https://www.instagram.com/p/ABC123xyz#comentarios', 'https://www.instagram.com/p/ABC123xyz/embed/captioned/'],
      ['https://www.instagram.com/reel/C0dE_-9xY/', 'https://www.instagram.com/reel/C0dE_-9xY/embed/captioned/'],
      ['https://instagram.com/reel/C0dE_-9xY?igsh=1', 'https://www.instagram.com/reel/C0dE_-9xY/embed/captioned/'],
      ['https://www.instagram.com/tv/XYZ987abc/', 'https://www.instagram.com/tv/XYZ987abc/embed/captioned/'],
      ['https://instagram.com/tv/XYZ987abc', 'https://www.instagram.com/tv/XYZ987abc/embed/captioned/'],
      ['https://www.instagram.com/p/ABC123xyz/embed/captioned/', 'https://www.instagram.com/p/ABC123xyz/embed/captioned/'],
      ['  https://www.instagram.com/p/ABC123xyz/  ', 'https://www.instagram.com/p/ABC123xyz/embed/captioned/']
    ];
    for (const [url, esperado] of casos) assert.equal(instagramParaEmbed(url), esperado, url);
  });

  test('instagramParaEmbed devolve null para URLs inválidas', () => {
    const invalidas = [
      'https://www.instagram.com/', 'https://www.instagram.com/ama/', 'https://www.instagram.com/p/',
      'https://www.instagram.com/stories/ama/123/', 'https://www.instagram.com/explore/tags/ama/',
      'https://evil.com/p/ABC123xyz/', 'https://instagram.com.evil.com/p/ABC123xyz/',
      'https://evil.com/instagram.com/p/ABC123xyz/', 'https://evilinstagram.com/p/ABC123xyz/',
      'https://usuario@evil.com/p/ABC123xyz/', 'https://www.instagram.com:8443/p/ABC123xyz/',
      'javascript:alert(1)//instagram.com/p/ABC123xyz/', 'ftp://instagram.com/p/ABC123xyz/',
      'data:text/html,instagram.com/p/ABC123xyz/', 'https://www.instagram.com/p/AB"C/',
      'https://www.instagram.com/p/<script>/', 'não é url', '', '   ', null, undefined, 42, {}
    ];
    for (const url of invalidas) assert.equal(instagramParaEmbed(url), null, String(url));
  });

  test('embedParaInstagram faz o caminho inverso', () => {
    assert.equal(embedParaInstagram('https://www.instagram.com/p/ABC123xyz/embed/captioned/'), 'https://www.instagram.com/p/ABC123xyz/');
    assert.equal(embedParaInstagram('https://www.instagram.com/reel/C0dE_-9xY/embed/captioned/?cr=1&v=14'), 'https://www.instagram.com/reel/C0dE_-9xY/');
    assert.equal(embedParaInstagram('https://www.instagram.com/tv/XYZ987abc/embed'), 'https://www.instagram.com/tv/XYZ987abc/');
    assert.equal(embedParaInstagram('https://instagram.com/p/ABC123xyz/embed/captioned'), 'https://www.instagram.com/p/ABC123xyz/');
    for (const src of ['https://evil.com/p/ABC123xyz/embed/', 'about:blank', '', null, 7]) {
      assert.equal(embedParaInstagram(src), null, String(src));
    }
  });

  test('ida e volta entre publicação e embed', () => {
    for (const url of ['https://www.instagram.com/p/ABC123xyz/', 'https://www.instagram.com/reel/C0dE_-9xY/', 'https://www.instagram.com/tv/XYZ987abc/']) {
      assert.equal(embedParaInstagram(instagramParaEmbed(url)), url);
      assert.equal(instagramParaEmbed(embedParaInstagram(instagramParaEmbed(url))), instagramParaEmbed(url));
    }
  });
});

describe('sanitizarHtml', () => {
  const doc = montar('<p>x</p>');
  const limpar = (html) => sanitizarHtml(html, doc);

  test('mantém as tags permitidas', () => {
    const html = '<p>a <strong>b</strong> <b>c</b> <em>d</em> <i>e</i> <u>f</u> <s>g</s><br>h <span>i</span></p>' +
      '<ul><li>1</li></ul><ol><li>2</li></ol><blockquote>q</blockquote><h3>t3</h3><h4>t4</h4>';
    assert.equal(limpar(html), html);
  });

  test('aceita o resultado do parseHTML e o próprio elemento como documento', () => {
    const janela = parseHTML('<p>x</p>');
    assert.equal(sanitizarHtml('<p onclick="x">a</p>', janela), '<p>a</p>');
    assert.equal(sanitizarHtml('<p onclick="x">a</p>', janela.document.body), '<p>a</p>');
  });

  test('remove script, style, iframe, object, embed, svg, math, template e noscript com o conteúdo', () => {
    const casos = {
      script: '<script>alert("perigo")</script>',
      style: '<style>body{display:none} /* perigo */</style>',
      iframe: '<iframe src="https://evil.com">perigo</iframe>',
      object: '<object data="x.swf"><param name="a" value="perigo">perigo</object>',
      embed: '<embed src="x.swf">',
      svg: '<svg onload="alert(1)"><text>perigo</text><script>alert(1)</script></svg>',
      math: '<math><mi>perigo</mi></math>',
      template: '<template><p>perigo</p><script>alert(1)</script></template>',
      noscript: '<noscript><p>perigo</p></noscript>'
    };
    for (const [tag, perigoso] of Object.entries(casos)) {
      const saida = limpar(`<p>antes${perigoso}depois</p>`);
      assert.equal(saida, '<p>antesdepois</p>', tag);
    }
  });

  test('remove atributos on* e todos os que não estão na lista', () => {
    assert.equal(
      limpar('<p onclick="alert(1)" class="x" style="color:red" id="y" title="t" data-x="1">a</p>'),
      '<p>a</p>'
    );
    assert.equal(limpar('<span onmouseover="alert(1)" ONCLICK="x" lang="pt">s</span>'), '<span>s</span>');
    assert.equal(limpar('<a href="/x" onclick="alert(1)" class="botao" download name="n">l</a>'), '<a href="/x">l</a>');
  });

  test('desembrulha tags fora da lista e mantém o conteúdo', () => {
    assert.equal(limpar('<div><h1>T</h1><section>S<font color="red">F</font></section></div>'), 'TSF');
    assert.equal(limpar('<p><code>x</code> e <mark>y</mark></p>'), '<p>x e y</p>');
    assert.equal(limpar('<form action="javascript:alert(1)"><button formaction="x">Enviar</button></form>'), 'Enviar');
    assert.equal(limpar('<details open ontoggle="alert(1)"><summary>Mais</summary>texto</details>'), 'Maistexto');
    assert.equal(limpar('<a href="/x"><img src="x" onerror="alert(1)">texto</a>'), '<a href="/x">texto</a>');
  });

  test('a[href] só com URL segura', () => {
    assert.equal(limpar('<a href="https://ama.org.br/x?a=1">l</a>'), '<a href="https://ama.org.br/x?a=1">l</a>');
    assert.equal(limpar('<a href="mailto:a@b.com">l</a>'), '<a href="mailto:a@b.com">l</a>');
    assert.equal(limpar('<a href="/x?a=1&amp;b=2">l</a>'), '<a href="/x?a=1&amp;b=2">l</a>');
    assert.equal(limpar('<a href=\'/x?q="a"\'>l</a>'), '<a href="/x?q=&quot;a&quot;">l</a>');
    const perigosos = [
      'javascript:alert(1)', ' JaVaScRiPt:alert(1)', '&#106;avascript:alert(1)', 'java&#x09;script:alert(1)',
      'javascript&colon;alert(1)', 'javascript&amp;colon;alert(1)', '&#x6A;avascript&#x3A;alert(1)',
      '&#14;javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)', '//evil.com'
    ];
    for (const href of perigosos) {
      assert.equal(limpar(`<a href="${href}">l</a>`), '<a>l</a>', href);
    }
  });

  test('desembrulha title, textarea, select, option, audio, video, canvas e picture (fica o texto, escapado)', () => {
    assert.equal(limpar('<select><option>Texto</option></select>'), 'Texto');
    assert.equal(limpar('<datalist><optgroup><option>Op</option></optgroup></datalist>'), 'Op');
    assert.equal(limpar('<textarea>Texto</textarea>'), 'Texto');
    assert.equal(limpar('<title>T</title>'), 'T');
    assert.equal(limpar('<video src="/v.mp4">Fallback</video>'), 'Fallback');
    assert.equal(limpar('<audio>Sem áudio</audio>'), 'Sem áudio');
    assert.equal(limpar('<canvas>Sem canvas</canvas>'), 'Sem canvas');
    assert.equal(limpar('<picture><source srcset="/a.webp"><img src="/a.jpg">Foto</picture>'), 'Foto');
    // Em title/textarea o conteúdo é texto cru: sai escapado, nunca como tag.
    assert.equal(limpar('<textarea><img src=x onerror=alert(1)></textarea>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(limpar('<p><title><b>x</b></title></p>'), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
  });

  test('remove com o conteúdo o que não tem texto visível ou é texto cru', () => {
    for (const html of [
      '<noembed>x</noembed>', '<noframes>x</noframes>', '<xmp>x</xmp>', '<applet>x</applet>',
      '<frameset><frame src="/x"></frameset>', '<img src="/a.jpg" alt="x">', '<input value="x">',
      '<link rel="stylesheet" href="/x.css">', '<meta content="x">', '<base href="/">'
    ]) {
      assert.equal(limpar(`<p>a${html}b</p>`), '<p>ab</p>', html);
    }
  });

  test('profundidade máxima: além de 100 níveis as tags são desembrulhadas', () => {
    const html = '<span>'.repeat(150) + 'fundo' + '</span>'.repeat(150);
    const saida = limpar(html);
    assert.equal(saida, '<span>'.repeat(100) + 'fundo' + '</span>'.repeat(100));
    assert.equal(limpar(saida), saida);
  });

  test('target="_blank" força rel="noopener noreferrer"; outros target e rel saem', () => {
    assert.equal(limpar('<a href="/x" target="_blank">l</a>'), '<a href="/x" target="_blank" rel="noopener noreferrer">l</a>');
    assert.equal(limpar('<a href="/x" target="_blank" rel="opener">l</a>'), '<a href="/x" target="_blank" rel="noopener noreferrer">l</a>');
    assert.equal(limpar('<a href="/x" target="_BLANK">l</a>'), '<a href="/x" target="_blank" rel="noopener noreferrer">l</a>');
    assert.equal(limpar('<a href="/x" target="_self">l</a>'), '<a href="/x">l</a>');
    assert.equal(limpar('<a href="/x" target="janela">l</a>'), '<a href="/x">l</a>');
    assert.equal(limpar('<a href="/x" rel="opener">l</a>'), '<a href="/x">l</a>');
  });

  test('texto escapado continua texto e comentários somem', () => {
    assert.equal(limpar('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; "aspas"</p>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; "aspas"</p>');
    assert.equal(limpar('<p>a<!-- <script>alert(1)</script> -->b</p>'), '<p>ab</p>');
    assert.equal(limpar('texto solto'), 'texto solto');
  });

  test('escape canônico, igual ao dos navegadores', () => {
    assert.equal(limpar('<p>a&nbsp;b &amp; c &lt; d &gt; e "f" \'g\'</p>'), '<p>a&nbsp;b &amp; c &lt; d &gt; e "f" \'g\'</p>');
    assert.equal(limpar('<P><STRONG>x</STRONG></P>'), '<p><strong>x</strong></p>');
  });

  test('sem documento (Node puro) devolve o texto escapado', () => {
    assert.equal(typeof globalThis.document, 'undefined');
    assert.equal(sanitizarHtml('<b onclick="x">a</b>'), '&lt;b onclick="x"&gt;a&lt;/b&gt;');
  });

  test('não string ou vazio vira string vazia', () => {
    for (const valor of [null, undefined, 42, {}, [], '']) assert.equal(limpar(valor), '');
  });

  test('ataques conhecidos não passam e o resultado é estável', () => {
    const ataques = [
      '<img src=x onerror=alert(1)>',
      '<svg onload=alert(1)>',
      '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
      '<math><mi><a href="javascript:alert(1)">x</a></mi></math>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      '<a href="javas&#99;ript:alert(1)">x</a>',
      '<a href=" &#14;javascript:alert(1)">x</a>',
      '<a href="java\nscript:alert(1)">x</a>',
      '<object data="javascript:alert(1)"></object>',
      '<embed src="javascript:alert(1)">',
      '<body onload=alert(1)>x</body>',
      '<p style="background:url(javascript:alert(1))">x</p>',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
      '<template><script>alert(1)</script></template>',
      '<xmp><img src=x onerror=alert(1)></xmp>',
      '<textarea><img src=x onerror=alert(1)></textarea>',
      '<title><img src=x onerror=alert(1)></title>',
      '<<script>script>alert(1)<</script>/script>',
      '<scr<script>ipt>alert(1)</scr</script>ipt>',
      '<a href="https://ok.com" onclick="x" style="x" target="_blank" rel="opener">ok</a>',
      '<base href="javascript:/"><a href="x">x</a>',
      '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
      '<link rel="import" href="https://evil.com/x.html">',
      '<input autofocus onfocus=alert(1)>',
      '<video><source onerror=alert(1)></video>',
      '<audio src=x onerror=alert(1)>',
      '<p>"><script>alert(1)</script></p>',
      '<!--<script>alert(1)--><img src=x>',
      '<![CDATA[<script>alert(1)</script>]]>',
      '<span>texto</span><div><<p>>',
      '<a href="/x"><a href="javascript:alert(1)">aninhado</a></a>',
      '<ul><li><ul><li><ol><li><blockquote><p><span><strong><em>fundo</em></strong></span></p></blockquote></li></ol></li></ul></li></ul>',
      '<p>' + '<span>'.repeat(300) + 'muito fundo' + '</span>'.repeat(300) + '</p>'
    ];
    for (const ataque of ataques) {
      const saida = limpar(ataque);
      assertHtmlLimpo(saida, ataque);
      assert.equal(limpar(saida), saida, `estável: ${ataque}`);
    }
  });
});

describe('tipo texto', () => {
  test('lê textContent com espaços colapsados e trim', () => {
    const doc = montar('<h2 data-cms="t" data-cms-tipo="texto">  Quem \n   <em>somos</em>\t </h2>');
    assert.equal(lerValor($(doc, 'h2'), 'texto'), 'Quem somos');
  });

  test('aplica como texto puro, nunca como HTML', () => {
    const doc = montar('<h2 data-cms="t" data-cms-tipo="texto">Quem <em>somos</em></h2>');
    const h2 = $(doc, 'h2');
    aplicarConteudo(doc, { t: 'Novo <script>alert(1)</script> & <b>cia</b>' });
    assert.equal(h2.textContent, 'Novo <script>alert(1)</script> & <b>cia</b>');
    assert.equal(elementosFilhos(h2).length, 0);
    assert.equal(h2.innerHTML, 'Novo &lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;cia&lt;/b&gt;');
    assert.equal(lerValor(h2, 'texto'), 'Novo <script>alert(1)</script> & <b>cia</b>');
    assert.equal($$(reparsear(doc), 'script').length, 0);
  });

  test('string vazia limpa o texto', () => {
    const doc = montar('<p data-cms="t">Algo</p>');
    aplicarConteudo(doc, { t: '' });
    assert.equal($(doc, 'p').textContent, '');
  });

  test('em <title> não deixa fechar a tag', () => {
    const doc = montar('<!doctype html><html><head><title data-cms="t">Padrão</title></head><body></body></html>');
    aplicarConteudo(doc, { t: '</title><script>alert(1)</script><title>' });
    const novo = reparsear(doc);
    assert.equal($$(novo, 'title').length, 1);
    assert.equal($$(novo, 'script').length, 0);
    assert.ok(!$(novo, 'title').textContent.includes('<'));
    assert.match($(novo, 'title').textContent, /alert\(1\)/);
  });

  test('em <textarea> não deixa fechar a tag', () => {
    const doc = montar('<form><textarea data-cms="t">Padrão</textarea></form>');
    aplicarConteudo(doc, { t: '</textarea><script>alert(1)</script><textarea>' });
    const novo = reparsear(doc);
    assert.equal($$(novo, 'textarea').length, 1);
    assert.equal($$(novo, 'script').length, 0);
    assert.ok(!$(novo, 'textarea').textContent.includes('<'));
  });

  test('com filhos data-cms-fixo: o valor vira texto e os fixos vão para o fim', () => {
    const doc = montar('<p data-cms="p">x<span class="selo" data-cms-fixo>*</span></p>');
    const p = $(doc, 'p');
    const fixo = $(p, '[data-cms-fixo]');
    assert.equal(lerValor(p, 'texto'), 'x');
    aplicarConteudo(doc, { p: '<img src=x onerror=alert(1)>' });
    assert.ok(elementosFilhos(p).length === 1 && elementosFilhos(p)[0] === fixo, 'só o fixo como filho elemento');
    assert.equal(p.innerHTML, '&lt;img src=x onerror=alert(1)&gt;<span class="selo" data-cms-fixo="">*</span>');
    assert.equal(lerValor(p, 'texto'), '<img src=x onerror=alert(1)>');
    const novo = reparsear(doc);
    assert.equal($$(novo, 'img').length, 0);
    assert.deepEqual(elementosFilhos($(novo, 'p')).map((el) => el.localName), ['span']);
  });

  test('não escreve dentro de <script> ou <style>', () => {
    const doc = montar('<script data-cms="s" data-cms-tipo="texto">var a = 1;</script><style data-cms="c" data-cms-tipo="texto">p{}</style>');
    assertSemMudanca(doc, { s: 'alert(1)', c: 'body{display:none}' });
  });
});

describe('tipo textolongo', () => {
  test('lê <br> como \\n', () => {
    const doc = montar('<p data-cms="t" data-cms-tipo="textolongo">\n  Linha 1<br>Linha 2<br/>\n   Linha   3\n</p>');
    assert.equal(lerValor($(doc, 'p'), 'textolongo'), 'Linha 1\nLinha 2\nLinha 3');
  });

  test('aplica \\n como <br> e o resto como texto', () => {
    const doc = montar('<p data-cms="t" data-cms-tipo="textolongo">Padrão</p>');
    const p = $(doc, 'p');
    aplicarConteudo(doc, { t: 'A\nB\r\n\nC <b>x</b>' });
    assert.equal(p.innerHTML, 'A<br>B<br><br>C &lt;b&gt;x&lt;/b&gt;');
    assert.equal(lerValor(p, 'textolongo'), 'A\nB\n\nC <b>x</b>');
    assert.deepEqual(elementosFilhos(p).map((el) => el.localName), ['br', 'br', 'br']);
  });

  test('com filhos data-cms-fixo: linhas viram texto e os fixos vão para o fim', () => {
    const doc = montar('<p data-cms="t" data-cms-tipo="textolongo">a<br>b<span class="selo" data-cms-fixo>*</span></p>');
    const p = $(doc, 'p');
    assert.equal(lerValor(p, 'textolongo'), 'a\nb');
    aplicarConteudo(doc, { t: '<img src=x onerror=alert(1)>\n<script>alert(2)</script>' });
    assert.deepEqual(elementosFilhos(p).map((el) => el.localName), ['br', 'span']);
    assert.equal(lerValor(p, 'textolongo'), '<img src=x onerror=alert(1)>\n<script>alert(2)</script>');
    const novo = reparsear(doc);
    assert.equal($$(novo, 'img').length, 0);
    assert.equal($$(novo, 'script').length, 0);
  });

  test('em <title> e <textarea> vira uma linha só e não deixa fechar a tag', () => {
    const doc = montar('<!doctype html><html><head><title data-cms="t" data-cms-tipo="textolongo">Padrão</title></head>' +
      '<body><form><textarea data-cms="a" data-cms-tipo="textolongo">Padrão</textarea></form></body></html>');
    aplicarConteudo(doc, {
      t: 'a\n</title><script>alert(1)</script><title>',
      a: 'b\n</textarea><script>alert(2)</script><textarea>'
    });
    const novo = reparsear(doc);
    assert.equal($$(novo, 'script').length, 0);
    assert.equal($$(novo, 'title').length, 1);
    assert.equal($$(novo, 'textarea').length, 1);
    for (const tag of ['title', 'textarea']) {
      assert.ok(!$(novo, tag).textContent.includes('<'), tag);
      assert.ok(!$(novo, tag).textContent.includes('\n'), tag);
      assert.equal(elementosFilhos($(novo, tag)).length, 0, tag);
    }
  });
});

describe('tipo html', () => {
  const MOLDE = '<div class="c" data-cms="c" data-cms-tipo="html"><span class="selo" data-cms-fixo>Selo</span>' +
    '<p>Padrão <strong>forte</strong></p></div>';

  test('lê innerHTML sem os filhos fixos', () => {
    const doc = montar(MOLDE);
    assert.equal(lerValor($(doc, '.c'), 'html'), '<p>Padrão <strong>forte</strong></p>');
  });

  test('aplica HTML sanitizado e preserva os filhos data-cms-fixo no fim', () => {
    const doc = montar(MOLDE);
    const div = $(doc, '.c');
    const fixo = $(div, '[data-cms-fixo]');
    aplicarConteudo(doc, { c: '<p onclick="alert(1)" class="x">Novo <em>texto</em><script>alert(1)</script></p><div>solto</div>' });
    assert.equal(lerValor(div, 'html'), '<p>Novo <em>texto</em></p>solto');
    assert.ok(elementosFilhos(div).at(-1) === fixo, 'o fixo é o último filho');
    assert.equal(div.innerHTML, '<p>Novo <em>texto</em></p>solto<span class="selo" data-cms-fixo="">Selo</span>');
  });

  test('string vazia mantém só os fixos', () => {
    const doc = montar(MOLDE);
    aplicarConteudo(doc, { c: '' });
    assert.equal($(doc, '.c').innerHTML, '<span class="selo" data-cms-fixo="">Selo</span>');
  });

  test('não escreve HTML em <title>, <textarea>, <script> ou <style>', () => {
    const doc = montar('<!doctype html><html><head><title data-cms="t" data-cms-tipo="html">Padrão</title>' +
      '<style data-cms="s" data-cms-tipo="html">p{}</style></head><body>' +
      '<textarea data-cms="a" data-cms-tipo="html">Padrão</textarea><script data-cms="j" data-cms-tipo="html">var a;</script></body></html>');
    const html = '<p>x</p></title></textarea></style></script><script>alert(1)</script>';
    assertSemMudanca(doc, { t: html, s: html, a: html, j: html });
  });
});

describe('tipo imagem', () => {
  const MOLDE = '<picture><source srcset="/a.webp" type="image/webp"><source srcset="/a.avif" type="image/avif">' +
    '<img src="/a.jpg" srcset="/a-2x.jpg 2x" alt="Padrão" data-cms="f" data-cms-tipo="imagem"></picture>';

  test('lê src e alt', () => {
    const doc = montar(MOLDE);
    assert.deepEqual(lerValor($(doc, 'img'), 'imagem'), { src: '/a.jpg', alt: 'Padrão' });
  });

  test('aplica src e alt, remove srcset e os <source> do <picture>', () => {
    const doc = montar(MOLDE);
    aplicarConteudo(doc, { f: { src: 'https://cdn.exemplo.com/b.jpg', alt: 'Nova "foto"' } });
    const img = $(doc, 'img');
    assert.equal(img.getAttribute('src'), 'https://cdn.exemplo.com/b.jpg');
    assert.equal(img.getAttribute('alt'), 'Nova "foto"');
    assert.equal(img.hasAttribute('srcset'), false);
    assert.equal($$(doc, 'picture source').length, 0);
    assert.equal($(reparsear(doc), 'img').getAttribute('alt'), 'Nova "foto"');
  });

  test('só alt: mantém src, srcset e <source>', () => {
    const doc = montar(MOLDE);
    aplicarConteudo(doc, { f: { alt: 'Só o alt' } });
    const img = $(doc, 'img');
    assert.equal(img.getAttribute('src'), '/a.jpg');
    assert.equal(img.getAttribute('srcset'), '/a-2x.jpg 2x');
    assert.equal(img.getAttribute('alt'), 'Só o alt');
    assert.equal($$(doc, 'picture source').length, 2);
  });

  test('fora de <picture> também funciona', () => {
    const doc = montar('<p><img src="/a.jpg" alt="A" data-cms="f" data-cms-tipo="imagem"></p>');
    aplicarConteudo(doc, { f: { src: 'img/b.png', alt: 'B' } });
    assert.deepEqual(lerValor($(doc, 'img'), 'imagem'), { src: 'img/b.png', alt: 'B' });
  });

  test('src inseguro mantém o padrão inteiro', () => {
    for (const src of ['javascript:alert(1)', 'data:image/png;base64,AAAA', ' JaVaScRiPt:alert(1)', '\u0001javascript:alert(1)', 'javascript&colon;alert(1)', 'vbscript:x']) {
      const doc = montar(MOLDE);
      assertSemMudanca(doc, { f: { src, alt: 'Nova' } }, src);
    }
  });
});

describe('tipo video', () => {
  test('lê e aplica src e poster', () => {
    const doc = montar('<video src="/v.mp4" poster="/p.jpg" muted data-cms="v" data-cms-tipo="video"></video>');
    const video = $(doc, 'video');
    assert.deepEqual(lerValor(video, 'video'), { src: '/v.mp4', poster: '/p.jpg' });
    aplicarConteudo(doc, { v: { src: 'https://cdn.exemplo.com/n.mp4', poster: '/np.jpg' } });
    assert.deepEqual(lerValor(video, 'video'), { src: 'https://cdn.exemplo.com/n.mp4', poster: '/np.jpg' });
    assert.equal(video.hasAttribute('muted'), true);
  });

  test('com <source> filho: lê e troca o src do <source>', () => {
    const doc = montar('<video poster="/p.jpg" data-cms="v" data-cms-tipo="video">' +
      '<source src="/a.mp4" type="video/mp4"><source src="/a.webm" type="video/webm"></video>');
    const video = $(doc, 'video');
    assert.deepEqual(lerValor(video, 'video'), { src: '/a.mp4', poster: '/p.jpg' });
    aplicarConteudo(doc, { v: { src: '/b.webm' } });
    assert.deepEqual(lerValor(video, 'video'), { src: '/b.webm', poster: '/p.jpg' });
    const fontes = $$(video, 'source');
    assert.equal(fontes.length, 1);
    assert.equal(fontes[0].getAttribute('src'), '/b.webm');
    assert.equal(fontes[0].hasAttribute('type'), false);
    assert.equal(video.hasAttribute('src'), false);
  });

  test('poster vazio tira a capa; só poster mantém o src', () => {
    const doc = montar('<video src="/v.mp4" poster="/p.jpg" data-cms="v" data-cms-tipo="video"></video>');
    aplicarConteudo(doc, { v: { poster: '' } });
    assert.deepEqual(lerValor($(doc, 'video'), 'video'), { src: '/v.mp4', poster: '' });
    assert.equal($(doc, 'video').hasAttribute('poster'), false);
  });

  test('src ou poster inseguro mantém o padrão inteiro', () => {
    const casos = [
      { src: 'javascript:alert(1)', poster: '/ok.jpg' },
      { src: '/ok.mp4', poster: 'javascript:alert(1)' },
      { src: 'data:video/mp4;base64,AAAA' },
      { poster: ' vbscript:x' }
    ];
    for (const valor of casos) {
      const doc = montar('<video src="/v.mp4" poster="/p.jpg" data-cms="v" data-cms-tipo="video"></video>');
      assertSemMudanca(doc, { v: valor }, JSON.stringify(valor));
    }
  });
});

describe('tipo link', () => {
  test('texto em [data-cms-link-texto]: preserva os outros filhos', () => {
    const doc = montar('<a href="/contato" data-cms="l" data-cms-tipo="link"><span class="icone">→</span> <span data-cms-link-texto>Fale conosco</span></a>');
    const a = $(doc, 'a');
    assert.deepEqual(lerValor(a, 'link'), { href: '/contato', texto: 'Fale conosco' });
    aplicarConteudo(doc, { l: { href: 'https://wa.me/5591999999999', texto: '<b>Zap</b>' } });
    assert.deepEqual(lerValor(a, 'link'), { href: 'https://wa.me/5591999999999', texto: '<b>Zap</b>' });
    assert.equal($(a, '.icone').textContent, '→');
    assert.equal($(a, '[data-cms-link-texto]').textContent, '<b>Zap</b>');
    assert.equal($$(a, 'b').length, 0);
  });

  test('texto no próprio <a> quando ele não tem filhos elemento', () => {
    const doc = montar('<a href="/x" data-cms="l" data-cms-tipo="link">  Texto   simples </a>');
    const a = $(doc, 'a');
    assert.deepEqual(lerValor(a, 'link'), { href: '/x', texto: 'Texto simples' });
    aplicarConteudo(doc, { l: { texto: 'Outro <i>texto</i>' } });
    assert.equal(a.getAttribute('href'), '/x');
    assert.equal(a.textContent, 'Outro <i>texto</i>');
    assert.equal(elementosFilhos(a).length, 0);
  });

  test('<a> com filhos elemento e sem marcador: o texto não é campo (só o href muda)', () => {
    const doc = montar('<a href="/x" data-cms="l" data-cms-tipo="link"><img src="/i.png" alt="">Texto</a>');
    const a = $(doc, 'a');
    const antes = a.innerHTML;
    assert.deepEqual(lerValor(a, 'link'), { href: '/x', texto: '' });
    aplicarConteudo(doc, { l: { href: '/y', texto: 'Novo' } });
    assert.equal(a.getAttribute('href'), '/y');
    assert.equal(a.innerHTML, antes);
  });

  test('<a> com ícone e sem marcador: texto com HTML não vira elemento', () => {
    const doc = montar('<a href="/x" data-cms="k" data-cms-tipo="link"><svg class="icone"></svg> Texto</a>');
    const a = $(doc, 'a');
    const antes = serializar(doc);
    aplicarConteudo(doc, { k: { texto: '<img src=x onerror=alert(1)>' } });
    assert.equal(serializar(doc), antes);
    const novo = reparsear(doc);
    assert.equal($$(novo, 'img').length, 0);
    assert.equal($$(novo, 'a svg').length, 1);
    assert.equal(lerValor(a, 'link').texto, '');
  });

  test('href inseguro mantém o padrão inteiro', () => {
    const hrefs = ['javascript:alert(1)', '\tjavascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', '&#106;avascript:alert(1)', 'java\nscript:alert(1)'];
    for (const href of hrefs) {
      const doc = montar('<a href="/x" data-cms="l" data-cms-tipo="link">Texto</a>');
      assertSemMudanca(doc, { l: { href, texto: 'Clique' } }, href);
    }
  });
});

describe('tipo url', () => {
  const MOLDE = '<a href="/a" data-cms="u1" data-cms-tipo="url">Texto</a>' +
    '<img src="/i.jpg" srcset="/i2.jpg 2x" alt="I" data-cms="u2" data-cms-tipo="url">' +
    '<iframe src="https://exemplo.com/e" data-cms="u3" data-cms-tipo="url"></iframe>' +
    '<video src="/v.mp4" data-cms="u4" data-cms-tipo="url"></video>' +
    '<video><source src="/s.mp4" data-cms="u5" data-cms-tipo="url"></video>';

  test('lê href de <a> e src de img, iframe, video e source', () => {
    const doc = montar(MOLDE);
    const lidos = ['u1', 'u2', 'u3', 'u4', 'u5'].map((c) => lerValor($(doc, `[data-cms="${c}"]`), 'url'));
    assert.deepEqual(lidos, ['/a', '/i.jpg', 'https://exemplo.com/e', '/v.mp4', '/s.mp4']);
  });

  test('aplica no atributo certo', () => {
    const doc = montar(MOLDE);
    aplicarConteudo(doc, { u1: 'https://b.com/', u2: '/j.jpg', u3: 'https://exemplo.com/f', u4: '/w.mp4', u5: '/t.mp4' });
    const a = $(doc, '[data-cms="u1"]');
    assert.equal(a.getAttribute('href'), 'https://b.com/');
    assert.equal(a.textContent, 'Texto');
    assert.equal($(doc, 'img').getAttribute('src'), '/j.jpg');
    assert.equal($(doc, 'img').hasAttribute('srcset'), false);
    assert.equal($(doc, 'iframe').getAttribute('src'), 'https://exemplo.com/f');
    assert.equal($(doc, '[data-cms="u4"]').getAttribute('src'), '/w.mp4');
    assert.equal($(doc, 'source').getAttribute('src'), '/t.mp4');
  });

  test('URL insegura mantém o padrão', () => {
    const doc = montar(MOLDE);
    assertSemMudanca(doc, {
      u1: 'javascript:alert(1)', u2: 'data:image/png;base64,AAAA', u3: ' javascript:alert(1)',
      u4: 'vbscript:x', u5: 'java\tscript:alert(1)'
    });
  });
});

describe('tipo instagram', () => {
  const MOLDE = '<iframe src="https://www.instagram.com/p/AAA111bbb/embed/captioned/" data-cms="i" data-cms-tipo="instagram"></iframe>';

  test('lê a URL da publicação a partir do embed', () => {
    const doc = montar(MOLDE);
    assert.equal(lerValor($(doc, 'iframe'), 'instagram'), 'https://www.instagram.com/p/AAA111bbb/');
  });

  test('aplica iframe.src = instagramParaEmbed(valor)', () => {
    const doc = montar(MOLDE);
    aplicarConteudo(doc, { i: 'https://instagram.com/reel/BBB222ccc?igsh=xyz' });
    assert.equal($(doc, 'iframe').getAttribute('src'), 'https://www.instagram.com/reel/BBB222ccc/embed/captioned/');
    assert.equal(lerValor($(doc, 'iframe'), 'instagram'), 'https://www.instagram.com/reel/BBB222ccc/');
  });

  test('também com data-cms num elemento que contém o iframe', () => {
    const doc = montar('<div data-cms="i" data-cms-tipo="instagram"><iframe src="https://www.instagram.com/p/AAA111bbb/embed/captioned/"></iframe></div>');
    aplicarConteudo(doc, { i: 'https://www.instagram.com/tv/DDD444eee/' });
    assert.equal($(doc, 'iframe').getAttribute('src'), 'https://www.instagram.com/tv/DDD444eee/embed/captioned/');
  });

  test('URL inválida mantém o padrão', () => {
    for (const valor of ['https://evil.com/p/AAA111bbb/', 'javascript:alert(1)', 'https://www.instagram.com/ama/', '']) {
      assertSemMudanca(montar(MOLDE), { i: valor }, valor);
    }
  });
});

describe('tipo meta', () => {
  test('lê e aplica o atributo content', () => {
    const doc = montar('<!doctype html><html><head><meta name="description" content="Padrão" data-cms="m" data-cms-tipo="meta"></head><body></body></html>');
    const meta = $(doc, 'meta');
    assert.equal(lerValor(meta, 'meta'), 'Padrão');
    aplicarConteudo(doc, { m: 'Nova "descrição" <b>&</b>' });
    assert.equal(meta.getAttribute('content'), 'Nova "descrição" <b>&</b>');
    assert.equal($(reparsear(doc), 'meta[name="description"]').getAttribute('content'), 'Nova "descrição" <b>&</b>');
  });
});

describe('listas', () => {
  const nomes = (doc) => $$(doc, '.grade [data-cms-item] strong').map((el) => el.textContent);

  test('lê o array dos itens do template', () => {
    const doc = montar(FIXTURE);
    assert.deepEqual(lerValor($(doc, '[data-cms="depoimentos.itens"]'), 'lista'), PADROES['depoimentos.itens']);
    assert.deepEqual(lerValor($(doc, '[data-cms="cabecalho.menu"]'), 'lista'), PADROES['cabecalho.menu']);
  });

  test('reordena', () => {
    const doc = montar(FIXTURE);
    const [maria, joana] = PADROES['depoimentos.itens'];
    aplicarConteudo(doc, { 'depoimentos.itens': [joana, maria] });
    assert.deepEqual(nomes(doc), ['Joana', 'Maria']);
    assert.deepEqual(lerValor($(doc, '[data-cms="depoimentos.itens"]'), 'lista'), [joana, maria]);
  });

  test('adiciona além do template', () => {
    const doc = montar(FIXTURE);
    const itens = ['Ana', 'Bia', 'Cris', 'Duda'].map((nome) => ({
      foto: { src: `/img/${nome.toLowerCase()}.jpg`, alt: nome }, texto: `Depoimento de ${nome}`, nome
    }));
    aplicarConteudo(doc, { 'depoimentos.itens': itens });
    assert.deepEqual(nomes(doc), ['Ana', 'Bia', 'Cris', 'Duda']);
    assert.deepEqual(lerValor($(doc, '[data-cms="depoimentos.itens"]'), 'lista'), itens);
    for (const item of $$(doc, '.grade [data-cms-item]')) {
      assert.equal(item.getAttribute('class'), 'card');
      assert.equal($(item, '.assinatura').textContent, $(item, 'strong').textContent);
    }
  });

  test('remove itens', () => {
    const doc = montar(FIXTURE);
    aplicarConteudo(doc, { 'depoimentos.itens': [PADROES['depoimentos.itens'][1]] });
    assert.deepEqual(nomes(doc), ['Joana']);
  });

  test('lista vazia remove todos os itens e mantém o resto da seção', () => {
    const doc = montar(FIXTURE);
    aplicarConteudo(doc, { 'depoimentos.itens': [] });
    assert.equal($$(doc, '.grade [data-cms-item]').length, 0);
    assert.ok($(doc, '.grade'));
    assert.equal($(doc, '[data-cms="depoimentos.titulo"]').textContent, 'Depoimentos');
    assert.deepEqual(lerValor($(doc, '.grade'), 'lista'), []);
  });

  test('o primeiro item é o molde: campos faltando ficam com o padrão do molde', () => {
    const doc = montar('<ul data-cms="l" data-cms-tipo="lista">' +
      '<li class="primeiro" data-cms-item><b data-cms-campo="n">Um</b><i data-cms-campo="d">detalhe 1</i></li>' +
      '<li class="segundo" data-cms-item><b data-cms-campo="n">Dois</b><i data-cms-campo="d">detalhe 2</i></li></ul>');
    aplicarConteudo(doc, { l: [{ n: 'A' }, { n: 'B', d: 'x' }, { d: 'só detalhe' }] });
    const itens = $$(doc, 'li');
    assert.deepEqual(itens.map((li) => li.getAttribute('class')), ['primeiro', 'primeiro', 'primeiro']);
    assert.deepEqual(lerValor($(doc, 'ul'), 'lista'), [
      { n: 'A', d: 'detalhe 1' }, { n: 'B', d: 'x' }, { n: 'Um', d: 'só detalhe' }
    ]);
  });

  describe('todo item novo é clone do molde, mesmo igual a um item do template', () => {
    const MOLDE = '<ul data-cms="l" data-cms-tipo="lista">' +
      '<li class="normal" data-cms-item><b data-cms-campo="n" data-cms-rotulo="Nome">Um</b></li>' +
      '<li class="destaque" data-cms-item><b data-cms-campo="n" data-cms-rotulo="Nome do destaque">Dois</b></li></ul>';
    const classes = (doc) => $$(doc, 'li').map((li) => li.getAttribute('class'));
    const textos = (doc) => $$(doc, 'li').map((li) => li.textContent);

    test('reordenar ou duplicar não reaproveita a marcação do item original', () => {
      for (const valor of [[{ n: 'Dois' }, { n: 'Um' }, { n: 'Três' }], [{ n: 'Dois' }, { n: 'Dois' }], [{ n: 'Dois' }]]) {
        const doc = montar(MOLDE);
        const originais = $$(doc, 'li');
        aplicarConteudo(doc, { l: valor });
        assert.deepEqual(textos(doc), valor.map((v) => v.n), JSON.stringify(valor));
        assert.deepEqual(classes(doc), valor.map(() => 'normal'), JSON.stringify(valor));
        assert.ok($$(doc, 'li').every((li) => !originais.includes(li)), 'itens originais saem');
        assert.deepEqual($$(doc, 'b').map((b) => b.getAttribute('data-cms-rotulo')), valor.map(() => 'Nome'));
      }
    });

    test('mesmos valores, na mesma ordem, que os itens atuais: a lista fica como está', () => {
      const doc = montar(MOLDE);
      assertSemMudanca(doc, { l: [{ n: 'Um' }, { n: 'Dois' }] });
      assert.deepEqual(classes(doc), ['normal', 'destaque']);
    });

    test('o esquema descreve os subcampos pelo molde depois de aplicar no mesmo documento', () => {
      const doc = montar(MOLDE);
      aplicarConteudo(doc, { l: [{ n: 'Dois' }, { n: 'Um' }] });
      const [c] = extrairEsquema(doc).grupos[0].campos;
      assert.deepEqual(c.campos, [{ campo: 'n', tipo: 'texto', rotulo: 'Nome', ajuda: '' }]);
      assert.deepEqual(c.padrao, [{ n: 'Dois' }, { n: 'Um' }]);
    });
  });

  test('no máximo 200 itens', () => {
    const doc = montar('<ul data-cms="l" data-cms-tipo="lista"><li data-cms-item><b data-cms-campo="n">Um</b></li></ul>');
    const itens = Array.from({ length: 250 }, (_, i) => ({ n: `Item ${i}` }));
    aplicarConteudo(doc, { l: itens });
    const lidos = lerValor($(doc, 'ul'), 'lista');
    assert.equal(lidos.length, 200);
    assert.deepEqual(lidos, itens.slice(0, 200));
  });

  test('os novos itens entram onde estava o primeiro item', () => {
    const doc = montar('<div data-cms="l" data-cms-tipo="lista"><h3>Cabeçalho</h3>' +
      '<p data-cms-item><span data-cms-campo="n">1</span></p><hr>' +
      '<p data-cms-item><span data-cms-campo="n">2</span></p><footer>fim</footer></div>');
    aplicarConteudo(doc, { l: [{ n: 'a' }, { n: 'b' }, { n: 'c' }] });
    const div = $(doc, 'div');
    assert.deepEqual(elementosFilhos(div).map((el) => el.localName), ['h3', 'p', 'p', 'p', 'hr', 'footer']);
    assert.deepEqual($$(div, 'p').map((p) => p.textContent), ['a', 'b', 'c']);
  });

  test('campo repetido dentro do item recebe o valor em todos os elementos', () => {
    const doc = montar(FIXTURE);
    aplicarConteudo(doc, { 'depoimentos.itens': [{ nome: 'Ana' }] });
    const item = $(doc, '.grade [data-cms-item]');
    assert.equal($(item, 'strong').textContent, 'Ana');
    assert.equal($(item, '.assinatura').textContent, 'Ana');
    // os outros campos vêm do molde (primeiro item)
    assert.deepEqual(lerValor($(item, 'img'), 'imagem'), { src: '/img/maria.jpg', alt: 'Maria' });
    assert.equal(lerValor($(item, 'blockquote'), 'textolongo'), 'A AMA mudou\na minha vida.');
  });

  test('valores de campo com formato errado ou inseguro ficam com o padrão do molde', () => {
    const doc = montar(FIXTURE);
    aplicarConteudo(doc, {
      'depoimentos.itens': [{ nome: 42, foto: 'texto', texto: null }, { nome: 'Ana', foto: { src: 'javascript:alert(1)', alt: 'x' } }]
    });
    assert.deepEqual(lerValor($(doc, '.grade'), 'lista'), [
      PADROES['depoimentos.itens'][0],
      { ...PADROES['depoimentos.itens'][0], nome: 'Ana' }
    ]);
  });

  test('itens que não são objetos são ignorados; lista sem nenhum item válido mantém o padrão', () => {
    const doc = montar(FIXTURE);
    aplicarConteudo(doc, { 'depoimentos.itens': [null, 'x', 3, [], { nome: 'Ana' }] });
    assert.deepEqual(nomes(doc), ['Ana']);
    for (const valor of ['x', 42, true, {}, { 0: { nome: 'x' } }, [1, 2], ['a'], [[]], [null]]) {
      assertSemMudanca(montar(FIXTURE), { 'depoimentos.itens': valor }, JSON.stringify(valor));
    }
  });

  test('texto com HTML dentro de item continua texto', () => {
    const doc = montar(FIXTURE);
    aplicarConteudo(doc, { 'depoimentos.itens': [{ nome: '<img src=x onerror=alert(1)>', texto: '<script>alert(1)</script>' }] });
    const item = $(doc, '.grade [data-cms-item]');
    assert.equal($(item, 'strong').textContent, '<img src=x onerror=alert(1)>');
    assert.equal($$(item, 'img').length, 1);
    assert.equal($$(reparsear(doc), '.grade script').length, 0);
  });

  test('depois de [] dá para aplicar itens de novo no mesmo documento (molde guardado)', () => {
    const doc = montar(FIXTURE);
    aplicarConteudo(doc, { 'depoimentos.itens': [] });
    aplicarConteudo(doc, { 'depoimentos.itens': [{ nome: 'Ana' }, { nome: 'Bia' }] });
    assert.deepEqual(nomes(doc), ['Ana', 'Bia']);
    const esquema = extrairEsquema(doc);
    const lista = esquema.grupos.find((g) => g.id === 'depoimentos').campos.find((c) => c.chave === 'depoimentos.itens');
    assert.deepEqual(lista.campos.map((c) => c.campo), ['foto', 'texto', 'nome']);
  });

  test('listas aninhadas não são suportadas, mas não quebram', () => {
    const MOLDE = '<ul data-cms="externa" data-cms-tipo="lista" data-cms-item-rotulo="Bloco">' +
      '<li data-cms-item><b data-cms-campo="n">A</b>' +
      '<ol data-cms="interna" data-cms-tipo="lista" data-cms-campo="sub">' +
      '<li data-cms-item><i data-cms-campo="x">a1</i></li><li data-cms-item><i data-cms-campo="x">a2</i></li></ol>' +
      '</li></ul>';
    const doc = montar(MOLDE);
    const esquema = extrairEsquema(doc);
    assert.equal(esquema.grupos.length, 1);
    assert.deepEqual(esquema.grupos[0].campos.map((c) => c.chave), ['externa']);
    assert.deepEqual(esquema.grupos[0].campos[0].campos.map((c) => c.campo), ['n']);
    assert.deepEqual(esquema.grupos[0].campos[0].padrao, [{ n: 'A' }]);
    assert.doesNotThrow(() => aplicarConteudo(doc, {
      externa: [{ n: 'B', sub: [{ x: 'z' }] }, { n: 'C' }],
      interna: [{ x: 'q' }]
    }));
    const externos = $$(doc, 'ul > li');
    assert.deepEqual(externos.map((li) => $(li, 'b').textContent), ['B', 'C']);
    for (const li of externos) assert.deepEqual($$(li, 'ol i').map((i) => i.textContent), ['a1', 'a2']);
  });
});

describe('visibilidade de grupos', () => {
  test('grupo.<id>.visivel === false remove o elemento ocultável', () => {
    const doc = montar(FIXTURE);
    aplicarConteudo(doc, { 'grupo.quem-somos.visivel': false, 'grupo.depoimentos.visivel': true });
    assert.ok($(doc, '#quem-somos') === null);
    assert.ok($(doc, '#depoimentos'));
  });

  test('não remove grupo sem data-cms-ocultavel', () => {
    const doc = montar(FIXTURE);
    assertSemMudanca(doc, { 'grupo.cabecalho.visivel': false, 'grupo.rodape.visivel': false, 'grupo.seo.visivel': false });
  });

  test('só o booleano false oculta', () => {
    for (const valor of [true, 'false', 0, '', null, undefined, {}, []]) {
      assertSemMudanca(montar(FIXTURE), { 'grupo.quem-somos.visivel': valor }, JSON.stringify(valor));
    }
  });

  test('<html>, <head> e <body> nunca são ocultados', () => {
    const doc = montar('<!doctype html><html><head data-cms-grupo="cabeca" data-cms-ocultavel><title data-cms="t">T</title></head>' +
      '<body data-cms-grupo="corpo" data-cms-ocultavel><p data-cms="corpo.x">x</p></body></html>');
    assert.deepEqual(extrairEsquema(doc).grupos.map((g) => [g.id, g.ocultavel]), [['cabeca', false], ['corpo', false]]);
    assertSemMudanca(doc, { 'grupo.cabeca.visivel': false, 'grupo.corpo.visivel': false });
  });

  test('remove todos os elementos do mesmo grupo que são ocultáveis', () => {
    const doc = montar('<section class="a" data-cms-grupo="g" data-cms-ocultavel><p data-cms="g.x">x</p></section>' +
      '<aside class="b" data-cms-grupo="g" data-cms-ocultavel>b</aside><div class="c" data-cms-grupo="g">c</div>');
    aplicarConteudo(doc, { 'grupo.g.visivel': false });
    assert.ok($(doc, '.a') === null);
    assert.ok($(doc, '.b') === null);
    assert.ok($(doc, '.c'));
  });
});

describe('valores ausentes, nulos ou de formato errado', () => {
  test('conteúdo vazio ou inválido não altera nada e não lança', () => {
    for (const conteudo of [undefined, null, {}, 'texto', 42, true, [], [1, 2], new Date(0), () => {}]) {
      assertSemMudanca(montar(FIXTURE), conteudo, String(conteudo));
    }
  });

  test('null e undefined mantêm o padrão de cada campo', () => {
    const nulos = Object.fromEntries(Object.keys(PADROES).map((chave) => [chave, null]));
    assertSemMudanca(montar(FIXTURE), nulos);
    const indefinidos = Object.fromEntries(Object.keys(PADROES).map((chave) => [chave, undefined]));
    assertSemMudanca(montar(FIXTURE), indefinidos);
  });

  test('formato errado mantém o padrão de cada tipo', () => {
    const errados = {
      texto: [42, true, {}, [], ['x'], { texto: 'x' }],
      textolongo: [42, false, {}, ['a', 'b']],
      html: [42, {}, ['<p>x</p>'], { html: '<p>x</p>' }],
      imagem: ['/img/x.jpg', 42, [], [{ src: '/x.jpg' }], true, { src: 42, alt: 7 }, {}],
      video: ['/v.mp4', 42, [], { src: 42, poster: false }],
      link: ['/x', 42, [], { href: 42, texto: 7 }, { href: '', texto: '' }],
      url: [42, {}, ['/x'], { href: '/x' }, '', '   '],
      instagram: [42, {}, ['https://www.instagram.com/p/AAA111bbb/'], ''],
      meta: [42, {}, [], true],
      lista: ['x', 42, {}, [1], ['x'], [[]]]
    };
    const esquema = extrairEsquema(montar(FIXTURE));
    for (const grupo of esquema.grupos) {
      for (const campo of grupo.campos) {
        for (const valor of errados[campo.tipo]) {
          assertSemMudanca(montar(FIXTURE), { [campo.chave]: valor }, `${campo.chave} (${campo.tipo}) = ${JSON.stringify(valor)}`);
        }
      }
    }
  });

  test('getters que lançam não quebram a aplicação', () => {
    const doc = montar(FIXTURE);
    const conteudo = {
      get aviso() { throw new Error('falha'); },
      'cabecalho.logo': { get src() { throw new Error('falha'); }, alt: 'x' },
      'quem-somos.titulo': 'Aplicado mesmo assim'
    };
    assert.doesNotThrow(() => aplicarConteudo(doc, conteudo));
    assert.equal($(doc, '[data-cms="quem-somos.titulo"]').textContent, 'Aplicado mesmo assim');
    assert.equal($(doc, '[data-cms="aviso"]').textContent, 'Aviso geral do site');
  });

  test('chaves desconhecidas são ignoradas', () => {
    assertSemMudanca(montar(FIXTURE), JSON.parse('{"nao.existe": "x", "__proto__": {"aviso": "x"}, "constructor": "y", "toString": "z"}'));
    assertSemMudanca(montar(FIXTURE), Object.create({ aviso: 'herdado não conta' }));
  });

  test('entradas inválidas nas outras funções', () => {
    assert.deepEqual(extrairEsquema(null), { grupos: [] });
    assert.deepEqual(extrairEsquema(undefined), { grupos: [] });
    assert.deepEqual(extrairEsquema({}), { grupos: [] });
    assert.equal(lerValor(null, 'texto'), null);
    assert.equal(lerValor(undefined, 'imagem'), null);
    const doc = montar('<p>x</p>');
    assert.equal(lerValor($(doc, 'p').firstChild, 'texto'), null);
    assert.doesNotThrow(() => aplicarConteudo(null, { a: 1 }));
    assert.doesNotThrow(() => aplicarConteudo(undefined, undefined));
    assert.doesNotThrow(() => aplicarConteudo({}, { a: 1 }));
  });

  test('chaves fora do padrão no template são ignoradas', () => {
    const doc = montar('<p data-cms="Chave Inválida">a</p><p data-cms="-x">b</p><p data-cms="">c</p>' +
      '<p data-cms="grupo.g.visivel">d</p><p data-cms="Quem.Titulo">e</p><p data-cms=" com-espaco ">f</p>' +
      `<p data-cms="${'a'.repeat(121)}">g</p><p data-cms="ok">h</p>`);
    const esquema = extrairEsquema(doc);
    assert.deepEqual(esquema.grupos.flatMap((g) => g.campos.map((c) => c.chave)), ['ok']);
    assertSemMudanca(doc, {
      'Chave Inválida': 'x', '-x': 'x', '': 'x', 'grupo.g.visivel': 'x', 'Quem.Titulo': 'x', 'quem.titulo': 'x',
      ' com-espaco ': 'x', 'com-espaco': 'x', ['a'.repeat(121)]: 'x'
    });
  });

  test('id de grupo fora do padrão é ignorado (o campo vai para o grupo de cima ou "geral")', () => {
    const doc = montar('<section data-cms-grupo="Quem-Somos" data-cms-ocultavel><p data-cms="a">a</p></section>' +
      '<section data-cms-grupo="ok" data-cms-ocultavel><div data-cms-grupo=" x "><p data-cms="b">b</p></div></section>');
    assert.deepEqual(extrairEsquema(doc).grupos.map((g) => [g.id, g.campos.map((c) => c.chave)]), [
      ['geral', ['a']],
      ['ok', ['b']]
    ]);
    assertSemMudanca(doc, { 'grupo.quem-somos.visivel': false, 'grupo.Quem-Somos.visivel': false, 'grupo.x.visivel': false });
  });

  test('data-cms-tipo só vale escrito exatamente como na tabela 5.3', () => {
    const doc = montar('<ul data-cms="l" data-cms-tipo="LISTA"><li data-cms-item><b data-cms-campo="n">a</b></li></ul>' +
      '<p data-cms="t" data-cms-tipo=" textolongo">a<br>b</p>');
    assert.deepEqual(extrairEsquema(doc).grupos[0].campos.map((c) => [c.chave, c.tipo, c.padrao]), [
      ['l', 'texto', 'a'],
      ['t', 'texto', 'ab']
    ]);
  });
});

describe('XSS de ponta a ponta', () => {
  test('valores maliciosos em todos os campos não geram nada executável', () => {
    const doc = montar(FIXTURE);
    const scriptsAntes = $$(doc, 'script').length;
    aplicarConteudo(doc, MALICIOSOS);
    assertDocumentoSeguro(doc, scriptsAntes);
    // URLs inseguras mantêm o padrão
    assert.equal($(doc, '[data-cms="cabecalho.logo-link"]').getAttribute('href'), '/');
    assert.deepEqual(lerValor($(doc, '[data-cms="cabecalho.logo"]'), 'imagem'), PADROES['cabecalho.logo']);
    assert.deepEqual(lerValor($(doc, '[data-cms="quem-somos.foto"]'), 'imagem'), PADROES['quem-somos.foto']);
    assert.deepEqual(lerValor($(doc, '[data-cms="quem-somos.video"]'), 'video'), PADROES['quem-somos.video']);
    assert.deepEqual(lerValor($(doc, '[data-cms="quem-somos.botao"]'), 'link'), PADROES['quem-somos.botao']);
    assert.deepEqual(lerValor($(doc, '[data-cms="rodape.whatsapp"]'), 'link'), PADROES['rodape.whatsapp']);
    assert.equal(lerValor($(doc, '[data-cms="postagens.post-1"]'), 'instagram'), PADROES['postagens.post-1']);
    assert.equal(lerValor($(doc, '[data-cms="postagens.perfil"]'), 'url'), PADROES['postagens.perfil']);
    // textos viram texto
    assert.equal($(doc, '[data-cms="aviso"]').textContent, '<script>alert(1)</script>');
    assert.equal($(doc, '[data-cms="quem-somos.titulo"]').textContent, '<script>alert(1)</script>');
    assert.equal($(doc, '[data-cms="seo.descricao"]').getAttribute('content'), '"><script>alert(1)</script>');
    const [, segundo] = $$(doc, '.grade [data-cms-item]');
    assert.equal($(segundo, 'img').getAttribute('alt'), '" onerror="alert(1)" x="');
    assert.equal($(segundo, 'strong').textContent, '<script>alert(1)</script>');
    assert.equal($$(doc, '.menu a')[1].getAttribute('href'), '/ok" onmouseover="alert(1)');
  });

  test('o mesmo vale depois de serializar e analisar de novo', () => {
    const doc = montar(FIXTURE);
    aplicarConteudo(doc, MALICIOSOS);
    const novo = reparsear(doc);
    assert.equal($(novo, '[data-cms="aviso"]').textContent, '<script>alert(1)</script>');
    assert.equal($(novo, 'meta[name="description"]').getAttribute('content'), '"><script>alert(1)</script>');
    assertHtmlLimpo($(novo, '[data-cms="quem-somos.corpo"]').innerHTML.replace(/<span class="selo" data-cms-fixo="">Desde 2010<\/span>$/, ''), MALICIOSOS['quem-somos.corpo']);
  });
});

describe('extrairEsquema', () => {
  const campo = (chave, tipo, rotulo, ajuda = '') => ({ chave, tipo, rotulo, ajuda, padrao: PADROES[chave] });

  test('grupos e campos na ordem do documento, com rótulos, ajuda, padrões, listas e espelhos', () => {
    const esquema = extrairEsquema(montar(FIXTURE));
    assert.deepEqual(esquema, {
      grupos: [
        {
          id: 'seo', rotulo: 'SEO e compartilhamento', ocultavel: false,
          campos: [
            campo('seo.titulo', 'texto', 'Título da página'),
            campo('seo.descricao', 'meta', 'Descrição', 'Aparece nos resultados de busca')
          ]
        },
        {
          id: 'cabecalho', rotulo: 'Cabeçalho', ocultavel: false,
          campos: [
            campo('cabecalho.logo-link', 'url', 'Link do logo'),
            campo('cabecalho.logo', 'imagem', 'Logo'),
            {
              ...campo('cabecalho.menu', 'lista', 'Menu'),
              itemRotulo: 'Item do menu',
              campos: [{ campo: 'link', tipo: 'link', rotulo: 'Link', ajuda: '' }]
            }
          ]
        },
        {
          id: 'quem-somos', rotulo: 'Quem somos', ocultavel: true,
          campos: [
            campo('quem-somos.titulo', 'texto', 'Título'),
            campo('quem-somos.texto', 'textolongo', 'Texto'),
            campo('quem-somos.corpo', 'html', 'Corpo'),
            campo('quem-somos.foto', 'imagem', 'Foto'),
            campo('quem-somos.video', 'video', 'Vídeo'),
            campo('quem-somos.botao', 'link', 'Botão')
          ]
        },
        {
          id: 'postagens', rotulo: 'Postagens', ocultavel: false,
          campos: [
            campo('postagens.post-1', 'instagram', 'Publicação 1'),
            campo('postagens.perfil', 'url', 'Perfil')
          ]
        },
        {
          id: 'depoimentos', rotulo: 'Depoimentos', ocultavel: true,
          campos: [
            campo('depoimentos.titulo', 'texto', 'Título'),
            {
              ...campo('depoimentos.itens', 'lista', 'Depoimentos'),
              itemRotulo: 'Depoimento',
              campos: [
                { campo: 'foto', tipo: 'imagem', rotulo: 'Foto', ajuda: '' },
                { campo: 'texto', tipo: 'textolongo', rotulo: 'Depoimento', ajuda: 'Até 300 caracteres' },
                { campo: 'nome', tipo: 'texto', rotulo: 'Nome', ajuda: '' }
              ]
            }
          ]
        },
        { id: 'parcerias', rotulo: 'Parcerias', ocultavel: true, campos: [] },
        {
          id: 'rodape', rotulo: 'Rodapé', ocultavel: false,
          campos: [
            campo('rodape.direitos', 'texto', 'Direitos'),
            campo('rodape.whatsapp', 'link', 'WhatsApp')
          ]
        },
        { id: 'geral', rotulo: 'Geral', ocultavel: false, campos: [campo('aviso', 'texto', 'Aviso')] }
      ]
    });
  });

  test('campo pertence ao grupo mais próximo; sem grupo vai para "geral", na ordem em que aparece', () => {
    const doc = montar('<p data-cms="topo">t</p>' +
      '<section data-cms-grupo="a" data-cms-grupo-rotulo="A"><p data-cms="a.x">x</p>' +
      '<div data-cms-grupo="b"><p data-cms="b.y">y</p></div><p data-cms="a.z">z</p></section>' +
      '<p data-cms="fim">f</p>');
    const esquema = extrairEsquema(doc);
    assert.deepEqual(esquema.grupos.map((g) => [g.id, g.campos.map((c) => c.chave)]), [
      ['geral', ['topo', 'fim']],
      ['a', ['a.x', 'a.z']],
      ['b', ['b.y']]
    ]);
    assert.equal(esquema.grupos[1].rotulo, 'A');
    assert.equal(typeof esquema.grupos[2].rotulo, 'string');
    assert.ok(esquema.grupos[2].rotulo.length > 0);
  });

  test('grupo sem campos e não ocultável não aparece', () => {
    const doc = montar('<section data-cms-grupo="vazio"><p>nada</p></section><p data-cms="x">x</p>');
    assert.deepEqual(extrairEsquema(doc).grupos.map((g) => g.id), ['geral']);
  });

  test('rótulo padrão quando falta data-cms-rotulo', () => {
    const doc = montar('<section data-cms-grupo="g"><p data-cms="g.algum-campo">x</p></section>');
    const [c] = extrairEsquema(doc).grupos[0].campos;
    assert.equal(typeof c.rotulo, 'string');
    assert.ok(c.rotulo.length > 0);
    assert.equal(c.ajuda, '');
  });

  test('espelhos: o esquema usa o primeiro e todos recebem o valor', () => {
    const doc = montar(FIXTURE);
    aplicarConteudo(doc, { 'seo.titulo': 'Título espelhado' });
    assert.equal($(doc, 'title').textContent, 'Título espelhado');
    assert.equal($(doc, 'meta[property="og:title"]').getAttribute('content'), 'Título espelhado');
    const seo = extrairEsquema(doc).grupos[0];
    assert.deepEqual(seo.campos.map((c) => c.chave), ['seo.titulo', 'seo.descricao']);
    assert.equal(seo.campos[0].tipo, 'texto');
    assert.equal(seo.campos[0].padrao, 'Título espelhado');
  });

  test('espelhos do mesmo tipo em lugares diferentes', () => {
    const doc = montar('<header><span data-cms="tel">(91) 0000-0000</span></header><footer><span data-cms="tel">(91) 0000-0000</span></footer>');
    aplicarConteudo(doc, { tel: '(91) 98888-7777' });
    assert.deepEqual($$(doc, '[data-cms="tel"]').map((el) => el.textContent), ['(91) 98888-7777', '(91) 98888-7777']);
    assert.equal(extrairEsquema(doc).grupos[0].campos.length, 1);
  });

  test('sem data-cms-tipo, o tipo é deduzido da tag', () => {
    const doc = montar('<!doctype html><html><head><meta name="d" content="c" data-cms="m"></head><body>' +
      '<img src="/a.jpg" alt="A" data-cms="i">' +
      '<video src="/v.mp4" poster="/p.jpg" data-cms="v"></video>' +
      '<a href="/x" data-cms="l">L</a>' +
      '<iframe src="https://www.instagram.com/p/AAA111bbb/embed/captioned/" data-cms="ig"></iframe>' +
      '<iframe src="https://exemplo.com/e" data-cms="if"></iframe>' +
      '<p data-cms="t">T</p><p data-cms="d" data-cms-tipo="desconhecido">D</p></body></html>');
    assert.deepEqual(extrairEsquema(doc).grupos[0].campos.map((c) => [c.chave, c.tipo, c.padrao]), [
      ['m', 'meta', 'c'],
      ['i', 'imagem', { src: '/a.jpg', alt: 'A' }],
      ['v', 'video', { src: '/v.mp4', poster: '/p.jpg' }],
      ['l', 'link', { href: '/x', texto: 'L' }],
      ['ig', 'instagram', 'https://www.instagram.com/p/AAA111bbb/'],
      ['if', 'url', 'https://exemplo.com/e'],
      ['t', 'texto', 'T'],
      ['d', 'texto', 'D']
    ]);
    aplicarConteudo(doc, { ig: 'https://www.instagram.com/reel/BBB222ccc/', if: '/outra', i: { src: '/b.jpg' } });
    assert.equal($(doc, '[data-cms="ig"]').getAttribute('src'), 'https://www.instagram.com/reel/BBB222ccc/embed/captioned/');
    assert.equal($(doc, '[data-cms="if"]').getAttribute('src'), '/outra');
    assert.equal($(doc, 'img').getAttribute('src'), '/b.jpg');
  });

  test('lista sem data-cms-item-rotulo tem itemRotulo de texto', () => {
    const doc = montar('<ul data-cms="l" data-cms-tipo="lista"><li data-cms-item><span data-cms-campo="n" data-cms-ajuda="dica">a</span></li></ul>');
    const [c] = extrairEsquema(doc).grupos[0].campos;
    assert.equal(typeof c.itemRotulo, 'string');
    assert.ok(c.itemRotulo.length > 0);
    assert.equal(c.campos[0].ajuda, 'dica');
    assert.equal(c.campos[0].tipo, 'texto');
  });

  test('não altera o documento', () => {
    const doc = montar(FIXTURE);
    const antes = serializar(doc);
    extrairEsquema(doc);
    assert.equal(serializar(doc), antes);
  });
});

describe('idempotência e ida e volta', () => {
  const conjuntos = {
    novos: NOVOS,
    maliciosos: MALICIOSOS,
    padroes: PADROES,
    'lista vazia e grupo oculto': { 'depoimentos.itens': [], 'cabecalho.menu': [], 'grupo.quem-somos.visivel': false },
    'html não canônico': { 'quem-somos.corpo': '<P CLASS=x>a<B>b</B>\n<script>x</script>' }
  };

  for (const [nome, conteudo] of Object.entries(conjuntos)) {
    test(`aplicar duas vezes dá o mesmo HTML que uma vez (${nome})`, () => {
      const doc = montar(FIXTURE);
      aplicarConteudo(doc, conteudo);
      const umaVez = serializar(doc);
      aplicarConteudo(doc, conteudo);
      assert.equal(serializar(doc), umaVez);
      // Num documento novo, o resultado também é o mesmo.
      const outro = montar(FIXTURE);
      aplicarConteudo(outro, conteudo);
      assert.equal(serializar(outro), umaVez);
    });
  }

  test('aplicar outro conteúdo e voltar dá o mesmo HTML (mesmo documento)', () => {
    const doc = montar(FIXTURE);
    aplicarConteudo(doc, NOVOS);
    aplicarConteudo(doc, PADROES);
    aplicarConteudo(doc, { 'depoimentos.itens': [], 'cabecalho.menu': [] });
    aplicarConteudo(doc, NOVOS);
    const novo = montar(FIXTURE);
    aplicarConteudo(novo, NOVOS);
    assert.equal(serializar(doc), serializar(novo));
  });

  test('aplicar os próprios padrões não altera o HTML', () => {
    const doc = montar(FIXTURE);
    const padroes = {};
    for (const grupo of extrairEsquema(doc).grupos) {
      if (grupo.ocultavel) padroes[`grupo.${grupo.id}.visivel`] = true;
      for (const c of grupo.campos) padroes[c.chave] = c.padrao;
    }
    assert.deepEqual(Object.keys(padroes).filter((k) => !k.startsWith('grupo.')).sort(), Object.keys(PADROES).sort());
    assertSemMudanca(doc, padroes);
  });

  test('aplicar e ler devolve os mesmos valores (lerValor e extrairEsquema)', () => {
    const doc = montar(FIXTURE);
    aplicarConteudo(doc, NOVOS);
    const lidos = {};
    for (const grupo of extrairEsquema(doc).grupos) for (const c of grupo.campos) lidos[c.chave] = c.padrao;
    assert.deepEqual(lidos, NOVOS);
    for (const [chave, valor] of Object.entries(NOVOS)) {
      // inclui os espelhos (seo.titulo em <title> e em <meta property="og:title">)
      for (const el of $$(doc, `[data-cms="${chave}"]`)) {
        assert.deepEqual(lerValor(el, el.getAttribute('data-cms-tipo')), valor, chave);
      }
    }
  });

  test('ida e volta também depois de serializar (como no servidor)', () => {
    const doc = montar(FIXTURE);
    aplicarConteudo(doc, NOVOS);
    const lidos = {};
    for (const grupo of extrairEsquema(reparsear(doc)).grupos) for (const c of grupo.campos) lidos[c.chave] = c.padrao;
    assert.deepEqual(lidos, NOVOS);
  });
});

describe('templates/home.html', () => {
  test('aplicarConteudo({}) não altera o documento', () => {
    const doc = montar(HOME);
    assertSemMudanca(doc, {});
  });

  test('aplicar os padrões extraídos do próprio template não altera o documento', () => {
    const doc = montar(HOME);
    const padroes = {};
    for (const grupo of extrairEsquema(doc).grupos) {
      for (const c of grupo.campos) {
        // Espelhos podem ter conteúdos diferentes no template; aqui só as chaves de um elemento.
        if ($$(doc, '[data-cms]').filter((el) => el.getAttribute('data-cms') === c.chave).length === 1) {
          padroes[c.chave] = c.padrao;
        }
      }
    }
    assertSemMudanca(doc, padroes);
  });
});
