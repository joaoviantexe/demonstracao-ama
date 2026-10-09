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
| Frete | Melhor Envio (API REST, token pessoal) + frete fixo + retirada | Melhor Envio é opcional |
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
- **Preço, estoque, cupom e frete são sempre recalculados no servidor.** O navegador
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
lib/                         Código compartilhado do servidor (não vira rota)
  ambiente.js  http.js  supabase.js  dinheiro.js  validacao.js
  mercadopago.js  melhorenvio.js  frete.js  loja.js  email.js  admin.js
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
  "functions": { "api/render.js": { "includeFiles": "templates/**" } }
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
| `EMAIL_REMETENTE` | ex.: `AMA <loja@seudominio.com.br>` (opcional) | — |
| `MP_API_BASE`, `MELHOR_ENVIO_API_BASE`, `RESEND_API_BASE` | só para testes (servidores falsos) | — |

`lib/ambiente.js` exporta `obterAmbiente()` → objeto normalizado com essas chaves e
flags `supabaseConfigurado`, `mercadoPagoConfigurado`, `melhorEnvioConfigurado`,
`emailConfigurado`. Lê `process.env` a cada chamada (testes mudam o ambiente).

Chamadas REST ao Supabase:
- anônimas (navegador e servidor): cabeçalho `apikey: <anon>`; no servidor também `Authorization: Bearer <anon>`.
- como serviço (servidor): `apikey: <service>` e `Authorization: Bearer <service>`.
- em nome do admin: `apikey: <anon>` e `Authorization: Bearer <jwt do usuário>`.

## 4. Banco de dados (Supabase)

Arquivo único: `supabase/migrations/20261009120000_inicial.sql`. Pode ser colado
inteiro no SQL Editor do Supabase. Tudo em `public`, RLS ativado em todas as tabelas.

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
  `{ "titulo": "Loja AMA", "subtitulo": "…", "whatsapp": "5591981056049", "instagram": "oscdemulheres", "email_contato": "", "aviso_topo": "", "frete_gratis_acima_centavos": null }`
- `frete` (privado):
  `{ "origem": { "cep": "", "nome": "AMA - Associação de Mulheres na Amazônia", "telefone": "", "email": "", "documento": "", "endereco": "", "numero": "", "complemento": "", "bairro": "", "cidade": "Ananindeua", "uf": "PA" },
     "retirada": { "ativa": true, "nome": "Retirar na sede da AMA", "endereco": "Conjunto Uirapuru, Quadra 28, Casa 02, Icuí, Ananindeua - PA", "prazo_texto": "Combine a retirada pelo WhatsApp" },
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
Preço efetivo = `coalesce(preco_promocional_centavos, preco_centavos)`.
Produto só é vendável se `ativo` e preço efetivo > 0.

**`cupons`** — `id uuid pk`, `codigo text unique not null` (check `codigo = upper(codigo)` e `^[A-Z0-9_-]{3,30}$`),
`descricao text default ''`, `tipo text not null check in ('percentual','fixo','frete_gratis')`,
`valor int not null default 0` (percentual: 1–100; fixo: centavos), `minimo_centavos int not null default 0`,
`inicio timestamptz null`, `fim timestamptz null`, `usos_max int null`, `usos int not null default 0`,
`ativo boolean not null default true`, `criado_em`.

**`pedidos`** — `id uuid pk default gen_random_uuid()`,
`numero bigint generated always as identity unique` (exibido como `#1001`… começar em 1001),
`token_acesso text not null` (64 hex aleatórios; gerado no SQL com dois `gen_random_uuid()` sem hífens),
`status text not null default 'aguardando_pagamento'` check in
(`aguardando_pagamento`, `pagamento_em_analise`, `pago`, `em_separacao`, `enviado`, `entregue`, `cancelado`, `reembolsado`),
`status_pagamento text`, `status_pagamento_detalhe text`, `metodo_pagamento text`,
`mp_preference_id text`, `mp_init_point text`, `mp_payment_id text`,
`cliente_nome text not null`, `cliente_email text not null`, `cliente_telefone text not null`, `cliente_cpf text not null` (só dígitos),
`endereco jsonb not null default '{}'` (`{cep, logradouro, numero, complemento, bairro, cidade, uf}` — vazio na retirada),
`entrega jsonb not null` (`{tipo, id, nome, empresa, prazo_dias, preco_centavos, servico_id}`; `tipo` ∈ `melhor_envio|fixo|retirada`),
`subtotal_centavos int not null`, `desconto_centavos int not null default 0`, `frete_centavos int not null default 0`,
`total_centavos int not null check (> 0)`, `cupom_codigo text`,
`codigo_rastreio text`, `url_rastreio text`, `me_ordem_id text`, `etiqueta_url text`,
`observacoes text` (do cliente), `notas_internas text` (do admin),
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
  Entrada: `{ "itens": [{ "produto_id": uuid, "quantidade": int }], "cupom": "CODIGO" | null }`.
  Junta linhas repetidas do mesmo produto; ignora quantidades ≤ 0; limita a 30 linhas e 99 unidades por linha.
  Saída:
  ```json
  { "itens": [{ "produto_id": "…", "nome": "…", "slug": "…", "imagem": "/img/…", "preco_unitario_centavos": 4500,
                "quantidade": 2, "total_centavos": 9000, "estoque_disponivel": 3, "disponivel": true,
                "motivo": null, "peso_gramas": 300, "altura_cm": 4, "largura_cm": 12, "comprimento_cm": 16 }],
    "subtotal_centavos": 9000, "desconto_centavos": 900,
    "cupom": { "codigo": "AMA10", "valido": true, "tipo": "percentual", "mensagem": "Cupom aplicado: 10% de desconto" } | null,
    "frete_gratis_cupom": false }
  ```
  `motivo` ∈ `null | 'inexistente' | 'inativo' | 'sem_estoque' | 'estoque_insuficiente'`.
  Itens indisponíveis entram na lista com `disponivel: false` e **não** somam no subtotal.
  `estoque_disponivel` é `null` quando `controlar_estoque = false`.
  Cupom inválido → `valido: false` + mensagem (`Cupom não encontrado`, `Cupom expirado`, `Cupom esgotado`,
  `Valor mínimo para este cupom: R$ X`), desconto 0. Desconto: percentual = `floor(subtotal * valor / 100)`;
  fixo = `least(valor, subtotal)`; frete_gratis = 0 e `frete_gratis_cupom: true`.

