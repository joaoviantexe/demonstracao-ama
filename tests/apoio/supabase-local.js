// Apoio para testes contra o Supabase local (supabase start / supabase db reset).
// Os valores padrão são os do Supabase CLI em desenvolvimento; nada aqui é segredo de produção.

import { execFile, execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createClient } from '@supabase/supabase-js';

const executar = promisify(execFile);

export const LOCAL = Object.freeze({
  url: 'http://127.0.0.1:54321',
  publishableKey: 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH',
  jwtSecret: 'super-secret-jwt-token-with-at-least-32-characters-long',
  dbUrl: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
});

// Raiz do repositório (tests/apoio/ → ../../) e o script que roda o CLI via npx.
const RAIZ = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT_CLI = join(RAIZ, 'scripts', 'supabase-local.sh');

// Nome no "status -o env" do CLI → nome da variável de ambiente equivalente.
// O CLI novo imprime PUBLISHABLE_KEY/SECRET_KEY e ainda as antigas ANON_KEY/SERVICE_ROLE_KEY.
const NOMES_CLI = {
  PUBLISHABLE_KEY: 'SUPABASE_PUBLISHABLE_KEY',
  ANON_KEY: 'SUPABASE_ANON_KEY',
  SECRET_KEY: 'SUPABASE_SECRET_KEY',
  SERVICE_ROLE_KEY: 'SUPABASE_SERVICE_ROLE_KEY',
  JWT_SECRET: 'SUPABASE_JWT_SECRET',
  API_URL: 'SUPABASE_URL',
  DB_URL: 'SUPABASE_DB_URL',
};

/** Interpreta a saída de "status -o env" (linhas NOME="valor"; ruído do npx é ignorado). */
export function lerSaidaStatus(saida) {
  const valores = {};
  for (const linha of String(saida || '').split(/\r?\n/)) {
    const m = linha.trim().match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S*))$/);
    if (!m) continue;
    const nome = NOMES_CLI[m[1]];
    const valor = m[2] ?? m[3] ?? m[4] ?? '';
    if (nome && valor) valores[nome] = valor;
  }
  return valores;
}

let chavesCache;
/**
 * Lê as chaves do Supabase local pelo CLI ("status -o env") quando a chave de serviço
 * não veio do ambiente. Assim nenhuma chave fica escrita no repositório.
 * Padrão: scripts/supabase-local.sh do próprio repositório (roda o CLI via npx).
 * SUPABASE_CLI aponta para outro executável (ex.: "supabase" ou node_modules/.bin/supabase).
 * O resultado (inclusive a falha) fica em cache: o CLI roda no máximo uma vez por processo.
 */
