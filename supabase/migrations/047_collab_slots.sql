-- =====================================================================
-- 047: сколько соавторов ещё можно добавить.
--
-- Редактор показывает владельцу «осталось N из M». Считать это на клиенте
-- нельзя: правило (гости события не в счёт, потолок по тарифу владельца)
-- живёт в album_collaborator_add из миграции 045, и вторая копия правила в
-- JS разошлась бы с первой при ближайшей смене тарифов.
--
-- Отдаём только владельцу альбома: соавторам и посторонним знать чужой
-- тариф незачем, а именно из потолка он и читается.
--
-- p_album = null — это ещё не сохранённый черновик в редакторе: строки
-- альбома нет, но потолок тарифа уже надо показать. Занятых мест в этом
-- случае ноль по определению.
-- =====================================================================

create or replace function public.album_collab_slots(p_album uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); owner uuid; cap int; taken int := 0;
begin
  if me is null then return null; end if;
  if p_album is not null then
    select author_id into owner from albums where id = p_album;
    if owner is null or owner <> me then return null; end if;
  end if;

  -- Условия слово в слово повторяют album_collaborator_add (045).
  cap := case when (select plan from profiles where id = me) = 'pro' then 10 else 1 end;
  if p_album is not null then
    select count(*) into taken from album_collaborators
     where album_id = p_album and joined_via is null;
  end if;

  return jsonb_build_object(
    'used', taken,
    'max',  cap,
    'left', greatest(0, cap - taken),
    'plan', case when cap > 1 then 'pro' else 'free' end);
end $$;

revoke execute on function public.album_collab_slots(uuid) from public, anon;
grant  execute on function public.album_collab_slots(uuid) to authenticated;
