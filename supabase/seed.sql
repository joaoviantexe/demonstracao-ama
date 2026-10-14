-- =============================================================================
-- Dados de exemplo — SOMENTE para desenvolvimento local.
-- Aplicado pelo "supabase db reset" depois das migrações. Não rode em produção.
--
-- Admin de desenvolvimento: admin@ama.local / admin123456
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Usuário administrador (auth.users + auth.identities + public.admins)
--    As colunas de token precisam ser '' (e não NULL) para o Auth aceitar o login.
-- -----------------------------------------------------------------------------

do $$
declare
  v_id    uuid := 'a0000000-0000-4000-8000-000000000001';
  v_email text := 'admin@ama.local';
begin
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token,
    is_sso_user, is_anonymous
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
    extensions.crypt('admin123456', extensions.gen_salt('bf')), now(),
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    '{"nome": "Administração AMA"}'::jsonb,
    now(), now(),
    '', '', '', '',
    '', '', '', '',
    false, false
  )
  on conflict (id) do nothing;

  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (
    v_id::text, v_id,
    jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true, 'phone_verified', false),
    'email', now(), now(), now()
  )
  on conflict (provider_id, provider) do nothing;

  insert into public.admins (user_id, email)
  values (v_id, v_email)
  on conflict (user_id) do nothing;
end;
$$;


-- -----------------------------------------------------------------------------
-- 2. Produtos ativos com preços, estoque, peso e dimensões de exemplo
-- -----------------------------------------------------------------------------

update public.produtos p
   set ativo = true,
       preco_centavos = v.preco,
       preco_promocional_centavos = v.promocional,
       estoque = 5,
       destaque = v.destaque,
       descricao = v.descricao,
       peso_gramas = v.peso,
       altura_cm = v.altura,
       largura_cm = v.largura,
       comprimento_cm = v.comprimento,
       sku = v.sku
  from (values
    ('body-splash-200ml', 5990, null::int, true,
     'Body splash AMA Bioessência com fragrância inspirada na flora amazônica. Frasco de 200 mL.',
     320, 6.0, 8.0, 19.0, 'AMA-BS-200'),
    ('colar-01', 8990, null, true,
     'Colar artesanal de sementes verdes com pingentes de madeira em formato de folha.',
     120, 4.0, 12.0, 16.0, 'AMA-CL-01'),
    ('colar-02', 8990, null, false,
     'Colar floral com contas brancas, rosa e detalhes de madeira, feito à mão.',
     120, 4.0, 12.0, 16.0, 'AMA-CL-02'),
    ('colar-03', 8990, null, false,
     'Colar artesanal em preto e branco, peça única do ateliê da AMA.',
     120, 4.0, 12.0, 16.0, 'AMA-CL-03'),
    ('colar-04', 8990, null, false,
     'Peça floral de madeira entalhada com contas claras.',
     100, 4.0, 12.0, 16.0, 'AMA-CL-04'),
    ('colar-05', 8990, null, false,
     'Peça com folhas de madeira e miçangas creme.',
     100, 4.0, 12.0, 16.0, 'AMA-CL-05'),
    -- Um produto em promoção, para ver o selo na loja.
    ('colar-06', 8990, 7490, false,
     'Peça em formato de gota em resina verde, estilo boho.',
     100, 4.0, 12.0, 16.0, 'AMA-CL-06')
  ) as v (slug, preco, promocional, destaque, descricao, peso, altura, largura, comprimento, sku)
 where p.slug = v.slug;


-- -----------------------------------------------------------------------------
-- 3. Cupons de exemplo
-- -----------------------------------------------------------------------------

insert into public.cupons (codigo, descricao, tipo, valor, minimo_centavos) values
  ('AMA10',       '10% de desconto em toda a loja', 'percentual',   10, 0),
  ('FRETEGRATIS', 'Frete grátis',                   'frete_gratis',  0, 0)
on conflict (codigo) do nothing;


-- -----------------------------------------------------------------------------
-- 4. Origem do frete (dados fictícios; CEP do Conjunto Uirapuru, Icuí-Guajará)
-- -----------------------------------------------------------------------------

update public.configuracoes
   set valor = jsonb_set(valor, '{origem}', coalesce(valor -> 'origem', '{}'::jsonb) || '{
     "cep": "67125866",
     "nome": "AMA - Associação de Mulheres na Amazônia",
     "telefone": "91999990000",
     "email": "loja@ama.local",
     "documento": "11222333000181",
     "endereco": "Conjunto Uirapuru, Quadra 28",
     "numero": "02",
     "complemento": "Casa 02",
     "bairro": "Icuí-Guajará",
     "cidade": "Ananindeua",
     "uf": "PA"
   }'::jsonb)
 where chave = 'frete';
