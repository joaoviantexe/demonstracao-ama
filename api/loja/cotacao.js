// POST /api/loja/cotacao — preços, estoque, cupom e frete recalculados no servidor (docs/ARQUITETURA.md §6.2).
// Entrada { itens: [{ produto_id, quantidade }], cep?, cupom? }; frete é null sem CEP.

import { exigirMetodo, lerCorpo, responderJson, tratarErro } from '../../lib/http.js';
import { CABECALHOS_SEM_CACHE, cotar, erroDaLoja } from '../../lib/loja.js';

export default async function handler(req, res) {
  if (!exigirMetodo(req, res, ['POST'])) return;
  try {
    const corpo = await lerCorpo(req);
    const cotacao = await cotar({ itens: corpo.itens, cep: corpo.cep, cupom: corpo.cupom });
    responderJson(res, 200, { ok: true, ...cotacao }, CABECALHOS_SEM_CACHE);
  } catch (erro) {
    tratarErro(res, erroDaLoja(erro));
  }
}
