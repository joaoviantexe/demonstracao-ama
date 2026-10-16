// Testes da home editável (templates/home.html), do public/js/main.js e do render com o template real.
// Contrato: docs/ARQUITETURA.md §5. Requer o cwd na raiz do repositório (npm test).
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { aplicarConteudo, extrairEsquema, lerValor } from '../../public/js/cms/aplicar.js';
import render, { ogImagemAbsoluta } from '../../api/render.js';
import {
  AMBIENTE_VAZIO, aplicarAmbiente, chamarHandler, respostaJson, simularFetch,
} from '../apoio/servidor.js';

const RAIZ = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TEMPLATE = readFileSync(path.join(RAIZ, 'templates', 'home.html'), 'utf8');
const MAIN_JS = readFileSync(path.join(RAIZ, 'public', 'js', 'main.js'), 'utf8');
const ESTILO = readFileSync(path.join(RAIZ, 'public', 'css', 'estilo.css'), 'utf8');

const GRUPOS = [
  'seo', 'cabecalho', 'identidade', 'quem-somos', 'postagens', 'projetos', 'historia', 'loja',
  'depoimentos', 'parcerias', 'rodape', 'whatsapp',
];
const OCULTAVEIS = ['quem-somos', 'postagens', 'projetos', 'historia', 'loja', 'depoimentos', 'parcerias', 'whatsapp'];
const RE_CHAVE = /^[a-z0-9][a-z0-9._-]*$/;
const TIPOS_VALIDOS = ['texto', 'textolongo', 'html', 'imagem', 'video', 'link', 'url', 'instagram', 'meta', 'lista'];

const montar = (html = TEMPLATE) => parseHTML(html).document;
const $ = (raiz, seletor) => raiz.querySelector(seletor);
const $$ = (raiz, seletor) => Array.from(raiz.querySelectorAll(seletor));
const texto = (el) => String(el.textContent).replace(/\s+/g, ' ').trim();
const camposDoEsquema = (esquema) => esquema.grupos.flatMap((g) => g.campos);

// Elementos [data-cms] fora de itens de lista, agrupados por chave (espelhos juntos).
function elementosPorChave(doc) {
  const mapa = new Map();
  for (const el of $$(doc, '[data-cms]')) {
    const item = el.closest('[data-cms-item]');
    if (item && item.closest('[data-cms-tipo="lista"]')) continue;
    const chave = el.getAttribute('data-cms');
    if (!mapa.has(chave)) mapa.set(chave, []);
    mapa.get(chave).push(el);
  }
  return mapa;
}

