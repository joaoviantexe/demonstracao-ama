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
-- 2. Promoção, destaques e SKU de exemplo para a coleção Ama Bioessência
--    Nome, descrição, foto, peso, medidas, preços e estoque de teste já vêm da
--    migração (as biojoias também: R$ 89,90 e 10 unidades).
-- -----------------------------------------------------------------------------

update public.produtos p
   set preco_centavos = v.preco,
       preco_promocional_centavos = v.promocional,
       estoque = 10,
       destaque = v.destaque,
       sku = v.sku
  from (values
    ('body-splash-raiz',                            5990, null::int, true,  'AMA-BS-RAIZ'),
    ('body-splash-bruma',                           5990, null,      false, 'AMA-BS-BRUMA'),
    ('body-splash-orvalho',                         5990, null,      false, 'AMA-BS-ORVALHO'),
    ('body-splash-ambar',                           5990, null,      false, 'AMA-BS-AMBAR'),
    ('creme-hidratante-ameixa-negra',               6990, null,      false, 'AMA-CH-AMEIXA'),
    -- Um produto em promoção, para ver o selo na loja.
    ('creme-hidratante-cupuacu',                    6990, 5990,      true,  'AMA-CH-CUPUACU'),
    ('creme-hidratante-cumaru',                     6990, null,      false, 'AMA-CH-CUMARU'),
    ('creme-hidratante-capim-limao',                6990, null,      false, 'AMA-CH-CAPIM'),
    ('sabonete-liquido-intimo-barbatimao-andiroba', 4990, null,      false, 'AMA-SLI-BARBATIMAO'),
    ('sabonete-solido-manteiga-cupuacu',            2490, null,      true,  'AMA-SS-CUPUACU')
  ) as v (slug, preco, promocional, destaque, sku)
 where p.slug = v.slug;


-- -----------------------------------------------------------------------------
-- 3. Origem do frete (dados fictícios; CEP do Conjunto Uirapuru, Icuí-Guajará)
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
