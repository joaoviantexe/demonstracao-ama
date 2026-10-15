// Variáveis de ambiente normalizadas (docs/ARQUITETURA.md §3).
// obterAmbiente() lê process.env a cada chamada: os testes mudam o ambiente em tempo de execução.

/**
 * @typedef {object} Ambiente
 * @property {string} supabaseUrl          SUPABASE_URL | NEXT_PUBLIC_SUPABASE_URL (sem barra final)
 * @property {string} supabaseAnonKey      SUPABASE_ANON_KEY | SUPABASE_PUBLISHABLE_KEY | NEXT_PUBLIC_SUPABASE_ANON_KEY | NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
 *                                         (uma chave secreta posta aqui por engano é ignorada: ver ehChaveSecreta)
 * @property {boolean} supabaseAnonKeyRecusada  alguma dessas variáveis tinha uma chave secreta (ignorada e logada)
 * @property {string} supabaseServiceKey   SUPABASE_SERVICE_ROLE_KEY | SUPABASE_SECRET_KEY (só servidor)
 * @property {string} siteUrl              origem de SITE_URL | VERCEL_PROJECT_PRODUCTION_URL ('' se nenhuma válida;
 *                                         ver normalizarUrlSite: sem esquema assume https://, sem caminho nem barra final)
 * @property {string} mpAccessToken        MP_ACCESS_TOKEN
 * @property {string} mpWebhookSecret      MP_WEBHOOK_SECRET
 * @property {string} melhorEnvioToken     MELHOR_ENVIO_TOKEN
 * @property {'producao'|'sandbox'} melhorEnvioAmbiente  MELHOR_ENVIO_AMBIENTE (padrão 'producao')
 * @property {string} melhorEnvioEmail     MELHOR_ENVIO_EMAIL
 * @property {string} resendApiKey         RESEND_API_KEY
 * @property {string} cronSecret           CRON_SECRET
 * @property {string} emailRemetente       EMAIL_REMETENTE
 * @property {string} mpApiBase            MP_API_BASE | https://api.mercadopago.com
 * @property {string} melhorEnvioApiBase   MELHOR_ENVIO_API_BASE | https://melhorenvio.com.br | https://sandbox.melhorenvio.com.br
 * @property {string} resendApiBase        RESEND_API_BASE | https://api.resend.com
 * @property {boolean} supabasePublicoConfigurado  URL + chave pública (o navegador e a home conseguem ler)
 * @property {boolean} supabaseServicoConfigurado  URL + chave de serviço (as funções conseguem gravar)
 * @property {boolean} supabaseConfigurado         URL + chave pública + chave de serviço
 * @property {boolean} mercadoPagoConfigurado      MP_ACCESS_TOKEN presente
 * @property {boolean} melhorEnvioConfigurado      MELHOR_ENVIO_TOKEN presente
 * @property {boolean} emailConfigurado            RESEND_API_KEY presente
 *
 * O objeto também traz as mesmas informações com os nomes da tabela da §3
 * (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SITE_URL, MP_ACCESS_TOKEN,
 * MP_WEBHOOK_SECRET, MELHOR_ENVIO_TOKEN, MELHOR_ENVIO_AMBIENTE, MELHOR_ENVIO_EMAIL,
 * RESEND_API_KEY, CRON_SECRET, EMAIL_REMETENTE, MP_API_BASE, MELHOR_ENVIO_API_BASE,
 * RESEND_API_BASE), já com os aliases resolvidos. Valores ausentes são ''.
 */

const MP_API_BASE_PADRAO = 'https://api.mercadopago.com';
const MELHOR_ENVIO_PRODUCAO = 'https://melhorenvio.com.br';
const MELHOR_ENVIO_SANDBOX = 'https://sandbox.melhorenvio.com.br';
const RESEND_API_BASE_PADRAO = 'https://api.resend.com';

// Primeiro valor não vazio entre os nomes, sem espaços nas pontas.
function ler(env, ...nomes) {
  for (const nome of nomes) {
    const valor = env[nome];
    if (typeof valor === 'string' && valor.trim() !== '') return valor.trim();
  }
  return '';
}