describe('templates/home.html — esquema do CMS', () => {
  const esquema = extrairEsquema(montar());

  test('tem exatamente os grupos do contrato, na ordem do documento', () => {
    assert.deepEqual(esquema.grupos.map((g) => g.id), GRUPOS);
  });

  test('todo grupo tem rótulo e campos; as seções principais são ocultáveis', () => {
    for (const grupo of esquema.grupos) {
      assert.ok(grupo.rotulo && grupo.rotulo !== grupo.id, `rótulo do grupo ${grupo.id}`);
      assert.ok(grupo.campos.length > 0, `campos do grupo ${grupo.id}`);
      assert.equal(grupo.ocultavel, OCULTAVEIS.includes(grupo.id), `ocultável: ${grupo.id}`);
    }
  });

  test('chaves válidas, prefixadas pelo grupo, com tipo explícito e rótulo próprio', () => {
    for (const grupo of esquema.grupos) {
      for (const campo of grupo.campos) {
        assert.match(campo.chave, RE_CHAVE);
        assert.ok(campo.chave.startsWith(`${grupo.id}.`), `${campo.chave} começa com ${grupo.id}.`);
        assert.ok(TIPOS_VALIDOS.includes(campo.tipo), `${campo.chave}: tipo ${campo.tipo}`);
        assert.ok(campo.rotulo, `${campo.chave}: rótulo`);
        if (campo.tipo === 'lista') {
          assert.ok(campo.itemRotulo && campo.itemRotulo !== 'Item', `${campo.chave}: rótulo do item`);
          assert.ok(campo.campos.length > 0, `${campo.chave}: campos do item`);
          for (const sub of campo.campos) {
            assert.ok(TIPOS_VALIDOS.includes(sub.tipo) && sub.tipo !== 'lista', `${campo.chave}.${sub.campo}`);
            assert.ok(sub.rotulo, `${campo.chave}.${sub.campo}: rótulo`);
          }
        }
      }
    }
    const doc = montar();
    for (const el of $$(doc, '[data-cms], [data-cms-campo]')) {
      assert.ok(TIPOS_VALIDOS.includes(el.getAttribute('data-cms-tipo')),
        `tipo explícito em ${el.outerHTML.slice(0, 80)}`);
    }
  });

  test('a mesma chave nunca aparece com tipos diferentes; espelhos têm o mesmo padrão', () => {
    const doc = montar();
    for (const [chave, elementos] of elementosPorChave(doc)) {
      const tipos = new Set(elementos.map((el) => el.getAttribute('data-cms-tipo')));
      assert.equal(tipos.size, 1, `${chave}: ${[...tipos].join(', ')}`);
      const [tipo] = tipos;
      const padrao = JSON.stringify(lerValor(elementos[0], tipo));
      for (const el of elementos.slice(1)) assert.equal(JSON.stringify(lerValor(el, tipo)), padrao, `espelho de ${chave}`);
    }
    // Dentro de cada lista, o mesmo campo tem sempre o mesmo tipo e todos os itens têm os mesmos campos.
    for (const lista of $$(doc, '[data-cms-tipo="lista"]')) {
      const itens = $$(lista, '[data-cms-item]').filter((item) => item.closest('[data-cms-tipo="lista"]') === lista);
      assert.ok(itens.length > 0, `itens de ${lista.getAttribute('data-cms')}`);
      const assinatura = (item) => {
        const els = $$(item, '[data-cms-campo]');
        if (item.hasAttribute('data-cms-campo')) els.unshift(item);
        return els.map((el) => `${el.getAttribute('data-cms-campo')}:${el.getAttribute('data-cms-tipo')}`).join('|');
      };
      const primeira = assinatura(itens[0]);
      for (const item of itens) assert.equal(assinatura(item), primeira, `itens de ${lista.getAttribute('data-cms')}`);
    }
  });

  test('cobre o conteúdo visível pedido', () => {
    const chaves = new Set(camposDoEsquema(esquema).map((c) => c.chave));
    for (const chave of [
      'seo.titulo', 'seo.descricao', 'seo.og-titulo', 'seo.og-descricao', 'seo.og-imagem',
      'identidade.logo', 'cabecalho.menu',
      'quem-somos.titulo', 'quem-somos.video', 'quem-somos.texto',
      'postagens.titulo', 'postagens.publicacoes', 'postagens.perfil',
      'projetos.titulo', 'projetos.subtitulo', 'projetos.itens',
      'historia.titulo', 'historia.galeria', 'historia.trechos', 'historia.coragem-titulo',
      'historia.coragem-citacao', 'historia.coragem-referencia', 'historia.manifesto-titulo', 'historia.manifesto-texto',
      'loja.titulo', 'loja.texto', 'loja.botao', 'loja.imagem-1', 'loja.imagem-2', 'loja.imagem-3',
      'depoimentos.titulo', 'depoimentos.itens', 'parcerias.titulo', 'parcerias.logos',
      'rodape.contatos', 'rodape.copyright', 'whatsapp.link',
    ]) {
      assert.ok(chaves.has(chave), `falta ${chave}`);
    }
    const tipo = (chave) => camposDoEsquema(esquema).find((c) => c.chave === chave).tipo;
    assert.equal(tipo('cabecalho.menu'), 'lista');
    assert.equal(tipo('quem-somos.video'), 'video');
    assert.equal(tipo('quem-somos.texto'), 'html');
    assert.equal(tipo('postagens.publicacoes'), 'lista');
    assert.equal(tipo('historia.trechos'), 'lista');
    assert.equal(tipo('historia.manifesto-texto'), 'html');
    assert.equal(tipo('loja.botao'), 'link');
    assert.equal(tipo('whatsapp.link'), 'link');
    const subcampos = (chave) => camposDoEsquema(esquema).find((c) => c.chave === chave).campos
      .map((c) => `${c.campo}:${c.tipo}`);
    assert.deepEqual(subcampos('cabecalho.menu'), ['link:link']);
    assert.deepEqual(subcampos('postagens.publicacoes'), ['publicacao:instagram']);
    assert.deepEqual(subcampos('projetos.itens'), ['cartaz:imagem', 'botao:link']);
    assert.deepEqual(subcampos('historia.galeria'), ['imagem:imagem']);
    assert.deepEqual(subcampos('historia.trechos'), ['texto:html']);
    assert.deepEqual(subcampos('depoimentos.itens'), ['texto:textolongo', 'foto:imagem', 'nome:texto']);
    assert.deepEqual(subcampos('parcerias.logos'), ['logo:imagem']);
    assert.deepEqual(subcampos('rodape.contatos'), ['rotulo:texto', 'link:link']);
  });

  test('padrões lidos do template batem com o conteúdo da página', () => {
    const padrao = (chave) => camposDoEsquema(esquema).find((c) => c.chave === chave).padrao;
    assert.equal(padrao('seo.titulo'), 'Associação de Mulheres na Amazônia - AMA');
    assert.equal(padrao('seo.og-imagem'), '/img/logo-ama.png');
    assert.deepEqual(padrao('cabecalho.menu').map((i) => i.link), [
      { href: '#sobre', texto: 'Sobre' },
      { href: '#redes', texto: 'Postagens' },
      { href: '#cursos', texto: 'Projetos' },
      { href: '/loja/', texto: 'Cosméticos' },
      { href: '#historia', texto: 'História' },
      { href: '#depoimentos', texto: 'Depoimentos' },
    ]);
    assert.deepEqual(padrao('quem-somos.video'), { src: '/img/sobre-ama-video.mp4', poster: '/img/sobre-video-poster.jpg' });
    assert.equal(padrao('postagens.publicacoes').length, 3);
    assert.equal(padrao('postagens.publicacoes')[0].publicacao, 'https://www.instagram.com/reel/DdtzBiCNWnB/');
    assert.deepEqual(padrao('postagens.perfil'), {
      href: 'https://www.instagram.com/oscdemulheres/', texto: 'Acompanhe mais publicações no @oscdemulheres',
    });
    assert.equal(padrao('projetos.itens').length, 4);
    assert.deepEqual(padrao('projetos.itens')[0].cartaz, { src: '/img/capa-curso-ela-empreende.jpg', alt: 'Ela Empreende' });
    assert.equal(padrao('projetos.itens')[0].botao.texto, 'Conhecer');
    assert.equal(padrao('historia.galeria').length, 3);
    assert.equal(padrao('historia.trechos').length, 4);
    assert.match(padrao('historia.trechos')[0].texto, /^<p>Mônica Moura, aos 54 anos/);
    assert.doesNotMatch(padrao('historia.trechos')[0].texto, /historia-expandir/, 'o botão fixo não entra no texto');
    assert.equal(padrao('historia.coragem-referencia'), 'Josué 1:9');
    assert.deepEqual(padrao('loja.botao'), { href: '/loja/', texto: 'Conhecer a loja' });
    assert.equal(padrao('loja.subtitulo'), 'Saboaria, perfumaria e biojoias da Amazônia');
    assert.equal(padrao('loja.frase'), 'Feito com amor, força e raízes da floresta.');
    assert.match(padrao('loja.imagem-1').src, /^\/img\/.+\.jpg$/);
    assert.equal(padrao('depoimentos.itens').length, 3);
    assert.deepEqual(padrao('depoimentos.itens')[2].nome, 'Maria Rita');
    assert.equal(padrao('parcerias.logos').length, 8);
    assert.deepEqual(padrao('rodape.contatos'), [
      { rotulo: 'WhatsApp:', link: { href: 'https://wa.me/5591981056049', texto: '(91) 98105-6049' } },
      { rotulo: 'Instagram:', link: { href: 'https://www.instagram.com/oscdemulheres/', texto: '@oscdemulheres' } },
    ]);
    assert.equal(padrao('rodape.copyright'), 'Associação de Mulheres na Amazônia - AMA. Todos os direitos reservados.');
    assert.deepEqual(padrao('whatsapp.link'), { href: 'https://wa.me/5591981056049', texto: 'Falar no WhatsApp' });
  });
});

