// Bucket R2 (binding MIDIA do wrangler.jsonc) com a interface de lib/armazenamento.js.

const PAGINAS_MAXIMAS = 20; // 20 × 1000 objetos

export function armazenamentoR2(bucket) {
  return {
    async lerTexto(chave) {
      const objeto = await bucket.get(chave);
      return objeto ? objeto.text() : null;
    },

    async gravar(chave, dados, { tipo } = {}) {
      await bucket.put(chave, dados, tipo ? { httpMetadata: { contentType: tipo } } : undefined);
    },

    async existe(chave) {
      return Boolean(await bucket.head(chave));
    },

    async listar(prefixo) {
      const saida = [];
      let cursor;
      for (let pagina = 0; pagina < PAGINAS_MAXIMAS; pagina += 1) {
        const lista = await bucket.list({ prefix: prefixo, cursor, limit: 1000, include: ['httpMetadata'] });
        for (const o of lista.objects) {
          saida.push({
            chave: o.key,
            tamanho: o.size,
            tipo: (o.httpMetadata && o.httpMetadata.contentType) || '',
            criado_em: o.uploaded instanceof Date ? o.uploaded.toISOString() : null,
          });
        }
        if (!lista.truncated) break;
        cursor = lista.cursor;
      }
      return saida;
    },

    async apagar(chave) {
      if (!(await bucket.head(chave))) return false;
      await bucket.delete(chave);
      return true;
    },
  };
}
