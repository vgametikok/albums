-- 010: событийные альбомы — ссылка-приглашение и роль «контрибьютор».
--
-- Сценарий: владелец кидает одну ссылку в общий чат, гости входят через Google
-- и дозаливают свои фото. Гость НЕ становится соавтором: он видит альбом, может
-- добавлять своё и удалять только своё, но не правит альбом и не трогает чужое.
--
-- Политики album_media/album_chapters под роль контрибьютора собираются в 015 —
-- здесь только новые объекты и предикаты (см. PLAN.md).

do $$ begin
  create type collab_role as enum ('editor','contributor');
exception when duplicate_object then null; end $$;

alter table album_collaborators add column if not exists role collab_role not null default 'editor';
alter table album_collaborators add column if not exists joined_via uuid;   -- ссылка, по которой вошёл

-- Приглашения. В базе лежит только хэш токена: утечка дампа не даёт рабочих ссылок.
create table if not exists album_invites (
  id         uuid primary key default gen_random_uuid(),
  album_id   uuid not null references albums(id) on delete cascade,
  token_hash text not null unique,
  created_by uuid not null references profiles(id) on delete cascade,
  role       collab_role not null default 'contributor',
  expires_at timestamptz,
  max_uses   int,
  uses       int not null default 0,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists album_invites_album_idx on album_invites(album_id, created_at desc);

alter table album_invites enable row level security;
drop policy if exists invites_read on album_invites;
create policy invites_read on album_invites for select using (is_album_owner(album_id));
-- запись только через RPC

/** Сколько файлов участник уже залил в альбом (для квоты). */
create or replace function public.contrib_upload_count(p_album uuid, p_user uuid)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int from album_media am join media m on m.id = am.media_id
  where am.album_id = p_album and m.owner_id = p_user;
$$;

/** Может ли человек ДОЗАЛИВАТЬ в альбом (владелец, редактор или контрибьютор). */
create or replace function public.can_contribute_album(a_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from albums where id = a_id and author_id = auth.uid())
      or exists (select 1 from album_collaborators where album_id = a_id and user_id = auth.uid());
$$;

/** Владелец или редактор — правка самого альбома. Контрибьютор сюда НЕ попадает. */
create or replace function public.can_edit_album(a_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from albums where id = a_id and author_id = auth.uid())
      or exists (select 1 from album_collaborators
                 where album_id = a_id and user_id = auth.uid() and role = 'editor');
$$;

-- ---------------------------------------------------------------- RPC

create or replace function public.album_invite_create(
  p_album uuid, p_days int default 30, p_max_uses int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); tok text; owner uuid;
begin
  if me is null then raise exception 'auth required'; end if;
  select author_id into owner from albums where id = p_album;
  if owner is null then raise exception 'Альбом не найден'; end if;
  if owner <> me then raise exception 'Ссылку создаёт только владелец альбома'; end if;

  tok := encode(gen_random_bytes(24), 'hex');
  insert into album_invites (album_id, token_hash, created_by, expires_at, max_uses)
  values (p_album, encode(sha256(tok::bytea), 'hex'), me,
          case when p_days is null then null else now() + make_interval(days => greatest(1, p_days)) end,
          p_max_uses);
  return jsonb_build_object('token', tok);      -- показывается ОДИН раз
end $$;

create or replace function public.album_invite_revoke(p_invite uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'auth required'; end if;
  update album_invites i set revoked_at = now()
   from albums a where i.id = p_invite and a.id = i.album_id and a.author_id = me;
  if not found then raise exception 'Недостаточно прав'; end if;
  return jsonb_build_object('ok', true);
end $$;

/** Что показать гостю на странице дозагрузки ДО входа: только обложка и название. */
create or replace function public.album_invite_peek(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare inv album_invites; a albums; p profiles;
begin
  select * into inv from album_invites where token_hash = encode(sha256(p_token::bytea), 'hex');
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if inv.revoked_at is not null then return jsonb_build_object('ok', false, 'reason', 'revoked'); end if;
  if inv.expires_at is not null and inv.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired'); end if;
  if inv.max_uses is not null and inv.uses >= inv.max_uses then
    return jsonb_build_object('ok', false, 'reason', 'used_up'); end if;

  select * into a from albums where id = inv.album_id;
  select * into p from profiles where id = a.author_id;
  return jsonb_build_object('ok', true, 'album_id', a.id, 'title', a.title,
    'owner_name', p.display_name, 'owner_username', p.username,
    'cover_path', (select coalesce(m.thumb_path, m.storage_path) from media m where m.id = a.cover_media_id),
    'already_in', exists (select 1 from album_collaborators c
                          where c.album_id = a.id and c.user_id = auth.uid()));
end $$;

create or replace function public.album_invite_accept(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); inv album_invites; owner uuid;
begin
  if me is null then raise exception 'Войдите, чтобы присоединиться'; end if;
  select * into inv from album_invites where token_hash = encode(sha256(p_token::bytea), 'hex');
  if not found then raise exception 'Ссылка недействительна'; end if;
  if inv.revoked_at is not null then raise exception 'Ссылка отозвана'; end if;
  if inv.expires_at is not null and inv.expires_at < now() then raise exception 'Срок ссылки истёк'; end if;
  if inv.max_uses is not null and inv.uses >= inv.max_uses then raise exception 'Лимит переходов исчерпан'; end if;

  select author_id into owner from albums where id = inv.album_id;
  if owner = me then return jsonb_build_object('album_id', inv.album_id, 'role', 'owner'); end if;
  if is_blocked_between(owner, me) then raise exception 'Недоступно'; end if;

  insert into album_collaborators (album_id, user_id, added_by, role, joined_via)
  values (inv.album_id, me, inv.created_by, inv.role, inv.id)
  on conflict (album_id, user_id) do nothing;

  if found then
    update album_invites set uses = uses + 1 where id = inv.id;
  end if;
  return jsonb_build_object('album_id', inv.album_id, 'role', inv.role);
end $$;

/** Список участников события для владельца: кто сколько залил. */
create or replace function public.album_contributors(p_album uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select case when not can_view_album(p_album, auth.uid()) then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object(
      'username', p.username, 'name', p.display_name, 'avatar', p.avatar_url,
      'role', c.role, 'uploaded', contrib_upload_count(p_album, c.user_id)))
    from album_collaborators c join profiles p on p.id = c.user_id
    where c.album_id = p_album), '[]'::jsonb) end;
$$;

grant select on album_invites to authenticated;
