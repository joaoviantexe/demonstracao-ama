# Arquitetura — Site AMA, painel administrativo e loja

Este documento é o **contrato técnico** do projeto. Nomes de arquivos, tabelas,
colunas, rotas, formatos JSON e atributos descritos aqui são a fonte da verdade:
quem implementa uma parte segue exatamente estes nomes para que as partes se
encaixem sem retrabalho.

## 1. Visão geral

| Camada | Tecnologia | Observação |
|---|---|---|
| Hospedagem | Vercel (preset "Other", sem build) | Estático em `public/`, funções Node em `api/` |
| Banco, login, arquivos | Supabase (Postgres + Auth + Storage) | RLS em todas as tabelas |
| Pagamento | Mercado Pago Checkout Pro (API REST, sem SDK) | Pix, cartão, boleto |
| Frete | Melhor Envio (API REST, token pessoal) + frete fixo | Sem Melhor Envio, o frete fixo precisa estar ligado (não há retirada na sede) |
| E-mail (opcional) | Resend (API REST) | Sem chave, os e-mails são simplesmente pulados |

Princípios:

- **Sem framework e sem etapa de build.** HTML, CSS e JavaScript puros, como o site já é.
  Código novo do navegador usa módulos ES (`<script type="module">`). O código antigo
  (`public/js/main.js`) continua sendo script clássico.
- **Nada de CDN de JavaScript em produção.** O supabase-js é servido de
  `public/vendor/supabase-2.116.0.js` (bundle UMD → `window.supabase.createClient`).
  Única dependência externa de front: Google Fonts (já usada) e o `embed.js` do Instagram.
- **O site continua funcionando sem Supabase configurado**: a home usa o conteúdo
  padrão do template; a loja mostra "loja em configuração".
- **Dinheiro sempre em centavos (inteiro)** no banco, nas APIs e no JS. Só o
  Mercado Pago recebe reais com 2 casas (`centavos / 100`).
- **Preço, estoque e frete são sempre recalculados no servidor.** O navegador
  nunca define valores cobrados.
- Nomes em **português**, sem acentos em identificadores (`preco_centavos`, `aplicarConteudo`).
  Indentação de 2 espaços. Comentários curtos em português, só quando agregam.

## 2. Estrutura de pastas

```
api/                         Funções serverless (cada arquivo = uma rota)
  render.js                  GET /  (rewrite) — home renderizada no servidor
  config.js                  GET /api/config — configuração pública (JS)
  loja/cotacao.js            POST /api/loja/cotacao
  loja/checkout.js           POST /api/loja/checkout
  loja/pedido.js             GET  /api/loja/pedido
  webhooks/mercadopago.js    POST /api/webhooks/mercadopago
  admin/status.js            GET  /api/admin/status        (admin)
  admin/pedido-status.js     POST /api/admin/pedido-status (admin)
  admin/envio.js             POST /api/admin/envio         (admin)
  admin/pagamento.js         POST /api/admin/pagamento     (admin)
  cron/manter-ativo.js       GET  /api/cron/manter-ativo   (Vercel Cron diário: consulta leve ao banco para o
                             projeto Supabase gratuito não ser pausado por inatividade)
lib/                         Código compartilhado do servidor (não vira rota)
  ambiente.js  http.js  supabase.js  dinheiro.js  validacao.js
  mercadopago.js  melhorenvio.js  frete.js  cep.js  loja.js  email.js  admin.js
public/                      Tudo que é servido estaticamente
  css/estilo.css             (existente) + estilos do banner da loja
  css/loja.css               estilos da loja
  img/ …                     (existente)
  js/main.js                 (existente, ajustado)
  js/cms/aplicar.js          motor do CMS (ESM, roda no Node e no navegador)
  js/loja/*.js               módulos da loja
  loja/index.html  produto.html  carrinho.html  checkout.html  pedido.html
  admin/index.html  admin/admin.css  admin/js/**.js
  vendor/supabase-2.116.0.js
templates/home.html          Template da home (conteúdo padrão + atributos data-cms)
supabase/config.toml         Supabase local (desenvolvimento)
supabase/migrations/20261009120000_inicial.sql
supabase/seed.sql            Dados de exemplo só para desenvolvimento local
scripts/dev-server.mjs       Servidor local que imita a Vercel
tests/unit/ tests/integracao/ tests/e2e/
docs/CONFIGURACAO.md         Passo a passo para colocar no ar
vercel.json  package.json  .env.example
```

### 2.1 `vercel.json`

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "outputDirectory": "public",
  "cleanUrls": true,
  "rewrites": [{ "source": "/", "destination": "/api/render" }],
  "functions": { "api/render.js": { "includeFiles": "templates/**" } },
  "crons": [{ "path": "/api/cron/manter-ativo", "schedule": "17 9 * * *" }]
}
```

Mais cabeçalhos de segurança (`X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY` em `/admin/(.*)`).
Não existe `public/index.html`: por isso o rewrite de `/` para `/api/render` funciona.

## 3. Variáveis de ambiente (`lib/ambiente.js`)

| Variável | Uso | Alternativas aceitas |
|---|---|---|
| `SUPABASE_URL` | URL do projeto | `NEXT_PUBLIC_SUPABASE_URL` |
| `SUPABASE_ANON_KEY` | chave pública | `SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` |
| `SUPABASE_SERVICE_ROLE_KEY` | chave secreta (só servidor) | `SUPABASE_SECRET_KEY` |
| `SITE_URL` | URL pública (back_urls, webhooks, e-mails) | `VERCEL_PROJECT_PRODUCTION_URL` (prefixar https://), depois host da requisição |
| `MP_ACCESS_TOKEN` | Mercado Pago | — |
| `MP_WEBHOOK_SECRET` | assinatura secreta dos webhooks MP | — |
| `MELHOR_ENVIO_TOKEN` | token pessoal Melhor Envio | — |
| `MELHOR_ENVIO_AMBIENTE` | `producao` (padrão) ou `sandbox` | — |
| `MELHOR_ENVIO_EMAIL` | e-mail técnico no User-Agent | — |
| `RESEND_API_KEY` | e-mails transacionais (opcional) | — |
| `CRON_SECRET` | protege `/api/cron/manter-ativo` (a Vercel envia `Authorization: Bearer <CRON_SECRET>`) | — |
| `EMAIL_REMETENTE` | ex.: `AMA <loja@seudominio.com.br>` (opcional) | — |
| `MP_API_BASE`, `MELHOR_ENVIO_API_BASE`, `RESEND_API_BASE` | só para testes (servidores falsos) | — |

`lib/ambiente.js` exporta `obterAmbiente()` → objeto normalizado com essas chaves e
flags `supabaseConfigurado`, `mercadoPagoConfigurado`, `melhorEnvioConfigurado`,
`emailConfigurado`. Lê `process.env` a cada chamada (testes mudam o ambiente).
`siteUrl` é sempre uma origem http(s) normalizada ou `''` (`normalizarUrlSite`): sem esquema recebe `https://`
(`http://` para localhost), caminho e barra final são descartados e valor inválido é ignorado com aviso.
Uma chave secreta colada por engano em `SUPABASE_ANON_KEY` (ou aliases) é ignorada (`supabaseAnonKeyRecusada: true`),
para nunca ser publicada pelo `/api/config`.

