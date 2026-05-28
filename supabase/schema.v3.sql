-- Tania v3 — chat upgrade migration on top of schema.v2.sql
--
-- Run this in the Supabase SQL editor on a project that already has v1's
-- schema.sql and v2's schema.v2.sql applied. Idempotent: every CREATE uses
-- `if not exists`, every policy is dropped + recreated, every function uses
-- `or replace` (signatures that changed shape are dropped first).
--
-- Features added by this migration:
--   1.  Freeform chat messages         → `public.messages` (text/link/image/document)
--   1b. Read receipts                  → `public.message_recipients`
--   2.  Per-conversation message RPCs  → `send_message`, `get_conversation_messages`
--   3.  Security-audit helper          → `security_audit_visibility`
--   4.  Group-invite notifications     → `list_new_group_invitations`
--   5.  Member-editable group avatars  → `update_group` permission split
--   6.  Chat file uploads              → `chat-uploads` storage bucket
--   7.  Mark delivered / read          → `mark_messages_delivered`, `mark_messages_read`
--   8.  Unified inbox + badge          → `get_conversations` (shares + messages), `unread_message_count`
--   9.  Saved archive (any message)    → bookmarks file columns + sender attribution, `save_message_to_archive`
--   10. Creator badge                  → profiles.is_creator (seeded by email)
--
-- Design notes:
--   * `shares` (v1/v2) stays as-is for backward compatibility with existing
--     link-share data. New chat content lives in `messages`. Unifying the two
--     in the thread view is handled in the frontend (Group 4).
--   * A peer conversation_id is a deterministic md5()::uuid of the two
--     participant ids, so both sides resolve to the same id without a registry
--     table. A group conversation_id is simply the group id.
--   * `messages` carries explicit `recipient_id` (peer) / `group_id` (group)
--     columns in addition to `conversation_id`. They're what RLS checks — the
--     hash alone can't tell you who a peer conversation's participants are.

-- ===========================================================================
-- 1. messages — freeform chat (text, link, image, document)
-- ===========================================================================

-- Deterministic, order-independent conversation id for a peer pair. Both
-- sides compute the same value because least()/greatest() canonicalize the
-- ordering before hashing. Uses md5()::uuid (md5 is a pg_catalog built-in) so
-- there's no dependency on the uuid-ossp extension's schema/search_path — a
-- function-local `search_path = public` can't see uuid_generate_v5/uuid_ns_oid
-- when uuid-ossp lives in the `extensions` schema (Supabase's default).
create or replace function public.get_peer_conversation_id(p_peer_id uuid)
returns uuid
language sql stable set search_path = public
as $$
  select md5(
    least(auth.uid()::text, p_peer_id::text) || greatest(auth.uid()::text, p_peer_id::text)
  )::uuid;
$$;

grant execute on function public.get_peer_conversation_id(uuid) to authenticated;

create table if not exists public.messages (
  id              uuid primary key default uuid_generate_v4(),
  conversation_id uuid not null,
  sender_id       uuid not null references public.profiles(id) on delete cascade,
  -- Exactly one of recipient_id / group_id is set (enforced by the CHECK
  -- below). recipient_id → 1:1 peer message; group_id → group message.
  recipient_id    uuid references public.profiles(id) on delete cascade,
  group_id        uuid references public.groups(id) on delete cascade,
  content         text check (content is null or char_length(content) <= 4000),
  message_type    varchar(20) not null default 'text'
                  check (message_type in ('text', 'link', 'image', 'document')),
  url             text,
  title           varchar(300),
  og_title        varchar(500),
  og_description  varchar(1000),
  og_image        text,
  file_path       text,
  file_name       varchar(255),
  file_size       int,
  mime_type       varchar(100),
  platform        varchar(30),
  edited_at       timestamptz,
  deleted_at      timestamptz,
  created_at      timestamptz not null default now(),
  constraint messages_one_target check (
    (recipient_id is not null and group_id is null)
    or (recipient_id is null and group_id is not null)
  )
);

create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc);
create index if not exists messages_sender_idx
  on public.messages (sender_id);

alter table public.messages enable row level security;

-- SELECT: sender, the peer recipient, or any member of the target group.
drop policy if exists messages_select_participant on public.messages;
create policy messages_select_participant on public.messages for select
  to authenticated
  using (
    sender_id = auth.uid()
    or recipient_id = auth.uid()
    or (group_id is not null and public.is_group_member(group_id))
  );

-- INSERT: sender must be the caller. Peer messages require an accepted
-- friendship and a conversation_id that matches the canonical pair hash;
-- group messages require membership and conversation_id = group_id. Pinning
-- conversation_id this way stops a caller from smuggling a message into an
-- arbitrary conversation.
drop policy if exists messages_insert_sender on public.messages;
create policy messages_insert_sender on public.messages for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and (
      (recipient_id is not null
        and group_id is null
        and public.are_friends(auth.uid(), recipient_id)
        and conversation_id = public.get_peer_conversation_id(recipient_id))
      or
      (recipient_id is null
        and group_id is not null
        and conversation_id = group_id
        and public.is_group_member(group_id))
    )
  );

