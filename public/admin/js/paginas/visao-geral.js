// #/ — Visão geral: pedidos que pedem ação, vendas do mês, situação do catálogo, últimos pedidos,
// status das integrações (GET /api/admin/status) e atalhos.

const STATUS_VENDIDO = ['pago', 'em_separacao', 'enviado', 'entregue'];
const FUSO = 'America/Belem';

/** Início do mês corrente no horário de Belém (UTC−3, sem horário de verão), em ISO sem milissegundos. */
export function inicioDoMes(agora = new Date()) {
  const partes = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: FUSO, year: 'numeric', month: '2-digit' }).formatToParts(agora)) {
    partes[p.type] = p.value;
  }
  const inicio = new Date(Date.UTC(Number(partes.year), Number(partes.month) - 1, 1, 3, 0, 0));
  return inicio.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function nomeDoMes(agora = new Date()) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, month: 'long' }).format(agora);
}

/** Resumo do catálogo a partir das linhas de produtos. */
export function resumirProdutos(produtos) {
  const r = { total: 0, ativos: 0, rascunhos: 0, semPreco: 0, semEstoque: 0, estoqueBaixo: 0 };
  for (const p of produtos || []) {
    r.total += 1;
    if (!p.ativo) {
      r.rascunhos += 1;
      continue;
    }
    r.ativos += 1;
    const preco = p.preco_promocional_centavos ?? p.preco_centavos;
    if (!(Number(preco) > 0)) r.semPreco += 1;
    if (p.controlar_estoque) {
      if (Number(p.estoque) <= 0) r.semEstoque += 1;
      else if (Number(p.estoque) <= 3) r.estoqueBaixo += 1;
    }
  }
  return r;
}

