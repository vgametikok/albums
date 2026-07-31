-- =====================================================================
-- 036: данные для OG-превью (карточка ссылки в мессенджерах).
--
-- Сайт статический на GitHub Pages, содержимое рисует JS, а краулеры
-- (Telegram/WhatsApp/VK/Facebook/X) JS не исполняют — расшаренная ссылка на
-- альбом показывалась голой. Превью отдаёт edge-функция `og`, а безопасные
-- данные карточки — эта RPC.
--
-- ПРИВАТНОСТЬ: карточка отдаётся ТОЛЬКО для публичного контента. Проверка —
-- can_view_album/can_view_post с viewer=null (аноним): она пропускает лишь
-- public + одобренное + не скрытое + автор не забанен. Приватный альбом →
-- null → функция покажет обезличенную карточку Albums, не раскрывая ни
-- названия, ни обложки.
-- =====================================================================

create or replace function public.og_card(p_type text, p_key text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a albums; po posts; pr profiles; kid uuid;
begin
  if p_type = 'album' then
    begin kid := p_key::uuid; exception when others then return null; end;
    if not can_view_album(kid, null) then return null; end if;
    select * into a from albums where id = kid;
    select * into pr from profiles where id = a.author_id;
    return jsonb_build_object(
      'type', 'album', 'id', a.id, 'title', a.title,
      'desc', nullif(btrim(coalesce(a.description, '')), ''),
      'author', coalesce(nullif(pr.display_name, ''), pr.username),
      'author_username', pr.username,
      'photos', a.photos_count, 'videos', a.videos_count, 'audio', a.audio_count,
      'cover', (select coalesce(m.thumb_path, m.storage_path)
                from media m where m.id = a.cover_media_id));

  elsif p_type = 'post' then
    begin kid := p_key::uuid; exception when others then return null; end;
    if not can_view_post(kid, null) then return null; end if;
    select * into po from posts where id = kid;
    select * into pr from profiles where id = po.author_id;
    return jsonb_build_object(
      'type', 'post', 'id', po.id,
      'title', coalesce(nullif(pr.display_name, ''), pr.username) || ' · Albums',
      'desc', nullif(btrim(coalesce(po.caption, '')), ''),
      'author', coalesce(nullif(pr.display_name, ''), pr.username),
      'author_username', pr.username,
      'cover', (select coalesce(m.thumb_path, m.storage_path)
                from post_media pm join media m on m.id = pm.media_id
                where pm.post_id = po.id order by pm.position limit 1));

  elsif p_type = 'user' then
    select * into pr from profiles where username = lower(p_key);
    if pr.id is null or pr.banned_at is not null or pr.deleted_at is not null then return null; end if;
    return jsonb_build_object(
      'type', 'user', 'username', pr.username,
      'title', coalesce(nullif(pr.display_name, ''), pr.username),
      'desc', nullif(btrim(coalesce(pr.bio, '')), ''),
      'avatar', pr.avatar_url,
      'albums', (select count(*) from albums al
                 where al.author_id = pr.id and can_view_album(al.id, null)));
  end if;
  return null;
end $$;

revoke execute on function public.og_card(text, text) from public;
grant execute on function public.og_card(text, text) to anon, authenticated;