Chamadas REST ao Supabase:
- anônimas (navegador e servidor): cabeçalho `apikey: <anon>`; no servidor também `Authorization: Bearer <anon>`.
- como serviço (servidor): `apikey: <service>` e `Authorization: Bearer <service>`.
- em nome do admin: `apikey: <anon>` e `Authorization: Bearer <jwt do usuário>`.

## 4. Banco de dados (Supabase)

Arquivo único: `supabase/migrations/20261009120000_inicial.sql`. Pode ser colado
inteiro no SQL Editor do Supabase. Tudo em `public`, RLS ativado em todas as tabelas.

**GRANTs explícitos são obrigatórios**: projetos Supabase novos (desde 30/05/2026, e todos a partir de 30/10/2026)
não dão mais GRANT automático para `anon`, `authenticated` e `service_role` em tabelas novas — sem GRANT a API
responde 42501 mesmo com RLS correta. A migração concede `select/insert/update/delete` (e `usage` nas sequências)
explicitamente a esses papéis em cada tabela; quem limita o acesso é a RLS.

### 4.1 Tabelas

**`admins`** — quem pode usar o painel.
`user_id uuid pk references auth.users(id) on delete cascade`, `email text`, `criado_em timestamptz default now()`.

**`conteudo_site`** — valores editados do CMS.
`chave text pk` (check `^[a-z0-9][a-z0-9._-]{0,119}$`), `valor jsonb not null`,
`atualizado_em timestamptz not null default now()`, `atualizado_por uuid`.
Linha ausente = usar o padrão do template.

**`configuracoes`** — `chave text pk`, `valor jsonb not null default '{}'`,
`publico boolean not null default false`, `atualizado_em timestamptz default now()`.
Chaves usadas (criadas pela migração com valores padrão):

- `loja` (**publico = true**):
  `{ "titulo": "Cosméticos", "subtitulo": "…", "whatsapp": "5591981056049", "instagram": "oscdemulheres", "email_contato": "", "aviso_topo": "", "frete_gratis_acima_centavos": null }`
- `frete` (privado):
  `{ "origem": { "cep": "", "nome": "AMA - Associação de Mulheres na Amazônia", "telefone": "", "email": "", "documento": "", "endereco": "", "numero": "", "complemento": "", "bairro": "", "cidade": "Ananindeua", "uf": "PA" },
     "fixo": { "ativo": false, "opcoes": [ { "id": "fixo-1", "nome": "Entrega local", "preco_centavos": 1500, "prazo_dias": 3, "ufs": ["PA"] } ] },
     "melhor_envio": { "ativo": true, "servicos": [1, 2], "seguro": true, "prazo_extra_dias": 2, "taxa_extra_centavos": 0 },
     "embalagem_padrao": { "peso_gramas": 300, "altura_cm": 4, "largura_cm": 12, "comprimento_cm": 16 } }`
- `checkout` (privado): `{ "parcelas_max": 6, "aceitar_boleto": true, "expiracao_horas": 72 }`
- `notificacoes` (privado): `{ "email_admin": "" }`

**`categorias`** — `id uuid pk default gen_random_uuid()`, `nome text not null`,
`slug text unique not null` (check `^[a-z0-9]+(-[a-z0-9]+)*$`), `descricao text default ''`,
`ordem int not null default 0`, `ativo boolean not null default true`, `criado_em timestamptz default now()`.

**`produtos`** — `id uuid pk default gen_random_uuid()`, `nome text not null`,
`slug text unique not null` (mesmo check), `descricao text not null default ''`,
`preco_centavos int not null check (>= 0)`,
`preco_promocional_centavos int null check (null or (>= 0 and < preco_centavos))`,
`estoque int not null default 0 check (>= 0)`, `controlar_estoque boolean not null default true`,
`ativo boolean not null default false`, `destaque boolean not null default false`,
`categoria_id uuid null references categorias(id) on delete set null`,
`imagens jsonb not null default '[]'` (array de `{ "src": "...", "alt": "..." }`, check `jsonb_typeof = 'array'`),
`peso_gramas int not null default 300 check (> 0)`, `altura_cm numeric(6,1) not null default 4`,
`largura_cm numeric(6,1) not null default 12`, `comprimento_cm numeric(6,1) not null default 16`,
`sku text`, `ordem int not null default 0`, `criado_em`, `atualizado_em` (trigger de atualização).
Preço efetivo = `coalesce(preco_promocional_centavos, preco_centavos)`. O painel não edita promoção, SKU, medidas,
controle de estoque nem endereço (slug): o slug sai do nome na criação e não muda; a migração zera promoções antigas.
Produto só é vendável se `ativo` e preço efetivo > 0.

Não existe sistema de cupons: a migração apaga a tabela `cupons` e as colunas `pedidos.desconto_centavos` e
`pedidos.cupom_codigo` em projetos criados antes da remoção (`drop … if exists`).

**`pedidos`** — `id uuid pk default gen_random_uuid()`,
`numero bigint generated always as identity unique` (exibido como `#1001`… começar em 1001),
`token_acesso text not null` (64 hex aleatórios; gerado no SQL com dois `gen_random_uuid()` sem hífens),
`status text not null default 'aguardando_pagamento'` check in
(`aguardando_pagamento`, `pagamento_em_analise`, `pago`, `em_separacao`, `enviado`, `entregue`, `cancelado`, `reembolsado`),
`status_pagamento text`, `status_pagamento_detalhe text`, `metodo_pagamento text`,
`mp_preference_id text`, `mp_init_point text`, `mp_payment_id text`,
`cliente_nome text not null`, `cliente_email text not null`, `cliente_telefone text not null`, `cliente_cpf text not null` (só dígitos),
`endereco jsonb not null default '{}'` (`{cep, logradouro, numero, complemento, bairro, cidade, uf}`, sempre preenchido),
`entrega jsonb not null` (`{tipo, id, nome, empresa, prazo_dias, preco_centavos, servico_id}`; `tipo` ∈ `melhor_envio|fixo`).
Não existe retirada na sede: em projetos criados antes, a migração troca o check de `entrega` por um `not valid` (pedidos
antigos de retirada continuam lá, os novos são recusados) e apaga `frete.retirada` da configuração.
`subtotal_centavos int not null`, `frete_centavos int not null default 0`,
`total_centavos int not null check (> 0)`,
`codigo_rastreio text`, `url_rastreio text`, `me_ordens jsonb not null default '[]'` (ids das etiquetas no Melhor Envio), `etiqueta_url text`,
`observacoes text` (do cliente), `notas_internas text` (do admin). Checks: `url_rastreio` null ou `https://` com host
(até 500 caracteres, sem espaços, aspas, `<`, `>`, crase ou barra invertida); `codigo_rastreio` null ou até 200 caracteres
sem `<`, `>`, aspas, crase ou controles (vírgula separa vários códigos).
`estoque_baixado boolean not null default false`,
`pago_em`, `enviado_em`, `entregue_em`, `cancelado_em` (timestamptz null), `criado_em`, `atualizado_em`.

**`pedido_itens`** — `id bigint generated always as identity pk`, `pedido_id uuid not null references pedidos on delete cascade`,
`produto_id uuid null references produtos on delete set null`, `nome text not null`, `imagem text`,
`preco_unitario_centavos int not null`, `quantidade int not null check (between 1 and 99)`, `total_centavos int not null`.