export async function renderizar(ctx) {
  const { ui, api, supabase } = ctx;
  const { el, icone } = ui;
  const agora = new Date();
  const mes = nomeDoMes(agora);

  const cabecalho = ui.cabecalhoPagina({
    titulo: 'Visão geral',
    descricao: `Resumo da loja e do site · ${ui.formatarData(agora, { hora: false })}`,
    acoes: [
      ui.botao({ texto: 'Ver loja', tipo: 'secundario', iconeDireita: 'externo', href: '/loja/', attrs: { target: '_blank', rel: 'noopener' } }),
      ui.botao({ texto: 'Novo produto', tipo: 'primario', icone: 'mais', href: '#/produtos/novo' }),
    ],
  });

  const metricas = el('div', { class: 'metricas' });
  const ultimos = el('div', { class: 'cartao__corpo cartao__corpo--sem-espaco' });
  const catalogo = el('div', { class: 'cartao__corpo' });
  const integracoes = el('div', { class: 'cartao__corpo' });

  const atalhos = el('div', { class: 'atalhos' },
    [
      { texto: 'Editar o site', detalhe: 'Textos, fotos e vídeos da página inicial', icone: 'conteudo', href: '#/conteudo' },
      { texto: 'Novo produto', detalhe: 'Cadastrar um item na loja', icone: 'produtos', href: '#/produtos/novo' },
      { texto: 'Pedidos para enviar', detalhe: 'Pagos e em separação', icone: 'caminhao', href: '#/pedidos?status=para_enviar' },
      { texto: 'Ver a loja', detalhe: 'Abre em outra aba', icone: 'loja', href: '/loja/', externo: true },
    ].map((a) => el('a', {
      class: 'atalho', href: a.href, target: a.externo ? '_blank' : null, rel: a.externo ? 'noopener' : null,
    }, el('span', { class: 'atalho__icone' }, icone(a.icone)),
    el('span', { class: 'atalho__textos' }, el('span', { class: 'atalho__titulo' }, a.texto), el('span', { class: 'atalho__detalhe' }, a.detalhe)),
    icone(a.externo ? 'externo' : 'avancar', { classe: 'atalho__seta' }))));

  ctx.raiz.append(
    cabecalho,
    metricas,
    el('div', { class: 'grade grade--painel' },
      el('section', { class: 'cartao', 'aria-labelledby': 'vg-ultimos' },
        el('div', { class: 'cartao__cabecalho' },
          el('h2', { class: 'cartao__titulo', id: 'vg-ultimos' }, 'Últimos pedidos'),
          el('a', { class: 'cartao__link', href: '#/pedidos' }, 'Ver todos', icone('avancar'))),
        ultimos),
      el('div', { class: 'pilha' },
        el('section', { class: 'cartao', 'aria-labelledby': 'vg-atalhos' },
          el('div', { class: 'cartao__cabecalho' }, el('h2', { class: 'cartao__titulo', id: 'vg-atalhos' }, 'Atalhos')),
          el('div', { class: 'cartao__corpo cartao__corpo--sem-espaco' }, atalhos)),
        el('section', { class: 'cartao', 'aria-labelledby': 'vg-catalogo' },
          el('div', { class: 'cartao__cabecalho' },
            el('h2', { class: 'cartao__titulo', id: 'vg-catalogo' }, 'Catálogo'),
            el('a', { class: 'cartao__link', href: '#/produtos' }, 'Produtos', icone('avancar'))),
          catalogo))),
    el('section', { class: 'cartao', 'aria-labelledby': 'vg-integracoes' },
      el('div', { class: 'cartao__cabecalho' },
        el('h2', { class: 'cartao__titulo', id: 'vg-integracoes' }, 'Integrações'),
        el('p', { class: 'cartao__subtitulo' }, 'O que está ligado e o que falta configurar')),
      integracoes),
  );

  // Esqueletos enquanto carrega.
  metricas.append(...[1, 2, 3, 4].map(() => el('div', { class: 'metrica metrica--carregando' }, el('div', { class: 'esqueleto esqueleto--linha', style: { width: '55%' } }), el('div', { class: 'esqueleto esqueleto--titulo' }))));
  ui.estadoCarregando(ultimos, { linhas: 5, tipo: 'tabela' });
  ui.estadoCarregando(catalogo, { linhas: 3 });
  ui.estadoCarregando(integracoes, { linhas: 4 });

  const inicio = inicioDoMes(agora);
  const contar = (filtro) => api.consultar(filtro(supabase.from('pedidos').select('id', { count: 'exact', head: true })));

  const [aEnviar, aguardando, emAnalise, vendas, recentes, produtos] = await Promise.all([
    contar((q) => q.in('status', ['pago', 'em_separacao'])),
    contar((q) => q.eq('status', 'aguardando_pagamento')),
    contar((q) => q.eq('status', 'pagamento_em_analise')),
    api.consultar(supabase.from('pedidos').select('total_centavos')
      .in('status', STATUS_VENDIDO)
      .or(`pago_em.gte."${inicio}",and(pago_em.is.null,criado_em.gte."${inicio}")`)
      .limit(5000)),
    api.consultar(supabase.from('pedidos').select('id, numero, cliente_nome, total_centavos, status, criado_em')
      .order('criado_em', { ascending: false }).limit(6)),
    api.consultar(supabase.from('produtos').select('id, ativo, preco_centavos, preco_promocional_centavos, estoque, controlar_estoque')),
  ]);
  if (!ctx.ativo()) return;

  // Métricas
  const somaVendas = vendas.ok ? vendas.dados.reduce((s, p) => s + (Number(p.total_centavos) || 0), 0) : null;
  const resumo = produtos.ok ? resumirProdutos(produtos.dados) : null;
  const valor = (r, f) => (r.ok ? f(r) : '—');
  const metrica = ({ rotulo, valor: v, detalhe, href, icone: nome, destaque }) => el(href ? 'a' : 'div', {
    class: ['metrica', destaque && 'metrica--destaque'], href,
  }, el('span', { class: 'metrica__rotulo' }, icone(nome), rotulo),
  el('span', { class: 'metrica__valor' }, v),
  detalhe ? el('span', { class: 'metrica__detalhe' }, detalhe) : null);
  const totalAEnviar = aEnviar.ok ? aEnviar.total || 0 : null;
  metricas.replaceChildren(
    metrica({
      rotulo: 'Pedidos para enviar', icone: 'caminhao', href: '#/pedidos?status=para_enviar', destaque: totalAEnviar > 0,
      valor: valor(aEnviar, (r) => String(r.total || 0)),
      detalhe: totalAEnviar ? 'Pagos, aguardando separação ou envio' : 'Nenhum pedido esperando envio',
    }),
    metrica({
      rotulo: 'Aguardando pagamento', icone: 'relogio', href: '#/pedidos?status=aguardando_pagamento',
      valor: valor(aguardando, (r) => String(r.total || 0)),
      detalhe: emAnalise.ok && emAnalise.total ? `${emAnalise.total} em análise no Mercado Pago` : 'Pix e boleto ainda não pagos',
    }),
    metrica({
      rotulo: `Vendas em ${mes}`, icone: 'dinheiro',
      valor: somaVendas === null ? '—' : ui.formatarPreco(somaVendas),
      detalhe: vendas.ok ? `${vendas.dados.length} ${vendas.dados.length === 1 ? 'pedido pago' : 'pedidos pagos'} no mês` : vendas.mensagem,
    }),
    metrica({
      rotulo: 'Produtos à venda', icone: 'produtos', href: '#/produtos',
      valor: resumo ? String(resumo.ativos) : '—',
      detalhe: resumo ? `${resumo.rascunhos} ${resumo.rascunhos === 1 ? 'rascunho' : 'rascunhos'} (fora da loja)` : produtos.mensagem,
    }),
  );

  // "Tentar novamente": renderiza a visão geral de novo (navegar para o próprio hash).
  const recarregar = () => ctx.navegar(ctx.hash, { substituir: true });

  // Últimos pedidos
  if (!recentes.ok) {
    ui.estadoErro(ultimos, recentes.mensagem, { aoTentarNovamente: recarregar });
  } else if (!recentes.dados.length) {
    ui.estadoVazio(ultimos, 'Quando alguém comprar na loja, o pedido aparece aqui.', { titulo: 'Nenhum pedido ainda', icone: 'pedidos' });
  } else {
    ultimos.replaceChildren(ui.tabela({
      legenda: 'Últimos pedidos',
      linhas: recentes.dados,
      link: (p) => `#/pedidos/${p.id}`,
      colunas: [
        { titulo: 'Pedido', principal: true, celula: (p) => ui.formatarNumeroPedido(p.numero) },
        { titulo: 'Cliente', celula: (p) => p.cliente_nome, classe: 'truncar' },
        { titulo: 'Total', alinhar: 'direita', celula: (p) => ui.formatarPreco(p.total_centavos) },
        { titulo: 'Status', celula: (p) => ui.seloStatusPedido(p.status) },
        { titulo: 'Quando', celula: (p) => el('time', { datetime: p.criado_em, title: ui.formatarData(p.criado_em) }, ui.tempoRelativo(p.criado_em)) },
      ],
    }));
  }

  // Catálogo
  if (!resumo) {
    ui.estadoErro(catalogo, produtos.mensagem, { aoTentarNovamente: recarregar });
  } else {
    const linhas = [];
    if (resumo.semPreco) {
      linhas.push(ui.aviso(
        `${resumo.semPreco} ${resumo.semPreco === 1 ? 'produto à venda está' : 'produtos à venda estão'} sem preço: aparecem na loja com R$ 00,00 e ninguém consegue finalizar a compra até você definir o preço.`,
        'alerta', { titulo: 'Sem preço' },
      ));
    }
    if (resumo.semEstoque) {
      linhas.push(ui.aviso(`${resumo.semEstoque} ${resumo.semEstoque === 1 ? 'produto está esgotado' : 'produtos estão esgotados'} (estoque zero).`, 'alerta', { titulo: 'Sem estoque' }));
    }
    if (resumo.estoqueBaixo) {
      linhas.push(ui.aviso(`${resumo.estoqueBaixo} ${resumo.estoqueBaixo === 1 ? 'produto tem' : 'produtos têm'} 3 unidades ou menos.`, 'info', { titulo: 'Estoque baixo' }));
    }
    if (!linhas.length) linhas.push(ui.aviso('Todos os produtos à venda têm preço e estoque.', 'sucesso'));
    catalogo.replaceChildren(el('dl', { class: 'lista-dados lista-dados--colunas' },
      el('div', {}, el('dt', {}, 'À venda'), el('dd', {}, String(resumo.ativos))),
      el('div', {}, el('dt', {}, 'Rascunhos'), el('dd', {}, String(resumo.rascunhos))),
      el('div', {}, el('dt', {}, 'Sem preço'), el('dd', {}, String(resumo.semPreco))),
      el('div', {}, el('dt', {}, 'Sem estoque'), el('dd', {}, String(resumo.semEstoque)))),
    el('div', { class: 'pilha pilha--estreita' }, linhas));
  }

  // Integrações (pode demorar: consulta o saldo do Melhor Envio)
  carregarIntegracoes(ctx, integracoes);
  return undefined;
}

