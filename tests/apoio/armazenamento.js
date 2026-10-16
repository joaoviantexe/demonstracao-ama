// Armazenamento em memória (interface de lib/armazenamento.js) e um bucket R2 falso (para worker/r2.js e
// worker/midia.js), para os testes rodarem sem disco nem Cloudflare.

import { createHash } from 'node:crypto';

const bytesDe = (dados) => (typeof dados === 'string' ? new TextEncoder().encode(dados) : new Uint8Array(dados));

/** Interface de lib/armazenamento.js guardando tudo num Map (exposto em .arquivos). */
export function armazenamentoMemoria(inicial = {}) {
  const arquivos = new Map();
  let relogio = Date.parse('2026-10-01T12:00:00Z');
  const gravarSync = (chave, dados, tipo = '') => {
    relogio += 1000;
    arquivos.set(chave, { bytes: bytesDe(dados), tipo, criado_em: new Date(relogio).toISOString() });
  };
  for (const [chave, valor] of Object.entries(inicial)) gravarSync(chave, valor);
  return {
    arquivos,
    async lerTexto(chave) {
      const a = arquivos.get(chave);
      return a ? new TextDecoder().decode(a.bytes) : null;
    },
    async gravar(chave, dados, { tipo } = {}) {
      gravarSync(chave, dados, tipo || '');
    },
    async existe(chave) {
      return arquivos.has(chave);
    },
    async listar(prefixo) {
      return [...arquivos].filter(([chave]) => chave.startsWith(prefixo))
        .map(([chave, a]) => ({ chave, tamanho: a.bytes.length, tipo: a.tipo, criado_em: a.criado_em }));
    },
    async apagar(chave) {
      return arquivos.delete(chave);
    },
  };
}

function lerFaixa(cabecalho, tamanho) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(cabecalho || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) return { suffix: Number(m[2]) };
  const offset = Number(m[1]);
  if (offset >= tamanho) throw new RangeError('faixa fora do arquivo');
  return m[2] ? { offset, length: Math.min(Number(m[2]), tamanho - 1) - offset + 1 } : { offset };
}

/** Bucket R2 falso: get (com range/onlyIf em Headers), head, put, delete, list. Guarda em .objetos. */
export function bucketR2Falso() {
  const objetos = new Map();
  let relogio = Date.parse('2026-10-01T12:00:00Z');
  const metadados = (chave, o) => ({
    key: chave,
    size: o.bytes.length,
    uploaded: o.uploaded,
    httpEtag: `"${o.etag}"`,
    etag: o.etag,
    httpMetadata: { ...o.httpMetadata },
    writeHttpMetadata(headers) {
      if (o.httpMetadata.contentType) headers.set('content-type', o.httpMetadata.contentType);
    },
  });
  return {
    objetos,
    async put(chave, dados, opcoes = {}) {
      relogio += 1000;
      const bytes = bytesDe(dados);
      objetos.set(chave, {
        bytes,
        etag: createHash('md5').update(bytes).digest('hex'),
        uploaded: new Date(relogio),
        httpMetadata: { ...(opcoes.httpMetadata || {}) },
      });
    },
    async head(chave) {
      const o = objetos.get(chave);
      return o ? metadados(chave, o) : null;
    },
    async get(chave, opcoes = {}) {
      const o = objetos.get(chave);
      if (!o) return null;
      const base = metadados(chave, o);
      const condicoes = opcoes.onlyIf instanceof Headers ? opcoes.onlyIf : new Headers();
      const naoCasar = condicoes.get('if-none-match');
      if (naoCasar && naoCasar.split(',').map((s) => s.trim()).includes(base.httpEtag)) return base; // sem body → 304
      const cabecalhoFaixa = opcoes.range instanceof Headers ? opcoes.range.get('range') : null;
      const range = cabecalhoFaixa ? lerFaixa(cabecalhoFaixa, o.bytes.length) : undefined;
      let parte = o.bytes;
      if (range) {
        if (range.suffix !== undefined) parte = o.bytes.slice(Math.max(0, o.bytes.length - range.suffix));
        else parte = o.bytes.slice(range.offset, range.length !== undefined ? range.offset + range.length : undefined);
      }
      return {
        ...base,
        range,
        body: new Blob([parte]).stream(),
        text: async () => new TextDecoder().decode(o.bytes),
      };
    },
    async delete(chave) {
      objetos.delete(chave);
    },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const chaves = [...objetos.keys()].filter((k) => k.startsWith(prefix)).sort();
      const inicio = cursor ? Number(cursor) : 0;
      const pagina = chaves.slice(inicio, inicio + limit);
      const truncated = inicio + limit < chaves.length;
      return {
        objects: pagina.map((k) => metadados(k, objetos.get(k))),
        truncated,
        cursor: truncated ? String(inicio + limit) : undefined,
      };
    },
  };
}