**`pedido_eventos`** — `id bigint identity pk`, `pedido_id uuid not null references pedidos on delete cascade`,
`tipo text not null` (`criado`, `pagamento`, `status`, `envio`, `email`, `nota`, `alerta`),
`descricao text not null`, `dados jsonb`, `autor text` (`sistema`, `mercadopago`, e-mail do admin), `criado_em timestamptz default now()`.

Índices: `produtos(ativo, ordem)`, `produtos(categoria_id)`, `pedidos(status, criado_em desc)`,
`pedidos(mp_payment_id)`, `pedido_itens(pedido_id)`, `pedido_eventos(pedido_id, criado_em)`.

### 4.2 Funções (RPC)

Todas `security definer`, `set search_path = ''` (nomes totalmente qualificados).

- `public.eh_admin() returns boolean` — `stable`; `exists (select 1 from public.admins where user_id = auth.uid())`.
  `execute` liberado para `anon, authenticated`.

- `public.cotar_carrinho(p jsonb) returns jsonb` — **somente `service_role`** (revogar de `public, anon, authenticated`).
  Entrada: `{ "itens": [{ "produto_id": uuid, "quantidade": int }] }` (outros campos são ignorados).
  Junta linhas repetidas do mesmo produto; ignora quantidades ≤ 0; limita a 30 linhas e 99 unidades por linha.
  Saída:
  ```json
  { "itens": [{ "produto_id": "…", "nome": "…", "slug": "…", "imagem": "/img/…", "preco_unitario_centavos": 4500,
                "quantidade": 2, "total_centavos": 9000, "estoque_disponivel": 3, "disponivel": true,
                "motivo": null, "peso_gramas": 300, "altura_cm": 4, "largura_cm": 12, "comprimento_cm": 16 }],
    "subtotal_centavos": 9000 }
  ```
  `motivo` ∈ `null | 'inexistente' | 'inativo' | 'sem_preco' | 'sem_estoque' | 'estoque_insuficiente'`.
  `sem_preco` = produto ativo (visível na vitrine) com preço efetivo 0: a loja mostra "R$ 00,00" e a compra é recusada.
  Itens indisponíveis entram na lista com `disponivel: false` e **não** somam no subtotal.
  Para `inexistente` e `inativo` (produto despublicado) a função **não expõe** dados do produto:
  `nome`, `slug`, `imagem` e `estoque_disponivel` vêm `null` e `preco_unitario_centavos` 0.
  `estoque_disponivel` é `null` quando `controlar_estoque = false`.

- `public.criar_pedido(p jsonb) returns jsonb` — **somente `service_role`**.
  Entrada: `{ itens, cliente: {nome, email, telefone, cpf}, endereco: {...}, entrega: {tipo, id, nome, empresa, prazo_dias, preco_centavos, servico_id}, observacoes }`.
  Reusa `cotar_carrinho`. Erros com `raise exception '<codigo>'` (PostgREST devolve HTTP 400 com `message` = código):
  `carrinho_vazio`, `item_indisponivel`, `dados_invalidos`, `total_invalido`.
  Total = subtotal + `entrega.preco_centavos` (o servidor já calculou o frete). Total precisa ser > 0 e caber num `int`.
  Insere pedido + itens + evento `criado`. Saída: `{ "id", "numero", "token_acesso", "subtotal_centavos", "frete_centavos", "total_centavos", "itens": [...] }`.

- `public.confirmar_pagamento(p_pedido_id uuid, p_pagamento jsonb) returns jsonb` — **somente `service_role`**.
  `p_pagamento` = `{ id, status, status_detail, transaction_amount, payment_type_id, payment_method_id, date_approved }`
  (exatamente como vem de `GET /v1/payments/{id}`). Idempotente, com `select … for update` do pedido:
  - `approved`/`authorized`: se `transaction_amount * 100` (arredondado) < `total_centavos − 1` → status
    `pagamento_em_analise` + evento `alerta` ("valor divergente"). Senão, se o pedido está em
    `aguardando_pagamento|pagamento_em_analise|cancelado` → `pago`, `pago_em = now()`; na primeira vez
    (`estoque_baixado = false`) baixa estoque (`greatest(0, estoque − qtd)` só onde `controlar_estoque`),
    registra `alerta` se faltou estoque e marca `estoque_baixado = true`.
  - `pending`/`in_process`/`in_mediation`: só muda para `pagamento_em_analise` se estava `aguardando_pagamento`.
  - `rejected`/`cancelled`: não muda o status do pedido (cliente pode tentar de novo); só registra. Exceção: se o
    pedido está em `pagamento_em_analise` por causa **deste mesmo** pagamento (mesmo `mp_payment_id`, que estava
    `pending|in_process|in_mediation`), volta para `aguardando_pagamento` (Pix/boleto expirado, cartão recusado).
  - `refunded`/`charged_back`: → `reembolsado`; se `estoque_baixado`, devolve o estoque e zera a flag. Exceção: se
    outro pagamento do mesmo pedido continua aprovado (último evento dele é `approved|authorized`), o pedido
    mantém o status e grava um `alerta` ("pagamento duplicado estornado").
  - Nunca regride `em_separacao|enviado|entregue` para `pago`.
  - Evento repetido (mesmo `payment_id` e mesmo `status`, autor `mercadopago`) não altera status nem estoque.
  - Um pagamento pendente/recusado de outra tentativa não apaga os dados de um pagamento já aprovado.
  - Sempre atualiza `status_pagamento`, `status_pagamento_detalhe`, `mp_payment_id`, `metodo_pagamento`
    (`payment_type_id`) e grava evento `pagamento` (autor `mercadopago`). Evento repetido (mesmo payment id e
    mesmo status) não é gravado de novo.
  Saída: `{ "pedido_id", "numero", "status_anterior", "status_novo", "mudou": bool, "virou_pago": bool }`.

- `public.alterar_status_pedido(p_pedido_id uuid, p_status text, p_autor text, p_nota text default null, p_repor_estoque boolean default false, p_rastreio jsonb default null) returns jsonb` — **somente `service_role`**.
  Ajusta `enviado_em`/`entregue_em`/`cancelado_em`; em `cancelado`/`reembolsado` com `p_repor_estoque` e `estoque_baixado`, devolve o estoque.
  `p_rastreio` = `{codigo_rastreio, url_rastreio}` opcional (`url_rastreio` só `https://`, sem aspas, `<`, `>` ou crase). Grava evento `status`. Saída `{ status_anterior, status_novo }`.

### 4.3 RLS

| Tabela | anon | authenticated não-admin | admin (`eh_admin()`) |
|---|---|---|---|
| `admins` | — | — | select |
| `conteudo_site` | select | select | tudo |
| `configuracoes` | select onde `publico` | select onde `publico` | tudo |
| `categorias` | select onde `ativo` | idem | tudo |
| `produtos` | select onde `ativo` | idem | tudo |
| `pedidos`, `pedido_itens` | — | — | select, update, delete |
| `pedido_eventos` | — | — | select e delete; insert e update só com `tipo = 'nota'` |

O `service_role` ignora RLS (usado só pelas funções da Vercel).

