// Peças do resumo de compra usadas no carrinho e no checkout: totais, cupom, opções de frete e
// aviso de frete grátis. Os valores exibidos são sempre os da cotação do servidor.

import { el, icone } from './comum.js';
import { formatarPreco, formatarPrazo } from './formatos.js';

/** Opção de frete escolhida dentro da cotação (ou null). */
export function opcaoEscolhida(cotacao, freteId) {
  const opcoes = cotacao && cotacao.frete && Array.isArray(cotacao.frete.opcoes) ? cotacao.frete.opcoes : [];
  return opcoes.find((o) => o.id === freteId) || null;
}

/** Total exibido: subtotal − desconto + frete escolhido (todos números do servidor). */
export function totalExibido(cotacao, opcao) {
  if (!cotacao) return 0;
  const frete = opcao ? opcao.preco_centavos : 0;
  return Math.max(0, cotacao.subtotal_centavos - cotacao.desconto_centavos + frete);
}

function textoFrete(opcao) {
  if (!opcao) return null;
  if (opcao.preco_centavos === 0) return opcao.tipo === 'retirada' ? 'Sem custo' : 'Grátis';
  return formatarPreco(opcao.preco_centavos);
}

/**
 * Lista de totais (dl). opcao: opção de frete escolhida | null (frete ainda não calculado).
 * semFreteTexto: o que mostrar no frete sem opção ("Calcule no carrinho", "Informe o CEP"…).
 */
export function blocoTotais(cotacao, opcao, { semFreteTexto = 'Calcule abaixo', atualizando = false } = {}) {
  const linhas = [];
  const linha = (rotulo, valor, classe = '') => linhas.push(
    el('div', { class: `totais-linha${classe ? ` ${classe}` : ''}` }, el('dt', {}, ...[].concat(rotulo)), el('dd', {}, ...[].concat(valor))),
  );
  linha('Subtotal', formatarPreco(cotacao.subtotal_centavos));
  if (cotacao.desconto_centavos > 0) {
    const codigo = cotacao.cupom && cotacao.cupom.valido ? cotacao.cupom.codigo : '';
    linha(codigo ? ['Desconto ', el('span', { class: 'totais-cupom', texto: codigo })] : 'Desconto',
      `− ${formatarPreco(cotacao.desconto_centavos)}`, 'totais-linha--desconto');
  }
  if (opcao) {
    linha(['Frete', el('span', { class: 'totais-detalhe', texto: opcao.nome })], textoFrete(opcao),
      opcao.preco_centavos === 0 ? 'totais-linha--gratis' : '');
  } else {
    linha('Frete', el('span', { class: 'totais-pendente', texto: semFreteTexto }));
  }
  linha(opcao ? 'Total' : 'Total sem frete', formatarPreco(totalExibido(cotacao, opcao)), 'totais-linha--total');
  return el('dl', { class: `totais${atualizando ? ' totais--atualizando' : ''}`, 'aria-busy': atualizando ? 'true' : 'false' }, ...linhas);
}

/** Aviso de frete grátis acima de X (ou cupom de frete grátis). null se não se aplica. */
export function avisoFreteGratis(cotacao) {
  if (!cotacao) return null;
  if (cotacao.frete_gratis_cupom) {
    return el('p', { class: 'aviso-frete aviso-frete--ok' }, icone('presente'), 'Cupom de frete grátis aplicado na entrega mais barata.');
  }
  const limite = Number(cotacao.frete_gratis_acima_centavos);
  if (!Number.isInteger(limite) || limite <= 0) return null;
  const base = cotacao.subtotal_centavos - cotacao.desconto_centavos;
  if (base >= limite) {
    return el('p', { class: 'aviso-frete aviso-frete--ok' }, icone('presente'), 'Você ganhou frete grátis na entrega mais barata!');
  }
  const falta = limite - base;
  const progresso = Math.max(4, Math.min(100, Math.round((base / limite) * 100)));
  return el('div', { class: 'aviso-frete' },
    el('p', {}, icone('caminhao'), el('span', {}, 'Faltam ', el('strong', { texto: formatarPreco(falta) }), ' para ganhar frete grátis')),
    el('div', {
      class: 'aviso-frete-barra', role: 'progressbar', 'aria-label': 'Progresso para o frete grátis',
      'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(progresso),
    }, el('span', { style: `width:${progresso}%` })));
}

