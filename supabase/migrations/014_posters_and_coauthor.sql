-- 014: состояние постера видео и соавтор поста.

alter table media add column if not exists thumb_attempts int not null default 0;

/** Свои видео без постера — клиент догенерирует их и пришлёт через set_media_poster. */
create or replace function public.my_videos_without_poster(p_limit int default 20)
returns table (id uuid, storage_path text)
language sql stable security definer set search_path = public as $$
  select m.id, m.storage_path from media m
  where m.owner_id = auth.uid() and m.kind = 'video'
    and m.thumb_path is null and m.thumb_attempts < 3
  order by m.created_at desc
  limit greatest(1, least(p_limit, 50));
$$;

create or replace function public.set_media_poster(p_media uuid, p_path text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from media where id = p_media and owner_id = auth.uid()) then
    raise exception 'Недостаточно прав';
  end if;
  update media set thumb_path = p_path, thumb_attempts = thumb_attempts + 1 where id = p_media;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.mark_poster_failed(p_media uuid)
returns void language sql security definer set search_path = public as $$
  update media set thumb_attempts = thumb_attempts + 1
  where id = p_media and owner_id = auth.uid();
$$;

-- ---------------------------------------------------------------- соавтор поста

alter table posts add column if not exists coauthor_id uuid references profiles(id) on delete set null;
alter table posts add column if not exists album_id    uuid references albums(id) on delete set null;
create index if not exists posts_coauthor_idx on posts(coauthor_id) where coauthor_id is not null;

/** Может ли человек редактировать пост (автор или соавтор). Удаляет только автор. */
create or replace function public.can_edit_post(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from posts
                 where id = p_id and (author_id = auth.uid() or coauthor_id = auth.uid()));
$$;

/** Соавтором поста можно назначить только друга. */
create or replace function public.post_set_coauthor(p_post uuid, p_username text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); target uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  if not exists (select 1 from posts where id = p_post and author_id = me) then
    raise exception 'Соавтора назначает только автор поста';
  end if;
  if p_username is null then
    update posts set coauthor_id = null where id = p_post;
    return jsonb_build_object('coauthor', null);
  end if;
  select id into target from profiles where username = lower(p_username);
  if target is null then raise exception 'Пользователь не найден'; end if;
  if target = me then raise exception 'Вы и так автор'; end if;
  if not are_friends(me, target) then raise exception 'Соавтором можно сделать только друга'; end if;
  update posts set coauthor_id = target where id = p_post;
  return jsonb_build_object('coauthor', p_username);
end $$;
