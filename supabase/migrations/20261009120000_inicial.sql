-- =============================================================================
-- AMA — Associação de Mulheres na Amazônia
-- Migração inicial: conteúdo do site (CMS), loja, pedidos, painel e mídia.
--
-- Pode ser colada inteira no SQL Editor de um projeto Supabase novo e executada
-- de uma vez (não depende do CLI). Também é segura para rodar de novo: usa
-- "if not exists", "create or replace", "drop policy if exists" e
-- "on conflict do nothing" nos dados iniciais.
--
-- Contrato: docs/ARQUITETURA.md, seção 4.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Tabelas
-- -----------------------------------------------------------------------------

-- Quem pode usar o painel administrativo.
create table if not exists public.admins (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  email     text,
  criado_em timestamptz not null default now()
);

-- Valores editados do CMS. Linha ausente = usar o padrão do template.
create table if not exists public.conteudo_site (
  chave          text primary key
                 constraint conteudo_site_chave_check check (chave ~ '^[a-z0-9][a-z0-9._-]{0,119}$'),
  valor          jsonb not null
                 constraint conteudo_site_valor_tamanho_check check (octet_length(valor::text) <= 200000),
  atualizado_em  timestamptz not null default now(),
  atualizado_por uuid
);

-- Configurações da loja. Só as linhas com publico = true são lidas pelo site.
create table if not exists public.configuracoes (
  chave         text primary key,
  valor         jsonb not null default '{}'::jsonb,
  publico       boolean not null default false,
  atualizado_em timestamptz not null default now()
);

create table if not exists public.categorias (
  id        uuid primary key default gen_random_uuid(),
  nome      text not null
            constraint categorias_nome_check check (length(btrim(nome)) between 1 and 120),
  slug      text not null unique
            constraint categorias_slug_check check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 120),
  descricao text default '',
  ordem     int not null default 0,
  ativo     boolean not null default true,
  criado_em timestamptz not null default now()
);

-- Preço efetivo = coalesce(preco_promocional_centavos, preco_centavos).
-- Produto só é vendável se ativo e com preço efetivo > 0.
create table if not exists public.produtos (
  id                         uuid primary key default gen_random_uuid(),
  nome                       text not null
                             constraint produtos_nome_check check (length(btrim(nome)) between 1 and 120),
  slug                       text not null unique
                             constraint produtos_slug_check check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) <= 120),
  descricao                  text not null default '',
  preco_centavos             int not null default 0
                             constraint produtos_preco_check check (preco_centavos >= 0),
  preco_promocional_centavos int
                             constraint produtos_preco_promocional_check check (
                               preco_promocional_centavos is null
                               or (preco_promocional_centavos >= 0 and preco_promocional_centavos < preco_centavos)),
  estoque                    int not null default 0
                             constraint produtos_estoque_check check (estoque >= 0),
  controlar_estoque          boolean not null default true,
  ativo                      boolean not null default false,
  destaque                   boolean not null default false,
  categoria_id               uuid references public.categorias (id) on delete set null,
  -- Array de { "src": "...", "alt": "..." }
  imagens                    jsonb not null default '[]'::jsonb
                             constraint produtos_imagens_check check (jsonb_typeof(imagens) = 'array'),
  peso_gramas                int not null default 300
                             constraint produtos_peso_check check (peso_gramas > 0),
  altura_cm                  numeric(6,1) not null default 4
                             constraint produtos_altura_check check (altura_cm > 0),
  largura_cm                 numeric(6,1) not null default 12
                             constraint produtos_largura_check check (largura_cm > 0),
  comprimento_cm             numeric(6,1) not null default 16
                             constraint produtos_comprimento_check check (comprimento_cm > 0),
  sku                        text,
  ordem                      int not null default 0,
  criado_em                  timestamptz not null default now(),
  atualizado_em              timestamptz not null default now()
);

-- Cupons. percentual: valor de 1 a 100; fixo: valor em centavos; frete_gratis: valor ignorado.
create table if not exists public.cupons (
  id              uuid primary key default gen_random_uuid(),
  codigo          text not null unique
                  constraint cupons_codigo_check check (codigo = upper(codigo) and codigo ~ '^[A-Z0-9_-]{3,30}$'),
  descricao       text default '',
  tipo            text not null
                  constraint cupons_tipo_check check (tipo in ('percentual', 'fixo', 'frete_gratis')),
  valor           int not null default 0,
  minimo_centavos int not null default 0
                  constraint cupons_minimo_check check (minimo_centavos >= 0),
  inicio          timestamptz,
  fim             timestamptz,
  usos_max        int
                  constraint cupons_usos_max_check check (usos_max is null or usos_max >= 0),
  usos            int not null default 0
                  constraint cupons_usos_check check (usos >= 0),
  ativo           boolean not null default true,
  criado_em       timestamptz not null default now(),
  constraint cupons_valor_check check (
    (tipo = 'percentual' and valor between 1 and 100)
    or (tipo = 'fixo' and valor > 0)
    or (tipo = 'frete_gratis' and valor >= 0)
  ),
  constraint cupons_periodo_check check (inicio is null or fim is null or fim > inicio)
);

create table if not exists public.pedidos (
  id                       uuid primary key default gen_random_uuid(),
  -- Exibido como #1001, #1002…
  numero                   bigint generated always as identity (start with 1001) unique,
  -- 64 caracteres hexadecimais: dois UUIDs aleatórios sem hífens.
  token_acesso             text not null
                           default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''))
                           constraint pedidos_token_check check (token_acesso ~ '^[0-9a-f]{64}$'),
  status                   text not null default 'aguardando_pagamento'
                           constraint pedidos_status_check check (status in (
                             'aguardando_pagamento', 'pagamento_em_analise', 'pago', 'em_separacao',
                             'enviado', 'entregue', 'cancelado', 'reembolsado')),
  status_pagamento         text,
  status_pagamento_detalhe text,
  metodo_pagamento         text,
  mp_preference_id         text,
  mp_init_point            text,
  mp_payment_id            text,
  cliente_nome             text not null,
  cliente_email            text not null,
  cliente_telefone         text not null,
  -- Só dígitos.
  cliente_cpf              text not null
                           constraint pedidos_cpf_check check (cliente_cpf ~ '^[0-9]{11}$'),
  -- { cep, logradouro, numero, complemento, bairro, cidade, uf } — vazio na retirada.
  endereco                 jsonb not null default '{}'::jsonb
                           constraint pedidos_endereco_check check (jsonb_typeof(endereco) = 'object'),
  -- { tipo, id, nome, empresa, prazo_dias, preco_centavos, servico_id }
  entrega                  jsonb not null
                           constraint pedidos_entrega_check check (
                             jsonb_typeof(entrega) = 'object'
                             and (entrega ->> 'tipo') in ('melhor_envio', 'fixo', 'retirada')),
  subtotal_centavos        int not null
                           constraint pedidos_subtotal_check check (subtotal_centavos >= 0),
  desconto_centavos        int not null default 0
                           constraint pedidos_desconto_check check (desconto_centavos >= 0),
  frete_centavos           int not null default 0
                           constraint pedidos_frete_check check (frete_centavos >= 0),
  total_centavos           int not null
                           constraint pedidos_total_check check (total_centavos > 0),
  cupom_codigo             text,
  codigo_rastreio          text,
  url_rastreio             text,
  -- Ids das etiquetas no Melhor Envio.
  me_ordens                jsonb not null default '[]'::jsonb
                           constraint pedidos_me_ordens_check check (jsonb_typeof(me_ordens) = 'array'),
  etiqueta_url             text,
  observacoes              text
                           constraint pedidos_observacoes_check check (observacoes is null or length(observacoes) <= 500),
  notas_internas           text,
  -- true enquanto os itens deste pedido estão descontados do estoque.
  estoque_baixado          boolean not null default false,
  pago_em                  timestamptz,
  enviado_em               timestamptz,
  entregue_em              timestamptz,
  cancelado_em             timestamptz,
  criado_em                timestamptz not null default now(),
  atualizado_em            timestamptz not null default now()
);

