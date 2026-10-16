// Worker do Cloudflare (docs/ARQUITETURA.md §2): o Cloudflare entrega sozinho os arquivos de public/
// (com os cabeçalhos de public/_headers); o Worker só recebe o que não é arquivo:
// - "/"         → api/render.js (home publicada pelo painel ou o template)
// - "/api/..."  → as funções de api/ (worker/rotas.js), com o adaptador req/res (worker/adaptador.js)
// - "/midia/..." → fotos e vídeos do bucket R2 (worker/midia.js)
// - o resto     → o 404 dos arquivos estáticos
// E o agendamento diário (triggers.crons do wrangler.jsonc) chama api/cron/manter-ativo.js.
//
// criarApp() fica separado de worker/index.js para os testes rodarem no Node (index.js importa .html).

import { definirArmazenamento } from '../lib/armazenamento.js';
import { cabecalhosPara, lerRegrasCabecalhos } from '../lib/cabecalhos.js';
import { definirTemplateHome } from '../lib/home.js';
import { executarHandler } from './adaptador.js';
import { servirMidia } from './midia.js';
import { armazenamentoR2 } from './r2.js';
import { ROTAS } from './rotas.js';

const json = (status, objeto) => new Response(JSON.stringify(objeto), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

/** { template: texto de templates/home.html, cabecalhos: texto de public/_headers } → { fetch, scheduled }. */
export function criarApp({ template, cabecalhos = '' } = {}) {
  const regras = lerRegrasCabecalhos(cabecalhos);
  let envPreparado = null;

  // As variáveis e segredos do Worker chegam em `env`; lib/ambiente.js lê process.env.
  function preparar(env) {
    if (env === envPreparado) return;
    for (const [nome, valor] of Object.entries(env || {})) {
      if (typeof valor === 'string') process.env[nome] = valor;
    }
    if (typeof template === 'string') definirTemplateHome(template);
    definirArmazenamento(env && env.MIDIA ? armazenamentoR2(env.MIDIA) : null);
    envPreparado = env;
  }

  // Mesmos cabeçalhos de segurança dos arquivos estáticos, nas respostas do Worker.
  function comCabecalhos(resposta, caminho) {
    const extras = cabecalhosPara(caminho, regras);
    if (!extras.length) return resposta;
    const copia = new Response(resposta.body, resposta);
    for (const [nome, valor] of extras) {
      if (!copia.headers.has(nome)) copia.headers.set(nome, valor);
    }
    return copia;
  }

  async function fetch(request, env, ctx) {
    preparar(env);
    const url = new URL(request.url);
    const caminho = url.pathname;
    let resposta;
    if (caminho === '/') {
      resposta = await executarHandler(ROTAS['/api/render'], request);
    } else if (caminho === '/api' || caminho.startsWith('/api/')) {
      const handler = ROTAS[caminho.replace(/\/+$/, '')];
      resposta = handler
        ? await executarHandler(handler, request)
        : json(404, { ok: false, erro: 'nao_encontrado', mensagem: 'Rota não encontrada.' });
    } else if (caminho.startsWith('/midia/')) {
      resposta = await servirMidia(request, env, ctx);
    } else if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    } else {
      resposta = new Response('Página não encontrada.', { status: 404 });
    }
    return comCabecalhos(resposta, caminho);
  }

  async function scheduled(controlador, env, ctx) {
    preparar(env);
    const segredo = env && typeof env.CRON_SECRET === 'string' ? env.CRON_SECRET.trim() : '';
    const request = new Request('https://agendamento.interno/api/cron/manter-ativo', {
      headers: segredo ? { Authorization: `Bearer ${segredo}` } : {},
    });
    const tarefa = executarHandler(ROTAS['/api/cron/manter-ativo'], request).then((r) => {
      if (!r.ok) console.error('[agendamento] manter-ativo respondeu', r.status);
    });
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(tarefa);
    await tarefa;
  }

  return { fetch, scheduled };
}