### 4.4 Storage

Bucket `midia`, **público**, limite 50 MB por arquivo, tipos `image/*`, `video/mp4`, `video/webm`.
Policies em `storage.objects` para `bucket_id = 'midia'`: select/insert/update/delete apenas `public.eh_admin()`.
(Leitura pública acontece pela URL pública do bucket, que não passa por policy.)
Pastas: `site/` (CMS), `produtos/`, `videos/`. Nome de arquivo: `<pasta>/<aaaa-mm>/<slug-do-nome>-<6 hex>.<ext>`.

### 4.5 Seeds

A própria migração cria: as 4 linhas de `configuracoes`; as categorias da coleção **Ama Bioessência**
(`body-splash`, `cremes-hidratantes`, `sabonete-liquido-intimo`, `sabonete-solido`) e `biojoias`; e o catálogo
inicial, **ativo, com preços e estoque de teste** (placeholder para os testes de funcionamento; a AMA troca pelos
valores reais no painel): body splash R$ 59,90, cremes R$ 69,90, sabonete líquido R$ 49,90, sabonete sólido R$ 24,90,
biojoias R$ 89,90 e 10 unidades de cada. Em projetos criados quando o catálogo vinha com preço 0, a seção 10 tem um
`update` que aplica esses valores só nos 16 produtos iniciais que continuam com `preco_centavos = 0 and estoque = 0`:
- 10 produtos Ama Bioessência com nome e descrição da apresentação institucional e fotos em `/img/produtos/…`:
  Body Splash Raiz, Bruma, Orvalho e Âmbar (200 mL); Creme Hidratante Ameixa Negra, Cupuaçu, Cumaru e
  Capim-Limão (200 mL); Sabonete Líquido Íntimo Barbatimão & Andiroba (250 mL); Sabonete Sólido Manteiga de Cupuaçu (90 g).
- 6 biojoias (`biojoia-01` … `biojoia-06`) com nome "Nome em Produção", descrição "Descrição em Produção" e as fotos do ateliê.

`supabase/seed.sql` (só desenvolvimento) cria um admin `admin@ama.local` / `admin123456`, marca destaques e SKUs,
deixa um produto em promoção e preenche a origem do frete com dados fictícios.

## 5. CMS — conteúdo editável da home

### 5.1 Como funciona

1. `templates/home.html` é o HTML da home **com o conteúdo atual como padrão** e atributos `data-cms-*`.
2. `GET /` → `api/render.js` lê o template, busca todas as linhas de `conteudo_site`
   (REST anônimo, timeout 2,5 s), aplica com `aplicarConteudo()` (linkedom) e devolve o HTML.
   Se o Supabase falhar ou não estiver configurado, devolve o template puro (cabeçalho `X-AMA-CMS: padrao`).
   Cache: `Cache-Control: public, s-maxage=15, stale-while-revalidate=600`.
   `GET /api/render?modelo=1` devolve o template cru com `Cache-Control: no-store` (o painel usa para montar o formulário).
3. O painel lê o template, roda `extrairEsquema()` para descobrir grupos e campos, mostra os valores atuais
   (linha do banco ou padrão do template) e grava em `conteudo_site`.

### 5.2 Atributos

| Atributo | Onde | Significado |
|---|---|---|
| `data-cms-grupo="id"` | seção/elemento raiz | agrupa campos no painel (`id` em minúsculas, ex.: `quem-somos`) |
| `data-cms-grupo-rotulo="Quem somos"` | mesmo elemento | título do grupo no painel |
| `data-cms-ocultavel` | mesmo elemento | o painel oferece "mostrar/ocultar seção" (chave `grupo.<id>.visivel`, valor booleano) |
| `data-cms="chave"` | elemento | campo simples ou lista; chave `^[a-z0-9][a-z0-9._-]*$` (ex.: `quem-somos.titulo`) |
| `data-cms-tipo="…"` | elemento com `data-cms` ou `data-cms-campo` | tipo (tabela 5.3) |
| `data-cms-rotulo="…"` | idem | rótulo no painel |
| `data-cms-ajuda="…"` | idem (opcional) | dica abaixo do campo |
| `data-cms-item` | filho de uma lista | marca cada item da lista |
| `data-cms-item-rotulo="Depoimento"` | elemento lista | nome de um item no painel |
| `data-cms-campo="nome"` | dentro de um item | campo do item |
| `data-cms-link-texto` | dentro de um `<a>` do tipo `link` | elemento cujo texto é o texto do link |
| `data-cms-fixo` | dentro de campo `html` | filho preservado (vai para o fim) quando o HTML é trocado |

Regras:
- Um campo pertence ao grupo `data-cms-grupo` mais próximo acima dele (`closest`). Campos sem grupo vão para o grupo `geral`.
- A mesma chave pode aparecer em vários elementos (espelhos): todos recebem o valor; o esquema usa o primeiro.
  O mesmo vale para o mesmo `data-cms-campo` repetido dentro de um item.
- Itens de uma lista = elementos `[data-cms-item]` cujo `closest('[data-cms-tipo="lista"]')` é a lista.
  Campos de um item = `[data-cms-campo]` cujo `closest('[data-cms-item]')` é o item.
- Na aplicação, o **primeiro item** (como está no template) é o molde: todos os itens são removidos e os novos
  são inseridos, na ordem, onde estava o primeiro item. Lista vazia `[]` remove todos os itens.
- Valor ausente, `null` ou de formato errado → mantém o padrão do template (nunca quebra a página).
- Listas não podem ser aninhadas.
- Uma lista cujo valor tem os mesmos itens, com os mesmos valores e na mesma ordem dos itens atuais, não é tocada
  (aplicar duas vezes dá o mesmo HTML).
- Chaves, ids de grupo e `data-cms-tipo` valem só exatamente no padrão (sem maiúsculas). Em um `<a>` com ícone
  (filhos elemento), o texto só é editável se houver `[data-cms-link-texto]`.

### 5.3 Tipos de campo

| Tipo | Valor salvo | Aplicação | Leitura (padrão) |
|---|---|---|---|
| `texto` | string | `textContent` | `textContent` com espaços colapsados e `trim` |
| `textolongo` | string com `\n` | texto com `<br>` nas quebras de linha | `<br>` → `\n` |
| `html` | string HTML | `innerHTML = sanitizarHtml(v)`; filhos `[data-cms-fixo]` preservados no fim | `innerHTML` sem os filhos fixos, `trim` |
| `imagem` | `{ src, alt }` | em `<img>`: `src` (se `urlSegura`), `alt`; remove `srcset` | atributos |
| `video` | `{ src, poster }` | em `<video>`: `src`, `poster` | atributos |
| `link` | `{ href, texto }` | `href` (se seguro); texto em `[data-cms-link-texto]` ou no próprio `<a>` se ele não tem filhos elemento | idem |
| `url` | string | `href` em `<a>`, `src` em `img/iframe/video/source` | idem |
| `instagram` | string (URL da publicação) | `iframe.src = instagramParaEmbed(v)` | `embedParaInstagram(src)` |
| `meta` | string | atributo `content` | `content` |
| `lista` | array de objetos `{ campo: valor }` | ver 5.2 | array lido dos itens do template |

