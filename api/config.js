// GET /api/config — configuração pública para o navegador (docs/ARQUITETURA.md §6.1).
// Só a URL e a chave PÚBLICA do Supabase; a chave de serviço nunca sai daqui. Uma chave secreta
// colada por engano no lugar da pública vira "não configurado" (obterAmbiente já a descarta e loga).

import { ehChaveSecreta, obterAmbiente } from '../lib/ambiente.js';
import { exigirMetodo, tratarErro } from '../lib/http.js';

/** JSON seguro para embutir em <script> e em JS (sem </script>, <!--, U+2028/U+2029). */
export function jsonSeguro(valor) {
  return JSON.stringify(valor)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export default function handler(req, res) {
  try {
    if (!exigirMetodo(req, res, ['GET'])) return;
    const { supabaseUrl, supabaseAnonKey, supabaseServiceKey, supabasePublicoConfigurado } = obterAmbiente();
    const publicavel = supabasePublicoConfigurado && !ehChaveSecreta(supabaseAnonKey, supabaseServiceKey);
    const config = publicavel
      ? { supabaseUrl, supabaseAnonKey, configurado: true }
      : { supabaseUrl: '', supabaseAnonKey: '', configurado: false };
    const corpo = Buffer.from(`window.AMA_CONFIG = ${jsonSeguro(config)};`, 'utf8');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Content-Length', String(corpo.length));
    if (String(req.method).toUpperCase() === 'HEAD') res.end();
    else res.end(corpo);
  } catch (erro) {
    tratarErro(res, erro);
  }
}