/**
 * Opções de frete como botões de rádio. aoEscolher(id) é chamado na mudança.
 * Devolve o contêiner (role=radiogroup é do chamador).
 */
export function listaOpcoesFrete(opcoes, freteId, aoEscolher, { nome = 'frete' } = {}) {
  return opcoes.map((o) => {
    const marcado = o.id === freteId;
    const radio = el('input', {
      type: 'radio', name: nome, value: o.id, checked: marcado,
      onchange: () => aoEscolher(o.id),
    });
    const preco = o.preco_centavos === 0
      ? el('span', { class: 'opcao-frete-preco opcao-frete-preco--gratis' },
        o.gratis && o.preco_original_centavos > 0
          ? el('s', {}, el('span', { class: 'sr-only', texto: 'De ' }), formatarPreco(o.preco_original_centavos)) : null,
        o.tipo === 'retirada' ? 'Sem custo' : 'Grátis')
      : el('span', { class: 'opcao-frete-preco', texto: formatarPreco(o.preco_centavos) });
    return el('label', { class: `opcao-frete${marcado ? ' opcao-frete--marcada' : ''}` },
      radio,
      el('span', { class: 'opcao-frete-icone' }, icone(o.tipo === 'retirada' ? 'local' : 'caminhao')),
      el('span', { class: 'opcao-frete-texto' },
        el('span', { class: 'opcao-frete-nome' },
          o.nome, o.empresa ? el('span', { class: 'opcao-frete-empresa', texto: ` · ${o.empresa}` }) : null),
        el('span', { class: 'opcao-frete-prazo', texto: formatarPrazo(o) })),
      preco);
  });
}

/**
 * Campo de cupom (sem <form>, para poder ficar dentro do formulário do checkout).
 * estado: { aplicado: {codigo, mensagem} | null, mensagem: {tipo, texto} | null, ocupado }
 * aoAplicar(codigo), aoRemover().
 */
export function blocoCupom({ aplicado, mensagem, ocupado = false, id = 'cupom' }, { aoAplicar, aoRemover }) {
  if (aplicado) {
    return el('div', { class: 'cupom cupom--aplicado' },
      el('p', { class: 'cupom-aplicado' },
        icone('etiqueta'),
        el('span', {}, el('strong', { texto: aplicado.codigo }), aplicado.mensagem ? el('span', { class: 'cupom-aplicado-texto', texto: aplicado.mensagem }) : null)),
      el('button', {
        type: 'button', class: 'cupom-remover', disabled: ocupado, 'aria-label': `Remover o cupom ${aplicado.codigo}`, onclick: aoRemover,
      }, 'Remover'));
  }
  const input = el('input', {
    id, type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '30',
    placeholder: 'Ex.: AMA10', 'aria-describedby': `${id}-mensagem`,
    'aria-invalid': mensagem && mensagem.tipo === 'erro' ? 'true' : null,
  });
  const aplicar = () => {
    const codigo = input.value.trim().toUpperCase();
    if (codigo) aoAplicar(codigo);
    else input.focus();
  };
  input.addEventListener('keydown', (evento) => {
    if (evento.key === 'Enter') {
      evento.preventDefault();
      aplicar();
    }
  });
  return el('div', { class: 'cupom' },
    el('label', { for: id, class: 'cupom-rotulo' }, icone('etiqueta'), 'Cupom de desconto'),
    el('div', { class: 'campo-com-acao' },
      input,
      el('button', { type: 'button', class: 'botao botao--fantasma botao--sm', disabled: ocupado, onclick: aplicar }, 'Aplicar')),
    el('p', {
      id: `${id}-mensagem`,
      class: `cupom-mensagem${mensagem ? ` cupom-mensagem--${mensagem.tipo}` : ''}`,
      role: mensagem && mensagem.tipo === 'erro' ? 'alert' : null,
      texto: mensagem ? mensagem.texto : '',
      hidden: !mensagem,
    }));
}