`urlSegura(url)` aceita: caminhos relativos (`/x`, `./x`, `x/y.jpg`, `#ancora`, `?q`), `http:`, `https:`, `mailto:`, `tel:`.
Rejeita qualquer outro esquema (`javascript:`, `data:`, `vbscript:` …), inclusive com espaços/maiúsculas/controle no início.

`sanitizarHtml(html, documento)`: permite `p, br, strong, b, em, i, u, s, a, ul, ol, li, blockquote, h3, h4, span`;
em `a` só `href` (seguro), `target="_blank"` e força `rel="noopener noreferrer"` quando há `target`;
todos os outros atributos são removidos; `script, style, iframe, object, embed, svg, math, template, noscript`
e seus conteúdos são removidos (também `frame, noembed, noframes, xmp, plaintext, applet, head, img, input, source, track, param, link, meta, base`); outras tags são "desembrulhadas" (fica o conteúdo).

`instagramParaEmbed`: aceita `https://www.instagram.com/(p|reel|tv)/<codigo>/...` (com ou sem `www`, com query)
e devolve `https://www.instagram.com/<tipo>/<codigo>/embed/captioned/`. URL inválida → mantém o padrão.

### 5.4 Módulo `public/js/cms/aplicar.js` (ESM, sem dependências)

Funciona com qualquer DOM (navegador ou linkedom). Exporta:

```js
export const TIPOS_CAMPO;                            // lista de tipos
export function extrairEsquema(documento);           // → { grupos: [Grupo] }
export function aplicarConteudo(documento, conteudo);// conteudo: { [chave]: valor } — muta o documento
export function lerValor(elemento, tipo);            // valor atual de um elemento
export function sanitizarHtml(html, documento);
export function urlSegura(url);                      // → string segura ou null
export function instagramParaEmbed(url);             // → string ou null
export function embedParaInstagram(src);             // → string ou null
```

`Grupo = { id, rotulo, ocultavel, campos: [Campo] }`,
`Campo = { chave, tipo, rotulo, ajuda, padrao, itemRotulo?, campos?: [{ campo, tipo, rotulo, ajuda }] }`.
Grupos e campos na ordem do documento. `aplicarConteudo` também trata as chaves `grupo.<id>.visivel === false`
removendo o elemento do grupo (só se ele tiver `data-cms-ocultavel`).

### 5.5 Home (`templates/home.html`)

- Caminhos absolutos (`/css/estilo.css`, `/img/...`, `/js/main.js`).
- Grupos: `seo` (no `<head>`: title, description, og), `cabecalho` (logo, menu), `quem-somos`, `postagens`,
  `projetos`, `historia`, `loja` (banner novo), `depoimentos`, `parcerias`, `rodape`, `whatsapp` (botão flutuante).
- A seção `#biojoias` e o modal de produto saem. Entra a seção `#loja` (banner com título, texto, imagem e botão
  para `/loja/`), com o visual da AMA. No menu, "Produtos" vira "Cosméticos" → `/loja/`.
- O visual da página renderizada deve ficar **idêntico** ao atual em tudo que não foi pedido para mudar.

## 6. APIs

Todas respondem JSON `{ "ok": true, ... }` ou `{ "ok": false, "erro": "codigo", "mensagem": "Texto para o cliente" }`
com status HTTP adequado (400 dados inválidos, 401/403 auth, 404, 405 método, 409 conflito de estoque, 502 falha em
serviço externo, 503 integração não configurada). `lib/http.js` abstrai a diferença entre a Vercel (que já entrega
`req.body` e `req.query`) e o servidor local: `lerCorpo(req)`, `lerQuery(req)`, `responderJson(res, status, obj)`,
`exigirMetodo(req, res, ['POST'])`, `urlBase(req)`. Handlers usam só APIs nativas de `res`
(`statusCode`, `setHeader`, `end`). Tamanho máximo de corpo: 100 kB.

### 6.0 Bibliotecas do servidor (`lib/`)

Assinaturas fixas (outras funções internas são livres):

```js
// lib/http.js
export async function lerCorpo(req, { limiteBytes = 100_000 } = {}) // objeto (JSON) ou {}; lança ErroHttp(400) se inválido
                                    // (na Vercel, ler req.body com JSON inválido LANÇA exceção: usar try/catch)
export function lerQuery(req)                                       // objeto simples com os parâmetros da URL
export function responderJson(res, status, objeto, cabecalhos = {})
export function responderErro(res, status, erro, mensagem, extra = {}) // { ok:false, erro, mensagem, ...extra }
export function exigirMetodo(req, res, metodos)                     // true se ok; senão responde 405 e devolve false
export function urlBase(req)                                        // SITE_URL ou protocolo+host da requisição, sem barra final
export class ErroHttp extends Error { constructor(status, erro, mensagem, extra) }
export function tratarErro(res, erro)                               // ErroHttp → resposta; outros → 500 genérico (loga)

// lib/supabase.js
export class ErroSupabase extends Error { status; codigo; detalhes }   // codigo = message do PostgREST (ex.: 'item_indisponivel')
export function servico()  // { select(tabela, query), rpc(nome, args), insert(tabela, dados, {retornar=true}),
                           //   update(tabela, query, dados), remove(tabela, query) } — chave de serviço
export async function selecionarPublico(tabela, query, { timeoutMs = 2500 } = {}) // chave anônima
export async function usuarioDoToken(jwt)  // { id, email } | null

// lib/admin.js
export async function exigirAdmin(req, res) // { id, email } | null (já respondeu 401/403)

// lib/loja.js
export async function cotar({ itens, cep })          // saída de /api/loja/cotacao (sem "ok"); lança ErroHttp
export async function lerConfiguracoes()             // { loja, frete, checkout, notificacoes } com padrões
export async function sincronizarPagamento(pagamento) // confirmar_pagamento + e-mails; devolve o retorno da RPC

// lib/frete.js
export async function cotarFrete({ itens, cep, subtotalCentavos, config }) // → { opcoes, erro, uf }
// lib/mercadopago.js
export async function criarPreferencia({ pedido, itens, cliente, entrega, config, siteUrl })  // → { id, init_point }
export async function obterPagamento(id)            // objeto do MP | null (404)
export async function buscarPagamentosPorReferencia(referencia)
export function validarAssinatura({ xSignature, xRequestId, dataId, segredo }) // → boolean
// lib/melhorenvio.js
export async function calcular({ de, para, volumes|produtos, servicos, valorSeguro })
export async function adicionarAoCarrinho(dados, { desfazerEmFalha }) ; comprar(ids) ; gerar(ids) ; imprimir(ids) ; rastrear(ids) ; saldo()
export async function removerDoCarrinho(id) ; obterEtiqueta(id)
// valorSeguro em CENTAVOS (produtos e volumes). Numa falha no meio de adicionarAoCarrinho(lista), as etiquetas já
// criadas são removidas e o erro traz extra.carrinho_criados / carrinho_removidos / carrinho_orfaos.
// cotarFrete guarda cotações do Melhor Envio em cache por 10 min (limparCacheCotacoes para testes).
// lib/email.js
export async function enviarEmail({ para, assunto, html })  // no-op (false) sem RESEND_API_KEY; nunca lança
export function emailPedidoPago(pedido, opcoes) ; emailPedidoEnviado(pedido, opcoes) ; emailNovoPedidoAdmin(pedido, opcoes)
export function emailStatusPedido(pedido, opcoes) // → { assunto, html } | null
// opcoes = { siteUrl, whatsapp: configuracoes.loja.whatsapp }
```

