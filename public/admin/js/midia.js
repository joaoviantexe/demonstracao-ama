// Arquivos do bucket "midia" do Supabase Storage (docs/ARQUITETURA.md §4.4 e docs/PAINEL.md).
// Nome no bucket: <pasta>/<aaaa-mm>/<slug-do-nome>-<6 hex>.<ext>. Upload direto do navegador com o
// JWT do admin (as policies só deixam admins gravar); a leitura é pela URL pública.
// As funções puras (nomeSeguroArquivo, validarArquivo, tipoDoArquivo) rodam no Node para os testes.

import { erroSupabase, obterConfigSupabase, obterSupabase, obterToken } from './api.js';
import {
  botao, campo, debounce, el, estadoCarregando, estadoErro, estadoVazio, formatarBytes, icone, modal, slugify, toast,
} from './ui.js';

export const BUCKET = 'midia';
/** Pastas usadas pelo site: site/ (CMS), produtos/ e videos/. */
export const PASTAS = Object.freeze(['site', 'produtos', 'videos']);
export const ROTULOS_PASTAS = Object.freeze({ site: 'Site', produtos: 'Produtos', videos: 'Vídeos' });
/** Limite do bucket (50 MB, igual ao plano gratuito do Supabase). */
export const LIMITE_BYTES = 50 * 1024 * 1024;
/** Acima disso a imagem gera aviso (deixa o site lento). */
export const IMAGEM_RECOMENDADA_BYTES = 2 * 1024 * 1024;
/** Acima disso o vídeo gera aviso. */
export const VIDEO_RECOMENDADO_BYTES = 20 * 1024 * 1024;
/** Lado máximo da imagem otimizada no navegador. */
export const LADO_MAXIMO_PX = 2000;

/** Tipos aceitos. SVG fica de fora de propósito (pode carregar script). */
export const TIPOS_ACEITOS = Object.freeze({
  imagem: Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']),
  video: Object.freeze(['video/mp4', 'video/webm']),
});

const EXTENSAO_DO_TIPO = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
  'video/mp4': 'mp4', 'video/webm': 'webm',
};
const TIPO_DA_EXTENSAO = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  avif: 'image/avif', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm',
};

/** Erro das funções de mídia: message em português e .codigo. */
export class ErroMidia extends Error {
  constructor(mensagem, codigo = 'erro_midia') {
    super(mensagem);
    this.name = 'ErroMidia';
    this.codigo = codigo;
  }
}

// Pasta de envio: só a-z, 0-9 e hífens simples (sem "/", "." ou espaço).
const PASTA_VALIDA = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function extensaoDe(nome) {
  const m = String(nome || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : '';
}

/** Tipo MIME do arquivo (pelo .type ou, se vazio, pela extensão). '' se desconhecido. */
export function tipoDoArquivo(arquivo) {
  const tipo = String((arquivo && arquivo.type) || '').toLowerCase();
  if (tipo) return tipo === 'image/jpg' ? 'image/jpeg' : tipo;
  return TIPO_DA_EXTENSAO[extensaoDe(arquivo && arquivo.name)] || '';
}

/** 'imagem' | 'video' | null para um tipo MIME (ou nome de arquivo). */
export function categoriaDoTipo(tipoOuNome) {
  const texto = String(tipoOuNome || '').toLowerCase();
  const tipo = texto.includes('/') ? texto : TIPO_DA_EXTENSAO[extensaoDe(texto)] || '';
  if (TIPOS_ACEITOS.imagem.includes(tipo)) return 'imagem';
  if (TIPOS_ACEITOS.video.includes(tipo)) return 'video';
  return null;
}

function hexAleatorio(tamanho = 6) {
  const bytes = new Uint8Array(Math.ceil(tamanho / 2));
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, tamanho);
}

/**
 * Caminho seguro no bucket: <pasta>/<aaaa-mm>/<slug-do-nome>-<6 hex>.<ext>.
 * - pasta: só a-z, 0-9 e hífen (padrão "site"); outra coisa lança TypeError.
 * - ext: do tipo MIME (opções.tipo) ou do nome; "jpeg" vira "jpg"; desconhecida → "bin".
 * - opções: { tipo, data (Date, mês em UTC), sufixo (6 a 16 hex; padrão: 6 aleatórios) }.
 */
