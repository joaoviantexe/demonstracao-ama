// #/configuracoes — ajustes da loja (docs/ARQUITETURA.md §4.1 → configuracoes, §6.6 e §8).
// Abas: Loja (nome e descrição), Frete (origem, Melhor Envio, frete fixo,
// frete grátis, embalagem padrão; não existe retirada na sede), Pagamento (parcelas, boleto, prazo),
// Avisos por e-mail (equipe) e Integrações (situação das chaves na Vercel, via /api/admin/status).
// Cada aba salva só as chaves dela, mantendo o que já existe no valor (campos que o painel não mostra).
// As funções puras do começo do arquivo são testadas em tests/unit/painel-configuracoes.test.js.

import { formatarPreco } from '../ui.js';

// ---------------------------------------------------------------------------
// Regras gerais

export const UFS = Object.freeze(['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB',
  'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO']);

/** Serviços do Melhor Envio oferecidos (só Correios: as outras transportadoras pedem agência). */
export const SERVICOS_MELHOR_ENVIO = Object.freeze([
  { id: 1, nome: 'PAC (Correios)', ajuda: 'Mais barato, prazo maior.' },
  { id: 2, nome: 'SEDEX (Correios)', ajuda: 'Mais rápido.' },
  { id: 17, nome: 'Mini Envios (Correios)', ajuda: 'Só para pacotes pequenos: até 300 g e 4 × 16 × 24 cm.' },
]);

/** Prazos para pagar (Pix e boleto), em dias. O Mercado Pago usa no mínimo 3 dias. */
export const PRAZOS_PAGAMENTO_DIAS = Object.freeze([3, 4, 5, 7, 10, 15, 30]);

const MAIOR_INT = 2147483647;
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const digitos = (v) => String(v ?? '').replace(/\D+/g, '');
const texto = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** "12" → 12; "" → null (vazio); texto inválido → NaN. */
export function lerInteiro(valor) {
  const t = String(valor ?? '').replace(/\s+/g, '');
  if (!t) return null;
  if (!/^\d+$/.test(t)) return Number.NaN;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : Number.NaN;
}

/** "4,5" → 4.5; "" → null; texto inválido → NaN. */
export function lerDecimal(valor) {
  const t = String(valor ?? '').replace(/\s+/g, '');
  if (!t) return null;
  if (!/^\d+([.,]\d+)?$/.test(t)) return Number.NaN;
  return Number(t.replace(',', '.'));
}

/** 4.5 → "4,5"; 12 → "12"; vazio → "". */
export function formatarDecimal(numero) {
  const n = Number(numero);
  if (numero === null || numero === undefined || numero === '' || !Number.isFinite(n)) return '';
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : String(r).replace('.', ',');
}

// ---------------------------------------------------------------------------
// Loja

/** Campos da aba Loja → { erros, valor } (valor = só os campos desta aba). */
export function validarLoja(v) {
  const erros = {};
  const titulo = texto(v.titulo);
  if (!titulo) erros.titulo = 'Informe o nome da loja.';
  else if (titulo.length > 120) erros.titulo = 'Use no máximo 120 caracteres.';
  const subtitulo = texto(v.subtitulo);
  if (subtitulo.length > 400) erros.subtitulo = 'Use no máximo 400 caracteres.';
  // O WhatsApp e o e-mail de contato não são editados aqui: o número vem do botão do WhatsApp (Site → Botão do WhatsApp).
  return { erros, valor: { titulo, subtitulo } };
}

// ---------------------------------------------------------------------------
// Frete

/** CPF ou CNPJ com dígitos verificadores corretos. */
export function documentoValido(valor) {
  const d = digitos(valor);
  if (d.length === 11) {
    if (/^(\d)\1{10}$/.test(d)) return false;
    const dv = (base) => {
      const soma = [...base].reduce((s, n, i) => s + Number(n) * (base.length + 1 - i), 0);
      const resto = (soma * 10) % 11;
      return resto === 10 ? 0 : resto;
    };
    return dv(d.slice(0, 9)) === Number(d[9]) && dv(d.slice(0, 10)) === Number(d[10]);
  }
  if (d.length === 14) {
    if (/^(\d)\1{13}$/.test(d)) return false;
    const dv = (base) => {
      const pesos = base.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      const resto = [...base].reduce((s, n, i) => s + Number(n) * pesos[i], 0) % 11;
      return resto < 2 ? 0 : 11 - resto;
    };
    return dv(d.slice(0, 12)) === Number(d[12]) && dv(d.slice(0, 13)) === Number(d[13]);
  }
  return false;
}

/** "pa, AP am" → ['PA', 'AP', 'AM']; siglas inválidas em `invalidas`. */
export function lerUfs(valor) {
  const partes = String(valor ?? '').toUpperCase().split(/[\s,;/]+/).map((p) => p.trim()).filter(Boolean);
  const ufs = [];
  const invalidas = [];
  for (const p of partes) {
    if (!UFS.includes(p)) invalidas.push(p);
    else if (!ufs.includes(p)) ufs.push(p);
  }
  return { ufs, invalidas };
}