Servidores falsos para testes (`tests/apoio/`): `mercadopago-falso.js` e `melhorenvio-falso.js` exportam
`iniciar({ porta })` → `{ url, fechar(), estado }`. O MP falso implementa `POST /checkout/preferences`
(devolve `init_point = <url>/pagar/<pref_id>`), `GET /v1/payments/:id`, `GET /v1/payments/search` e a página
`GET /pagar/:pref_id` com botões **Aprovar**, **Pendente** e **Recusar**: cria o pagamento, envia o webhook
assinado para a `notification_url` (com `x-signature`/`x-request-id` válidos para o segredo `segredo-teste`)
e redireciona para a `back_urls.success|pending|failure` com `payment_id`, `status`, `external_reference`.

### 6.1 `GET /api/config`
`Content-Type: application/javascript`; corpo: `window.AMA_CONFIG = {"supabaseUrl":"…","supabaseAnonKey":"…","configurado":true};`
`Cache-Control: public, max-age=300`. Sem Supabase: `configurado:false` e strings vazias.

### 6.2 `POST /api/loja/cotacao`
Entrada `{ "itens": [{ "produto_id", "quantidade" }], "cep": "66000-000"? }`.
Saída:
```json
{ "ok": true, "itens": [ …como cotar_carrinho… ], "subtotal_centavos": 9000,
  "frete": { "opcoes": [Opcao], "erro": "mensagem" | null } | null,
  "frete_gratis_acima_centavos": 20000 | null }
```
`Opcao = { "id": "me-1" | "fixo-1", "tipo": "melhor_envio"|"fixo", "nome": "PAC", "empresa": "Correios",
 "prazo_dias": 7 | null, "prazo_texto": "até 7 dias úteis", "preco_centavos": 2350, "preco_original_centavos": 2350, "gratis": false, "servico_id": 1 | null }`.
`frete` é `null` quando não veio CEP. Regras de frete (`lib/frete.js`):
- Melhor Envio (se configurado e `melhor_envio.ativo`): cota os serviços configurados com origem `frete.origem.cep`,
  produtos com peso/dimensões (mínimos dos Correios garantidos), seguro = valor dos itens se `seguro`.
  Soma `prazo_extra_dias` e `taxa_extra_centavos`. Ignora serviços com `error`. Usa `custom_price`/`custom_delivery_time` quando existirem.
- Fixo (se `fixo.ativo`): opções cuja lista `ufs` contém a UF do CEP (a UF sai da tabela de faixas de CEP em `lib/cep.js`, sem rede; lista vazia = todas).
- Frete grátis: se o subtotal ≥ `loja.frete_gratis_acima_centavos`,
  a opção paga **mais barata** fica com preço 0 e `gratis: true`.
- Ordenação: por preço, depois prazo e nome. CEP inválido ou sem nenhuma forma de entrega: `opcoes: []` e `erro`.
- Erro do Melhor Envio não derruba a cotação: devolve as outras opções e `frete.erro`.

### 6.3 `POST /api/loja/checkout`
Entrada:
```json
{ "itens": [...], "frete_id": "me-1",
  "cliente": { "nome", "email", "telefone", "cpf" },
  "endereco": { "cep", "logradouro", "numero", "complemento", "bairro", "cidade", "uf" },
  "observacoes": "…"? }
```
Valida (nome ≥ 2 palavras, e-mail, telefone 10–11 dígitos, CPF com dígitos verificadores, endereço sempre completo),
recota no servidor, acha a opção `frete_id` (senão 409 `frete_indisponivel`), chama `criar_pedido`,
cria a preferência no Mercado Pago, grava `mp_preference_id` e `mp_init_point`, devolve
`{ "ok": true, "pedido": { "id", "numero", "token" }, "redirecionar": "<init_point>" }`.
Sem Mercado Pago configurado → 503 `pagamento_indisponivel` **antes** de criar o pedido.
Item indisponível → 409 `item_indisponivel` com `itens` atualizados.

Preferência (`lib/mercadopago.js`): itens com `unit_price` em reais (se os itens não fecharem com o total, um único
item "Pedido #N — AMA" com o valor dos produtos); frete como item separado "Frete — <nome>" quando > 0;
`payer` (nome, sobrenome, e-mail, telefone, CPF); `external_reference = pedido.id`;
`notification_url = <SITE_URL>/api/webhooks/mercadopago`;
`back_urls` = `<SITE_URL>/loja/pedido?id=<id>&token=<token>` (as três); `auto_return: "approved"`;
`statement_descriptor: "AMA"` (máx. 13 caracteres); `payment_methods.installments = min(parcelas_max, 12)`; se `aceitar_boleto` for false, exclui `ticket`;
`expires: true` com `expiration_date_to = agora + expiracao_horas` (mínimo 72 h, por causa de Pix/boleto); cabeçalho `X-Idempotency-Key = pedido.id`.
`notification_url` leva `?source_news=webhooks`. O Mercado Pago exige **HTTPS** em `back_urls`/`notification_url`
e recusa `localhost`: se `SITE_URL` não for https, omitir `auto_return` e `notification_url` (só desenvolvimento).
`unit_price` com no máximo 2 casas; nunca item com preço negativo. Usar sempre `init_point` (não existe mais sandbox).

### 6.4 `GET /api/loja/pedido?id=&token=[&payment_id=]`
Compara o token em tempo constante (senão 404). Se veio `payment_id` e o MP está configurado: busca o pagamento,
confere `external_reference === id` e chama `confirmar_pagamento` (sincroniza mesmo sem webhook).
Saída `{ "ok": true, "pedido": { numero, status, status_pagamento, criado_em, pago_em, enviado_em, itens:[{nome, imagem,
quantidade, preco_unitario_centavos, total_centavos}], subtotal_centavos, frete_centavos, total_centavos,
entrega:{tipo, nome, empresa, prazo_dias}, codigo_rastreio, url_rastreio, primeiro_nome, pode_pagar, link_pagamento } }`.
`pode_pagar` = status `aguardando_pagamento` e há `mp_init_point`. `Cache-Control: no-store`.

### 6.5 `POST /api/webhooks/mercadopago`
1. Aceita os dois formatos: Webhooks (`?data.id=123&type=payment`, corpo `{type, action, data:{id}}`) e IPN
   (`?topic=payment&id=123`). `data.id` vem preferencialmente da **query string**. Tópicos que não são pagamento
   (`merchant_order` etc.) → 200 ignorado.
2. Se `MP_WEBHOOK_SECRET` existe **e** veio `x-signature`, valida (`ts=…,v1=…`) com HMAC-SHA256 do manifesto
   `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` (partes ausentes omitidas por inteiro; usa o `ts` literal),
   comparação em tempo constante. Inválida → 401. Sem `x-signature` (IPN, ou notificação não assinada) o processamento
   continua, porque o passo 3 consulta o próprio Mercado Pago — um aviso falso não consegue marcar nada como pago.
