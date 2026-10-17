// Núcleo do painel /admin (docs/ARQUITETURA.md §8 e docs/PAINEL.md): cliente do Supabase, login,
// recuperação de senha, verificação de admin, layout (menu lateral/gaveta), roteador por hash e
// carregamento das páginas de ./paginas/<nome>.js.
//
// Contrato das páginas: export async function renderizar(ctx) → (opcional) função de limpeza.
// ctx = { raiz, supabase, usuario, params, consulta, navegar(hash, opcoes), marcarAlterado(bool),
//         ui, api, midia, sinal, rota, hash, definirTitulo(txt), atualizarContadores() }

import * as api from './api.js';
import * as midia from './midia.js';
import { publicarHome } from './publicar-home.js';
import * as ui from './ui.js';

const { el, icone } = ui;

// ---------------------------------------------------------------------------
// Rotas e menu

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** Tabela de rotas: padrão do caminho → página (arquivo em paginas/), item do menu e título. */
export const ROTAS = Object.freeze([
  { padrao: /^\/$/, pagina: 'visao-geral', menu: 'inicio', titulo: 'Visão geral' },
  { padrao: /^\/conteudo$/, pagina: 'conteudo', menu: 'conteudo', titulo: 'Conteúdo do site' },
  { padrao: /^\/conteudo\/([a-z0-9][a-z0-9_-]*)$/, pagina: 'conteudo', menu: 'conteudo', titulo: 'Conteúdo do site', params: ['grupo'] },
  { padrao: /^\/produtos$/, pagina: 'produtos', menu: 'produtos', titulo: 'Produtos' },
  { padrao: new RegExp(`^/produtos/(novo|${UUID})$`), pagina: 'produtos', menu: 'produtos', titulo: 'Produto', params: ['id'] },
  { padrao: /^\/categorias$/, pagina: 'categorias', menu: 'categorias', titulo: 'Categorias' },
  { padrao: /^\/pedidos$/, pagina: 'pedidos', menu: 'pedidos', titulo: 'Pedidos' },
  { padrao: new RegExp(`^/pedidos/(${UUID})$`), pagina: 'pedidos', menu: 'pedidos', titulo: 'Pedido', params: ['id'] },
  { padrao: /^\/configuracoes$/, pagina: 'configuracoes', menu: 'configuracoes', titulo: 'Configurações' },
]);

/** Itens do menu lateral, em seções. */
export const MENU = Object.freeze([
  {
    secao: 'Site',
    // Um item por parte da página inicial; o hash é o do grupo em paginas/conteudo.js.
    itens: [
      { id: 'conteudo-identidade', rotulo: 'Identidade', hash: '#/conteudo/identidade', icone: 'midia' },
      { id: 'conteudo-quem-somos', rotulo: 'Quem somos', hash: '#/conteudo/quem-somos', icone: 'info' },
      { id: 'conteudo-postagens', rotulo: 'Postagens destacadas', hash: '#/conteudo/postagens', icone: 'imagem' },
      { id: 'conteudo-projetos', rotulo: 'Nossos projetos', hash: '#/conteudo/projetos', icone: 'estrela' },
      { id: 'conteudo-historia', rotulo: 'História', hash: '#/conteudo/historia', icone: 'conteudo' },
      { id: 'conteudo-loja', rotulo: 'Banner da Loja', hash: '#/conteudo/loja', icone: 'loja' },
      { id: 'conteudo-depoimentos', rotulo: 'Depoimentos', hash: '#/conteudo/depoimentos', icone: 'usuario' },
      { id: 'conteudo-parcerias', rotulo: 'Colaborações e parcerias', hash: '#/conteudo/parcerias', icone: 'link' },
      { id: 'conteudo-rodape', rotulo: 'Rodapé', hash: '#/conteudo/rodape', icone: 'email' },
      { id: 'conteudo-whatsapp', rotulo: 'WhatsApp', hash: '#/conteudo/whatsapp', icone: 'link' },
      { id: 'conteudo-seo', rotulo: 'Google', hash: '#/conteudo/seo', icone: 'busca' },
    ],
  },
  {
    secao: 'Loja',
    itens: [
      { id: 'pedidos', rotulo: 'Pedidos', hash: '#/pedidos', icone: 'pedidos' },
      { id: 'produtos', rotulo: 'Produtos', hash: '#/produtos', icone: 'produtos' },
      { id: 'categorias', rotulo: 'Categorias', hash: '#/categorias', icone: 'categorias' },
      { id: 'configuracoes', rotulo: 'Configurações', hash: '#/configuracoes', icone: 'configuracoes' },
    ],
  },
]);

/**
 * "#/produtos/<id>?aba=fotos" → { pagina, menu, titulo, params: { id }, consulta: { aba }, caminho, hash }.
 * Hash vazio ou sem "#/" → visão geral. Caminho desconhecido → null (página não encontrada).
 */