- `public.criar_pedido(p jsonb) returns jsonb` — **somente `service_role`**.
  Entrada: `{ itens, cupom, cliente: {nome, email, telefone, cpf}, endereco: {...}, entrega: {tipo, id, nome, empresa, prazo_dias, preco_centavos, servico_id}, observacoes }`.
  Reusa `cotar_carrinho`. Erros com `raise exception '<codigo>'` (PostgREST devolve HTTP 400 com `message` = código):
  `carrinho_vazio`, `item_indisponivel`, `cupom_invalido` (só se um cupom foi informado e é inválido), `dados_invalidos`, `total_invalido`.
  Total = subtotal − desconto + `entrega.preco_centavos` (o servidor já calculou o frete). Total precisa ser > 0.
  Insere pedido + itens + evento `criado`. Saída: `{ "id", "numero", "token_acesso", "subtotal_centavos", "desconto_centavos", "frete_centavos", "total_centavos", "itens": [...] }`.

- `public.confirmar_pagamento(p_pedido_id uuid, p_pagamento jsonb) returns jsonb` — **somente `service_role`**.
  `p_pagamento` = `{ id, status, status_detail, transaction_amount, payment_type_id, payment_method_id, date_approved }`
  (exatamente como vem de `GET /v1/payments/{id}`). Idempotente, com `select … for update` do pedido:
  - `approved`/`authorized`: se `transaction_amount * 100` (arredondado) < `total_centavos − 1` → status
    `pagamento_em_analise` + evento `alerta` ("valor divergente"). Senão, se o pedido está em
    `aguardando_pagamento|pagamento_em_analise|cancelado` → `pago`, `pago_em = now()`; na primeira vez
    (`estoque_baixado = false`) baixa estoque (`greatest(0, estoque − qtd)` só onde `controlar_estoque`),
    registra `alerta` se faltou estoque, marca `estoque_baixado = true` e soma 1 em `cupons.usos`.
  - `pending`/`in_process`/`in_mediation`: só muda para `pagamento_em_analise` se estava `aguardando_pagamento`.
  - `rejected`/`cancelled`: não muda o status do pedido (cliente pode tentar de novo); só registra.
  - `refunded`/`charged_back`: → `reembolsado`; se `estoque_baixado`, devolve o estoque e zera a flag.
  - Nunca regride `em_separacao|enviado|entregue` para `pago`.
  - Sempre atualiza `status_pagamento`, `status_pagamento_detalhe`, `mp_payment_id`, `metodo_pagamento`
    (`payment_type_id`) e grava evento `pagamento` (autor `mercadopago`). Evento repetido (mesmo payment id e
    mesmo status) não é gravado de novo.
  Saída: `{ "pedido_id", "numero", "status_anterior", "status_novo", "mudou": bool, "virou_pago": bool }`.