/** Id de uma opção de frete fixo a partir do nome, sem repetir os existentes ("fixo-entrega-local"). */
export function idOpcaoFixa(nome, existentes = []) {
  const base = `fixo-${String(nome ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'opcao'}`;
  const usados = new Set(existentes);
  if (!usados.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) if (!usados.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${Date.now().toString(36)}`;
}

/**
 * Campos da aba Frete → { erros, frete, freteGratisCentavos }.
 * v = { origem: {...}, melhor_envio: { ativo, servicos: [ids], seguro, prazo_extra_dias, taxa_extra_centavos },
 *       fixo: { ativo, opcoes: [{ id?, nome, preco_centavos, prazo_dias, ufs (texto) }] },
 *       embalagem_padrao: {...textos}, frete_gratis_centavos }
 * Chaves de erro: 'origem.cep', 'melhor_envio.servicos', 'fixo.opcoes.0.nome', 'embalagem_padrao.peso_gramas'…
 */
export function validarFrete(v) {
  const erros = {};
  const o = ehObjeto(v.origem) ? v.origem : {};
  const origem = {
    nome: texto(o.nome), documento: digitos(o.documento), telefone: digitos(o.telefone), email: texto(o.email).toLowerCase(),
    cep: digitos(o.cep), endereco: texto(o.endereco), numero: texto(o.numero), complemento: texto(o.complemento),
    bairro: texto(o.bairro), cidade: texto(o.cidade), uf: texto(o.uf).toUpperCase(),
  };
  const me = ehObjeto(v.melhor_envio) ? v.melhor_envio : {};
  const meAtivo = me.ativo === true;
  // Os dados do remetente só são exigidos com o Melhor Envio ligado (vão na etiqueta).
  if (origem.cep && origem.cep.length !== 8) erros['origem.cep'] = 'O CEP tem 8 números.';
  if (origem.documento && !documentoValido(origem.documento)) erros['origem.documento'] = 'Confira o CPF ou CNPJ.';
  if (origem.telefone && (origem.telefone.length < 10 || origem.telefone.length > 11)) erros['origem.telefone'] = 'Telefone com DDD (10 ou 11 números).';
  if (origem.email && !EMAIL.test(origem.email)) erros['origem.email'] = 'Confira o e-mail.';
  if (origem.uf && !UFS.includes(origem.uf)) erros['origem.uf'] = 'Escolha o estado.';
  if (meAtivo) {
    const obrigatorios = [
      ['nome', 'Informe o nome do remetente.'], ['documento', 'Os Correios exigem o CPF ou CNPJ do remetente.'],
      ['telefone', 'Informe um telefone com DDD.'], ['cep', 'Informe o CEP de onde os pacotes saem.'],
      ['endereco', 'Informe a rua.'], ['numero', 'Informe o número (ou S/N).'], ['bairro', 'Informe o bairro.'],
      ['cidade', 'Informe a cidade.'], ['uf', 'Escolha o estado.'],
    ];
    for (const [campo, mensagem] of obrigatorios) if (!origem[campo] && !erros[`origem.${campo}`]) erros[`origem.${campo}`] = mensagem;
  }
  for (const [campo, max] of [['nome', 120], ['endereco', 200], ['numero', 20], ['complemento', 100], ['bairro', 100], ['cidade', 100]]) {
    if (origem[campo].length > max && !erros[`origem.${campo}`]) erros[`origem.${campo}`] = `Use no máximo ${max} caracteres.`;
  }

  const servicos = (Array.isArray(me.servicos) ? me.servicos : []).map(Number)
    .filter((id) => SERVICOS_MELHOR_ENVIO.some((s) => s.id === id));
  if (meAtivo && !servicos.length) erros['melhor_envio.servicos'] = 'Escolha pelo menos um serviço.';
  const prazoExtra = lerInteiro(me.prazo_extra_dias);
  if (Number.isNaN(prazoExtra) || prazoExtra > 30) erros['melhor_envio.prazo_extra_dias'] = 'Use um número de 0 a 30 dias.';
  const taxa = me.taxa_extra_centavos;
  if (taxa !== null && taxa !== undefined && (!Number.isSafeInteger(taxa) || taxa < 0 || taxa > 100000)) {
    erros['melhor_envio.taxa_extra_centavos'] = 'Confira o valor (até R$ 1.000,00).';
  }

  const f = ehObjeto(v.fixo) ? v.fixo : {};
  const opcoesBrutas = Array.isArray(f.opcoes) ? f.opcoes : [];
  const usados = [];
  const opcoes = opcoesBrutas.map((op, i) => {
    const nome = texto(op.nome);
    if (!nome) erros[`fixo.opcoes.${i}.nome`] = 'Dê um nome (ex.: Entrega em Ananindeua).';
    else if (nome.length > 60) erros[`fixo.opcoes.${i}.nome`] = 'Use no máximo 60 caracteres.';
    const preco = op.preco_centavos;
    if (preco === null || preco === undefined) erros[`fixo.opcoes.${i}.preco_centavos`] = 'Informe o valor (0 para grátis).';
    else if (!Number.isSafeInteger(preco) || preco < 0 || preco > MAIOR_INT) erros[`fixo.opcoes.${i}.preco_centavos`] = 'Confira o valor.';
    const prazo = lerInteiro(op.prazo_dias);
    if (Number.isNaN(prazo) || prazo > 60) erros[`fixo.opcoes.${i}.prazo_dias`] = 'Use um número de 0 a 60 dias.';
    const { ufs, invalidas } = lerUfs(op.ufs);
    if (invalidas.length) erros[`fixo.opcoes.${i}.ufs`] = `Sigla de estado inválida: ${invalidas.join(', ')}.`;
    const idExistente = typeof op.id === 'string' && /^fixo-[a-z0-9_-]{1,60}$/.test(op.id) && !usados.includes(op.id) ? op.id : null;
    const id = idExistente || idOpcaoFixa(nome, usados);
    usados.push(id);
    return { id, nome, preco_centavos: preco, prazo_dias: prazo, ufs };
  });
  if (f.ativo === true && !opcoes.length) erros['fixo.opcoes'] = 'Adicione pelo menos uma opção de frete fixo (ou desligue o frete fixo).';

  const e = ehObjeto(v.embalagem_padrao) ? v.embalagem_padrao : {};
  const embalagem = {};
  for (const [campo, min, max, rotulo] of [['peso_gramas', 1, 30000, 'g'], ['altura_cm', 1, 100, 'cm'], ['largura_cm', 1, 100, 'cm'], ['comprimento_cm', 1, 100, 'cm']]) {
    const n = campo === 'peso_gramas' ? lerInteiro(e[campo]) : lerDecimal(e[campo]);
    if (n === null || Number.isNaN(n) || n < min || n > max) erros[`embalagem_padrao.${campo}`] = `Use um número de ${min} a ${max} ${rotulo}.`;
    embalagem[campo] = Number.isNaN(n) ? null : n;
  }

  const gratis = v.frete_gratis_centavos;
  if (gratis !== null && gratis !== undefined && (!Number.isSafeInteger(gratis) || gratis <= 0 || gratis > MAIOR_INT)) {
    erros.frete_gratis_centavos = 'Informe um valor maior que zero, ou deixe vazio para não ter frete grátis.';
  }

  return {
    erros,
    frete: {
      origem,
      melhor_envio: {
        ativo: meAtivo, servicos, seguro: me.seguro !== false,
        prazo_extra_dias: prazoExtra ?? 0, taxa_extra_centavos: Number.isSafeInteger(taxa) ? taxa : 0,
      },
      fixo: { ativo: f.ativo === true, opcoes },
      embalagem_padrao: embalagem,
    },
    freteGratisCentavos: Number.isSafeInteger(gratis) && gratis > 0 ? gratis : null,
  };
}

/**
 * Alguma forma de entrega vai aparecer no checkout? (Melhor Envio ligado e configurado, ou frete fixo ligado
 * com opções.) → { ok, mensagem }. `melhorEnvioConfigurado` = null quando ainda não se sabe.
 */
export function diagnosticoEntrega(frete, melhorEnvioConfigurado) {
  const me = frete && frete.melhor_envio && frete.melhor_envio.ativo === true;
  const fixo = frete && frete.fixo && frete.fixo.ativo === true && Array.isArray(frete.fixo.opcoes) && frete.fixo.opcoes.length > 0;
  if (fixo) return { ok: true, mensagem: null };
  if (me && melhorEnvioConfigurado !== false) {
    const semOrigem = !(frete.origem && digitos(frete.origem.cep).length === 8);
    return semOrigem
      ? { ok: false, mensagem: 'O Melhor Envio está ligado, mas falta o CEP de onde os pacotes saem: sem ele o frete não é calculado.' }
      : { ok: true, mensagem: null };
  }
  if (me) {
    return { ok: false, mensagem: 'O Melhor Envio está ligado aqui, mas falta o MELHOR_ENVIO_TOKEN na Vercel. Até lá, ligue o frete fixo para a loja conseguir vender.' };
  }
  return { ok: false, mensagem: 'Nenhuma forma de entrega está ligada: ninguém consegue finalizar a compra. Ligue o Melhor Envio ou o frete fixo.' };
}

// ---------------------------------------------------------------------------
// Pagamento e avisos

/** Campos da aba Pagamento → { erros, valor }. */
export function validarCheckout(v) {
  const erros = {};
  const parcelas = Number(v.parcelas_max);
  if (!Number.isInteger(parcelas) || parcelas < 1 || parcelas > 12) erros.parcelas_max = 'Escolha de 1 a 12 parcelas.';
  const dias = Number(v.prazo_dias);
  if (!PRAZOS_PAGAMENTO_DIAS.includes(dias)) erros.prazo_dias = 'Escolha um dos prazos da lista.';
  return {
    erros,
    valor: { parcelas_max: parcelas, aceitar_boleto: v.aceitar_boleto !== false, expiracao_horas: dias * 24 },
  };
}

/** expiracao_horas salva → dias da lista (o mais próximo, no mínimo 3). */
export function diasDoPrazo(horas) {
  const dias = Math.max(3, Math.round((Number(horas) || 72) / 24));
  return PRAZOS_PAGAMENTO_DIAS.reduce((melhor, d) => (Math.abs(d - dias) < Math.abs(melhor - dias) ? d : melhor), PRAZOS_PAGAMENTO_DIAS[0]);
}

/** "a@x.com; B@y.com, a@x.com" → { emails: 'a@x.com, b@y.com', invalidos: [] }. Até 5 endereços. */
export function lerEmails(valor) {
  const partes = String(valor ?? '').split(/[\s,;]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  const emails = [];
  const invalidos = [];
  for (const p of partes) {
    if (!EMAIL.test(p) || p.length > 160) invalidos.push(p);
    else if (!emails.includes(p)) emails.push(p);
  }
  return { emails: emails.join(', '), lista: emails, invalidos };
}

/** Campos da aba Avisos → { erros, valor }. */
export function validarNotificacoes(v) {
  const erros = {};
  const { emails, lista, invalidos } = lerEmails(v.email_admin);
  if (invalidos.length) erros.email_admin = `Confira: ${invalidos.join(', ')}.`;
  else if (lista.length > 5) erros.email_admin = 'Use no máximo 5 e-mails.';
  return { erros, valor: { email_admin: emails } };
}

// ---------------------------------------------------------------------------
// Página

const CHAVES = Object.freeze(['loja', 'frete', 'checkout', 'notificacoes']);
const PUBLICO = Object.freeze({ loja: true, frete: false, checkout: false, notificacoes: false });
const ABAS = Object.freeze(['loja', 'frete', 'pagamento', 'avisos']);

export async function renderizar(ctx) {
  const { ui, api, supabase } = ctx;
  const { el } = ui;

  ctx.raiz.append(ui.cabecalhoPagina({
    titulo: 'Configurações',
    descricao: 'Dados da loja, formas de entrega, pagamento e avisos por e-mail.',
  }));
  const corpo = el('div', { class: 'pilha' });
  ctx.raiz.append(corpo);
  ui.estadoCarregando(corpo, { linhas: 6, mensagem: 'Carregando as configurações…' });

  let integracoes = null;
  const sujos = new Set();
  const marcar = (aba, sim) => {
    if (sim) sujos.add(aba);
    else sujos.delete(aba);
    ctx.marcarAlterado(sujos.size > 0);
  };

  const [r] = await Promise.all([
    api.consultar(supabase.from('configuracoes').select('chave, valor').in('chave', [...CHAVES])),
    ui.carregarCss('configuracoes'),
  ]);
  if (!ctx.ativo()) return undefined;
  if (!r.ok) {
    ui.estadoErro(corpo, r.mensagem, { titulo: 'Não foi possível carregar as configurações', aoTentarNovamente: () => ctx.navegar(window.location.hash) });
    return undefined;
  }
  const valores = Object.fromEntries(CHAVES.map((c) => [c, {}]));
  for (const linha of r.dados || []) if (ehObjeto(linha.valor)) valores[linha.chave] = linha.valor;

  /** Salva uma chave mesclando com o valor atual (preserva campos que o painel não mostra). */
  async function salvarChave(chave, parcial) {
    const valor = { ...valores[chave], ...parcial };
    const resp = await api.consultar(supabase.from('configuracoes')
      .upsert({ chave, valor, publico: PUBLICO[chave] }, { onConflict: 'chave' }).select('chave, valor').maybeSingle());
    if (resp.ok && resp.dados && ehObjeto(resp.dados.valor)) valores[chave] = resp.dados.valor;
    return resp;
  }

  // --- Componentes comuns ------------------------------------------------------
  const cartao = (idTitulo, titulo, subtitulo, ...conteudo) => el('section', { class: 'cartao', 'aria-labelledby': idTitulo },
    el('div', { class: 'cartao__cabecalho' },
      el('h2', { class: 'cartao__titulo', id: idTitulo }, titulo),
      subtitulo ? el('p', { class: 'cartao__subtitulo' }, subtitulo) : null),
    el('div', { class: 'cartao__corpo' }, ...conteudo));

  function montarFormulario(aba, rotulo, conteudo, aoSalvar, { info = 'As mudanças valem na loja assim que você salvar.' } = {}) {
    const botao = ui.botao({ texto: 'Salvar', tipo: 'primario', icone: 'check', tipoHtml: 'submit' });
    const infoBarra = el('p', { class: 'barra-acoes__info', 'aria-live': 'polite' }, info);
    const form = el('form', { class: 'pilha config-form', novalidate: true, 'aria-label': rotulo }, ...conteudo, el('div', { class: 'barra-acoes' }, infoBarra, botao));
    form.addEventListener('input', () => marcar(aba, true));
    form.addEventListener('change', () => marcar(aba, true));
    form.addEventListener('submit', async (evento) => {
      evento.preventDefault();
      await ui.ocupado(botao, async () => {
        const salvou = await aoSalvar();
        if (!ctx.ativo()) return;
        if (salvou === true) {
          marcar(aba, false);
          infoBarra.textContent = info;
          infoBarra.classList.remove('config-barra__erro');
        } else if (typeof salvou === 'string') {
          infoBarra.textContent = salvou;
          infoBarra.classList.add('config-barra__erro');
        }
      });
    });
    return form;
  }

  /** Mostra os erros nos campos; foca o primeiro. Devolve true se houve erro. */
  function mostrarErros(erros, campos) {
    const chaves = Object.keys(erros);
    for (const [chave, campo] of Object.entries(campos)) if (campo) campo.definirErro(erros[chave] || null);
    const primeiro = chaves.map((c) => campos[c]).find(Boolean);
    if (primeiro) {
      primeiro.entrada.focus();
      primeiro.elemento.scrollIntoView({ block: 'center' });
    }
    return chaves.length > 0;
  }

  const MSG_ERROS = 'Confira os campos marcados em vermelho.';

  /** Campo de preço: null se vazio, NaN se o texto não é um valor (ler() devolve null nos dois casos). */
  const precoDe = (campo) => {
    if (!campo.entrada.value.trim()) return null;
    const v = campo.ler();
    return v === null ? Number.NaN : v;
  };

  // --- Aba Loja -----------------------------------------------------------------
  function abaLoja() {
    const v = valores.loja;
    const c = {
      titulo: ui.campo({ rotulo: 'Nome da loja', nome: 'titulo', obrigatorio: true, valor: v.titulo || 'Cosméticos', ajuda: 'Aparece no título da aba do navegador e nos resultados de busca.', attrs: { maxlength: '120' } }),
      subtitulo: ui.campo({ rotulo: 'Descrição curta', nome: 'subtitulo', tipo: 'textarea', linhas: 2, valor: v.subtitulo || '', ajuda: 'Uma frase sobre a loja. Usada pelos buscadores (Google) e quando o link é compartilhado.', attrs: { maxlength: '400' } }),
    };
    return montarFormulario('loja', 'Dados da loja', [
      cartao('cf-loja', 'Loja', null, c.titulo.elemento, c.subtitulo.elemento),
    ], async () => {
      const { erros, valor } = validarLoja(Object.fromEntries(Object.entries(c).map(([k, campo]) => [k, campo.ler()])));
      if (mostrarErros(erros, c)) return MSG_ERROS;
      const resp = await salvarChave('loja', valor);
      if (!ctx.ativo()) return false;
      if (!resp.ok) {
        ui.toast(resp.mensagem, 'erro');
        return false;
      }
      ui.toast('Dados da loja salvos.', 'sucesso');
      return true;
    });
  }

  // --- Aba Frete ----------------------------------------------------------------
  function abaFrete() {
    const f = ehObjeto(valores.frete) ? valores.frete : {};
    const o = ehObjeto(f.origem) ? f.origem : {};
    const me = ehObjeto(f.melhor_envio) ? f.melhor_envio : {};
    const fixo = ehObjeto(f.fixo) ? f.fixo : {};
    const emb = ehObjeto(f.embalagem_padrao) ? f.embalagem_padrao : {};
    const campos = {};
    const avisoEntrega = el('div', { class: 'config-aviso-entrega', 'aria-live': 'polite' });

    // Origem
    const origem = (campo, opcoes) => {
      campos[`origem.${campo}`] = ui.campo({ nome: `origem_${campo}`, valor: o[campo] ?? '', ...opcoes });
      return campos[`origem.${campo}`].elemento;
    };
    const cartaoOrigem = cartao('cf-origem', 'De onde os pacotes saem', 'Dados do remetente nas etiquetas do Melhor Envio. Os Correios exigem CPF ou CNPJ.',
      origem('nome', { rotulo: 'Nome do remetente', attrs: { maxlength: '120', autocomplete: 'off' } }),
      el('div', { class: 'formulario__linha' },
        origem('documento', { rotulo: 'CPF ou CNPJ', attrs: { inputmode: 'numeric', maxlength: '18', autocomplete: 'off' } }),
        origem('telefone', { rotulo: 'Telefone com DDD', tipo: 'tel', attrs: { inputmode: 'tel', maxlength: '20', autocomplete: 'off' } })),
      origem('email', { rotulo: 'E-mail', tipo: 'email', ajuda: 'Opcional.', attrs: { inputmode: 'email', maxlength: '160', autocomplete: 'off' } }),
      el('div', { class: 'formulario__linha' },
        origem('cep', { rotulo: 'CEP', placeholder: '00000-000', attrs: { inputmode: 'numeric', maxlength: '9', autocomplete: 'off' } }),
        origem('numero', { rotulo: 'Número', attrs: { maxlength: '20', autocomplete: 'off' } })),
      origem('endereco', { rotulo: 'Rua', attrs: { maxlength: '200', autocomplete: 'off' } }),
      origem('complemento', { rotulo: 'Complemento', ajuda: 'Opcional.', attrs: { maxlength: '100', autocomplete: 'off' } }),
      el('div', { class: 'formulario__linha' },
        origem('bairro', { rotulo: 'Bairro', attrs: { maxlength: '100', autocomplete: 'off' } }),
        origem('cidade', { rotulo: 'Cidade', attrs: { maxlength: '100', autocomplete: 'off' } })),
      (() => {
        campos['origem.uf'] = ui.campo({ rotulo: 'Estado', nome: 'origem_uf', tipo: 'select', valor: (o.uf || '').toUpperCase(), opcoes: [{ valor: '', rotulo: 'Escolha' }, ...UFS] });
        return campos['origem.uf'].elemento;
      })());

    // Melhor Envio
    const meAtivo = ui.campo({ rotulo: 'Calcular o frete pelo Melhor Envio', nome: 'me_ativo', tipo: 'interruptor', valor: me.ativo !== false, ajuda: 'Os Correios calculam o frete e o prazo pelo CEP da cliente.' });
    const servicosAtuais = Array.isArray(me.servicos) ? me.servicos.map(Number) : [1, 2];
    const caixasServicos = SERVICOS_MELHOR_ENVIO.map((s) => ({ id: s.id, campo: ui.campo({ rotulo: s.nome, nome: `servico_${s.id}`, tipo: 'checkbox', valor: servicosAtuais.includes(s.id), ajuda: s.ajuda }) }));
    const erroServicos = el('p', { class: 'campo__erro', id: ui.novoId('erro-servicos'), hidden: true });
    campos['melhor_envio.servicos'] = {
      elemento: erroServicos, entrada: caixasServicos[0].campo.entrada,
      definirErro: (msg) => { erroServicos.textContent = msg || ''; erroServicos.hidden = !msg; },
    };
    const seguro = ui.campo({ rotulo: 'Declarar o valor dos produtos (seguro)', nome: 'seguro', tipo: 'checkbox', valor: me.seguro !== false, ajuda: 'Recomendado: em caso de extravio, a transportadora paga o valor declarado.' });
    campos['melhor_envio.prazo_extra_dias'] = ui.campo({ rotulo: 'Dias a mais no prazo', nome: 'prazo_extra', valor: String(me.prazo_extra_dias ?? 2), sufixo: 'dias', ajuda: 'Tempo para separar e postar, somado ao prazo da transportadora.', attrs: { inputmode: 'numeric', maxlength: '2' } });
    campos['melhor_envio.taxa_extra_centavos'] = ui.campo({ rotulo: 'Valor a mais no frete', nome: 'taxa_extra', tipo: 'preco', valor: me.taxa_extra_centavos ?? 0, ajuda: 'Opcional. Para cobrir a embalagem, por exemplo.' });
    const cartaoMe = cartao('cf-me', 'Melhor Envio (Correios)', null,
      meAtivo.elemento,
      el('fieldset', { class: 'formulario__secao config-servicos' }, el('legend', {}, 'Serviços oferecidos'), ...caixasServicos.map((s) => s.campo.elemento), erroServicos),
      seguro.elemento,
      el('div', { class: 'formulario__linha' }, campos['melhor_envio.prazo_extra_dias'].elemento, campos['melhor_envio.taxa_extra_centavos'].elemento));

    // Frete fixo
    const fixoAtivo = ui.campo({ rotulo: 'Oferecer frete fixo', nome: 'fixo_ativo', tipo: 'interruptor', valor: fixo.ativo === true, ajuda: 'Valor fixo que a AMA cobra e entrega por conta própria (ex.: na Grande Belém).' });
    const listaFixo = el('div', { class: 'pilha config-fixo' });
    const erroFixo = el('p', { class: 'campo__erro', hidden: true });
    campos['fixo.opcoes'] = { elemento: erroFixo, entrada: fixoAtivo.entrada, definirErro: (msg) => { erroFixo.textContent = msg || ''; erroFixo.hidden = !msg; } };
    let opcoesFixas = (Array.isArray(fixo.opcoes) ? fixo.opcoes : []).map((op) => criarOpcaoFixa(op));
    function criarOpcaoFixa(op = {}) {
      const item = {
        id: typeof op.id === 'string' ? op.id : null,
        nome: ui.campo({ rotulo: 'Nome', nome: 'fixo_nome', valor: op.nome || '', placeholder: 'Ex.: Entrega em Ananindeua', attrs: { maxlength: '60' } }),
        preco: ui.campo({ rotulo: 'Valor', nome: 'fixo_preco', tipo: 'preco', valor: Number.isSafeInteger(op.preco_centavos) ? op.preco_centavos : null }),
        prazo: ui.campo({ rotulo: 'Prazo', nome: 'fixo_prazo', valor: op.prazo_dias === null || op.prazo_dias === undefined ? '' : String(op.prazo_dias), sufixo: 'dias úteis', attrs: { inputmode: 'numeric', maxlength: '2' } }),
        ufs: ui.campo({ rotulo: 'Estados atendidos', nome: 'fixo_ufs', valor: Array.isArray(op.ufs) ? op.ufs.join(', ') : '', placeholder: 'Ex.: PA', ajuda: 'Siglas separadas por vírgula. Vazio = todo o Brasil.', attrs: { maxlength: '120', autocapitalize: 'characters' } }),
      };
      return item;
    }
    function desenharFixo({ focar } = {}) {
      if (!opcoesFixas.length) {
        listaFixo.replaceChildren(el('p', { class: 'texto-suave texto-pequeno' }, 'Nenhuma opção de frete fixo. Use "Adicionar opção".'));
      } else {
        listaFixo.replaceChildren(...opcoesFixas.map((item, i) => el('div', { class: 'config-fixo__item' },
          el('div', { class: 'config-fixo__topo' },
            el('p', { class: 'config-fixo__titulo' }, `Opção ${i + 1}`),
            ui.botao({ texto: 'Remover', tamanho: 'pequeno', tipo: 'fantasma', icone: 'lixeira', rotulo: `Remover a opção ${i + 1}`, aoClicar: () => removerFixo(i) })),
          item.nome.elemento,
          el('div', { class: 'formulario__linha' }, item.preco.elemento, item.prazo.elemento),
          item.ufs.elemento)));
      }
      if (focar !== undefined && opcoesFixas[focar]) opcoesFixas[focar].nome.entrada.focus();
    }
    function removerFixo(i) {
      opcoesFixas = opcoesFixas.filter((_, j) => j !== i);
      marcar('frete', true);
      desenharFixo();
      atualizarAviso();
    }
    const adicionarFixo = ui.botao({
      texto: 'Adicionar opção', icone: 'mais', tamanho: 'pequeno',
      aoClicar: () => {
        opcoesFixas.push(criarOpcaoFixa({ ufs: ['PA'], prazo_dias: 3 }));
        marcar('frete', true);
        desenharFixo({ focar: opcoesFixas.length - 1 });
        atualizarAviso();
      },
    });
    desenharFixo();
    const cartaoFixo = cartao('cf-fixo', 'Frete fixo', null, fixoAtivo.elemento, listaFixo, erroFixo, el('div', { class: 'grupo-botoes' }, adicionarFixo));

    // Frete grátis e embalagem
    const lojaGratis = Number.isSafeInteger(valores.loja.frete_gratis_acima_centavos) ? valores.loja.frete_gratis_acima_centavos : null;
    campos.frete_gratis_centavos = ui.campo({ rotulo: 'Frete grátis nas compras a partir de', nome: 'frete_gratis', tipo: 'preco', valor: lojaGratis, placeholder: 'Sem frete grátis', ajuda: 'Vazio = sem frete grátis. A entrega mais barata fica grátis e o carrinho mostra quanto falta.' });
    const medida = (campo, rotulo, sufixo, padrao) => {
      campos[`embalagem_padrao.${campo}`] = ui.campo({ rotulo, nome: `emb_${campo}`, sufixo, valor: formatarDecimal(emb[campo] ?? padrao), attrs: { inputmode: campo === 'peso_gramas' ? 'numeric' : 'decimal', maxlength: '7' } });
      return campos[`embalagem_padrao.${campo}`].elemento;
    };
    const cartaoGratis = cartao('cf-gratis', 'Frete grátis', null, campos.frete_gratis_centavos.elemento);
    const cartaoEmbalagem = cartao('cf-embalagem', 'Embalagem padrão', 'Usada no cálculo do frete dos produtos que estão sem peso ou medidas.',
      el('div', { class: 'config-medidas' },
        medida('peso_gramas', 'Peso', 'g', 300), medida('altura_cm', 'Altura', 'cm', 4),
        medida('largura_cm', 'Largura', 'cm', 12), medida('comprimento_cm', 'Comprimento', 'cm', 16)));

    function lerValores() {
      return {
        origem: Object.fromEntries(['nome', 'documento', 'telefone', 'email', 'cep', 'endereco', 'numero', 'complemento', 'bairro', 'cidade', 'uf'].map((k) => [k, campos[`origem.${k}`].ler()])),
        melhor_envio: {
          ativo: meAtivo.ler(), servicos: caixasServicos.filter((s) => s.campo.ler()).map((s) => s.id), seguro: seguro.ler(),
          prazo_extra_dias: campos['melhor_envio.prazo_extra_dias'].ler(), taxa_extra_centavos: precoDe(campos['melhor_envio.taxa_extra_centavos']),
        },
        fixo: {
          ativo: fixoAtivo.ler(),
          opcoes: opcoesFixas.map((item) => ({ id: item.id, nome: item.nome.ler(), preco_centavos: precoDe(item.preco), prazo_dias: item.prazo.ler(), ufs: item.ufs.ler() })),
        },
        embalagem_padrao: Object.fromEntries(['peso_gramas', 'altura_cm', 'largura_cm', 'comprimento_cm'].map((k) => [k, campos[`embalagem_padrao.${k}`].ler()])),
        frete_gratis_centavos: precoDe(campos.frete_gratis_centavos),
      };
    }

    function atualizarAviso() {
      const { frete } = validarFrete(lerValores());
      const configurado = integracoes && integracoes.melhor_envio ? integracoes.melhor_envio.configurado !== false : null;
      const d = diagnosticoEntrega(frete, configurado);
      avisoEntrega.replaceChildren(...(d.ok ? [] : [ui.aviso(d.mensagem, 'alerta', { titulo: 'Atenção às formas de entrega' })]));
    }

    const form = montarFormulario('frete', 'Frete', [
      avisoEntrega,
      el('div', { class: 'grade grade--painel' },
        el('div', { class: 'pilha' }, cartaoMe, cartaoFixo, cartaoGratis),
        el('div', { class: 'pilha' }, cartaoOrigem, cartaoEmbalagem)),
    ], async () => {
      const { erros, frete, freteGratisCentavos } = validarFrete(lerValores());
      // Erros das opções de frete fixo vão para os campos de cada opção.
      const camposComOpcoes = { ...campos };
      opcoesFixas.forEach((item, i) => {
        camposComOpcoes[`fixo.opcoes.${i}.nome`] = item.nome;
        camposComOpcoes[`fixo.opcoes.${i}.preco_centavos`] = item.preco;
        camposComOpcoes[`fixo.opcoes.${i}.prazo_dias`] = item.prazo;
        camposComOpcoes[`fixo.opcoes.${i}.ufs`] = item.ufs;
      });
      if (mostrarErros(erros, camposComOpcoes)) return MSG_ERROS;
      const r1 = await salvarChave('frete', frete);
      if (!ctx.ativo()) return false;
      if (!r1.ok) {
        ui.toast(r1.mensagem, 'erro');
        return false;
      }
      const r2 = await salvarChave('loja', { frete_gratis_acima_centavos: freteGratisCentavos });
      if (!ctx.ativo()) return false;
      if (!r2.ok) {
        ui.toast(`O frete foi salvo, mas o frete grátis não: ${r2.mensagem}`, 'erro');
        return false;
      }
      frete.fixo.opcoes.forEach((op, i) => { if (opcoesFixas[i]) opcoesFixas[i].id = op.id; });
      atualizarAviso();
      ui.toast('Configurações de frete salvas.', 'sucesso');
      return true;
    }, { info: 'O novo frete vale nas próximas cotações da loja (em até 1 minuto).' });
    form.addEventListener('change', atualizarAviso);
    atualizarAviso();
    form.atualizarAviso = atualizarAviso;
    return form;
  }

  // --- Aba Pagamento ------------------------------------------------------------
  function abaPagamento() {
    const v = valores.checkout;
    const parcelas = ui.campo({
      rotulo: 'Parcelas no cartão', nome: 'parcelas_max', tipo: 'select', valor: String(Number(v.parcelas_max) || 6),
      opcoes: Array.from({ length: 12 }, (_, i) => ({ valor: String(i + 1), rotulo: i === 0 ? 'Só à vista (1x)' : `Até ${i + 1}x` })),
      ajuda: 'Os juros do parcelamento seguem as regras da sua conta no Mercado Pago.',
    });
    const boleto = ui.campo({ rotulo: 'Aceitar boleto', nome: 'aceitar_boleto', tipo: 'interruptor', valor: v.aceitar_boleto !== false, ajuda: 'O boleto demora até 3 dias úteis para compensar. Pix e cartão continuam sempre ligados.' });
    const prazo = ui.campo({
      rotulo: 'Prazo para pagar', nome: 'prazo_dias', tipo: 'select', valor: String(diasDoPrazo(v.expiracao_horas)),
      opcoes: PRAZOS_PAGAMENTO_DIAS.map((d) => ({ valor: String(d), rotulo: `${d} dias` })),
      ajuda: 'Depois disso o link de pagamento do pedido vence. O Mercado Pago pede no mínimo 3 dias por causa do Pix e do boleto.',
    });
    const c = { parcelas_max: parcelas, prazo_dias: prazo };
    return montarFormulario('pagamento', 'Pagamento', [
      cartao('cf-pagamento', 'Formas de pagamento', null, parcelas.elemento, boleto.elemento, prazo.elemento),
    ], async () => {
      const { erros, valor } = validarCheckout({ parcelas_max: parcelas.ler(), aceitar_boleto: boleto.ler(), prazo_dias: prazo.ler() });
      if (mostrarErros(erros, c)) return MSG_ERROS;
      const resp = await salvarChave('checkout', valor);
      if (!ctx.ativo()) return false;
      if (!resp.ok) {
        ui.toast(resp.mensagem, 'erro');
        return false;
      }
      ui.toast('Pagamento salvo. Vale para os próximos pedidos.', 'sucesso');
      return true;
    }, { info: 'Vale para os próximos pedidos.' });
  }

  // --- Aba Avisos ---------------------------------------------------------------
  function abaAvisos() {
    const v = valores.notificacoes;
    const email = ui.campo({
      rotulo: 'E-mails da equipe', nome: 'email_admin', valor: v.email_admin || '', placeholder: 'loja@ama.org.br',
      ajuda: 'Recebem um aviso a cada pedido pago. Para mais de um, separe com vírgula (até 5). Vazio = ninguém recebe.',
      attrs: { inputmode: 'email', autocomplete: 'off', maxlength: '800' },
    });
    return montarFormulario('avisos', 'Avisos por e-mail', [
      cartao('cf-email', 'Avisos de pedidos novos', null, email.elemento),
    ], async () => {
      const { erros, valor } = validarNotificacoes({ email_admin: email.ler() });
      if (mostrarErros(erros, { email_admin: email })) return MSG_ERROS;
      const resp = await salvarChave('notificacoes', valor);
      if (!ctx.ativo()) return false;
      if (!resp.ok) {
        ui.toast(resp.mensagem, 'erro');
        return false;
      }
      email.entrada.value = valor.email_admin;
      ui.toast('Avisos salvos.', 'sucesso');
      return true;
    });
  }

  // A situação do Melhor Envio só serve para o aviso da aba Frete (nada de integrações na tela).
  async function carregarIntegracoes() {
    const resp = await api.chamarApi('/api/admin/status', { sinal: ctx.sinal });
    if (!resp || !ctx.ativo() || !resp.ok || !resp.integracoes) return;
    integracoes = resp.integracoes;
    if (formFrete && formFrete.atualizarAviso) formFrete.atualizarAviso();
  }

  // --- Montagem -----------------------------------------------------------------
  const formFrete = abaFrete();
  const abaInicial = ABAS.includes(ctx.consulta && ctx.consulta.aba) ? ctx.consulta.aba : 'loja';
  const abas = ui.abas({
    rotulo: 'Partes das configurações',
    ativa: abaInicial,
    aoTrocar: (id) => ctx.navegar(`#/configuracoes?aba=${id}`, { silencioso: true }),
    abas: [
      { id: 'loja', rotulo: 'Loja', icone: 'loja', conteudo: abaLoja() },
      { id: 'frete', rotulo: 'Frete', icone: 'caminhao', conteudo: formFrete },
      { id: 'pagamento', rotulo: 'Pagamento', icone: 'cartao', conteudo: abaPagamento() },
      { id: 'avisos', rotulo: 'Avisos por e-mail', icone: 'email', conteudo: abaAvisos() },
    ],
  });
  corpo.replaceChildren(abas.elemento);
  carregarIntegracoes();
  return undefined;
}
