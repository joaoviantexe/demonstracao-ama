// Utilitários HTTP dos handlers (docs/ARQUITETURA.md §6 e §6.0).
// Funcionam na Vercel (req.body e req.query prontos) e no servidor local (stream puro).
// Os handlers usam só APIs nativas de `res`: statusCode, setHeader, end.

import { obterAmbiente } from './ambiente.js';

export const LIMITE_CORPO_PADRAO = 100_000;

const MENSAGENS_PADRAO = {
  400: 'Dados inválidos.',
  401: 'É preciso entrar para continuar.',
  403: 'Você não tem permissão para isso.',
  404: 'Não encontrado.',
  405: 'Método não permitido.',
  409: 'Conflito com o estado atual.',
  413: 'Os dados enviados são grandes demais.',
  415: 'Tipo de conteúdo não suportado.',
  500: 'Erro interno. Tente novamente em instantes.',
  502: 'Falha ao falar com um serviço externo. Tente novamente em instantes.',
  503: 'Serviço indisponível no momento.',
};

/** Erro que vira resposta { ok:false, erro, mensagem, ...extra } com o status indicado. */
export class ErroHttp extends Error {
  /**
   * @param {number} status   status HTTP (ex.: 400)
   * @param {string} erro     código curto (ex.: 'json_invalido')
   * @param {string} [mensagem] texto para o cliente
   * @param {object} [extra]  campos adicionais no JSON de resposta
   */
  constructor(status, erro, mensagem, extra) {
    const texto = mensagem || MENSAGENS_PADRAO[status] || 'Erro.';
    super(texto);
    this.name = 'ErroHttp';
    this.status = status;
    this.erro = erro;
    this.mensagem = texto;
    this.extra = extra && typeof extra === 'object' ? extra : {};
  }
}

const ehErroHttp = (erro) => erro instanceof ErroHttp
  || (erro && erro.name === 'ErroHttp' && Number.isInteger(erro.status) && typeof erro.erro === 'string');

function cabecalho(req, nome) {
  const valor = req && req.headers ? req.headers[nome] : undefined;
  return Array.isArray(valor) ? valor[0] : valor;
}

const ehObjetoSimples = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !Buffer.isBuffer(v);

function interpretarJson(texto) {
  const limpo = String(texto).replace(/^\ufeff/, '');
  if (limpo.trim() === '') return {};
  let valor;
  try {
    valor = JSON.parse(limpo);
  } catch {
    throw new ErroHttp(400, 'json_invalido', 'Os dados enviados não são um JSON válido.');
  }
  if (!ehObjetoSimples(valor)) {
    throw new ErroHttp(400, 'json_invalido', 'Os dados enviados devem ser um objeto JSON.');
  }
  return valor;
}

const erroTamanho = () => new ErroHttp(413, 'corpo_muito_grande', MENSAGENS_PADRAO[413]);

// Lê o stream da requisição (servidor local sem req.body) respeitando o limite.
// Ao estourar, rejeita na hora e continua drenando o resto em silêncio para a resposta 413 sair.
function lerStream(req, limiteBytes) {
  return new Promise((resolve, reject) => {
    if (req.readableEnded || typeof req.on !== 'function') {
      resolve(Buffer.alloc(0));
      return;
    }
    const partes = [];
    let total = 0;
    let estourou = false;
    req.on('data', (parte) => {
      if (estourou) return;
      const buffer = typeof parte === 'string' ? Buffer.from(parte) : parte;
      total += buffer.length;
      if (total > limiteBytes) {
        estourou = true;
        partes.length = 0;
        reject(erroTamanho());
        return;
      }
      partes.push(buffer);
    });
    req.on('end', () => {
      if (!estourou) resolve(Buffer.concat(partes));
    });
    req.on('error', () => {
      if (!estourou) reject(new ErroHttp(400, 'corpo_invalido', 'Não foi possível ler os dados enviados.'));
    });
  });
}

/**
 * Lê o corpo JSON da requisição. Devolve sempre um objeto simples ({} quando vazio).
 * Lança ErroHttp 400 (JSON inválido ou que não é objeto) ou 413 (acima de limiteBytes).
 * Na Vercel, ler req.body com JSON inválido lança exceção: aqui ela vira 400.
 */
