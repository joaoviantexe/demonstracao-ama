-- Pedidos de EXEMPLO para simular e visualizar o painel (Pedidos, filtros, envio, rastreio).
-- Rode no SQL Editor do Supabase (ou localmente). Não depende de nenhuma integração (Mercado Pago, Melhor Envio).
-- Os pedidos usam e-mails @exemplo.com.br e a observação começa com "[Exemplo]".
-- Eles descontam do estoque dos produtos como pedidos reais; para apagar tudo e devolver o estoque,
-- rode supabase/exemplos/remover-pedidos-exemplo.sql.
-- Pode rodar de novo: se já existirem pedidos de exemplo, nada é criado.

do $$
declare
  v_ids   uuid[];
  v_end   jsonb := '{"cep":"66010000","logradouro":"Avenida Presidente Vargas","numero":"123","complemento":"Apto 401","bairro":"Campina","cidade":"Belém","uf":"PA"}';
  v_pac   jsonb := '{"tipo":"melhor_envio","id":"me-1","nome":"PAC","empresa":"Correios","prazo_dias":7,"preco_centavos":2350,"servico_id":1}';
  v_sedex jsonb := '{"tipo":"melhor_envio","id":"me-2","nome":"SEDEX","empresa":"Correios","prazo_dias":3,"preco_centavos":3890,"servico_id":2}';
  v_p     jsonb;
  v_ped   jsonb;
  v_id    uuid;
  v_total bigint;
  n       int := 0;
  r       record;
begin
  if exists (select 1 from public.pedidos where cliente_email like '%@exemplo.com.br' and observacoes like '[Exemplo]%') then
    raise notice 'Já existem pedidos de exemplo: nada a fazer.';
    return;
  end if;

  select array_agg(id order by ordem, nome) into v_ids
    from (select id, ordem, nome from public.produtos where ativo and preco_centavos > 0 and estoque >= 3
           order by ordem, nome limit 4) t;
  if v_ids is null or array_length(v_ids, 1) < 2 then
    raise exception 'Cadastre ao menos 2 produtos à venda, com preço e estoque, antes de criar os pedidos de exemplo.';
  end if;

  -- Cada linha: cliente, telefone, cpf, entrega, itens (índices em v_ids, quantidade), situação final
  for r in
    select * from (values
      (1, 'Maria Souza',       'maria.souza',     '91981056049', '52998224725', v_pac,   1, 1, 1, 0, 'aguardando'),
      (2, 'Joana Pereira',     'joana.pereira',   '91988887777', '11144477735', v_sedex, 2, 1, 2, 0, 'analise'),
      (3, 'Ana Beatriz Lima',  'ana.lima',        '91987654321', '39053344705', v_pac,   1, 2, 0, 0, 'pago'),
      (4, 'Luciana Ferreira',  'luciana.ferreira','91982345678', '52998224725', v_sedex, 2, 1, 1, 1, 'pago'),
      (5, 'Carla Nascimento',  'carla.nascimento','91983456789', '11144477735', v_pac,   1, 1, 2, 1, 'separacao'),
      (6, 'Patrícia Gomes',    'patricia.gomes',  '91984567890', '39053344705', v_pac,   2, 2, 0, 0, 'enviado'),
      (7, 'Renata Oliveira',   'renata.oliveira', '91985678901', '52998224725', v_sedex, 1, 1, 0, 0, 'entregue'),
      (8, 'Fernanda Costa',    'fernanda.costa',  '91986789012', '11144477735', v_pac,   2, 1, 0, 0, 'cancelado')
    ) as t (n, nome, email, tel, cpf, entrega, i1, q1, i2, q2, fim)
  loop
    n := r.n;
    v_p := jsonb_build_object(
      'itens', jsonb_build_array(jsonb_build_object('produto_id', v_ids[r.i1], 'quantidade', r.q1))
               || case when r.q2 > 0 then jsonb_build_array(jsonb_build_object('produto_id', v_ids[r.i2], 'quantidade', r.q2)) else '[]'::jsonb end,
      'cliente', jsonb_build_object('nome', r.nome, 'email', r.email || '@exemplo.com.br', 'telefone', r.tel, 'cpf', r.cpf),
      'endereco', v_end,
      'entrega', r.entrega,
      'observacoes', '[Exemplo] Pedido de teste para visualizar o painel.'
    );
    v_ped := public.criar_pedido(v_p);
    v_id := (v_ped ->> 'id')::uuid;
    select total_centavos into v_total from public.pedidos where id = v_id;

    if r.fim in ('pago', 'separacao', 'enviado', 'entregue', 'cancelado') then
      perform public.confirmar_pagamento(v_id, jsonb_build_object(
        'id', (900000000 + n)::text, 'status', 'approved', 'status_detail', 'accredited',
        'transaction_amount', v_total / 100.0,
        'payment_type_id', case when n % 2 = 0 then 'bank_transfer' else 'credit_card' end,
        'payment_method_id', case when n % 2 = 0 then 'pix' else 'visa' end,
        'date_approved', now()));
    elsif r.fim = 'analise' then
      perform public.confirmar_pagamento(v_id, jsonb_build_object(
        'id', (900000000 + n)::text, 'status', 'in_process', 'status_detail', 'pending_contingency',
        'transaction_amount', v_total / 100.0, 'payment_type_id', 'credit_card', 'payment_method_id', 'master'));
    end if;

    if r.fim = 'separacao' then
      perform public.alterar_status_pedido(v_id, 'em_separacao', 'exemplo', 'Separando os produtos.');
    elsif r.fim = 'enviado' then
      perform public.alterar_status_pedido(v_id, 'enviado', 'exemplo', null, false,
        jsonb_build_object('codigo_rastreio', 'AA123456789BR', 'url_rastreio', 'https://rastreamento.correios.com.br/app/index.php'));
    elsif r.fim = 'entregue' then
      perform public.alterar_status_pedido(v_id, 'enviado', 'exemplo', null, false,
        jsonb_build_object('codigo_rastreio', 'BB987654321BR', 'url_rastreio', 'https://rastreamento.correios.com.br/app/index.php'));
      perform public.alterar_status_pedido(v_id, 'entregue', 'exemplo', 'Entregue à cliente.');
    elsif r.fim = 'cancelado' then
      perform public.alterar_status_pedido(v_id, 'cancelado', 'exemplo', 'A cliente desistiu da compra.', true);
    end if;
  end loop;
  raise notice 'Pedidos de exemplo criados: %', n;
end;
$$;