create table if not exists public.pedido_itens (
  id                      bigint generated always as identity primary key,
  pedido_id               uuid not null references public.pedidos (id) on delete cascade,
  produto_id              uuid references public.produtos (id) on delete set null,
  nome                    text not null,
  imagem                  text,
  preco_unitario_centavos int not null
                          constraint pedido_itens_preco_check check (preco_unitario_centavos >= 0),
  quantidade              int not null
                          constraint pedido_itens_quantidade_check check (quantidade between 1 and 99),
  total_centavos          int not null
                          constraint pedido_itens_total_check check (total_centavos >= 0)
);

-- Linha do tempo do pedido. autor: 'sistema', 'mercadopago' ou e-mail do admin.
create table if not exists public.pedido_eventos (
  id        bigint generated always as identity primary key,
  pedido_id uuid not null references public.pedidos (id) on delete cascade,
  tipo      text not null
            constraint pedido_eventos_tipo_check check (tipo in ('criado', 'pagamento', 'status', 'envio', 'email', 'nota', 'alerta')),
  descricao text not null
            constraint pedido_eventos_descricao_check check (length(descricao) between 1 and 5000),
  dados     jsonb,
  autor     text,
  criado_em timestamptz not null default now()
);


-- -----------------------------------------------------------------------------
-- 2. Índices
-- -----------------------------------------------------------------------------

create index if not exists produtos_ativo_ordem_idx       on public.produtos (ativo, ordem);
create index if not exists produtos_categoria_idx         on public.produtos (categoria_id);
create index if not exists pedidos_status_criado_idx      on public.pedidos (status, criado_em desc);
create index if not exists pedidos_criado_idx             on public.pedidos (criado_em desc);
create index if not exists pedidos_mp_payment_idx         on public.pedidos (mp_payment_id);
create index if not exists pedido_itens_pedido_idx        on public.pedido_itens (pedido_id);
create index if not exists pedido_itens_produto_idx       on public.pedido_itens (produto_id);
create index if not exists pedido_eventos_pedido_idx      on public.pedido_eventos (pedido_id, criado_em);


-- -----------------------------------------------------------------------------
-- 3. Triggers de atualizado_em
-- -----------------------------------------------------------------------------

create or replace function public.definir_atualizado_em()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

-- No CMS também guarda quem editou (o usuário logado no painel).
create or replace function public.definir_autor_conteudo()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.atualizado_em := now();
  new.atualizado_por := coalesce((select auth.uid()), new.atualizado_por);
  return new;
end;
$$;

drop trigger if exists conteudo_site_atualizado_em on public.conteudo_site;
create trigger conteudo_site_atualizado_em
  before insert or update on public.conteudo_site
  for each row execute function public.definir_autor_conteudo();

drop trigger if exists configuracoes_atualizado_em on public.configuracoes;
create trigger configuracoes_atualizado_em
  before update on public.configuracoes
  for each row execute function public.definir_atualizado_em();

drop trigger if exists produtos_atualizado_em on public.produtos;
create trigger produtos_atualizado_em
  before update on public.produtos
  for each row execute function public.definir_atualizado_em();

drop trigger if exists pedidos_atualizado_em on public.pedidos;
create trigger pedidos_atualizado_em
  before update on public.pedidos
  for each row execute function public.definir_atualizado_em();


-- -----------------------------------------------------------------------------
-- 4. Funções auxiliares internas (não são chamadas pela API)
--    Rodam com os privilégios de quem chama; só as funções da seção 5
--    (security definer, donas das tabelas) as usam.
-- -----------------------------------------------------------------------------

