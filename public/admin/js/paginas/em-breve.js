// Página provisória: o app.js usa esta quando paginas/<nome>.js ainda não existe (import com 404).

const DESCRICOES = {
  conteudo: 'Textos, imagens, vídeos e links da página inicial.',
  midia: 'Biblioteca de imagens e vídeos do site e da loja.',
  produtos: 'Cadastro de produtos, preços, estoque e fotos.',
  categorias: 'Organização dos produtos da loja.',
  pedidos: 'Pedidos da loja, pagamentos e envios.',
  cupons: 'Cupons de desconto e de frete grátis.',
  configuracoes: 'Dados da loja, frete, pagamento e avisos.',
};

export async function renderizar(ctx) {
  const { ui } = ctx;
  ctx.raiz.append(
    ui.cabecalhoPagina({ titulo: ctx.titulo || 'Em breve', descricao: DESCRICOES[ctx.rota] || '' }),
    ui.estadoVazio(null, 'Esta seção do painel está sendo preparada e logo estará disponível.', {
      titulo: 'Em breve por aqui',
      icone: 'relogio',
      acao: { texto: 'Voltar para a visão geral', href: '#/', icone: 'inicio', tipo: 'secundario' },
    }),
  );
}