export function chavesDoCli() {
  if (chavesCache) return chavesCache;
  chavesCache = {};
  if (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY) return chavesCache;
  const cli = process.env.SUPABASE_CLI || SCRIPT_CLI;
  const [comando, args] = cli.endsWith('.sh') ? ['bash', [cli]] : [cli, []];
  try {
    const saida = execFileSync(comando, [...args, 'status', '-o', 'env'], {
      cwd: RAIZ,
      env: { ...process.env, DO_NOT_TRACK: '1', SUPABASE_TELEMETRY_DISABLED: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 180_000,
    });
    chavesCache = lerSaidaStatus(saida);
  } catch (erro) {
    // A saída pode ter vindo mesmo com código de saída diferente de zero.
    chavesCache = lerSaidaStatus(erro && erro.stdout);
  }
  return chavesCache;
}

/** Primeiro valor definido entre os nomes: o ambiente tem prioridade sobre o CLI. */
function primeiro(...nomes) {
  for (const nome of nomes) if (process.env[nome]) return process.env[nome];
  const doCli = chavesDoCli();
  for (const nome of nomes) if (doCli[nome]) return doCli[nome];
  return undefined;
}

const OPCOES_CLIENTE = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function hostDe(endereco, rotulo) {
  let url;
  try {
    url = new URL(endereco);
  } catch {
    throw new Error(`${rotulo} inválida: ${endereco}`);
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new Error(`${rotulo} sem host: ${endereco}`);
  return { host, usuario: decodeURIComponent(url.username || '') };
}

/**
 * Trava contra rodar os testes num Supabase de produção: os testes criam usuários,
 * produtos ativos, pedidos e arquivos, e a limpeza roda pelo psql no dbUrl.
 * - API e banco precisam estar em 127.0.0.1, localhost ou ::1, salvo AMA_TESTES_PERMITIR_REMOTO=1.
 * - API e banco precisam apontar para o mesmo lugar (senão os dados ficam num e a limpeza roda no outro).
 *   Remoto: mesmo host, ou o banco do mesmo projeto (db.<projeto>.supabase.co ou usuário postgres.<projeto>).
 * Lança erro com a explicação; devolve os hosts quando está tudo certo.
 */
export function conferirDestino({ url, dbUrl }, env = process.env) {
  const api = hostDe(url, 'URL da API do Supabase');
  const banco = hostDe(dbUrl, 'URL do banco (SUPABASE_DB_URL)');
  const apiLocal = LOOPBACK.has(api.host);
  const bancoLocal = LOOPBACK.has(banco.host);

  if (env.AMA_TESTES_PERMITIR_REMOTO !== '1') {
    for (const [rotulo, alvo, local] of [['a API', api.host, apiLocal], ['o banco', banco.host, bancoLocal]]) {
      if (!local) {
        throw new Error(
          `Os testes só rodam contra o Supabase local, mas ${rotulo} aponta para "${alvo}". `
            + 'Confira SUPABASE_URL/SUPABASE_DB_URL (não use o .env de produção) ou defina '
            + 'AMA_TESTES_PERMITIR_REMOTO=1 se for de propósito.',
        );
      }
    }
  }

  const projeto = api.host.split('.')[0];
  const mesmoDestino = apiLocal || bancoLocal
    ? apiLocal && bancoLocal
    : banco.host === api.host
      || banco.host.endsWith(`.${api.host}`)
      || (projeto !== '' && banco.usuario.endsWith(`.${projeto}`));
  if (!mesmoDestino) {
    throw new Error(
      `A API (${api.host}) e o banco (${banco.host}) apontam para lugares diferentes: os testes criariam `
        + 'dados num e limpariam no outro. Ajuste SUPABASE_URL e SUPABASE_DB_URL.',
    );
  }
  return { api: api.host, banco: banco.host };
}

/** { url, anonKey, serviceKey, dbUrl } — do ambiente, com padrão no Supabase local (conferido por conferirDestino). */
export function ambienteLocal() {
  const ambiente = {
    url: (primeiro('SUPABASE_URL') || LOCAL.url).replace(/\/+$/, ''),
    anonKey: primeiro('SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_ANON_KEY') || LOCAL.publishableKey,
    serviceKey: primeiro('SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'),
    dbUrl: primeiro('SUPABASE_DB_URL') || LOCAL.dbUrl,
  };
  conferirDestino(ambiente);
  return ambiente;
}

/** Cliente supabase-js com a chave indicada (padrão: chave pública). Sem sessão persistida. */
export function cliente(chave) {
  const { url, anonKey } = ambienteLocal();
  return createClient(url, chave || anonKey, OPCOES_CLIENTE);
}

/** Cliente com a chave de serviço (ignora RLS). */
export function clienteServico() {
  return cliente(ambienteLocal().serviceKey);
}

async function procurarUsuarioPorEmail(admin, email) {
  const alvo = email.toLowerCase();
  for (let pagina = 1; pagina <= 50; pagina += 1) {
    const { data, error } = await admin.listUsers({ page: pagina, perPage: 200 });
    if (error) throw error;
    const achado = data.users.find((u) => (u.email || '').toLowerCase() === alvo);
    if (achado) return achado;
    if (data.users.length < 200) return null;
  }
  return null;
}

/**
 * Cria (ou reaproveita) um usuário com e-mail confirmado. Se admin, registra em public.admins.
 * Devolve { id, email }.
 */
export async function criarUsuario({ email, senha, admin = false }) {
  const servico = clienteServico();
  let usuario;
  const { data, error } = await servico.auth.admin.createUser({
    email,
    password: senha,
    email_confirm: true,
  });
  if (error) {
    const jaExiste = error.code === 'email_exists' || /already been registered/i.test(error.message || '');
    if (!jaExiste) throw new Error(`Falha ao criar usuário ${email}: ${error.message}`);
    usuario = await procurarUsuarioPorEmail(servico.auth.admin, email);
    if (!usuario) throw new Error(`Usuário ${email} existe mas não foi encontrado`);
    const { error: erroSenha } = await servico.auth.admin.updateUserById(usuario.id, { password: senha });
    if (erroSenha) throw new Error(`Falha ao redefinir a senha de ${email}: ${erroSenha.message}`);
  } else {
    usuario = data.user;
  }

  if (admin) {
    const { error: erroAdmin } = await servico
      .from('admins')
      .upsert({ user_id: usuario.id, email: usuario.email }, { onConflict: 'user_id' });
    if (erroAdmin) throw new Error(`Falha ao registrar admin ${email}: ${erroAdmin.message}`);
  }
  return { id: usuario.id, email: usuario.email };
}

/** Apaga o usuário (e, em cascata, a linha em admins). Ignora "não encontrado". */
export async function removerUsuario(id) {
  if (!id) return;
  const { error } = await clienteServico().auth.admin.deleteUser(id);
  if (error && error.status !== 404) throw new Error(`Falha ao remover usuário ${id}: ${error.message}`);
}

function base64url(texto) {
  return Buffer.from(texto).toString('base64url');
}

// Plano B, só como último recurso: se o provedor de e-mail do Auth local estiver
// desligado, assina localmente um JWT HS256 com o segredo de desenvolvimento do CLI.
// O Auth local atual assina as sessões com ES256, então este token provavelmente será
// recusado; o caminho normal (e testado) é o signInWithPassword em clienteLogado().
async function tokenLocal(email) {
  const segredo = process.env.SUPABASE_JWT_SECRET || chavesDoCli().SUPABASE_JWT_SECRET || LOCAL.jwtSecret;
  const servico = clienteServico();
  const usuario = await procurarUsuarioPorEmail(servico.auth.admin, email);
  if (!usuario) throw new Error(`Usuário ${email} não encontrado`);
  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const corpo = base64url(JSON.stringify({
    iss: `${ambienteLocal().url}/auth/v1`,
    sub: usuario.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: usuario.email,
    aal: 'aal1',
    session_id: randomUUID(),
    is_anonymous: false,
    iat: agora,
    exp: agora + 3600,
  }));
  const assinatura = createHmac('sha256', segredo).update(`${cabecalho}.${corpo}`).digest('base64url');
  return { token: `${cabecalho}.${corpo}.${assinatura}`, usuario };
}

/** Cliente autenticado como o usuário (para testar RLS). Lança erro se o login falhar. */
export async function clienteLogado(email, senha) {
  const supa = cliente();
  const { data, error } = await supa.auth.signInWithPassword({ email, password: senha });
  if (!error) {
    supa.usuario = data.user;
    return supa;
  }
  if (error.code !== 'email_provider_disabled') {
    throw new Error(`Falha no login de ${email}: ${error.message}`);
  }
  const { url, anonKey } = ambienteLocal();
  const { token, usuario } = await tokenLocal(email);
  const logado = createClient(url, anonKey, {
    ...OPCOES_CLIENTE,
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  logado.usuario = usuario;
  logado.loginSimulado = true;
  return logado;
}

/**
 * Executa SQL direto no Postgres local com o psql (como postgres, ignora RLS).
 * Devolve a saída sem alinhamento (-A -t), já sem espaços nas pontas.
 * Dica: para dados estruturados use `select json_agg(...)` e JSON.parse.
 */
export async function sql(query) {
  const url = new URL(ambienteLocal().dbUrl);
  const args = [
    '-X', '-q', '-A', '-t',
    '-v', 'ON_ERROR_STOP=1',
    '-h', url.hostname,
    '-p', url.port || '5432',
    '-U', decodeURIComponent(url.username || 'postgres'),
    '-d', decodeURIComponent(url.pathname.replace(/^\//, '') || 'postgres'),
    '-c', query,
  ];
  const { stdout } = await executar('psql', args, {
    env: { ...process.env, PGPASSWORD: decodeURIComponent(url.password || 'postgres') },
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Atalho: executa uma consulta que devolve um único valor JSON e já faz o parse. */
export async function sqlJson(query) {
  const saida = await sql(query);
  return saida === '' ? null : JSON.parse(saida);
}