export function nomeSeguroArquivo(nomeOriginal, pasta = 'site', { tipo, data = new Date(), sufixo } = {}) {
  const p = String(pasta || 'site');
  if (!PASTA_VALIDA.test(p)) throw new TypeError(`Pasta inválida: "${pasta}"`);
  const nome = String(nomeOriginal || '').split(/[\\/]/).pop();
  const extNome = extensaoDe(nome);
  const ext = EXTENSAO_DO_TIPO[String(tipo || '').toLowerCase()]
    || (extNome === 'jpeg' || extNome === 'jfif' ? 'jpg' : extNome)
    || 'bin';
  const semExtensao = extNome ? nome.slice(0, -(extNome.length + 1)) : nome;
  const base = slugify(semExtensao, { max: 60 }) || 'arquivo';
  const dataValida = data instanceof Date && !Number.isNaN(data.getTime()) ? data : new Date();
  const mes = dataValida.toISOString().slice(0, 7);
  const fim = typeof sufixo === 'string' && /^[0-9a-f]{6,16}$/.test(sufixo) ? sufixo : hexAleatorio(6);
  return `${p}/${mes}/${base}-${fim}.${ext}`;
}

/**
 * Confere tamanho e tipo antes do envio. tipo: 'imagem' | 'video' | undefined (os dois).
 * → { ok, erro?, avisos: [texto], tipo (MIME), categoria: 'imagem'|'video'|null }
 */
export function validarArquivo(arquivo, { tipo } = {}) {
  const mime = tipoDoArquivo(arquivo);
  const categoria = categoriaDoTipo(mime);
  const tamanho = Number(arquivo && arquivo.size) || 0;
  const avisos = [];
  const aceitos = tipo ? TIPOS_ACEITOS[tipo] || [] : [...TIPOS_ACEITOS.imagem, ...TIPOS_ACEITOS.video];
  if (!aceitos.includes(mime)) {
    const lista = tipo === 'video' ? 'MP4 ou WebM' : tipo === 'imagem' ? 'JPG, PNG, WebP, GIF ou AVIF' : 'JPG, PNG, WebP, GIF, AVIF, MP4 ou WebM';
    return { ok: false, erro: `Tipo de arquivo não aceito. Use ${lista}.`, avisos, tipo: mime, categoria };
  }
  if (tamanho <= 0) return { ok: false, erro: 'O arquivo está vazio.', avisos, tipo: mime, categoria };
  if (tamanho > LIMITE_BYTES) {
    return { ok: false, erro: `O arquivo tem ${formatarBytes(tamanho)} e o limite é 50 MB. Comprima antes de enviar.`, avisos, tipo: mime, categoria };
  }
  if (categoria === 'imagem' && tamanho > IMAGEM_RECOMENDADA_BYTES) {
    avisos.push(`Imagem grande (${formatarBytes(tamanho)}): acima de 2 MB o site fica lento. Deixe "Otimizar" ligado ou comprima antes (ex.: squoosh.app).`);
  }
  if (categoria === 'video' && tamanho > VIDEO_RECOMENDADO_BYTES) {
    avisos.push(`Vídeo grande (${formatarBytes(tamanho)}): prefira vídeos curtos e comprimidos (até 20 MB) para carregar rápido no celular.`);
  }
  return { ok: true, avisos, tipo: mime, categoria };
}

// ---------------------------------------------------------------------------
// Otimização de imagem no navegador

async function carregarBitmap(arquivo) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(arquivo, { imageOrientation: 'from-image' });
    } catch { /* tenta pelo <img> */ }
  }
  const url = URL.createObjectURL(arquivo);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function paraBlob(canvas, tipo, qualidade) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), tipo, qualidade));
}

function temTransparencia(fonte, largura, altura) {
  const lado = 64;
  const c = document.createElement('canvas');
  c.width = lado;
  c.height = lado;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(fonte, 0, 0, largura, altura, 0, 0, lado, lado);
  const dados = g.getImageData(0, 0, lado, lado).data;
  for (let i = 3; i < dados.length; i += 4) if (dados[i] < 250) return true;
  return false;
}

/**
 * Reduz a imagem para no máximo `maxLado` px e comprime (JPEG; WebP se tiver transparência).
 * Só JPEG, PNG e WebP (GIF e AVIF ficam como estão). Se não ficar menor nem precisar
 * reduzir, devolve o original. → { arquivo, otimizado, largura, altura, larguraOriginal, alturaOriginal }
 */