-- 123456 → 'R$ 1.234,56'
create or replace function public._formatar_reais(p_centavos bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select 'R$ ' || translate(to_char(coalesce(p_centavos, 0) / 100.0, 'FM999,999,999,990.00'), ',.', '.,');
$$;

create or replace function public._rotulo_status(p_status text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'aguardando_pagamento' then 'Aguardando pagamento'
    when 'pagamento_em_analise' then 'Pagamento em análise'
    when 'pago'                 then 'Pago'
    when 'em_separacao'         then 'Em separação'
    when 'enviado'              then 'Enviado'
    when 'entregue'             then 'Entregue'
    when 'cancelado'            then 'Cancelado'
    when 'reembolsado'          then 'Reembolsado'
    else coalesce(p_status, '—')
  end;
$$;

-- Desconta do estoque os itens do pedido (só produtos com controlar_estoque),
-- marca estoque_baixado = true e soma 1 no uso do cupom.
-- Quem chama já deve ter travado o pedido (select … for update) e conferido
-- que estoque_baixado = false. Devolve a lista de itens que faltaram.
create or replace function public._baixar_estoque(p_pedido_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  r         record;
  v_estoque int;
  v_faltas  jsonb := '[]'::jsonb;
  v_cupom   text;
begin
  -- Ordem fixa por produto evita impasse (deadlock) entre pedidos simultâneos.
  for r in
    select i.produto_id, sum(i.quantidade)::int as quantidade, min(i.nome) as nome
      from public.pedido_itens i
     where i.pedido_id = p_pedido_id
       and i.produto_id is not null
     group by i.produto_id
     order by i.produto_id
  loop
    select pr.estoque into v_estoque
      from public.produtos pr
     where pr.id = r.produto_id
       and pr.controlar_estoque
       for update;

    if found then
      if v_estoque < r.quantidade then
        v_faltas := v_faltas || jsonb_build_array(jsonb_build_object(
          'produto_id', r.produto_id, 'nome', r.nome,
          'quantidade', r.quantidade, 'estoque', v_estoque));
      end if;

      update public.produtos
         set estoque = greatest(0, estoque - r.quantidade)
       where id = r.produto_id;
    end if;
  end loop;

  update public.pedidos
     set estoque_baixado = true
   where id = p_pedido_id
  returning cupom_codigo into v_cupom;

  if v_cupom is not null then
    update public.cupons set usos = usos + 1 where codigo = v_cupom;
  end if;

  return v_faltas;
end;
$$;

-- Devolve ao estoque os itens do pedido, zera estoque_baixado e devolve o uso do cupom.
create or replace function public._repor_estoque(p_pedido_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  r       record;
  v_cupom text;
begin
  for r in
    select i.produto_id, sum(i.quantidade)::int as quantidade
      from public.pedido_itens i
     where i.pedido_id = p_pedido_id
       and i.produto_id is not null
     group by i.produto_id
     order by i.produto_id
  loop
    update public.produtos
       set estoque = estoque + r.quantidade
     where id = r.produto_id
       and controlar_estoque;
  end loop;

  update public.pedidos
     set estoque_baixado = false
   where id = p_pedido_id
  returning cupom_codigo into v_cupom;

  if v_cupom is not null then
    update public.cupons set usos = greatest(0, usos - 1) where codigo = v_cupom;
  end if;
end;
$$;


-- -----------------------------------------------------------------------------
-- 5. Funções da API (RPC)
--    Todas security definer, search_path vazio e nomes totalmente qualificados.
-- -----------------------------------------------------------------------------

-- 5.1 O usuário logado é administrador?
create or replace function public.eh_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = (select auth.uid()));
$$;


-- 5.2 Cotação do carrinho: preços, estoque e cupom recalculados no banco.
-- Entrada: { "itens": [{ "produto_id": uuid, "quantidade": int }], "cupom": "CODIGO" | null }
create or replace function public.cotar_carrinho(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_entrada      jsonb := coalesce(p, '{}'::jsonb);
  v_itens        jsonb := '[]'::jsonb;
  v_subtotal     bigint := 0;
  v_desconto     bigint := 0;
  v_frete_gratis boolean := false;
  v_codigo       text;
  v_cupom        public.cupons%rowtype;
  v_cupom_json   jsonb;
  v_preco        bigint;
  v_motivo       text;
  v_disponivel   boolean;
  v_total        bigint;
  r              record;
begin
  if jsonb_typeof(v_entrada) <> 'object' then
    v_entrada := '{}'::jsonb;
  end if;

  -- Normaliza as linhas: junta o mesmo produto, ignora quantidade <= 0,
  -- limita a 99 unidades por linha e a 30 linhas (na ordem em que chegaram).
  for r in
    with brutos as (
      select e.valor, e.ordem
        from jsonb_array_elements(
               case when jsonb_typeof(v_entrada -> 'itens') = 'array'
                    then v_entrada -> 'itens' else '[]'::jsonb end
             ) with ordinality as e (valor, ordem)
       where jsonb_typeof(e.valor) = 'object'
         and jsonb_typeof(e.valor -> 'produto_id') = 'string'
    ),
    normalizados as (
      select lower(left(btrim(b.valor ->> 'produto_id'), 64)) as id_texto,
             case
               when jsonb_typeof(b.valor -> 'quantidade') = 'number'
                 then trunc((b.valor ->> 'quantidade')::numeric)
               when jsonb_typeof(b.valor -> 'quantidade') = 'string'
                    and btrim(b.valor ->> 'quantidade') ~ '^-?[0-9]{1,9}$'
                 then btrim(b.valor ->> 'quantidade')::numeric
               else 0
             end as qtd,
             b.ordem
        from brutos b
    ),
    agrupados as (
      select n.id_texto, least(sum(n.qtd), 99)::int as quantidade, min(n.ordem) as ordem
        from normalizados n
       where n.qtd > 0
         and n.id_texto <> ''
       group by n.id_texto
       order by min(n.ordem)
       limit 30
    )
    select a.id_texto, a.quantidade, a.ordem,
           pr.id, pr.nome, pr.slug, pr.imagens, pr.preco_centavos, pr.preco_promocional_centavos,
           pr.estoque, pr.controlar_estoque, pr.ativo,
           pr.peso_gramas, pr.altura_cm, pr.largura_cm, pr.comprimento_cm
      from agrupados a
      left join public.produtos pr
        on pr.id = (case when a.id_texto ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         then a.id_texto::uuid end)
     order by a.ordem
  loop
    v_preco := coalesce(r.preco_promocional_centavos, r.preco_centavos);

    v_motivo := case
      when r.id is null then 'inexistente'
      when not r.ativo or coalesce(v_preco, 0) <= 0 then 'inativo'
      when r.controlar_estoque and r.estoque <= 0 then 'sem_estoque'
      when r.controlar_estoque and r.estoque < r.quantidade then 'estoque_insuficiente'
      else null
    end;
    v_disponivel := v_motivo is null;
    v_total := case when v_disponivel then v_preco * r.quantidade else 0 end;
    v_subtotal := v_subtotal + v_total;

    v_itens := v_itens || jsonb_build_array(jsonb_build_object(
      'produto_id',              coalesce(r.id::text, r.id_texto),
      'nome',                    r.nome,
      'slug',                    r.slug,
      'imagem',                  case when jsonb_typeof(r.imagens -> 0) = 'object' then r.imagens -> 0 ->> 'src' end,
      'preco_unitario_centavos', coalesce(v_preco, 0),
      'quantidade',              r.quantidade,
      'total_centavos',          v_total,
      'estoque_disponivel',      case when r.id is null then 0
                                      when r.controlar_estoque then r.estoque
                                      else null end,
      'disponivel',              v_disponivel,
      'motivo',                  v_motivo,
      'peso_gramas',             r.peso_gramas,
      'altura_cm',               r.altura_cm,
      'largura_cm',              r.largura_cm,
      'comprimento_cm',          r.comprimento_cm
    ));
  end loop;

  -- Cupom (o código é comparado em maiúsculas).
  if jsonb_typeof(v_entrada -> 'cupom') = 'string' then
    v_codigo := nullif(upper(btrim(v_entrada ->> 'cupom')), '');
  end if;

  if v_codigo is not null then
    v_codigo := left(v_codigo, 60);

    select c.* into v_cupom
      from public.cupons c
     where c.codigo = v_codigo
       and c.ativo;

    if not found then
      v_cupom_json := jsonb_build_object('codigo', v_codigo, 'valido', false, 'tipo', null,
                                         'mensagem', 'Cupom não encontrado');
    elsif v_cupom.inicio is not null and v_cupom.inicio > now() then
      v_cupom_json := jsonb_build_object('codigo', v_codigo, 'valido', false, 'tipo', v_cupom.tipo,
                                         'mensagem', 'Cupom ainda não disponível');
    elsif v_cupom.fim is not null and v_cupom.fim <= now() then
      v_cupom_json := jsonb_build_object('codigo', v_codigo, 'valido', false, 'tipo', v_cupom.tipo,
                                         'mensagem', 'Cupom expirado');
    elsif v_cupom.usos_max is not null and v_cupom.usos >= v_cupom.usos_max then
      v_cupom_json := jsonb_build_object('codigo', v_codigo, 'valido', false, 'tipo', v_cupom.tipo,
                                         'mensagem', 'Cupom esgotado');
    elsif v_subtotal < v_cupom.minimo_centavos then
      v_cupom_json := jsonb_build_object('codigo', v_codigo, 'valido', false, 'tipo', v_cupom.tipo,
                                         'mensagem', 'Valor mínimo para este cupom: '
                                                     || public._formatar_reais(v_cupom.minimo_centavos));
    elsif v_cupom.tipo = 'percentual' then
      -- Arredonda para baixo: nunca dá mais desconto que o anunciado.
      v_desconto := floor(v_subtotal * v_cupom.valor / 100.0)::bigint;
      v_cupom_json := jsonb_build_object('codigo', v_codigo, 'valido', true, 'tipo', v_cupom.tipo,
                                         'mensagem', 'Cupom aplicado: ' || v_cupom.valor || '% de desconto');
    elsif v_cupom.tipo = 'fixo' then
      v_desconto := least(v_cupom.valor::bigint, v_subtotal);
      v_cupom_json := jsonb_build_object('codigo', v_codigo, 'valido', true, 'tipo', v_cupom.tipo,
                                         'mensagem', 'Cupom aplicado: '
                                                     || public._formatar_reais(v_cupom.valor) || ' de desconto');
    else
      v_frete_gratis := true;
      v_cupom_json := jsonb_build_object('codigo', v_codigo, 'valido', true, 'tipo', v_cupom.tipo,
                                         'mensagem', 'Cupom aplicado: frete grátis');
    end if;
  end if;

  return jsonb_build_object(
    'itens',              v_itens,
    'subtotal_centavos',  v_subtotal,
    'desconto_centavos',  v_desconto,
    'cupom',              v_cupom_json,
    'frete_gratis_cupom', v_frete_gratis
  );
end;
$$;


-- 5.3 Cria o pedido a partir do carrinho (preços recalculados aqui).
-- Erros (message do PostgREST): carrinho_vazio, item_indisponivel, cupom_invalido,
-- dados_invalidos (detail = campo), total_invalido.
create or replace function public.criar_pedido(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_cliente   jsonb;
  v_end       jsonb;
  v_ent       jsonb;
  v_nome      text;
  v_email     text;
  v_telefone  text;
  v_cpf       text;
  v_tipo      text;
  v_ent_id    text;
  v_ent_nome  text;
  v_empresa   text;
  v_prazo     int;
  v_frete     bigint;
  v_servico   bigint;
  v_cep       text;
  v_logr      text;
  v_num       text;
  v_compl     text;
  v_bairro    text;
  v_cidade    text;
  v_uf        text;
  v_endereco  jsonb := '{}'::jsonb;
  v_entrega   jsonb;
  v_obs       text;
  v_cupom_inf text;
  v_cotacao   jsonb;
  v_subtotal  bigint;
  v_desconto  bigint;
  v_total     bigint;
  v_pedido    public.pedidos%rowtype;
  v_indisp    jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'dados_invalidos' using detail = 'corpo';
  end if;

  -- Cliente ------------------------------------------------------------------
  v_cliente := p -> 'cliente';
  if jsonb_typeof(v_cliente) is distinct from 'object' then
    raise exception 'dados_invalidos' using detail = 'cliente';
  end if;

  v_nome := case when jsonb_typeof(v_cliente -> 'nome') = 'string'
                 then regexp_replace(btrim(v_cliente ->> 'nome', E' \t\r\n'), '[[:space:]]+', ' ', 'g') end;
  if v_nome is null or length(v_nome) not between 2 and 120 then
    raise exception 'dados_invalidos' using detail = 'cliente.nome';
  end if;

  v_email := case when jsonb_typeof(v_cliente -> 'email') = 'string'
                  then lower(btrim(v_cliente ->> 'email', E' \t\r\n')) end;
  if v_email is null or length(v_email) > 160
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'dados_invalidos' using detail = 'cliente.email';
  end if;

  v_telefone := case when jsonb_typeof(v_cliente -> 'telefone') = 'string'
                     then regexp_replace(v_cliente ->> 'telefone', '[^0-9]', '', 'g') end;
  if v_telefone is null or length(v_telefone) not between 10 and 11 then
    raise exception 'dados_invalidos' using detail = 'cliente.telefone';
  end if;

  v_cpf := case when jsonb_typeof(v_cliente -> 'cpf') = 'string'
                then regexp_replace(v_cliente ->> 'cpf', '[^0-9]', '', 'g') end;
  if v_cpf is null or length(v_cpf) <> 11 then
    raise exception 'dados_invalidos' using detail = 'cliente.cpf';
  end if;

  -- Entrega (já cotada pelo servidor) ---------------------------------------
  v_ent := p -> 'entrega';
  if jsonb_typeof(v_ent) is distinct from 'object' then
    raise exception 'dados_invalidos' using detail = 'entrega';
  end if;

  v_tipo := case when jsonb_typeof(v_ent -> 'tipo') = 'string' then v_ent ->> 'tipo' end;
  if v_tipo is null or v_tipo not in ('melhor_envio', 'fixo', 'retirada') then
    raise exception 'dados_invalidos' using detail = 'entrega.tipo';
  end if;

  v_ent_id := case when jsonb_typeof(v_ent -> 'id') in ('string', 'number') then btrim(v_ent ->> 'id') end;
  if v_ent_id is null or length(v_ent_id) not between 1 and 60 then
    raise exception 'dados_invalidos' using detail = 'entrega.id';
  end if;

  v_ent_nome := case when jsonb_typeof(v_ent -> 'nome') = 'string' then btrim(v_ent ->> 'nome') end;
  if v_ent_nome is null or length(v_ent_nome) not between 1 and 120 then
    raise exception 'dados_invalidos' using detail = 'entrega.nome';
  end if;

  if jsonb_typeof(v_ent -> 'empresa') = 'string' then
    v_empresa := nullif(btrim(v_ent ->> 'empresa'), '');
    if length(v_empresa) > 120 then
      raise exception 'dados_invalidos' using detail = 'entrega.empresa';
    end if;
  elsif coalesce(jsonb_typeof(v_ent -> 'empresa'), 'null') <> 'null' then
    raise exception 'dados_invalidos' using detail = 'entrega.empresa';
  end if;

  if jsonb_typeof(v_ent -> 'prazo_dias') = 'number' then
    if (v_ent ->> 'prazo_dias')::numeric <> trunc((v_ent ->> 'prazo_dias')::numeric)
       or (v_ent ->> 'prazo_dias')::numeric not between 0 and 365 then
      raise exception 'dados_invalidos' using detail = 'entrega.prazo_dias';
    end if;
    v_prazo := (v_ent ->> 'prazo_dias')::int;
  elsif coalesce(jsonb_typeof(v_ent -> 'prazo_dias'), 'null') <> 'null' then
    raise exception 'dados_invalidos' using detail = 'entrega.prazo_dias';
  end if;

  -- (testes separados: o cast só roda quando já se sabe que é número)
  if jsonb_typeof(v_ent -> 'preco_centavos') is distinct from 'number' then
    raise exception 'dados_invalidos' using detail = 'entrega.preco_centavos';
  end if;
  if (v_ent ->> 'preco_centavos')::numeric <> trunc((v_ent ->> 'preco_centavos')::numeric)
     or (v_ent ->> 'preco_centavos')::numeric not between 0 and 2147483647 then
    raise exception 'dados_invalidos' using detail = 'entrega.preco_centavos';
  end if;
  v_frete := (v_ent ->> 'preco_centavos')::bigint;

  if jsonb_typeof(v_ent -> 'servico_id') = 'number'
     or (jsonb_typeof(v_ent -> 'servico_id') = 'string' and btrim(v_ent ->> 'servico_id') ~ '^[0-9]{1,9}$') then
    if (v_ent ->> 'servico_id')::numeric <> trunc((v_ent ->> 'servico_id')::numeric)
       or (v_ent ->> 'servico_id')::numeric not between 1 and 2147483647 then
      raise exception 'dados_invalidos' using detail = 'entrega.servico_id';
    end if;
    v_servico := (v_ent ->> 'servico_id')::bigint;
  elsif coalesce(jsonb_typeof(v_ent -> 'servico_id'), 'null') <> 'null' then
    raise exception 'dados_invalidos' using detail = 'entrega.servico_id';
  end if;
  -- O Melhor Envio precisa do serviço para gerar a etiqueta depois.
  if v_tipo = 'melhor_envio' and v_servico is null then
    raise exception 'dados_invalidos' using detail = 'entrega.servico_id';
  end if;

  v_entrega := jsonb_build_object(
    'tipo', v_tipo, 'id', v_ent_id, 'nome', v_ent_nome, 'empresa', v_empresa,
    'prazo_dias', v_prazo, 'preco_centavos', v_frete, 'servico_id', v_servico);

  -- Endereço (não se aplica à retirada) --------------------------------------
  if v_tipo <> 'retirada' then
    v_end := p -> 'endereco';
    if jsonb_typeof(v_end) is distinct from 'object' then
      raise exception 'dados_invalidos' using detail = 'endereco';
    end if;

    v_cep := case when jsonb_typeof(v_end -> 'cep') = 'string'
                  then regexp_replace(v_end ->> 'cep', '[^0-9]', '', 'g') end;
    if v_cep is null or length(v_cep) <> 8 then
      raise exception 'dados_invalidos' using detail = 'endereco.cep';
    end if;

    v_logr := case when jsonb_typeof(v_end -> 'logradouro') = 'string' then btrim(v_end ->> 'logradouro') end;
    if v_logr is null or length(v_logr) not between 1 and 200 then
      raise exception 'dados_invalidos' using detail = 'endereco.logradouro';
    end if;

    v_num := case when jsonb_typeof(v_end -> 'numero') in ('string', 'number') then btrim(v_end ->> 'numero') end;
    if v_num is null or length(v_num) not between 1 and 20 then
      raise exception 'dados_invalidos' using detail = 'endereco.numero';
    end if;

    if jsonb_typeof(v_end -> 'complemento') = 'string' then
      v_compl := nullif(btrim(v_end ->> 'complemento'), '');
      if length(v_compl) > 100 then
        raise exception 'dados_invalidos' using detail = 'endereco.complemento';
      end if;
    elsif coalesce(jsonb_typeof(v_end -> 'complemento'), 'null') <> 'null' then
      raise exception 'dados_invalidos' using detail = 'endereco.complemento';
    end if;

    v_bairro := case when jsonb_typeof(v_end -> 'bairro') = 'string' then btrim(v_end ->> 'bairro') end;
    if v_bairro is null or length(v_bairro) not between 1 and 100 then
      raise exception 'dados_invalidos' using detail = 'endereco.bairro';
    end if;

    v_cidade := case when jsonb_typeof(v_end -> 'cidade') = 'string' then btrim(v_end ->> 'cidade') end;
    if v_cidade is null or length(v_cidade) not between 1 and 100 then
      raise exception 'dados_invalidos' using detail = 'endereco.cidade';
    end if;

    v_uf := case when jsonb_typeof(v_end -> 'uf') = 'string' then upper(btrim(v_end ->> 'uf')) end;
    if v_uf is null or v_uf !~ '^[A-Z]{2}$' then
      raise exception 'dados_invalidos' using detail = 'endereco.uf';
    end if;

    v_endereco := jsonb_build_object(
      'cep', v_cep, 'logradouro', v_logr, 'numero', v_num, 'complemento', coalesce(v_compl, ''),
      'bairro', v_bairro, 'cidade', v_cidade, 'uf', v_uf);
  end if;

  -- Observações do cliente ----------------------------------------------------
  if jsonb_typeof(p -> 'observacoes') = 'string' then
    v_obs := nullif(btrim(p ->> 'observacoes', E' \t\r\n'), '');
    if length(v_obs) > 500 then
      raise exception 'dados_invalidos' using detail = 'observacoes';
    end if;
  elsif coalesce(jsonb_typeof(p -> 'observacoes'), 'null') <> 'null' then
    raise exception 'dados_invalidos' using detail = 'observacoes';
  end if;

  -- Carrinho e cupom (recalculados) -------------------------------------------
  if jsonb_typeof(p -> 'cupom') = 'string' then
    v_cupom_inf := nullif(upper(btrim(p ->> 'cupom')), '');
  end if;

  v_cotacao := public.cotar_carrinho(jsonb_build_object('itens', p -> 'itens', 'cupom', p -> 'cupom'));

  if jsonb_array_length(v_cotacao -> 'itens') = 0 then
    raise exception 'carrinho_vazio';
  end if;

  select jsonb_agg(jsonb_build_object('produto_id', i ->> 'produto_id', 'motivo', i ->> 'motivo'))
    into v_indisp
    from jsonb_array_elements(v_cotacao -> 'itens') i
   where not (i ->> 'disponivel')::boolean;
  if v_indisp is not null then
    raise exception 'item_indisponivel' using detail = v_indisp::text;
  end if;

  if v_cupom_inf is not null and coalesce((v_cotacao -> 'cupom' ->> 'valido')::boolean, false) = false then
    raise exception 'cupom_invalido' using detail = coalesce(v_cotacao -> 'cupom' ->> 'mensagem', '');
  end if;

  v_subtotal := (v_cotacao ->> 'subtotal_centavos')::bigint;
  v_desconto := (v_cotacao ->> 'desconto_centavos')::bigint;
  v_total := v_subtotal - v_desconto + v_frete;

  if v_total <= 0 or v_total > 2147483647 or v_subtotal > 2147483647 then
    raise exception 'total_invalido';
  end if;

  -- Gravação --------------------------------------------------------------------
  insert into public.pedidos (
    cliente_nome, cliente_email, cliente_telefone, cliente_cpf,
    endereco, entrega, subtotal_centavos, desconto_centavos, frete_centavos, total_centavos,
    cupom_codigo, observacoes)
  values (
    v_nome, v_email, v_telefone, v_cpf,
    v_endereco, v_entrega, v_subtotal, v_desconto, v_frete, v_total,
    case when v_cupom_inf is not null then v_cotacao -> 'cupom' ->> 'codigo' end, v_obs)
  returning * into v_pedido;

  insert into public.pedido_itens (pedido_id, produto_id, nome, imagem, preco_unitario_centavos, quantidade, total_centavos)
  select v_pedido.id,
         (i ->> 'produto_id')::uuid,
         i ->> 'nome',
         i ->> 'imagem',
         (i ->> 'preco_unitario_centavos')::int,
         (i ->> 'quantidade')::int,
         (i ->> 'total_centavos')::int
    from jsonb_array_elements(v_cotacao -> 'itens') with ordinality as t (i, ordem)
   order by t.ordem;

  insert into public.pedido_eventos (pedido_id, tipo, descricao, dados, autor)
  values (
    v_pedido.id, 'criado', 'Pedido criado',
    jsonb_build_object(
      'total_centavos', v_total,
      'itens', jsonb_array_length(v_cotacao -> 'itens'),
      'entrega', v_tipo,
      'cupom', v_pedido.cupom_codigo),
    'sistema');

  return jsonb_build_object(
    'id',                v_pedido.id,
    'numero',            v_pedido.numero,
    'token_acesso',      v_pedido.token_acesso,
    'subtotal_centavos', v_pedido.subtotal_centavos,
    'desconto_centavos', v_pedido.desconto_centavos,
    'frete_centavos',    v_pedido.frete_centavos,
    'total_centavos',    v_pedido.total_centavos,
    'cupom_codigo',      v_pedido.cupom_codigo,
    'itens',             v_cotacao -> 'itens'
  );
end;
$$;


-- 5.4 Sincroniza o pedido com um pagamento do Mercado Pago (GET /v1/payments/{id}).
-- Idempotente: pode ser chamada várias vezes (webhook, retorno do cliente, painel).
create or replace function public.confirmar_pagamento(p_pedido_id uuid, p_pagamento jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pedido      public.pedidos%rowtype;
  v_id          text;
  v_status      text;
  v_detalhe     text;
  v_tipo_pag    text;
  v_metodo      text;
  v_valor       numeric;
  v_valor_cent  bigint;
  v_anterior    text;
  v_novo        text;
  v_repetido    boolean;
  v_divergente  boolean := false;
  v_virou_pago  boolean := false;
  v_atualizar   boolean;
  v_faltas      jsonb := '[]'::jsonb;
  v_descricao   text;
begin
  if p_pedido_id is null then
    raise exception 'dados_invalidos' using detail = 'p_pedido_id';
  end if;
  if p_pagamento is null or jsonb_typeof(p_pagamento) <> 'object' then
    raise exception 'dados_invalidos' using detail = 'p_pagamento';
  end if;

  v_status := lower(btrim(p_pagamento ->> 'status'));
  if v_status is null or v_status = '' or length(v_status) > 40 then
    raise exception 'dados_invalidos' using detail = 'p_pagamento.status';
  end if;

  v_id       := nullif(left(btrim(p_pagamento ->> 'id'), 60), '');
  v_detalhe  := nullif(left(btrim(p_pagamento ->> 'status_detail'), 120), '');
  v_tipo_pag := nullif(left(btrim(p_pagamento ->> 'payment_type_id'), 60), '');
  v_metodo   := nullif(left(btrim(p_pagamento ->> 'payment_method_id'), 60), '');

  if jsonb_typeof(p_pagamento -> 'transaction_amount') = 'number' then
    v_valor := (p_pagamento ->> 'transaction_amount')::numeric;
  elsif jsonb_typeof(p_pagamento -> 'transaction_amount') = 'string'
        and btrim(p_pagamento ->> 'transaction_amount') ~ '^[0-9]{1,12}(\.[0-9]{1,6})?$' then
    v_valor := btrim(p_pagamento ->> 'transaction_amount')::numeric;
  end if;
  -- Reais → centavos (limite só para não estourar bigint com valores absurdos).
  v_valor_cent := round(least(v_valor, 1000000000000) * 100);

  -- Trava o pedido: chamadas simultâneas (webhook + retorno) esperam a vez.
  select * into v_pedido
    from public.pedidos
   where id = p_pedido_id
     for update;
  if not found then
    raise exception 'pedido_nao_encontrado';
  end if;

  v_anterior := v_pedido.status;
  v_novo := v_anterior;

  select exists (
    select 1
      from public.pedido_eventos e
     where e.pedido_id = p_pedido_id
       and e.tipo = 'pagamento'
       and (e.dados ->> 'payment_id') is not distinct from v_id
       and (e.dados ->> 'status') = v_status
  ) into v_repetido;

  -- Novo status do pedido -----------------------------------------------------
  if v_status in ('approved', 'authorized') then
    if v_valor_cent is null or v_valor_cent < v_pedido.total_centavos - 1 then
      v_divergente := true;
      if v_anterior in ('aguardando_pagamento', 'pagamento_em_analise', 'cancelado') then
        v_novo := 'pagamento_em_analise';
      end if;
    elsif v_anterior in ('aguardando_pagamento', 'pagamento_em_analise', 'cancelado') then
      v_novo := 'pago';
    end if;
    -- Nunca regride em_separacao, enviado ou entregue (nem reembolsado).
  elsif v_status in ('pending', 'in_process', 'in_mediation') then
    if v_anterior = 'aguardando_pagamento' then
      v_novo := 'pagamento_em_analise';
    end if;
  elsif v_status in ('refunded', 'charged_back') then
    v_novo := 'reembolsado';
  end if;
  -- rejected / cancelled e status desconhecidos: o pedido continua como está
  -- (o cliente pode tentar pagar de novo); só registramos o evento.

  v_virou_pago := v_novo = 'pago' and v_anterior <> 'pago';

  -- Um pagamento diferente, pendente ou recusado, não apaga os dados de um
  -- pagamento já aprovado (ex.: webhook atrasado de uma tentativa anterior).
  v_atualizar := not (
    v_pedido.mp_payment_id is not null
    and v_id is distinct from v_pedido.mp_payment_id
    and v_pedido.status_pagamento in ('approved', 'authorized')
    and v_status not in ('approved', 'authorized', 'refunded', 'charged_back')
  );

  update public.pedidos
     set status                   = v_novo,
         pago_em                  = case when v_virou_pago then now() else pago_em end,
         status_pagamento         = case when v_atualizar then v_status else status_pagamento end,
         status_pagamento_detalhe = case when v_atualizar then v_detalhe else status_pagamento_detalhe end,
         mp_payment_id            = case when v_atualizar then coalesce(v_id, mp_payment_id) else mp_payment_id end,
         metodo_pagamento         = case when v_atualizar then coalesce(v_tipo_pag, metodo_pagamento) else metodo_pagamento end
   where id = p_pedido_id;

  -- Estoque -------------------------------------------------------------------
  -- Pagamento aprovado (com valor correto) num pedido que está em situação de
  -- pago: baixa o estoque uma única vez.
  if v_status in ('approved', 'authorized') and not v_divergente
     and v_novo in ('pago', 'em_separacao', 'enviado', 'entregue')
     and not v_pedido.estoque_baixado then
    v_faltas := public._baixar_estoque(p_pedido_id);
  end if;

  if v_novo = 'reembolsado' and v_pedido.estoque_baixado then
    perform public._repor_estoque(p_pedido_id);
  end if;

  -- Linha do tempo --------------------------------------------------------------
  if not v_repetido then
    v_descricao := case v_status
        when 'approved'     then 'Pagamento aprovado'
        when 'authorized'   then 'Pagamento autorizado'
        when 'pending'      then 'Pagamento pendente'
        when 'in_process'   then 'Pagamento em análise pelo Mercado Pago'
        when 'in_mediation' then 'Pagamento em disputa'
        when 'rejected'     then 'Pagamento recusado'
        when 'cancelled'    then 'Pagamento cancelado'
        when 'refunded'     then 'Pagamento devolvido ao cliente'
        when 'charged_back' then 'Pagamento contestado (estorno)'
        else 'Pagamento: ' || v_status
      end
      || coalesce(' — ' || case
        when v_metodo = 'pix'          then 'Pix'
        when v_tipo_pag = 'credit_card'   then 'cartão de crédito'
        when v_tipo_pag = 'debit_card'    then 'cartão de débito'
        when v_tipo_pag = 'ticket'        then 'boleto'
        when v_tipo_pag = 'bank_transfer' then 'transferência'
        when v_tipo_pag = 'account_money' then 'saldo no Mercado Pago'
        else v_tipo_pag
      end, '');

    insert into public.pedido_eventos (pedido_id, tipo, descricao, dados, autor)
    values (
      p_pedido_id, 'pagamento', v_descricao,
      jsonb_build_object(
        'payment_id',         v_id,
        'status',             v_status,
        'status_detail',      v_detalhe,
        'transaction_amount', v_valor,
        'payment_type_id',    v_tipo_pag,
        'payment_method_id',  v_metodo,
        'date_approved',      p_pagamento -> 'date_approved',
        'status_anterior',    v_anterior,
        'status_novo',        v_novo),
      'mercadopago');

    if v_divergente then
      insert into public.pedido_eventos (pedido_id, tipo, descricao, dados, autor)
      values (
        p_pedido_id, 'alerta',
        'Pagamento com valor divergente: recebido '
          || case when v_valor_cent is null then 'valor não informado' else public._formatar_reais(v_valor_cent) end
          || ', total do pedido ' || public._formatar_reais(v_pedido.total_centavos) || '. Confira antes de enviar.',
        jsonb_build_object('payment_id', v_id, 'valor_centavos', v_valor_cent,
                           'total_centavos', v_pedido.total_centavos),
        'sistema');
    end if;
  end if;

  if jsonb_array_length(v_faltas) > 0 then
    insert into public.pedido_eventos (pedido_id, tipo, descricao, dados, autor)
    values (
      p_pedido_id, 'alerta',
      'Estoque insuficiente para algum item ao confirmar o pagamento. Confira o estoque antes de separar.',
      jsonb_build_object('itens', v_faltas),
      'sistema');
  end if;

  return jsonb_build_object(
    'pedido_id',       v_pedido.id,
    'numero',          v_pedido.numero,
    'status_anterior', v_anterior,
    'status_novo',     v_novo,
    'mudou',           v_novo <> v_anterior,
    'virou_pago',      v_virou_pago
  );
end;
$$;


-- 5.5 Alteração manual de status pelo painel (via /api/admin/pedido-status).
create or replace function public.alterar_status_pedido(
  p_pedido_id     uuid,
  p_status        text,
  p_autor         text,
  p_nota          text default null,
  p_repor_estoque boolean default false,
  p_rastreio      jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_pedido     public.pedidos%rowtype;
  v_anterior   text;
  v_novo       text := lower(btrim(p_status));
  v_autor      text := coalesce(nullif(left(btrim(p_autor), 160), ''), 'sistema');
  v_nota       text := nullif(btrim(p_nota, E' \t\r\n'), '');
  v_tem_codigo boolean := false;
  v_tem_url    boolean := false;
  v_codigo     text;
  v_url        text;
  v_reposto    boolean := false;
  v_baixado    boolean := false;
  v_faltas     jsonb := '[]'::jsonb;
  v_descricao  text;
begin
  if p_pedido_id is null then
    raise exception 'dados_invalidos' using detail = 'p_pedido_id';
  end if;
  if v_novo is null or v_novo not in ('aguardando_pagamento', 'pagamento_em_analise', 'pago', 'em_separacao',
                                      'enviado', 'entregue', 'cancelado', 'reembolsado') then
    raise exception 'status_invalido';
  end if;
  if length(v_nota) > 2000 then
    raise exception 'dados_invalidos' using detail = 'p_nota';
  end if;

  -- Rastreio opcional: { codigo_rastreio, url_rastreio } ("" ou null apaga).
  if p_rastreio is not null and jsonb_typeof(p_rastreio) <> 'null' then
    if jsonb_typeof(p_rastreio) <> 'object' then
      raise exception 'dados_invalidos' using detail = 'p_rastreio';
    end if;

    if p_rastreio ? 'codigo_rastreio' then
      v_tem_codigo := true;
      if jsonb_typeof(p_rastreio -> 'codigo_rastreio') = 'string' then
        v_codigo := nullif(btrim(p_rastreio ->> 'codigo_rastreio'), '');
      elsif jsonb_typeof(p_rastreio -> 'codigo_rastreio') <> 'null' then
        raise exception 'dados_invalidos' using detail = 'p_rastreio.codigo_rastreio';
      end if;
      if length(v_codigo) > 200 then
        raise exception 'dados_invalidos' using detail = 'p_rastreio.codigo_rastreio';
      end if;
    end if;

    if p_rastreio ? 'url_rastreio' then
      v_tem_url := true;
      if jsonb_typeof(p_rastreio -> 'url_rastreio') = 'string' then
        v_url := nullif(btrim(p_rastreio ->> 'url_rastreio'), '');
      elsif jsonb_typeof(p_rastreio -> 'url_rastreio') <> 'null' then
        raise exception 'dados_invalidos' using detail = 'p_rastreio.url_rastreio';
      end if;
      if v_url is not null and (length(v_url) > 500 or v_url !~* '^https?://[^[:space:]]+$') then
        raise exception 'dados_invalidos' using detail = 'p_rastreio.url_rastreio';
      end if;
    end if;
  end if;

  select * into v_pedido
    from public.pedidos
   where id = p_pedido_id
     for update;
  if not found then
    raise exception 'pedido_nao_encontrado';
  end if;

  v_anterior := v_pedido.status;

  update public.pedidos
     set status          = v_novo,
         pago_em         = case
                             when v_novo in ('aguardando_pagamento', 'pagamento_em_analise') then null
                             when v_novo in ('pago', 'em_separacao', 'enviado', 'entregue') then coalesce(pago_em, now())
                             else pago_em
                           end,
         enviado_em      = case
                             when v_novo = 'enviado' and v_anterior not in ('enviado', 'entregue') then now()
                             when v_novo = 'enviado' then coalesce(enviado_em, now())
                             when v_novo in ('entregue', 'cancelado', 'reembolsado') then enviado_em
                             else null
                           end,
         entregue_em     = case
                             when v_novo = 'entregue' and v_anterior <> 'entregue' then now()
                             when v_novo = 'entregue' then coalesce(entregue_em, now())
                             when v_novo in ('cancelado', 'reembolsado') then entregue_em
                             else null
                           end,
         cancelado_em    = case
                             when v_novo = 'cancelado' and v_anterior <> 'cancelado' then now()
                             when v_novo = 'cancelado' then coalesce(cancelado_em, now())
                             when v_novo = 'reembolsado' then cancelado_em
                             else null
                           end,
         codigo_rastreio = case when v_tem_codigo then v_codigo else codigo_rastreio end,
         url_rastreio    = case when v_tem_url then v_url else url_rastreio end
   where id = p_pedido_id;

  -- Estoque: devolve só quando pedido (cancelado/reembolsado + p_repor_estoque);
  -- ao marcar manualmente como pago/separação/enviado/entregue, baixa se ainda não baixou.
  if v_novo in ('cancelado', 'reembolsado') and coalesce(p_repor_estoque, false) and v_pedido.estoque_baixado then
    perform public._repor_estoque(p_pedido_id);
    v_reposto := true;
  elsif v_novo in ('pago', 'em_separacao', 'enviado', 'entregue') and not v_pedido.estoque_baixado then
    v_faltas := public._baixar_estoque(p_pedido_id);
    v_baixado := true;
  end if;

  v_descricao := case
      when v_novo <> v_anterior
        then 'Status alterado de ' || public._rotulo_status(v_anterior) || ' para ' || public._rotulo_status(v_novo)
      else 'Pedido atualizado (' || public._rotulo_status(v_novo) || ')'
    end
    || case when v_tem_codigo and v_codigo is not null then '. Rastreio: ' || v_codigo else '' end
    || case when v_reposto then '. Estoque devolvido' else '' end
    || case when v_baixado then '. Estoque baixado' else '' end
    || case when v_nota is not null then '. Nota: ' || v_nota else '' end;

  insert into public.pedido_eventos (pedido_id, tipo, descricao, dados, autor)
  values (
    p_pedido_id, 'status', left(v_descricao, 5000),
    jsonb_strip_nulls(jsonb_build_object(
      'status_anterior', v_anterior,
      'status_novo',     v_novo,
      'nota',            v_nota,
      'codigo_rastreio', case when v_tem_codigo then v_codigo end,
      'url_rastreio',    case when v_tem_url then v_url end,
      'estoque_reposto', v_reposto,
      'estoque_baixado', v_baixado)),
    v_autor);

  if jsonb_array_length(v_faltas) > 0 then
    insert into public.pedido_eventos (pedido_id, tipo, descricao, dados, autor)
    values (
      p_pedido_id, 'alerta',
      'Estoque insuficiente para algum item. Confira o estoque antes de separar.',
      jsonb_build_object('itens', v_faltas),
      'sistema');
  end if;

  return jsonb_build_object(
    'pedido_id',       v_pedido.id,
    'numero',          v_pedido.numero,
    'status_anterior', v_anterior,
    'status_novo',     v_novo,
    'mudou',           v_novo <> v_anterior,
    'estoque_reposto', v_reposto,
    'estoque_baixado', v_baixado
  );
end;
$$;


-- -----------------------------------------------------------------------------
-- 6. Permissões de execução das funções
--    O Postgres libera EXECUTE para PUBLIC por padrão e o Supabase também para
--    anon/authenticated: por isso revogamos explicitamente.
-- -----------------------------------------------------------------------------

revoke all on function public.definir_atualizado_em() from public, anon, authenticated;
revoke all on function public.definir_autor_conteudo() from public, anon, authenticated;

revoke all on function public._formatar_reais(bigint) from public, anon, authenticated, service_role;
revoke all on function public._rotulo_status(text) from public, anon, authenticated, service_role;
revoke all on function public._baixar_estoque(uuid) from public, anon, authenticated, service_role;
revoke all on function public._repor_estoque(uuid) from public, anon, authenticated, service_role;

revoke all on function public.eh_admin() from public;
grant execute on function public.eh_admin() to anon, authenticated, service_role;

revoke all on function public.cotar_carrinho(jsonb) from public, anon, authenticated;
grant execute on function public.cotar_carrinho(jsonb) to service_role;

revoke all on function public.criar_pedido(jsonb) from public, anon, authenticated;
grant execute on function public.criar_pedido(jsonb) to service_role;

revoke all on function public.confirmar_pagamento(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.confirmar_pagamento(uuid, jsonb) to service_role;

revoke all on function public.alterar_status_pedido(uuid, text, text, text, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.alterar_status_pedido(uuid, text, text, text, boolean, jsonb) to service_role;


-- -----------------------------------------------------------------------------
-- 7. GRANTs de tabelas e sequências
--    Projetos Supabase novos não concedem mais acesso automático às tabelas
--    novas. Concedemos aqui; quem limita o acesso de fato é a RLS (seção 8).
-- -----------------------------------------------------------------------------

revoke all on table
  public.admins, public.conteudo_site, public.configuracoes, public.categorias, public.produtos,
  public.cupons, public.pedidos, public.pedido_itens, public.pedido_eventos
  from anon, authenticated;

grant select, insert, update, delete on table
  public.admins, public.conteudo_site, public.configuracoes, public.categorias, public.produtos,
  public.cupons, public.pedidos, public.pedido_itens, public.pedido_eventos
  to anon, authenticated, service_role;

grant usage, select on sequence
  public.pedidos_numero_seq, public.pedido_itens_id_seq, public.pedido_eventos_id_seq
  to anon, authenticated, service_role;


-- -----------------------------------------------------------------------------
-- 8. Segurança por linha (RLS)
--    anon/authenticated não-admin: leem só o que é público.
--    admin (eh_admin()): acesso completo pelo painel.
--    service_role ignora a RLS (usado apenas pelas funções da Vercel).
-- -----------------------------------------------------------------------------

alter table public.admins         enable row level security;
alter table public.conteudo_site  enable row level security;
alter table public.configuracoes  enable row level security;
alter table public.categorias     enable row level security;
alter table public.produtos       enable row level security;
alter table public.cupons         enable row level security;
alter table public.pedidos        enable row level security;
alter table public.pedido_itens   enable row level security;
alter table public.pedido_eventos enable row level security;

-- admins: só admin lê.
drop policy if exists admins_admin_select on public.admins;
create policy admins_admin_select on public.admins
  for select to authenticated
  using ((select public.eh_admin()));

-- conteudo_site: todos leem; admin escreve.
drop policy if exists conteudo_site_publico_select on public.conteudo_site;
create policy conteudo_site_publico_select on public.conteudo_site
  for select to anon, authenticated
  using (true);

drop policy if exists conteudo_site_admin_tudo on public.conteudo_site;
create policy conteudo_site_admin_tudo on public.conteudo_site
  for all to authenticated
  using ((select public.eh_admin()))
  with check ((select public.eh_admin()));

-- configuracoes: todos leem as públicas; admin faz tudo.
drop policy if exists configuracoes_publico_select on public.configuracoes;
create policy configuracoes_publico_select on public.configuracoes
  for select to anon, authenticated
  using (publico);

drop policy if exists configuracoes_admin_tudo on public.configuracoes;
create policy configuracoes_admin_tudo on public.configuracoes
  for all to authenticated
  using ((select public.eh_admin()))
  with check ((select public.eh_admin()));

-- categorias: todos leem as ativas; admin faz tudo.
drop policy if exists categorias_publico_select on public.categorias;
create policy categorias_publico_select on public.categorias
  for select to anon, authenticated
  using (ativo);

drop policy if exists categorias_admin_tudo on public.categorias;
create policy categorias_admin_tudo on public.categorias
  for all to authenticated
  using ((select public.eh_admin()))
  with check ((select public.eh_admin()));

-- produtos: todos leem os ativos; admin faz tudo.
drop policy if exists produtos_publico_select on public.produtos;
create policy produtos_publico_select on public.produtos
  for select to anon, authenticated
  using (ativo);

drop policy if exists produtos_admin_tudo on public.produtos;
create policy produtos_admin_tudo on public.produtos
  for all to authenticated
  using ((select public.eh_admin()))
  with check ((select public.eh_admin()));

-- cupons: só admin.
drop policy if exists cupons_admin_tudo on public.cupons;
create policy cupons_admin_tudo on public.cupons
  for all to authenticated
  using ((select public.eh_admin()))
  with check ((select public.eh_admin()));

-- pedidos e itens: admin lê, altera e apaga (criação só pelo servidor).
drop policy if exists pedidos_admin_select on public.pedidos;
create policy pedidos_admin_select on public.pedidos
  for select to authenticated
  using ((select public.eh_admin()));

drop policy if exists pedidos_admin_update on public.pedidos;
create policy pedidos_admin_update on public.pedidos
  for update to authenticated
  using ((select public.eh_admin()))
  with check ((select public.eh_admin()));

drop policy if exists pedidos_admin_delete on public.pedidos;
create policy pedidos_admin_delete on public.pedidos
  for delete to authenticated
  using ((select public.eh_admin()));

drop policy if exists pedido_itens_admin_select on public.pedido_itens;
create policy pedido_itens_admin_select on public.pedido_itens
  for select to authenticated
  using ((select public.eh_admin()));

drop policy if exists pedido_itens_admin_update on public.pedido_itens;
create policy pedido_itens_admin_update on public.pedido_itens
  for update to authenticated
  using ((select public.eh_admin()))
  with check ((select public.eh_admin()));

drop policy if exists pedido_itens_admin_delete on public.pedido_itens;
create policy pedido_itens_admin_delete on public.pedido_itens
  for delete to authenticated
  using ((select public.eh_admin()));

-- pedido_eventos: admin lê, altera, apaga e também insere (notas internas).
drop policy if exists pedido_eventos_admin_tudo on public.pedido_eventos;
create policy pedido_eventos_admin_tudo on public.pedido_eventos
  for all to authenticated
  using ((select public.eh_admin()))
  with check ((select public.eh_admin()));


-- -----------------------------------------------------------------------------
-- 9. Storage: bucket público "midia" (imagens e vídeos do site e da loja)
--    Leitura pela URL pública (não passa por policy). Envio, troca e exclusão
--    só para admins. Pastas: site/, produtos/, videos/.
-- -----------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('midia', 'midia', true, 52428800, array['image/*', 'video/mp4', 'video/webm'])
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists ama_midia_admin_select on storage.objects;
create policy ama_midia_admin_select on storage.objects
  for select to authenticated
  using (bucket_id = 'midia' and (select public.eh_admin()));

drop policy if exists ama_midia_admin_insert on storage.objects;
create policy ama_midia_admin_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'midia' and (select public.eh_admin()));

drop policy if exists ama_midia_admin_update on storage.objects;
create policy ama_midia_admin_update on storage.objects
  for update to authenticated
  using (bucket_id = 'midia' and (select public.eh_admin()))
  with check (bucket_id = 'midia' and (select public.eh_admin()));

drop policy if exists ama_midia_admin_delete on storage.objects;
create policy ama_midia_admin_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'midia' and (select public.eh_admin()));


-- -----------------------------------------------------------------------------
-- 10. Dados iniciais
--     Configurações padrão, categorias e os produtos que já aparecem na home
--     (preço 0 e inativos: a AMA só ajusta preço, estoque e ativa).
-- -----------------------------------------------------------------------------

insert into public.configuracoes (chave, publico, valor) values
(
  'loja', true,
  '{
    "titulo": "Loja AMA",
    "subtitulo": "Biojoias e cosméticos feitos à mão por mulheres da Amazônia. Cada compra fortalece os projetos da AMA.",
    "whatsapp": "5591981056049",
    "instagram": "oscdemulheres",
    "email_contato": "",
    "aviso_topo": "",
    "frete_gratis_acima_centavos": null
  }'::jsonb
),
(
  'frete', false,
  '{
    "origem": {
      "cep": "",
      "nome": "AMA - Associação de Mulheres na Amazônia",
      "telefone": "",
      "email": "",
      "documento": "",
      "endereco": "",
      "numero": "",
      "complemento": "",
      "bairro": "",
      "cidade": "Ananindeua",
      "uf": "PA"
    },
    "retirada": {
      "ativa": true,
      "nome": "Retirar na sede da AMA",
      "endereco": "Conjunto Uirapuru, Quadra 28, Casa 02, Icuí, Ananindeua - PA",
      "prazo_texto": "Combine a retirada pelo WhatsApp"
    },
    "fixo": {
      "ativo": false,
      "opcoes": [
        { "id": "fixo-1", "nome": "Entrega local", "preco_centavos": 1500, "prazo_dias": 3, "ufs": ["PA"] }
      ]
    },
    "melhor_envio": {
      "ativo": true,
      "servicos": [1, 2],
      "seguro": true,
      "prazo_extra_dias": 2,
      "taxa_extra_centavos": 0
    },
    "embalagem_padrao": { "peso_gramas": 300, "altura_cm": 4, "largura_cm": 12, "comprimento_cm": 16 }
  }'::jsonb
),
(
  'checkout', false,
  '{ "parcelas_max": 6, "aceitar_boleto": true, "expiracao_horas": 72 }'::jsonb
),
(
  'notificacoes', false,
  '{ "email_admin": "" }'::jsonb
)
on conflict (chave) do nothing;

insert into public.categorias (nome, slug, descricao, ordem) values
  ('Biojoias',   'biojoias',   'Colares e brincos feitos à mão com sementes, madeira e elementos da Amazônia.', 1),
  ('Cosméticos', 'cosmeticos', 'Cosméticos artesanais com essências da Amazônia.', 2)
on conflict (slug) do nothing;

insert into public.produtos (nome, slug, descricao, preco_centavos, ativo, categoria_id, imagens, ordem)
select v.nome, v.slug, 'Em produção.', 0, false,
       (select c.id from public.categorias c where c.slug = v.categoria),
       jsonb_build_array(jsonb_build_object('src', v.imagem, 'alt', v.alt)),
       v.ordem
  from (values
    ('Body Splash 200mL', 'body-splash-200ml', 'cosmeticos', '/img/ama-bioessencia-body-splash.jpg',
     'AMA Bioessência Body Splash 200mL', 1),
    ('Colar 01', 'colar-01', 'biojoias', '/img/colar-atelie-verde.jpg',
     'Colar de sementes verdes com pingentes de madeira em formato de folha', 2),
    ('Colar 02', 'colar-02', 'biojoias', '/img/colar-floral-rosa-madeira.jpg',
     'Colar floral com contas brancas, rosa e detalhes de madeira', 3),
    ('Colar 03', 'colar-03', 'biojoias', '/img/retrato-colar-preto-branco.jpg',
     'Mulher usando colar artesanal preto e branco sobre blusa estampada', 4),
    ('Colar 04', 'colar-04', 'biojoias', '/img/brinco-flor-madeira-close.jpg',
     'Close de brinco floral de madeira entalhada com contas claras', 5),
    ('Colar 05', 'colar-05', 'biojoias', '/img/brinco-folha-madeira-orelha.jpg',
     'Brinco de folhas de madeira com miçangas creme, em uso', 6),
    ('Colar 06', 'colar-06', 'biojoias', '/img/brinco-gota-verde.jpg',
     'Brinco em formato de gota em resina verde, estilo boho', 7)
  ) as v (nome, slug, categoria, imagem, alt, ordem)
on conflict (slug) do nothing;
