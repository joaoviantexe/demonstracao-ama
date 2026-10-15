#!/usr/bin/env node
// Servidor local que imita a Vercel (docs/ARQUITETURA.md §2 e §2.1). Uso: npm run dev
//
// - Serve public/ como estático com cleanUrls (/loja/produto → public/loja/produto.html,
//   /admin/ → public/admin/index.html, /x.html → 308 para /x).
// - /api/<caminho> → importa api/<caminho>.js e chama o export default handler(req, res),
//   com req.query, req.cookies e req.body (getter que lança em JSON inválido, como na Vercel).
//   Os módulos de api/ são recarregados quando o arquivo muda (import com ?v=<hash do conteúdo>;
//   cada versão é importada uma vez, porque o cache de módulos ESM nunca libera memória).
// - Rewrite "/" → api/render (só porque não existe public/index.html, como na Vercel).
// - Aplica os "headers" do vercel.json.
// - Executado diretamente: carrega .env (sem sobrescrever o ambiente), PORT (padrão 3000) e HOST.

import http from 'node:http';
import { createReadStream, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import querystring from 'node:querystring';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const LIMITE_CORPO_VERCEL = 4.5 * 1024 * 1024;

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf',
};

/**
 * Carrega um arquivo .env simples (NOME=valor, # comentários, aspas opcionais, "export" opcional).
 * Não sobrescreve variáveis que já existem no ambiente. Devolve os nomes carregados.
 */
export function carregarEnv(arquivo = path.join(RAIZ, '.env')) {
  let texto;
  try {
    texto = readFileSync(arquivo, 'utf8');
  } catch {
    return [];
  }
  const carregadas = [];
  for (const linhaBruta of texto.split(/\r?\n/)) {
    const linha = linhaBruta.trim();
    if (!linha || linha.startsWith('#')) continue;
    const m = linha.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, nome, bruto] = m;
    let valor = bruto;
    if (/^"(?:[^"\\]|\\.)*"/.test(valor)) {
      valor = valor.match(/^"((?:[^"\\]|\\.)*)"/)[1].replace(/\\n/g, '\n').replace(/\\(["\\])/g, '$1');
    } else if (/^'[^']*'/.test(valor)) {
      valor = valor.match(/^'([^']*)'/)[1];
    } else {
      valor = valor.replace(/\s+#.*$/, '').trim();
    }
    if (process.env[nome] === undefined) {
      process.env[nome] = valor;
      carregadas.push(nome);
    }
  }
  return carregadas;
}

