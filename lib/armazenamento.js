// Armazenamento de arquivos do site (docs/ARQUITETURA.md §4.4): fotos e vídeos do painel e a home publicada.
// Em produção é o bucket R2 do Cloudflare (worker/r2.js); no servidor local e nos testes, uma pasta
// (scripts/armazenamento-local.mjs). Quem sobe o servidor escolhe com definirArmazenamento().
//
// Interface (todas as funções são assíncronas; `chave` é o caminho no bucket, ex.: "site/2026-10/foto-a1b2c3.jpg"):
// - lerTexto(chave) → string | null
// - gravar(chave, dados: Uint8Array | string, { tipo }) → void
// - existe(chave) → boolean
// - listar(prefixo) → [{ chave, tamanho, tipo, criado_em }] (todos os níveis abaixo do prefixo)
// - apagar(chave) → boolean (false se não existia)

import { ErroHttp } from './http.js';

let atual = null;

/** Define o armazenamento usado pelas funções (null desliga). */
export function definirArmazenamento(armazenamento) {
  atual = armazenamento || null;
}

/** Armazenamento atual; sem nenhum, lança ErroHttp 503. */
export function obterArmazenamento() {
  if (!atual) {
    throw new ErroHttp(503, 'armazenamento_nao_configurado',
      'O armazenamento de arquivos não está configurado (bucket R2 "MIDIA").');
  }
  return atual;
}

/** true se há armazenamento definido. */
export const armazenamentoConfigurado = () => Boolean(atual);

/** Pastas de mídia aceitas no bucket (as mesmas do painel). */
export const PASTAS_MIDIA = Object.freeze(['site', 'produtos', 'videos']);

/** Chave da home publicada pelo painel (fora das pastas de mídia: não aparece na biblioteca nem em /midia/). */
export const CHAVE_HOME = '_publicado/home.html';
/** Metadados da home publicada (assinatura do conteúdo e data). */
export const CHAVE_HOME_INFO = '_publicado/home.json';

const SEGMENTO = /^[a-z0-9](?:[a-z0-9._-]{0,150}[a-z0-9])?$/i;

/**
 * Caminho de mídia válido: <pasta>/<…>/<arquivo>, com a pasta em PASTAS_MIDIA, sem "..", "//" nem
 * caracteres fora de [a-z0-9._-]. → o caminho ou null.
 */
export function caminhoDeMidiaValido(caminho) {
  const texto = String(caminho ?? '');
  if (!texto || texto.length > 400) return null;
  const partes = texto.split('/');
  if (partes.length < 2 || !PASTAS_MIDIA.includes(partes[0])) return null;
  if (partes.some((p) => !SEGMENTO.test(p) || p.includes('..'))) return null;
  return texto;
}

const TIPOS_POR_EXTENSAO = Object.freeze({
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', html: 'text/html; charset=utf-8', json: 'application/json',
});

/** Tipo MIME pela extensão do caminho ('' se desconhecida). */
export function tipoPelaExtensao(caminho) {
  const m = String(caminho || '').toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return (m && TIPOS_POR_EXTENSAO[m[1]]) || '';
}
