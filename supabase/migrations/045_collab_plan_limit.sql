-- =====================================================================
-- 045: лимит соавторов по тарифу владельца.
--
-- Раньше album_collaborator_add не смотрел на тариф вовсе: соавторов можно
-- было добавить сколько угодно и на Free, и на Pro. Теперь потолок задаёт
-- тариф владельца альбома: Free — 1 соавтор в альбоме, Pro — 10.
--
-- Считаются только соавторы, добавленные вручную (joined_via is null):
-- гости событийного альбома входят по ссылке/QR — это отдельный платный
-- продукт (026), и его этот лимит не касается. Уже добавленные сверх
-- потолка остаются: правило действует только на новые добавления.
--
-- Ошибка несёт hint 'collab_limit:<план>' — новый фронт показывает по нему
-- локализованный текст, а старый клиент, печатающий message как есть,
-- получает человеческую фразу, как у остальных ошибок этой функции.
-- =====================================================================

create or replace function public.album_collaborator_add(p_album uuid, p_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); target uuid; owner uuid;
  cap int; taken int;
begin
  if me is null then raise exception 'auth required'; end if;
  -- for update: параллельные добавления в один альбом выстраиваются в
  -- очередь, иначе два одновременных вызова пролезли бы под общий потолок.
  select author_id into owner from albums where id = p_album for update;
  if owner is null then raise exception 'Альбом не найден'; end if;
  if owner <> me then raise exception 'Соавторов добавляет только владелец альбома'; end if;

  select id into target from profiles where username = lower(p_username);
  if target is null then raise exception 'Пользователь не найден'; end if;
  if target = me then raise exception 'Вы и так владелец'; end if;
  if not are_friends(me, target) then raise exception 'Соавтором можно сделать только друга'; end if;

  cap := case when (select plan from profiles where id = me) = 'pro' then 10 else 1 end;
  -- target исключён из подсчёта: повторное добавление уже сидящего соавтора
  -- остаётся идемпотентным (on conflict do nothing), а не бьётся о лимит.
  select count(*) into taken from album_collaborators
   where album_id = p_album and joined_via is null and user_id <> target;
  if taken >= cap then
    raise exception 'На бесплатном тарифе в альбоме один соавтор, на Pro — до десяти'
      using hint = 'collab_limit:' || case when cap > 1 then 'pro' else 'free' end;
  end if;

  insert into album_collaborators (album_id, user_id, added_by)
  values (p_album, target, me) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;