export async function lerCorpo(req, { limiteBytes = LIMITE_CORPO_PADRAO } = {}) {
  const tamanhoDeclarado = Number(cabecalho(req, 'content-length'));
  if (Number.isFinite(tamanhoDeclarado) && tamanhoDeclarado > limiteBytes) throw erroTamanho();

  // Vercel (ou servidor que a imita): req.body já existe, possivelmente como getter preguiçoso.
  if (req && 'body' in req) {
    let corpo;
    try {
      corpo = req.body;
    } catch {
      throw new ErroHttp(400, 'json_invalido', 'Os dados enviados não são um JSON válido.');
    }
    if (corpo === undefined || corpo === null) {
      // undefined: tipo de conteúdo que a Vercel não interpreta (ex.: multipart/form-data).
      const tipo = String(cabecalho(req, 'content-type') || '');
      if (corpo === undefined && tipo && !/json|text\/plain/i.test(tipo)) {
        throw new ErroHttp(400, 'json_invalido', 'Envie os dados em JSON.');
      }
      return {};
    }
    if (Buffer.isBuffer(corpo) || corpo instanceof Uint8Array) {
      if (corpo.length > limiteBytes) throw erroTamanho();
      return interpretarJson(Buffer.from(corpo).toString('utf8'));
    }
    if (typeof corpo === 'string') {
      if (Buffer.byteLength(corpo) > limiteBytes) throw erroTamanho();
      return interpretarJson(corpo);
    }
    if (ehObjetoSimples(corpo)) {
      // Já interpretado (JSON ou formulário). Sem Content-Length (envio "chunked"), mede pelo JSON.
      if (!Number.isFinite(tamanhoDeclarado)) {
        let medida = 0;
        try {
          medida = Buffer.byteLength(JSON.stringify(corpo));
        } catch {
          throw new ErroHttp(400, 'json_invalido', 'Os dados enviados devem ser um objeto JSON.');
        }
        if (medida > limiteBytes) throw erroTamanho();
      }
      return { ...corpo };
    }
    throw new ErroHttp(400, 'json_invalido', 'Os dados enviados devem ser um objeto JSON.');
  }

  // Servidor Node puro: lê o stream.
  const bruto = await lerStream(req, limiteBytes);
  return interpretarJson(bruto.toString('utf8'));
}

/**
 * Parâmetros da URL como objeto simples { nome: 'valor' }.
 * Usa req.query quando existe (Vercel); senão interpreta req.url.
 * Parâmetro repetido (?a=1&a=2): fica o ÚLTIMO valor, sempre string.
 */
export function lerQuery(req) {
  const resultado = {};
  const definir = (chave, valor) => {
    if (chave === '__proto__' || chave === 'constructor' || chave === 'prototype') return;
    resultado[chave] = valor;
  };

  let query;
  try {
    query = req ? req.query : undefined;
  } catch {
    query = undefined;
  }
  if (query && typeof query === 'object') {
    for (const [chave, valor] of Object.entries(query)) {
      const ultimo = Array.isArray(valor) ? valor[valor.length - 1] : valor;
      if (ultimo === undefined || ultimo === null) continue;
      definir(chave, String(ultimo));
    }
    return resultado;
  }

  let url;
  try {
    url = new URL(String((req && req.url) || '/'), 'http://localhost');
  } catch {
    return resultado;
  }
  for (const [chave, valor] of url.searchParams) definir(chave, valor);
  return resultado;
}

/** Responde JSON com Content-Type application/json; charset=utf-8. */
export function responderJson(res, status, objeto, cabecalhos = {}) {
  const corpo = JSON.stringify(objeto === undefined ? null : objeto);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [nome, valor] of Object.entries(cabecalhos || {})) {
    if (valor !== undefined && valor !== null) res.setHeader(nome, valor);
  }
  res.end(corpo);
}

/** Responde { ok:false, erro, mensagem, ...extra }. */
export function responderErro(res, status, erro, mensagem, extra = {}) {
  const { ok: _ok, erro: _erro, mensagem: _mensagem, ...resto } = extra || {};
  responderJson(res, status, {
    ok: false,
    erro,
    mensagem: mensagem || MENSAGENS_PADRAO[status] || 'Erro.',
    ...resto,
  });
}

/**
 * true se req.method está em `metodos`; senão responde 405 (com Allow) e devolve false.
 * HEAD é aceito sempre que GET for aceito.
 */
export function exigirMetodo(req, res, metodos) {
  const lista = (Array.isArray(metodos) ? metodos : [metodos]).map((m) => String(m).toUpperCase());
  if (lista.includes('GET') && !lista.includes('HEAD')) lista.push('HEAD');
  const metodo = String((req && req.method) || 'GET').toUpperCase();
  if (lista.includes(metodo)) return true;
  res.setHeader('Allow', lista.join(', '));
  responderErro(res, 405, 'metodo_nao_permitido', MENSAGENS_PADRAO[405]);
  return false;
}

const HOST_VALIDO = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/i;

/** SITE_URL (ou https://VERCEL_PROJECT_PRODUCTION_URL); senão protocolo + host da requisição. Sem barra final. */
export function urlBase(req) {
  const { siteUrl } = obterAmbiente();
  if (siteUrl) return siteUrl;

  const primeiro = (valor) => String(valor || '').split(',')[0].trim();
  let protocolo = primeiro(cabecalho(req, 'x-forwarded-proto')).toLowerCase();
  if (protocolo !== 'http' && protocolo !== 'https') {
    protocolo = req && req.socket && req.socket.encrypted ? 'https' : 'http';
  }
  let host = primeiro(cabecalho(req, 'x-forwarded-host')) || primeiro(cabecalho(req, 'host'));
  if (!HOST_VALIDO.test(host)) host = 'localhost';
  return `${protocolo}://${host}`;
}

/** ErroHttp → resposta correspondente; qualquer outro erro → 500 { ok:false, erro:'erro_interno' } (e loga). */
export function tratarErro(res, erro) {
  if (ehErroHttp(erro)) {
    if (res.headersSent || res.writableEnded) return;
    responderErro(res, erro.status, erro.erro, erro.mensagem, erro.extra);
    return;
  }
  console.error('[api] erro inesperado:', erro);
  if (res.headersSent || res.writableEnded) {
    if (!res.writableEnded) res.end();
    return;
  }
  responderErro(res, 500, 'erro_interno', MENSAGENS_PADRAO[500]);
}