- `public.alterar_status_pedido(p_pedido_id uuid, p_status text, p_autor text, p_nota text default null, p_repor_estoque boolean default false, p_rastreio jsonb default null) returns jsonb` — **somente `service_role`**.
  Ajusta `enviado_em`/`entregue_em`/`cancelado_em`; em `cancelado`/`reembolsado` com `p_repor_estoque` e `estoque_baixado`, devolve o estoque.
  `p_rastreio` = `{codigo_rastreio, url_rastreio}` opcional. Grava evento `status`. Saída `{ status_anterior, status_novo }`.

### 4.3 RLS

| Tabela | anon | authenticated não-admin | admin (`eh_admin()`) |
|---|---|---|---|
| `admins` | — | — | select |
| `conteudo_site` | select | select | tudo |
| `configuracoes` | select onde `publico` | select onde `publico` | tudo |
| `categorias` | select onde `ativo` | idem | tudo |
| `produtos` | select onde `ativo` | idem | tudo |
| `cupons` | — | — | tudo |
| `pedidos`, `pedido_itens`, `pedido_eventos` | — | — | select, update, delete (e insert em `pedido_eventos` para notas) |

O `service_role` ignora RLS (usado só pelas funções da Vercel).

### 4.4 Storage

Bucket `midia`, **público**, limite 50 MB por arquivo, tipos `image/*`, `video/mp4`, `video/webm`.
Policies em `storage.objects` para `bucket_id = 'midia'`: select/insert/update/delete apenas `public.eh_admin()`.
(Leitura pública acontece pela URL pública do bucket, que não passa por policy.)
Pastas: `site/` (CMS), `produtos/`, `videos/`. Nome de arquivo: `<pasta>/<aaaa-mm>/<slug-do-nome>-<6 hex>.<ext>`.

### 4.5 Seeds

A própria migração cria: as 4 linhas de `configuracoes`; categorias `Biojoias` (slug `biojoias`) e
`Cosméticos` (`cosmeticos`); e os 7 produtos que hoje aparecem na home (mesmos nomes, imagens `/img/...`,
descrição "Em produção.", preço 0, **inativos**) para a AMA só ajustar preço e ativar.
`supabase/seed.sql` (só desenvolvimento) cria um admin `admin@ama.local` / `admin123456`, ativa os produtos com
preços de exemplo e cria o cupom `AMA10`.

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
e seus conteúdos são removidos; outras tags são "desembrulhadas" (fica o conteúdo).

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
  para `/loja/`), com o visual da AMA. No menu, "Produtos" vira "Loja" → `/loja/`.
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
export async function cotar({ itens, cep, cupom })   // saída de /api/loja/cotacao (sem "ok"); lança ErroHttp
export async function lerConfiguracoes()             // { loja, frete, checkout, notificacoes } com padrões
export async function sincronizarPagamento(pagamento) // confirmar_pagamento + e-mails; devolve o retorno da RPC

// lib/frete.js
export async function cotarFrete({ itens, cep, subtotalCentavos, freteGratisCupom, config }) // → { opcoes, erro, uf }
// lib/mercadopago.js
export async function criarPreferencia({ pedido, itens, cliente, entrega, config, siteUrl })  // → { id, init_point }
export async function obterPagamento(id)            // objeto do MP | null (404)
export async function buscarPagamentosPorReferencia(referencia)
export function validarAssinatura({ xSignature, xRequestId, dataId, segredo }) // → boolean
// lib/melhorenvio.js
export async function calcular({ de, para, volumes|produtos, servicos, valorSeguro })
export async function adicionarAoCarrinho(dados) ; comprar(ids) ; gerar(ids) ; imprimir(ids) ; rastrear(ids) ; saldo()
// lib/email.js
export async function enviarEmail({ para, assunto, html })  // no-op (false) sem RESEND_API_KEY; nunca lança
export function emailPedidoPago(pedido) ; emailPedidoEnviado(pedido) ; emailNovoPedidoAdmin(pedido) // → { assunto, html }
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
Entrada `{ "itens": [{ "produto_id", "quantidade" }], "cep": "66000-000"?, "cupom": "AMA10"? }`.
Saída:
```json
{ "ok": true, "itens": [ …como cotar_carrinho… ], "subtotal_centavos": 9000, "desconto_centavos": 900,
  "cupom": { … } | null,
  "frete": { "opcoes": [Opcao], "erro": "mensagem" | null } | null,
  "frete_gratis_acima_centavos": 20000 | null }
```
`Opcao = { "id": "me-1" | "fixo-1" | "retirada", "tipo": "melhor_envio"|"fixo"|"retirada", "nome": "PAC", "empresa": "Correios",
 "prazo_dias": 7 | null, "prazo_texto": "até 7 dias úteis", "preco_centavos": 2350, "preco_original_centavos": 2350, "gratis": false, "servico_id": 1 | null }`.