function itemIntegracao(ui, { nome, icone: nomeIcone, cor, estado, texto }) {
  const { el, icone } = ui;
  return el('li', { class: 'integracao' },
    el('span', { class: ['integracao__icone', `integracao__icone--${cor}`] }, icone(nomeIcone)),
    el('div', { class: 'integracao__textos' },
      el('p', { class: 'integracao__nome' }, nome, el('span', { class: ['selo', `selo--${cor}`] }, estado)),
      el('p', { class: 'integracao__texto' }, texto)));
}

/** Linhas da lista de integrações a partir de GET /api/admin/status (função pura, testável). */
export function descreverIntegracoes(integracoes, formatarPreco) {
  const i = integracoes || {};
  const itens = [];
  const supa = i.supabase || {};
  itens.push(supa.configurado
    ? { nome: 'Banco de dados (Supabase)', icone: 'banco', cor: 'verde', estado: 'Funcionando', texto: 'Conteúdo do site, produtos, pedidos e arquivos estão ligados.' }
    : { nome: 'Banco de dados (Supabase)', icone: 'banco', cor: 'vermelho', estado: 'Incompleto', texto: 'Falta a chave secreta (SUPABASE_SERVICE_ROLE_KEY) na Vercel: sem ela a loja não registra pedidos.' });

  const mp = i.mercadopago || {};
  if (!mp.configurado) {
    itens.push({ nome: 'Pagamentos (Mercado Pago)', icone: 'cartao', cor: 'vermelho', estado: 'Não configurado', texto: 'Sem MP_ACCESS_TOKEN a loja não consegue cobrar: o cliente vê "pagamento indisponível".' });
  } else if (mp.modo === 'teste') {
    itens.push({ nome: 'Pagamentos (Mercado Pago)', icone: 'cartao', cor: 'ambar', estado: 'Modo teste', texto: 'Usando credenciais de teste: troque pelas de produção (e MP_MODO) antes de vender de verdade.' });
  } else {
    itens.push({ nome: 'Pagamentos (Mercado Pago)', icone: 'cartao', cor: 'verde', estado: 'Ativo', texto: 'Pix, cartão e boleto pelo Checkout do Mercado Pago.' });
  }
  if (mp.configurado) {
    itens.push(i.webhook_assinatura
      ? { nome: 'Avisos de pagamento', icone: 'escudo', cor: 'verde', estado: 'Protegidos', texto: 'Os avisos do Mercado Pago são conferidos com a assinatura secreta.' }
      : { nome: 'Avisos de pagamento', icone: 'escudo', cor: 'ambar', estado: 'Recomendado', texto: 'Defina MP_WEBHOOK_SECRET (Mercado Pago → Suas integrações → Webhooks → assinatura secreta) para conferir cada aviso.' });
  }

  const me = i.melhor_envio || {};
  const ambiente = me.ambiente === 'sandbox' ? ' (sandbox)' : '';
  if (!me.configurado) {
    itens.push({ nome: 'Fretes (Melhor Envio)', icone: 'caminhao', cor: 'ambar', estado: 'Recomendado', texto: 'Sem MELHOR_ENVIO_TOKEN a loja oferece só o frete fixo (ligue em Configurações → Frete); sem nenhum dos dois, ninguém consegue finalizar a compra.' });
  } else if (me.erro) {
    itens.push({ nome: 'Fretes (Melhor Envio)', icone: 'caminhao', cor: 'vermelho', estado: 'Com erro', texto: `Não foi possível consultar a conta${ambiente}: ${me.erro} Confira o token.` });
  } else {
    const saldo = typeof me.saldo_centavos === 'number' ? formatarPreco(me.saldo_centavos) : '—';
    const pouco = typeof me.saldo_centavos === 'number' && me.saldo_centavos < 3000;
    itens.push({
      nome: 'Fretes (Melhor Envio)', icone: 'caminhao', cor: pouco ? 'ambar' : 'verde', estado: pouco ? 'Saldo baixo' : 'Ativo',
      texto: `Saldo para etiquetas${ambiente}: ${saldo}.${pouco ? ' Adicione saldo no Melhor Envio antes de comprar etiquetas.' : ''}`,
    });
  }

  const email = i.email || {};
  itens.push(email.configurado
    ? { nome: 'E-mails da loja', icone: 'email', cor: 'verde', estado: 'Ativo', texto: 'Clientes e equipe recebem os e-mails de pedido pago, enviado e entregue.' }
    : { nome: 'E-mails da loja', icone: 'email', cor: 'cinza', estado: 'Opcional', texto: 'Sem RESEND_API_KEY os e-mails de pedido não são enviados (o cliente acompanha pela página do pedido).' });
  return itens;
}