-- UPDATE: only the sender. Column-level limits + the edit time window are
-- enforced by the trigger below (RLS can't gate which columns change).
drop policy if exists messages_update_sender on public.messages;
create policy messages_update_sender on public.messages for update
  to authenticated
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

-- No DELETE policy — deletion is a soft-delete (set deleted_at) via UPDATE.
grant select, insert, update on public.messages to authenticated;

-- Guard: on UPDATE, only content / edited_at / deleted_at may change, and a
-- content edit is only allowed within 24h of creation. Everything else is
-- immutable. Defense-in-depth on top of the sender-only RLS update policy.
create or replace function public.messages_guard_update()
returns trigger
language plpgsql set search_path = public
as $$
begin
  if new.conversation_id is distinct from old.conversation_id
     or new.sender_id    is distinct from old.sender_id
     or new.recipient_id is distinct from old.recipient_id
     or new.group_id     is distinct from old.group_id
     or new.message_type is distinct from old.message_type
     or new.url          is distinct from old.url
     or new.file_path    is distinct from old.file_path
     or new.file_name    is distinct from old.file_name
     or new.file_size    is distinct from old.file_size
     or new.mime_type    is distinct from old.mime_type
     or new.platform     is distinct from old.platform
     or new.created_at   is distinct from old.created_at then
    raise exception 'Only message content can be edited';
  end if;

  if new.content is distinct from old.content
     and old.created_at < now() - interval '24 hours' then
    raise exception 'Edit window has passed';
  end if;

  return new;
end;
$$;

drop trigger if exists messages_guard_update_trg on public.messages;
create trigger messages_guard_update_trg
  before update on public.messages
  for each row execute function public.messages_guard_update();

-- Realtime: stream message INSERTs/UPDATEs to subscribed clients. Realtime
-- enforces the messages RLS policies on the subscriber's JWT, so a client only
-- receives rows it's allowed to SELECT. `add table` errors if the table is
-- already in the publication, so guard it.
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception
  when duplicate_object then null;
  when undefined_object then
    raise notice 'publication supabase_realtime not found; enable Realtime in the dashboard';
end $$;

-- ===========================================================================
-- 1b. message_recipients — per-recipient delivery + read state (Prompt 12)
-- ===========================================================================
-- One row per (message, recipient). For peer messages that's a single row;
-- for group messages it's one per other member, fanned out by send_message.
-- The sender sees aggregate read/delivered counts; each recipient updates
-- only their own row's flags.

create table if not exists public.message_recipients (
  id              uuid primary key default uuid_generate_v4(),
  message_id      uuid not null references public.messages(id) on delete cascade,
  conversation_id uuid not null,  -- denormalized from messages so Realtime can
                                  -- filter receipt updates per conversation
  recipient_id    uuid not null references public.profiles(id) on delete cascade,
  delivered       boolean not null default false,
  delivered_at    timestamptz,
  read            boolean not null default false,
  read_at         timestamptz,
  unique (message_id, recipient_id)
);

create index if not exists message_recipients_recipient_idx
  on public.message_recipients (recipient_id);
create index if not exists message_recipients_message_idx
  on public.message_recipients (message_id);
create index if not exists message_recipients_conversation_idx
  on public.message_recipients (conversation_id);

alter table public.message_recipients enable row level security;

-- Realtime: stream receipt flips (delivered/read) so the sender's "Read" /
-- "Seen by N" updates live. RLS-gated to rows the subscriber can SELECT.
do $$
begin
  alter publication supabase_realtime add table public.message_recipients;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;

-- Security-definer helper: am I the sender of this message? Breaks the RLS
-- recursion between message_recipients and messages.
create or replace function public.is_message_sender(p_message_id uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.messages m
    where m.id = p_message_id and m.sender_id = auth.uid()
  );
$$;

revoke all on function public.is_message_sender(uuid) from public;
grant execute on function public.is_message_sender(uuid) to authenticated;

-- SELECT: the recipient sees their own row; the message sender sees all rows
-- for their message (to compute "seen by N").
drop policy if exists message_recipients_select on public.message_recipients;
create policy message_recipients_select on public.message_recipients for select
  to authenticated
  using (recipient_id = auth.uid() or public.is_message_sender(message_id));

-- UPDATE: only the recipient, and only to flip their own delivered/read flags.
drop policy if exists message_recipients_update_recipient on public.message_recipients;
create policy message_recipients_update_recipient on public.message_recipients for update
  to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

-- INSERT happens only inside send_message (SECURITY DEFINER) — no policy.
grant select, update on public.message_recipients to authenticated;

-- ===========================================================================
-- 2. Message RPCs — send + list
-- ===========================================================================
-- send_message computes conversation_id server-side (clients never derive the
-- v5 hash themselves) and re-checks the same invariants the RLS insert policy
-- enforces. SECURITY DEFINER so the single source of truth for conversation_id
-- is this function.

create or replace function public.send_message(
  p_recipient_id   uuid    default null,
  p_group_id       uuid    default null,
  p_content        text    default null,
  p_message_type   text    default 'text',
  p_url            text    default null,
  p_title          text    default null,
  p_og_title       text    default null,
  p_og_description text    default null,
  p_og_image       text    default null,
  p_file_path      text    default null,
  p_file_name      text    default null,
  p_file_size      int     default null,
  p_mime_type      text    default null,
  p_platform       text    default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_conversation_id uuid;
  new_id uuid;
begin
  if p_message_type not in ('text', 'link', 'image', 'document') then
    raise exception 'Invalid message type: %', p_message_type using errcode = '22023';
  end if;
  if (p_recipient_id is null) = (p_group_id is null) then
    raise exception 'Exactly one of recipient or group is required' using errcode = '22023';
  end if;

  if p_group_id is not null then
    if not public.is_group_member(p_group_id) then
      raise exception 'Not a member of that group' using errcode = '42501';
    end if;
    v_conversation_id := p_group_id;
  else
    if not public.are_friends(auth.uid(), p_recipient_id) then
      raise exception 'Recipient is not an accepted friend' using errcode = '42501';
    end if;
    v_conversation_id := public.get_peer_conversation_id(p_recipient_id);
  end if;

  insert into public.messages (
    conversation_id, sender_id, recipient_id, group_id,
    content, message_type, url, title,
    og_title, og_description, og_image,
    file_path, file_name, file_size, mime_type, platform
  ) values (
    v_conversation_id, auth.uid(), p_recipient_id, p_group_id,
    p_content, p_message_type, p_url, p_title,
    p_og_title, p_og_description, p_og_image,
    p_file_path, p_file_name, p_file_size, p_mime_type, p_platform
  )
  returning id into new_id;

  -- Fan out per-recipient delivery rows for read receipts. Peer → one row;
  -- group → one row per other member.
  if p_group_id is not null then
    insert into public.message_recipients (message_id, conversation_id, recipient_id)
    select new_id, v_conversation_id, gm.member_id
    from public.group_members gm
    where gm.group_id = p_group_id and gm.member_id <> auth.uid();
  else
    insert into public.message_recipients (message_id, conversation_id, recipient_id)
    values (new_id, v_conversation_id, p_recipient_id);
  end if;

  return new_id;
end;
$$;

revoke all on function public.send_message(uuid, uuid, text, text, text, text, text, text, text, text, text, int, text, text) from public;
grant execute on function public.send_message(uuid, uuid, text, text, text, text, text, text, text, text, text, int, text, text) to authenticated;

-- List one conversation's messages, oldest→newest within a page, keyset
-- paginated by created_at. SECURITY INVOKER so the SELECT policy still
-- applies as a backstop; we additionally pin to the resolved conversation_id.
-- Deleted messages return a null content (the row stays so the client can
-- render a "[deleted]" placeholder in place).
create or replace function public.get_conversation_messages(
  p_peer_id  uuid        default null,
  p_group_id uuid        default null,
  after      timestamptz default null,
  page_size  int         default 50
)
returns table (
  id              uuid,
  conversation_id uuid,
  sender_id       uuid,
  sender_username   varchar,
  sender_avatar_key varchar,
  sender_avatar_url text,
  recipient_id    uuid,
  group_id        uuid,
  content         text,
  message_type    varchar,
  url             text,
  title           varchar,
  og_title        varchar,
  og_description  varchar,
  og_image        text,
  file_path       text,
  file_name       varchar,
  file_size       int,
  mime_type       varchar,
  platform        varchar,
  direction       text,
  recipient_count int,
  delivered_count int,
  read_count      int,
  edited_at       timestamptz,
  deleted_at      timestamptz,
  created_at      timestamptz
)
language sql security invoker set search_path = public stable
as $$
  with conv as (
    select case
             when p_group_id is not null then p_group_id
             when p_peer_id  is not null then public.get_peer_conversation_id(p_peer_id)
             else null::uuid
           end as id
  )
  select
    m.id, m.conversation_id, m.sender_id,
    p.username   as sender_username,
    p.avatar_key as sender_avatar_key,
    p.avatar_url as sender_avatar_url,
    m.recipient_id, m.group_id,
    case when m.deleted_at is not null then null else m.content end as content,
    m.message_type,
    case when m.deleted_at is not null then null else m.url end as url,
    case when m.deleted_at is not null then null else m.title end as title,
    case when m.deleted_at is not null then null else m.og_title end as og_title,
    case when m.deleted_at is not null then null else m.og_description end as og_description,
    case when m.deleted_at is not null then null else m.og_image end as og_image,
    case when m.deleted_at is not null then null else m.file_path end as file_path,
    case when m.deleted_at is not null then null else m.file_name end as file_name,
    case when m.deleted_at is not null then null else m.file_size end as file_size,
    case when m.deleted_at is not null then null else m.mime_type end as mime_type,
    m.platform,
    case when m.sender_id = auth.uid() then 'out' else 'in' end as direction,
    (select count(*)::int from public.message_recipients mr where mr.message_id = m.id) as recipient_count,
    (select count(*)::int from public.message_recipients mr where mr.message_id = m.id and mr.delivered) as delivered_count,
    (select count(*)::int from public.message_recipients mr where mr.message_id = m.id and mr.read) as read_count,
    m.edited_at, m.deleted_at, m.created_at
  from public.messages m
  join conv c on m.conversation_id = c.id
  join public.profiles p on p.id = m.sender_id
  where c.id is not null
    and (after is null or m.created_at < after)
  order by m.created_at asc
  limit greatest(1, least(page_size, 200));
$$;

grant execute on function public.get_conversation_messages(uuid, uuid, timestamptz, int) to authenticated;

-- ===========================================================================
-- 3. Security audit helper (Prompt 3)
-- ===========================================================================
-- A developer signs in as a test user and runs `select * from
-- security_audit_visibility();`. Because it runs SECURITY INVOKER, every count
-- is filtered by that table's RLS — so it reports exactly how many rows the
-- current user can see in each table. Use it to confirm a test account can't
-- see messages/shares/groups it isn't a participant in.

create or replace function public.security_audit_visibility()
returns table (table_name text, visible_rows bigint)
language sql security invoker set search_path = public stable
as $$
  select 'messages'::text,          count(*) from public.messages
  union all select 'shares',            count(*) from public.shares
  union all select 'share_recipients',  count(*) from public.share_recipients
  union all select 'share_replies',     count(*) from public.share_replies
  union all select 'bookmarks',         count(*) from public.bookmarks
  union all select 'groups',            count(*) from public.groups
  union all select 'group_members',     count(*) from public.group_members
  union all select 'group_invitations', count(*) from public.group_invitations;
$$;

grant execute on function public.security_audit_visibility() to authenticated;

-- ===========================================================================
-- 4. Group-invite notifications (Prompt 4 remainder)
-- ===========================================================================
-- The v2 invite flow means you aren't a member until you accept, so the
-- service worker's old "list_new_group_memberships" signal never fires for a
-- fresh invite. This returns pending invites newer than `after` so the worker
-- can notify the invitee. Keyset by invitation created_at.

create or replace function public.list_new_group_invitations(after timestamptz default null)
returns table (
  invitation_id    uuid,
  group_id         uuid,
  group_name       varchar,
  inviter_username varchar,
  created_at       timestamptz
)
language sql security invoker set search_path = public stable
as $$
  select inv.id, inv.group_id, g.name, p.username, inv.created_at
  from public.group_invitations inv
  join public.groups g   on g.id = inv.group_id
  join public.profiles p on p.id = inv.inviter_id
  where inv.invitee_id = auth.uid()
    and inv.status = 'pending'
    and (after is null or inv.created_at > after)
  order by inv.created_at desc
  limit 10;
$$;

grant execute on function public.list_new_group_invitations(timestamptz) to authenticated;

-- ===========================================================================
-- 5. Group permissions: members may edit the avatar, admins everything (Prompt 5)
-- ===========================================================================
-- The doc's RLS sketch referenced NEW/OLD column diffs, which Postgres RLS
-- policies can't express. We enforce the split inside the RPC instead:
-- name/color are admin-only, avatar_key is editable by any member. SECURITY
-- DEFINER so a non-admin member's avatar edit isn't blocked by the
-- admin-only groups_update_admin table policy. The table policy stays in
-- place as the backstop for any direct REST update.

create or replace function public.update_group(
  p_id uuid, p_name text default null, p_color text default null, p_avatar_key text default null
)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_group_member(p_id) then
    raise exception 'Not a member of this group' using errcode = '42501';
  end if;

  if public.is_group_admin(p_id) then
    update public.groups
       set name       = coalesce(nullif(trim(p_name), ''), name),
           color      = coalesce(p_color, color),
           avatar_key = coalesce(p_avatar_key, avatar_key)
     where id = p_id;
  else
    -- Non-admin member: avatar only. Reject attempts to change name/color.
    if nullif(trim(coalesce(p_name, '')), '') is not null or p_color is not null then
      raise exception 'Only group admins can change the name or color' using errcode = '42501';
    end if;
    update public.groups
       set avatar_key = coalesce(p_avatar_key, avatar_key)
     where id = p_id;
  end if;
end;
$$;

revoke all on function public.update_group(uuid, text, text, text) from public;
grant execute on function public.update_group(uuid, text, text, text) to authenticated;

-- ===========================================================================
-- 6. chat-uploads storage bucket — images + documents in chat (Prompt 10)
-- ===========================================================================
-- Public bucket (like avatars) so <img src> / download links work without
-- signed URLs. Writes are confined to the uploader's own folder: <uid>/...
-- MIME-type allow-listing (images + documents, no video) is enforced in the
-- application layer (api.uploadMessageFile); object metadata mime checks
-- aren't reliably available to storage RLS.

insert into storage.buckets (id, name, public)
values ('chat-uploads', 'chat-uploads', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "chat_uploads_read_all"   on storage.objects;
drop policy if exists "chat_uploads_upload_own"  on storage.objects;
drop policy if exists "chat_uploads_delete_own"  on storage.objects;

create policy "chat_uploads_read_all"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'chat-uploads');

create policy "chat_uploads_upload_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'chat-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "chat_uploads_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'chat-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ===========================================================================
-- 7. Mark messages delivered / read (Prompt 12)
-- ===========================================================================
-- Flip the caller's own message_recipients flags for a whole conversation in
-- one round-trip. SECURITY INVOKER so the recipient-only UPDATE policy applies.

create or replace function public.mark_messages_delivered(
  p_peer_id uuid default null, p_group_id uuid default null
)
returns void
language sql security invoker set search_path = public
as $$
  update public.message_recipients mr
     set delivered = true, delivered_at = coalesce(mr.delivered_at, now())
    from public.messages m
   where mr.message_id = m.id
     and mr.recipient_id = auth.uid()
     and mr.delivered = false
     and m.conversation_id = case
           when p_group_id is not null then p_group_id
           when p_peer_id  is not null then public.get_peer_conversation_id(p_peer_id)
           else null::uuid
         end;
$$;

grant execute on function public.mark_messages_delivered(uuid, uuid) to authenticated;

create or replace function public.mark_messages_read(
  p_peer_id uuid default null, p_group_id uuid default null
)
returns void
language sql security invoker set search_path = public
as $$
  update public.message_recipients mr
     set read = true, read_at = coalesce(mr.read_at, now()),
         delivered = true, delivered_at = coalesce(mr.delivered_at, now())
    from public.messages m
   where mr.message_id = m.id
     and mr.recipient_id = auth.uid()
     and mr.read = false
     and m.conversation_id = case
           when p_group_id is not null then p_group_id
           when p_peer_id  is not null then public.get_peer_conversation_id(p_peer_id)
           else null::uuid
         end;
$$;

grant execute on function public.mark_messages_read(uuid, uuid) to authenticated;

create or replace function public.mark_all_messages_read()
returns void
language sql security invoker set search_path = public
as $$
  update public.message_recipients mr
     set read = true, read_at = coalesce(mr.read_at, now()),
         delivered = true, delivered_at = coalesce(mr.delivered_at, now())
    from public.messages m
   where mr.message_id = m.id
     and mr.recipient_id = auth.uid()
     and mr.read = false;
$$;

grant execute on function public.mark_all_messages_read() to authenticated;

-- Mark every undelivered message addressed to the caller as delivered. Called
-- when the client is online (on inbox load / app focus) so the sender sees
-- "Delivered" even before the recipient opens the specific thread.
create or replace function public.mark_all_messages_delivered()
returns void
language sql security invoker set search_path = public
as $$
  update public.message_recipients mr
     set delivered = true, delivered_at = coalesce(mr.delivered_at, now())
   where mr.recipient_id = auth.uid() and mr.delivered = false;
$$;

grant execute on function public.mark_all_messages_delivered() to authenticated;

-- ===========================================================================
-- 8. get_conversations — unified inbox (link-shares + chat messages)
-- ===========================================================================
-- Supersedes the v2 (shares-only) definition. A conversation now surfaces in
-- the inbox if it has either a link-share or a chat message, and the snippet /
-- last activity / unread count reflect both. Same return shape as v2, so the
-- client mapping is unchanged (last_share_id is now always null — the client
-- only uses it as an opaque marker).

-- The function body references profiles.inbox_cleared_at (the Clear-inbox
-- cursor — see section 8b). language sql functions are parsed and have
-- their column references resolved at CREATE time, so the column must
-- exist before this function is defined. Adding it here, idempotently;
-- 8b's definition stays for documentation but is now a no-op.
alter table public.profiles add column if not exists inbox_cleared_at timestamptz;

drop function if exists public.get_conversations(timestamptz, int);
create or replace function public.get_conversations(
  after timestamptz default null, page_size int default 5
)
returns table (
  kind              text,
  peer_id           uuid,
  peer_username     varchar,
  peer_avatar_key   varchar,
  peer_avatar_url   text,
  group_id          uuid,
  group_name        varchar,
  group_color       varchar,
  group_avatar_key  varchar,
  group_avatar_url  text,
  last_share_id     uuid,
  last_snippet      text,
  last_message_type varchar,
  last_sender_id    uuid,
  last_at           timestamptz,
  unread_count      int
)
language sql security invoker set search_path = public stable
as $$
  with
  peer_share_rows as (
    select
      case when s.sender_id = auth.uid() then sr.recipient_id else s.sender_id end as peer_id,
      s.sender_id, s.created_at,
      coalesce(s.note, s.og_title, s.title, s.url) as snippet,
      'share'::varchar(20) as message_type,
      case when sr.recipient_id = auth.uid() and sr.read = false then 1 else 0 end as is_unread
    from public.shares s
    join public.share_recipients sr on sr.share_id = s.id
    where s.group_id is null
      and (s.sender_id = auth.uid() or sr.recipient_id = auth.uid())
  ),
  peer_msg_rows as (
    select
      case when m.sender_id = auth.uid() then m.recipient_id else m.sender_id end as peer_id,
      m.sender_id, m.created_at,
      case when m.deleted_at is not null then 'message deleted'
           else coalesce(m.content, m.og_title, m.title, m.file_name, m.url)
      end as snippet,
      m.message_type,
      case when m.sender_id <> auth.uid()
                and exists (select 1 from public.message_recipients mr
                            where mr.message_id = m.id and mr.recipient_id = auth.uid() and mr.read = false)
           then 1 else 0 end as is_unread
    from public.messages m
    where m.recipient_id is not null
      and (m.sender_id = auth.uid() or m.recipient_id = auth.uid())
  ),
  peer_rows as (
    select * from peer_share_rows
    union all
    select * from peer_msg_rows
  ),
  peer_agg as (
    select peer_id,
           max(created_at) as last_at,
           (array_agg(snippet      order by created_at desc))[1] as last_snippet,
           (array_agg(message_type order by created_at desc))[1] as last_message_type,
           (array_agg(sender_id    order by created_at desc))[1] as last_sender_id,
           sum(is_unread)::int as unread_count
    from peer_rows
    where peer_id is not null
    group by peer_id
  ),
  group_share_rows as (
    select s.group_id, s.sender_id, s.created_at,
           coalesce(s.note, s.og_title, s.title, s.url) as snippet,
           'share'::varchar(20) as message_type,
           case when sr.recipient_id is not null and sr.read = false then 1 else 0 end as is_unread
    from public.shares s
    join public.group_members gm on gm.group_id = s.group_id and gm.member_id = auth.uid()
    left join public.share_recipients sr on sr.share_id = s.id and sr.recipient_id = auth.uid()
    where s.group_id is not null
  ),
  group_msg_rows as (
    select m.group_id, m.sender_id, m.created_at,
           case when m.deleted_at is not null then 'message deleted'
                else coalesce(m.content, m.og_title, m.title, m.file_name, m.url)
           end as snippet,
           m.message_type,
           case when m.sender_id <> auth.uid()
                     and exists (select 1 from public.message_recipients mr
                                 where mr.message_id = m.id and mr.recipient_id = auth.uid() and mr.read = false)
                then 1 else 0 end as is_unread
    from public.messages m
    join public.group_members gm on gm.group_id = m.group_id and gm.member_id = auth.uid()
    where m.group_id is not null
  ),
  group_rows as (
    select * from group_share_rows
    union all
    select * from group_msg_rows
  ),
  group_agg as (
    select group_id,
           max(created_at) as last_at,
           (array_agg(snippet      order by created_at desc))[1] as last_snippet,
           (array_agg(message_type order by created_at desc))[1] as last_message_type,
           (array_agg(sender_id    order by created_at desc))[1] as last_sender_id,
           sum(is_unread)::int as unread_count
    from group_rows
    group by group_id
  ),
  unified as (
    select 'peer'::text as kind, p.id as peer_id, p.username as peer_username,
           p.avatar_key as peer_avatar_key, p.avatar_url as peer_avatar_url,
           null::uuid as group_id, null::varchar as group_name, null::varchar as group_color,
           null::varchar as group_avatar_key, null::text as group_avatar_url,
           null::uuid as last_share_id, pa.last_snippet, pa.last_message_type,
           pa.last_sender_id, pa.last_at, pa.unread_count
    from peer_agg pa
    join public.profiles p on p.id = pa.peer_id
    union all
    select 'group'::text, null::uuid, null::varchar, null::varchar, null::text,
           g.id, g.name, g.color, g.avatar_key, g.avatar_url,
           null::uuid, ga.last_snippet, ga.last_message_type,
           ga.last_sender_id, ga.last_at, ga.unread_count
    from group_agg ga
    join public.groups g on g.id = ga.group_id
  )
  select * from unified
  where (after is null or last_at < after)
    and last_at > coalesce(
      (select inbox_cleared_at from public.profiles where id = auth.uid()),
      '-infinity'::timestamptz
    )
  order by last_at desc nulls last
  limit greatest(1, least(page_size, 50));
$$;

grant execute on function public.get_conversations(timestamptz, int) to authenticated;

-- ===========================================================================
-- 8b. Clear-inbox cursor (Settings → Clear inbox)
-- ===========================================================================
-- A per-user "everything before this is hidden from MY inbox" timestamp.
-- Reversible (no data destroyed; sent shares/messages are still visible to
-- their recipients), uniform across shares and chat messages, and a single
-- one-row UPDATE on the user's own profile. get_conversations (above) filters
-- by this cursor; unread_message_count and unread_share_count also apply it
-- so the badge zeros out after a clear.

alter table public.profiles add column if not exists inbox_cleared_at timestamptz;

create or replace function public.clear_inbox()
returns void
language sql security invoker set search_path = public
as $$
  update public.profiles
     set inbox_cleared_at = now()
   where id = auth.uid();
$$;

grant execute on function public.clear_inbox() to authenticated;

-- Undo a clear by nulling the cursor. The cleared rows were never destroyed,
-- so this restores the inbox exactly as it was. Trivially reversible because
-- the entire feature is just a cursor.

create or replace function public.undo_clear_inbox()
returns void
language sql security invoker set search_path = public
as $$
  update public.profiles
     set inbox_cleared_at = null
   where id = auth.uid();
$$;

grant execute on function public.undo_clear_inbox() to authenticated;

-- Re-create the unread counters to respect the cursor. (Original versions
-- live in schema.sql / schema.v2.sql — overriding here so a clear actually
-- zeros the badge.)

create or replace function public.unread_share_count()
returns int
language sql security invoker set search_path = public stable
as $$
  select count(*)::int from public.share_recipients sr
  join public.shares s on s.id = sr.share_id
  where sr.recipient_id = auth.uid()
    and sr.read = false
    and s.created_at > coalesce(
      (select inbox_cleared_at from public.profiles where id = auth.uid()),
      '-infinity'::timestamptz
    );
$$;

grant execute on function public.unread_share_count() to authenticated;

-- Unread chat-message count for the toolbar badge (added to the existing
-- unread_share_count by the service worker, so the badge reflects both).
-- Filters by the inbox_cleared_at cursor (8b) so a Clear-inbox zeroes the badge.
create or replace function public.unread_message_count()
returns int
language sql security invoker set search_path = public stable
as $$
  select count(*)::int
  from public.message_recipients mr
  join public.messages m on m.id = mr.message_id
  where mr.recipient_id = auth.uid()
    and mr.read = false
    and m.created_at > coalesce(
      (select inbox_cleared_at from public.profiles where id = auth.uid()),
      '-infinity'::timestamptz
    );
$$;

grant execute on function public.unread_message_count() to authenticated;

-- ===========================================================================
-- 9. Saved archive: sender attribution + non-link saves (Prompts 14 & 15)
-- ===========================================================================
-- bookmarks gains columns to archive images/documents (not just links) and a
-- pointer to the source message. url becomes nullable so a text/note-only or
-- file save (no http url for some) can still be stored.

alter table public.bookmarks
  add column if not exists message_type      varchar(20),
  add column if not exists file_path         text,
  add column if not exists file_name         varchar(255),
  add column if not exists mime_type         varchar(100),
  add column if not exists source_message_id uuid references public.messages(id) on delete set null;

alter table public.bookmarks alter column url drop not null;

create index if not exists bookmarks_source_message_idx
  on public.bookmarks (source_message_id);

-- list_bookmarks: return shape changes (sender attribution + file columns), so
-- drop first. Sender is resolved by joining the source share OR source message
-- back to its author's profile. SECURITY INVOKER, so the joins respect the
-- caller's RLS — an unreadable source just yields a null sender (graceful).
drop function if exists public.list_bookmarks(timestamptz, int);
create or replace function public.list_bookmarks(
  after timestamptz default null, page_size int default 20
)
returns table (
  id uuid, url text, title varchar, note varchar, platform varchar,
  og_title varchar, og_description varchar, og_image text,
  message_type varchar, file_path text, file_name varchar, mime_type varchar,
  source_share_id uuid, source_message_id uuid,
  source_sender_username   varchar,
  source_sender_avatar_key varchar,
  source_sender_avatar_url text,
  saved_at timestamptz
)
language sql security invoker set search_path = public stable
as $$
  select
    b.id, b.url, b.title, b.note, b.platform,
    b.og_title, b.og_description, b.og_image,
    b.message_type, b.file_path, b.file_name, b.mime_type,
    b.source_share_id, b.source_message_id,
    coalesce(sp.username,   mp.username)   as source_sender_username,
    coalesce(sp.avatar_key, mp.avatar_key) as source_sender_avatar_key,
    coalesce(sp.avatar_url, mp.avatar_url) as source_sender_avatar_url,
    b.created_at
  from public.bookmarks b
  left join public.shares   s  on s.id = b.source_share_id
  left join public.profiles sp on sp.id = s.sender_id
  left join public.messages m  on m.id = b.source_message_id
  left join public.profiles mp on mp.id = m.sender_id
  where b.owner_id = auth.uid()
    and (after is null or b.created_at < after)
  order by b.created_at desc
  limit greatest(1, least(page_size, 50));
$$;

grant execute on function public.list_bookmarks(timestamptz, int) to authenticated;

-- Save any visible message into the caller's personal archive. Links keep
-- their url; images/documents store the file url; the message text becomes the
-- note. Dedupes by url when one is present.
create or replace function public.save_message_to_archive(p_message_id uuid)
returns uuid
language plpgsql security invoker set search_path = public
as $$
declare
  m public.messages%rowtype;
  existing_id uuid;
  new_id uuid;
  v_title text;
begin
  select * into m from public.messages
   where id = p_message_id and deleted_at is null;
  if not found then
    raise exception 'Message not found or not visible' using errcode = 'P0002';
  end if;

  v_title := coalesce(m.title, m.og_title, m.file_name);

  if m.url is not null then
    select id into existing_id from public.bookmarks
     where owner_id = auth.uid() and url = m.url;
    if existing_id is not null then
      return existing_id;
    end if;
  end if;

  insert into public.bookmarks (
    owner_id, url, title, note, platform,
    og_title, og_description, og_image,
    message_type, file_path, file_name, mime_type, source_message_id
  ) values (
    auth.uid(), m.url, v_title, m.content, m.platform,
    m.og_title, m.og_description, m.og_image,
    m.message_type, m.file_path, m.file_name, m.mime_type, m.id
  )
  returning id into new_id;

  return new_id;
end;
$$;

grant execute on function public.save_message_to_archive(uuid) to authenticated;

-- ===========================================================================
-- 10. New-message notifications (for the service-worker poller)
-- ===========================================================================
-- Returns the latest unread message per conversation created after `after`,
-- with sender + peer/group display info so the SW can fire a system
-- notification without another round-trip to resolve names.

create or replace function public.get_new_messages(after timestamptz default null)
returns table (
  id              uuid,
  sender_id       uuid,
  sender_username varchar,
  snippet         text,
  message_type    varchar(20),
  created_at      timestamptz,
  peer_id         uuid,
  peer_username   varchar,
  group_id        uuid,
  group_name      varchar
)
language sql security invoker set search_path = public stable
as $$
  select distinct on (m.conversation_id)
    m.id, m.sender_id, p.username as sender_username,
    coalesce(nullif(m.content, ''), m.og_title, m.title, m.file_name, m.url) as snippet,
    m.message_type, m.created_at,
    case when m.recipient_id is not null then
      case when m.sender_id = auth.uid() then m.recipient_id else m.sender_id end
    end as peer_id,
    pr.username as peer_username,
    m.group_id,
    g.name as group_name
  from public.messages m
  join public.profiles p on p.id = m.sender_id
  left join public.profiles pr on pr.id = (
    case when m.recipient_id is not null then
      case when m.sender_id = auth.uid() then m.recipient_id else m.sender_id end
    else null end
  )
  left join public.groups g on g.id = m.group_id
  where m.sender_id <> auth.uid()
    and m.deleted_at is null
    and (after is null or m.created_at > after)
    and exists (select 1 from public.message_recipients mr
                where mr.message_id = m.id and mr.recipient_id = auth.uid() and mr.read = false)
  order by m.conversation_id, m.created_at desc;
$$;

grant execute on function public.get_new_messages(timestamptz) to authenticated;

-- ===========================================================================
-- 10b. Accept-notifications — let inviters know their group invite landed
-- ===========================================================================
-- group_invitations.responded_at already records when the invitee responded,
-- so we can key off it directly. Returns the invitations *I* sent that
-- flipped to 'accepted' after the supplied cursor — newest first, capped
-- at 10. The friend-request equivalent is handled service-worker-side by
-- diffing the friend list (friendships has no accepted_at column).

create or replace function public.list_new_accepted_group_invitations(after timestamptz default null)
returns table (
  invitation_id    uuid,
  group_id         uuid,
  group_name       varchar,
  invitee_id       uuid,
  invitee_username varchar,
  responded_at     timestamptz
)
language sql security invoker set search_path = public stable
as $$
  select inv.id, inv.group_id, g.name, inv.invitee_id, p.username, inv.responded_at
  from public.group_invitations inv
  join public.groups g   on g.id = inv.group_id
  join public.profiles p on p.id = inv.invitee_id
  where inv.inviter_id = auth.uid()
    and inv.status = 'accepted'
    and inv.responded_at is not null
    and (after is null or inv.responded_at > after)
  order by inv.responded_at desc
  limit 10;
$$;

grant execute on function public.list_new_accepted_group_invitations(timestamptz) to authenticated;

-- ===========================================================================
-- 11. Creator badge — flag specific accounts as "Creator"
-- ===========================================================================
-- profiles.is_creator marks built-in/owner accounts. It's seeded by email
-- against auth.users (only the SQL editor / service role can read auth.users;
-- the column itself is readable by clients via the existing profiles SELECT
-- policy, so the app can badge those users wherever they appear).
-- Re-run this UPDATE any time you need to (re)seed creators.

alter table public.profiles
  add column if not exists is_creator boolean not null default false;

update public.profiles p
   set is_creator = true
  from auth.users u
 where u.id = p.id
   and lower(u.email) in ('flaubertbenimana@gmail.com', 'nielox490@gmail.com');