`frete` é `null` quando não veio CEP. Regras de frete (`lib/frete.js`):
- Melhor Envio (se configurado e `melhor_envio.ativo`): cota os serviços configurados com origem `frete.origem.cep`,
  produtos com peso/dimensões (mínimos dos Correios garantidos), seguro = valor dos itens se `seguro`.
  Soma `prazo_extra_dias` e `taxa_extra_centavos`. Ignora serviços com `error`. Usa `custom_price`/`custom_delivery_time` quando existirem.
- Fixo (se `fixo.ativo`): opções cuja lista `ufs` contém a UF do CEP (UF vem do ViaCEP no servidor; lista vazia = todas).
- Retirada (se `retirada.ativa`): sempre disponível, preço 0.
- Frete grátis: se cupom `frete_gratis` ou subtotal (após desconto) ≥ `loja.frete_gratis_acima_centavos`,
  a opção paga **mais barata** fica com preço 0 e `gratis: true`.
- Ordenação: retirada por último; as demais por preço.
- Erro do Melhor Envio não derruba a cotação: devolve as outras opções e `frete.erro`.

### 6.3 `POST /api/loja/checkout`
Entrada:
```json
{ "itens": [...], "cupom": "AMA10"?, "frete_id": "me-1",
  "cliente": { "nome", "email", "telefone", "cpf" },
  "endereco": { "cep", "logradouro", "numero", "complemento", "bairro", "cidade", "uf" },
  "observacoes": "…"? }
```
Valida (nome ≥ 2 palavras, e-mail, telefone 10–11 dígitos, CPF com dígitos verificadores, endereço completo exceto na
retirada), recota no servidor, acha a opção `frete_id` (senão 409 `frete_indisponivel`), chama `criar_pedido`,
cria a preferência no Mercado Pago, grava `mp_preference_id` e `mp_init_point`, devolve
`{ "ok": true, "pedido": { "id", "numero", "token" }, "redirecionar": "<init_point>" }`.
Sem Mercado Pago configurado → 503 `pagamento_indisponivel` **antes** de criar o pedido.
Item indisponível → 409 `item_indisponivel` com `itens` atualizados.

Preferência (`lib/mercadopago.js`): itens com `unit_price` em reais; se houver desconto, um único item
"Pedido #N — AMA" com o valor dos produtos já descontado; frete como item separado "Frete — <nome>" quando > 0;
`payer` (nome, sobrenome, e-mail, telefone, CPF); `external_reference = pedido.id`;
`notification_url = <SITE_URL>/api/webhooks/mercadopago`;
`back_urls` = `<SITE_URL>/loja/pedido?id=<id>&token=<token>` (as três); `auto_return: "approved"`;
`statement_descriptor: "AMA"`; `payment_methods.installments = parcelas_max`; se `aceitar_boleto` for false, exclui `ticket`;
`expires: true` com `expiration_date_to = agora + expiracao_horas`; cabeçalho `X-Idempotency-Key = pedido.id`.

### 6.4 `GET /api/loja/pedido?id=&token=[&payment_id=]`
Compara o token em tempo constante (senão 404). Se veio `payment_id` e o MP está configurado: busca o pagamento,
confere `external_reference === id` e chama `confirmar_pagamento` (sincroniza mesmo sem webhook).
Saída `{ "ok": true, "pedido": { numero, status, status_pagamento, criado_em, pago_em, enviado_em, itens:[{nome, imagem,
quantidade, preco_unitario_centavos, total_centavos}], subtotal_centavos, desconto_centavos, frete_centavos, total_centavos,
entrega:{tipo, nome, empresa, prazo_dias}, codigo_rastreio, url_rastreio, primeiro_nome, pode_pagar, link_pagamento } }`.
`pode_pagar` = status `aguardando_pagamento` e há `mp_init_point`. `Cache-Control: no-store`.