const semBarraFinal = (url) => url.replace(/\/+$/, '');

// Avisos de configuração saem uma vez por valor (obterAmbiente roda várias vezes por requisição).
const avisados = new Set();
function avisarUmaVez(chave, nivel, mensagem) {
  if (avisados.has(chave)) return;
  if (avisados.size > 200) avisados.clear();
  avisados.add(chave);
  console[nivel](mensagem);
}

// Host de URL pública: nomes DNS com ponto, localhost ou IPv6 entre colchetes.
const HOST_SITE = /^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+|\[[0-9a-f:.]+\])$/;

/**
 * Normaliza a URL pública do site. Sem esquema assume https:// (http:// para localhost/127.0.0.1).
 * Aceita só http(s), sem usuário/senha e com host válido; devolve a origem (sem caminho, query nem
 * barra final), ou '' quando não dá para usar (ex.: 'javascript:alert(1)', 'ftp://x.com').
 */
export function normalizarUrlSite(valor) {
  if (typeof valor !== 'string') return '';
  const bruto = valor.trim();
  if (!bruto) return '';
  let candidato;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(bruto)) candidato = bruto;
  else if (bruto.startsWith('//')) candidato = `https:${bruto}`;
  else if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(bruto)) return ''; // outro esquema (javascript:, mailto:...)
  else if (/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(bruto)) candidato = `http://${bruto}`;
  else candidato = `https://${bruto}`;
  let url;
  try {
    url = new URL(candidato);
  } catch {
    return '';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
  if (url.username || url.password || !HOST_SITE.test(url.hostname)) return '';
  return url.origin;
}

