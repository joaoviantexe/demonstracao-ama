// Publica a home do site (docs/ARQUITETURA.md §5.1): monta o HTML final aqui no navegador, com o mesmo
// motor do CMS (public/js/cms/aplicar.js), e grava em /api/admin/home. O servidor só entrega esse arquivo
// pronto (no Cloudflare gratuito não há CPU para montar a página a cada visita).
// - Depois de salvar no editor do site: publica sempre.
// - Ao abrir o painel: publica só se a assinatura (template + conteúdo) mudou desde a última publicação
//   (ex.: deploy com template novo ou conteúdo mudado direto no banco).

import { aplicarConteudo } from '../../js/cms/aplicar.js';
import * as api from './api.js';

/** Conteúdo em texto canônico (chaves em ordem), para a assinatura não depender da ordem das linhas. */
export function conteudoCanonico(linhas) {
  const pares = (Array.isArray(linhas) ? linhas : [])
    .filter((l) => l && typeof l.chave === 'string')
    .map((l) => [l.chave, l.valor ?? null])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(pares);
}

/** SHA-256 (hex) do template + conteúdo. */
export async function assinaturaDe(template, linhas) {
  const bytes = new TextEncoder().encode(`${template}\n${conteudoCanonico(linhas)}`);
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Template + conteúdo ({ chave: valor }) → HTML completo da home.
 * `analisar(texto)` devolve um Document (no navegador, o DOMParser; nos testes, o linkedom).
 */
export function montarHome(template, conteudo, analisar = (texto) => new DOMParser().parseFromString(texto, 'text/html')) {
  const documento = analisar(template);
  aplicarConteudo(documento, conteudo);
  const doctype = (String(template).match(/^\s*(<!doctype[^>]*>)/i) || [])[1] || '<!doctype html>';
  return `${doctype}\n${documento.documentElement.outerHTML}\n`;
}

// Uma publicação por vez: cada uma lê o conteúdo quando começa, então a última a terminar é a mais nova
// (sem a fila, a conferência feita ao entrar no painel podia gravar por cima do que acabou de ser salvo).
let fila = Promise.resolve();

/**
 * Publica a home. opções: { supabase, forcar = false (publica mesmo com a assinatura igual), sinal }.
 * → { ok: true, publicado: boolean } | { ok: false, erro, mensagem }.
 */
export function publicarHome(opcoes = {}) {
  const tarefa = fila.then(() => publicarAgora(opcoes));
  fila = tarefa.catch(() => {});
  return tarefa;
}

async function publicarAgora({ supabase, forcar = false, sinal } = {}) {
  let respostaTemplate;
  let consulta;
  try {
    [respostaTemplate, consulta] = await Promise.all([
      fetch('/?modelo=1', { cache: 'no-store', credentials: 'same-origin', signal: sinal }),
      api.consultar(supabase.from('conteudo_site').select('chave, valor')),
    ]);
  } catch {
    return { ok: false, erro: 'sem_conexao', mensagem: 'Não foi possível atualizar o site: verifique sua internet.' };
  }
  if (!consulta.ok) return consulta;
  if (!respostaTemplate.ok) {
    return { ok: false, erro: 'modelo_indisponivel', mensagem: 'Não foi possível ler o modelo da página. Tente de novo.' };
  }
  const template = await respostaTemplate.text();
  const linhas = consulta.dados || [];
  const assinatura = await assinaturaDe(template, linhas);

  if (!forcar) {
    const atual = await api.chamarApi('/api/admin/home', { sinal });
    if (atual.ok && atual.assinatura === assinatura) return { ok: true, publicado: false };
  }

  const conteudo = Object.fromEntries(linhas.map((l) => [l.chave, l.valor]));
  const html = montarHome(template, conteudo);
  const r = await api.chamarApi('/api/admin/home', { corpo: { html, assinatura }, sinal, timeoutMs: 60_000 });
  return r.ok ? { ok: true, publicado: true } : r;
}