3. Busca `GET /v1/payments/{id}` (fonte da verdade). 404 do MP → 200 ignorado. `external_reference` que não é UUID
   de um pedido existente → 200 ignorado.
4. `confirmar_pagamento`. Se `virou_pago`: e-mail ao cliente e ao admin (se configurado). Responde 200.
5. Falha transitória (banco/MP fora) → 500 para o MP tentar de novo.

### 6.6 Rotas de admin (`Authorization: Bearer <jwt do Supabase>`)
`lib/admin.js` → `exigirAdmin(req, res)`: valida o JWT em `GET <SUPABASE_URL>/auth/v1/user` e confere `admins`
com a chave de serviço. Sem token/inválido → 401; não admin → 403. Devolve `{ id, email }`.

- `GET /api/admin/status` → `{ ok, integracoes: { supabase: {configurado}, mercadopago: {configurado, modo: 'teste'|'producao'|null},
  melhor_envio: {configurado, ambiente, saldo_centavos|null, erro|null}, email: {configurado}, webhook_assinatura: bool, site_url } }`.
- `POST /api/admin/pedido-status` `{ pedido_id, status, codigo_rastreio?, url_rastreio?, nota?, repor_estoque?, notificar_cliente? }`
  → `alterar_status_pedido` (autor = e-mail do admin); se `notificar_cliente` e status `enviado`/`entregue`/`cancelado`, envia e-mail.
- `POST /api/admin/envio` `{ pedido_id, acao, chave_nfe? }`, `acao` ∈ `adicionar_carrinho | comprar | gerar | imprimir | rastrear`.
  `adicionar_carrinho` recota o serviço `entrega.servico_id` com os itens do pedido e cria **um item de carrinho por
  pacote** devolvido em `packages` (Correios não aceita vários volumes por etiqueta), com remetente de `frete.origem`,
  destinatário do pedido (nome, CPF, telefone, e-mail, endereço). Com `chave_nfe` envia `options.invoice.key` e
  `non_commercial: false`; sem ela, declaração de conteúdo (`non_commercial: true`). `comprar` confere o saldo
  (`GET /me/balance`) antes; `imprimir` confere `generated_at` de cada etiqueta (geração é assíncrona) e usa `mode: "public"`.
  Salva `me_ordens`, `etiqueta_url`, `codigo_rastreio` (vários separados por vírgula); registra evento `envio`.
  Só para pedidos com `entrega.tipo = 'melhor_envio'` e status `pago`/`em_separacao`/`enviado`.
- `POST /api/admin/pagamento` `{ pedido_id }` → `GET /v1/payments/search?external_reference=<id>`; escolhe o aprovado
  mais recente, senão o mais recente; `confirmar_pagamento`; devolve o resultado.

## 7. Loja (`/loja/…`)

Páginas estáticas com o cabeçalho e rodapé da AMA (mesmas classes de `estilo.css`), mais `public/css/loja.css`.
Carregam `/api/config` (script clássico, antes dos módulos), `/js/main.js` (menu e efeitos) e um módulo da pasta `public/js/loja/`.

| Página | Arquivo | Módulo |
|---|---|---|
| Catálogo `/loja/` | `public/loja/index.html` | `js/loja/catalogo.js` |
| Produto `/loja/produto?slug=` | `public/loja/produto.html` | `js/loja/produto.js` |
| Carrinho `/loja/carrinho` | `public/loja/carrinho.html` | `js/loja/carrinho-pagina.js` |
| Checkout `/loja/checkout` | `public/loja/checkout.html` | `js/loja/checkout.js` |
| Pedido `/loja/pedido?id=&token=` | `public/loja/pedido.html` | `js/loja/pedido.js` |

Módulos de apoio: `js/loja/config.js` (lê `window.AMA_CONFIG`, `restGet(caminho)` para o PostgREST com `apikey`),
`js/loja/formatos.js` (`formatarPreco`, máscaras de CEP/CPF/telefone, `validarCpf`, `escaparHtml`, `slugify`),
`js/loja/carrinho.js` (estado no `localStorage` `ama_carrinho_v1` = `[{ produto_id, quantidade, nome, preco_centavos, imagem, slug }]`
— os dados extras são só para exibir rápido; o servidor sempre recota; evento `window` `carrinho:mudou`),
`js/loja/api.js` (`cotar`, `finalizar`, `consultarPedido`), `js/loja/comum.js` (contador do carrinho no cabeçalho,
toasts, rodapé com dados de `configuracoes.loja`, aviso de loja em configuração).

Leitura de produtos pelo navegador (RLS garante só ativos):
`GET <supabaseUrl>/rest/v1/produtos?select=id,nome,slug,descricao,preco_centavos,preco_promocional_centavos,estoque,controlar_estoque,imagens,destaque,categoria_id,categorias(nome,slug)&ativo=eq.true&order=destaque.desc,ordem.asc,criado_em.desc`.
Categorias: `GET /rest/v1/categorias?select=id,nome,slug&ativo=eq.true&order=ordem.asc`.
Configuração pública: `GET /rest/v1/configuracoes?select=valor&chave=eq.loja`.

Produto com preço 0 (ativo): aparece na vitrine como um produto normal (a loja é apresentada como versão final),
com o preço "R$ 00,00", sem selo e sem "Esgotado"; pode ir para o carrinho, mas o servidor recusa a compra
(`motivo: 'sem_preco'`) e o carrinho pede para remover o item. **A loja não oferece pedido pelo WhatsApp** em nenhum
ponto; o WhatsApp aparece só como contato institucional (botão flutuante e rodapé) e como suporte na página do pedido.
O rodapé das páginas da loja é o mesmo da página inicial (grupo `rodape` do CMS, aplicado no navegador por `comum.js`).

Funcionalidades: busca, filtro por categoria (na URL `?categoria=`), ordenação, selo de promoção e "esgotado",
página de produto com galeria e miniaturas, quantidade limitada ao estoque, "Adicionar ao carrinho" e "Comprar agora",
cálculo de frete por CEP na página do produto e do carrinho, checkout com autopreenchimento de endereço pelo
ViaCEP (`https://viacep.com.br/ws/<cep>/json/`), página do pedido com linha do
tempo, rastreio e "Pagar agora". "Meus pedidos neste aparelho": a página do pedido guarda `{id, token, numero, criado_em}`
em `localStorage` `ama_pedidos_v1` e `/loja/pedido` sem parâmetros lista esses pedidos.
Ao voltar do pagamento aprovado o carrinho é limpo.

## 8. Painel (`/admin/`)

`public/admin/index.html` carrega `/api/config`, `/vendor/supabase-2.116.0.js`, `admin/admin.css` e o módulo `admin/js/app.js`.

- `app.js`: cria o cliente (`window.supabase.createClient(url, anonKey)`), tela de login (e-mail e senha; não há "esqueci minha senha": a senha é trocada pelo Supabase),
  tratamento do evento `PASSWORD_RECOVERY` e de convites (tela de nova senha),
  verificação de admin (`rpc('eh_admin')`; não admin → mensagem e sair), layout (menu lateral, topo com e-mail, "Ver site", "Sair"),
  roteador por hash e aviso de alterações não salvas.
