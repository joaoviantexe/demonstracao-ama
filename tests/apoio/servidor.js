// Apoio para testar handlers e o servidor local (scripts/dev-server.mjs).
// - subirServidor(env): aplica variáveis de ambiente e sobe o dev-server numa porta livre.
// - requisicaoFalsa / respostaFalsa: req/res mínimos para chamar um handler direto.
// - simularFetch(rotas): troca globalThis.fetch por uma função que registra as chamadas.

import { Readable } from 'node:stream';
import { iniciarServidor } from '../../scripts/dev-server.mjs';

/**
 * Aplica `env` em process.env (undefined/null apaga a variável) e devolve uma função que restaura.
 */
export function aplicarAmbiente(env = {}) {
  const anteriores = {};
  for (const [nome, valor] of Object.entries(env)) {
    anteriores[nome] = Object.hasOwn(process.env, nome) ? process.env[nome] : undefined;
    if (valor === undefined || valor === null) delete process.env[nome];
    else process.env[nome] = String(valor);
  }
  return () => {
    for (const [nome, valor] of Object.entries(anteriores)) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
  };
}

/** Todas as variáveis da §3 (e aliases) apagadas: ponto de partida para testes sem integrações. */
export const AMBIENTE_VAZIO = Object.freeze({
  SUPABASE_URL: undefined,
  NEXT_PUBLIC_SUPABASE_URL: undefined,
  SUPABASE_ANON_KEY: undefined,
  SUPABASE_PUBLISHABLE_KEY: undefined,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: undefined,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: undefined,
  SUPABASE_SERVICE_ROLE_KEY: undefined,
  SUPABASE_SECRET_KEY: undefined,
  SITE_URL: undefined,
  VERCEL_PROJECT_PRODUCTION_URL: undefined,
  MP_ACCESS_TOKEN: undefined,
  MP_WEBHOOK_SECRET: undefined,
  MP_PUBLIC_KEY: undefined,
  MELHOR_ENVIO_TOKEN: undefined,
  MELHOR_ENVIO_AMBIENTE: undefined,
  MELHOR_ENVIO_EMAIL: undefined,
  RESEND_API_KEY: undefined,
  CRON_SECRET: undefined,
  EMAIL_REMETENTE: undefined,
  MP_API_BASE: undefined,
  MELHOR_ENVIO_API_BASE: undefined,
  RESEND_API_BASE: undefined,
});

/**
 * Sobe o dev-server em 127.0.0.1, porta aleatória, com as variáveis de `env` aplicadas.
 * `opcoes` vai para iniciarServidor (ex.: { dirApi }). fechar() derruba o servidor e restaura o ambiente.
 * @returns {Promise<{ url: string, fechar: () => Promise<void> }>}
 */
export async function subirServidor(env = {}, opcoes = {}) {
  const restaurar = aplicarAmbiente(env);
  let servidor;
  try {
    servidor = await iniciarServidor({ ...opcoes, porta: 0, host: '127.0.0.1' });
  } catch (erro) {
    restaurar();
    throw erro;
  }
  return {
    url: servidor.url,
    async fechar() {
      await servidor.fechar();
      restaurar();
    },
  };
}

/**
 * Requisição mínima para chamar um handler direto.
 * - estilo 'vercel' (padrão): req.query e req.body prontos; `corpoLanca: true` imita o req.body
 *   da Vercel com JSON inválido (getter que lança).
 * - estilo 'stream': um Readable com o corpo bruto (servidor Node puro, sem req.body).
 */
export function requisicaoFalsa({
  method = 'GET', url = '/', headers = {}, query, body, corpoBruto, corpoLanca = false, estilo = 'vercel',
} = {}) {
  const cabecalhos = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (estilo === 'stream') {
    const partes = corpoBruto === undefined ? [] : [Buffer.from(corpoBruto)];
    const req = Readable.from(partes);
    Object.assign(req, { method, url, headers: cabecalhos });
    return req;
  }
  const req = { method, url, headers: cabecalhos };
  if (query !== undefined) req.query = query;
  if (corpoLanca) {
    Object.defineProperty(req, 'body', {
      enumerable: true,
      get() { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); },
    });
  } else if (body !== undefined) {
    req.body = body;
  }
  return req;
}

