// GET /midia/<caminho> — fotos e vídeos enviados pelo painel, lidos do bucket R2.
// Os nomes são únicos (terminam com a impressão digital do arquivo), então o navegador e o cache do
// Cloudflare guardam por um ano. Aceita Range (vídeos no iPhone precisam) e If-None-Match (304).

import { caminhoDeMidiaValido } from '../lib/armazenamento.js';

const CACHE = 'public, max-age=31536000, immutable';

const texto = (status, mensagem, extra = {}) => new Response(mensagem, {
  status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
});

function faixaDe(objeto) {
  const r = objeto.range;
  if (!r) return null;
  if (r.suffix !== undefined) {
    const tamanho = Math.min(r.suffix, objeto.size);
    return { inicio: objeto.size - tamanho, fim: objeto.size - 1 };
  }
  const inicio = r.offset || 0;
  const tamanho = r.length !== undefined ? r.length : objeto.size - inicio;
  return { inicio, fim: inicio + tamanho - 1 };
}

export async function servirMidia(request, env, ctx) {
  const metodo = request.method.toUpperCase();
  if (metodo !== 'GET' && metodo !== 'HEAD') return texto(405, 'Método não permitido', { Allow: 'GET, HEAD' });

  let caminho;
  try {
    caminho = decodeURIComponent(new URL(request.url).pathname.slice('/midia/'.length));
  } catch {
    return texto(400, 'Endereço inválido');
  }
  if (!caminhoDeMidiaValido(caminho) || !env.MIDIA) return texto(404, 'Arquivo não encontrado');

  const temFaixa = request.headers.has('range');
  const cache = typeof caches !== 'undefined' && caches.default ? caches.default : null;
  if (cache && metodo === 'GET' && !temFaixa) {
    const guardada = await cache.match(request);
    if (guardada) return guardada;
  }

  let objeto;
  try {
    objeto = await env.MIDIA.get(caminho, { range: request.headers, onlyIf: request.headers });
  } catch {
    return texto(416, 'Faixa inválida');
  }
  if (!objeto) return texto(404, 'Arquivo não encontrado');

  const headers = new Headers();
  objeto.writeHttpMetadata(headers);
  headers.set('ETag', objeto.httpEtag);
  headers.set('Cache-Control', CACHE);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (!('body' in objeto) || !objeto.body) return new Response(null, { status: 304, headers });

  let status = 200;
  const faixa = temFaixa ? faixaDe(objeto) : null;
  if (faixa) {
    status = 206;
    headers.set('Content-Range', `bytes ${faixa.inicio}-${faixa.fim}/${objeto.size}`);
  }
  const resposta = new Response(metodo === 'HEAD' ? null : objeto.body, { status, headers });
  if (cache && metodo === 'GET' && status === 200 && ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(cache.put(request, resposta.clone()).catch(() => {}));
  }
  return resposta;
}
