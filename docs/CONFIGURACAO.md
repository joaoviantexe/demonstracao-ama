# Como colocar o site da AMA no ar

Este guia é para quem vai publicar o site: não precisa saber programar. Ele tem duas partes:

1. **Demonstração gratuita** (cerca de 30 minutos): o site, a loja e o painel no ar, num endereço
   `https://….vercel.app`, para mostrar à AMA. Custo zero.
2. **Produção** (quando a loja for vender de verdade): domínio próprio, pagamento real, frete e e-mails.

Serviços usados, todos com plano gratuito:

| Serviço | Para quê | Plano |
|---|---|---|
| [Vercel](https://vercel.com) | Hospeda o site, a loja e o painel | Hobby (grátis) |
| [Supabase](https://supabase.com) | Banco de dados, login do painel e fotos/vídeos | Free |
| [Mercado Pago](https://www.mercadopago.com.br/developers) | Pagamento (Pix, cartão, boleto) | Sem mensalidade; cobra taxa por venda |
| [Melhor Envio](https://melhorenvio.com.br) | Frete e etiquetas dos Correios e transportadoras | Sem mensalidade; paga-se a etiqueta |
| [Resend](https://resend.com) | E-mails de confirmação de pedido (opcional) | Free |

> As telas da Vercel, do Supabase e do Mercado Pago mudam de tempos em tempos. Se um botão estiver com outro
> nome, procure pela palavra principal (por exemplo, "Environment Variables" ou "SQL Editor").

---

## Parte 1 — Demonstração gratuita

### Passo 1. Criar o banco de dados no Supabase

1. Entre em [supabase.com](https://supabase.com) e clique em **Start your project**. Entre com a conta do GitHub.
2. Clique em **New project**:
   - **Name**: `ama`
   - **Database Password**: crie uma senha forte e guarde (não será usada no dia a dia).
   - **Region**: *South America (São Paulo)*.
   - Plano **Free**. Clique em **Create new project** e espere 1 ou 2 minutos.
3. No menu da esquerda, abra **SQL Editor** → **New query**.
4. No GitHub, abra o arquivo
   [`supabase/migrations/20261009120000_inicial.sql`](../supabase/migrations/20261009120000_inicial.sql),
   clique em **Raw**, selecione tudo (Ctrl+A), copie e cole no SQL Editor. Clique em **Run**.
   - Deve aparecer *Success. No rows returned*.
   - Isso cria as tabelas, as regras de segurança, a pasta de fotos (`midia`) e o catálogo inicial: os 10 produtos
     Ama Bioessência e 6 biojoias, com **preços e estoque de teste** (body splash R$ 59,90, cremes R$ 69,90,
     sabonete líquido R$ 49,90, sabonete sólido R$ 24,90, biojoias R$ 89,90 e 10 unidades de cada) para os testes de
     funcionamento. Troque pelos valores reais no painel (**Produtos**) antes de vender.
   - Pode rodar de novo sem problema: o arquivo não duplica nada. Se você já tinha rodado uma versão anterior, rodar
     de novo também aplica as mudanças: remove o sistema de cupons e a retirada na sede e atualiza os textos padrão
     antigos (nome "Loja AMA").
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

   Deve aparecer *Success. 1 row affected* (se aparecer *0 rows*, o e-mail não confere com o do passo 6).
8. **Copie as chaves** (vai precisar no passo 2). Em **Project Settings**:
   - **Data API** (ou **API**): copie a **Project URL** (`https://xxxx.supabase.co`).
   - **API Keys**: copie a **Publishable key** (`sb_publishable_…`) e a **Secret key** (`sb_secret_…`, clique para
     revelar). Em projetos antigos elas se chamam **anon** e **service_role**.
   - A *Secret key* dá acesso total ao banco: **nunca** a coloque no código, em mensagens ou no navegador.

### Passo 2. Publicar na Vercel

> **Já tem um projeto na Vercel ligado a este repositório?** (Por exemplo, `demonstracao-site-ama`.) Não apague:
> reaproveite. Ele já gera uma prévia de cada pull request. Faça só isto:
>
> 1. No projeto, **Settings** → **Build and Deployment**: **Framework Preset** = **Other** e deixe **desligados**
>    os campos de *Build Command*, *Output Directory* e *Install Command* (o `vercel.json` cuida disso).
> 2. **Settings** → **Environment Variables**: cadastre as variáveis da tabela do item 4 abaixo, marcando
>    **Production** e **Preview**.
> 3. Escolha como mostrar a versão nova (veja "Qual versão vai ao ar?" abaixo) e faça **Redeploy**: variável nova
>    só vale depois de publicar de novo.
> 4. Se houver um segundo projeto ligado ao mesmo repositório que você não usa (cada envio ao GitHub gera duas
>    publicações), apague-o em **Settings** → **General** → **Delete Project**. Isso não afeta o outro projeto.
>
> Depois siga para o Passo 3.


1. Entre em [vercel.com](https://vercel.com) → **Sign Up** → **Continue with GitHub** e escolha o plano **Hobby**.
2. Clique em **Add New…** → **Project** e importe o repositório **`joaoviantexe/demonstracao-ama`**
   (se ele não aparecer, clique em *Adjust GitHub App Permissions* e libere o repositório).
3. Na tela de configuração:
   - **Framework Preset**: **Other**.
   - **Root Directory**: deixe `./`.
   - **Build and Output Settings**: não mexa (o arquivo `vercel.json` do projeto já diz tudo).
4. Abra **Environment Variables** e cadastre:

   | Nome | Valor |
   |---|---|
   | `SUPABASE_URL` | a Project URL do Supabase |
   | `SUPABASE_ANON_KEY` | a Publishable key (`sb_publishable_…`) |
   | `SUPABASE_SERVICE_ROLE_KEY` | a Secret key (`sb_secret_…`) |
   | `CRON_SECRET` | uma sequência longa e aleatória (ex.: gere em [1password.com/password-generator](https://1password.com/password-generator)) |

5. Clique em **Deploy**. Em 1 ou 2 minutos aparece o endereço, algo como `https://demonstracao-ama.vercel.app`.

**Qual versão vai ao ar?** A Vercel publica como "produção" a branch `main`. Enquanto o pull request não for
aprovado (merge), a `main` ainda tem o site antigo. Para a demonstração há dois caminhos — escolha um:

- **A) Endereço de prévia do pull request (mais simples).** Com o projeto ligado à Vercel, cada pull request ganha
  um link de prévia: aparece um comentário da Vercel no próprio pull request com **Visit Preview**. Para a AMA abrir
  esse link sem ter conta na Vercel, desligue a proteção: **Settings** → **Deployment Protection** →
  **Vercel Authentication** → **Disabled** → **Save**.
- **B) Publicar a branch como produção.** **Settings** → **Environments** → **Production** (ou **Settings** → **Git**)
  → em *Branch Tracking*/*Production Branch* troque `main` por `claude/brave-curie-t7yeku` → **Save**. Depois
  **Deployments** → no último → **⋯** → **Redeploy**. Quando o pull request for aprovado, volte para `main`.

### Passo 3. Avisar o Supabase sobre o endereço do site

Necessário para o "Esqueci minha senha" do painel funcionar.

1. No Supabase: **Authentication** → **URL Configuration**.
2. **Site URL**: o endereço da Vercel (ex.: `https://demonstracao-ama.vercel.app`).
3. **Redirect URLs** → **Add URL**: o mesmo endereço com `/admin/` no fim
   (ex.: `https://demonstracao-ama.vercel.app/admin/`). Se for usar o link de prévia (caminho A), adicione também
   `https://*-joaoviantexes-projects.vercel.app/admin/` trocando pelo final real do seu link de prévia.

> O e-mail de recuperação de senha usa o servidor de e-mail do próprio Supabase, que só envia para membros da
> equipe do projeto e no máximo 2 por hora. Para a demonstração isso basta; para produção, veja a Parte 2.

### Passo 4. Conferir

| Endereço | O que deve aparecer |
|---|---|
| `/` | A página inicial da AMA, com o banner novo "Ama Bioessência" e o item **Loja** no menu |
| `/loja/` | Os 16 produtos com os preços de teste |
| `/loja/produto?slug=body-splash-raiz` | A página do produto |
| `/admin/` | O login do painel. Entre com o usuário do passo 1.6 |

Os produtos já vêm com preço e estoque de teste, então dá para comprar até o fim (com o frete configurado: Melhor
Envio ou o frete fixo ligado no painel, em **Configurações → Frete**). Sem o Mercado Pago configurado, o checkout mostra "Pagamento online em configuração" e não deixa finalizar a
compra. Para testar o pagamento, faça o passo 5.

### Passo 5 (opcional). Pagamento em modo teste no Mercado Pago

1. Entre em [mercadopago.com.br/developers](https://www.mercadopago.com.br/developers) com a conta da AMA →
   **Suas integrações** → **Criar aplicação** → produto **Checkout Pro** (pagamentos on-line).
2. Na aplicação, abra **Credenciais de teste** e copie o **Access Token**.
3. Na Vercel, **Settings** → **Environment Variables**, cadastre `MP_ACCESS_TOKEN` (o token de teste) e
   `MP_MODO` = `teste`. Depois **Deployments** → **Redeploy** (variável nova só vale depois de publicar de novo).
4. Ainda na aplicação do Mercado Pago, **Webhooks** → **Configurar notificações**:
   - URL de produção: `https://SEU-ENDERECO.vercel.app/api/webhooks/mercadopago`
   - Evento: **Pagamentos**. Salve e copie a **Assinatura secreta** → cadastre na Vercel como `MP_WEBHOOK_SECRET`
     e publique de novo.
5. Para pagar em teste, use as contas de teste do Mercado Pago (comprador de teste) e o cartão de teste com o nome
   do titular **APRO** (aprova o pagamento). Pix e boleto em teste ficam "pendentes".

---

## Parte 2 — Produção (loja vendendo de verdade)

Faça quando a AMA aprovar o site e definir preços.

1. **Plano da Vercel.** Pelos termos da Vercel, o plano Hobby é para uso pessoal e não comercial. Para a loja
   vendendo, avalie o plano **Pro** (confira os termos e o preço atuais em vercel.com/pricing).
2. **Domínio próprio** (ex.: `ama.org.br`): Vercel → **Settings** → **Domains** → **Add** e siga as instruções de
   DNS. Depois cadastre `SITE_URL` = `https://www.seudominio.com.br`, atualize a **Site URL** e as **Redirect URLs**
   no Supabase (Passo 3) e publique de novo.
3. **Mercado Pago em produção.** Na aplicação: ative as **Credenciais de produção** (pede ramo de atividade, site e
   aceite dos termos), troque `MP_ACCESS_TOKEN` pelo token de produção, apague `MP_MODO` (ou ponha `producao`),
   cadastre a URL de Webhooks com o domínio definitivo e atualize `MP_WEBHOOK_SECRET`. Cadastre uma **chave Pix**
   na conta recebedora (sem ela o Pix não aparece). Confira as taxas em *Seu negócio → Custos*.
   Se o Mercado Pago não conseguir criar o link de pagamento, o pedido é cancelado sozinho, com uma nota na linha
   do tempo, e o cliente pode tentar de novo.
4. **Melhor Envio (frete e etiquetas).** Em [melhorenvio.com.br](https://melhorenvio.com.br): crie a conta da AMA,
   faça a verificação, gere um **token** em *Configurações → Permissões de acesso → Tokens* e cadastre na Vercel
   `MELHOR_ENVIO_TOKEN`, `MELHOR_ENVIO_EMAIL` (e-mail técnico) e, se usar o ambiente de testes,
   `MELHOR_ENVIO_AMBIENTE=sandbox`. No painel da loja, preencha o **endereço de origem** (CEP, endereço, CPF/CNPJ,
   telefone) em Configurações → Frete. As etiquetas são pagas com o saldo da carteira do Melhor Envio.
   **Converse com o contador** sobre nota fiscal (NF-e) ou declaração de conteúdo: a AMA tem CNPJ e vende.
5. **E-mails de pedido (opcional).** Crie a conta no [Resend](https://resend.com), verifique o domínio, gere uma
   API key e cadastre `RESEND_API_KEY` e `EMAIL_REMETENTE` (ex.: `AMA <loja@seudominio.com.br>`). No painel, em
   Configurações, informe o e-mail que recebe o aviso de novo pedido.
6. **E-mail de recuperação de senha.** Configure um SMTP próprio no Supabase (**Authentication** → **Emails** →
   **SMTP Settings**; o Resend oferece SMTP). Sem isso, o Supabase envia no máximo 2 e-mails por hora.
7. **Limites do plano grátis do Supabase:** 500 MB de banco, 1 GB de arquivos (50 MB por arquivo) e o projeto é
   pausado depois de 7 dias sem uso. O site faz uma consulta diária automática (`/api/cron/manter-ativo`) para
   evitar a pausa; mesmo assim, se receber o e-mail de aviso do Supabase, abra o projeto e clique em restaurar.
   Prefira vídeos no YouTube/Instagram e fotos comprimidas (o painel já reduz as fotos antes de enviar).

## Referência: variáveis de ambiente

Todas estão explicadas em [`.env.example`](../.env.example). Resumo:

| Variável | Obrigatória? | Para quê |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Sim | Banco, login e arquivos |
| `CRON_SECRET` | Recomendada | Protege a consulta diária que evita a pausa do Supabase |
| `SITE_URL` | Em produção | Endereço público (links de pagamento, e-mails) |
| `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `MP_MODO` | Para vender | Mercado Pago |
| `MELHOR_ENVIO_TOKEN`, `MELHOR_ENVIO_EMAIL`, `MELHOR_ENVIO_AMBIENTE` | Opcional | Frete calculado e etiquetas |
| `RESEND_API_KEY`, `EMAIL_REMETENTE` | Opcional | E-mails de pedido |

Depois de criar ou mudar uma variável na Vercel, publique de novo (**Deployments** → **Redeploy**).

## Para quem desenvolve

```bash
npm install
scripts/supabase-local.sh start          # Supabase local (precisa do Docker)
scripts/supabase-local.sh db reset       # aplica a migração e os dados de exemplo
npm run dev                              # http://127.0.0.1:3000 (admin@ama.local / admin123456)
npm test                                 # testes unitários
npm run test:integracao                  # testes contra o Supabase local
npm run test:e2e                         # compra de ponta a ponta no navegador (Playwright)
```

O contrato técnico (tabelas, rotas, formatos) está em [`docs/ARQUITETURA.md`](ARQUITETURA.md).