async function carregarIntegracoes(ctx, container) {
  const { ui, api } = ctx;
  const { el } = ui;
  const r = await api.chamarApi('/api/admin/status', { sinal: ctx.sinal });
  if (!ctx.ativo()) return;
  if (!r.ok) {
    ui.estadoErro(container, r.mensagem, { titulo: 'Não foi possível consultar as integrações', aoTentarNovamente: () => {
      ui.estadoCarregando(container, { linhas: 4 });
      carregarIntegracoes(ctx, container);
    } });
    return;
  }
  const integ = r.integracoes || {};
  const lista = el('ul', { class: 'integracoes' }, descreverIntegracoes(integ, ui.formatarPreco).map((item) => itemIntegracao(ui, item)));
  const extras = [];
  if (integ.site_url) {
    const https = /^https:\/\//.test(integ.site_url);
    extras.push(el('p', { class: 'texto-pequeno texto-suave integracoes__site' }, 'Endereço do site: ', el('span', { class: 'mono' }, integ.site_url)));
    if (!https) {
      extras.push(ui.aviso('Sem https o Mercado Pago não avisa os pagamentos automaticamente (normal só em testes locais). Em produção defina SITE_URL com https://.', 'info'));
    }
  }
  container.replaceChildren(lista, ...extras);
}