export function resolverRota(hash) {
  let texto = String(hash || '').replace(/^#/, '');
  if (!texto.startsWith('/')) texto = '/';
  const [caminhoBruto, ...resto] = texto.split('?');
  const caminho = caminhoBruto.length > 1 ? caminhoBruto.replace(/\/+$/, '') || '/' : '/';
  const consulta = {};
  for (const [chave, valor] of new URLSearchParams(resto.join('?'))) consulta[chave] = valor;
  for (const rota of ROTAS) {
    const m = caminho.match(rota.padrao);
    if (!m) continue;
    const params = {};
    (rota.params || []).forEach((nome, i) => { params[nome] = rota.params && nome === 'id' && m[i + 1] !== 'novo' ? m[i + 1].toLowerCase() : m[i + 1]; });
    const menu = rota.pagina === 'conteudo' && params.grupo ? `conteudo-${params.grupo}` : rota.menu;
    return { pagina: rota.pagina, menu, titulo: rota.titulo, params, consulta, caminho, hash: `#${texto}` };
  }
  return null;
}

/** Normaliza o destino de navegar(): "produtos", "/produtos" e "#/produtos" → "#/produtos". */
export function normalizarHash(destino) {
  const texto = String(destino || '').trim().replace(/^#/, '');
  if (!texto) return '#/';
  return `#${texto.startsWith('/') ? texto : `/${texto}`}`;
}

// ---------------------------------------------------------------------------
// Estado

const estado = {
  supabase: null,
  usuario: null, // { id, email }
  painel: null, // elementos do layout montado
  hashAtual: null,
  alterado: false,
  limpeza: null,
  abortar: null,
  geracao: 0, // cada renderização de rota ganha um número; ctx de páginas antigas fica inativo
  processandoLogin: false,
  motivoSaida: null, // 'usuario' | 'sem_permissao' | null (= sessão expirou)
  recuperacao: null, // 'recovery' | 'invite' quando o link do e-mail abriu o painel
  avisoLink: '', // erro vindo no link do e-mail (expirado etc.)
  telaAcesso: null, // container da tela de login/recuperação (sobre o painel, se houver)
  ultimoContador: 0,
  verificando: false,
};

// ---------------------------------------------------------------------------
// Utilidades

function definirTitulo(titulo) {
  document.title = titulo ? `${titulo} · Painel AMA` : 'Painel AMA';
}

function raizApp() {
  return document.getElementById('app');
}

function mensagemErroAuth(erro) {
  const codigo = String((erro && erro.code) || '');
  const texto = String((erro && erro.message) || '');
  const status = Number(erro && erro.status) || 0;
  if (codigo === 'invalid_credentials' || /invalid login credentials/i.test(texto)) return 'E-mail ou senha incorretos.';
  if (codigo === 'email_not_confirmed' || /email not confirmed/i.test(texto)) return 'Este e-mail ainda não foi confirmado. Use o link enviado por e-mail ou peça ajuda a um administrador.';
  if (codigo === 'user_banned') return 'Este usuário está bloqueado. Fale com um administrador da AMA.';
  if (codigo === 'over_email_send_rate_limit') return 'Muitos e-mails enviados em pouco tempo. Aguarde alguns minutos e tente de novo.';
  if (codigo === 'over_request_rate_limit' || status === 429) return 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.';
  if (codigo === 'weak_password' || /password should be/i.test(texto)) return 'Senha fraca: use pelo menos 8 caracteres, misturando letras e números.';
  if (codigo === 'same_password') return 'A nova senha precisa ser diferente da atual.';
  if (codigo === 'email_address_invalid' || codigo === 'validation_failed') return 'E-mail inválido.';
  if (/email address not authorized/i.test(texto)) return 'O envio de e-mails do Supabase não está configurado (SMTP). Peça ao responsável técnico para configurar ou para redefinir sua senha.';
  if (codigo === 'email_provider_disabled') return 'O login por e-mail está desativado no Supabase.';
  if (codigo === 'session_not_found' || codigo === 'session_expired' || codigo === 'refresh_token_not_found') return 'Sua sessão expirou. Entre novamente.';
  if (/error sending .*email/i.test(texto)) {
    return 'O Supabase não conseguiu enviar o e-mail agora. Tente de novo mais tarde; se continuar, peça ao responsável técnico para conferir o envio de e-mails (SMTP) do Supabase.';
  }
  if (status >= 500) return 'O serviço de login está com problema agora. Tente de novo em instantes.';
  if ((erro && erro.name === 'AuthRetryableFetchError') || status === 0 || /failed to fetch|network/i.test(texto)) {
    return 'Não foi possível conectar. Verifique sua internet e tente de novo.';
  }
  return 'Não foi possível concluir agora. Tente de novo em instantes.';
}

const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Erro de link de e-mail (#error=…&error_code=otp_expired) ou tokens de recuperação/convite.
function lerRetornoDoEmail() {
  const hash = window.location.hash.replace(/^#/, '');
  const busca = window.location.search.replace(/^\?/, '');
  const doHash = hash.startsWith('/') ? new URLSearchParams() : new URLSearchParams(hash);
  const daBusca = new URLSearchParams(busca);
  const erro = doHash.get('error_description') || doHash.get('error') || daBusca.get('error_description') || daBusca.get('error');
  const codigoErro = doHash.get('error_code') || daBusca.get('error_code') || '';
  if (erro) {
    estado.avisoLink = codigoErro === 'otp_expired' || /expired|invalid/i.test(erro)
      ? 'O link do e-mail expirou ou já foi usado. Peça à AMA um novo acesso.'
      : 'Não foi possível usar o link do e-mail. Peça à AMA um novo acesso.';
    // Limpa a URL antes do supabase-js lê-la (evita erro no console e o hash cair no roteador).
    window.history.replaceState(null, '', `${window.location.pathname}#/`);
    return;
  }
  const tipo = doHash.get('type') || daBusca.get('type');
  if ((doHash.get('access_token') || daBusca.get('code')) && (tipo === 'recovery' || tipo === 'invite')) {
    estado.recuperacao = tipo;
  }
}

// ---------------------------------------------------------------------------
// Telas de acesso (login, recuperação, nova senha, verificação, configuração)

function moldeAcesso(...conteudo) {
  return el('div', { class: 'acesso__conteudo' },
    el('div', { class: 'acesso__marca' },
      el('img', { src: '/img/logo-ama.png', alt: 'AMA — Associação de Mulheres na Amazônia', width: '402', height: '279', class: 'acesso__logo' })),
    el('div', { class: 'acesso__cartao' }, ...conteudo),
    el('a', { class: 'acesso__voltar', href: '/' }, icone('voltar'), 'Voltar ao site'));
}

/** Mostra uma tela de acesso por cima de tudo (o painel, se montado, fica inerte por baixo). */
function mostrarAcesso(conteudo, { titulo = 'Entrar' } = {}) {
  definirTitulo(titulo);
  if (!estado.telaAcesso || !estado.telaAcesso.isConnected) {
    estado.telaAcesso = el('div', { class: 'acesso', role: 'main' });
    raizApp().append(estado.telaAcesso);
  }
  const carregando = raizApp().querySelector('.tela-carregando');
  if (carregando) carregando.remove();
  // Um <dialog> modal aberto deixaria a tela de acesso inerte (sem como digitar a senha).
  ui.fecharModais();
  if (estado.painel) estado.painel.raiz.inert = true;
  document.documentElement.classList.add('acesso-aberto');
  estado.telaAcesso.replaceChildren(moldeAcesso(conteudo));
  const foco = estado.telaAcesso.querySelector('[autofocus], input, h1');
  if (foco) {
    if (foco.tagName === 'H1') foco.setAttribute('tabindex', '-1');
    foco.focus({ preventScroll: true });
  }
}

function fecharAcesso() {
  if (estado.telaAcesso) estado.telaAcesso.remove();
  estado.telaAcesso = null;
  document.documentElement.classList.remove('acesso-aberto');
  if (estado.painel) estado.painel.raiz.inert = false;
}

function caixaMensagem(texto, tipo) {
  return el('div', { class: ['aviso', `aviso--${tipo}`], role: tipo === 'erro' ? 'alert' : 'status', hidden: !texto },
    icone(tipo === 'erro' ? 'erro' : tipo === 'sucesso' ? 'sucesso' : 'info'), el('div', { class: 'aviso__texto' }, texto || ''));
}

function definirMensagem(caixa, texto, tipo = 'erro') {
  caixa.className = `aviso aviso--${tipo}`;
  caixa.setAttribute('role', tipo === 'erro' ? 'alert' : 'status');
  caixa.replaceChildren(icone(tipo === 'erro' ? 'erro' : tipo === 'sucesso' ? 'sucesso' : 'info'), el('div', { class: 'aviso__texto' }, texto));
  caixa.hidden = !texto;
}

function telaLogin({ mensagem = '', tipo = 'erro', email = '' } = {}) {
  const caixa = caixaMensagem(mensagem, tipo);
  const campoEmail = ui.campo({
    rotulo: 'E-mail', nome: 'email', tipo: 'email', valor: email, obrigatorio: true,
    attrs: { autocomplete: 'username', inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', autofocus: !email },
  });
  const campoSenha = ui.campo({ rotulo: 'Senha', nome: 'senha', tipo: 'senha', obrigatorio: true, attrs: { autofocus: Boolean(email) } });
  const entrar = ui.botao({ texto: 'Entrar', tipo: 'primario', tamanho: 'grande', tipoHtml: 'submit', bloco: true });
  const form = el('form', { class: 'acesso__formulario', novalidate: true },
    el('h1', { class: 'acesso__titulo' }, 'Painel da AMA'),
    caixa, campoEmail.elemento, campoSenha.elemento, entrar);

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    definirMensagem(caixa, '');
    const valorEmail = campoEmail.entrada.value.trim();
    const senha = campoSenha.entrada.value;
    let invalido = false;
    if (!valorEmail) { campoEmail.definirErro('Informe seu e-mail.'); invalido = true; }
    else if (!EMAIL_VALIDO.test(valorEmail)) { campoEmail.definirErro('Confira o e-mail: parece incompleto.'); invalido = true; }
    if (!senha) { campoSenha.definirErro('Informe sua senha.'); invalido = true; }
    if (invalido) {
      form.querySelector('[aria-invalid="true"]').focus();
      return;
    }
    await ui.ocupado(entrar, async () => {
      estado.processandoLogin = true;
      try {
        const { data, error } = await estado.supabase.auth.signInWithPassword({ email: valorEmail, password: senha });
        if (error || !data || !data.session) {
          definirMensagem(caixa, mensagemErroAuth(error));
          campoSenha.entrada.select();
          campoSenha.entrada.focus();
          return;
        }
        await entrarComSessao(data.session);
      } finally {
        estado.processandoLogin = false;
      }
    });
  });
  mostrarAcesso(form, { titulo: 'Entrar' });
}

function telaNovaSenha() {
  if (estado.telaAcesso && estado.telaAcesso.querySelector('[data-tela="nova-senha"]')) return;
  const convite = estado.recuperacao === 'invite';
  const caixa = caixaMensagem('', 'erro');
  const senha = ui.campo({
    rotulo: 'Nova senha', nome: 'nova-senha', tipo: 'senha', obrigatorio: true,
    ajuda: 'Pelo menos 8 caracteres. Misture letras e números.', attrs: { autocomplete: 'new-password', autofocus: true, minlength: '8' },
  });
  const repetir = ui.campo({ rotulo: 'Repita a nova senha', nome: 'repetir-senha', tipo: 'senha', obrigatorio: true, attrs: { autocomplete: 'new-password', minlength: '8' } });
  const salvar = ui.botao({ texto: 'Salvar senha e entrar', tipo: 'primario', tamanho: 'grande', tipoHtml: 'submit', bloco: true });
  const cancelar = el('button', { type: 'button', class: 'botao-link' }, 'Cancelar e sair');
  const form = el('form', { class: 'acesso__formulario', novalidate: true, 'data-tela': 'nova-senha' },
    el('h1', { class: 'acesso__titulo' }, convite ? 'Crie sua senha' : 'Criar senha nova'),
    el('p', { class: 'acesso__texto' }, convite ? 'Bem-vinda! Escolha a senha que você vai usar para entrar no painel.' : 'Escolha uma senha nova para entrar no painel.'),
    caixa, senha.elemento, repetir.elemento, salvar, el('p', { class: 'acesso__links' }, cancelar));
  cancelar.addEventListener('click', async () => {
    estado.recuperacao = null;
    await sair('usuario');
  });
  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    definirMensagem(caixa, '');
    const valor = senha.entrada.value;
    if (valor.length < 8) {
      senha.definirErro('A senha precisa ter pelo menos 8 caracteres.');
      senha.entrada.focus();
      return;
    }
    if (valor !== repetir.entrada.value) {
      repetir.definirErro('As duas senhas não são iguais.');
      repetir.entrada.focus();
      return;
    }
    await ui.ocupado(salvar, async () => {
      const { error } = await estado.supabase.auth.updateUser({ password: valor });
      if (error) {
        definirMensagem(caixa, error.code === 'session_not_found' || error.status === 401
          ? 'O link expirou. Volte ao login e peça um novo acesso.'
          : mensagemErroAuth(error));
        return;
      }
      estado.recuperacao = null;
      ui.toast('Senha salva com sucesso.', 'sucesso');
      const { data } = await estado.supabase.auth.getSession();
      if (data && data.session) await entrarComSessao(data.session);
      else telaLogin({ mensagem: 'Senha salva. Entre com a senha nova.', tipo: 'sucesso' });
    });
  });
  mostrarAcesso(form, { titulo: convite ? 'Criar senha' : 'Nova senha' });
}

function telaVerificando() {
  mostrarAcesso(el('div', { class: 'acesso__formulario acesso__formulario--centro', role: 'status' },
    el('span', { class: 'girador', 'aria-hidden': 'true' }),
    el('p', { class: 'acesso__texto' }, 'Verificando seu acesso…')), { titulo: 'Entrando' });
}

function telaFalhaVerificacao(sessao) {
  const tentar = ui.botao({ texto: 'Tentar novamente', tipo: 'primario', icone: 'atualizar', bloco: true });
  const sairBotao = el('button', { type: 'button', class: 'botao-link' }, 'Sair');
  tentar.addEventListener('click', () => entrarComSessao(sessao));
  sairBotao.addEventListener('click', () => sair('usuario'));
  mostrarAcesso(el('div', { class: 'acesso__formulario' },
    el('h1', { class: 'acesso__titulo' }, 'Não foi possível verificar o acesso'),
    caixaMensagem('O servidor não respondeu agora. Confira sua internet e tente de novo.', 'erro'),
    tentar, el('p', { class: 'acesso__links' }, sairBotao)), { titulo: 'Erro' });
}

function telaConfiguracao({ titulo, texto, recarregar = false }) {
  const acoes = recarregar
    ? ui.botao({ texto: 'Recarregar', tipo: 'primario', icone: 'atualizar', bloco: true, aoClicar: () => window.location.reload() })
    : null;
  mostrarAcesso(el('div', { class: 'acesso__formulario' },
    el('h1', { class: 'acesso__titulo' }, titulo),
    el('p', { class: 'acesso__texto' }, texto),
    acoes), { titulo });
}

// ---------------------------------------------------------------------------
// Sessão

async function entrarComSessao(sessao) {
  if (!sessao || !sessao.user) {
    telaLogin();
    return;
  }
  if (estado.verificando) return;
  estado.verificando = true;
  const usuario = { id: sessao.user.id, email: sessao.user.email || '' };
  try {
    if (!estado.painel) telaVerificando();
    let resposta;
    try {
      resposta = await estado.supabase.rpc('eh_admin');
    } catch (erro) {
      resposta = { error: erro };
    }
    if (resposta.error) {
      const normal = api.erroSupabase(resposta.error);
      if (normal.erro === 'nao_autenticado') {
        await sair('expirou');
        return;
      }
      console.error('[painel] falha ao verificar admin:', resposta.error);
      telaFalhaVerificacao(sessao);
      return;
    }
    if (resposta.data !== true) {
      await sair('sem_permissao');
      telaLogin({
        mensagem: `Sem permissão: o usuário ${usuario.email || 'informado'} não tem acesso ao painel. Peça a uma administradora da AMA para liberar o acesso.`,
        email: usuario.email,
      });
      return;
    }
    if (estado.painel && estado.usuario && estado.usuario.id === usuario.id) {
      // Mesma pessoa voltando de uma sessão expirada: mantém a página (e o que não foi salvo).
      estado.usuario = usuario;
      atualizarUsuarioNoLayout();
      fecharAcesso();
      return;
    }
    if (estado.painel) desmontarPainel();
    estado.usuario = usuario;
    fecharAcesso();
    montarPainel();
    conferirPublicacaoDaHome();
    await mostrarRotaAtual();
  } finally {
    estado.verificando = false;
  }
}

/** motivo: 'usuario' (clicou em Sair) | 'sem_permissao' | 'expirou'. */
async function sair(motivo = 'usuario') {
  estado.motivoSaida = motivo;
  let falhou = false;
  try {
    const { error } = await estado.supabase.auth.signOut({ scope: 'local' });
    falhou = Boolean(error);
    if (error) console.warn('[painel] signOut falhou:', error);
  } catch (erro) {
    falhou = true;
    console.warn('[painel] signOut falhou:', erro);
  }
  // Sem SIGNED_OUT do supabase-js (erro antes de limpar a sessão): trata aqui mesmo.
  if (falhou && estado.motivoSaida === motivo) tratarEventoAuth('SIGNED_OUT', null);
}

function aoSessaoExpirada() {
  if (estado.telaAcesso || estado.motivoSaida) return;
  sair('expirou');
}

function tratarEventoAuth(evento, sessao) {
  if (evento === 'PASSWORD_RECOVERY') {
    estado.recuperacao = estado.recuperacao || 'recovery';
    telaNovaSenha();
    return;
  }
  if (evento === 'INITIAL_SESSION') {
    if (sessao && estado.recuperacao) telaNovaSenha();
    else if (sessao) entrarComSessao(sessao);
    else telaLogin(estado.avisoLink ? { mensagem: estado.avisoLink } : {});
    estado.avisoLink = '';
    return;
  }
  if (evento === 'SIGNED_IN') {
    if (estado.processandoLogin || estado.recuperacao || estado.verificando) return;
    // Login feito em outra aba, ou volta de uma sessão expirada.
    if (!estado.painel || estado.telaAcesso) entrarComSessao(sessao);
    return;
  }
  if (evento === 'USER_UPDATED' && sessao && sessao.user && estado.usuario) {
    estado.usuario = { id: sessao.user.id, email: sessao.user.email || estado.usuario.email };
    atualizarUsuarioNoLayout();
    return;
  }
  if (evento === 'SIGNED_OUT') {
    const motivo = estado.motivoSaida;
    estado.motivoSaida = null;
    if (motivo === 'sem_permissao') return;
    if (motivo === 'usuario') {
      desmontarPainel();
      estado.usuario = null;
      telaLogin({ mensagem: 'Você saiu do painel.', tipo: 'info' });
      return;
    }
    // Sessão expirada (ou saída em outra aba): login por cima, mantendo a rota e a página.
    telaLogin({
      mensagem: estado.painel || motivo === 'expirou'
        ? (estado.alterado
          ? 'Sua sessão expirou. Entre novamente para continuar: o que você não salvou continua na página.'
          : 'Sua sessão expirou. Entre novamente para continuar.')
        : '',
      tipo: 'info',
      email: estado.usuario ? estado.usuario.email : '',
    });
  }
}

// ---------------------------------------------------------------------------
// Layout

const telaCelular = () => window.matchMedia('(max-width: 1023.98px)').matches;

function montarPainel() {
  const pular = el('a', { class: 'pular', href: '#conteudo-principal' }, 'Pular para o conteúdo');
  const botaoMenu = ui.botao({ tipo: 'fantasma', icone: 'menu', rotulo: 'Abrir menu', classe: 'topo__menu', attrs: { 'aria-controls': 'menu-lateral', 'aria-expanded': 'false' } });
  const emailTopo = el('span', { class: 'topo__email truncar' });
  const alterado = el('span', { class: 'topo__alterado', hidden: true },
    el('span', { class: 'topo__ponto', 'aria-hidden': 'true' }), el('span', { class: 'topo__alterado-texto' }, 'Alterações não salvas'));
  const sairTopo = ui.botao({ texto: 'Sair', tipo: 'secundario', tamanho: 'pequeno', icone: 'sair', classe: 'topo__sair' });
  const topo = el('header', { class: 'topo' },
    botaoMenu,
    el('a', { class: 'topo__marca', href: '#/' },
      el('img', { src: '/img/logo-ama-icone.png', alt: '', width: '224', height: '134' }),
      el('span', {}, 'Painel ', el('strong', {}, 'AMA'))),
    alterado,
    el('div', { class: 'topo__acoes' },
      el('span', { class: 'topo__usuario oculto-celular' }, icone('usuario'), emailTopo),
      ui.botao({ texto: 'Ver site', tipo: 'fantasma', tamanho: 'pequeno', iconeDireita: 'externo', href: '/', classe: 'topo__ver-site', attrs: { target: '_blank', rel: 'noopener' } }),
      sairTopo));

  const fecharGaveta = ui.botao({ tipo: 'fantasma', icone: 'fechar', rotulo: 'Fechar menu', classe: 'menu-lateral__fechar' });
  const contadores = {};
  const links = {};
  const secoes = MENU.map((secao) => {
    const idTitulo = secao.secao ? ui.novoId('menu-secao') : null;
    return el('div', { class: 'menu-lateral__secao' },
      secao.secao ? el('p', { class: 'menu-lateral__titulo', id: idTitulo }, secao.secao) : null,
      el('ul', { class: 'menu-lateral__lista', 'aria-labelledby': idTitulo },
        secao.itens.map((item) => {
          const contador = el('span', { class: 'menu-lateral__contador', hidden: true });
          contadores[item.id] = contador;
          const link = el('a', { class: 'menu-lateral__link', href: item.hash, 'data-menu': item.id },
            icone(item.icone), el('span', { class: 'menu-lateral__rotulo' }, item.rotulo), contador);
          links[item.id] = link;
          return el('li', {}, link);
        })));
  });
  const emailGaveta = el('span', { class: 'truncar' });
  const sairGaveta = ui.botao({ texto: 'Sair', tipo: 'secundario', icone: 'sair', bloco: true, classe: 'menu-lateral__sair' });
  const menu = el('nav', { id: 'menu-lateral', class: 'menu-lateral', 'aria-label': 'Menu do painel' },
    el('div', { class: 'menu-lateral__cabecalho' },
      el('a', { class: 'menu-lateral__marca', href: '#/' },
        el('img', { src: '/img/logo-ama-icone.png', alt: '', width: '224', height: '134' }),
        el('span', {}, 'Painel ', el('strong', {}, 'AMA'))),
      fecharGaveta),
    el('div', { class: 'menu-lateral__rolagem' }, secoes),
    el('div', { class: 'menu-lateral__rodape' },
      el('p', { class: 'menu-lateral__usuario' }, icone('usuario'), emailGaveta),
      el('a', { class: 'menu-lateral__externo menu-lateral__externo--site', href: '/', target: '_blank', rel: 'noopener' }, icone('externo'), 'Ver site'),
      el('a', { class: 'menu-lateral__externo', href: '/loja/', target: '_blank', rel: 'noopener' }, icone('loja'), 'Ver loja'),
      sairGaveta));
  const fundo = el('div', { class: 'menu-fundo', hidden: true });
  const principal = el('main', { id: 'conteudo-principal', class: 'principal', tabindex: '-1' });
  const raiz = el('div', { class: 'painel' }, pular, topo, menu, fundo, principal);

  pular.addEventListener('click', (evento) => {
    evento.preventDefault();
    const titulo = principal.querySelector('h1');
    (titulo || principal).focus();
  });
  botaoMenu.addEventListener('click', () => abrirMenu());
  fecharGaveta.addEventListener('click', () => fecharMenu({ devolverFoco: true }));
  fundo.addEventListener('click', () => fecharMenu({ devolverFoco: true }));
  menu.addEventListener('click', (evento) => {
    const link = evento.target.closest('a.menu-lateral__link');
    if (!link) return;
    // Clicar na seção já aberta só fecha a gaveta.
    if (link.getAttribute('href') === estado.hashAtual) fecharMenu();
  });
  for (const b of [sairTopo, sairGaveta]) {
    b.addEventListener('click', async () => {
      if (estado.alterado && !(await confirmarDescarte('Você tem alterações não salvas. Sair do painel mesmo assim?'))) return;
      estado.alterado = false;
      await sair('usuario');
    });
  }

  raizApp().querySelectorAll('.tela-carregando').forEach((e) => e.remove());
  raizApp().prepend(raiz);
  estado.painel = { raiz, topo, menu, fundo, principal, botaoMenu, emailTopo, emailGaveta, alterado, contadores, links };
  atualizarUsuarioNoLayout();
  ajustarMenuAoTamanho();
  atualizarContadores(true);
}

function desmontarPainel() {
  if (!estado.painel) return;
  executarLimpeza();
  estado.geracao += 1;
  estado.painel.raiz.remove();
  estado.painel = null;
  estado.hashAtual = null;
  estado.alterado = false;
}

function atualizarUsuarioNoLayout() {
  if (!estado.painel || !estado.usuario) return;
  estado.painel.emailTopo.textContent = estado.usuario.email;
  estado.painel.emailTopo.title = estado.usuario.email;
  estado.painel.emailGaveta.textContent = estado.usuario.email;
  estado.painel.emailGaveta.title = estado.usuario.email;
}

function abrirMenu() {
  const p = estado.painel;
  if (!p || !telaCelular()) return;
  p.raiz.classList.add('painel--menu-aberto');
  p.botaoMenu.setAttribute('aria-expanded', 'true');
  p.fundo.hidden = false;
  p.menu.inert = false;
  p.principal.inert = true;
  p.topo.inert = true;
  document.documentElement.classList.add('menu-aberto');
  const atual = p.menu.querySelector('[aria-current="page"]') || p.menu.querySelector('a, button');
  if (atual) atual.focus();
}

function fecharMenu({ devolverFoco = false } = {}) {
  const p = estado.painel;
  if (!p) return;
  const estavaAberto = p.raiz.classList.contains('painel--menu-aberto');
  p.raiz.classList.remove('painel--menu-aberto');
  p.botaoMenu.setAttribute('aria-expanded', 'false');
  p.fundo.hidden = true;
  p.principal.inert = false;
  p.topo.inert = false;
  p.menu.inert = telaCelular();
  document.documentElement.classList.remove('menu-aberto');
  if (estavaAberto && devolverFoco) p.botaoMenu.focus();
}

function ajustarMenuAoTamanho() {
  if (!estado.painel) return;
  fecharMenu();
}

function marcarMenuAtivo(id) {
  if (!estado.painel) return;
  for (const [chave, link] of Object.entries(estado.painel.links)) {
    if (chave === id) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

/** Atualiza os contadores do menu (pedidos pagos aguardando envio). No máximo a cada 30 s sem `forcar`. */
async function atualizarContadores(forcar = false) {
  if (!estado.painel || (!forcar && Date.now() - estado.ultimoContador < 30_000)) return;
  estado.ultimoContador = Date.now();
  const r = await api.consultar(estado.supabase.from('pedidos').select('id', { count: 'exact', head: true }).in('status', ['pago', 'em_separacao']));
  const contador = estado.painel && estado.painel.contadores.pedidos;
  if (!contador || !r.ok) return;
  const total = Number(r.total) || 0;
  contador.hidden = total === 0;
  contador.textContent = total > 99 ? '99+' : String(total);
  contador.setAttribute('aria-label', `${total} ${total === 1 ? 'pedido pago' : 'pedidos pagos'} para enviar`);
  contador.title = contador.getAttribute('aria-label');
}

// ---------------------------------------------------------------------------
// Alterações não salvas

function definirAlterado(sim) {
  estado.alterado = Boolean(sim);
  if (estado.painel) estado.painel.alterado.hidden = !estado.alterado;
}

function confirmarDescarte(mensagem = 'Você tem alterações não salvas nesta página. Sair e descartar as alterações?') {
  return ui.confirmar(mensagem, {
    perigo: true, titulo: 'Descartar alterações?', textoConfirmar: 'Descartar e sair', textoCancelar: 'Continuar editando',
  });
}

// ---------------------------------------------------------------------------
// Roteador

function executarLimpeza() {
  if (estado.abortar) {
    estado.abortar.abort();
    estado.abortar = null;
  }
  const limpeza = estado.limpeza;
  estado.limpeza = null;
  if (typeof limpeza === 'function') {
    try {
      const r = limpeza();
      if (r && typeof r.catch === 'function') r.catch((erro) => console.error('[painel] erro na limpeza da página:', erro));
    } catch (erro) {
      console.error('[painel] erro na limpeza da página:', erro);
    }
  }
  // Modais que a página deixou abertos (ex.: botão Voltar com o seletor de mídia aberto).
  ui.fecharModais();
}

async function arquivoExiste(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (r.ok) return true;
    return r.status === 404 ? false : null;
  } catch {
    return null;
  }
}

/** import() da página; se o arquivo não existe (404), usa a página provisória em-breve.js. */
async function carregarPagina(nome) {
  try {
    return await import(`./paginas/${nome}.js`);
  } catch (erro) {
    if (nome !== 'em-breve' && (await arquivoExiste(`/admin/js/paginas/${nome}.js`)) === false) {
      return import('./paginas/em-breve.js');
    }
    throw erro;
  }
}

function criarCtx(raiz, rota, sinal, geracao) {
  const ativo = () => geracao === estado.geracao;
  return {
    raiz,
    supabase: estado.supabase,
    usuario: { ...estado.usuario },
    params: { ...rota.params },
    consulta: { ...rota.consulta },
    rota: rota.pagina,
    hash: rota.hash,
    titulo: rota.titulo,
    sinal,
    ui,
    api,
    midia,
    ativo,
    navegar: (destino, opcoes) => { if (ativo()) navegar(destino, opcoes); },
    marcarAlterado: (sim = true) => { if (ativo()) definirAlterado(sim); },
    definirTitulo: (titulo) => { if (ativo()) definirTitulo(titulo); },
    atualizarContadores: () => atualizarContadores(true),
    publicarHome: (opcoes = {}) => publicarHome({ supabase: estado.supabase, ...opcoes }),
  };
}

// Ao entrar: se o template ou o conteúdo mudaram desde a última publicação, publica a home de novo.
async function conferirPublicacaoDaHome() {
  try {
    const r = await publicarHome({ supabase: estado.supabase });
    if (!r.ok) console.warn('[painel] não foi possível conferir a publicação do site:', r.mensagem || r.erro);
  } catch (erro) {
    console.warn('[painel] não foi possível conferir a publicação do site:', erro);
  }
}

function paginaNaoEncontrada(raiz) {
  raiz.append(
    ui.cabecalhoPagina({ titulo: 'Página não encontrada' }),
    ui.estadoVazio(null, 'O endereço aberto não existe no painel. Confira o link ou use o menu.', {
      icone: 'busca', acao: { texto: 'Ir para a visão geral', href: '#/', icone: 'inicio' },
    }),
  );
}

async function mostrarRotaAtual() {
  if (!estado.painel) return;
  const hash = window.location.hash.startsWith('#/') ? window.location.hash : '#/';
  if (window.location.hash !== hash) window.history.replaceState(window.history.state, '', hash);
  executarLimpeza();
  estado.geracao += 1;
  const geracao = estado.geracao;
  definirAlterado(false);
  estado.hashAtual = hash;
  fecharMenu();

  const rota = resolverRota(hash);
  marcarMenuAtivo(rota ? rota.menu : null);
  const raiz = el('div', { class: 'pagina', 'data-pagina': rota ? rota.pagina : 'nao-encontrada' });
  estado.painel.principal.replaceChildren(raiz);
  window.scrollTo(0, 0);
  if (!rota) {
    definirTitulo('Página não encontrada');
    paginaNaoEncontrada(raiz);
    focarTitulo(raiz);
    return;
  }
  definirTitulo(rota.titulo);
  ui.estadoCarregando(raiz, { linhas: 4, mensagem: `Carregando ${rota.titulo.toLowerCase()}…` });
  const controle = new AbortController();
  estado.abortar = controle;

  let modulo;
  try {
    modulo = await carregarPagina(rota.pagina);
  } catch (erro) {
    if (geracao !== estado.geracao) return;
    console.error(`[painel] não foi possível carregar a página ${rota.pagina}:`, erro);
    ui.estadoErro(raiz, 'Não foi possível abrir esta seção. Verifique sua internet e tente de novo.', { aoTentarNovamente: () => mostrarRotaAtual() });
    return;
  }
  if (geracao !== estado.geracao) return;
  raiz.replaceChildren();
  const ctx = criarCtx(raiz, rota, controle.signal, geracao);
  try {
    const limpeza = await modulo.renderizar(ctx);
    if (geracao !== estado.geracao) {
      if (typeof limpeza === 'function') limpeza();
      return;
    }
    estado.limpeza = typeof limpeza === 'function' ? limpeza : null;
  } catch (erro) {
    if (geracao !== estado.geracao) return;
    console.error(`[painel] erro na página ${rota.pagina}:`, erro);
    ui.estadoErro(raiz, 'Esta seção encontrou um erro inesperado. Tente de novo; se continuar, avise o responsável técnico.', {
      aoTentarNovamente: () => mostrarRotaAtual(),
    });
  }
  focarTitulo(raiz);
  atualizarContadores();
}

function focarTitulo(raiz) {
  if (estado.telaAcesso) return;
  const titulo = raiz.querySelector('h1');
  if (titulo) {
    if (!titulo.hasAttribute('tabindex')) titulo.setAttribute('tabindex', '-1');
    titulo.focus({ preventScroll: true });
  } else if (estado.painel) {
    estado.painel.principal.focus({ preventScroll: true });
  }
}

/**
 * Vai para outra rota. opções: { substituir: true } troca a entrada do histórico;
 * { silencioso: true } só atualiza a URL (ex.: filtros na consulta) sem renderizar de novo.
 * Sem `silencioso`, destino igual ao hash atual renderiza a página de novo.
 */
function navegar(destino, { substituir = false, silencioso = false } = {}) {
  const hash = normalizarHash(destino);
  if (silencioso) {
    window.history.replaceState(window.history.state, '', hash);
    estado.hashAtual = hash;
    return;
  }
  if (substituir) {
    window.history.replaceState(window.history.state, '', hash);
    // replaceState não dispara hashchange; forçar cobre o destino igual ao atual ("Tentar novamente").
    aoMudarHash({ forcar: true });
    return;
  }
  if (window.location.hash === hash) {
    aoMudarHash({ forcar: true });
    return;
  }
  window.location.hash = hash;
}

let confirmandoSaida = false;
async function aoMudarHash({ forcar = false } = {}) {
  if (!estado.painel || estado.telaAcesso) return;
  const destino = window.location.hash;
  if (!destino.startsWith('#/') && destino !== '' && destino !== '#') {
    // Âncoras comuns (#conteudo-principal) não são rotas: volta a URL para a rota atual.
    if (estado.hashAtual) window.history.replaceState(window.history.state, '', estado.hashAtual);
    return;
  }
  if (!forcar && (destino || '#/') === estado.hashAtual) return;
  if (estado.alterado) {
    if (confirmandoSaida) return;
    confirmandoSaida = true;
    const ok = await confirmarDescarte();
    confirmandoSaida = false;
    if (!ok) {
      if (estado.hashAtual) window.history.replaceState(window.history.state, '', estado.hashAtual);
      return;
    }
    definirAlterado(false);
  }
  await mostrarRotaAtual();
}

// ---------------------------------------------------------------------------
// Início

function iniciar() {
  const config = window.AMA_CONFIG;
  if (!config) {
    telaConfiguracao({
      titulo: 'Não foi possível abrir o painel',
      texto: 'A configuração do site não carregou. Verifique sua internet e recarregue a página.',
      recarregar: true,
    });
    return;
  }
  if (!config.configurado || !config.supabaseUrl || !config.supabaseAnonKey) {
    telaConfiguracao({
      titulo: 'Painel em configuração',
      texto: 'O painel ainda não está ligado ao banco de dados. Quem cuida da parte técnica precisa preencher SUPABASE_URL e SUPABASE_ANON_KEY nas variáveis do Cloudflare (passo a passo em docs/CONFIGURACAO.md). O site continua funcionando normalmente.',
    });
    return;
  }
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    telaConfiguracao({
      titulo: 'Não foi possível abrir o painel',
      texto: 'Um arquivo do painel não carregou. Recarregue a página; se continuar, avise o responsável técnico.',
      recarregar: true,
    });
    return;
  }

  lerRetornoDoEmail();
  estado.supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  // Registrado logo após o createClient para não perder o PASSWORD_RECOVERY do link do e-mail.
  // O callback não pode esperar outras chamadas do supabase-js (trava o cliente): adia com setTimeout.
  estado.supabase.auth.onAuthStateChange((evento, sessao) => {
    setTimeout(() => tratarEventoAuth(evento, sessao), 0);
  });
  api.configurarApi({
    supabase: estado.supabase,
    supabaseUrl: config.supabaseUrl,
    supabaseAnonKey: config.supabaseAnonKey,
    aoSessaoExpirada,
  });

  window.addEventListener('hashchange', () => aoMudarHash());
  // Esc fecha a gaveta do menu (se não houver um modal aberto por cima).
  window.addEventListener('keydown', (evento) => {
    const p = estado.painel;
    if (evento.key !== 'Escape' || !p || !p.raiz.classList.contains('painel--menu-aberto')) return;
    if (document.querySelector('dialog[open]')) return;
    evento.preventDefault();
    fecharMenu({ devolverFoco: true });
  });
  window.addEventListener('beforeunload', (evento) => {
    if (!estado.alterado) return;
    evento.preventDefault();
    evento.returnValue = '';
  });
  window.matchMedia('(max-width: 1023.98px)').addEventListener('change', ajustarMenuAoTamanho);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById('app')) {
  iniciar();
}
