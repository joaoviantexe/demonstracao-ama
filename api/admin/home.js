// /api/admin/home — home publicada pelo painel (docs/ARQUITETURA.md §5.1).
// GET  → { ok, publicada, assinatura, publicado_em }: o painel compara a assinatura (SHA-256 do template + conteúdo)
//        para saber se precisa publicar de novo.
// POST { html, assinatura } → valida o HTML contra o template (lib/home.js) e grava no armazenamento.
//        422 'home_invalida' se o HTML traz algo que o template não tinha (script, on*, javascript:...).

import { exigirAdmin } from '../../lib/admin.js';
import { CHAVE_HOME, CHAVE_HOME_INFO, obterArmazenamento } from '../../lib/armazenamento.js';
import { LIMITE_HOME_BYTES, lerTemplateHome, validarHomePublicada } from '../../lib/home.js';
import { ErroHttp, exigirMetodo, lerCorpo, responderJson, tratarErro } from '../../lib/http.js';
import { CABECALHOS_SEM_CACHE } from '../../lib/loja.js';

const ASSINATURA = /^[0-9a-f]{16,128}$/;

async function lerInfo(armazenamento) {
  const texto = await armazenamento.lerTexto(CHAVE_HOME_INFO);
  if (!texto) return null;
  try {
    const info = JSON.parse(texto);
    return info && typeof info === 'object' ? info : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (!exigirMetodo(req, res, ['GET', 'POST'])) return;
  const admin = await exigirAdmin(req, res);
  if (!admin) return;
  try {
    const armazenamento = obterArmazenamento();

    if (String(req.method).toUpperCase() !== 'POST') {
      const info = await lerInfo(armazenamento);
      responderJson(res, 200, {
        ok: true,
        publicada: Boolean(info),
        assinatura: info && typeof info.assinatura === 'string' ? info.assinatura : null,
        publicado_em: info && typeof info.publicado_em === 'string' ? info.publicado_em : null,
      }, CABECALHOS_SEM_CACHE);
      return;
    }

    const corpo = await lerCorpo(req, { limiteBytes: Math.ceil(LIMITE_HOME_BYTES * 1.5) });
    const html = typeof corpo.html === 'string' ? corpo.html : '';
    const assinatura = typeof corpo.assinatura === 'string' ? corpo.assinatura.trim().toLowerCase() : '';
    if (!ASSINATURA.test(assinatura)) throw new ErroHttp(400, 'assinatura_invalida', 'Assinatura do conteúdo inválida.');

    const erro = validarHomePublicada(html, await lerTemplateHome());
    if (erro) {
      console.warn('[admin/home] publicação recusada:', erro);
      throw new ErroHttp(422, 'home_invalida', `A página não foi publicada: ${erro}`);
    }

    const publicadoEm = new Date().toISOString();
    await armazenamento.gravar(CHAVE_HOME, html, { tipo: 'text/html; charset=utf-8' });
    await armazenamento.gravar(CHAVE_HOME_INFO, JSON.stringify({ assinatura, publicado_em: publicadoEm, por: admin.email || null }),
      { tipo: 'application/json' });
    responderJson(res, 200, { ok: true, publicado_em: publicadoEm }, CABECALHOS_SEM_CACHE);
  } catch (erro) {
    tratarErro(res, erro);
  }
}