export async function otimizarImagem(arquivo, { maxLado = LADO_MAXIMO_PX, qualidade = 0.85 } = {}) {
  const mime = tipoDoArquivo(arquivo);
  const original = { arquivo, otimizado: false, largura: null, altura: null, larguraOriginal: null, alturaOriginal: null };
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime) || typeof document === 'undefined') return original;
  const fonte = await carregarBitmap(arquivo);
  const larguraOriginal = fonte.width || fonte.naturalWidth;
  const alturaOriginal = fonte.height || fonte.naturalHeight;
  if (!larguraOriginal || !alturaOriginal) return original;
  const escala = Math.min(1, maxLado / Math.max(larguraOriginal, alturaOriginal));
  const largura = Math.max(1, Math.round(larguraOriginal * escala));
  const altura = Math.max(1, Math.round(alturaOriginal * escala));
  const transparente = mime !== 'image/jpeg' && temTransparencia(fonte, larguraOriginal, alturaOriginal);

  const canvas = document.createElement('canvas');
  canvas.width = largura;
  canvas.height = altura;
  const g = canvas.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  if (!transparente) {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, largura, altura);
  }
  g.drawImage(fonte, 0, 0, largura, altura);
  if (typeof fonte.close === 'function') fonte.close();

  let blob = await paraBlob(canvas, transparente ? 'image/webp' : 'image/jpeg', qualidade);
  if (transparente && (!blob || blob.type !== 'image/webp')) blob = await paraBlob(canvas, 'image/png');
  const info = { largura, altura, larguraOriginal, alturaOriginal };
  if (!blob || (escala === 1 && blob.size >= arquivo.size)) return { ...original, ...info, largura: larguraOriginal, altura: alturaOriginal };
  const ext = EXTENSAO_DO_TIPO[blob.type] || 'jpg';
  const nomeBase = String(arquivo.name || 'imagem').replace(/\.[^.]+$/, '');
  const novo = new File([blob], `${nomeBase}.${ext}`, { type: blob.type, lastModified: Date.now() });
  return { arquivo: novo, otimizado: true, ...info };
}

// ---------------------------------------------------------------------------
// Storage

function storage() {
  return obterSupabase().storage.from(BUCKET);
}

/** URL pública de um caminho do bucket. */
export function urlPublica(caminho) {
  return storage().getPublicUrl(caminho).data.publicUrl;
}