### 6.5 `POST /api/webhooks/mercadopago`
1. Lê `type`/`topic` e `data.id` (query string ou corpo). Tópicos diferentes de `payment` → 200 ignorado.
2. Se `MP_WEBHOOK_SECRET` existe, valida `x-signature` (`ts=…,v1=…`) com HMAC-SHA256 do manifesto
   `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` (partes ausentes omitidas; `data.id` alfanumérico em minúsculas),
   comparação em tempo constante. Inválida → 401.
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
- `POST /api/admin/envio` `{ pedido_id, acao }`, `acao` ∈ `adicionar_carrinho | comprar | gerar | imprimir | rastrear`.
  Usa `frete.origem`, endereço/CPF do pedido, `entrega.servico_id`, volumes somados dos itens. Salva `me_ordem_id`,
  `etiqueta_url`, `codigo_rastreio`; registra evento `envio`. Só para pedidos com `entrega.tipo = 'melhor_envio'` e status `pago`/`em_separacao`/`enviado`.
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

Funcionalidades: busca, filtro por categoria (na URL `?categoria=`), ordenação, selo de promoção e "esgotado",
página de produto com galeria e miniaturas, quantidade limitada ao estoque, "Adicionar ao carrinho" e "Comprar agora",
cálculo de frete por CEP na página do produto e do carrinho, cupom, checkout com autopreenchimento de endereço pelo
ViaCEP (`https://viacep.com.br/ws/<cep>/json/`), botão "Tirar dúvidas no WhatsApp", página do pedido com linha do
tempo, rastreio e "Pagar agora". "Meus pedidos neste aparelho": a página do pedido guarda `{id, token, numero, criado_em}`
em `localStorage` `ama_pedidos_v1` e `/loja/pedido` sem parâmetros lista esses pedidos.
Ao voltar do pagamento aprovado o carrinho é limpo.

## 8. Painel (`/admin/`)

`public/admin/index.html` carrega `/api/config`, `/vendor/supabase-2.116.0.js`, `admin/admin.css` e o módulo `admin/js/app.js`.

- `app.js`: cria o cliente (`window.supabase.createClient(url, anonKey)`), tela de login (e-mail e senha), "esqueci minha senha"
  (`resetPasswordForEmail` com `redirectTo = <origem>/admin/`), tratamento do evento `PASSWORD_RECOVERY` (tela de nova senha),
  verificação de admin (`rpc('eh_admin')`; não admin → mensagem e sair), layout (menu lateral, topo com e-mail, "Ver site", "Sair"),
  roteador por hash e aviso de alterações não salvas.
- Rotas: `#/` visão geral · `#/conteudo` e `#/conteudo/<grupo>` · `#/midia` · `#/produtos`, `#/produtos/novo`, `#/produtos/<id>` ·
  `#/categorias` · `#/pedidos`, `#/pedidos/<id>` · `#/cupons` · `#/configuracoes`.
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
- Páginas: `visao-geral.js`, `conteudo.js`, `midia.js`, `produtos.js`, `categorias.js`, `pedidos.js`, `cupons.js`, `configuracoes.js`.
- Estilos: `admin/admin.css` é o sistema de design do painel (botões, campos, cartões, tabelas, selos de status,
  modais, abas, listas, área de upload, grade responsiva). Estilos específicos de uma página ficam em
  `admin/css/<pagina>.css`, carregados pela própria página com `ui.carregarCss('<pagina>')`.
  As classes e componentes disponíveis ficam documentados em `docs/PAINEL.md`.

Editor de conteúdo: grupos vindos de `extrairEsquema` (template de `/api/render?modelo=1`); editores por tipo
(texto, textarea, editor rico com barra Negrito/Itálico/Link/Lista/Parágrafo + `sanitizarHtml`, imagem com prévia,
upload, biblioteca e texto alternativo, vídeo com upload e capa, link, URL, Instagram, listas com adicionar/remover/
duplicar/subir/descer), "Restaurar padrão" por campo (apaga a linha), "Salvar" (upsert só do que mudou),
"Pré-visualizar" (abre nova aba com o template + `<base href="/">` + rascunho aplicado) e "Ver no site".
Aviso: as mudanças aparecem no site em até ~15 segundos.

## 9. Testes

- `npm test` — unitários (`node --test`), sem rede: CMS (linkedom), sanitização, URLs, Instagram, validações,
  assinatura do webhook, regras de frete, montagem da preferência, handlers com `fetch` simulado.
- `npm run test:integracao` — exige o Supabase local (`supabase start`) e `supabase db reset`: RLS, RPCs,
  idempotência do pagamento e do estoque, APIs completas contra servidores falsos do MP e do Melhor Envio.
- `tests/e2e/` — Playwright: admin edita conteúdo e produto; cliente compra; webhook confirma; admin vê o pedido.