describe('templates/home.html — aplicação do conteúdo', () => {
  test('aplicarConteudo(doc, {}) não altera o HTML', () => {
    const doc = montar();
    const antes = doc.toString();
    aplicarConteudo(doc, {});
    assert.equal(doc.toString(), antes);
  });

  test('aplicar os padrões do próprio esquema não altera o HTML (e reaplicar também não)', () => {
    const doc = montar();
    const antes = doc.toString();
    const padroes = {};
    for (const campo of camposDoEsquema(extrairEsquema(doc))) padroes[campo.chave] = campo.padrao;
    for (const grupo of GRUPOS) padroes[`grupo.${grupo}.visivel`] = true;
    aplicarConteudo(doc, padroes);
    assert.equal(doc.toString(), antes);
    aplicarConteudo(doc, padroes);
    assert.equal(doc.toString(), antes);
    // Num documento novo, a partir do HTML serializado, também.
    const outro = montar(antes);
    aplicarConteudo(outro, padroes);
    assert.equal(outro.toString(), antes);
  });

  test('o número do botão do WhatsApp vale para todos os links wa.me, mantendo as mensagens', () => {
    const antes = montar();
    const mensagens = $$(antes, 'a[href*="wa.me/"][href*="text="]').map((a) => a.getAttribute('href').split('?')[1]);
    assert.ok(mensagens.length >= 4, 'os botões dos projetos têm mensagem');
    const doc = montar();
    aplicarConteudo(doc, { 'whatsapp.link': { href: 'https://wa.me/5591977776666?text=ignorado', texto: 'Oi' } });
    const links = $$(doc, 'a[href*="wa.me/"]');
    assert.ok(links.length >= 6);
    for (const a of links) assert.match(a.getAttribute('href'), /^https:\/\/wa\.me\/5591977776666/, a.getAttribute('href'));
    assert.deepEqual($$(doc, 'a[href*="wa.me/"][href*="text="]').map((a) => a.getAttribute('href').split('?')[1]).sort(),
      [...mensagens, 'text=ignorado'].sort());
    // Endereço que não é wa.me não muda nada.
    const outro = montar();
    aplicarConteudo(outro, { 'whatsapp.link': { href: 'https://exemplo.com/zap', texto: 'Oi' } });
    assert.equal($$(outro, 'a[href*="wa.me/5591981056049"]').length, $$(antes, 'a[href*="wa.me/5591981056049"]').length - 1, 'só o próprio botão mudou');
  });

  test('valores de exemplo mudam os elementos certos, inclusive espelhos e listas', () => {
    const doc = montar();
    aplicarConteudo(doc, {
      'seo.titulo': 'AMA — título editado',
      'seo.descricao': 'Descrição editada',
      'seo.og-imagem': 'https://ama.exemplo.org/img/capa.jpg',
      'identidade.logo': { src: '/img/logo-nova.png', alt: 'Logo nova da AMA' },
      'cabecalho.menu': [
        { link: { href: '#sobre', texto: 'Quem somos' } },
        { link: { href: '/loja/', texto: 'Loja virtual' } },
      ],
      'quem-somos.titulo': 'Quem somos nós',
      'quem-somos.video': { src: '/img/outro-video.mp4', poster: '/img/outra-capa.jpg' },
      'quem-somos.texto': '<p>Texto <strong>novo</strong></p><script>alert(1)</script>',
      'postagens.publicacoes': [{ publicacao: 'https://www.instagram.com/p/ABC123xyz/' }],
      'postagens.perfil': { href: 'https://www.instagram.com/ama.exemplo/', texto: 'Siga a AMA' },
      'projetos.itens': [{
        cartaz: { src: '/img/cartaz-novo.jpg', alt: 'Projeto novo' },
        botao: { href: 'https://ama.exemplo.org/inscricao', texto: 'Inscreva-se' },
      }],
      'historia.galeria': [{ imagem: { src: '/img/foto-a.jpg', alt: 'Foto A' } }, { imagem: { src: '/img/foto-b.jpg', alt: 'Foto B' } }],
      'historia.trechos': [{ texto: '<p>Primeira parte.</p>' }, { texto: '<p>Segunda parte.</p>' }],
      'historia.coragem-citacao': 'Linha um\nLinha dois',
      'historia.manifesto-texto': '<p>Manifesto novo.</p>',
      'loja.titulo': 'Loja da AMA',
      'loja.botao': { href: '/loja/?categoria=sabonetes', texto: 'Ver sabonetes' },
      'loja.imagem-1': { src: '/img/produtos/body-splash-bruma.jpg', alt: 'Body splash Bruma' },
      'depoimentos.itens': [{ texto: 'Aprendi muito.', nome: 'Ana', foto: { src: '/img/ana.jpg', alt: 'Ana' } }],
      'parcerias.logos': [{ logo: { src: '/img/parceiros/novo.png', alt: 'Parceiro novo' } }],
      'rodape.contatos': [{ rotulo: 'E-mail:', link: { href: 'mailto:contato@ama.exemplo.org', texto: 'contato@ama.exemplo.org' } }],
      'rodape.copyright': 'AMA. Alguns direitos reservados.',
      'whatsapp.link': { href: 'https://wa.me/5591988887777', texto: 'Fale com a gente' },
    });

    assert.equal(texto($(doc, 'title')), 'AMA — título editado');
    assert.equal($(doc, 'meta[name="description"]').getAttribute('content'), 'Descrição editada');
    assert.equal($(doc, 'meta[property="og:title"]').getAttribute('content'), 'Associação de Mulheres na Amazônia - AMA');
    assert.equal($(doc, 'meta[property="og:image"]').getAttribute('content'), 'https://ama.exemplo.org/img/capa.jpg');

    // Espelhos: a logo da Identidade vale no topo, no menu do celular e no rodapé; menu do computador e do celular.
    for (const img of $$(doc, '.marca-logo, .menu-mobile-logo, .rodape-logo')) {
      assert.equal(img.getAttribute('src'), '/img/logo-nova.png');
      assert.equal(img.getAttribute('alt'), 'Logo nova da AMA');
    }
    for (const menu of [$(doc, '.nav-desktop'), $(doc, '#menu-mobile')]) {
      const links = $$(menu, 'a[data-cms-item]').map((a) => [a.getAttribute('href'), texto(a)]);
      assert.deepEqual(links, [['#sobre', 'Quem somos'], ['/loja/', 'Loja virtual']]);
    }
    assert.ok($(doc, '#menu-mobile .menu-mobile-topo'), 'o topo do menu do celular continua');
    const waMenu = $(doc, '#menu-mobile a.botao');
    // O número do botão do WhatsApp (whatsapp.link) vale para todos os links wa.me do site.
    assert.equal(waMenu.getAttribute('href'), 'https://wa.me/5591988887777');
    assert.equal(texto(waMenu), 'Falar no WhatsApp');
    for (const a of $$(doc, 'a[href*="wa.me/"]')) assert.match(a.getAttribute('href'), /^https:\/\/wa\.me\/5591988887777(\?text=.*)?$/, a.getAttribute('href'));
    assert.equal($(doc, '#menu-mobile').lastElementChild, waMenu, 'botão do WhatsApp continua no fim do menu');

    assert.equal(texto($(doc, '#sobre h2')), 'Quem somos nós');
    const video = $(doc, '#sobre video');
    assert.equal(video.getAttribute('src'), '/img/outro-video.mp4');
    assert.equal(video.getAttribute('poster'), '/img/outra-capa.jpg');
    assert.equal($(doc, '.sobre-descricao').innerHTML, '<p>Texto <strong>novo</strong></p>');

    const iframes = $$(doc, '#redes iframe');
    assert.equal(iframes.length, 1);
    assert.equal(iframes[0].getAttribute('src'), 'https://www.instagram.com/p/ABC123xyz/embed/captioned/');
    const perfil = $(doc, '.instagram-perfil-rodape a');
    assert.equal(perfil.getAttribute('href'), 'https://www.instagram.com/ama.exemplo/');
    assert.equal(texto(perfil), 'Siga a AMA');
    assert.ok($(perfil, 'svg'), 'o ícone do Instagram continua no botão');

    const projetos = $$(doc, '#carrossel-projetos > article');
    assert.equal(projetos.length, 1);
    assert.equal($(projetos[0], 'img').getAttribute('src'), '/img/cartaz-novo.jpg');
    assert.equal($(projetos[0], 'img').getAttribute('alt'), 'Projeto novo');
    assert.ok($(projetos[0], 'button[data-lightbox]'), 'o cartaz continua ampliável');
    assert.equal($(projetos[0], 'a').getAttribute('href'), 'https://ama.exemplo.org/inscricao');
    assert.equal(texto($(projetos[0], 'a')), 'Inscreva-se');

    assert.deepEqual($$(doc, '.historia-galeria img').map((i) => i.getAttribute('src')), ['/img/foto-a.jpg', '/img/foto-b.jpg']);
    const trechos = $$(doc, '.historia-narrativa > article');
    assert.deepEqual(trechos.map((t) => texto(t)), ['Primeira parte.', 'Segunda parte.']);
    for (const trecho of trechos) {
      assert.ok(trecho.lastElementChild.matches('button.historia-expandir'), 'o botão fixo vai para o fim do trecho');
    }
    assert.equal($(doc, '.historia-fecho blockquote').innerHTML, 'Linha um<br>Linha dois');
    assert.equal($(doc, '.historia-manifesto-texto').innerHTML, '<p>Manifesto novo.</p>');
    assert.equal(texto($(doc, '.historia-manifesto h3')), 'Uma palavra para sua caminhada');

    assert.equal(texto($(doc, '#loja h2')), 'Loja da AMA');
    const botaoLoja = $(doc, '#loja a.loja-botao');
    assert.equal(botaoLoja.getAttribute('href'), '/loja/?categoria=sabonetes');
    assert.equal(texto(botaoLoja), 'Ver sabonetes');
    assert.ok($(botaoLoja, 'svg'), 'a seta continua no botão da loja');
    assert.equal($(doc, '.loja-foto--1 img').getAttribute('src'), '/img/produtos/body-splash-bruma.jpg');
    assert.equal($(doc, '.loja-foto--2 img').getAttribute('src'), '/img/produtos/creme-hidratante-cupuacu.jpg');

    const depoimentos = $$(doc, '.grade-depoimentos > .depoimento');
    assert.equal(depoimentos.length, 1);
    assert.equal(texto($(depoimentos[0], 'p')), 'Aprendi muito.');
    assert.equal(texto($(depoimentos[0], 'strong')), 'Ana');
    assert.equal($(depoimentos[0], 'img').getAttribute('src'), '/img/ana.jpg');

    assert.deepEqual($$(doc, '.lista-parceiros img').map((i) => i.getAttribute('alt')), ['Parceiro novo']);

    const contatos = $$(doc, '.rodape-contato-item');
    assert.equal(contatos.length, 1);
    assert.equal(texto($(contatos[0], 'strong')), 'E-mail:');
    assert.equal($(contatos[0], 'a').getAttribute('href'), 'mailto:contato@ama.exemplo.org');
    assert.equal(texto($(doc, '.rodape-contatos-titulo')), 'Contatos');
    assert.ok($(doc, '#ano-atual'), 'o ano continua no rodapé (o main.js preenche)');
    assert.equal(texto($(doc, '.rodape-copyright')), 'Copyright © 2026 AMA. Alguns direitos reservados.');

    const wa = $(doc, 'a.wa-flutuante');
    assert.equal(wa.getAttribute('href'), 'https://wa.me/5591988887777');
    assert.equal(texto($(wa, '.wa-flutuante-texto')), 'Fale com a gente');
    assert.ok($(wa, 'svg.wa-flutuante-icone'), 'o ícone continua no botão flutuante');
  });

  test('seções ocultáveis somem com grupo.<id>.visivel = false; cabeçalho e rodapé não', () => {
    const doc = montar();
    aplicarConteudo(doc, {
      'grupo.loja.visivel': false,
      'grupo.whatsapp.visivel': false,
      'grupo.cabecalho.visivel': false,
      'grupo.rodape.visivel': false,
    });
    assert.equal($(doc, '#loja'), null);
    assert.equal($(doc, '.wa-flutuante'), null);
    assert.ok($(doc, '#historia') && $(doc, '#depoimentos'));
    assert.ok($(doc, 'header.topo') && $(doc, '#menu-mobile') && $(doc, 'footer.rodape'));
  });
});

