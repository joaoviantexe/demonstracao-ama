// Ponto de entrada do Worker (wrangler.jsonc → "main"). O wrangler embute os dois arquivos abaixo como
// texto (regra "Text" do wrangler.jsonc): no Worker não há disco para ler o template.

import cabecalhos from '../public/_headers';
import template from '../templates/home.html';
import { criarApp } from './app.js';

export default criarApp({ template, cabecalhos });
