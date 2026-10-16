// Regras do arquivo public/_headers (formato do Cloudflare), usadas pelo Worker nas respostas que ele gera
// e pelo servidor local em tudo (o Cloudflare aplica o arquivo sozinho só aos arquivos estáticos).
//
// Formato: uma linha com o padrão do caminho (começa com "/"; "*" casa qualquer coisa, ":nome" um segmento)
// seguida de linhas indentadas "Nome: valor". Linhas começando com "#" são comentários.

/** Padrão do _headers → RegExp do caminho inteiro. */
export function padraoParaRegex(padrao) {
  let re = '';
  let i = 0;
  while (i < padrao.length) {
    const c = padrao[i];
    if (c === '*') {
      re += '.*';
      i += 1;
      continue;
    }
    if (c === ':') {
      const m = padrao.slice(i).match(/^:[A-Za-z_]\w*/);
      if (m) {
        re += '[^/]+';
        i += m[0].length;
        continue;
      }
    }
    re += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

/** Texto do _headers → [{ padrao, regex, cabecalhos: [[nome, valor]] }]. */
export function lerRegrasCabecalhos(texto) {
  const regras = [];
  let atual = null;
  for (const linhaBruta of String(texto || '').split(/\r?\n/)) {
    if (!linhaBruta.trim() || linhaBruta.trim().startsWith('#')) continue;
    if (/^\s/.test(linhaBruta)) {
      const m = linhaBruta.trim().match(/^([A-Za-z0-9-]+)\s*:\s*(.*)$/);
      if (atual && m) atual.cabecalhos.push([m[1], m[2].trim()]);
      continue;
    }
    const padrao = linhaBruta.trim();
    atual = padrao.startsWith('/') ? { padrao, regex: padraoParaRegex(padrao), cabecalhos: [] } : null;
    if (atual) regras.push(atual);
  }
  return regras;
}

/** Cabeçalhos que valem para o caminho, na ordem do arquivo (o último vence). → [[nome, valor]] */
export function cabecalhosPara(caminho, regras) {
  const saida = [];
  for (const { regex, cabecalhos } of regras) {
    if (regex.test(caminho)) saida.push(...cabecalhos);
  }
  return saida;
}
