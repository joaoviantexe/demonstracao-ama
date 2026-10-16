// Rotas /api/* do Worker: uma entrada por arquivo de api/ (o teste tests/unit/worker.test.js confere
// que nenhum arquivo ficou de fora). Ao criar uma função nova em api/, acrescente-a aqui.

import adminEnvio from '../api/admin/envio.js';
import adminHome from '../api/admin/home.js';
import adminMidia from '../api/admin/midia.js';
import adminPagamento from '../api/admin/pagamento.js';
import adminPedidoStatus from '../api/admin/pedido-status.js';
import adminStatus from '../api/admin/status.js';
import config from '../api/config.js';
import cronManterAtivo from '../api/cron/manter-ativo.js';
import lojaCheckout from '../api/loja/checkout.js';
import lojaCotacao from '../api/loja/cotacao.js';
import lojaPedido from '../api/loja/pedido.js';
import render from '../api/render.js';
import webhookMercadoPago from '../api/webhooks/mercadopago.js';

export const ROTAS = Object.freeze({
  '/api/admin/envio': adminEnvio,
  '/api/admin/home': adminHome,
  '/api/admin/midia': adminMidia,
  '/api/admin/pagamento': adminPagamento,
  '/api/admin/pedido-status': adminPedidoStatus,
  '/api/admin/status': adminStatus,
  '/api/config': config,
  '/api/cron/manter-ativo': cronManterAtivo,
  '/api/loja/checkout': lojaCheckout,
  '/api/loja/cotacao': lojaCotacao,
  '/api/loja/pedido': lojaPedido,
  '/api/render': render,
  '/api/webhooks/mercadopago': webhookMercadoPago,
});
