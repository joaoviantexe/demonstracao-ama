# Continuação do projeto (para a próxima sessão do Claude Code)

Responda e comente sempre em **português do Brasil**. Não faça merge nem marque o PR como pronto sem o dono pedir.

## Onde está o trabalho

- Repositório `joaoviantexe/demonstracao-ama`, branch **`claude/brave-curie-t7yeku`**.
- PR em rascunho: https://github.com/joaoviantexe/demonstracao-ama/pull/3. Atualize a descrição do PR ao final de cada etapa.
- Publicado na Vercel, no projeto `demonstracao-site-ama` (https://demonstracao-site-ama.vercel.app). Existe um projeto
  duplicado, `demonstracao-ama`, ligado ao mesmo repositório. O dono criou o projeto no Supabase e aplicou a migração.
  **Sempre que a migração mudar, avise o dono para rodar o arquivo inteiro de novo no SQL Editor.** Ela é re-executável,
  e as atualizações de valores padrão antigos ficam no fim da seção 10.

## Leia primeiro

1. `docs/ARQUITETURA.md`: contrato técnico (tabelas, RPCs, RLS, rotas, CMS, loja, painel).
2. `docs/PAINEL.md`: núcleo do painel (contrato das páginas, `ctx`, `ui.js`, `api.js`, `midia.js` e todas as classes
   do `admin.css`).
3. `docs/CONFIGURACAO.md`: guia de publicação (Vercel e Supabase) para o dono.
4. `docs/pesquisa-apis.json`: fatos e armadilhas do Mercado Pago, do Melhor Envio e da Vercel/Supabase.

## O que já está pronto e testado

- **Banco:** migração com RLS, GRANTs, RPCs e bucket `midia`.
  - `confirmar_pagamento` é idempotente e seguro em paralelo.
  - Catálogo inicial: 10 produtos Ama Bioessência com descrições reais e 6 biojoias "Nome em Produção".
- **Motor do CMS:** `public/js/cms/aplicar.js`.
- **Página inicial editável:** `templates/home.html` com `data-cms`, renderizada em `api/render.js`.
  - Visual idêntico ao da `main`, conferido por `scripts/comparar-home.mjs`.
- **Servidor:**
  - Bibliotecas em `lib/`.
  - APIs da loja: cotação, checkout, pedido e webhook do Mercado Pago.
  - Rotas de admin: status, pedido-status, envio no Melhor Envio e conferência de pagamento.
  - Servidores falsos do Mercado Pago e do Melhor Envio em `tests/apoio/`.
- **Vitrine:** `public/loja/*`, `public/js/loja/*` e `public/css/loja.css`.
  - O script `scripts/capturas-loja.mjs` percorre a compra inteira.
- **Painel:**
  - Núcleo (`public/admin/`), com as correções do §13 do `PAINEL.md`.
  - Páginas prontas, ainda **sem revisão independente**: visão geral, conteúdo do site, mídia, produtos e categorias.
- **Testes:**
  - `npm test`: 740 testes unitários.
  - `npm run test:integracao`: 148 testes contra o Supabase local.

## Decisões do cliente que já valem (não desfazer)

- O item do menu "Produtos" virou **"Cosméticos"** (`/loja/`). Os títulos das páginas da loja são "Cosméticos — …".
- **Não existe pedido pelo WhatsApp** em lugar nenhum, nem para combinar retirada. O WhatsApp aparece só como contato
  institucional (botão flutuante, rodapé, menu do celular) e como "Falar com a AMA" na página do pedido.
- **Sem "Em breve":** produto com preço 0 aparece como um produto normal ("R$ 00,00", sem selo); só o servidor recusa a
  compra (`sem_preco`).
- **Rodapé igual em todo o site:** as páginas da loja usam o rodapé da página inicial, e `comum.js` aplica nele o
  conteúdo `rodape.*` do CMS.
- **Banner da página inicial (`#loja`):**
  - sem a chamada "Nova loja virtual da AMA";
  - subtítulo "Saboaria, perfumaria e biojoias da Amazônia";
  - texto citando biojoias;
  - a primeira foto é `/img/brinco-gota-verde.jpg`.
- **Página da loja:** sem banner no topo; abre direto em "Nossos produtos".
- **Página do produto:** sem a linha "Entrega ou retirada na sede da AMA".

## Pedidos novos do cliente (fazer PRIMEIRO, nesta ordem)

1. **Banner:** trocar o título "Cosméticos" por **"Produtos AMA"** (`templates/home.html`, seção `#loja`, `h2`) e
   ajustar `tests/unit/home.test.js`.
2. **Remover o sistema de cupom por completo:**
   - campo de cupom no carrinho e no checkout;
   - parâmetro `cupom` em `/api/loja/cotacao` e `/api/loja/checkout`, e o tratamento em `lib/loja.js`;
   - lógica de cupom em `cotar_carrinho`, `criar_pedido`, `_baixar_estoque` e `_repor_estoque`, e `frete_gratis_cupom` em
     `lib/frete.js`;
   - tabela `cupons`, cupons do seed (`AMA10`, `FRETEGRATIS`) e a página/menu "Cupons" do painel;
   - contrato e testes.
   Na migração, use `drop … if exists` para projetos que já têm a tabela, mantendo o arquivo re-executável.
3. **Tirar todos os textos que citam o Mercado Pago** do que a cliente vê (site, loja e e-mails). Exemplos:
   - "Pagamento seguro pelo Mercado Pago: Pix, cartão ou boleto." → "Pix, cartão ou boleto."
   - "Compra segura pelo Mercado Pago" e "Pague com Pix, cartão ou boleto pelo Mercado Pago" → sem citar o Mercado Pago.
   - Avisos do checkout como "Você será levado ao ambiente seguro do Mercado Pago…".
   No painel, o nome da integração pode continuar (confirme com o dono se tiver dúvida).
4. **Remover por completo a opção de retirar na sede da AMA:**
   - opção `retirada` do frete (`lib/frete.js`), configuração `frete.retirada`, interface do checkout (hoje ela esconde o
     endereço), textos da página do pedido e dos e-mails;
   - aceitação de `entrega.tipo = 'retirada'` em `criar_pedido` (ajuste o check);
   - testes e contrato.
   O endereço passa a ser sempre obrigatório.
5. **Preços e estoques placeholder** nos 16 produtos, na migração (produção) e não só no seed, para os testes de
   funcionamento:
   - body splash R$ 59,90; cremes R$ 69,90; sabonete líquido R$ 49,90; sabonete sólido R$ 24,90; biojoias R$ 89,90;
   - estoque 10 em todos;
   - nomes "Nome em Produção" e descrições continuam iguais.
   Para projetos já criados, acrescente na seção 10 um `update` que só preenche onde `preco_centavos = 0 and estoque = 0`.
6. Depois de cada item: `npm test`, `npm run test:integracao`, `node scripts/capturas-loja.mjs` e
   `node scripts/comparar-home.mjs`; olhe as capturas; commit e push.

## O que falta para lançar (depois dos pedidos acima)

1. **Páginas do painel ainda não feitas:**
   - `public/admin/js/paginas/pedidos.js`: lista com filtros e busca; detalhe com itens, cliente, entrega e pagamento;
     linha do tempo; notas (insert em `pedido_eventos` só com `tipo = 'nota'`); mudar status pela
     `/api/admin/pedido-status`; "Conferir pagamento"; assistente de envio pelo Melhor Envio
     (`/api/admin/envio`: adicionar_carrinho → comprar → gerar → imprimir → rastrear).
   - `public/admin/js/paginas/configuracoes.js`: abas Loja, Frete (sem retirada), Pagamento, Notificações e Integrações.
   Siga o `docs/PAINEL.md`. Cada página tem seu CSS em `public/admin/css/<pagina>.css`, seu script de capturas
   `scripts/capturas-painel-<pagina>.mjs` e seus testes `tests/unit/painel-<pagina>.test.js`.
2. **Revisão independente** das páginas de conteúdo, mídia, produtos e categorias, rodando
   `scripts/capturas-painel-conteudo.mjs` e `scripts/capturas-painel-produtos.mjs` e olhando as capturas no celular.
3. **Testes ponta a ponta com Playwright** em `tests/e2e/`:
   - admin edita o site;
   - cliente compra;
   - pagamento aprovado no Mercado Pago falso;
   - estoque baixa;
   - admin envia pelo Melhor Envio falso;
   - cliente vê o rastreio.
4. **Revisão final de segurança:** XSS, RLS, assinatura do webhook, token do pedido e segredos fora do front.
5. Completar a **Parte 2 do `docs/CONFIGURACAO.md`** para produção, atualizar o **PR** e perguntar ao dono antes de
   marcar como pronto.

## Ambiente local

- **Docker** (não sobe sozinho; depois de reiniciar o container pode haver PID antigo):
  `rm -f /var/run/docker/containerd/containerd.pid /var/run/docker.pid; setsid nohup dockerd >/tmp/dockerd.log 2>&1 < /dev/null &`
- **Supabase local:** `scripts/supabase-local.sh start -x imgproxy,postgres-meta,supavisor,vector,studio,mailpit`
  - Na primeira vez baixa as imagens (cerca de 5 minutos).
  - `scripts/supabase-local.sh db reset` reaplica a migração e o seed.
  - Admin de desenvolvimento: `admin@ama.local` / `admin123456`.
- **Servidor local:** `npm run dev`. Playwright usa o Chromium que já está em `/opt/pw-browsers`; **nunca** rode
  `playwright install`.
- **Segredos:** nunca escreva chaves em arquivos (o GitHub bloqueia o push).
- **Rede:** os domínios do Mercado Pago, Melhor Envio, Vercel, ViaCEP e Instagram são inacessíveis do container; use
  os servidores falsos.
- **Limite de uso:** o dono atinge o limite com frequência. Trabalhe em partes pequenas e faça commit e push a cada
  parte que passar nos testes.
