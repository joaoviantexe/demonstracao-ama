// Executa um handler de api/ (estilo Node: handler(req, res)) dentro do Worker do Cloudflare.
// req: { method, url, headers (minúsculas), query, body/corpoBruto (bytes, fora de GET/HEAD) }.
// res: statusCode, setHeader/getHeader, write/end, headersSent/writableEnded — o que lib/http.js usa.

const codificador = new TextEncoder();

function bytesDe(parte) {
  if (parte === undefined || parte === null) return null;
  if (typeof parte === 'string') return codificador.encode(parte);
  if (parte instanceof Uint8Array) return parte;
  if (parte instanceof ArrayBuffer) return new Uint8Array(parte);
  return codificador.encode(String(parte));
}

function juntar(partes) {
  const total = partes.reduce((soma, p) => soma + p.length, 0);
  const saida = new Uint8Array(total);
  let posicao = 0;
  for (const p of partes) {
    saida.set(p, posicao);
    posicao += p.length;
  }
  return saida;
}

/** Resposta no formato que os handlers esperam; paraResponse() vira um Response do Worker. */
export class RespostaWorker {
  constructor() {
    this.statusCode = 200;
    this.headersSent = false;
    this.writableEnded = false;
    this.cabecalhos = new Map();
    this.partes = [];
  }

  setHeader(nome, valor) {
    this.cabecalhos.set(String(nome).toLowerCase(), [String(nome), valor]);
    return this;
  }

  getHeader(nome) {
    const par = this.cabecalhos.get(String(nome).toLowerCase());
    return par ? par[1] : undefined;
  }

  hasHeader(nome) {
    return this.cabecalhos.has(String(nome).toLowerCase());
  }

  removeHeader(nome) {
    this.cabecalhos.delete(String(nome).toLowerCase());
  }

  getHeaders() {
    return Object.fromEntries([...this.cabecalhos].map(([chave, [, valor]]) => [chave, valor]));
  }

  write(parte) {
    if (this.writableEnded) return false;
    this.headersSent = true;
    const bytes = bytesDe(parte);
    if (bytes) this.partes.push(bytes);
    return true;
  }

  end(parte) {
    if (this.writableEnded) return this;
    if (typeof parte !== 'function') {
      const bytes = bytesDe(parte);
      if (bytes) this.partes.push(bytes);
    }
    this.headersSent = true;
    this.writableEnded = true;
    return this;
  }

  paraResponse(metodo = 'GET') {
    const headers = new Headers();
    for (const [chave, [nome, valor]] of this.cabecalhos) {
      if (chave === 'content-length' || valor === undefined || valor === null) continue; // o Worker calcula
      if (Array.isArray(valor)) for (const v of valor) headers.append(nome, String(v));
      else headers.set(nome, String(valor));
    }
    const semCorpo = metodo === 'HEAD' || [101, 204, 205, 304].includes(this.statusCode);
    return new Response(semCorpo ? null : juntar(this.partes), { status: this.statusCode, headers });
  }
}

function erroInterno() {
  return new Response(JSON.stringify({ ok: false, erro: 'erro_interno', mensagem: 'Erro interno. Tente novamente em instantes.' }), {
    status: 500,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Monta o req no formato dos handlers a partir do Request do Worker. */
export async function requisicaoDoHandler(request) {
  const url = new URL(request.url);
  const metodo = request.method.toUpperCase();
  const headers = {};
  for (const [nome, valor] of request.headers) headers[nome] = valor;
  // O endereço vem da própria requisição (não do que o cliente mandar nesses cabeçalhos).
  headers['x-forwarded-proto'] = url.protocol.replace(/:$/, '');
  headers['x-forwarded-host'] = url.host;
  const query = {};
  for (const [chave, valor] of url.searchParams) {
    if (chave === '__proto__' || chave === 'constructor' || chave === 'prototype') continue;
    query[chave] = Object.hasOwn(query, chave) ? [].concat(query[chave], valor) : valor;
  }
  const req = { method: metodo, url: url.pathname + url.search, headers, query };
  if (metodo !== 'GET' && metodo !== 'HEAD') {
    const bytes = new Uint8Array(await request.arrayBuffer());
    const corpo = typeof Buffer === 'function' ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes;
    req.corpoBruto = corpo;
    req.body = corpo;
  }
  return req;
}

/** Roda handler(req, res) e devolve o Response. Erro não tratado (ou nenhuma resposta) → 500. */
export async function executarHandler(handler, request) {
  const req = await requisicaoDoHandler(request);
  const res = new RespostaWorker();
  try {
    await handler(req, res);
  } catch (erro) {
    console.error('[worker] erro não tratado:', erro);
    if (!res.writableEnded) return erroInterno();
  }
  if (!res.writableEnded) {
    console.error('[worker] a função terminou sem responder:', req.method, req.url);
    return erroInterno();
  }
  return res.paraResponse(req.method);
}
