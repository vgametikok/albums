-- 016: фикс генерации токена приглашения.
--
-- gen_random_bytes живёт в схеме extensions (pgcrypto), а у функции задан
-- search_path = public — вызов падал с 42883. Менять search_path не хочется:
-- он тут стоит специально, чтобы definer-функцию нельзя было обмануть подменой
-- схемы. Поэтому берём два gen_random_uuid() — они встроены в Postgres,
-- дают вместе ~244 бита случайности, чего для токена ссылки более чем достаточно.

create or replace function public.album_invite_create(
  p_album uuid, p_days int default 30, p_max_uses int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); tok text; owner uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select author_id into owner from albums where id = p_album;
  if owner is null then raise exception 'Альбом не найден'; end if;
  if owner <> me then raise exception 'Ссылку создаёт только владелец альбома'; end if;

  tok := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into album_invites (album_id, token_hash, created_by, expires_at, max_uses)
  values (p_album, encode(sha256(tok::bytea), 'hex'), me,
          case when p_days is null then null else now() + make_interval(days => greatest(1, p_days)) end,
          p_max_uses);
  return jsonb_build_object('token', tok);
end $$;

grant execute on function public.album_invite_create(uuid,int,int) to authenticated;
