// Apoio para testes contra o Supabase local (supabase start / supabase db reset).
// Os valores padrão são os do Supabase CLI em desenvolvimento; nada aqui é segredo de produção.

import { execFile, execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createClient } from '@supabase/supabase-js';

const executar = promisify(execFile);

export const LOCAL = Object.freeze({
  url: 'http://127.0.0.1:54321',
  publishableKey: 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH',
  jwtSecret: 'super-secret-jwt-token-with-at-least-32-characters-long',
  dbUrl: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
});

let chavesCache;
/**
 * Lê as chaves do Supabase local pelo CLI ("supabase status -o env") quando elas não
 * vieram do ambiente. Assim nenhuma chave fica escrita no repositório.
 * Defina SUPABASE_CLI para apontar para outro executável (ex.: node_modules/.bin/supabase).
 */
function chavesDoCli() {
  if (chavesCache) return chavesCache;
  chavesCache = {};
  const temChaves = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (temChaves) return chavesCache;
  try {
    const cli = process.env.SUPABASE_CLI || 'supabase';
    const saida = execFileSync(cli, ['status', '-o', 'env'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    for (const linha of saida.split('\n')) {
      const m = linha.match(/^([A-Z_]+)="?([^"]*)"?$/);
      if (!m) continue;
      if (m[1] === 'SECRET_KEY') chavesCache.SUPABASE_SECRET_KEY = m[2];
      if (m[1] === 'SERVICE_ROLE_KEY') chavesCache.SUPABASE_SERVICE_ROLE_KEY ||= m[2];
      if (m[1] === 'JWT_SECRET') chavesCache.SUPABASE_JWT_SECRET = m[2];
    }
  } catch { /* sem CLI: o chamador recebe serviceKey indefinida e o teste explica */ }
  return chavesCache;
}

const OPCOES_CLIENTE = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
};

/** { url, anonKey, serviceKey, dbUrl } — do ambiente, com padrão no Supabase local. */
export function ambienteLocal() {
  const env = { ...chavesDoCli(), ...process.env };
  return {
    url: (env.SUPABASE_URL || LOCAL.url).replace(/\/+$/, ''),
    anonKey: env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || LOCAL.publishableKey,
    serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY,
    dbUrl: env.SUPABASE_DB_URL || LOCAL.dbUrl,
  };
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

// Plano B: se o provedor de e-mail do Auth local estiver desligado
// ([auth.email] enable_signup = false no config.toml), assina localmente um JWT
// de sessão com o segredo de desenvolvimento do CLI. Só funciona no Supabase local.
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
