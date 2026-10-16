// /api/admin/midia — fotos e vídeos do site no armazenamento (bucket R2 em produção; docs/ARQUITETURA.md §4.4).
// GET    ?pasta=site|produtos|videos (sem pasta: todas) → { ok, arquivos: [{ nome, caminho, pasta, url, tamanho, tipo, categoria, criado_em }] }
// POST   ?caminho=<pasta>/<aaaa-mm>/<nome>.<ext>, corpo = bytes do arquivo, Content-Type do arquivo
//        → { ok, url, caminho, tamanho, tipo }. 409 'duplicado' se o caminho já existe (o painel gera outro nome).
// DELETE ?caminho=... → { ok }. 404 se não existe.
// A URL pública é /midia/<caminho> (servida pelo Worker, worker/midia.js; no servidor local, pela pasta).

import { exigirAdmin } from '../../lib/admin.js';
import {
  caminhoDeMidiaValido, obterArmazenamento, PASTAS_MIDIA, tipoPelaExtensao,
} from '../../lib/armazenamento.js';
import { ErroHttp, exigirMetodo, lerCorpoBinario, lerQuery, responderJson, tratarErro } from '../../lib/http.js';
import { CABECALHOS_SEM_CACHE } from '../../lib/loja.js';

/** Limite de cada arquivo (o painel avisa antes de enviar). */
export const LIMITE_ARQUIVO_BYTES = 50 * 1024 * 1024;

/** Tipos aceitos (SVG fica de fora: pode carregar script). */
export const TIPOS_MIDIA = Object.freeze({
  'image/jpeg': 'imagem', 'image/png': 'imagem', 'image/webp': 'imagem', 'image/gif': 'imagem', 'image/avif': 'imagem',
  'video/mp4': 'video', 'video/webm': 'video',
});

/** URL pública de um caminho do bucket. */
export const urlDaMidia = (caminho) => `/midia/${caminho.split('/').map(encodeURIComponent).join('/')}`;

function cabecalho(req, nome) {
  const valor = req.headers ? req.headers[nome] : undefined;
  return Array.isArray(valor) ? valor[0] : valor;
}

function caminhoDaQuery(req) {
  const caminho = caminhoDeMidiaValido(lerQuery(req).caminho);
  if (!caminho) throw new ErroHttp(400, 'caminho_invalido', 'Caminho de arquivo inválido.', { campo: 'caminho' });
  return caminho;
}

function itemDaLista({ chave, tamanho, tipo, criado_em: criadoEm }) {
  const tipoFinal = tipo || tipoPelaExtensao(chave);
  return {
    nome: chave.split('/').pop(),
    caminho: chave,
    pasta: chave.split('/')[0],
    url: urlDaMidia(chave),
    tamanho: Number(tamanho) || 0,
    tipo: tipoFinal,
    categoria: TIPOS_MIDIA[tipoFinal.split(';')[0].trim()] || null,
    criado_em: criadoEm || null,
  };
}

async function listar(req, res, armazenamento) {
  const pasta = lerQuery(req).pasta;
  if (pasta && !PASTAS_MIDIA.includes(pasta)) throw new ErroHttp(400, 'pasta_invalida', 'Pasta inválida.', { campo: 'pasta' });
  const pastas = pasta ? [pasta] : [...PASTAS_MIDIA];
  const listas = await Promise.all(pastas.map((p) => armazenamento.listar(`${p}/`)));
  const arquivos = listas.flat()
    .filter((o) => caminhoDeMidiaValido(o.chave))
    .map(itemDaLista)
    .sort((a, b) => String(b.criado_em || b.caminho).localeCompare(String(a.criado_em || a.caminho)));
  responderJson(res, 200, { ok: true, arquivos }, CABECALHOS_SEM_CACHE);
}

async function enviar(req, res, armazenamento) {
  const caminho = caminhoDaQuery(req);
  const tipo = String(cabecalho(req, 'content-type') || '').split(';')[0].trim().toLowerCase();
  const categoria = TIPOS_MIDIA[tipo];
  if (!categoria) throw new ErroHttp(415, 'tipo_nao_aceito', 'Tipo de arquivo não aceito. Envie JPG, PNG, WebP, GIF, AVIF, MP4 ou WebM.');
  // A extensão do nome tem que ser do mesmo tipo (a URL pública é servida com o tipo gravado).
  if (TIPOS_MIDIA[tipoPelaExtensao(caminho)] !== categoria) {
    throw new ErroHttp(400, 'extensao_invalida', 'A extensão do arquivo não combina com o tipo.', { campo: 'caminho' });
  }
  const bytes = await lerCorpoBinario(req, { limiteBytes: LIMITE_ARQUIVO_BYTES });
  if (!bytes.length) throw new ErroHttp(400, 'arquivo_vazio', 'O arquivo está vazio.');
  if (await armazenamento.existe(caminho)) throw new ErroHttp(409, 'duplicado', 'Já existe um arquivo com esse nome.');
  await armazenamento.gravar(caminho, bytes, { tipo });
  responderJson(res, 200, { ok: true, url: urlDaMidia(caminho), caminho, tamanho: bytes.length, tipo }, CABECALHOS_SEM_CACHE);
}

async function apagar(req, res, armazenamento) {
  const caminho = caminhoDaQuery(req);
  if (!(await armazenamento.apagar(caminho))) throw new ErroHttp(404, 'nao_encontrado', 'Arquivo não encontrado.');
  responderJson(res, 200, { ok: true }, CABECALHOS_SEM_CACHE);
}

export default async function handler(req, res) {
  if (!exigirMetodo(req, res, ['GET', 'POST', 'DELETE'])) return;
  const admin = await exigirAdmin(req, res);
  if (!admin) return;
  try {
    const armazenamento = obterArmazenamento();
    const metodo = String(req.method).toUpperCase();
    if (metodo === 'POST') await enviar(req, res, armazenamento);
    else if (metodo === 'DELETE') await apagar(req, res, armazenamento);
    else await listar(req, res, armazenamento);
  } catch (erro) {
    tratarErro(res, erro);
  }
}