function urlDoSite(env) {
  // A Vercel entrega VERCEL_PROJECT_PRODUCTION_URL só com o domínio (ex.: "ama.vercel.app").
  for (const nome of ['SITE_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) {
    const bruto = ler(env, nome);
    if (!bruto) continue;
    const url = normalizarUrlSite(bruto);
    if (url) return url;
    avisarUmaVez(`url:${nome}:${bruto}`, 'warn',
      `[ambiente] ${nome} inválida (${JSON.stringify(bruto.slice(0, 200))}): ignorada. `
      + 'Use o endereço completo do site, como https://www.seudominio.com.br');
  }
  return '';
}

function payloadJwt(chave) {
  const partes = chave.split('.');
  if (partes.length !== 3 || !partes[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(partes[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Motivo pelo qual `chave` NÃO pode ser usada como chave pública (anon/publishable), ou '' se pode:
 * secret key nova (sb_secret_...), igual à chave de serviço, ou JWT legado com role diferente de anon
 * (service_role ignora a RLS).
 */
export function motivoChaveSecreta(chave, chaveServico = '') {
  if (typeof chave !== 'string' || !chave) return '';
  if (/^sb_secret_/i.test(chave)) return 'é uma secret key (sb_secret_...)';
  if (chaveServico && chave === chaveServico) return 'é igual à chave de serviço';
  const payload = payloadJwt(chave);
  if (payload && typeof payload.role === 'string' && payload.role !== 'anon') {
    return `é um JWT com role ${JSON.stringify(payload.role.slice(0, 40))}`;
  }
  return '';
}

/** true se a chave não pode ir ao navegador nem ser usada como anônima (ver motivoChaveSecreta). */
export const ehChaveSecreta = (chave, chaveServico = '') => motivoChaveSecreta(chave, chaveServico) !== '';

const NOMES_CHAVE_PUBLICA = [
  'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
];

// Primeira chave pública aceitável; uma secreta posta no lugar errado é pulada e logada (sem o valor).
function chavePublica(env, chaveServico) {
  let recusada = false;
  for (const nome of NOMES_CHAVE_PUBLICA) {
    const valor = ler(env, nome);
    if (!valor) continue;
    const motivo = motivoChaveSecreta(valor, chaveServico);
    if (!motivo) return { chave: valor, recusada };
    recusada = true;
    avisarUmaVez(`chave:${nome}:${valor}`, 'error',
      `[ambiente] ${nome} ${motivo}: a chave foi IGNORADA para não ir ao navegador. `
      + 'Coloque ali a chave pública (anon ou sb_publishable_...) e troque a chave secreta no painel do Supabase se ela já foi publicada.');
  }
  return { chave: '', recusada };
}

/**
 * Lê e normaliza as variáveis de ambiente (ver o typedef Ambiente acima).
 * @returns {Ambiente}
 */
export function obterAmbiente() {
  const env = process.env;

  const supabaseUrl = semBarraFinal(ler(env, 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'));
  const supabaseServiceKey = ler(env, 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY');
  const { chave: supabaseAnonKey, recusada: supabaseAnonKeyRecusada } = chavePublica(env, supabaseServiceKey);
  const siteUrl = urlDoSite(env);

  const mpAccessToken = ler(env, 'MP_ACCESS_TOKEN');
  const mpWebhookSecret = ler(env, 'MP_WEBHOOK_SECRET');
  const melhorEnvioToken = ler(env, 'MELHOR_ENVIO_TOKEN');
  const melhorEnvioAmbiente = ler(env, 'MELHOR_ENVIO_AMBIENTE').toLowerCase() === 'sandbox' ? 'sandbox' : 'producao';
  const melhorEnvioEmail = ler(env, 'MELHOR_ENVIO_EMAIL');
  const resendApiKey = ler(env, 'RESEND_API_KEY');
  const cronSecret = ler(env, 'CRON_SECRET');
  const emailRemetente = ler(env, 'EMAIL_REMETENTE');

  const mpApiBase = semBarraFinal(ler(env, 'MP_API_BASE') || MP_API_BASE_PADRAO);
  const melhorEnvioApiBase = semBarraFinal(ler(env, 'MELHOR_ENVIO_API_BASE')
    || (melhorEnvioAmbiente === 'sandbox' ? MELHOR_ENVIO_SANDBOX : MELHOR_ENVIO_PRODUCAO));
  const resendApiBase = semBarraFinal(ler(env, 'RESEND_API_BASE') || RESEND_API_BASE_PADRAO);

  const supabasePublicoConfigurado = Boolean(supabaseUrl && supabaseAnonKey);
  const supabaseServicoConfigurado = Boolean(supabaseUrl && supabaseServiceKey);

  return {
    supabaseUrl,
    supabaseAnonKey,
    supabaseAnonKeyRecusada,
    supabaseServiceKey,
    siteUrl,
    mpAccessToken,
    mpWebhookSecret,
    melhorEnvioToken,
    melhorEnvioAmbiente,
    melhorEnvioEmail,
    resendApiKey,
    cronSecret,
    emailRemetente,
    mpApiBase,
    melhorEnvioApiBase,
    resendApiBase,

    supabasePublicoConfigurado,
    supabaseServicoConfigurado,
    supabaseConfigurado: supabasePublicoConfigurado && supabaseServicoConfigurado,
    mercadoPagoConfigurado: Boolean(mpAccessToken),
    melhorEnvioConfigurado: Boolean(melhorEnvioToken),
    emailConfigurado: Boolean(resendApiKey),

    // Mesmos valores com os nomes da §3.
    SUPABASE_URL: supabaseUrl,
    SUPABASE_ANON_KEY: supabaseAnonKey,
    SUPABASE_SERVICE_ROLE_KEY: supabaseServiceKey,
    SITE_URL: siteUrl,
    MP_ACCESS_TOKEN: mpAccessToken,
    MP_WEBHOOK_SECRET: mpWebhookSecret,
    MELHOR_ENVIO_TOKEN: melhorEnvioToken,
    MELHOR_ENVIO_AMBIENTE: melhorEnvioAmbiente,
    MELHOR_ENVIO_EMAIL: melhorEnvioEmail,
    RESEND_API_KEY: resendApiKey,
    CRON_SECRET: cronSecret,
    EMAIL_REMETENTE: emailRemetente,
    MP_API_BASE: mpApiBase,
    MELHOR_ENVIO_API_BASE: melhorEnvioApiBase,
    RESEND_API_BASE: resendApiBase,
  };
}