/**
 * Resposta mínima compatível com o que os handlers usam (statusCode, setHeader, getHeader, end).
 * Depois de `await res.terminou`: res.statusCode, res.cabecalhos (nomes em minúsculas), res.corpo
 * (string) e res.json().
 */
export function respostaFalsa() {
  const cabecalhos = {};
  let resolver;
  const terminou = new Promise((r) => { resolver = r; });
  const partes = [];
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    cabecalhos,
    corpo: '',
    terminou,
    setHeader(nome, valor) {
      cabecalhos[String(nome).toLowerCase()] = valor;
      return res;
    },
    getHeader(nome) {
      return cabecalhos[String(nome).toLowerCase()];
    },
    hasHeader(nome) {
      return Object.hasOwn(cabecalhos, String(nome).toLowerCase());
    },
    removeHeader(nome) {
      delete cabecalhos[String(nome).toLowerCase()];
    },
    getHeaders() {
      return { ...cabecalhos };
    },
    write(parte) {
      res.headersSent = true;
      if (parte !== undefined && parte !== null) partes.push(Buffer.from(parte));
      return true;
    },
    end(parte) {
      if (parte !== undefined && parte !== null && typeof parte !== 'function') partes.push(Buffer.from(parte));
      res.headersSent = true;
      res.writableEnded = true;
      res.corpo = Buffer.concat(partes).toString('utf8');
      resolver(res);
      return res;
    },
    json() {
      return JSON.parse(res.corpo);
    },
  };
  return res;
}

/** Chama um handler com req/res falsos e devolve a resposta já terminada. */
export async function chamarHandler(handler, opcoesReq = {}) {
  const req = requisicaoFalsa(opcoesReq);
  const res = respostaFalsa();
  await handler(req, res);
  if (!res.writableEnded) await Promise.race([res.terminou, new Promise((r) => setTimeout(r, 2000))]);
  return res;
}

/**
 * Troca globalThis.fetch por um simulador. `responder(url, init, chamada)` devolve um Response
 * (ou lança, ou devolve uma Promise que só termina no abort). Devolve { chamadas, restaurar }.
 * Cada chamada registra { url, metodo, cabecalhos (minúsculas), corpo (texto), init }.
 */
export function simularFetch(responder) {
  const original = globalThis.fetch;
  const chamadas = [];
  globalThis.fetch = async (entrada, init = {}) => {
    const url = typeof entrada === 'string' ? entrada : entrada.url;
    const cabecalhos = {};
    for (const [nome, valor] of new Headers(init.headers || {})) cabecalhos[nome] = valor;
    const chamada = {
      url,
      metodo: String(init.method || 'GET').toUpperCase(),
      cabecalhos,
      corpo: typeof init.body === 'string' ? init.body : init.body === undefined ? undefined : String(init.body),
      init,
    };
    chamadas.push(chamada);
    return responder(url, init, chamada);
  };
  return {
    chamadas,
    restaurar() {
      globalThis.fetch = original;
    },
  };
}

/** Response JSON para usar com simularFetch. */
export function respostaJson(status, objeto, cabecalhos = {}) {
  return new Response(objeto === undefined ? null : JSON.stringify(objeto), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cabecalhos },
  });
}

/** Promise que nunca resolve sozinha: rejeita quando o signal da requisição é abortado. */
export function esperarAbort(init) {
  return new Promise((_, rejeitar) => {
    const sinal = init && init.signal;
    if (!sinal) return;
    if (sinal.aborted) rejeitar(new DOMException('Abortado', 'AbortError'));
    sinal.addEventListener('abort', () => rejeitar(new DOMException('Abortado', 'AbortError')));
  });
}
