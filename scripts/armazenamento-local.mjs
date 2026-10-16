// Armazenamento numa pasta do disco, com a mesma interface do bucket R2 (lib/armazenamento.js).
// Usado pelo servidor local (npm run dev) e pelos testes. Padrão: <raiz do repositório>/.midia-local
// (ou MIDIA_DIR). O tipo de cada arquivo fica num arquivo irmão "<nome>.tipo".

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tipoPelaExtensao } from '../lib/armazenamento.js';

const SUFIXO_TIPO = '.tipo';

/** Pasta → { lerTexto, gravar, existe, listar, apagar, caminhoNoDisco }. */
export function armazenamentoLocal(pasta) {
  const raiz = path.resolve(pasta);

  // Chave do bucket → caminho no disco, sem sair da pasta.
  function noDisco(chave) {
    const texto = String(chave || '');
    const partes = texto.split('/');
    if (!texto || partes.some((p) => !p || p === '.' || p === '..' || p.includes('\\') || p.includes('\0'))) {
      throw new Error(`chave inválida: ${texto.slice(0, 80)}`);
    }
    const alvo = path.resolve(raiz, ...partes);
    if (!alvo.startsWith(raiz + path.sep)) throw new Error('chave fora da pasta');
    return alvo;
  }

  async function arquivo(chave) {
    try {
      const info = await stat(noDisco(chave));
      return info.isFile() ? info : null;
    } catch {
      return null;
    }
  }

  async function caminhar(pastaAtual, prefixoChave, saida) {
    let entradas;
    try {
      entradas = await readdir(pastaAtual, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entrada of entradas) {
      const chave = prefixoChave ? `${prefixoChave}/${entrada.name}` : entrada.name;
      const completo = path.join(pastaAtual, entrada.name);
      if (entrada.isDirectory()) await caminhar(completo, chave, saida);
      else if (entrada.isFile() && !entrada.name.endsWith(SUFIXO_TIPO)) saida.push({ chave, completo });
    }
  }

  return {
    raiz,
    caminhoNoDisco: noDisco,

    async lerTexto(chave) {
      try {
        return await readFile(noDisco(chave), 'utf8');
      } catch (erro) {
        if (erro && erro.code === 'ENOENT') return null;
        throw erro;
      }
    },

    async gravar(chave, dados, { tipo } = {}) {
      const alvo = noDisco(chave);
      await mkdir(path.dirname(alvo), { recursive: true });
      await writeFile(alvo, typeof dados === 'string' ? dados : Buffer.from(dados));
      if (tipo) await writeFile(alvo + SUFIXO_TIPO, String(tipo));
    },

    async existe(chave) {
      return Boolean(await arquivo(chave));
    },

    async listar(prefixo) {
      const texto = String(prefixo || '').replace(/\/+$/, '');
      const base = texto ? noDisco(texto) : raiz;
      const achados = [];
      await caminhar(base, texto, achados);
      return Promise.all(achados.map(async ({ chave, completo }) => {
        const info = await stat(completo);
        let tipo = '';
        try { tipo = (await readFile(completo + SUFIXO_TIPO, 'utf8')).trim(); } catch { tipo = tipoPelaExtensao(chave); }
        return { chave, tamanho: info.size, tipo, criado_em: info.mtime.toISOString() };
      }));
    },

    async apagar(chave) {
      if (!(await arquivo(chave))) return false;
      const alvo = noDisco(chave);
      await rm(alvo, { force: true });
      await rm(alvo + SUFIXO_TIPO, { force: true });
      return true;
    },

    /** Tipo gravado do arquivo ('' se não há). */
    async tipo(chave) {
      try { return (await readFile(noDisco(chave) + SUFIXO_TIPO, 'utf8')).trim(); } catch { return tipoPelaExtensao(chave); }
    },
  };
}
