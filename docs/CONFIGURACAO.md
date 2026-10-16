# Como colocar o site da AMA no ar

Este guia é para quem vai publicar o site: não precisa saber programar. Ele tem duas partes:

1. **Site no ar** (cerca de 1 hora, mais a espera do DNS): o site, a loja e o painel no domínio da AMA, hospedados
   no Cloudflare. Custo zero além do domínio.
2. **Produção** (quando a loja for vender de verdade): pagamento real, frete e e-mails.

Serviços usados, todos com plano gratuito:

| Serviço | Para quê | Plano |
|---|---|---|
| [Cloudflare](https://dash.cloudflare.com) | Hospeda o site, a loja e o painel (Workers), guarda fotos e vídeos (R2) e cuida do DNS do domínio | Free |
| [Supabase](https://supabase.com) | Banco de dados e login do painel | Free |
| [Registro.br](https://registro.br) | O domínio (`.com.br`), que já está comprado | Anuidade do domínio |
| [Mercado Pago](https://www.mercadopago.com.br/developers) | Pagamento (Pix, cartão, boleto) | Sem mensalidade; cobra taxa por venda |
| [Melhor Envio](https://melhorenvio.com.br) | Frete e etiquetas dos Correios e transportadoras | Sem mensalidade; paga-se a etiqueta |
| [Resend](https://resend.com) | E-mails de confirmação de pedido (opcional) | Free (3.000 por mês, 100 por dia) |

Limites gratuitos do Cloudflare que importam aqui: 100 mil acessos por dia às páginas que o servidor monta (home,
`/api` e fotos enviadas pelo painel; os arquivos do site, como CSS, JS e as imagens de `/img`, não contam) e
10 GB de fotos e vídeos no R2. É bem mais do que a AMA vai usar.

> As telas do Cloudflare, do Supabase e do Mercado Pago mudam de tempos em tempos. Se um botão estiver com outro
> nome, procure pela palavra principal (por exemplo, "Variables and Secrets" ou "SQL Editor").

Nos exemplos abaixo, troque `seudominio.com.br` pelo domínio da AMA (ex.: `oscdemulheres.com.br`).

---

## Parte 1 — Site no ar

### Passo 1. Preparar o banco de dados no Supabase

> **A AMA já tem um projeto no Supabase?** Use o mesmo: pule os itens 1 e 2, abra o projeto existente e siga do
> item 3. A migração é re-executável, não apaga produtos, pedidos nem textos já editados, e o usuário
> administrador e o bloqueio de cadastro (itens 5 a 7) só precisam ser feitos se ainda não existirem. As chaves do
> item 8 são as do projeto existente (**Project Settings**). Não precisa criar projeto novo nem mudar nada no
> Supabase por causa da mudança para o Cloudflare.

1. Só se **não** houver projeto: entre em [supabase.com](https://supabase.com) e clique em **Start your project**
   (conta do GitHub).
2. Só se **não** houver projeto: clique em **New project**:
   - **Name**: `ama`
   - **Database Password**: crie uma senha forte e guarde (não será usada no dia a dia).
   - **Region**: *South America (São Paulo)*.
   - Plano **Free**. Clique em **Create new project** e espere 1 ou 2 minutos.
3. No menu da esquerda, abra **SQL Editor** → **New query**.
4. No GitHub, abra o arquivo
   [`supabase/migrations/20261009120000_inicial.sql`](../supabase/migrations/20261009120000_inicial.sql),
   clique em **Raw**, selecione tudo (Ctrl+A), copie e cole no SQL Editor. Clique em **Run**.
   - Deve aparecer *Success. No rows returned*.
   - Isso cria as tabelas, as regras de segurança e o catálogo inicial: os 10 produtos Ama Bioessência e 6 biojoias,
     com **preços e estoque de teste** (body splash R$ 59,90, cremes R$ 69,90, sabonete líquido R$ 49,90, sabonete
     sólido R$ 24,90, biojoias R$ 89,90 e 10 unidades de cada) para os testes de funcionamento. Troque pelos
     valores reais no painel (**Produtos**) antes de vender.
   - Pode rodar de novo sem problema: o arquivo não duplica nada e aplica as mudanças das versões novas.
5. **Bloqueie o cadastro público** (importante para a segurança): **Authentication** → **Sign In / Providers**
   (ou **Settings**) → desligue **Allow new users to sign up**. Só quem você criar consegue entrar no painel.
6. **Crie o usuário do painel**: **Authentication** → **Users** → **Add user** → **Create new user**.
   Informe o e-mail e uma senha e marque **Auto Confirm User**.
7. **Libere esse usuário como administrador**: volte ao **SQL Editor** → **New query**, cole o comando abaixo
   trocando o e-mail, e clique em **Run**:

   ```sql
   insert into public.admins (user_id, email)
   select id, email from auth.users where email = 'email-da-administradora@exemplo.com';
   ```

   Deve aparecer *Success. 1 row affected* (se aparecer *0 rows*, o e-mail não confere com o do item 6).
8. **Copie as chaves** (vai precisar no passo 5). Em **Project Settings**:
   - **Data API** (ou **API**): copie a **Project URL** (`https://xxxx.supabase.co`).
   - **API Keys**: copie a **Publishable key** (`sb_publishable_…`) e a **Secret key** (`sb_secret_…`, clique para
     revelar). Em projetos antigos elas se chamam **anon** e **service_role**.
   - A *Secret key* dá acesso total ao banco: **nunca** a coloque no código, em mensagens ou no navegador.

### Passo 2. Criar a conta no Cloudflare e trazer o domínio

1. Crie a conta em [dash.cloudflare.com](https://dash.cloudflare.com/sign-up) (de preferência com um e-mail da AMA)
   e confirme o e-mail.
2. Na página inicial, clique em **Add a domain** (ou **Onboard a domain**), digite `seudominio.com.br` e continue.
   Escolha o plano **Free**. Na revisão dos registros DNS, apenas continue (o domínio é novo).
3. O Cloudflare mostra **dois nameservers**, parecidos com `ana.ns.cloudflare.com` e `bob.ns.cloudflare.com`.
   Deixe essa aba aberta.
4. Em outra aba, entre no [registro.br](https://registro.br) → clique no domínio → **DNS** →
   **Alterar servidores DNS**. Apague os servidores que estiverem lá, cole os dois do Cloudflare e salve.
   - Se o registro.br avisar sobre **DNSSEC**, desative o DNSSEC antes de trocar (dá para ligar de novo depois,
     pelo Cloudflare).
5. Volte ao Cloudflare e clique em **Check nameservers** (ou **Done, check nameservers**). A troca costuma levar de
   alguns minutos a algumas horas (no máximo 48 h). O Cloudflare manda um e-mail quando o domínio ficar **Active**.
   Os passos 3 a 5 podem ser feitos enquanto isso.

### Passo 3. Criar o "bucket" das fotos e vídeos (R2)

1. No menu da esquerda do Cloudflare: **Storage & Databases** → **R2 Object Storage** (ou só **R2**).
2. Na primeira vez, clique para ativar o R2 (**Purchase R2 Plan**/**Get started**). O Cloudflare pode pedir um cartão
   para ativar, mas **não cobra** dentro do limite gratuito (10 GB guardados, 1 milhão de envios e 10 milhões de
   leituras por mês).
3. Clique em **Create bucket**:
   - **Bucket name**: `ama-midia` (exatamente assim: é o nome que o site procura).
   - **Location**: *Automatic*. Deixe o resto como está e clique em **Create bucket**.
   - Não precisa deixar o bucket público: o próprio site entrega as fotos, no endereço `/midia/…`.

### Passo 4. Publicar o site (Workers)

1. No menu da esquerda: **Compute (Workers)** → **Workers & Pages** → **Create** (ou **Create application**).
2. Escolha **Import a repository** (na aba *Workers*), clique em **Connect GitHub** e libere o repositório
   **`joaoviantexe/demonstracao-ama`**.
3. Na tela de configuração:
   - **Project name**: `ama-site` (tem que ser igual ao nome do arquivo `wrangler.jsonc`).
   - **Build command**: deixe vazio.
   - **Deploy command**: `npx wrangler deploy` (já vem preenchido).
   - **Root directory**: `/`. **Production branch**: `main`.
4. Clique em **Create and deploy** (ou **Deploy**). Em 1 ou 2 minutos aparece um endereço provisório, algo como
   `https://ama-site.sua-conta.workers.dev`. O site já abre, mas ainda sem banco (vem com o texto padrão).
   - O arquivo `wrangler.jsonc` do projeto já liga o bucket `ama-midia` (como `MIDIA`) e a consulta diária que
     evita a pausa do Supabase. Não precisa configurar isso no painel.
   - A cada envio para a branch `main` no GitHub, o Cloudflare publica de novo sozinho. Pull requests ganham um
     endereço de prévia (aparece em **Deployments**/**Versions**).

### Passo 5. Cadastrar as variáveis (chaves)

No Worker `ama-site`: **Settings** → **Variables and Secrets** → **Add**. Cadastre cada uma como **Secret**
(guardada criptografada) e, no fim, clique em **Deploy** para valer:

| Nome | Valor |
|---|---|
| `SUPABASE_URL` | a Project URL do Supabase |
| `SUPABASE_ANON_KEY` | a Publishable key (`sb_publishable_…`) |
| `SUPABASE_SERVICE_ROLE_KEY` | a Secret key (`sb_secret_…`) |
| `SITE_URL` | `https://seudominio.com.br` (enquanto o domínio não estiver ativo, use o endereço `….workers.dev`) |
| `CRON_SECRET` | uma sequência longa e aleatória (ex.: gere em [1password.com/password-generator](https://1password.com/password-generator)) |

### Passo 6. Ligar o domínio ao site

Quando o domínio estiver **Active** no Cloudflare (passo 2):

1. No Worker `ama-site`: **Settings** → **Domains & Routes** → **Add** → **Custom domain** →
   `seudominio.com.br` → **Add domain**. Repita para `www.seudominio.com.br`.
2. Em 1 ou 2 minutos, `https://seudominio.com.br` abre o site, já com o cadeado (HTTPS).
3. Se o `SITE_URL` do passo 5 estava com o endereço `….workers.dev`, troque para `https://seudominio.com.br` e
   clique em **Deploy**.

### Passo 7. Avisar o Supabase sobre o endereço do site

Necessário para os links de e-mail do Supabase (convite de novo usuário e redefinição de senha feita pelo Supabase) abrirem o painel.

1. No Supabase: **Authentication** → **URL Configuration**.
2. **Site URL**: `https://seudominio.com.br`.
3. **Redirect URLs** → **Add URL**: `https://seudominio.com.br/admin/`.

> O painel não tem "Esqueci minha senha". Para trocar uma senha, use o Supabase: **Authentication** → **Users** →
> os três pontinhos do usuário → **Send password recovery** (ou crie outra senha ao recriar o usuário).

### Passo 8. Conferir

| Endereço | O que deve aparecer |
|---|---|
| `/` | A página inicial da AMA, com o banner da loja "Produtos AMA" e o item **Cosméticos** no menu |
| `/loja/` | Os 16 produtos com os preços de teste |
| `/loja/produto?slug=body-splash-raiz` | A página do produto |
| `/admin/` | O login do painel. Entre com o usuário do passo 1.6 |

**Como a página inicial é atualizada:** ao salvar qualquer parte em **Site** no painel, o próprio painel monta a
página e a publica; a mudança aparece no site na hora. Ao entrar no painel ele também confere se a página publicada
está em dia (por exemplo, depois de uma versão nova do site) e publica de novo se precisar. Então, logo depois do
primeiro deploy, **entre uma vez no painel**.

Para ver o painel de pedidos cheio, rode no **SQL Editor** o arquivo
[`supabase/exemplos/pedidos-exemplo.sql`](../supabase/exemplos/pedidos-exemplo.sql): ele cria 8 pedidos de exemplo
(aguardando pagamento, em análise, pagos, em separação, enviado, entregue e cancelado), sem precisar de nenhuma
integração. Para apagá-los e devolver o estoque, rode
[`supabase/exemplos/remover-pedidos-exemplo.sql`](../supabase/exemplos/remover-pedidos-exemplo.sql).

Os produtos já vêm com preço e estoque de teste, então dá para comprar até o fim. Mas **não existe retirada na
sede**: para a loja oferecer uma entrega, configure o Melhor Envio (Parte 2, item 2) **ou** ligue o frete fixo no
painel, em **Loja → Configurações → Frete → Oferecer frete fixo** (ex.: R$ 15,00 para o PA). Sem nenhum dos dois, o
carrinho não mostra frete e ninguém finaliza a compra; o painel avisa isso na **Visão geral**.
Sem o Mercado Pago configurado, o checkout mostra "Pagamento online em configuração" e não deixa finalizar a
compra. Para testar o pagamento, faça o passo 9.

Se algo não funcionar, veja os erros em **Workers & Pages** → `ama-site` → **Logs** (ou **Observability**).

### Passo 9 (opcional). Pagamento em modo teste no Mercado Pago

1. Entre em [mercadopago.com.br/developers](https://www.mercadopago.com.br/developers) com a conta que vai receber
   as vendas → **Suas integrações** → **Criar aplicação** → produto **Checkout Pro** (pagamentos on-line).
2. Na aplicação, abra **Credenciais de teste** e copie o **Access Token**.
3. No Cloudflare, cadastre os segredos `MP_ACCESS_TOKEN` (o token de teste) e `MP_MODO` = `teste` (passo 5) e
   clique em **Deploy**.
4. Ainda na aplicação do Mercado Pago, **Webhooks** → **Configurar notificações**:
   - URL de produção: `https://seudominio.com.br/api/webhooks/mercadopago`
   - Evento: **Pagamentos**. Salve e copie a **Assinatura secreta** → cadastre no Cloudflare como
     `MP_WEBHOOK_SECRET` e clique em **Deploy**.
5. Para pagar em teste, use as contas de teste do Mercado Pago (comprador de teste) e o cartão de teste com o nome
   do titular **APRO** (aprova o pagamento). Pix e boleto em teste ficam "pendentes".

---

## Parte 2 — Produção (loja vendendo de verdade)

Faça quando a AMA aprovar o site e definir preços.

1. **Mercado Pago em produção.** Na aplicação: ative as **Credenciais de produção** (pede ramo de atividade, site e
   aceite dos termos), troque `MP_ACCESS_TOKEN` pelo token de produção, apague `MP_MODO` (ou ponha `producao`),
   confira a URL de Webhooks com o domínio definitivo e atualize `MP_WEBHOOK_SECRET`. Cadastre uma **chave Pix**
   na conta recebedora (sem ela o Pix não aparece). Confira as taxas em *Seu negócio → Custos*.
   Se o Mercado Pago não conseguir criar o link de pagamento, o pedido é cancelado sozinho, com uma nota na linha
   do tempo, e o cliente pode tentar de novo.
2. **Entrega: Melhor Envio e/ou frete fixo.** Não há retirada na sede, então pelo menos um dos dois precisa estar
   ligado para a loja vender.
   - **Melhor Envio (Correios e transportadoras, com etiqueta pelo painel).** Em
     [melhorenvio.com.br](https://melhorenvio.com.br): crie a conta, faça a verificação, gere um **token** em
     *Configurações → Permissões de acesso → Tokens* e cadastre no Cloudflare `MELHOR_ENVIO_TOKEN` e
     `MELHOR_ENVIO_EMAIL` (e-mail técnico). Em produção não cadastre `MELHOR_ENVIO_AMBIENTE` (`sandbox` só para o
     ambiente de testes do Melhor Envio, que usa outro token). No painel, em **Loja → Configurações → Frete**, deixe
     ligado **Calcular o frete pelo Melhor Envio** e preencha **De onde os pacotes saem** (nome, CPF/CNPJ, telefone
     e endereço com CEP) e a **Embalagem padrão** (peso e medidas usados no cálculo). As etiquetas são pagas com o
     saldo da carteira do Melhor Envio: coloque saldo antes da primeira venda. O envio é feito na página do pedido
     (**Pedidos → pedido → Envio**): carrinho → pagar → gerar → imprimir → postar nos Correios → rastreio →
     "Marcar como enviado" (a cliente vê o código na página do pedido).
   - **Frete fixo (entrega por conta da AMA).** Em **Loja → Configurações → Frete → Oferecer frete fixo**: nome,
     valor, prazo e estados atendidos (ex.: só `PA`). Pode ficar ligado junto com o Melhor Envio.
   - **Nota fiscal:** o painel não pede a chave da NF-e; as etiquetas saem com **declaração de conteúdo**. Converse
     com o contador sobre CNAE de comércio e nota (a AMA hoje só tem CNAE associativo). Se precisar emitir NF-e, o
     campo da chave volta ao primeiro passo do envio (a API `/api/admin/envio` já aceita `chave_nfe`).
3. **E-mails de pedido (opcional).** Crie a conta no [Resend](https://resend.com) → **Domains** → **Add domain** →
   `seudominio.com.br`. O Resend mostra os registros DNS; como o DNS está no Cloudflare, use o botão de configurar
   automaticamente com o Cloudflare (ou cadastre os registros em **DNS → Records** no Cloudflare). Quando o domínio
   ficar *Verified*, gere uma **API key** e cadastre no Cloudflare `RESEND_API_KEY` e `EMAIL_REMETENTE`
   (ex.: `AMA <loja@seudominio.com.br>`). No painel, em **Loja → Configurações → Avisos por e-mail**, informe o
   e-mail da equipe que recebe o aviso de novo pedido.
4. **Receber e-mails no domínio (opcional, grátis).** Para respostas de clientes chegarem num Gmail: no Cloudflare,
   domínio → **Email** → **Email Routing** → **Get started** → crie, por exemplo, `contato@seudominio.com.br`
   apontando para o Gmail da AMA e confirme o e-mail de verificação. Isso só recebe; quem envia é o Resend.
5. **E-mails do Supabase (opcional).** Só são usados em convites e na recuperação de senha feita pelo Supabase. O
   servidor padrão envia no máximo 2 por hora; se precisar de mais, configure um SMTP próprio (**Authentication** →
   **Emails** → **SMTP Settings**; o Resend oferece SMTP).
6. **Limites do plano grátis do Supabase:** 500 MB de banco e o projeto é pausado depois de 7 dias sem uso. O site
   faz uma consulta diária automática (agendada no `wrangler.jsonc`, todo dia às 06:17 de Brasília) para evitar a
   pausa; mesmo assim, se receber o e-mail de aviso do Supabase, abra o projeto e clique em restaurar. Fotos e
   vídeos ficam no R2 do Cloudflare (10 GB grátis); o painel reduz as fotos antes de enviar.
7. **Banco atualizado.** Sempre que o arquivo da migração mudar (o pull request avisa), rode-o de novo no **SQL
   Editor** (Passo 1, item 4). Ele não apaga produtos, pedidos nem textos já editados.

### Antes de abrir as vendas (lista de conferência)

No painel (`/admin/`):

- [ ] **Variáveis no Cloudflare** (o painel não mostra a situação delas, confira lá): Supabase, `SITE_URL` com o
      domínio, Mercado Pago em **produção** com `MP_WEBHOOK_SECRET`, e o Melhor Envio (ou o frete fixo ligado).
- [ ] **Produtos**: troque os **preços e estoques de teste** (R$ 59,90, R$ 69,90… e 10 unidades) pelos reais; dê
      nome, descrição e fotos às 6 biojoias ("Nome em Produção"). Produto sem preço não pode ser comprado (a lista
      avisa).
- [ ] **Loja → Configurações → Loja**: nome e descrição da loja.
- [ ] **Site → WhatsApp**: o número com DDD (vale para o site inteiro e para a loja).
- [ ] **Loja → Configurações → Frete**: remetente completo e embalagem padrão; Melhor Envio ligado e/ou frete fixo.
- [ ] **Loja → Configurações → Pagamento**: parcelas no cartão.
- [ ] **Loja → Configurações → Avisos por e-mail**: e-mail da equipe (se usar o Resend).
- [ ] **Compra de verdade**: faça um pedido pequeno com Pix pelo domínio definitivo e confira: o pedido vira
      "Pago" sozinho (sem o webhook ele fica esperando), o estoque baixa, o e-mail chega (se configurado) e o envio
      funciona até a etiqueta. Depois devolva o dinheiro pelo Mercado Pago e marque o pedido como
      **Reembolsado** em **Mudar situação** (com "Devolver os produtos ao estoque").
- [ ] Apague os pedidos de teste no fim da página do pedido (**Apagar pedido**; aparece para pedidos aguardando
      pagamento, cancelados ou reembolsados cujos produtos já voltaram ao estoque).

## Referência: variáveis de ambiente

Todas estão explicadas em [`.env.example`](../.env.example). No Cloudflare ficam em **Workers & Pages** →
`ama-site` → **Settings** → **Variables and Secrets** (cadastre como **Secret** e clique em **Deploy**). Resumo:

| Variável | Obrigatória? | Para quê |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Sim | Banco e login |
| `SITE_URL` | Sim | Endereço público (links de pagamento, e-mails, imagem do link no WhatsApp) |
| `CRON_SECRET` | Recomendada | Protege a consulta diária que evita a pausa do Supabase |
| `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `MP_MODO` | Para vender | Mercado Pago |
| `MELHOR_ENVIO_TOKEN`, `MELHOR_ENVIO_EMAIL`, `MELHOR_ENVIO_AMBIENTE` | Para vender (ou o frete fixo ligado no painel) | Frete calculado e etiquetas |
| `RESEND_API_KEY`, `EMAIL_REMETENTE` | Opcional | E-mails de pedido |

O bucket das fotos (`MIDIA` → `ama-midia`) e a consulta diária já estão no `wrangler.jsonc`; não são variáveis.

## Para quem desenvolve

```bash
npm install
scripts/supabase-local.sh start          # Supabase local (precisa do Docker)
scripts/supabase-local.sh db reset       # aplica a migração e os dados de exemplo
npm run dev                              # http://127.0.0.1:3000 (admin@ama.local / admin123456)
npm test                                 # testes unitários
npm run test:integracao                  # testes contra o Supabase local
npm run test:e2e                         # compra de ponta a ponta no navegador (Playwright)
npx wrangler dev                         # o Worker de verdade, no simulador do Cloudflare (variáveis em .dev.vars)
```

No `npm run dev`, fotos, vídeos e a página inicial publicada ficam na pasta `.midia-local` (no Cloudflare, no R2).
O contrato técnico (tabelas, rotas, formatos) está em [`docs/ARQUITETURA.md`](ARQUITETURA.md).
