-- Фикс прав на функции.
--
-- Проблема: `revoke execute ... from public` ничего не давал, потому что Supabase
-- раздаёт EXECUTE напрямую ролям anon и authenticated (через default privileges),
-- а отзыв у PUBLIC прямые гранты ролям не трогает. В итоге аноним мог вызвать
-- вообще любую функцию, включая friend_request и album_collaborator_add.
--
-- Утечки не было: каждая такая функция первым делом проверяет auth.uid() и падает,
-- а выборки «моё» фильтруются по auth.uid() и для анонима пусты. Но полагаться
-- на один рубеж не годится — возвращаем deny by default.

revoke execute on all functions in schema public from anon, authenticated, public;

-- Чтобы будущие функции не открывались сами собой.
alter default privileges in schema public revoke execute on functions from anon, authenticated;

-- Нужны РОВНО эти. can_view_* и owns_* вызываются из RLS-политик под ролью
-- вызывающего, поэтому без них чтение сломается даже у анонима.
grant execute on function
  public.can_view_album(uuid,uuid),
  public.can_view_post(uuid,uuid),
  public.can_view_subject(subject_kind,uuid,uuid),
  public.can_view_media(uuid,uuid),
  public.can_view_storage_media(text),
  public.are_friends(uuid,uuid),
  public.owns_album(uuid),
  public.owns_subject(subject_kind,uuid),
  public.can_edit_album(uuid),
  public.is_album_owner(uuid),
  public.feed_albums(text,text,int,int),
  public.feed_posts(int,int),
  public.get_album(uuid),
  public.get_post(uuid),
  public.get_profile(text),
  public.log_album_view(uuid),
  public.search_all(text)
to anon, authenticated;

grant execute on function
  public.ensure_profile(),
  public.friend_request(text),
  public.friend_respond(text,boolean),
  public.friend_remove(text),
  public.my_friends(),
  public.my_shared_albums(),
  public.my_media(text,int,int),
  public.album_collaborator_add(uuid,text),
  public.album_collaborator_remove(uuid,text)
to authenticated;