/** Caminho no bucket a partir da URL pública (null se a URL não é do bucket "midia" deste projeto). */
export function caminhoDaUrl(url) {
  const { supabaseUrl } = obterConfigSupabase();
  const prefixo = `${supabaseUrl}/storage/v1/object/public/${BUCKET}/`;
  const texto = String(url || '');
  if (!supabaseUrl || !texto.startsWith(prefixo)) return null;
  const caminho = decodeURIComponent(texto.slice(prefixo.length).split(/[?#]/)[0]);
  return caminhoValido(caminho) ? caminho : null;
}

function caminhoValido(caminho) {
  const texto = String(caminho || '');
  return Boolean(texto) && !texto.startsWith('/') && !texto.split('/').some((p) => !p || p === '.' || p === '..');
}

function enviarComProgresso({ url, token, chave, arquivo, tipo, aoProgresso, sinal }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', chave);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.setRequestHeader('cache-control', 'max-age=31536000');
    xhr.setRequestHeader('Content-Type', tipo || 'application/octet-stream');
    xhr.upload.onprogress = (evento) => {
      if (evento.lengthComputable && aoProgresso) {
        aoProgresso({ enviados: evento.loaded, total: evento.total, fracao: evento.total ? evento.loaded / evento.total : 0 });
      }
    };
    xhr.onload = () => {
      let json = null;
      try { json = JSON.parse(xhr.responseText); } catch { json = null; }
      resolve({ status: xhr.status, json });
    };
    xhr.onerror = () => reject(new ErroMidia('Não foi possível enviar: verifique sua internet e tente de novo.', 'sem_conexao'));
    xhr.onabort = () => reject(new ErroMidia('Envio cancelado.', 'cancelado'));
    if (sinal) {
      if (sinal.aborted) {
        reject(new ErroMidia('Envio cancelado.', 'cancelado'));
        return;
      }
      sinal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(arquivo);
  });
}

/** Primeiros 12 caracteres hexadecimais do SHA-256 do arquivo; '' se o navegador não calcula. */
async function impressaoDigital(arquivo) {
  try {
    if (!globalThis.crypto || !globalThis.crypto.subtle || typeof arquivo.arrayBuffer !== 'function') return '';
    const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', await arquivo.arrayBuffer()));
    return Array.from(bytes.slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

/** Arquivo da pasta cujo nome termina com a impressão digital, ou null (qualquer falha vira null: envia normalmente). */
async function acharPorImpressao(pasta, impressao) {
  try {
    const arquivos = await listarArquivos(pasta);
    return arquivos.find((a) => a.nome.replace(/\.[^.]+$/, '').endsWith(`-${impressao}`)) || null;
  } catch {
    return null;
  }
}

/**
 * Envia um arquivo para o bucket. pasta: 'site' | 'produtos' | 'videos' (ou outra pasta a-z0-9-;
 * vazia → 'site'). opções: { otimizar = true (imagens JPEG/PNG/WebP), aoProgresso({ enviados, total, fracao }), sinal }.
 * → { url, caminho, tamanho, tipo, nome, otimizado, avisos }. Lança ErroMidia com mensagem em português
 * (inclusive 'pasta_invalida', antes de otimizar ou enviar qualquer coisa).
 */
export async function enviarArquivo(arquivo, pasta = 'site', { otimizar = true, aoProgresso, sinal } = {}) {
  const destino = pasta === null || pasta === undefined || pasta === '' ? 'site' : String(pasta);
  if (!PASTA_VALIDA.test(destino)) {
    throw new ErroMidia(`Pasta de envio inválida ("${destino.slice(0, 40)}"). Use ${PASTAS.join(', ')}.`, 'pasta_invalida');
  }
  if (!arquivo) throw new ErroMidia('Nenhum arquivo escolhido.', 'sem_arquivo');
  const validacao = validarArquivo(arquivo);
  if (!validacao.ok) throw new ErroMidia(validacao.erro, 'arquivo_invalido');
  // Arquivo idêntico a um que já está no bucket: reaproveita em vez de gastar armazenamento de novo.
  // O nome termina com o início do SHA-256 do arquivo original, então basta procurar por ele.
  const impressao = await impressaoDigital(arquivo);
  if (impressao) {
    const existente = await acharPorImpressao(destino, impressao);
    if (existente) {
      return {
        url: existente.url, caminho: existente.caminho, tamanho: existente.tamanho || arquivo.size, tipo: existente.tipo || tipoDoArquivo(arquivo),
        nome: existente.nome, otimizado: false, reutilizado: true, avisos: [],
      };
    }
  }
  let final = arquivo;
  let otimizado = false;
  if (otimizar && validacao.categoria === 'imagem') {
    try {
      const r = await otimizarImagem(arquivo);
      final = r.arquivo;
      otimizado = r.otimizado;
    } catch (erro) {
      console.warn('[midia] não foi possível otimizar; enviando o original.', erro);
    }
  }
  const tipo = tipoDoArquivo(final);
  const { supabaseUrl, supabaseAnonKey } = obterConfigSupabase();
  const token = await obterToken();
  if (!token) throw new ErroMidia('Sua sessão expirou. Entre novamente.', 'nao_autenticado');

  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    const caminho = nomeSeguroArquivo(arquivo.name, destino, { tipo, sufixo: tentativa === 0 && impressao ? impressao : undefined });
    const url = `${supabaseUrl}/storage/v1/object/${BUCKET}/${caminho.split('/').map(encodeURIComponent).join('/')}`;
    const { status, json } = await enviarComProgresso({ url, token, chave: supabaseAnonKey, arquivo: final, tipo, aoProgresso, sinal });
    if (status >= 200 && status < 300) {
      return {
        url: urlPublica(caminho), caminho, tamanho: final.size, tipo, nome: caminho.split('/').pop(), otimizado,
        avisos: otimizado ? [] : validacao.avisos,
      };
    }
    const codigoStorage = String((json && (json.statusCode || json.error)) || '');
    if ((status === 409 || codigoStorage === '409' || codigoStorage === 'Duplicate') && tentativa === 0) continue;
    const normal = erroSupabase({ message: json && (json.message || json.error), statusCode: Number(json && json.statusCode) || status }, status);
    throw new ErroMidia(normal.mensagem, normal.erro);
  }
  throw new ErroMidia('Não foi possível gerar um nome único para o arquivo. Tente de novo.', 'duplicado');
}

function itemDoStorage(pasta, item) {
  const caminho = `${pasta}/${item.name}`;
  const tipo = (item.metadata && item.metadata.mimetype) || TIPO_DA_EXTENSAO[extensaoDe(item.name)] || '';
  return {
    nome: item.name,
    caminho,
    pasta: pasta.split('/')[0],
    url: urlPublica(caminho),
    tamanho: item.metadata ? Number(item.metadata.size) || 0 : 0,
    tipo,
    categoria: categoriaDoTipo(tipo || item.name),
    criado_em: item.created_at || item.updated_at || null,
  };
}

async function listarPrefixo(prefixo) {
  const { data, error } = await storage().list(prefixo, { limit: 1000, sortBy: { column: 'name', order: 'desc' } });
  if (error) {
    const normal = erroSupabase(error);
    throw new ErroMidia(normal.mensagem, normal.erro);
  }
  return data || [];
}

/**
 * Lista os arquivos de uma pasta ('site', 'produtos', 'videos' ou 'site/2026-10'); sem pasta, de todas.
 * Desce um nível (as subpastas aaaa-mm). Mais novos primeiro.
 * → [{ nome, caminho, pasta, url, tamanho, tipo, categoria: 'imagem'|'video'|null, criado_em }]
 */
export async function listarArquivos(pasta) {
  const raizes = pasta ? [String(pasta).replace(/^\/+|\/+$/g, '')] : [...PASTAS];
  if (raizes.some((r) => !caminhoValido(r))) throw new ErroMidia('Pasta inválida.', 'pasta_invalida');
  const arquivos = [];
  await Promise.all(raizes.map(async (raiz) => {
    const itens = await listarPrefixo(raiz);
    const subpastas = [];
    for (const item of itens) {
      if (item.name === '.emptyFolderPlaceholder') continue;
      if (item.id === null || item.id === undefined) subpastas.push(`${raiz}/${item.name}`);
      else arquivos.push(itemDoStorage(raiz, item));
    }
    const filhos = await Promise.all(subpastas.map(async (sub) => (await listarPrefixo(sub))
      .filter((i) => i.id !== null && i.id !== undefined && i.name !== '.emptyFolderPlaceholder')
      .map((i) => itemDoStorage(sub, i))));
    for (const lista of filhos) arquivos.push(...lista);
  }));
  arquivos.sort((a, b) => String(b.criado_em || b.caminho).localeCompare(String(a.criado_em || a.caminho)));
  return arquivos;
}

/** Apaga um arquivo pelo caminho no bucket. Lança ErroMidia se não existir ou faltar permissão. */
export async function apagarArquivo(caminho) {
  if (!caminhoValido(caminho)) throw new ErroMidia('Caminho de arquivo inválido.', 'caminho_invalido');
  const { data, error } = await storage().remove([caminho]);
  if (error) {
    const normal = erroSupabase(error);
    throw new ErroMidia(normal.mensagem, normal.erro);
  }
  if (!data || !data.length) throw new ErroMidia('Arquivo não encontrado (ou sem permissão para apagar).', 'nao_encontrado');
  return true;
}

// ---------------------------------------------------------------------------
// Componentes de interface

/** Abre o seletor de arquivos do sistema. → Promise<File[]> (vazio se cancelar). */
export function escolherArquivos({ tipo, multiplo = false } = {}) {
  return new Promise((resolve) => {
    const entrada = el('input', {
      type: 'file', class: 'sr-only', accept: (tipo ? TIPOS_ACEITOS[tipo] : [...TIPOS_ACEITOS.imagem, ...TIPOS_ACEITOS.video]).join(','),
      multiple: multiplo, tabindex: '-1', 'aria-hidden': 'true',
    });
    entrada.addEventListener('change', () => {
      resolve(Array.from(entrada.files || []));
      entrada.remove();
    }, { once: true });
    entrada.addEventListener('cancel', () => {
      resolve([]);
      entrada.remove();
    }, { once: true });
    document.body.append(entrada);
    entrada.click();
  });
}

/**
 * Área de upload (arrastar e soltar + botão). aoEscolher(files: File[]) é chamado com os arquivos.
 * opções: { tipo: 'imagem'|'video', multiplo, texto }. → { elemento, definirProgresso(fracao|null, texto), desativar(bool) }
 */
export function criarAreaUpload({ tipo, multiplo = false, aoEscolher, texto } = {}) {
  const escolher = botao({ texto: multiplo ? 'Escolher arquivos' : 'Escolher arquivo', tipo: 'secundario', icone: 'upload' });
  const barra = el('div', { class: 'progresso__barra' });
  const textoProgresso = el('p', { class: 'progresso__texto', 'aria-live': 'polite' });
  const progresso = el('div', { class: 'progresso', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Envio do arquivo', hidden: true }, barra);
  const area = el('div', { class: 'area-upload' },
    el('div', { class: 'area-upload__icone' }, icone(tipo === 'video' ? 'video' : 'upload')),
    el('p', { class: 'area-upload__texto' }, texto || (multiplo ? 'Arraste os arquivos para cá' : 'Arraste o arquivo para cá'), el('span', { class: 'texto-suave' }, ' ou ')),
    escolher,
    progresso,
    textoProgresso);
  let desativada = false;

  const entregar = (arquivos) => {
    if (desativada || !arquivos.length || !aoEscolher) return;
    aoEscolher(multiplo ? arquivos : arquivos.slice(0, 1));
  };
  escolher.addEventListener('click', async () => entregar(await escolherArquivos({ tipo, multiplo })));
  let profundidade = 0;
  area.addEventListener('dragenter', (evento) => {
    evento.preventDefault();
    profundidade += 1;
    if (!desativada) area.classList.add('area-upload--ativa');
  });
  area.addEventListener('dragover', (evento) => {
    evento.preventDefault();
    if (evento.dataTransfer) evento.dataTransfer.dropEffect = desativada ? 'none' : 'copy';
  });
  area.addEventListener('dragleave', () => {
    profundidade = Math.max(0, profundidade - 1);
    if (!profundidade) area.classList.remove('area-upload--ativa');
  });
  area.addEventListener('drop', (evento) => {
    evento.preventDefault();
    profundidade = 0;
    area.classList.remove('area-upload--ativa');
    entregar(Array.from((evento.dataTransfer && evento.dataTransfer.files) || []));
  });

  return {
    elemento: area,
    definirProgresso(fracao, textoAtual = '') {
      if (fracao === null || fracao === undefined) {
        progresso.hidden = true;
        area.classList.remove('area-upload--enviando');
      } else {
        const pct = Math.round(Math.min(1, Math.max(0, fracao)) * 100);
        progresso.hidden = false;
        progresso.setAttribute('aria-valuenow', String(pct));
        barra.style.width = `${pct}%`;
        area.classList.add('area-upload--enviando');
      }
      textoProgresso.textContent = textoAtual;
    },
    desativar(sim) {
      desativada = Boolean(sim);
      escolher.disabled = desativada;
      area.classList.toggle('area-upload--desativada', desativada);
    },
  };
}

/** Miniatura de um arquivo (imagem ou vídeo) para grades e listas. */
export function miniatura(arquivo, { alt = '' } = {}) {
  if (arquivo.categoria === 'video') {
    return el('div', { class: 'miniatura miniatura--video' },
      el('video', { src: `${arquivo.url}#t=0.5`, preload: 'metadata', muted: true, playsinline: true, tabindex: '-1', 'aria-hidden': 'true' }),
      el('span', { class: 'miniatura__selo' }, icone('video')));
  }
  return el('div', { class: 'miniatura' }, el('img', { src: arquivo.url, alt, loading: 'lazy', decoding: 'async' }));
}

/** Endereço digitado aceito como mídia: https://… ou caminho do site (/img/…). */
export function enderecoDeMidiaValido(texto) {
  const v = String(texto || '').trim();
  if (/^\/(?!\/)[^\s"'<>`\\]*$/.test(v)) return true;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' && Boolean(url.hostname) && !/[\s"'<>`\\]/.test(v);
  } catch {
    return false;
  }
}

/**
 * Modal com a biblioteca do bucket (grade, busca, filtro de pasta) e envio de arquivo novo.
 * opções: { tipo: 'imagem'|'video' (padrão imagem), pasta (destino do envio; padrão site/ ou videos/),
 * titulo, permitirEndereco = true (aceita https://… ou /img/…), atual (URL já escolhida) }.
 * → Promise<string|null> com a URL escolhida (null se cancelar).
 */
export function seletorDeMidia({ tipo = 'imagem', pasta, titulo, permitirEndereco = true, atual } = {}) {
  const ehVideo = tipo === 'video';
  const pastaEnvio = pasta || (ehVideo ? 'videos' : 'site');
  let arquivos = [];
  let selecionado = null;
  let enviando = false;
  const controleEnvio = new AbortController();

  const grade = el('div', { class: 'grade-midia', role: 'listbox', 'aria-label': 'Biblioteca de mídia' });
  const contador = el('p', { class: 'texto-suave texto-pequeno', 'aria-live': 'polite' });
  const busca = el('input', { type: 'search', class: 'entrada', placeholder: 'Buscar pelo nome…', 'aria-label': 'Buscar na biblioteca' });
  const filtroPasta = el('select', { class: 'entrada', 'aria-label': 'Pasta' },
    el('option', { value: '' }, 'Todas as pastas'),
    PASTAS.map((p) => el('option', { value: p }, ROTULOS_PASTAS[p] || p)));
  const otimizar = ehVideo ? null : campo({
    tipo: 'interruptor', rotulo: 'Otimizar a imagem antes de enviar (recomendado)', valor: true,
    ajuda: `Reduz para no máximo ${LADO_MAXIMO_PX} px e comprime. Desligue para manter o arquivo original.`,
  });
  const avisos = el('div', { class: 'pilha pilha--estreita' });
  const area = criarAreaUpload({ tipo, aoEscolher: (lista) => enviar(lista[0]) });

  const endereco = permitirEndereco ? campo({
    rotulo: ehVideo ? 'Ou use o endereço de um vídeo' : 'Ou use o endereço de uma imagem',
    tipo: 'url', placeholder: 'https://… ou /img/…',
    ajuda: 'Endereço completo (https://) ou um caminho do próprio site, como /img/logo-ama.png.',
    valor: atual && !atual.includes('/storage/v1/object/public/') ? atual : '',
  }) : null;
  if (endereco) endereco.entrada.setAttribute('type', 'text');

  const conteudo = el('div', { class: 'seletor-midia' },
    el('section', { class: 'seletor-midia__envio', 'aria-label': 'Enviar arquivo novo' }, area.elemento, otimizar && otimizar.elemento, avisos),
    el('section', { class: 'seletor-midia__biblioteca', 'aria-label': 'Biblioteca' },
      el('div', { class: 'filtros' }, el('div', { class: 'filtros__busca' }, icone('busca'), busca), filtroPasta),
      contador,
      grade),
    endereco ? endereco.elemento : null);

  const controle = modal({
    titulo: titulo || (ehVideo ? 'Escolher vídeo' : 'Escolher imagem'),
    conteudo,
    tamanho: 'grande',
    classe: 'modal--midia',
    acoes: [
      { texto: 'Cancelar', tipo: 'secundario', valor: null },
      {
        texto: ehVideo ? 'Usar este vídeo' : 'Usar esta imagem', tipo: 'primario',
        aoClicar: () => {
          const digitado = endereco ? endereco.entrada.value.trim() : '';
          if (!selecionado && digitado) {
            if (!enderecoDeMidiaValido(digitado)) {
              endereco.definirErro('Use um endereço https:// ou um caminho que comece com /.');
              endereco.entrada.focus();
              return false;
            }
            return digitado;
          }
          if (!selecionado) {
            toast(ehVideo ? 'Escolha um vídeo da biblioteca ou envie um novo.' : 'Escolha uma imagem da biblioteca ou envie uma nova.', 'aviso');
            return false;
          }
          return selecionado.url;
        },
      },
    ],
  });
  // Fechar no meio do envio cancela o upload.
  controle.resultado.finally(() => controleEnvio.abort());

  function selecionar(arquivo, botaoItem) {
    selecionado = arquivo;
    for (const b of grade.querySelectorAll('.midia-item')) {
      const sim = b === botaoItem;
      b.setAttribute('aria-selected', String(sim));
      b.classList.toggle('midia-item--selecionado', sim);
    }
    if (endereco && arquivo) endereco.entrada.value = '';
  }

  function itemDaGrade(arquivo) {
    const b = el('button', {
      type: 'button', class: 'midia-item', role: 'option', 'aria-selected': 'false', title: arquivo.nome,
    }, miniatura(arquivo),
    el('span', { class: 'midia-item__nome' }, arquivo.nome),
    el('span', { class: 'midia-item__info' }, [ROTULOS_PASTAS[arquivo.pasta] || arquivo.pasta, arquivo.tamanho ? formatarBytes(arquivo.tamanho) : null].filter(Boolean).join(' · ')));
    b.addEventListener('click', () => selecionar(arquivo, b));
    b.addEventListener('dblclick', () => {
      selecionar(arquivo, b);
      controle.fechar(arquivo.url);
    });
    if (atual && arquivo.url === atual) queueMicrotask(() => selecionar(arquivo, b));
    return b;
  }

  function desenhar() {
    const termo = slugify(busca.value);
    const pastaFiltro = filtroPasta.value;
    const visiveis = arquivos.filter((a) => a.categoria === (ehVideo ? 'video' : 'imagem')
      && (!pastaFiltro || a.pasta === pastaFiltro)
      && (!termo || slugify(a.nome).includes(termo)));
    contador.textContent = arquivos.length
      ? `${visiveis.length} ${visiveis.length === 1 ? 'arquivo' : 'arquivos'}`
      : '';
    if (!visiveis.length) {
      grade.replaceChildren(estadoVazio(null, termo || pastaFiltro
        ? 'Nenhum arquivo encontrado com esse filtro.'
        : (ehVideo ? 'Nenhum vídeo na biblioteca ainda. Envie o primeiro acima.' : 'Nenhuma imagem na biblioteca ainda. Envie a primeira acima.'),
      { icone: ehVideo ? 'video' : 'imagem' }));
      return;
    }
    grade.replaceChildren(...visiveis.map(itemDaGrade));
    if (selecionado) {
      const ativo = Array.from(grade.querySelectorAll('.midia-item')).find((b) => b.title === selecionado.nome);
      if (ativo) selecionar(selecionado, ativo);
    }
  }

  async function carregar() {
    estadoCarregando(grade, { linhas: 6, tipo: 'cartoes', mensagem: 'Carregando a biblioteca…' });
    try {
      arquivos = await listarArquivos();
      desenhar();
    } catch (erro) {
      estadoErro(grade, erro.message, { aoTentarNovamente: carregar });
    }
  }

  async function enviar(arquivo) {
    if (enviando || !arquivo) return;
    const validacao = validarArquivo(arquivo, { tipo });
    avisos.replaceChildren();
    if (!validacao.ok) {
      toast(validacao.erro, 'erro');
      return;
    }
    const otimizarAgora = otimizar ? otimizar.ler() : false;
    if (!otimizarAgora) {
      for (const texto of validacao.avisos) avisos.append(el('p', { class: 'aviso aviso--alerta' }, icone('alerta'), el('span', {}, texto)));
    }
    enviando = true;
    area.desativar(true);
    controle.definirOcupado(true);
    area.definirProgresso(0, otimizarAgora && validacao.categoria === 'imagem' ? `Otimizando ${arquivo.name}…` : `Enviando ${arquivo.name}…`);
    try {
      const r = await enviarArquivo(arquivo, pastaEnvio, {
        otimizar: otimizarAgora,
        sinal: controleEnvio.signal,
        aoProgresso: ({ fracao }) => area.definirProgresso(fracao, `Enviando ${arquivo.name}… ${Math.round(fracao * 100)}%`),
      });
      const novo = {
        nome: r.nome, caminho: r.caminho, pasta: pastaEnvio, url: r.url, tamanho: r.tamanho, tipo: r.tipo,
        categoria: categoriaDoTipo(r.tipo), criado_em: new Date().toISOString(),
      };
      arquivos = [novo, ...arquivos];
      selecionado = novo;
      busca.value = '';
      filtroPasta.value = '';
      desenhar();
      area.definirProgresso(null, r.otimizado ? `Enviado e otimizado (${formatarBytes(r.tamanho)}).` : 'Arquivo enviado.');
      toast(ehVideo ? 'Vídeo enviado.' : 'Imagem enviada.', 'sucesso');
    } catch (erro) {
      area.definirProgresso(null, '');
      if (erro.codigo !== 'cancelado') toast(erro.message || 'Não foi possível enviar o arquivo.', 'erro');
    } finally {
      enviando = false;
      area.desativar(false);
      controle.definirOcupado(false);
    }
  }

  busca.addEventListener('input', debounce(desenhar, 150));
  filtroPasta.addEventListener('change', desenhar);
  carregar();
  return controle.resultado;
}
