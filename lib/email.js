/**
 * E-mails transacionais via Resend (docs/ARQUITETURA.md §1, §6.0, §6.5 e §6.6). Opcionais: sem
 * RESEND_API_KEY nada é enviado e enviarEmail devolve false.
 *
 * Exportações:
 * - enviarEmail({ para, assunto, html, texto?, responderPara?, idempotencia?, timeoutMs? }) → Promise<boolean>
 *     para: e-mail, lista de e-mails ou texto separado por vírgulas (inválidos são descartados).
 *     POST <RESEND_API_BASE>/emails com Authorization Bearer RESEND_API_KEY;
 *     from = EMAIL_REMETENTE ou "AMA <onboarding@resend.dev>". idempotencia vira o cabeçalho Idempotency-Key.
 *     true = o Resend aceitou. Nunca lança: falhas são registradas com console.error e devolvem false.
 * - Modelos → { assunto, html, texto } (texto é a versão em texto puro, opcional para o envio):
 *     emailPedidoPago(pedido, opcoes?)       cliente: pagamento confirmado
 *     emailPedidoEnviado(pedido, opcoes?)    cliente: pedido enviado (com rastreio quando houver)
 *     emailNovoPedidoAdmin(pedido, opcoes?)  equipe da AMA: novo pedido pago
 *     emailStatusPedido(pedido, opcoes?)     cliente: escolhe pelo pedido.status
 *                                            (pago, enviado, entregue, cancelado, reembolsado; outro → null)
 *   pedido: linha de `pedidos` (ou saída equivalente) com `itens` (ou `pedido_itens`):
 *     { id, numero, token_acesso | token, status, cliente_nome, cliente_email, cliente_telefone,
 *       endereco, entrega, itens: [{ nome, quantidade, preco_unitario_centavos, total_centavos }],
 *       subtotal_centavos, desconto_centavos, frete_centavos, total_centavos, cupom_codigo,
 *       metodo_pagamento, codigo_rastreio, url_rastreio, observacoes }
 *   opcoes: a URL pública do site como texto ('https://ama.org.br') ou { siteUrl, whatsapp, retirada }.
 *     Sem siteUrl usa pedido.siteUrl / pedido.site_url e, por fim, SITE_URL do ambiente.
 *     O link do pedido é <siteUrl>/loja/pedido?id=<id>&token=<token>; o do painel, <siteUrl>/admin/#/pedidos/<id>.
 *     retirada: configuracoes.frete.retirada ({ nome, endereco, prazo_texto }). criar_pedido não grava o
 *     endereço da sede em pedido.entrega, então só com ela o e-mail de um pedido de retirada mostra onde retirar.
 *   Todo texto vindo do banco é escapado; URLs só entram se forem http(s). O e-mail do cliente só vira
 *   link mailto: quando não tem caracteres que mudariam o rascunho (?, &, =, %, #, vírgula…).
 * - escaparHtml(texto) → string ; urlSegura(url) → string ('' se não for http/https)
 */

import { obterAmbiente } from './ambiente.js';
import { formatarReais } from './dinheiro.js';
import { validarEmail } from './validacao.js';

const REMETENTE_PADRAO = 'AMA <onboarding@resend.dev>';
const TIMEOUT_PADRAO_MS = 10_000;
const LIMITE_LOG = 1_000;

const COR = {
  verde: '#0B2A1C',
  verdeMedio: '#1F4F33',
  ouro: '#C9982B',
  ouroClaro: '#EDD9A3',
  creme: '#FBF6EA',
  cremeEscuro: '#F4EAD3',
  borda: '#ECDFC0',
  tinta: '#1A2A1E',
  tintaSuave: '#4B5A4E',
  terracota: '#B1552F',
};
const FONTE_TITULO = "'Fraunces', Georgia, 'Times New Roman', serif";
const FONTE_TEXTO = "'Manrope', 'Segoe UI', Helvetica, Arial, sans-serif";
const FONTE_MARCA = "'Baloo 2', 'Manrope', 'Segoe UI', Helvetica, Arial, sans-serif";