// "source" do vercel.json (path-to-regexp simplificado: grupos "(...)", ":nome", ":nome*") → RegExp.
export function fonteParaRegex(fonte) {
  let re = '';
  let i = 0;
  while (i < fonte.length) {
    const c = fonte[i];
    if (c === '(') {
      let profundidade = 0;
      let j = i;
      for (; j < fonte.length; j += 1) {
        if (fonte[j] === '(') profundidade += 1;
        else if (fonte[j] === ')' && --profundidade === 0) break;
      }
      re += fonte.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === ':') {
      const m = fonte.slice(i).match(/^:([A-Za-z_]\w*)([*+?])?/);
      if (m) {
        re += m[2] === '*' ? '(.*)' : '([^/]+)';
        i += m[0].length;
        continue;
      }
    }
    re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function lerRegrasCabecalhos(arquivoVercel) {
  try {
    const config = JSON.parse(readFileSync(arquivoVercel, 'utf8'));
    return (config.headers || []).map((regra) => ({
      regex: fonteParaRegex(regra.source),
      cabecalhos: (regra.headers || []).filter((h) => h && h.key),
    }));
  } catch {
    return [];
  }
}

function aplicarCabecalhos(res, caminho, regras) {
  for (const { regex, cabecalhos } of regras) {
    if (!regex.test(caminho)) continue;
    for (const { key, value } of cabecalhos) res.setHeader(key, value);
  }
}

// Redirecionamentos 308 do cleanUrls (mesmas expressões da Vercel).
function redirecionamentoCleanUrls(caminho) {
  let destino = null;
  const indice = caminho.match(/^\/(?:(.+)\/)?index(?:\.html)?\/?$/);
  if (indice) destino = `/${indice[1] || ''}`;
  else {
    const html = caminho.match(/^\/(.*)\.html\/?$/);
    if (html) destino = `/${html[1]}`;
  }
  if (destino === null) return null;
  // Evita redirecionar para outro domínio ("//exemplo.com").
  return destino.replace(/^[/\\]+/, '/');
}

function enviarTexto(res, status, texto, tipo = 'text/plain; charset=utf-8') {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.statusCode = status;
  res.setHeader('Content-Type', tipo);
  res.end(texto);
}

function enviarJson(res, status, objeto) {
  enviarTexto(res, status, JSON.stringify(objeto), 'application/json; charset=utf-8');
}

const dentroDe = (alvo, pasta) => alvo === pasta || alvo.startsWith(pasta + path.sep);

async function arquivoExistente(caminho) {
  try {
    const info = await stat(caminho);
    return info.isFile() ? { arquivo: caminho, tamanho: info.size } : null;
  } catch {
    return null;
  }
}

// Acha o arquivo estático (com cleanUrls). null = não existe; { proibido } = caminho suspeito.
async function acharEstatico(caminho, dirPublico) {
  const segmentos = caminho.split('/').filter(Boolean);
  for (const s of segmentos) {
    if (s === '.' || s === '..' || s.startsWith('.') || s.includes('\\') || s.includes('\0')) {
      return { proibido: true };
    }
  }
  const base = path.resolve(dirPublico, ...segmentos);
  if (!dentroDe(base, dirPublico)) return { proibido: true };
  const candidatos = caminho.endsWith('/')
    ? [path.join(base, 'index.html')]
    : [base, `${base}.html`, path.join(base, 'index.html')];
  for (const candidato of candidatos) {
    if (!dentroDe(candidato, dirPublico)) continue;
    const achado = await arquivoExistente(candidato);
    if (achado) return achado;
  }
  return null;
}

function servirArquivo(req, res, { arquivo, tamanho }, status = 200) {
  const metodo = String(req.method || 'GET').toUpperCase();
  if (metodo !== 'GET' && metodo !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    enviarTexto(res, 405, 'Método não permitido');
    return;
  }
  res.setHeader('Content-Type', TIPOS[path.extname(arquivo).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  res.setHeader('Accept-Ranges', 'bytes');

  let inicio = 0;
  let fim = tamanho - 1;
  res.statusCode = status;
  const faixa = status === 200 ? req.headers.range : undefined;
  if (faixa && tamanho > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(faixa).trim());
    if (m && (m[1] || m[2])) {
      if (m[1]) {
        inicio = Number(m[1]);
        fim = m[2] ? Math.min(Number(m[2]), tamanho - 1) : tamanho - 1;
      } else {
        inicio = Math.max(0, tamanho - Number(m[2]));
      }
      if (inicio > fim || inicio >= tamanho) {
        res.setHeader('Content-Range', `bytes */${tamanho}`);
        enviarTexto(res, 416, 'Faixa inválida');
        return;
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${inicio}-${fim}/${tamanho}`);
    }
  }
  res.setHeader('Content-Length', String(tamanho === 0 ? 0 : fim - inicio + 1));
  if (metodo === 'HEAD' || tamanho === 0) {
    res.end();
    return;
  }
  const leitura = createReadStream(arquivo, { start: inicio, end: fim });
  leitura.on('error', () => res.destroy());
  leitura.pipe(res);
}

async function responder404(req, res, opcoes) {
  const pagina = await arquivoExistente(path.join(opcoes.dirPublico, '404.html'));
  if (pagina && ['GET', 'HEAD'].includes(String(req.method).toUpperCase())) {
    servirArquivo(req, res, pagina, 404);
    return;
  }
  enviarTexto(res, 404, '<!doctype html><meta charset="utf-8"><title>404</title><p>Página não encontrada.</p>',
    'text/html; charset=utf-8');
}

// ---------------------------------------------------------------------------
// Funções (imitação dos helpers do @vercel/node)

function lerCorpoBruto(req, limite) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    let estourou = false;
    req.on('data', (parte) => {
      if (estourou) return;
      total += parte.length;
      if (total > limite) {
        estourou = true;
        partes.length = 0;
        reject(Object.assign(new Error('FUNCTION_PAYLOAD_TOO_LARGE'), { statusCode: 413 }));
        return;
      }
      partes.push(parte);
    });
    req.on('end', () => {
      if (!estourou) resolve(Buffer.concat(partes));
    });
    req.on('error', reject);
  });
}

// Mesmo comportamento do req.body da Vercel para cada Content-Type.
function interpretarCorpoVercel(tipoConteudo, bruto) {
  if (!tipoConteudo) return ''; // a Vercel nem lê o corpo sem Content-Type
  const tipo = String(tipoConteudo).split(';')[0].trim().toLowerCase();
  switch (tipo) {
    case 'application/json': {
      const texto = bruto.toString('utf8');
      if (!texto) return {};
      try {
        return JSON.parse(texto);
      } catch {
        throw Object.assign(new Error('Invalid JSON'), { statusCode: 400, name: 'ApiError' });
      }
    }
    case 'application/octet-stream':
      return bruto;
    case 'application/x-www-form-urlencoded':
      return querystring.parse(bruto.toString('utf8'));
    case 'text/plain':
      return bruto.toString('utf8');
    default:
      return undefined;
  }
}

function lerCookies(cabecalho) {
  const cookies = {};
  for (const parte of String(cabecalho || '').split(';')) {
    const pos = parte.indexOf('=');
    if (pos < 1) continue;
    const nome = parte.slice(0, pos).trim();
    if (!nome || nome === '__proto__') continue;
    let valor = parte.slice(pos + 1).trim();
    try { valor = decodeURIComponent(valor); } catch { /* mantém cru */ }
    cookies[nome] = valor;
  }
  return cookies;
}

function propriedadePreguicosa(objeto, nome, calcular) {
  Object.defineProperty(objeto, nome, {
    configurable: true,
    enumerable: true,
    get() {
      const valor = calcular(); // se lançar, lança de novo no próximo acesso (como a Vercel)
      Object.defineProperty(objeto, nome, { value: valor, writable: true, configurable: true, enumerable: true });
      return valor;
    },
    set(valor) {
      Object.defineProperty(objeto, nome, { value: valor, writable: true, configurable: true, enumerable: true });
    },
  });
}

function adicionarAjudantes(req, res, url, bruto) {
  propriedadePreguicosa(req, 'query', () => {
    const query = {};
    for (const [chave, valor] of url.searchParams) {
      if (chave === '__proto__') continue;
      if (Object.hasOwn(query, chave)) query[chave] = [].concat(query[chave], valor);
      else query[chave] = valor;
    }
    return query;
  });
  propriedadePreguicosa(req, 'cookies', () => lerCookies(req.headers.cookie));
  propriedadePreguicosa(req, 'body', () => interpretarCorpoVercel(req.headers['content-type'], bruto));

  res.status = (codigo) => {
    res.statusCode = codigo;
    return res;
  };
  res.send = (corpo) => {
    if (corpo !== null && typeof corpo === 'object' && !Buffer.isBuffer(corpo)) return res.json(corpo);
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', Buffer.isBuffer(corpo) ? 'application/octet-stream' : 'text/html; charset=utf-8');
    }
    res.end(corpo === undefined || corpo === null ? '' : corpo);
    return res;
  };
  res.json = (objeto) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(objeto));
    return res;
  };
  res.redirect = (statusOuUrl, destino) => {
    const [codigo, local] = typeof statusOuUrl === 'number' ? [statusOuUrl, destino] : [307, statusOuUrl];
    res.statusCode = codigo;
    res.setHeader('Location', local);
    res.end();
    return res;
  };
}

async function acharFuncao(rota, dirApi) {
  const segmentos = rota.split('/').filter(Boolean);
  if (!segmentos.length) return null;
  // Como na Vercel, arquivos/pastas que começam com "_" ou "." não são rotas.
  if (segmentos.some((s) => !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(s))) return null;
  const base = path.resolve(dirApi, ...segmentos);
  if (!dentroDe(base, dirApi)) return null;
  for (const candidato of [`${base}.js`, `${base}.mjs`, path.join(base, 'index.js'), path.join(base, 'index.mjs')]) {
    const achado = await arquivoExistente(candidato);
    if (achado) return achado.arquivo;
  }
  return null;
}

// arquivo → { versao, promessa } da última versão importada.
const modulosCarregados = new Map();

async function carregarModulo(arquivo, recarregar) {
  const href = pathToFileURL(arquivo).href;
  if (!recarregar) return import(href);
  // Hash do conteúdo, não o mtime: não depende da resolução do relógio do sistema de arquivos.
  const versao = createHash('sha1').update(await readFile(arquivo)).digest('hex').slice(0, 16);
  const atual = modulosCarregados.get(arquivo);
  if (atual && atual.versao === versao) return atual.promessa;
  // Uma falha (ex.: erro de sintaxe) fica guardada até o conteúdo mudar, como no cache ESM.
  const promessa = import(`${href}?v=${versao}`);
  modulosCarregados.set(arquivo, { versao, promessa });
  return promessa;
}

async function atenderFuncao(req, res, url, rota, opcoes) {
  const arquivo = await acharFuncao(rota, opcoes.dirApi);
  if (!arquivo) {
    enviarJson(res, 404, { ok: false, erro: 'nao_encontrado', mensagem: 'Rota não encontrada.' });
    return;
  }

  let bruto;
  try {
    bruto = await lerCorpoBruto(req, LIMITE_CORPO_VERCEL);
  } catch (erro) {
    if (erro && erro.statusCode === 413) {
      res.setHeader('Connection', 'close');
      enviarJson(res, 413, { ok: false, erro: 'corpo_muito_grande', mensagem: 'Os dados enviados são grandes demais.' });
    } else {
      enviarJson(res, 400, { ok: false, erro: 'corpo_invalido', mensagem: 'Não foi possível ler os dados enviados.' });
    }
    return;
  }
  adicionarAjudantes(req, res, url, bruto);

  let modulo;
  try {
    modulo = await carregarModulo(arquivo, opcoes.recarregar);
  } catch (erro) {
    console.error(`[dev-server] falha ao carregar ${path.relative(RAIZ, arquivo)}:`, erro);
    enviarJson(res, 500, { ok: false, erro: 'erro_interno', mensagem: 'Falha ao carregar a função.' });
    return;
  }
  const handler = modulo.default;
  if (typeof handler !== 'function') {
    enviarJson(res, 500, { ok: false, erro: 'erro_interno', mensagem: 'A função não exporta um handler padrão.' });
    return;
  }
  try {
    await handler(req, res);
  } catch (erro) {
    // Na Vercel isso vira FUNCTION_INVOCATION_FAILED (500).
    console.error(`[dev-server] erro não tratado em ${path.relative(RAIZ, arquivo)}:`, erro);
    if (!res.headersSent) {
      enviarJson(res, 500, { ok: false, erro: 'erro_interno', mensagem: 'Erro interno.' });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

async function atender(req, res, opcoes) {
  let url;
  let caminho;
  try {
    // Prefixa a origem em vez de usar "base": "//x.com/y" seria lido como outro host.
    const alvo = String(req.url || '/');
    url = new URL(alvo.startsWith('/') ? `http://localhost${alvo}` : alvo);
    caminho = decodeURIComponent(url.pathname);
  } catch {
    enviarTexto(res, 400, 'Requisição inválida');
    return;
  }
  if (caminho.includes('\0')) {
    enviarTexto(res, 400, 'Requisição inválida');
    return;
  }

  aplicarCabecalhos(res, caminho, opcoes.regras);

  const destino = redirecionamentoCleanUrls(url.pathname);
  if (destino !== null) {
    res.statusCode = 308;
    res.setHeader('Location', destino + url.search);
    res.end();
    return;
  }

  if (caminho === '/api' || caminho.startsWith('/api/')) {
    await atenderFuncao(req, res, url, caminho.slice('/api'.length), opcoes);
    return;
  }

  const estatico = await acharEstatico(caminho, opcoes.dirPublico);
  if (estatico && estatico.proibido) {
    await responder404(req, res, opcoes);
    return;
  }
  if (estatico) {
    servirArquivo(req, res, estatico);
    return;
  }

  // rewrites do vercel.json: "/" → /api/render (o filesystem vem antes, como na Vercel).
  if (caminho === '/') {
    await atenderFuncao(req, res, url, 'render', opcoes);
    return;
  }

  await responder404(req, res, opcoes);
}

/**
 * Sobe o servidor. Devolve { url, porta, servidor, fechar() }.
 * Opções extras (para testes): raiz, dirPublico, dirApi, recarregar (padrão true), log (padrão false).
 * O api/render.js lê o template de process.cwd(): rode a partir da raiz do repositório.
 */
export async function iniciarServidor({
  porta = 3000,
  host = '127.0.0.1',
  raiz = RAIZ,
  dirPublico,
  dirApi,
  recarregar = true,
  log = false,
} = {}) {
  const opcoes = {
    dirPublico: path.resolve(dirPublico || path.join(raiz, 'public')),
    dirApi: path.resolve(dirApi || path.join(raiz, 'api')),
    regras: lerRegrasCabecalhos(path.join(raiz, 'vercel.json')),
    recarregar,
  };

  const servidor = http.createServer((req, res) => {
    const inicio = Date.now();
    if (log) {
      res.on('finish', () => {
        console.log(`${req.method} ${req.url} → ${res.statusCode} (${Date.now() - inicio} ms)`);
      });
    }
    atender(req, res, opcoes).catch((erro) => {
      console.error('[dev-server] erro inesperado:', erro);
      enviarTexto(res, 500, 'Erro interno');
    });
  });

  await new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(porta, host, () => {
      servidor.off('error', reject);
      resolve();
    });
  });

  const endereco = servidor.address();
  const hostUrl = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${hostUrl}:${endereco.port}`,
    porta: endereco.port,
    servidor,
    fechar: () => new Promise((resolve) => {
      servidor.close(() => resolve());
      servidor.closeAllConnections();
    }),
  };
}

const executadoDiretamente = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (executadoDiretamente) {
  process.chdir(RAIZ);
  const carregadas = carregarEnv(path.join(RAIZ, '.env'));
  const porta = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  const { url } = await iniciarServidor({ porta, host, log: true });
  const { obterAmbiente } = await import('../lib/ambiente.js');
  const ambiente = obterAmbiente();
  console.log(`Servidor da AMA em ${url}`);
  if (carregadas.length) console.log(`.env: ${carregadas.length} variável(is) carregada(s)`);
  console.log(`Supabase: ${ambiente.supabaseConfigurado ? 'configurado' : ambiente.supabasePublicoConfigurado ? 'só chave pública' : 'não configurado (home com conteúdo padrão)'}`
    + (ambiente.supabaseAnonKeyRecusada ? ' · ATENÇÃO: a chave pública era secreta e foi ignorada' : ''));
  console.log(`Mercado Pago: ${ambiente.mercadoPagoConfigurado ? 'configurado' : 'não configurado'}`
    + ` · Melhor Envio: ${ambiente.melhorEnvioConfigurado ? ambiente.melhorEnvioAmbiente : 'não configurado'}`
    + ` · E-mail: ${ambiente.emailConfigurado ? 'configurado' : 'não configurado'}`);
}
