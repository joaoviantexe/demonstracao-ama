// Variáveis de ambiente normalizadas (docs/ARQUITETURA.md §3).
// obterAmbiente() lê process.env a cada chamada: os testes mudam o ambiente em tempo de execução.

/**
 * @typedef {object} Ambiente
 * @property {string} supabaseUrl          SUPABASE_URL | NEXT_PUBLIC_SUPABASE_URL (sem barra final)
 * @property {string} supabaseAnonKey      SUPABASE_ANON_KEY | SUPABASE_PUBLISHABLE_KEY | NEXT_PUBLIC_SUPABASE_ANON_KEY | NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
 * @property {string} supabaseServiceKey   SUPABASE_SERVICE_ROLE_KEY | SUPABASE_SECRET_KEY (só servidor)
 * @property {string} siteUrl              SITE_URL | https://VERCEL_PROJECT_PRODUCTION_URL (sem barra final; '' se nenhum)
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

function urlDoSite(env) {
  const site = ler(env, 'SITE_URL');
  if (site) return semBarraFinal(site);
  // A Vercel entrega só o domínio (ex.: "ama.vercel.app"), sem protocolo.
  const producao = ler(env, 'VERCEL_PROJECT_PRODUCTION_URL');
  if (!producao) return '';
  return semBarraFinal(/^https?:\/\//i.test(producao) ? producao : `https://${producao}`);
}

/**
 * Lê e normaliza as variáveis de ambiente (ver o typedef Ambiente acima).
 * @returns {Ambiente}
 */
export function obterAmbiente() {
  const env = process.env;

  const supabaseUrl = semBarraFinal(ler(env, 'SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'));
  const supabaseAnonKey = ler(env,
    'SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  const supabaseServiceKey = ler(env, 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY');
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
