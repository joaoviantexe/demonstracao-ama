-- Apaga os pedidos de EXEMPLO (e-mail @exemplo.com.br e observação "[Exemplo]…") e devolve ao estoque
-- os produtos dos que ainda estavam descontados. Rode no SQL Editor do Supabase.

do $$
declare
  r record;
  v_total int := 0;
begin
  for r in
    select id, estoque_baixado from public.pedidos
     where cliente_email like '%@exemplo.com.br' and observacoes like '[Exemplo]%'
  loop
    if r.estoque_baixado then
      perform public._repor_estoque(r.id);
    end if;
    delete from public.pedidos where id = r.id;
    v_total := v_total + 1;
  end loop;
  raise notice 'Pedidos de exemplo apagados: %', v_total;
end;
$$;