describe('templates/home.html — estrutura', () => {
  const doc = montar();

  test('sem a vitrine #biojoias e sem o modal de produto', () => {
    assert.equal($(doc, '#biojoias'), null);
    assert.equal($(doc, '#produto-modal'), null);
    assert.equal($(doc, '.produto, [data-categoria], [data-filtro]'), null);
    assert.doesNotMatch(TEMPLATE.replace(/<!--[\s\S]*?-->/g, ''), /biojoias"|pmodal/);
  });

  test('o menu leva à loja (/loja/) no computador e no celular; os demais itens são âncoras', () => {
    for (const menu of ['.nav-desktop', '#menu-mobile']) {
      const hrefs = $$(doc, `${menu} a[data-cms-item]`).map((a) => a.getAttribute('href'));
      assert.deepEqual(hrefs, ['#sobre', '#redes', '#cursos', '/loja/', '#historia', '#depoimentos'], menu);
      for (const href of hrefs.filter((h) => h.startsWith('#'))) {
        assert.ok($(doc, `main section${href}`), `âncora ${href} existe`);
      }
    }
  });

  test('banner da loja: seção #loja com título, texto, fotos dos produtos e botão para /loja/', () => {
    const loja = $(doc, 'section#loja.loja-banner');
    assert.ok(loja);
    assert.equal(loja.getAttribute('data-cms-grupo'), 'loja');
    assert.ok(loja.hasAttribute('data-cms-ocultavel'));
    assert.equal(texto($(loja, 'h2')), 'Produtos AMA');
    assert.match(texto(loja), /Saboaria, perfumaria e biojoias da Amazônia/);
    assert.match(texto(loja), /sabonetes e biojoias com a essência da Amazônia/);
    assert.doesNotMatch(texto(loja), /Nova loja virtual/i);
    assert.match(texto(loja), /Feito com amor, força e raízes da floresta\./);
    assert.equal($(loja, 'a.botao').getAttribute('href'), '/loja/');
    assert.equal(texto($(loja, 'a.botao')), 'Conhecer a loja');
    const fotos = $$(loja, 'img').map((i) => i.getAttribute('src'));
    assert.deepEqual(fotos, [
      '/img/brinco-gota-verde.jpg',
      '/img/produtos/creme-hidratante-cupuacu.jpg',
      '/img/produtos/sabonete-solido-manteiga-cupuacu.jpg',
    ]);
    for (const img of $$(loja, 'img')) assert.ok(img.getAttribute('alt'), 'foto com texto alternativo');
  });

  test('nenhum src/href/poster relativo; arquivos locais existem em public/', () => {
    const permitido = /^(\/(?!\/)|#|https?:\/\/|mailto:|tel:)/;
    for (const el of $$(doc, '[src], [href], [poster]')) {
      for (const nome of ['src', 'href', 'poster']) {
        if (!el.hasAttribute(nome)) continue;
        const valor = el.getAttribute(nome);
        assert.match(valor, permitido, `${nome}="${valor}"`);
        if (valor.startsWith('/') && !valor.startsWith('/loja/')) {
          const arquivo = path.join(RAIZ, 'public', decodeURIComponent(valor.split(/[?#]/)[0]));
          assert.ok(existsSync(arquivo), `arquivo de ${valor}`);
        }
      }
    }
    assert.match($(doc, 'meta[property="og:image"]').getAttribute('content'), permitido);
    assert.equal($(doc, 'script[src="/js/main.js"]').hasAttribute('type'), false, 'main.js continua script clássico');
    assert.ok($(doc, 'link[rel="stylesheet"][href="/css/estilo.css"]'));
  });

  // main#topo é flex; o "order" do estilo.css decide a ordem visual. Ela tem de seguir a do documento,
  // que é a ordem do Tab (WCAG 2.4.3) e a dos grupos no painel.
  test('a ordem visual das seções (order do estilo.css) segue a ordem do documento', () => {
    const ordens = new Map();
    for (const [, id, valor] of ESTILO.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/#([\w-]+)\s*\{\s*order\s*:\s*(-?\d+)\s*;?\s*\}/g)) {
      ordens.set(id, Number(valor)); // a última regra vale (cascata)
    }
    const secoes = $$(doc, 'main#topo > section[id]').map((s) => s.id);
    assert.deepEqual(secoes, ['sobre', 'redes', 'cursos', 'historia', 'loja', 'depoimentos', 'parcerias']);
    for (const id of secoes) assert.ok(ordens.has(id), `#${id} tem order no estilo.css`);
    for (let i = 1; i < secoes.length; i++) {
      const [antes, depois] = [secoes[i - 1], secoes[i]];
      assert.ok(ordens.get(antes) <= ordens.get(depois),
        `#${antes} (order ${ordens.get(antes)}) vem antes de #${depois} (order ${ordens.get(depois)}) no documento`);
    }
  });

  test('nomes acessíveis não descrevem o conteúdo padrão (que a AMA pode trocar)', () => {
    // Botões de ampliar: o nome vem do texto alternativo da imagem (o main.js acrescenta "Ampliar imagem").
    const botoes = $$(doc, '[data-lightbox]');
    assert.equal(botoes.length, 7);
    for (const btn of botoes) {
      assert.equal(btn.hasAttribute('aria-label'), false, btn.outerHTML.slice(0, 90));
      assert.ok($(btn, 'img[data-cms-campo="cartaz"], img[data-cms-campo="imagem"]'));
    }
    assert.equal($(doc, 'video[data-cms="quem-somos.video"]').getAttribute('aria-label'), 'Vídeo institucional da AMA');
  });
});

// ---------------------------------------------------------------------------
// public/js/main.js num DOM do linkedom (vm), depois de o CMS trocar imagens e links.

function executarMain(conteudo) {
  const janelaHtml = parseHTML(TEMPLATE);
  const { document } = janelaHtml;
  aplicarConteudo(document, conteudo);
  const observadores = [];
  class ObservadorFalso {
    constructor(callback) { this.callback = callback; this.alvos = []; observadores.push(this); }
    observe(alvo) { this.alvos.push(alvo); }
    unobserve() {}
    disconnect() {}
  }
  const janela = {
    document,
    IntersectionObserver: ObservadorFalso,
    scrollY: 0,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({}),
  };
  const contexto = vm.createContext({ ...janela, window: janela, console, setTimeout, clearTimeout });
  vm.runInContext(MAIN_JS, contexto, { filename: 'public/js/main.js' });
  const clicar = (el) => el.dispatchEvent(new janelaHtml.Event('click', { bubbles: true, cancelable: true }));
  return { document, observadores, clicar };
}

describe('public/js/main.js', () => {
  test('é script clássico, sem o código do filtro e do modal de produto', () => {
    assert.doesNotThrow(() => new vm.Script(MAIN_JS, { filename: 'main.js' }));
    assert.doesNotMatch(MAIN_JS, /produto-modal|pmodal|data-filtro|data-categoria/);
  });

  test('lightbox usa a imagem e o link atuais do cartão (trocados pelo CMS)', () => {
    const { document, clicar } = executarMain({
      'projetos.itens': [
        { cartaz: { src: '/img/cartaz-novo.jpg', alt: 'Projeto novo' }, botao: { href: 'https://ama.exemplo.org/inscricao', texto: 'Inscreva-se' } },
        { cartaz: { src: '/img/cartaz-interno.jpg', alt: 'Projeto interno' }, botao: { href: '#loja', texto: 'Ver a loja' } },
      ],
    });
    const [primeiro, segundo] = $$(document, '#carrossel-projetos .curso-media-btn');
    assert.equal(primeiro.getAttribute('aria-label'), 'Ampliar imagem: Projeto novo');

    clicar(primeiro);
    const modal = $(document, '#lightbox-modal');
    const img = $(document, '#lightbox-img');
    const link = $(document, '#lightbox-link');
    assert.equal(modal.hidden, false);
    assert.equal(img.getAttribute('src'), '/img/cartaz-novo.jpg');
    assert.equal(img.getAttribute('alt'), 'Projeto novo');
    assert.equal(link.getAttribute('href'), 'https://ama.exemplo.org/inscricao');
    assert.equal(texto(link), 'Inscreva-se');
    assert.equal(link.getAttribute('target'), '_blank');
    assert.notEqual(link.style.display, 'none');

    clicar(segundo);
    assert.equal(img.getAttribute('src'), '/img/cartaz-interno.jpg');
    assert.equal(link.getAttribute('href'), '#loja');

    // Foto da história não tem link: o botão "Conhecer" some.
    clicar($(document, '.historia-galeria .historia-imagem-zoom'));
    assert.equal(img.getAttribute('src'), '/img/monica-moura-retrato.jpg');
    assert.equal(link.style.display, 'none');
  });

  test('nome acessível do botão de ampliar segue o texto alternativo atual, mesmo vazio', () => {
    const { document } = executarMain({
      'projetos.itens': [
        { cartaz: { src: '/img/capa-curso-idiomas.jpg', alt: '' } },
        { cartaz: { src: '/img/capa-acredita-basa.jpg', alt: '  ' } },
        { cartaz: { src: '/img/capa-curso-ela-empreende.jpg', alt: 'Ela Empreende 2027' } },
      ],
      'historia.galeria': [{ imagem: { src: '/img/monica-moura.jpeg', alt: '' } }],
    });
    const nomes = (seletor) => $$(document, seletor).map((b) => b.getAttribute('aria-label'));
    assert.deepEqual(nomes('#carrossel-projetos [data-lightbox]'),
      ['Ampliar imagem', 'Ampliar imagem', 'Ampliar imagem: Ela Empreende 2027']);
    assert.deepEqual(nomes('.historia-galeria [data-lightbox]'), ['Ampliar imagem']);
  });

  test('destaque do menu só para âncoras: /loja/ nunca fica ativo', () => {
    const { document, observadores } = executarMain({});
    const [observadorMenu] = observadores;
    const alvos = observadorMenu.alvos.map((s) => s.id);
    assert.ok(alvos.includes('loja') && alvos.includes('cursos'));
    const ativos = () => $$(document, '.nav-desktop a.ativo').map((a) => a.getAttribute('href'));

    observadorMenu.callback([{ isIntersecting: true, target: $(document, '#cursos') }]);
    assert.deepEqual(ativos(), ['#cursos']);
    observadorMenu.callback([{ isIntersecting: true, target: $(document, '#loja') }]);
    assert.deepEqual(ativos(), []);
    assert.equal($(document, '.nav-desktop a[href="/loja/"]').classList.contains('ativo'), false);
  });

  test('o ano do rodapé é preenchido pelo main.js', () => {
    const { document } = executarMain({ 'rodape.copyright': 'AMA.' });
    assert.equal(texto($(document, '.rodape-copyright')), `Copyright © ${new Date().getFullYear()} AMA.`);
  });
});

// ---------------------------------------------------------------------------
// api/render.js com o template real e fetch simulado (linhas de conteudo_site).

describe('api/render.js com templates/home.html', () => {
  let restaurarAmbiente;
  let fetchSimulado;
  beforeEach(() => { restaurarAmbiente = aplicarAmbiente(AMBIENTE_VAZIO); });
  afterEach(() => {
    if (fetchSimulado) fetchSimulado.restaurar();
    fetchSimulado = null;
    restaurarAmbiente();
  });

  test('sem Supabase devolve o template como está', async () => {
    const res = await chamarHandler(render, { url: '/' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.cabecalhos['x-ama-cms'], 'padrao');
    assert.equal(res.corpo, TEMPLATE);
  });

  test('aplica as linhas de conteudo_site de verdade', async () => {
    aplicarAmbiente({ SUPABASE_URL: 'http://supabase.teste', SUPABASE_ANON_KEY: 'sb_publishable_teste' });
    fetchSimulado = simularFetch(() => respostaJson(200, [
      { chave: 'quem-somos.titulo', valor: 'Quem somos nós' },
      { chave: 'cabecalho.menu', valor: [{ link: { href: '/loja/', texto: 'Loja virtual' } }] },
      { chave: 'loja.botao', valor: { href: '/loja/?c=cremes', texto: 'Ver os cremes' } },
      { chave: 'projetos.itens', valor: [{ cartaz: { src: '/img/novo.jpg', alt: 'Novo' } }] },
      { chave: 'grupo.parcerias.visivel', valor: false },
      { chave: 'quem-somos.texto', valor: '<p onclick="x()">Oi<img src=x onerror=alert(1)></p>' },
    ]));
    const res = await chamarHandler(render, { url: '/' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.cabecalhos['x-ama-cms'], 'banco');
    assert.ok(res.corpo.startsWith('<!doctype html>'));
    const doc = montar(res.corpo);
    assert.equal(texto($(doc, '#sobre h2')), 'Quem somos nós');
    for (const menu of ['.nav-desktop', '#menu-mobile']) {
      assert.deepEqual($$(doc, `${menu} a[data-cms-item]`).map((a) => texto(a)), ['Loja virtual']);
    }
    assert.equal($(doc, '#loja a.loja-botao').getAttribute('href'), '/loja/?c=cremes');
    assert.equal(texto($(doc, '#loja a.loja-botao')), 'Ver os cremes');
    assert.equal($$(doc, '#carrossel-projetos > article').length, 1);
    assert.equal($(doc, '#carrossel-projetos img').getAttribute('src'), '/img/novo.jpg');
    assert.equal($(doc, '#parcerias'), null);
    assert.equal($(doc, '.sobre-descricao').innerHTML, '<p>Oi</p>');
    assert.doesNotMatch(res.corpo, /onerror|onclick/);
    assert.equal(fetchSimulado.chamadas.length, 1);
  });

  // WhatsApp e Facebook só mostram a imagem do link com endereço completo; o template usa /img/...
  test('og:image sai com endereço completo quando há SITE_URL', async () => {
    const ogImagem = (html) => $(montar(html), 'meta[property="og:image"]').getAttribute('content');
    aplicarAmbiente({ SITE_URL: 'https://ama.exemplo.org' });
    const semBanco = await chamarHandler(render, { url: '/' });
    assert.equal(ogImagem(semBanco.corpo), 'https://ama.exemplo.org/img/logo-ama.png');

    aplicarAmbiente({ SUPABASE_URL: 'http://supabase.teste', SUPABASE_ANON_KEY: 'sb_publishable_teste' });
    fetchSimulado = simularFetch(() => respostaJson(200, [
      { chave: 'seo.og-imagem', valor: '/img/produtos/body-splash-raiz.jpg' },
    ]));
    const comBanco = await chamarHandler(render, { url: '/' });
    assert.equal(ogImagem(comBanco.corpo), 'https://ama.exemplo.org/img/produtos/body-splash-raiz.jpg');

    // Endereço completo e "//host" ficam como estão; o modelo cru do painel não muda.
    assert.equal(ogImagemAbsoluta('<meta property="og:image" content="https://x.org/a.jpg">', 'https://ama.exemplo.org'),
      '<meta property="og:image" content="https://x.org/a.jpg">');
    assert.equal(ogImagemAbsoluta('<meta content="//x.org/a.jpg" property="og:image">', 'https://ama.exemplo.org'),
      '<meta content="//x.org/a.jpg" property="og:image">');
    assert.equal(ogImagemAbsoluta('<meta name="description" content="/nao">', 'https://ama.exemplo.org'),
      '<meta name="description" content="/nao">');
    const modelo = await chamarHandler(render, { url: '/?modelo=1' });
    assert.equal(ogImagem(modelo.corpo), '/img/logo-ama.png');
  });
});
