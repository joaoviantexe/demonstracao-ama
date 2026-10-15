// GET / (rewrite do vercel.json) — home renderizada no servidor (docs/ARQUITETURA.md §5.1).
// Lê templates/home.html, aplica o conteúdo de conteudo_site e devolve o HTML.
// Sem Supabase (ou se ele falhar) devolve o template puro: o site nunca cai por causa do CMS.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseHTML } from 'linkedom';
import { aplicarConteudo } from '../public/js/cms/aplicar.js';
import { obterAmbiente } from '../lib/ambiente.js';
import { exigirMetodo, lerQuery, tratarErro } from '../lib/http.js';
import { selecionarPublico } from '../lib/supabase.js';

const CACHE_PUBLICO = 'public, s-maxage=15, stale-while-revalidate=600';
const TIMEOUT_CMS_MS = 2500;

// Template em memória do módulo (uma leitura por instância da função), por caminho.
const templates = new Map();

function lerTemplate() {
  const arquivo = path.join(process.cwd(), 'templates', 'home.html');
  if (!templates.has(arquivo)) {
    const leitura = readFile(arquivo, 'utf8');
    templates.set(arquivo, leitura);
    leitura.catch(() => templates.delete(arquivo));
  }
  return templates.get(arquivo);
}

async function buscarConteudo() {
  const linhas = await selecionarPublico('conteudo_site', 'select=chave,valor', { timeoutMs: TIMEOUT_CMS_MS });
  const conteudo = {};
  for (const linha of linhas) {
    if (linha && typeof linha.chave === 'string') conteudo[linha.chave] = linha.valor;
  }
  return conteudo;
}

// Mantém a declaração <!doctype> exatamente como no template (o linkedom escreve "<!DOCTYPE html>").
function comDoctype(html, template) {
  const original = (String(template).match(/^\s*(<!doctype[^>]*>)/i) || [])[1] || '<!doctype html>';
  const gerado = html.match(/^\s*<!doctype[^>]*>/i);
  return gerado ? original + html.slice(gerado[0].length) : `${original}\n${html}`;
}

/** Aplica o conteúdo ao template com o linkedom e devolve o HTML serializado. */
export function renderizarHome(template, conteudo) {
  const { document } = parseHTML(template);
  aplicarConteudo(document, conteudo);
  return comDoctype(document.toString(), template);
}

/**
 * WhatsApp e Facebook só mostram a imagem do link com endereço completo:
 * transforma o og:image que começa com "/" em <SITE_URL>/... (siteUrl já é uma origem normalizada).
 */
export function ogImagemAbsoluta(html, siteUrl) {
  if (!siteUrl) return html;
  return html.replace(/<meta\b[^>]*>/gi, (tag) => {
    if (!/\bproperty\s*=\s*["']og:image["']/i.test(tag)) return tag;
    return tag.replace(/(\bcontent\s*=\s*["'])\/(?![\/\\])/i, (_, inicio) => `${inicio}${siteUrl}/`);
  });
}

function enviarHtml(req, res, html, cabecalhos) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  for (const [nome, valor] of Object.entries(cabecalhos)) res.setHeader(nome, valor);
  const corpo = Buffer.from(html, 'utf8');
  res.setHeader('Content-Length', String(corpo.length));
  if (String(req.method).toUpperCase() === 'HEAD') res.end();
  else res.end(corpo);
}

export default async function handler(req, res) {
  try {
    if (!exigirMetodo(req, res, ['GET'])) return;
    const template = await lerTemplate();

    // O painel usa o template cru para montar o formulário do CMS.
    if (lerQuery(req).modelo === '1') {
      enviarHtml(req, res, template, { 'Cache-Control': 'no-store' });
      return;
    }

    let html = template;
    let origem = 'padrao';
    if (obterAmbiente().supabasePublicoConfigurado) {
      try {
        const conteudo = await buscarConteudo();
        html = renderizarHome(template, conteudo);
        origem = 'banco';
      } catch (erro) {
        console.warn('[render] usando o conteúdo padrão:', erro && (erro.codigo || erro.message || erro));
        html = template;
        origem = 'padrao';
      }
    }

    html = ogImagemAbsoluta(html, obterAmbiente().siteUrl);
    enviarHtml(req, res, html, { 'Cache-Control': CACHE_PUBLICO, 'X-AMA-CMS': origem });
  } catch (erro) {
    tratarErro(res, erro);
  }
}
