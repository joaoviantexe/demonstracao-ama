// Partes comuns das páginas da loja: contador do carrinho no cabeçalho, toasts acessíveis,
// rodapé e WhatsApp com os dados de configuracoes.loja, aviso de topo, aviso de "loja em
// configuração", acessibilidade do menu do celular e utilitários de DOM.
// Regra de segurança: texto vindo do banco/servidor entra sempre como textContent (el()).

import { carregarConfigLoja, lojaConfigurada } from './config.js';
import { contarUnidades, EVENTO, iniciarSincronizacaoAbas, lerCarrinho } from './carrinho.js';
import {
  formatarWhatsapp, linkWhatsapp, pluralizar, somenteDigitos, urlSegura,
} from './formatos.js';

// ---------------------------------------------------------------------------
// DOM

/** href aceito: caminho/URL segura, âncora local, mailto: ou tel:. */
export function hrefSeguro(valor) {
  if (typeof valor !== 'string') return '';
  const v = valor.trim();
  if (/^#[A-Za-z0-9_-]*$/.test(v)) return v;
  if (/^mailto:[^\s<>"'`\\]+@[^\s<>"'`\\]+$/i.test(v)) return v;
  if (/^tel:\+?\d{8,15}$/.test(v)) return v;
  return urlSegura(v);
}

/**
 * Cria um elemento. props: class, texto, html (SÓ para marcação constante do código), dataset,
 * on<evento>, href/src (filtrados por URL segura), booleanos e demais atributos.
 * Filhos: nós ou textos (textos viram nós de texto).
 */
export function el(tag, props = {}, ...filhos) {
  const no = document.createElement(tag);
  for (const [chave, valor] of Object.entries(props || {})) {
    if (valor === null || valor === undefined || valor === false) continue;
    if (chave === 'class') no.className = valor;
    else if (chave === 'texto') no.textContent = String(valor);
    else if (chave === 'html') no.innerHTML = valor;
    else if (chave === 'dataset') Object.assign(no.dataset, valor);
    else if (chave.startsWith('on') && typeof valor === 'function') no.addEventListener(chave.slice(2), valor);
    else if (chave === 'href') {
      const seguro = hrefSeguro(String(valor));
      if (seguro) no.setAttribute('href', seguro);
    } else if (chave === 'src') {
      const seguro = urlSegura(String(valor));
      if (seguro) no.setAttribute('src', seguro);
    } else if (valor === true) no.setAttribute(chave, '');
    else no.setAttribute(chave, String(valor));
  }
  for (const filho of filhos.flat(Infinity)) {
    if (filho === null || filho === undefined || filho === false) continue;
    no.append(filho instanceof Node ? filho : String(filho));
  }
  return no;
}

/** Esvazia o contêiner e coloca os novos filhos. */
export function trocarConteudo(conteiner, ...filhos) {
  conteiner.replaceChildren(...filhos.flat(Infinity).filter((f) => f !== null && f !== undefined && f !== false));
}

// Ícones (marcação constante; desenhados em 24×24 com traço).
const ICONES = {
  carrinho: '<path d="M5.5 8h13l-1.1 11.2a1.5 1.5 0 0 1-1.5 1.3H8.1a1.5 1.5 0 0 1-1.5-1.3L5.5 8z"/><path d="M9 10.5V7a3 3 0 0 1 6 0v3.5"/>',
  lixeira: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5L18 7"/><path d="M9 7V4.5h6V7"/>',
  mais: '<path d="M12 5v14M5 12h14"/>',
  menos: '<path d="M5 12h14"/>',
  seta: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  voltar: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  caminhao: '<path d="M2.5 6.5h11v10h-11z"/><path d="M13.5 9.5h4l3.5 3.5v3.5h-7.5"/><circle cx="6.5" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  cadeado: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alerta: '<path d="M12 3.5l9 16H3l9-16z"/><path d="M12 10v4.5M12 17.2v.3"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8v.3"/>',
  busca: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  etiqueta: '<path d="M3.5 12.2V4.5a1 1 0 0 1 1-1h7.7l8.3 8.3a1 1 0 0 1 0 1.4l-7.3 7.3a1 1 0 0 1-1.4 0L3.5 12.2z"/><circle cx="8" cy="8" r="1.5"/>',
  folha: '<path d="M5 19.5C5 11 10 5 20 4c-.5 10-6.5 15.5-15 15.5z"/><path d="M5 19.5l7.5-7.5"/>',
  cartao: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h3"/>',
  coracao: '<path d="M12 20s-7.5-4.6-9.2-9.4A4.9 4.9 0 0 1 12 7.2a4.9 4.9 0 0 1 9.2 3.4C19.5 15.4 12 20 12 20z"/>',
  pacote: '<path d="M3.5 7.5L12 3.5l8.5 4v9L12 20.5l-8.5-4v-9z"/><path d="M3.5 7.5L12 11.5l8.5-4M12 11.5v9"/>',
  loja: '<path d="M4.5 10.5v9h15v-9"/><path d="M3 10.5L5 4.5h14l2 6"/><path d="M3 10.5a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0"/><path d="M10 19.5v-5h4v5"/>',
  recibo: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  relogio: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  fechar: '<path d="M6 6l12 12M18 6L6 18"/>',
  local: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  escudo: '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6L12 3z"/><path d="M8.8 12.2l2.2 2.2 4.2-4.4"/>',
  presente: '<rect x="3.5" y="8.5" width="17" height="4" rx="1"/><path d="M5 12.5v8h14v-8M12 8.5v12"/><path d="M12 8.5S10.5 4 8 4.5 7 8.5 12 8.5zM12 8.5S13.5 4 16 4.5 17 8.5 12 8.5z"/>',
};
const WHATSAPP = '<path fill="currentColor" stroke="none" d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.816 9.816 0 0 0 12.04 2m.01 1.67c4.55 0 8.24 3.7 8.24 8.24 0 2.2-.86 4.28-2.42 5.83a8.21 8.21 0 0 1-5.82 2.41h-.01c-1.46 0-2.88-.39-4.14-1.13l-.3-.18-3.08.81.82-3-.19-.31a8.24 8.24 0 0 1-1.26-4.43c0-4.55 3.69-8.24 8.24-8.24m4.53 11.66c-.25-.13-1.47-.72-1.7-.81-.23-.08-.39-.13-.56.13-.17.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.13-1.06-.39-2.02-1.24-.75-.67-1.25-1.49-1.4-1.74-.15-.25-.02-.39.11-.51.11-.11.25-.29.37-.43.13-.15.17-.25.25-.42.08-.17.04-.31-.02-.44-.06-.13-.56-1.34-.76-1.84-.2-.49-.4-.42-.56-.43h-.47c-.17 0-.44.06-.67.31-.23.25-.88.86-.88 2.1 0 1.24.9 2.44 1.03 2.61.13.17 1.78 2.71 4.3 3.8 2.53 1.09 2.53.73 2.99.69.45-.04 1.47-.6 1.68-1.18.21-.58.21-1.07.15-1.18-.06-.1-.23-.17-.48-.29"/>';

/** SVG decorativo (aria-hidden). */
export function icone(nome, classe = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (classe) svg.setAttribute('class', classe);
  svg.innerHTML = nome === 'whatsapp' ? WHATSAPP : (ICONES[nome] || '');
  return svg;
}

// ---------------------------------------------------------------------------
// Toasts (região aria-live)

let regiaoToasts = null;

function obterRegiaoToasts() {
  if (regiaoToasts && document.body.contains(regiaoToasts)) return regiaoToasts;
  regiaoToasts = el('div', { class: 'toasts', 'aria-live': 'polite', 'aria-relevant': 'additions' });
  document.body.append(regiaoToasts);
  return regiaoToasts;
}

/**
 * Mensagem curta no canto da tela. tipo: 'sucesso' | 'erro' | 'info'.
 * acao: { texto, href } opcional (ex.: "Ver carrinho"). Some sozinha em 5 s (erros em 8 s).
 */
export function toast(mensagem, { tipo = 'info', acao = null, duracaoMs } = {}) {
  const regiao = obterRegiaoToasts();
  const nomeIcone = tipo === 'sucesso' ? 'check' : tipo === 'erro' ? 'alerta' : 'info';
  const fechar = () => {
    item.classList.add('toast--saindo');
    setTimeout(() => item.remove(), 250);
  };
  const item = el('div', { class: `toast toast--${tipo}`, role: tipo === 'erro' ? 'alert' : null },
    el('span', { class: 'toast-icone' }, icone(nomeIcone)),
    el('p', { class: 'toast-texto', texto: mensagem }),
    acao && acao.href ? el('a', { class: 'toast-acao', href: acao.href, texto: acao.texto || 'Ver' }) : null,
    el('button', { type: 'button', class: 'toast-fechar', 'aria-label': 'Fechar aviso', onclick: fechar }, icone('fechar')));
  regiao.append(item);
  while (regiao.children.length > 3) regiao.firstElementChild.remove();
  let timer = setTimeout(fechar, duracaoMs || (tipo === 'erro' ? 8000 : 5000));
  const pausar = () => clearTimeout(timer);
  const retomar = () => {
    clearTimeout(timer);
    timer = setTimeout(fechar, 3000);
  };
  item.addEventListener('mouseenter', pausar);
  item.addEventListener('focusin', pausar);
  item.addEventListener('mouseleave', retomar);
  item.addEventListener('focusout', retomar);
  return item;
}

// ---------------------------------------------------------------------------
// Cabeçalho: contador do carrinho

export function atualizarContador(itens = lerCarrinho()) {
  const total = contarUnidades(itens);
  const rotulo = total ? `Carrinho: ${pluralizar(total, 'item', 'itens')}` : 'Carrinho vazio';
  document.querySelectorAll('[data-carrinho-contador]').forEach((contador) => {
    contador.textContent = total > 99 ? '99+' : String(total);
    contador.hidden = total === 0;
  });
  document.querySelectorAll('[data-carrinho-link]').forEach((link) => link.setAttribute('aria-label', rotulo));
  document.querySelectorAll('[data-carrinho-texto]').forEach((texto) => {
    texto.textContent = total ? `Meu carrinho (${total})` : 'Meu carrinho';
  });
}

// Menu do celular: o main.js abre/fecha; aqui ficam aria-expanded, Esc, foco e inert.
function melhorarMenuMobile() {
  const abrir = document.querySelector('[data-abrir-menu]');
  const fechar = document.querySelector('[data-fechar-menu]');
  const menu = document.getElementById('menu-mobile');
  if (!abrir || !fechar || !menu) return;
  const definir = (aberto) => {
    abrir.setAttribute('aria-expanded', aberto ? 'true' : 'false');
    menu.inert = !aberto;
  };
  definir(false);
  abrir.addEventListener('click', () => {
    definir(true);
    setTimeout(() => fechar.focus(), 60);
  });
  fechar.addEventListener('click', () => {
    definir(false);
    abrir.focus();
  });
  menu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => definir(false)));
  document.addEventListener('keydown', (evento) => {
    if (evento.key === 'Escape' && menu.classList.contains('aberto')) fechar.click();
  });
}

// ---------------------------------------------------------------------------
// Configuração da loja: rodapé, WhatsApp, aviso de topo, loja em configuração

let configAtual = null;

/** Número do WhatsApp da loja (configuração carregada ou padrão). */
export function whatsappDaLoja() {
  return (configAtual && configAtual.whatsapp) || '5591981056049';
}

/** Link wa.me da loja com a mensagem. */
export function linkWhatsappLoja(texto = '') {
  return linkWhatsapp(whatsappDaLoja(), texto);
}

function aplicarConfigLoja(cfg) {
  configAtual = cfg;
  const wa = linkWhatsapp(cfg.whatsapp);
  document.querySelectorAll('[data-whatsapp-loja]').forEach((link) => {
    if (wa) link.setAttribute('href', wa);
  });
  document.querySelectorAll('[data-rodape-whatsapp]').forEach((link) => {
    if (!wa) return;
    link.setAttribute('href', wa);
    link.textContent = formatarWhatsapp(cfg.whatsapp);
  });
  document.querySelectorAll('[data-rodape-instagram]').forEach((link) => {
    const item = link.closest('[data-rodape-item]');
    if (!cfg.instagram) {
      if (item) item.hidden = true;
      return;
    }
    link.setAttribute('href', `https://www.instagram.com/${encodeURIComponent(cfg.instagram)}/`);
    link.textContent = `@${cfg.instagram}`;
  });
  document.querySelectorAll('[data-rodape-email]').forEach((link) => {
    const item = link.closest('[data-rodape-item]');
    const email = /^[^\s@<>"'`\\]+@[^\s@<>"'`\\]+\.[^\s@<>"'`\\]+$/.test(cfg.email_contato) ? cfg.email_contato : '';
    if (item) item.hidden = !email;
    if (email) {
      link.setAttribute('href', `mailto:${email}`);
      link.textContent = email;
    }
  });
  const main = document.querySelector('main');
  if (cfg.aviso_topo && main && !document.querySelector('.aviso-topo')) {
    main.prepend(el('div', { class: 'aviso-topo', role: 'note' },
      el('div', { class: 'wrap' }, icone('presente'), el('p', { texto: cfg.aviso_topo }))));
  }
}

function mostrarAvisoConfiguracao() {
  const main = document.querySelector('main');
  if (!main || document.querySelector('.aviso-config')) return;
  const aviso = el('div', { class: 'aviso-config', role: 'status' },
    el('div', { class: 'wrap' },
      el('div', { class: 'aviso-config-caixa' },
        el('span', { class: 'aviso-config-icone' }, icone('folha')),
        el('div', { class: 'aviso-config-texto' },
          el('strong', { texto: 'Loja em configuração' }),
          el('p', { texto: 'Estamos preparando a loja virtual da AMA. Volte em breve!' })))));
  main.prepend(aviso);
}

/**
 * Prepara a página: contador do carrinho (e sincronização entre abas), menu acessível,
 * avisos e rodapé. Devolve { config: Promise<configuracoes.loja normalizada> }.
 */
export function iniciarPagina() {
  atualizarContador();
  iniciarSincronizacaoAbas();
  globalThis.addEventListener(EVENTO, (evento) => atualizarContador(evento.detail && evento.detail.itens));
  melhorarMenuMobile();
  const ano = document.getElementById('ano-atual');
  if (ano) ano.textContent = String(new Date().getFullYear());
  if (!lojaConfigurada()) mostrarAvisoConfiguracao();
  const config = carregarConfigLoja().then((cfg) => {
    aplicarConfigLoja(cfg);
    return cfg;
  });
  return { config };
}

// ---------------------------------------------------------------------------
// Utilidades das páginas

/** Atualiza <title>, description e og:*. */
export function definirMeta({ titulo, descricao } = {}) {
  if (titulo) {
    document.title = titulo;
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', titulo);
  }
  if (descricao) {
    const curta = descricao.replace(/\s+/g, ' ').trim().slice(0, 160);
    document.querySelector('meta[name="description"]')?.setAttribute('content', curta);
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', curta);
  }
}

/**
 * Máscara de digitação que mantém o cursor depois do mesmo número de dígitos.
 * `mascara(valor) → valor formatado`.
 */
export function aplicarMascara(input, mascara) {
  const formatar = () => {
    const valor = input.value;
    const posicao = input.selectionStart ?? valor.length;
    const digitosAntes = somenteDigitos(valor.slice(0, posicao)).length;
    const novo = mascara(valor);
    if (novo === valor) return;
    input.value = novo;
    let i = 0;
    let vistos = 0;
    while (i < novo.length && vistos < digitosAntes) {
      if (/\d/.test(novo[i])) vistos += 1;
      i += 1;
    }
    try {
      if (document.activeElement === input) input.setSelectionRange(i, i);
    } catch {
      // campos sem seleção (ex.: e-mail)
    }
  };
  input.addEventListener('input', formatar);
  if (input.value) input.value = mascara(input.value);
}

/**
 * Bloco de estado (vazio, erro, não encontrado…).
 * { icone, titulo, texto, acoes: [elementos], tipo: 'vazio' | 'erro' }
 */
export function blocoEstado({ icone: nomeIcone = 'info', titulo, texto, acoes = [], tipo = 'vazio', nivel = 'h2' } = {}) {
  return el('div', { class: `estado estado--${tipo}` },
    el('span', { class: 'estado-icone' }, icone(nomeIcone)),
    el(nivel, { class: 'estado-titulo', texto: titulo }),
    texto ? el('p', { class: 'estado-texto', texto }) : null,
    acoes.length ? el('div', { class: 'estado-acoes' }, ...acoes) : null);
}

/** Link-botão do WhatsApp da loja (abre em nova aba). */
export function botaoWhatsapp(texto, mensagem, { classe = 'botao botao--whatsapp' } = {}) {
  return el('a', {
    class: classe, href: linkWhatsappLoja(mensagem), target: '_blank', rel: 'noopener',
  }, icone('whatsapp'), el('span', { texto }));
}

/** Parâmetros da URL atual. */
export function parametros() {
  return new URLSearchParams(globalThis.location ? globalThis.location.search : '');
}

/** Coloca o foco num elemento sem rolar de forma brusca (torna focável se preciso). */
export function focar(elemento) {
  if (!elemento) return;
  if (!elemento.hasAttribute('tabindex') && !/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(elemento.tagName)) {
    elemento.setAttribute('tabindex', '-1');
  }
  elemento.focus({ preventScroll: true });
  elemento.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** Ajusta fotos em paisagem num quadro vertical: mostram-se inteiras sobre a cor do fundo da foto. */
export function ajustarFoto(img) {
  const avaliar = () => {
    if (!img.naturalWidth || !img.naturalHeight) return;
    const paisagem = img.naturalWidth / img.naturalHeight > 1.08;
    const quadro = img.closest('[data-quadro-foto]');
    if (!quadro) return;
    quadro.classList.toggle('foto--paisagem', paisagem);
    if (!paisagem) return;
    try {
      // Cor do canto da foto como fundo do quadro (só funciona com imagens do mesmo domínio).
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 2, 2, 1, 1, 0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      quadro.style.setProperty('--fundo-foto', `rgb(${r}, ${g}, ${b})`);
    } catch {
      // imagem de outro domínio: fica o fundo creme padrão
    }
  };
  // A foto pode já estar no cache (completa antes de entrar na página): avalia depois de inserida.
  if (img.complete) requestAnimationFrame(avaliar);
  else img.addEventListener('load', avaliar, { once: true });
}