- Rotas: `#/` visão geral · `#/conteudo` e `#/conteudo/<grupo>` (o menu lateral lista cada grupo da página inicial; não há página de mídia) · `#/produtos`, `#/produtos/novo`, `#/produtos/<id>` ·
  `#/categorias` · `#/pedidos`, `#/pedidos/<id>` · `#/configuracoes`.
- Contrato das páginas: cada arquivo em `admin/js/paginas/` exporta
  `export async function renderizar(ctx)` e pode devolver uma função de limpeza.
  `ctx = { raiz, supabase, usuario, params, navegar(hash), marcarAlterado(bool), ui, api }`.
- `admin/js/ui.js`: `toast(msg, tipo)`, `confirmar(msg, {perigo}) → Promise<boolean>`, `escapar(txt)`,
  `formatarPreco(centavos)`, `lerPreco("12,50") → 1250`, `formatarData(iso)`, `slugify(txt)`, `el(tag, attrs, ...filhos)`,
  `estadoCarregando(container)`, `estadoVazio(container, msg)`, `rotuloStatusPedido(status)`, `corStatusPedido(status)`,
  `carregarCss(nome)` (insere `<link>` para `/admin/css/<nome>.css` uma única vez), `modal({ titulo, conteudo, acoes })`.
- `admin/js/api.js`: `chamarApi(caminho, {metodo, corpo})` com o JWT da sessão.
- `admin/js/midia.js`: `enviarArquivo(arquivo, pasta) → { url, caminho }` (bucket `midia`, nome seguro, aviso de tamanho),
  `listarArquivos(pasta)`, `apagarArquivo(caminho)`, `seletorDeMidia({ tipo: 'imagem'|'video' }) → Promise<url|null>` (modal com biblioteca + upload).
- Páginas: `visao-geral.js`, `conteudo.js`, `produtos.js`, `categorias.js`, `pedidos.js`, `configuracoes.js`.
- Estilos: `admin/admin.css` é o sistema de design do painel (botões, campos, cartões, tabelas, selos de status,
  modais, abas, listas, área de upload, grade responsiva). Estilos específicos de uma página ficam em
  `admin/css/<pagina>.css`, carregados pela própria página com `ui.carregarCss('<pagina>')`.
  As classes e componentes disponíveis ficam documentados em `docs/PAINEL.md`.

Editor de conteúdo: grupos vindos de `extrairEsquema` (template de `/api/render?modelo=1`); editores por tipo
(texto, textarea, editor rico com barra Negrito/Itálico/Link/Lista/Parágrafo + `sanitizarHtml`, imagem com prévia,
upload, biblioteca e texto alternativo, vídeo com upload e capa, link, URL, Instagram, listas com adicionar/remover/
subir/descer; o menu do cabeçalho não cria itens novos), "Restaurar padrão" por campo (apaga a linha), "Salvar"
(upsert só do que mudou) e "Ver no site".
Os editores do site não têm prévia (nem botão "Pré-visualizar" nem prévia ao vivo); "Ver no site" abre a página.
Campos com `data-cms-editor="produto"` (fotos do Banner da Loja) são escolhidos entre os produtos (capa + nome).
"Identidade" (`identidade.logo`) é a logo do topo, do menu do celular e do rodapé (espelhos da mesma chave).

Produtos: formulário em uma coluna — Informações (nome, descrição, categoria), Fotos, Preço, Disponibilidade (à venda e
estoque) e Visualização (destaque e posição, com o cartão na vitrine entre os vizinhos e "Mais para o começo/fim",
que ajusta `ordem`). Nada é obrigatório: nome vazio vira "Produto sem Nome"; preço e estoque começam em 0.

Pedidos: lista com busca (nome, e-mail, telefone, CPF ou número), filtro por situação (guardado na URL) e páginas
de 20; detalhe com a próxima ação sugerida, itens, cliente (link do WhatsApp), entrega, pagamento ("Conferir no
Mercado Pago" → `/api/admin/pagamento`), linha do tempo (só histórico: não há campo de nova nota),
"Mudar situação" (`/api/admin/pedido-status`, com rastreio, repor estoque e aviso por e-mail) e o assistente de
envio do Melhor Envio (`/api/admin/envio`: carrinho com NF-e opcional → pagar com o saldo → gerar → imprimir →
buscar rastreio → marcar como enviado). Pedido aguardando pagamento pode ser apagado. Lista e detalhe se atualizam
sozinhos a cada 20 s e ao voltar para a aba (sem botão "Atualizar"); o painel inteiro usa uma coluna.

Configurações (`?aba=` na URL): Loja (nome e descrição; o WhatsApp vem de Site → Botão do WhatsApp, que vale para o site todo e a loja), Frete
(Melhor Envio com prazo e valor a mais e seguro; frete fixo com nome, valor, prazo e estados; remetente; frete
grátis a partir de um valor; sem retirada), Pagamento (parcelas, boleto, prazo para pagar), Avisos por e-mail
(e-mails da equipe); não há tela de integrações (o painel mostra o mínimo). Cada aba tem o próprio
"Salvar" e grava só a sua linha em `configuracoes` (a aba Frete também grava o frete grátis em `loja`).

## 9. Testes

- `npm test` — unitários (`node --test`), sem rede: CMS (linkedom), sanitização, URLs, Instagram, validações,
  assinatura do webhook, regras de frete, montagem da preferência, handlers com `fetch` simulado.
- `npm run test:integracao` — exige o Supabase local (`supabase start`) e `supabase db reset`: RLS, RPCs,
  idempotência do pagamento e do estoque, APIs completas contra servidores falsos do MP e do Melhor Envio.
- `npm run test:e2e` — Playwright (`tests/e2e/`), exige o Supabase local com o seed: admin edita o site; cliente
  compra; pagamento aprovado no MP falso (webhook assinado); estoque baixa; admin envia pelo Melhor Envio falso
  (carrinho → pagar → gerar → imprimir → rastreio → enviado); cliente vê o rastreio.

## 10. Segurança (revisão final)

- **Segredos:** só a URL e a chave pública do Supabase chegam ao navegador (`/api/config`, que recusa uma chave
  secreta colada no lugar da pública). Tokens do Mercado Pago, do Melhor Envio, do Resend e a chave de serviço
  ficam só nas funções da Vercel; o painel mostra apenas se cada uma está configurada.
- **RLS:** ligada em todas as tabelas; visitante e usuário comum leem só o que é público; escrita só para admin
  (`eh_admin()`); as RPCs de pedido e pagamento só rodam com a chave de serviço (testado em `banco.test.js`).
- **Rotas de admin:** todas exigem o JWT de um admin (`exigirAdmin`).
- **Webhook:** com `MP_WEBHOOK_SECRET`, assinatura inválida → 401; em qualquer caso o pagamento é consultado no
  próprio Mercado Pago, e valor pago menor que o total deixa o pedido "em análise" em vez de "pago".
- **Pedido do cliente:** token de 256 bits, comparado em tempo constante; id ou token errado → o mesmo 404; a
  resposta não traz CPF, e-mail, telefone, endereço nem notas internas.
- **XSS:** loja e painel criam elementos com `textContent` (sem `innerHTML` com dados); o HTML do editor rico é
  limpo no painel e de novo no servidor ao montar a página (tags e atributos permitidos, links só http/https/
  mailto/tel); os e-mails escapam todo texto. Conferido com conteúdo malicioso gravado direto no banco.
