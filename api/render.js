// GET / — home do site (docs/ARQUITETURA.md §5.1).
// Entrega a home publicada pelo painel (lib/home.js); sem ela, ou se o armazenamento falhar, o template
// com o conteúdo padrão: o site nunca cai por causa do CMS. ?modelo=1 devolve o template cru (o painel
// monta os formulários e a home publicada a partir dele).

import { armazenamentoConfigurado, CHAVE_HOME, obterArmazenamento } from '../lib/armazenamento.js';
import { obterAmbiente } from '../lib/ambiente.js';
import { lerTemplateHome, ogImagemAbsoluta } from '../lib/home.js';
import { exigirMetodo, lerQuery, tratarErro } from '../lib/http.js';

export { ogImagemAbsoluta };

// Sem cache compartilhado: a home muda assim que o painel publica.
const CACHE_PUBLICO = 'public, max-age=0, must-revalidate';

async function lerPublicada() {
  if (!armazenamentoConfigurado()) return null;
  try {
    return await obterArmazenamento().lerTexto(CHAVE_HOME);
  } catch (erro) {
    console.warn('[render] usando o conteúdo padrão:', erro && (erro.codigo || erro.message || erro));
    return null;
  }
}

function enviarHtml(req, res, html, cabecalhos) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  for (const [nome, valor] of Object.entries(cabecalhos)) res.setHeader(nome, valor);
  if (String(req.method).toUpperCase() === 'HEAD') res.end();
  else res.end(html);
}

export default async function handler(req, res) {
  try {
    if (!exigirMetodo(req, res, ['GET'])) return;
    const template = await lerTemplateHome();

    if (lerQuery(req).modelo === '1') {
      enviarHtml(req, res, template, { 'Cache-Control': 'no-store' });
      return;
    }

    const publicada = await lerPublicada();
    const html = ogImagemAbsoluta(publicada || template, obterAmbiente().siteUrl);
    enviarHtml(req, res, html, { 'Cache-Control': CACHE_PUBLICO, 'X-AMA-CMS': publicada ? 'publicado' : 'padrao' });
  } catch (erro) {
    tratarErro(res, erro);
  }
}
