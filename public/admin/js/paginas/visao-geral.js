// #/ — Visão geral (abre pela logo do menu): pedidos que pedem ação, vendas do mês, últimos pedidos e catálogo.

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
    ],
  });

  const metricas = el('div', { class: 'metricas' });
  const ultimos = el('div', { class: 'cartao__corpo cartao__corpo--sem-espaco' });
  const catalogo = el('div', { class: 'cartao__corpo' });

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
        el('section', { class: 'cartao', 'aria-labelledby': 'vg-catalogo' },
          el('div', { class: 'cartao__cabecalho' },
            el('h2', { class: 'cartao__titulo', id: 'vg-catalogo' }, 'Catálogo'),
            el('a', { class: 'cartao__link', href: '#/produtos' }, 'Produtos', icone('avancar'))),
          catalogo))),
  );

  // Esqueletos enquanto carrega.
  metricas.append(...[1, 2, 3, 4].map(() => el('div', { class: 'metrica metrica--carregando' }, el('div', { class: 'esqueleto esqueleto--linha', style: { width: '55%' } }), el('div', { class: 'esqueleto esqueleto--titulo' }))));
  ui.estadoCarregando(ultimos, { linhas: 5, tipo: 'tabela' });
  ui.estadoCarregando(catalogo, { linhas: 3 });

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

  return undefined;
}