// ---------------------------------------------------------------------------
// Utilitários

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Escapa texto para HTML (conteúdo e atributos entre aspas). */
export function escaparHtml(texto) {
  if (texto === undefined || texto === null) return '';
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

/** A própria URL (normalizada) se for http(s) absoluta; senão ''. */
export function urlSegura(url) {
  if (typeof url !== 'string' || !url.trim()) return '';
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    if (u.username || u.password) return '';
    return u.href;
  } catch {
    return '';
  }
}

const umaLinha = (texto) => String(texto ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

function primeiroNome(nome) {
  const limpo = umaLinha(nome);
  return limpo ? limpo.split(' ')[0] : '';
}

const centavos = (v) => (Number.isSafeInteger(v) ? v : 0);

function opcoesDoModelo(pedido, opcoes) {
  const o = typeof opcoes === 'string' ? { siteUrl: opcoes } : (ehObjeto(opcoes) ? opcoes : {});
  const candidato = o.siteUrl || o.site_url || (ehObjeto(pedido) && (pedido.siteUrl || pedido.site_url)) || obterAmbiente().siteUrl;
  const site = urlSegura(String(candidato || ''));
  const retirada = ehObjeto(o.retirada) ? o.retirada : {};
  return {
    siteUrl: site ? site.replace(/\/+$/, '') : '',
    whatsapp: String(o.whatsapp ?? '').replace(/\D+/g, ''),
    retirada: {
      nome: umaLinha(retirada.nome),
      endereco: umaLinha(retirada.endereco),
      prazoTexto: umaLinha(retirada.prazo_texto),
    },
  };
}

// No mailto:, "?", "&", "=", "%", "#" e "," mudam destinatários, cópias e corpo do rascunho (o &amp; volta
// a ser & no navegador). Só endereços com caracteres inofensivos viram link.
const EMAIL_SEGURO_MAILTO = /^[A-Za-z0-9._+'-]+@[A-Za-z0-9.-]+$/;
const podeVirarMailto = (email) => validarEmail(email) && EMAIL_SEGURO_MAILTO.test(email);

function linkDoPedido(pedido, siteUrl) {
  const id = pedido.id === undefined || pedido.id === null ? '' : String(pedido.id);
  const token = String(pedido.token_acesso ?? pedido.token ?? '');
  if (!siteUrl || !id || !token) return '';
  return urlSegura(`${siteUrl}/loja/pedido?id=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`);
}

function itensDoPedido(pedido) {
  const lista = Array.isArray(pedido.itens) ? pedido.itens : (Array.isArray(pedido.pedido_itens) ? pedido.pedido_itens : []);
  return lista.filter(ehObjeto).map((item) => {
    const quantidade = Number.isSafeInteger(item.quantidade) ? item.quantidade : 1;
    const unitario = centavos(item.preco_unitario_centavos);
    return {
      nome: umaLinha(item.nome) || 'Produto',
      quantidade,
      unitario,
      total: Number.isSafeInteger(item.total_centavos) ? item.total_centavos : unitario * quantidade,
    };
  });
}

const rotuloNumero = (pedido) => {
  const numero = umaLinha(pedido.numero);
  return numero ? `#${numero}` : '';
};

const METODOS = {
  credit_card: 'Cartão de crédito',
  debit_card: 'Cartão de débito',
  prepaid_card: 'Cartão pré-pago',
  bank_transfer: 'Pix',
  ticket: 'Boleto',
  account_money: 'Saldo do Mercado Pago',
  digital_currency: 'Linha de Crédito Mercado Pago',
  digital_wallet: 'Carteira digital',
};

function formatarTelefone(telefone) {
  const d = String(telefone ?? '').replace(/\D+/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return umaLinha(telefone);
}

function formatarCep(cep) {
  const d = String(cep ?? '').replace(/\D+/g, '');
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : umaLinha(cep);
}

function linhasDoEndereco(endereco) {
  if (!ehObjeto(endereco)) return [];
  const rua = [umaLinha(endereco.logradouro), umaLinha(endereco.numero)].filter(Boolean).join(', ');
  const linha1 = [rua, umaLinha(endereco.complemento)].filter(Boolean).join(' — ');
  const cidade = [umaLinha(endereco.cidade), umaLinha(endereco.uf).toUpperCase()].filter(Boolean).join('/');
  const linha2 = [umaLinha(endereco.bairro), cidade].filter(Boolean).join(', ');
  const cep = endereco.cep ? `CEP ${formatarCep(endereco.cep)}` : '';
  return [linha1, linha2, cep].filter(Boolean);
}

function prazoTexto(prazo) {
  if (!Number.isSafeInteger(prazo) || prazo <= 0) return '';
  return prazo === 1 ? 'até 1 dia útil' : `até ${prazo} dias úteis`;
}

// ---------------------------------------------------------------------------
// Blocos de HTML (tabelas e estilos inline para funcionar nos leitores de e-mail)

function botao(rotulo, url) {
  const href = urlSegura(url);
  if (!href) return '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 8px;">
<tr><td style="border-radius:999px;background:${COR.ouro};">
<a href="${escaparHtml(href)}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 30px;font-family:${FONTE_TEXTO};font-size:15px;font-weight:700;color:${COR.verde};text-decoration:none;border-radius:999px;">${escaparHtml(rotulo)}</a>
</td></tr></table>`;
}

function titulo(texto) {
  return `<h1 style="margin:0 0 12px;font-family:${FONTE_TITULO};font-size:26px;line-height:1.25;font-weight:600;color:${COR.verde};">${escaparHtml(texto)}</h1>`;
}

function paragrafo(html) {
  return `<p style="margin:0 0 14px;font-family:${FONTE_TEXTO};font-size:15px;line-height:1.6;color:${COR.tinta};">${html}</p>`;
}

function subtitulo(texto) {
  return `<h2 style="margin:28px 0 10px;font-family:${FONTE_TITULO};font-size:18px;font-weight:600;color:${COR.verde};">${escaparHtml(texto)}</h2>`;
}

function caixa(conteudoHtml) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COR.creme};border:1px solid ${COR.borda};border-radius:12px;">
<tr><td style="padding:16px 18px;font-family:${FONTE_TEXTO};font-size:14px;line-height:1.6;color:${COR.tinta};">${conteudoHtml}</td></tr></table>`;
}

function tabelaItens(pedido) {
  const itens = itensDoPedido(pedido);
  const celula = `font-family:${FONTE_TEXTO};font-size:14px;line-height:1.45;color:${COR.tinta};padding:10px 0;border-bottom:1px solid ${COR.borda};`;
  const linhas = itens.map((item) => `<tr>
<td style="${celula}">${escaparHtml(item.nome)}<br><span style="font-size:12px;color:${COR.tintaSuave};">${item.quantidade} × ${escaparHtml(formatarReais(item.unitario))}</span></td>
<td align="right" style="${celula}white-space:nowrap;padding-left:12px;">${escaparHtml(formatarReais(item.total))}</td>
</tr>`).join('\n');

  const total = centavos(pedido.total_centavos);
  const subtotal = Number.isSafeInteger(pedido.subtotal_centavos)
    ? pedido.subtotal_centavos : itens.reduce((soma, item) => soma + item.total, 0);
  const desconto = centavos(pedido.desconto_centavos);
  const frete = centavos(pedido.frete_centavos);
  const retirada = ehObjeto(pedido.entrega) && pedido.entrega.tipo === 'retirada';
  const resumo = `font-family:${FONTE_TEXTO};font-size:14px;color:${COR.tintaSuave};padding:4px 0;`;
  const linhaResumo = (rotulo, valor) => `<tr><td style="${resumo}">${rotulo}</td><td align="right" style="${resumo}white-space:nowrap;">${valor}</td></tr>`;

  const resumos = [linhaResumo('Subtotal', escaparHtml(formatarReais(subtotal)))];
  if (desconto > 0) {
    const cupom = umaLinha(pedido.cupom_codigo);
    resumos.push(linhaResumo(cupom ? `Desconto (cupom ${escaparHtml(cupom)})` : 'Desconto',
      `−&nbsp;${escaparHtml(formatarReais(desconto))}`));
  }
  resumos.push(linhaResumo('Frete', frete > 0 ? escaparHtml(formatarReais(frete)) : (retirada ? 'Retirada' : 'Grátis')));

  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${linhas}
${resumos.join('\n')}
<tr><td style="font-family:${FONTE_TEXTO};font-size:16px;font-weight:700;color:${COR.verde};padding:12px 0 0;border-top:2px solid ${COR.ouro};">Total</td>
<td align="right" style="font-family:${FONTE_TEXTO};font-size:16px;font-weight:700;color:${COR.verde};padding:12px 0 0;border-top:2px solid ${COR.ouro};white-space:nowrap;">${escaparHtml(formatarReais(total))}</td></tr>
</table>`;
}

const comPontoFinal = (texto) => (/[.!?…]$/.test(texto) ? texto : `${texto}.`);

function blocoEntrega(pedido, opcoes) {
  const entrega = ehObjeto(pedido.entrega) ? pedido.entrega : {};
  const linhas = [];
  if (entrega.tipo === 'retirada') {
    // O endereço e o combinado vêm da configuração atual (opcoes.retirada); entrega.* fica de reserva.
    const { retirada } = opcoes;
    const nome = umaLinha(entrega.nome) || retirada.nome || 'Retirar na sede da AMA';
    linhas.push(`<strong>${escaparHtml(nome)}</strong>`);
    const local = retirada.endereco || umaLinha(entrega.endereco);
    if (local) linhas.push(escaparHtml(local));
    const combinado = retirada.prazoTexto || umaLinha(entrega.prazo_texto);
    linhas.push(escaparHtml(combinado
      ? comPontoFinal(combinado)
      : 'Combine o melhor dia e horário da retirada com a AMA pelo WhatsApp.'));
  } else {
    const servico = [umaLinha(entrega.nome), umaLinha(entrega.empresa)].filter(Boolean);
    const nomeServico = servico.length === 2 && servico[0] !== servico[1] ? `${servico[0]} (${servico[1]})` : (servico[0] || 'Entrega');
    const prazo = prazoTexto(entrega.prazo_dias);
    linhas.push(`<strong>${escaparHtml(nomeServico)}</strong>${prazo ? ` — ${escaparHtml(prazo)} após a postagem` : ''}`);
    for (const linha of linhasDoEndereco(pedido.endereco)) linhas.push(escaparHtml(linha));
  }
  return caixa(linhas.join('<br>'));
}

function blocoRastreio(pedido) {
  const codigos = umaLinha(pedido.codigo_rastreio).split(',').map((c) => c.trim()).filter(Boolean);
  const url = urlSegura(pedido.url_rastreio);
  if (!codigos.length && !url) return '';
  const partes = [];
  if (codigos.length) {
    const rotulo = codigos.length > 1 ? 'Códigos de rastreio' : 'Código de rastreio';
    partes.push(`${rotulo}: ${codigos.map((c) => `<strong style="font-family:Consolas,'Courier New',monospace;font-size:15px;letter-spacing:.04em;">${escaparHtml(c)}</strong>`).join(', ')}`);
  }
  if (url) {
    partes.push(`<a href="${escaparHtml(url)}" target="_blank" rel="noopener" style="color:${COR.verdeMedio};font-weight:700;">Acompanhar a entrega</a>`);
  }
  return caixa(partes.join('<br>'));
}

function layout({ tituloPagina, preheader, conteudo, siteUrl, whatsapp, rodapeExtra = '', paraEquipe = false }) {
  const logo = siteUrl && /^https:/i.test(siteUrl) && !/\/\/(localhost|127\.|\[::1\])/i.test(siteUrl)
    ? `<img src="${escaparHtml(`${siteUrl}/img/logo-ama.png`)}" width="96" alt="AMA" style="display:block;border:0;width:96px;height:auto;margin:0 0 6px;">`
    : '';
  // O logo (dourado, fundo transparente) já traz "AMA"; sem ele, a marca vai em texto.
  const marca = `${logo || `<div style="font-family:${FONTE_MARCA};font-size:30px;font-weight:700;letter-spacing:.06em;color:${COR.ouro};line-height:1;">AMA</div>`}
<div style="font-family:${FONTE_TEXTO};font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${COR.ouroClaro};margin-top:6px;">Associação de Mulheres na Amazônia</div>`;
  let contato = whatsapp
    ? ` Dúvidas? Fale com a gente pelo <a href="https://wa.me/${escaparHtml(whatsapp)}" style="color:${COR.verdeMedio};font-weight:700;">WhatsApp</a>.`
    : ' Dúvidas? É só responder este e-mail.';
  if (paraEquipe) contato = '';
  const site = siteUrl
    ? `<br><a href="${escaparHtml(`${siteUrl}/`)}" style="color:${COR.verdeMedio};text-decoration:none;">${escaparHtml(siteUrl.replace(/^https?:\/\//i, ''))}</a>`
    : '';

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escaparHtml(tituloPagina)}</title>
</head>
<body style="margin:0;padding:0;background:${COR.creme};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${escaparHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COR.creme};">
<tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#FFFFFF;border:1px solid ${COR.borda};border-radius:18px;overflow:hidden;">
<tr><td style="background:${COR.verde};padding:28px 32px 24px;border-bottom:4px solid ${COR.ouro};">${marca}</td></tr>
<tr><td style="padding:32px 32px 24px;">
${conteudo}
</td></tr>
<tr><td style="background:${COR.cremeEscuro};padding:20px 32px;font-family:${FONTE_TEXTO};font-size:12px;line-height:1.6;color:${COR.tintaSuave};">
${rodapeExtra}AMA — Associação de Mulheres na Amazônia · Ananindeua/PA.${contato}${site}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** Versão em texto puro a partir do HTML dos modelos. */
function htmlParaTexto(html) {
  return String(html)
    .replace(/<(head|title|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<div style="display:none[\s\S]*?<\/div>/i, '')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, rotulo) => `${rotulo} (${href})`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h1|h2|tr|table|div)>/gi, '\n')
    .replace(/<\/td>\s*<td[^>]*>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#96;/g, '`')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function modelo({ assunto, preheader, conteudo, opcoes, rodapeExtra, paraEquipe }) {
  const html = layout({
    tituloPagina: assunto, preheader, conteudo, siteUrl: opcoes.siteUrl, whatsapp: opcoes.whatsapp, rodapeExtra, paraEquipe,
  });
  return { assunto: umaLinha(assunto), html, texto: htmlParaTexto(html) };
}

// ---------------------------------------------------------------------------
// Modelos

/** Cliente: pagamento confirmado. */
export function emailPedidoPago(pedido, opcoes) {
  const p = ehObjeto(pedido) ? pedido : {};
  const o = opcoesDoModelo(p, opcoes);
  const numero = rotuloNumero(p);
  const nome = primeiroNome(p.cliente_nome);
  const link = linkDoPedido(p, o.siteUrl);
  const retirada = ehObjeto(p.entrega) && p.entrega.tipo === 'retirada';
  const metodo = METODOS[p.metodo_pagamento] || '';

  const conteudo = [
    titulo('Pagamento confirmado!'),
    paragrafo(`${nome ? `Olá, ${escaparHtml(nome)}! ` : 'Olá! '}Recebemos o pagamento do seu pedido <strong>${escaparHtml(numero)}</strong>${metodo ? ` (${escaparHtml(metodo)})` : ''}. Obrigada por apoiar o trabalho das mulheres da AMA.`),
    paragrafo(retirada
      ? 'Agora vamos separar os seus produtos com carinho. Avisaremos quando estiver tudo pronto para a retirada.'
      : 'Agora vamos separar os seus produtos com carinho. Assim que o pedido for postado, você recebe o código de rastreio por e-mail.'),
    subtitulo('Resumo do pedido'),
    tabelaItens(p),
    subtitulo(retirada ? 'Retirada' : 'Entrega'),
    blocoEntrega(p, o),
    botao('Acompanhar meu pedido', link),
  ].join('\n');

  return modelo({
    assunto: `Pagamento confirmado — pedido ${numero}`.trim(),
    preheader: `Recebemos o pagamento do pedido ${numero}. Total ${formatarReais(centavos(p.total_centavos))}.`,
    conteudo,
    opcoes: o,
  });
}

/** Cliente: pedido enviado (com rastreio quando houver). */
export function emailPedidoEnviado(pedido, opcoes) {
  const p = ehObjeto(pedido) ? pedido : {};
  const o = opcoesDoModelo(p, opcoes);
  const numero = rotuloNumero(p);
  const nome = primeiroNome(p.cliente_nome);
  const link = linkDoPedido(p, o.siteUrl);
  const rastreio = blocoRastreio(p);
  const prazo = ehObjeto(p.entrega) ? prazoTexto(p.entrega.prazo_dias) : '';

  const conteudo = [
    titulo('Seu pedido está a caminho!'),
    paragrafo(`${nome ? `Olá, ${escaparHtml(nome)}! ` : 'Olá! '}O pedido <strong>${escaparHtml(numero)}</strong> foi enviado${prazo ? ` e deve chegar em ${escaparHtml(prazo)}` : ''}.`),
    rastreio ? subtitulo('Rastreio') : '',
    rastreio,
    rastreio ? '' : paragrafo('O código de rastreio aparece na página do seu pedido assim que a transportadora registrar a postagem.'),
    subtitulo('Entrega'),
    blocoEntrega(p, o),
    subtitulo('Resumo do pedido'),
    tabelaItens(p),
    botao('Ver meu pedido', link),
  ].filter(Boolean).join('\n');

  return modelo({
    assunto: `Seu pedido ${numero} foi enviado`.replace(/\s+/g, ' '),
    preheader: rastreio ? `Pedido ${numero} enviado. Acompanhe pelo código de rastreio.` : `Pedido ${numero} enviado.`,
    conteudo,
    opcoes: o,
  });
}

/** Equipe da AMA: novo pedido pago. */
export function emailNovoPedidoAdmin(pedido, opcoes) {
  const p = ehObjeto(pedido) ? pedido : {};
  const o = opcoesDoModelo(p, opcoes);
  const numero = rotuloNumero(p);
  const total = formatarReais(centavos(p.total_centavos));
  const metodo = METODOS[p.metodo_pagamento] || umaLinha(p.metodo_pagamento);
  const id = p.id === undefined || p.id === null ? '' : String(p.id);
  const linkPainel = o.siteUrl && id ? urlSegura(`${o.siteUrl}/admin/#/pedidos/${encodeURIComponent(id)}`) : '';
  const email = umaLinha(p.cliente_email);

  const cliente = [
    `<strong>${escaparHtml(umaLinha(p.cliente_nome) || 'Cliente')}</strong>`,
    email ? (podeVirarMailto(email)
      ? `<a href="mailto:${escaparHtml(email)}" style="color:${COR.verdeMedio};">${escaparHtml(email)}</a>`
      : escaparHtml(email)) : '',
    p.cliente_telefone ? escaparHtml(formatarTelefone(p.cliente_telefone)) : '',
  ].filter(Boolean).join('<br>');
  const observacoes = String(p.observacoes ?? '').trim();

  const conteudo = [
    titulo(`Novo pedido pago ${numero}`.trim()),
    paragrafo(`Um pagamento de <strong>${escaparHtml(total)}</strong> foi confirmado pelo Mercado Pago${metodo ? ` (${escaparHtml(metodo)})` : ''}. Hora de separar os produtos!`),
    subtitulo('Cliente'),
    caixa(cliente),
    subtitulo(ehObjeto(p.entrega) && p.entrega.tipo === 'retirada' ? 'Retirada' : 'Entrega'),
    blocoEntrega(p, o),
    observacoes ? subtitulo('Observações do cliente') : '',
    observacoes ? caixa(escaparHtml(observacoes).replace(/\r?\n/g, '<br>')) : '',
    subtitulo('Itens'),
    tabelaItens(p),
    botao('Abrir no painel', linkPainel),
  ].filter(Boolean).join('\n');

  return modelo({
    assunto: `Novo pedido pago ${numero} — ${total}`.replace(/\s+/g, ' '),
    preheader: `${umaLinha(p.cliente_nome) || 'Cliente'} pagou ${total}.`,
    conteudo,
    opcoes: o,
    rodapeExtra: 'E-mail automático da loja da AMA para a equipe. ',
    paraEquipe: true,
  });
}

/** Cliente: modelo de acordo com pedido.status (pago, enviado, entregue, cancelado, reembolsado). */
export function emailStatusPedido(pedido, opcoes) {
  const p = ehObjeto(pedido) ? pedido : {};
  if (p.status === 'pago') return emailPedidoPago(p, opcoes);
  if (p.status === 'enviado') return emailPedidoEnviado(p, opcoes);
  const textos = {
    entregue: {
      titulo: 'Pedido entregue!',
      assunto: 'Seu pedido {n} foi entregue',
      mensagem: 'O pedido <strong>{n}</strong> foi entregue. Esperamos que você ame cada detalhe feito pelas mulheres da AMA!',
    },
    cancelado: {
      titulo: 'Pedido cancelado',
      assunto: 'Seu pedido {n} foi cancelado',
      // Nenhuma rota estorna sozinha no Mercado Pago: a devolução é feita pela AMA.
      mensagem: 'O pedido <strong>{n}</strong> foi cancelado. Se você já pagou, a AMA vai fazer a devolução pelo Mercado Pago; o prazo para o valor aparecer depende do meio de pagamento. Qualquer dúvida, fale com a gente.',
    },
    reembolsado: {
      titulo: 'Pagamento devolvido',
      assunto: 'O pagamento do pedido {n} foi devolvido',
      mensagem: 'O pagamento do pedido <strong>{n}</strong> foi devolvido pelo Mercado Pago. O prazo para o valor aparecer depende do meio de pagamento usado.',
    },
  };
  const texto = textos[p.status];
  if (!texto) return null;
  const o = opcoesDoModelo(p, opcoes);
  const numero = rotuloNumero(p);
  const nome = primeiroNome(p.cliente_nome);
  const link = linkDoPedido(p, o.siteUrl);
  const conteudo = [
    titulo(texto.titulo),
    paragrafo(`${nome ? `Olá, ${escaparHtml(nome)}! ` : 'Olá! '}${texto.mensagem.replaceAll('{n}', escaparHtml(numero))}`),
    subtitulo('Resumo do pedido'),
    tabelaItens(p),
    botao('Ver meu pedido', link),
  ].join('\n');
  return modelo({
    assunto: texto.assunto.replace('{n}', numero).replace(/\s+/g, ' '),
    preheader: `${texto.titulo} ${numero}`.trim(),
    conteudo,
    opcoes: o,
  });
}

// ---------------------------------------------------------------------------
// Envio

function destinatarios(para) {
  const lista = Array.isArray(para) ? para : String(para ?? '').split(/[,;]/);
  const validos = [];
  for (const item of lista) {
    const email = typeof item === 'string' ? item.trim() : '';
    if (validarEmail(email) && !validos.includes(email)) validos.push(email);
  }
  return validos.slice(0, 50);
}

/**
 * Envia um e-mail pelo Resend. Sem RESEND_API_KEY não faz nada. Nunca lança.
 * @returns {Promise<boolean>} true se o Resend aceitou
 */
export async function enviarEmail(dados) {
  let relogio;
  try {
    const {
      para, assunto, html, texto, responderPara, idempotencia, timeoutMs,
    } = ehObjeto(dados) ? dados : {};
    const ambiente = obterAmbiente();
    if (!ambiente.resendApiKey) return false;

    const to = destinatarios(para);
    const subject = umaLinha(assunto).slice(0, 250);
    if (!to.length) {
      console.error('[email] envio ignorado: nenhum destinatário válido.');
      return false;
    }
    if (!subject || typeof html !== 'string' || !html.trim()) {
      console.error('[email] envio ignorado: assunto ou HTML vazio.');
      return false;
    }

    const corpo = { from: ambiente.emailRemetente || REMETENTE_PADRAO, to, subject, html };
    if (typeof texto === 'string' && texto.trim()) corpo.text = texto;
    const resposta = destinatarios(responderPara);
    if (resposta.length) corpo.reply_to = resposta;

    const cabecalhos = {
      Authorization: `Bearer ${ambiente.resendApiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'AMA Loja',
    };
    const chave = umaLinha(idempotencia);
    if (chave) cabecalhos['Idempotency-Key'] = chave.slice(0, 256);

    const limite = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : TIMEOUT_PADRAO_MS;
    const controle = new AbortController();
    relogio = setTimeout(() => controle.abort(), limite);
    const respostaHttp = await fetch(`${ambiente.resendApiBase}/emails`, {
      method: 'POST',
      headers: cabecalhos,
      body: JSON.stringify(corpo),
      signal: controle.signal,
    });
    const textoResposta = await respostaHttp.text().catch(() => '');
    if (!respostaHttp.ok) {
      console.error(`[email] o Resend recusou o envio (HTTP ${respostaHttp.status}): ${textoResposta.slice(0, LIMITE_LOG)}`);
      return false;
    }
    return true;
  } catch (erro) {
    const motivo = erro && erro.name === 'AbortError' ? 'tempo esgotado' : (erro && erro.message) || String(erro);
    console.error(`[email] falha ao enviar: ${motivo}`);
    return false;
  } finally {
    clearTimeout(relogio);
  }
}
