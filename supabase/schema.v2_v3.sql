-- Tania — consolidated schema (v2 + v3)
--
-- Convenience bundle: schema.v2.sql followed by schema.v3.sql, so everything
-- from v2 onward can be applied in a single Supabase SQL-editor run.
--
-- PREREQUISITE: v1 (schema.sql) must already be applied to the project.
-- AFTER RUNNING: enable Realtime on the project — this migration adds
--   public.messages and public.message_recipients to the supabase_realtime
--   publication, and creates the public chat-uploads storage bucket.
--
-- Both halves are idempotent, so re-running this file is safe.
-- ===========================================================================

-- ########################  BEGIN schema.v2.sql  ###########################

-- Tania v2 — additive migration on top of schema.sql
--
-- Run this in the Supabase SQL editor on a project that already has v1's
-- schema.sql applied. Idempotent: every CREATE uses `if not exists`, every
-- policy is dropped + recreated, every function uses `or replace`.
--
-- Features added by this migration:
--   1. Personal link archive       → `public.bookmarks`
--   2. Replies on shared links     → `public.share_replies`
--   3. Profile avatars             → `profiles.avatar_key`
--   4. Shared groups               → `public.groups` + `public.group_members`
--   5. Group-targeted shares       → `shares.group_id`
--   6. Conversation-grouped inbox  → RPC `get_conversations`, `get_conversation_thread`
--   7. Better friend search        → RPC `search_users_v2` (prefix-ranked, mutual count)

-- ===========================================================================
-- profiles.avatar_key
-- ===========================================================================

alter table public.profiles
  add column if not exists avatar_key varchar(20);

-- ===========================================================================
-- bookmarks — personal link archive
-- ===========================================================================

create table if not exists public.bookmarks (
  id              uuid primary key default uuid_generate_v4(),
  owner_id        uuid not null references public.profiles(id) on delete cascade,
  url             text not null check (char_length(url) <= 2048
                    and (url like 'http://%' or url like 'https://%')),
  title           varchar(300),
  note            varchar(500),
  platform        varchar(30),
  og_title        varchar(500),
  og_description  varchar(1000),
  og_image        text,
  site_icon       text,
  source_share_id uuid references public.shares(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (owner_id, url)
);

create index if not exists bookmarks_owner_created_idx
  on public.bookmarks (owner_id, created_at desc);

alter table public.bookmarks enable row level security;

drop policy if exists bookmarks_select_owner on public.bookmarks;
drop policy if exists bookmarks_insert_owner on public.bookmarks;
drop policy if exists bookmarks_update_owner on public.bookmarks;
drop policy if exists bookmarks_delete_owner on public.bookmarks;

create policy bookmarks_select_owner on public.bookmarks for select
  to authenticated using (owner_id = auth.uid());
create policy bookmarks_insert_owner on public.bookmarks for insert
  to authenticated with check (owner_id = auth.uid());
create policy bookmarks_update_owner on public.bookmarks for update
  to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy bookmarks_delete_owner on public.bookmarks for delete
  to authenticated using (owner_id = auth.uid());

create or replace function public.save_bookmark(
  p_url       text,
  p_title     text default null,
  p_note      text default null,
  p_platform  text default null,
  p_overwrite boolean default false
)
returns uuid
language plpgsql security invoker set search_path = public
as $$
declare existing_id uuid; new_id uuid;
begin
  select id into existing_id from public.bookmarks
   where owner_id = auth.uid() and url = p_url;
  if existing_id is not null then
    if p_overwrite then
      update public.bookmarks
         set title = coalesce(p_title, title),
             note = coalesce(p_note, note),
             platform = coalesce(p_platform, platform)
       where id = existing_id;
    end if;
    return existing_id;
  end if;
  insert into public.bookmarks (owner_id, url, title, note, platform)
  values (auth.uid(), p_url, p_title, p_note, p_platform)
  returning id into new_id;
  return new_id;
end;
$$;

grant execute on function public.save_bookmark(text, text, text, text, boolean) to authenticated;

create or replace function public.save_bookmark_from_share(
  p_share_id uuid, p_note text default null
)
returns uuid
language plpgsql security invoker set search_path = public
as $$
declare s public.shares%rowtype; existing_id uuid; new_id uuid;
begin
  select * into s from public.shares where id = p_share_id;
  if not found then
    raise exception 'Share not found or not visible' using errcode = 'P0002';
  end if;
  select id into existing_id from public.bookmarks
   where owner_id = auth.uid() and url = s.url;
  if existing_id is not null then
    return existing_id;
  end if;
  insert into public.bookmarks (
    owner_id, url, title, note, platform,
    og_title, og_description, og_image, site_icon,
    source_share_id
  ) values (
    auth.uid(), s.url, s.title, coalesce(p_note, s.note), s.platform,
    s.og_title, s.og_description, s.og_image, s.site_icon, s.id
  )
  returning id into new_id;
  return new_id;
end;
$$;

grant execute on function public.save_bookmark_from_share(uuid, text) to authenticated;

-- DROP first so re-running this bundle is safe: v3 later extends this
-- function's return shape (file columns + sender attribution), and
-- `create or replace` can't shrink an existing function's return type back
-- to this v2 shape on a re-run.
drop function if exists public.list_bookmarks(timestamptz, int);
create or replace function public.list_bookmarks(
  after timestamptz default null, page_size int default 20
)
returns table (
  id uuid, url text, title varchar, note varchar, platform varchar,
  og_title varchar, og_description varchar, og_image text,
  source_share_id uuid, saved_at timestamptz
)
language sql security invoker set search_path = public stable
as $$
  select b.id, b.url, b.title, b.note, b.platform,
         b.og_title, b.og_description, b.og_image,
         b.source_share_id, b.created_at
  from public.bookmarks b
  where b.owner_id = auth.uid()
    and (after is null or b.created_at < after)
  order by b.created_at desc
  limit greatest(1, least(page_size, 50));
$$;

grant execute on function public.list_bookmarks(timestamptz, int) to authenticated;

-- ===========================================================================
-- share_replies — comments on a shared link, visible to participants only
-- ===========================================================================

create table if not exists public.share_replies (
  id         uuid primary key default uuid_generate_v4(),
  share_id   uuid not null references public.shares(id) on delete cascade,
  author_id  uuid not null references public.profiles(id) on delete cascade,
  body       varchar(1000) not null check (char_length(trim(body)) > 0),
  created_at timestamptz not null default now()
);

-- Reply-to-reply: nullable pointer at another reply on the SAME share.
-- `on delete set null` so deleting a reply doesn't cascade-wipe child replies;
-- they just lose their quoted-parent indicator. The same-share invariant is
-- enforced inside post_share_reply (defense-in-depth — RLS already prevents
-- inserting a reply against an invisible share).
alter table public.share_replies
  add column if not exists parent_reply_id uuid
    references public.share_replies(id) on delete set null;

create index if not exists share_replies_share_created_idx
  on public.share_replies (share_id, created_at asc);

alter table public.share_replies enable row level security;

-- (RLS policies for share_replies are defined further down, after the
-- `is_share_visible_to_me` helper is created.)

-- ===========================================================================
-- groups — shared multi-user spaces (a step up from v1's "ad-hoc multi-recipient")
-- ===========================================================================
-- A group has members. Any member can post a share into the group; the share
-- is visible (and replyable) to every member. Per-member read state still
-- lives in share_recipients, populated at send time for each group member.

create table if not exists public.groups (
  id         uuid primary key default uuid_generate_v4(),
  name       varchar(40) not null check (char_length(trim(name)) > 0),
  color      varchar(7) not null default '#6366f1'
             check (color ~ '^#[0-9a-fA-F]{6}$'),
  avatar_key varchar(20),
  created_by uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists groups_created_by_idx on public.groups (created_by);

create table if not exists public.group_members (
  group_id  uuid not null references public.groups(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  role      varchar(10) not null default 'member' check (role in ('admin','member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, member_id)
);

create index if not exists group_members_member_idx on public.group_members (member_id);

alter table public.groups        enable row level security;
alter table public.group_members enable row level security;

-- Helper: am I a member of this group? Security-definer so RLS doesn't
-- recurse when a policy references group_members from inside groups (or
-- vice versa).

create or replace function public.is_group_member(p_group_id uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group_id and member_id = auth.uid()
  );
$$;

revoke all on function public.is_group_member(uuid) from public;
grant execute on function public.is_group_member(uuid) to authenticated;

create or replace function public.is_group_admin(p_group_id uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group_id and member_id = auth.uid() and role = 'admin'
  ) or exists (
    select 1 from public.groups
    where id = p_group_id and created_by = auth.uid()
  );
$$;

revoke all on function public.is_group_admin(uuid) from public;
grant execute on function public.is_group_admin(uuid) to authenticated;

-- groups policies

drop policy if exists groups_select_member on public.groups;
drop policy if exists groups_insert_self   on public.groups;
drop policy if exists groups_update_admin  on public.groups;
drop policy if exists groups_delete_admin  on public.groups;

create policy groups_select_member on public.groups for select
  to authenticated
  using (public.is_group_member(id) or created_by = auth.uid());

create policy groups_insert_self on public.groups for insert
  to authenticated
  with check (created_by = auth.uid());

create policy groups_update_admin on public.groups for update
  to authenticated
  using (public.is_group_admin(id))
  with check (public.is_group_admin(id));

create policy groups_delete_admin on public.groups for delete
  to authenticated
  using (public.is_group_admin(id));

-- group_members policies

drop policy if exists group_members_select_member on public.group_members;
drop policy if exists group_members_insert_admin  on public.group_members;
drop policy if exists group_members_delete_admin_or_self on public.group_members;

create policy group_members_select_member on public.group_members for select
  to authenticated
  using (public.is_group_member(group_id));

create policy group_members_insert_admin on public.group_members for insert
  to authenticated
  with check (
    public.is_group_admin(group_id)
    and public.are_friends(auth.uid(), member_id)
  );

create policy group_members_delete_admin_or_self on public.group_members for delete
  to authenticated
  using (public.is_group_admin(group_id) or member_id = auth.uid());

-- ===========================================================================
-- shares.group_id — tag a share as belonging to a group conversation
-- ===========================================================================

alter table public.shares
  add column if not exists group_id uuid references public.groups(id) on delete set null;

create index if not exists shares_group_created_idx on public.shares (group_id, created_at desc);

-- Replace v1's SELECT policy to also let group members see group shares.

drop policy if exists shares_select_participant on public.shares;

create policy shares_select_participant on public.shares for select
  to authenticated
  using (
    sender_id = auth.uid()
    or public.is_share_recipient(id)
    or (group_id is not null and public.is_group_member(group_id))
  );

-- Replace v1's INSERT policy to enforce membership when group_id is set.

drop policy if exists shares_insert_as_sender on public.shares;

create policy shares_insert_as_sender on public.shares for insert
  to authenticated
  with check (
    sender_id = auth.uid()
    and (group_id is null or public.is_group_member(group_id))
  );

-- Helper used by share_replies and any future cross-table check:
-- "is this share visible to me?" (sender, listed recipient, or group member)

create or replace function public.is_share_visible_to_me(p_share_id uuid)
returns boolean
language sql security definer set search_path = public stable
as $$
  select exists (
    select 1 from public.shares s
    where s.id = p_share_id
      and (
        s.sender_id = auth.uid()
        or exists (
          select 1 from public.share_recipients sr
          where sr.share_id = s.id and sr.recipient_id = auth.uid()
        )
        or (s.group_id is not null
            and exists (
              select 1 from public.group_members gm
              where gm.group_id = s.group_id and gm.member_id = auth.uid()
            ))
      )
  );
$$;

revoke all on function public.is_share_visible_to_me(uuid) from public;
grant execute on function public.is_share_visible_to_me(uuid) to authenticated;

-- share_replies policies (defined here, after is_share_visible_to_me exists)

drop policy if exists share_replies_select_participant on public.share_replies;
drop policy if exists share_replies_insert_participant on public.share_replies;
drop policy if exists share_replies_delete_author      on public.share_replies;

create policy share_replies_select_participant on public.share_replies for select
  to authenticated
  using (public.is_share_visible_to_me(share_id));

create policy share_replies_insert_participant on public.share_replies for insert
  to authenticated
  with check (
    author_id = auth.uid()
    and public.is_share_visible_to_me(share_id)
  );

create policy share_replies_delete_author on public.share_replies for delete
  to authenticated
  using (author_id = auth.uid());

-- The return-column list changed (added parent_*), so drop the old signature
-- first — `create or replace function` can't change a function's return shape.
drop function if exists public.list_share_replies(uuid);
create or replace function public.list_share_replies(p_share_id uuid)
returns table (
  id uuid, author_id uuid, author_username varchar,
  author_avatar_key varchar, body varchar, created_at timestamptz,
  parent_reply_id uuid, parent_author varchar, parent_excerpt text
)
language sql security invoker set search_path = public stable
as $$
  select
    r.id, r.author_id, p.username, p.avatar_key, r.body, r.created_at,
    r.parent_reply_id,
    pr_author.username as parent_author,
    case when pr.body is null then null
         else left(pr.body, 80) end as parent_excerpt
  from public.share_replies r
  join public.profiles p on p.id = r.author_id
  left join public.share_replies pr on pr.id = r.parent_reply_id
  left join public.profiles pr_author on pr_author.id = pr.author_id
  where r.share_id = p_share_id
  order by r.created_at asc;
$$;

grant execute on function public.list_share_replies(uuid) to authenticated;

-- post_share_reply: signature changed (added p_parent_reply_id and parent_* in
-- the return shape), so drop first.
drop function if exists public.post_share_reply(uuid, text);
drop function if exists public.post_share_reply(uuid, text, uuid);
create or replace function public.post_share_reply(
  p_share_id        uuid,
  p_body            text,
  p_parent_reply_id uuid default null
)
returns table (
  id uuid, author_id uuid, author_username varchar,
  author_avatar_key varchar, body varchar, created_at timestamptz,
  parent_reply_id uuid, parent_author varchar, parent_excerpt text
)
language plpgsql security invoker set search_path = public
as $$
declare new_id uuid;
begin
  -- Same-share invariant: a reply can only quote another reply on the same
  -- share. Without this, a user could plant a reference to a reply they
  -- can't see (the row insert would still succeed under RLS, since author
  -- and target-share are both validated, but the quote excerpt would leak
  -- into responses).
  if p_parent_reply_id is not null then
    if not exists (
      select 1 from public.share_replies pr
      where pr.id = p_parent_reply_id and pr.share_id = p_share_id
    ) then
      raise exception 'Parent reply must belong to the same share';
    end if;
  end if;

  insert into public.share_replies (share_id, author_id, body, parent_reply_id)
  values (p_share_id, auth.uid(), p_body, p_parent_reply_id)
  returning share_replies.id into new_id;

  return query
    select
      r.id, r.author_id, p.username, p.avatar_key, r.body, r.created_at,
      r.parent_reply_id,
      pr_author.username as parent_author,
      case when pr.body is null then null
           else left(pr.body, 80) end as parent_excerpt
    from public.share_replies r
    join public.profiles p on p.id = r.author_id
    left join public.share_replies pr on pr.id = r.parent_reply_id
    left join public.profiles pr_author on pr_author.id = pr.author_id
    where r.id = new_id;
end;
$$;

grant execute on function public.post_share_reply(uuid, text, uuid) to authenticated;

create or replace function public.reply_counts_for_shares(p_share_ids uuid[])
returns table (share_id uuid, count int)
language sql security invoker set search_path = public stable
as $$
  select r.share_id, count(*)::int
  from public.share_replies r
  where r.share_id = any(p_share_ids)
    and public.is_share_visible_to_me(r.share_id)
  group by r.share_id;
$$;

grant execute on function public.reply_counts_for_shares(uuid[]) to authenticated;

-- ===========================================================================
-- Groups RPCs
-- ===========================================================================

-- DROP first: re-runs of this migration may have already installed the
-- later (avatar_url-extended) shape — `create or replace` can't change a
-- function's return columns, so the bare CREATE here would fail.
drop function if exists public.get_groups_view();
create or replace function public.get_groups_view()
returns table (
  id           uuid,
  name         varchar,
  color        varchar,
  avatar_key   varchar,
  created_by   uuid,
  created_at   timestamptz,
  role         varchar,
  member_count int,
  members      json
)
language sql security invoker set search_path = public stable
as $$
  select
    g.id, g.name, g.color, g.avatar_key, g.created_by, g.created_at,
    me.role,
    (select count(*)::int from public.group_members where group_id = g.id) as member_count,
    coalesce(
      (select json_agg(json_build_object(
                'id', p.id,
                'username', p.username,
                'avatar_key', p.avatar_key,
                'role', gm.role
              ) order by p.username)
         from public.group_members gm
         join public.profiles p on p.id = gm.member_id
        where gm.group_id = g.id),
      '[]'::json
    ) as members
  from public.groups g
  join public.group_members me on me.group_id = g.id and me.member_id = auth.uid()
  order by g.created_at asc;
$$;

grant execute on function public.get_groups_view() to authenticated;

-- SECURITY DEFINER so the function can seed the first group_members row
-- (the creator as admin) without tripping the chicken-and-egg with the
-- `group_members_insert_admin` policy, which requires being an admin to
-- insert a member. All inserted values come from auth.uid() / trimmed
-- input — no caller-controlled role assignment.

create or replace function public.create_group(
  p_name text, p_color text default '#6366f1', p_avatar_key text default null
)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare new_id uuid;
begin
  insert into public.groups (name, color, avatar_key, created_by)
  values (trim(p_name), p_color, p_avatar_key, auth.uid())
  returning id into new_id;
  insert into public.group_members (group_id, member_id, role)
  values (new_id, auth.uid(), 'admin');
  return new_id;
end;
$$;

revoke all on function public.create_group(text, text, text) from public;
grant execute on function public.create_group(text, text, text) to authenticated;

create or replace function public.update_group(
  p_id uuid, p_name text default null, p_color text default null, p_avatar_key text default null
)
returns void
language sql security invoker set search_path = public
as $$
  update public.groups
     set name       = coalesce(nullif(trim(p_name), ''), name),
         color      = coalesce(p_color, color),
         avatar_key = coalesce(p_avatar_key, avatar_key)
   where id = p_id and public.is_group_admin(id);
$$;

grant execute on function public.update_group(uuid, text, text, text) to authenticated;

create or replace function public.set_group_members(
  p_group_id uuid, p_member_ids uuid[]
)
returns void
language plpgsql security invoker set search_path = public
as $$
declare mid uuid;
begin
  if not public.is_group_admin(p_group_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  delete from public.group_members
   where group_id = p_group_id and member_id <> auth.uid();
  if p_member_ids is null then return; end if;
  foreach mid in array p_member_ids loop
    if mid <> auth.uid() then
      insert into public.group_members (group_id, member_id)
      values (p_group_id, mid)
      on conflict (group_id, member_id) do nothing;
    end if;
  end loop;
end;
$$;

grant execute on function public.set_group_members(uuid, uuid[]) to authenticated;

-- ===========================================================================
-- Share with group / Share with friends (extended)
-- ===========================================================================
-- v1's share_with_friends keyed off recipient_ids only. We add group_id
-- support so the share can be tagged as belonging to a group conversation,
-- and we still populate share_recipients (for per-member read state).
--
-- We drop v1's 5-param signature so PostgREST doesn't see an overload set
-- when the client passes p_group_id. (If you're running this on a fresh
-- project that never had v1, the DROP is a no-op.)

drop function if exists public.share_with_friends(text, uuid[], text, text, text);

create or replace function public.share_with_friends(
  p_url           text,
  p_recipient_ids uuid[],
  p_title         text default null,
  p_note          text default null,
  p_platform      text default null,
  p_group_id      uuid default null
)
returns uuid
language plpgsql security invoker set search_path = public
as $$
declare new_id uuid; rid uuid; eff_recipients uuid[];
begin
  if p_group_id is not null then
    if not public.is_group_member(p_group_id) then
      raise exception 'Not a member of that group' using errcode = '42501';
    end if;
    -- For group shares, recipients = every other group member.
    select array_agg(member_id) into eff_recipients
      from public.group_members
     where group_id = p_group_id and member_id <> auth.uid();
  else
    eff_recipients := p_recipient_ids;
    if eff_recipients is null or array_length(eff_recipients, 1) is null then
      raise exception 'at least one recipient required' using errcode = '22023';
    end if;
  end if;

  insert into public.shares (sender_id, url, title, note, platform, group_id)
  values (auth.uid(), p_url, p_title, p_note, p_platform, p_group_id)
  returning id into new_id;

  if eff_recipients is not null then
    foreach rid in array eff_recipients loop
      insert into public.share_recipients (share_id, recipient_id)
      values (new_id, rid)
      on conflict do nothing;
    end loop;
  end if;
  return new_id;
end;
$$;

grant execute on function public.share_with_friends(text, uuid[], text, text, text, uuid) to authenticated;

-- For group sends, the share_recipients INSERT must succeed even though
-- the recipient may not be a friend (group members aren't required to be
-- friends with the sender). Extend the share_recipients INSERT policy.

drop policy if exists share_recipients_insert_friend_only on public.share_recipients;
drop policy if exists share_recipients_insert_friend_or_group on public.share_recipients;

create policy share_recipients_insert_friend_or_group
  on public.share_recipients for insert
  to authenticated
  with check (
    public.is_share_sender(share_id)
    and (
      public.are_friends(auth.uid(), recipient_id)
      or exists (
        select 1 from public.shares s
        where s.id = share_id
          and s.group_id is not null
          and public.is_group_member(s.group_id)
          and exists (
            select 1 from public.group_members gm
            where gm.group_id = s.group_id and gm.member_id = recipient_id
          )
      )
    )
  );

-- ===========================================================================
-- Conversations RPC — inbox grouped by peer or group
-- ===========================================================================
-- One row per conversation (peer or group), ordered by last activity desc.

drop function if exists public.get_conversations();
create or replace function public.get_conversations()
returns table (
  kind             text,         -- 'peer' | 'group'
  peer_id          uuid,
  peer_username    varchar,
  peer_avatar_key  varchar,
  group_id         uuid,
  group_name       varchar,
  group_color      varchar,
  group_avatar_key varchar,
  last_share_id    uuid,
  last_snippet     text,
  last_sender_id   uuid,
  last_at          timestamptz,
  unread_count     int
)
language sql security invoker set search_path = public stable
as $$
  with peer_rows as (
    select
      case when s.sender_id = auth.uid() then sr.recipient_id else s.sender_id end as peer_id,
      s.id, s.sender_id, s.created_at,
      coalesce(s.note, s.og_title, s.title, s.url) as snippet,
      case when sr.recipient_id = auth.uid() and sr.read = false then 1 else 0 end as is_unread
    from public.shares s
    join public.share_recipients sr on sr.share_id = s.id
    where s.group_id is null
      and (s.sender_id = auth.uid() or sr.recipient_id = auth.uid())
  ),
  peer_agg as (
    select peer_id,
           max(created_at) as last_at,
           (array_agg(id          order by created_at desc))[1] as last_share_id,
           (array_agg(snippet     order by created_at desc))[1] as last_snippet,
           (array_agg(sender_id   order by created_at desc))[1] as last_sender_id,
           sum(is_unread)::int as unread_count
    from peer_rows
    group by peer_id
  ),
  group_rows as (
    select s.group_id, s.id, s.sender_id, s.created_at,
           coalesce(s.note, s.og_title, s.title, s.url) as snippet,
           case when sr.recipient_id is not null and sr.read = false then 1 else 0 end as is_unread
    from public.shares s
    join public.group_members gm
      on gm.group_id = s.group_id and gm.member_id = auth.uid()
    left join public.share_recipients sr
      on sr.share_id = s.id and sr.recipient_id = auth.uid()
    where s.group_id is not null
  ),
  group_agg as (
    select group_id,
           max(created_at) as last_at,
           (array_agg(id        order by created_at desc))[1] as last_share_id,
           (array_agg(snippet   order by created_at desc))[1] as last_snippet,
           (array_agg(sender_id order by created_at desc))[1] as last_sender_id,
           sum(is_unread)::int as unread_count
    from group_rows
    group by group_id
  )
  select 'peer'::text, p.id, p.username, p.avatar_key,
         null::uuid, null::varchar, null::varchar, null::varchar,
         pa.last_share_id, pa.last_snippet, pa.last_sender_id, pa.last_at, pa.unread_count
  from peer_agg pa
  join public.profiles p on p.id = pa.peer_id
  union all
  select 'group'::text, null::uuid, null::varchar, null::varchar,
         g.id, g.name, g.color, g.avatar_key,
         ga.last_share_id, ga.last_snippet, ga.last_sender_id, ga.last_at, ga.unread_count
  from group_agg ga
  join public.groups g on g.id = ga.group_id
  order by last_at desc nulls last;
$$;

grant execute on function public.get_conversations() to authenticated;

-- ===========================================================================
-- Conversation thread — every share in one 1-1 or group conversation
-- ===========================================================================

drop function if exists public.get_conversation_thread(uuid, uuid, int);
create or replace function public.get_conversation_thread(
  p_peer_id  uuid default null,
  p_group_id uuid default null,
  page_size  int  default 50
)
returns table (
  id             uuid,
  url            text,
  title          varchar,
  note           varchar,
  platform       varchar,
  og_title       varchar,
  og_description varchar,
  og_image       text,
  sender_id      uuid,
  sender_username varchar,
  sender_avatar_key varchar,
  direction      text,          -- 'out' | 'in'
  read           boolean,
  shared_at      timestamptz,
  replies        json
)
language sql security invoker set search_path = public stable
as $$
  with picked as (
    select s.*
    from public.shares s
    left join public.share_recipients sr on sr.share_id = s.id and sr.recipient_id = auth.uid()
    where (
      -- 1-1 with peer
      (p_peer_id is not null and s.group_id is null
        and ((s.sender_id = auth.uid() and sr.recipient_id = p_peer_id)
          or (s.sender_id = p_peer_id  and sr.recipient_id = auth.uid())))
      or
      -- group thread
      (p_group_id is not null and s.group_id = p_group_id
        and public.is_group_member(p_group_id))
    )
    order by s.created_at desc
    limit greatest(1, least(page_size, 200))
  )
  select
    p.id, p.url, p.title, p.note, p.platform,
    p.og_title, p.og_description, p.og_image,
    p.sender_id,
    sender.username      as sender_username,
    sender.avatar_key    as sender_avatar_key,
    case when p.sender_id = auth.uid() then 'out' else 'in' end as direction,
    coalesce(sr2.read, p.sender_id = auth.uid()) as read,
    p.created_at as shared_at,
    coalesce(
      (select json_agg(json_build_object(
                'id', r.id,
                'author_id', r.author_id,
                'author', a.username,
                'avatar_key', a.avatar_key,
                'body', r.body,
                'created_at', r.created_at
              ) order by r.created_at asc)
         from public.share_replies r
         join public.profiles a on a.id = r.author_id
        where r.share_id = p.id),
      '[]'::json
    ) as replies
  from picked p
  join public.profiles sender on sender.id = p.sender_id
  left join public.share_recipients sr2 on sr2.share_id = p.id and sr2.recipient_id = auth.uid()
  order by p.created_at asc;
$$;

grant execute on function public.get_conversation_thread(uuid, uuid, int) to authenticated;

-- Convenience: bulk mark-read for a conversation

create or replace function public.mark_conversation_read(
  p_peer_id uuid default null, p_group_id uuid default null
)
returns void
language sql security invoker set search_path = public
as $$
  update public.share_recipients sr
     set read = true, read_at = coalesce(read_at, now())
   from public.shares s
   where sr.share_id = s.id
     and sr.recipient_id = auth.uid()
     and sr.read = false
     and (
       (p_peer_id  is not null and s.group_id is null  and s.sender_id = p_peer_id)
       or
       (p_group_id is not null and s.group_id = p_group_id)
     );
$$;

grant execute on function public.mark_conversation_read(uuid, uuid) to authenticated;

-- ===========================================================================
-- Better friend search: prefix-ranked, larger limit, mutual count
-- ===========================================================================

drop function if exists public.search_users_v2(text);
create or replace function public.search_users_v2(q text)
returns table (
  id              uuid,
  username        varchar,
  avatar_key      varchar,
  status          text,
  mutual_count    int
)
language sql security invoker set search_path = public stable
as $$
  with q_norm as (select lower(coalesce(q, '')) as t)
  select
    p.id,
    p.username,
    p.avatar_key,
    (
      select f.status from public.friendships f
       where (f.requester_id = auth.uid() and f.addressee_id = p.id)
          or (f.requester_id = p.id and f.addressee_id = auth.uid())
       limit 1
    ) as status,
    (
      select count(*)::int
        from public.friendships f1
        join public.friendships f2
          on case when f1.requester_id = auth.uid() then f1.addressee_id else f1.requester_id end
           = case when f2.requester_id = p.id          then f2.addressee_id else f2.requester_id end
       where (f1.requester_id = auth.uid() or f1.addressee_id = auth.uid())
         and (f2.requester_id = p.id          or f2.addressee_id = p.id)
         and f1.status = 'accepted'
         and f2.status = 'accepted'
    ) as mutual_count
  from public.profiles p, q_norm
  where p.id <> auth.uid()
    and char_length(q_norm.t) >= 1
    and lower(p.username) like '%' || q_norm.t || '%'
  order by
    case when lower(p.username) = q_norm.t       then 0
         when lower(p.username) like q_norm.t || '%' then 1
         else 2 end,
    char_length(p.username) asc,
    lower(p.username) asc
  limit 20;
$$;

grant execute on function public.search_users_v2(text) to authenticated;

-- ===========================================================================
-- get_friends_view — extended to include avatar_key
-- ===========================================================================
-- v1 returned (kind, friendship_id, user_id, username, ts). We're adding
-- avatar_key to the row type, which `create or replace` cannot do — drop
-- first, then recreate.

drop function if exists public.get_friends_view();

create or replace function public.get_friends_view()
returns table (
  kind            text,
  friendship_id   uuid,
  user_id         uuid,
  username        varchar,
  avatar_key      varchar,
  ts              timestamptz
)
language sql security invoker set search_path = public stable
as $$
  select
    case
      when f.status = 'accepted'       then 'friend'
      when f.requester_id = auth.uid() then 'outgoing'
      else                                  'incoming'
    end                                              as kind,
    f.id                                             as friendship_id,
    case when f.requester_id = auth.uid()
         then f.addressee_id else f.requester_id end as user_id,
    p.username,
    p.avatar_key,
    f.created_at                                     as ts
  from public.friendships f
  join public.profiles p
    on p.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
  where (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
    and f.status in ('accepted', 'pending')
  order by f.created_at desc;
$$;

grant execute on function public.get_friends_view() to authenticated;

-- ===========================================================================
-- AVATAR_URL — uploaded profile pictures (Supabase Storage)
-- ===========================================================================
-- avatar_key (emoji preset) stays as a fallback option. If avatar_url is
-- set, the client renders the uploaded image instead.

alter table public.profiles add column if not exists avatar_url text;
alter table public.groups   add column if not exists avatar_url text;

-- Storage bucket: public so any signed-in user can render <img src="...">
-- without needing signed URLs. File path convention enforced by RLS:
--   <auth.uid()>/...               — user's own profile pic
--   groups/<group_id>/...          — group pic (admin-only writes)

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "avatars_read_all"   on storage.objects;
drop policy if exists "avatars_upload_own" on storage.objects;
drop policy if exists "avatars_update_own" on storage.objects;
drop policy if exists "avatars_delete_own" on storage.objects;

create policy "avatars_read_all"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'avatars');

create policy "avatars_upload_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or (
        (storage.foldername(name))[1] = 'groups'
        and public.is_group_admin(((storage.foldername(name))[2])::uuid)
      )
    )
  );

create policy "avatars_update_own"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or (
        (storage.foldername(name))[1] = 'groups'
        and public.is_group_admin(((storage.foldername(name))[2])::uuid)
      )
    )
  );

create policy "avatars_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or (
        (storage.foldername(name))[1] = 'groups'
        and public.is_group_admin(((storage.foldername(name))[2])::uuid)
      )
    )
  );

-- ===========================================================================
-- RPCs updated to surface avatar_url
-- ===========================================================================
-- Each one had to be dropped + recreated because the RETURNS TABLE shape
-- changes when we add an avatar_url column.

drop function if exists public.get_friends_view();
create or replace function public.get_friends_view()
returns table (
  kind            text,
  friendship_id   uuid,
  user_id         uuid,
  username        varchar,
  avatar_key      varchar,
  avatar_url      text,
  ts              timestamptz
)
language sql security invoker set search_path = public stable
as $$
  select
    case
      when f.status = 'accepted'       then 'friend'
      when f.requester_id = auth.uid() then 'outgoing'
      else                                  'incoming'
    end                                              as kind,
    f.id                                             as friendship_id,
    case when f.requester_id = auth.uid()
         then f.addressee_id else f.requester_id end as user_id,
    p.username,
    p.avatar_key,
    p.avatar_url,
    f.created_at                                     as ts
  from public.friendships f
  join public.profiles p
    on p.id = case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end
  where (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
    and f.status in ('accepted', 'pending')
  order by f.created_at desc;
$$;

grant execute on function public.get_friends_view() to authenticated;

drop function if exists public.get_groups_view();
create or replace function public.get_groups_view()
returns table (
  id           uuid,
  name         varchar,
  color        varchar,
  avatar_key   varchar,
  avatar_url   text,
  created_by   uuid,
  created_at   timestamptz,
  role         varchar,
  member_count int,
  members      json
)
language sql security invoker set search_path = public stable
as $$
  select
    g.id, g.name, g.color, g.avatar_key, g.avatar_url, g.created_by, g.created_at,
    me.role,
    (select count(*)::int from public.group_members where group_id = g.id) as member_count,
    coalesce(
      (select json_agg(json_build_object(
                'id', p.id,
                'username', p.username,
                'avatar_key', p.avatar_key,
                'avatar_url', p.avatar_url,
                'role', gm.role
              ) order by p.username)
         from public.group_members gm
         join public.profiles p on p.id = gm.member_id
        where gm.group_id = g.id),
      '[]'::json
    ) as members
  from public.groups g
  join public.group_members me on me.group_id = g.id and me.member_id = auth.uid()
  order by g.created_at asc;
$$;

grant execute on function public.get_groups_view() to authenticated;

drop function if exists public.get_conversations();
create or replace function public.get_conversations()
returns table (
  kind             text,
  peer_id          uuid,
  peer_username    varchar,
  peer_avatar_key  varchar,
  peer_avatar_url  text,
  group_id         uuid,
  group_name       varchar,
  group_color      varchar,
  group_avatar_key varchar,
  group_avatar_url text,
  last_share_id    uuid,
  last_snippet     text,
  last_sender_id   uuid,
  last_at          timestamptz,
  unread_count     int
)
language sql security invoker set search_path = public stable
as $$
  with peer_rows as (
    select
      case when s.sender_id = auth.uid() then sr.recipient_id else s.sender_id end as peer_id,
      s.id, s.sender_id, s.created_at,
      coalesce(s.note, s.og_title, s.title, s.url) as snippet,
      case when sr.recipient_id = auth.uid() and sr.read = false then 1 else 0 end as is_unread
    from public.shares s
    join public.share_recipients sr on sr.share_id = s.id
    where s.group_id is null
      and (s.sender_id = auth.uid() or sr.recipient_id = auth.uid())
  ),
  peer_agg as (
    select peer_id,
           max(created_at) as last_at,
           (array_agg(id          order by created_at desc))[1] as last_share_id,
           (array_agg(snippet     order by created_at desc))[1] as last_snippet,
           (array_agg(sender_id   order by created_at desc))[1] as last_sender_id,
           sum(is_unread)::int as unread_count
    from peer_rows
    group by peer_id
  ),
  group_rows as (
    select s.group_id, s.id, s.sender_id, s.created_at,
           coalesce(s.note, s.og_title, s.title, s.url) as snippet,
           case when sr.recipient_id is not null and sr.read = false then 1 else 0 end as is_unread
    from public.shares s
    join public.group_members gm
      on gm.group_id = s.group_id and gm.member_id = auth.uid()
    left join public.share_recipients sr
      on sr.share_id = s.id and sr.recipient_id = auth.uid()
    where s.group_id is not null
  ),
  group_agg as (
    select group_id,
           max(created_at) as last_at,
           (array_agg(id        order by created_at desc))[1] as last_share_id,
           (array_agg(snippet   order by created_at desc))[1] as last_snippet,
           (array_agg(sender_id order by created_at desc))[1] as last_sender_id,
           sum(is_unread)::int as unread_count
    from group_rows
    group by group_id
  )
  select 'peer'::text, p.id, p.username, p.avatar_key, p.avatar_url,
         null::uuid, null::varchar, null::varchar, null::varchar, null::text,
         pa.last_share_id, pa.last_snippet, pa.last_sender_id, pa.last_at, pa.unread_count
  from peer_agg pa
  join public.profiles p on p.id = pa.peer_id
  union all
  select 'group'::text, null::uuid, null::varchar, null::varchar, null::text,
         g.id, g.name, g.color, g.avatar_key, g.avatar_url,
         ga.last_share_id, ga.last_snippet, ga.last_sender_id, ga.last_at, ga.unread_count
  from group_agg ga
  join public.groups g on g.id = ga.group_id
  order by last_at desc nulls last;
$$;

grant execute on function public.get_conversations() to authenticated;

drop function if exists public.get_conversation_thread(uuid, uuid, int);
create or replace function public.get_conversation_thread(
  p_peer_id  uuid default null,
  p_group_id uuid default null,
  page_size  int  default 50
)
returns table (
  id             uuid,
  url            text,
  title          varchar,
  note           varchar,
  platform       varchar,
  og_title       varchar,
  og_description varchar,
  og_image       text,
  sender_id      uuid,
  sender_username   varchar,
  sender_avatar_key varchar,
  sender_avatar_url text,
  direction      text,
  read           boolean,
  shared_at      timestamptz,
  replies        json
)
language sql security invoker set search_path = public stable
as $$
  with picked as (
    select s.*
    from public.shares s
    left join public.share_recipients sr on sr.share_id = s.id and sr.recipient_id = auth.uid()
    where (
      (p_peer_id is not null and s.group_id is null
        and ((s.sender_id = auth.uid() and sr.recipient_id = p_peer_id)
          or (s.sender_id = p_peer_id  and sr.recipient_id = auth.uid())))
      or
      (p_group_id is not null and s.group_id = p_group_id
        and public.is_group_member(p_group_id))
    )
    order by s.created_at desc
    limit greatest(1, least(page_size, 200))
  )
  select
    p.id, p.url, p.title, p.note, p.platform,
    p.og_title, p.og_description, p.og_image,
    p.sender_id,
    sender.username   as sender_username,
    sender.avatar_key as sender_avatar_key,
    sender.avatar_url as sender_avatar_url,
    case when p.sender_id = auth.uid() then 'out' else 'in' end as direction,
    coalesce(sr2.read, p.sender_id = auth.uid()) as read,
    p.created_at as shared_at,
    coalesce(
      (select json_agg(json_build_object(
                'id', r.id,
                'author_id', r.author_id,
                'author', a.username,
                'avatar_key', a.avatar_key,
                'avatar_url', a.avatar_url,
                'body', r.body,
                'created_at', r.created_at,
                'parent_reply_id', r.parent_reply_id,
                'parent_author',   pr_author.username,
                'parent_excerpt',  case when pr.body is null then null
                                        else left(pr.body, 80) end
              ) order by r.created_at asc)
         from public.share_replies r
         join public.profiles a on a.id = r.author_id
         left join public.share_replies pr on pr.id = r.parent_reply_id
         left join public.profiles pr_author on pr_author.id = pr.author_id
        where r.share_id = p.id),
      '[]'::json
    ) as replies
  from picked p
  join public.profiles sender on sender.id = p.sender_id
  left join public.share_recipients sr2 on sr2.share_id = p.id and sr2.recipient_id = auth.uid()
  order by p.created_at asc;
$$;

grant execute on function public.get_conversation_thread(uuid, uuid, int) to authenticated;

drop function if exists public.search_users_v2(text);
create or replace function public.search_users_v2(q text)
returns table (
  id              uuid,
  username        varchar,
  avatar_key      varchar,
  avatar_url      text,
  status          text,
  mutual_count    int
)
language sql security invoker set search_path = public stable
as $$
  with q_norm as (select lower(coalesce(q, '')) as t)
  select
    p.id,
    p.username,
    p.avatar_key,
    p.avatar_url,
    (
      select f.status from public.friendships f
       where (f.requester_id = auth.uid() and f.addressee_id = p.id)
          or (f.requester_id = p.id and f.addressee_id = auth.uid())
       limit 1
    ) as status,
    (
      select count(*)::int
        from public.friendships f1
        join public.friendships f2
          on case when f1.requester_id = auth.uid() then f1.addressee_id else f1.requester_id end
           = case when f2.requester_id = p.id          then f2.addressee_id else f2.requester_id end
       where (f1.requester_id = auth.uid() or f1.addressee_id = auth.uid())
         and (f2.requester_id = p.id          or f2.addressee_id = p.id)
         and f1.status = 'accepted'
         and f2.status = 'accepted'
    ) as mutual_count
  from public.profiles p, q_norm
  where p.id <> auth.uid()
    and char_length(q_norm.t) >= 1
    and lower(p.username) like '%' || q_norm.t || '%'
  order by
    case when lower(p.username) = q_norm.t       then 0
         when lower(p.username) like q_norm.t || '%' then 1
         else 2 end,
    char_length(p.username) asc,
    lower(p.username) asc
  limit 20;
$$;

grant execute on function public.search_users_v2(text) to authenticated;

-- ===========================================================================
-- Group-invite notifications
-- ===========================================================================
-- Returns groups the caller was added to after `after`, excluding ones the
-- caller created themselves. The service worker uses this to fire browser
-- notifications when someone invites you to a group.

create or replace function public.list_new_group_memberships(
  after timestamptz default null
)
returns table (
  group_id     uuid,
  group_name   varchar,
  group_avatar_key varchar,
  group_avatar_url text,
  joined_at    timestamptz
)
language sql security invoker set search_path = public stable
as $$
  select g.id, g.name, g.avatar_key, g.avatar_url, gm.joined_at
  from public.group_members gm
  join public.groups g on g.id = gm.group_id
  where gm.member_id = auth.uid()
    and g.created_by <> auth.uid()
    and (after is null or gm.joined_at > after)
  order by gm.joined_at desc
  limit 10;
$$;

grant execute on function public.list_new_group_memberships(timestamptz) to authenticated;

-- ===========================================================================
-- Mutual friends helper + paginated friends list
-- ===========================================================================
-- mutual_friends_count(other_id) — # of accepted-friend users that the
-- caller and `other_id` share. Used by friend rows + search results.

create or replace function public.mutual_friends_count(p_other_id uuid)
returns int
language sql security invoker set search_path = public stable
as $$
  select count(*)::int
  from public.friendships f1
  join public.friendships f2
    on case when f1.requester_id = auth.uid() then f1.addressee_id else f1.requester_id end
     = case when f2.requester_id = p_other_id then f2.addressee_id else f2.requester_id end
  where (f1.requester_id = auth.uid() or f1.addressee_id = auth.uid())
    and (f2.requester_id = p_other_id or f2.addressee_id = p_other_id)
    and f1.status = 'accepted'
    and f2.status = 'accepted';
$$;

grant execute on function public.mutual_friends_count(uuid) to authenticated;

-- list_my_friends(q, after, page_size) — paginated accepted-friends list,
-- optionally filtered by a substring of username (server-side search so
-- it works across the user's entire friends list, not just the loaded
-- page). Cursor: `since` of the last row from the previous page.

create or replace function public.list_my_friends(
  q          text         default null,
  after      timestamptz  default null,
  page_size  int          default 5
)
returns table (
  friendship_id uuid,
  user_id       uuid,
  username      varchar,
  avatar_key    varchar,
  avatar_url    text,
  since         timestamptz,
  mutual_count  int
)
language sql security invoker set search_path = public stable
as $$
  with my_friends as (
    select
      f.id as friendship_id,
      case when f.requester_id = auth.uid()
           then f.addressee_id else f.requester_id end as peer_id,
      f.created_at
    from public.friendships f
    where (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
      and f.status = 'accepted'
  )
  select
    mf.friendship_id,
    p.id          as user_id,
    p.username,
    p.avatar_key,
    p.avatar_url,
    mf.created_at as since,
    public.mutual_friends_count(p.id) as mutual_count
  from my_friends mf
  join public.profiles p on p.id = mf.peer_id
  where (q is null or char_length(q) = 0 or lower(p.username) like '%' || lower(q) || '%')
    and (after is null or mf.created_at < after)
  order by mf.created_at desc
  limit greatest(1, least(page_size, 50));
$$;

grant execute on function public.list_my_friends(text, timestamptz, int) to authenticated;

-- ===========================================================================
-- Paginated get_conversations
-- ===========================================================================
-- Same shape as the v2.2 version (peer/group rows with avatar_url) but
-- now keyset-paginated by `last_at`. Cursor: the previous page's last_at.

drop function if exists public.get_conversations();
drop function if exists public.get_conversations(timestamptz, int);

create or replace function public.get_conversations(
  after      timestamptz default null,
  page_size  int         default 5
)
returns table (
  kind             text,
  peer_id          uuid,
  peer_username    varchar,
  peer_avatar_key  varchar,
  peer_avatar_url  text,
  group_id         uuid,
  group_name       varchar,
  group_color      varchar,
  group_avatar_key varchar,
  group_avatar_url text,
  last_share_id    uuid,
  last_snippet     text,
  last_sender_id   uuid,
  last_at          timestamptz,
  unread_count     int
)
language sql security invoker set search_path = public stable
as $$
  with peer_rows as (
    select
      case when s.sender_id = auth.uid() then sr.recipient_id else s.sender_id end as peer_id,
      s.id, s.sender_id, s.created_at,
      coalesce(s.note, s.og_title, s.title, s.url) as snippet,
      case when sr.recipient_id = auth.uid() and sr.read = false then 1 else 0 end as is_unread
    from public.shares s
    join public.share_recipients sr on sr.share_id = s.id
    where s.group_id is null
      and (s.sender_id = auth.uid() or sr.recipient_id = auth.uid())
  ),
  peer_agg as (
    select peer_id,
           max(created_at) as last_at,
           (array_agg(id          order by created_at desc))[1] as last_share_id,
           (array_agg(snippet     order by created_at desc))[1] as last_snippet,
           (array_agg(sender_id   order by created_at desc))[1] as last_sender_id,
           sum(is_unread)::int as unread_count
    from peer_rows
    group by peer_id
  ),
  group_rows as (
    select s.group_id, s.id, s.sender_id, s.created_at,
           coalesce(s.note, s.og_title, s.title, s.url) as snippet,
           case when sr.recipient_id is not null and sr.read = false then 1 else 0 end as is_unread
    from public.shares s
    join public.group_members gm
      on gm.group_id = s.group_id and gm.member_id = auth.uid()
    left join public.share_recipients sr
      on sr.share_id = s.id and sr.recipient_id = auth.uid()
    where s.group_id is not null
  ),
  group_agg as (
    select group_id,
           max(created_at) as last_at,
           (array_agg(id        order by created_at desc))[1] as last_share_id,
           (array_agg(snippet   order by created_at desc))[1] as last_snippet,
           (array_agg(sender_id order by created_at desc))[1] as last_sender_id,
           sum(is_unread)::int as unread_count
    from group_rows
    group by group_id
  ),
  unified as (
    select 'peer'::text as kind, p.id as peer_id, p.username as peer_username, p.avatar_key as peer_avatar_key, p.avatar_url as peer_avatar_url,
           null::uuid as group_id, null::varchar as group_name, null::varchar as group_color, null::varchar as group_avatar_key, null::text as group_avatar_url,
           pa.last_share_id, pa.last_snippet, pa.last_sender_id, pa.last_at, pa.unread_count
    from peer_agg pa
    join public.profiles p on p.id = pa.peer_id
    union all
    select 'group'::text, null::uuid, null::varchar, null::varchar, null::text,
           g.id, g.name, g.color, g.avatar_key, g.avatar_url,
           ga.last_share_id, ga.last_snippet, ga.last_sender_id, ga.last_at, ga.unread_count
    from group_agg ga
    join public.groups g on g.id = ga.group_id
  )
  select * from unified
  where (after is null or last_at < after)
  order by last_at desc nulls last
  limit greatest(1, least(page_size, 50));
$$;

grant execute on function public.get_conversations(timestamptz, int) to authenticated;

-- ===========================================================================
-- PATCH: fix get_conversation_thread (FINAL) — outgoing peer shares + parent reply fields
-- ===========================================================================
-- The earlier definitions of this function used a LEFT JOIN restricted to
-- `sr.recipient_id = auth.uid()`, then required `sr.recipient_id = p_peer_id`
-- for outgoing shares. That branch can never match (you're not the recipient
-- of your own send), so messages you sent to a peer disappeared from the
-- thread. Replaced with EXISTS subqueries that check the correct recipient
-- side for each direction.

drop function if exists public.get_conversation_thread(uuid, uuid, int);

create or replace function public.get_conversation_thread(
  p_peer_id  uuid default null,
  p_group_id uuid default null,
  page_size  int  default 50
)
returns table (
  id             uuid,
  url            text,
  title          varchar,
  note           varchar,
  platform       varchar,
  og_title       varchar,
  og_description varchar,
  og_image       text,
  sender_id      uuid,
  sender_username   varchar,
  sender_avatar_key varchar,
  sender_avatar_url text,
  direction      text,
  read           boolean,
  shared_at      timestamptz,
  replies        json
)
language sql security invoker set search_path = public stable
as $$
  with picked as (
    select s.*
    from public.shares s
    where (
      (p_peer_id is not null and s.group_id is null
        and (
          (s.sender_id = auth.uid()
            and exists (
              select 1 from public.share_recipients sr
              where sr.share_id = s.id and sr.recipient_id = p_peer_id))
          or
          (s.sender_id = p_peer_id
            and exists (
              select 1 from public.share_recipients sr
              where sr.share_id = s.id and sr.recipient_id = auth.uid()))
        ))
      or
      (p_group_id is not null and s.group_id = p_group_id
        and public.is_group_member(p_group_id))
    )
    order by s.created_at desc
    limit greatest(1, least(page_size, 200))
  )
  select
    p.id, p.url, p.title, p.note, p.platform,
    p.og_title, p.og_description, p.og_image,
    p.sender_id,
    sender.username   as sender_username,
    sender.avatar_key as sender_avatar_key,
    sender.avatar_url as sender_avatar_url,
    case when p.sender_id = auth.uid() then 'out' else 'in' end as direction,
    coalesce(sr2.read, p.sender_id = auth.uid()) as read,
    p.created_at as shared_at,
    coalesce(
      (select json_agg(json_build_object(
                'id', r.id,
                'author_id', r.author_id,
                'author', a.username,
                'avatar_key', a.avatar_key,
                'avatar_url', a.avatar_url,
                'body', r.body,
                'created_at', r.created_at,
                'parent_reply_id', r.parent_reply_id,
                'parent_author',   pr_author.username,
                'parent_excerpt',  case when pr.body is null then null
                                        else left(pr.body, 80) end
              ) order by r.created_at asc)
         from public.share_replies r
         join public.profiles a on a.id = r.author_id
         left join public.share_replies pr on pr.id = r.parent_reply_id
         left join public.profiles pr_author on pr_author.id = pr.author_id
        where r.share_id = p.id),
      '[]'::json
    ) as replies
  from picked p
  join public.profiles sender on sender.id = p.sender_id
  left join public.share_recipients sr2 on sr2.share_id = p.id and sr2.recipient_id = auth.uid()
  order by p.created_at asc;
$$;

grant execute on function public.get_conversation_thread(uuid, uuid, int) to authenticated;

-- ===========================================================================
-- Group invitations
-- ===========================================================================
-- Adding a friend to a group is now a two-step process:
--   1. Admin invites a friend  → row in group_invitations (status='pending').
--   2. Friend accepts          → row in group_members + status='accepted'.
-- This replaces the previous direct-add behavior of set_group_members for
-- new members. Existing members are unchanged; removals still happen
-- directly. Cancellations + declines just flip the row status and never
-- write to group_members.
--
-- All writes go through SECURITY DEFINER RPCs so we can atomically maintain
-- the invariants (one pending per pair; insert into group_members on accept).
-- SELECT is policy-gated so the client can read directly when needed.

create table if not exists public.group_invitations (
  id           uuid primary key default uuid_generate_v4(),
  group_id     uuid not null references public.groups(id) on delete cascade,
  invitee_id   uuid not null references public.profiles(id) on delete cascade,
  inviter_id   uuid not null references public.profiles(id) on delete cascade,
  status       varchar(10) not null default 'pending'
               check (status in ('pending','accepted','declined','cancelled')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz
);

-- One pending invite per (group, invitee). Past responses don't block a
-- re-invite — the admin can invite again after a decline/cancel.
create unique index if not exists group_invitations_one_pending_idx
  on public.group_invitations (group_id, invitee_id)
  where status = 'pending';

create index if not exists group_invitations_invitee_status_idx
  on public.group_invitations (invitee_id, status);
create index if not exists group_invitations_group_status_idx
  on public.group_invitations (group_id, status);

alter table public.group_invitations enable row level security;

-- SELECT: invitee can see own invites; group admins can see invites for
-- their groups.
drop policy if exists group_invitations_select_self_or_admin on public.group_invitations;
create policy group_invitations_select_self_or_admin on public.group_invitations for select
  to authenticated
  using (invitee_id = auth.uid() or public.is_group_admin(group_id));

-- INSERT/UPDATE/DELETE are NOT exposed via policies — the RPCs below are the
-- only path. (No policy = no access for `authenticated`.)

-- ---- RPCs --------------------------------------------------------------

-- Invite one or more friends. Skips IDs already invited (pending), already
-- members, or not friends. Returns the count of invitations actually sent.

create or replace function public.invite_to_group(
  p_group_id uuid, p_invitee_ids uuid[]
)
returns int
language plpgsql security definer set search_path = public
as $$
declare
  iid uuid;
  sent int := 0;
begin
  if not public.is_group_admin(p_group_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if p_invitee_ids is null then return 0; end if;

  foreach iid in array p_invitee_ids loop
    continue when iid = auth.uid();
    -- Friendship requirement mirrors the group_members_insert_admin policy.
    continue when not public.are_friends(auth.uid(), iid);
    -- Skip if already a member.
    continue when exists (
      select 1 from public.group_members
      where group_id = p_group_id and member_id = iid
    );
    -- Skip if there's already a pending invite (the partial unique index
    -- would also enforce this, but checking up front avoids the raised
    -- error and keeps the count honest).
    continue when exists (
      select 1 from public.group_invitations
      where group_id = p_group_id and invitee_id = iid and status = 'pending'
    );

    insert into public.group_invitations (group_id, invitee_id, inviter_id)
    values (p_group_id, iid, auth.uid());
    sent := sent + 1;
  end loop;

  return sent;
end;
$$;

revoke all on function public.invite_to_group(uuid, uuid[]) from public;
grant execute on function public.invite_to_group(uuid, uuid[]) to authenticated;

-- Invitee responds. On accept, atomically flips status + inserts the
-- group_members row. On decline, just flips status.

create or replace function public.respond_to_group_invitation(
  p_invitation_id uuid, p_accept boolean
)
returns void
language plpgsql security definer set search_path = public
as $$
declare inv record;
begin
  select * into inv from public.group_invitations
   where id = p_invitation_id;
  if not found then
    raise exception 'Invitation not found';
  end if;
  if inv.invitee_id <> auth.uid() then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if inv.status <> 'pending' then
    raise exception 'Invitation already %', inv.status;
  end if;

  if p_accept then
    update public.group_invitations
       set status = 'accepted', responded_at = now()
     where id = inv.id;
    insert into public.group_members (group_id, member_id, role)
    values (inv.group_id, inv.invitee_id, 'member')
    on conflict (group_id, member_id) do nothing;
  else
    update public.group_invitations
       set status = 'declined', responded_at = now()
     where id = inv.id;
  end if;
end;
$$;

revoke all on function public.respond_to_group_invitation(uuid, boolean) from public;
grant execute on function public.respond_to_group_invitation(uuid, boolean) to authenticated;

-- Admin (or the original inviter) cancels a pending invite.

create or replace function public.cancel_group_invitation(p_invitation_id uuid)
returns void
language plpgsql security definer set search_path = public
as $$
declare inv record;
begin
  select * into inv from public.group_invitations
   where id = p_invitation_id;
  if not found then
    raise exception 'Invitation not found';
  end if;
  if not (inv.inviter_id = auth.uid() or public.is_group_admin(inv.group_id)) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;
  if inv.status <> 'pending' then return; end if;

  update public.group_invitations
     set status = 'cancelled', responded_at = now()
   where id = inv.id;
end;
$$;

revoke all on function public.cancel_group_invitation(uuid) from public;
grant execute on function public.cancel_group_invitation(uuid) to authenticated;

-- List the current user's pending invitations, with the group + inviter
-- info needed to render the inbox row (name, color, avatar, who sent it,
-- current member count for "small group" cues).

create or replace function public.list_my_pending_group_invitations()
returns table (
  id              uuid,
  group_id        uuid,
  group_name      varchar,
  group_color     varchar,
  group_avatar_key varchar,
  group_avatar_url text,
  inviter_id      uuid,
  inviter_username varchar,
  inviter_avatar_key varchar,
  inviter_avatar_url text,
  member_count    int,
  created_at      timestamptz
)
language sql security invoker set search_path = public stable
as $$
  select
    inv.id, inv.group_id,
    g.name as group_name, g.color as group_color,
    g.avatar_key as group_avatar_key, g.avatar_url as group_avatar_url,
    inv.inviter_id,
    p.username as inviter_username,
    p.avatar_key as inviter_avatar_key,
    p.avatar_url as inviter_avatar_url,
    (select count(*)::int from public.group_members gm where gm.group_id = g.id) as member_count,
    inv.created_at
  from public.group_invitations inv
  join public.groups g on g.id = inv.group_id
  join public.profiles p on p.id = inv.inviter_id
  where inv.invitee_id = auth.uid()
    and inv.status = 'pending'
  order by inv.created_at desc;
$$;

grant execute on function public.list_my_pending_group_invitations() to authenticated;

-- Admin-side counterpart: list the *pending* invitations for one group, with
-- the invitee profile needed to render a "Pending — cancel" row in the group
-- editor. SELECT runs as invoker, so the group_invitations RLS policy
-- (invitee_id = auth.uid() OR is_group_admin(group_id)) already restricts
-- this to the group's admins; the explicit is_group_admin guard short-circuits
-- to an empty set for non-admins and documents the intent.

create or replace function public.list_group_pending_invitations(p_group_id uuid)
returns table (
  id                 uuid,
  invitee_id         uuid,
  invitee_username   varchar,
  invitee_avatar_key varchar,
  invitee_avatar_url text,
  inviter_id         uuid,
  created_at         timestamptz
)
language sql security invoker set search_path = public stable
as $$
  select
    inv.id, inv.invitee_id,
    p.username as invitee_username,
    p.avatar_key as invitee_avatar_key,
    p.avatar_url as invitee_avatar_url,
    inv.inviter_id, inv.created_at
  from public.group_invitations inv
  join public.profiles p on p.id = inv.invitee_id
  where inv.group_id = p_group_id
    and inv.status = 'pending'
    and public.is_group_admin(p_group_id)
  order by inv.created_at desc;
$$;

grant execute on function public.list_group_pending_invitations(uuid) to authenticated;

-- ===========================================================================
-- set_group_members: switch to invite-mode for new members
-- ===========================================================================
-- Removals still happen directly (admins can kick). New IDs now generate
-- invites instead of inserting into group_members. Callers don't need to
-- change — the editor still passes the desired final set; the function
-- handles the "diff" itself.

create or replace function public.set_group_members(
  p_group_id uuid, p_member_ids uuid[]
)
returns void
language plpgsql security definer set search_path = public
as $$
declare mid uuid;
begin
  if not public.is_group_admin(p_group_id) then
    raise exception 'Not authorized' using errcode = '42501';
  end if;

  -- Remove members no longer in the desired set (admin stays put).
  delete from public.group_members
   where group_id = p_group_id
     and member_id <> auth.uid()
     and (p_member_ids is null or not (member_id = any(p_member_ids)));

  -- For desired IDs that aren't yet members, create pending invites
  -- (skipping already-invited and non-friends, mirroring invite_to_group).
  if p_member_ids is null then return; end if;
  foreach mid in array p_member_ids loop
    continue when mid = auth.uid();
    continue when exists (
      select 1 from public.group_members
      where group_id = p_group_id and member_id = mid
    );
    continue when not public.are_friends(auth.uid(), mid);
    continue when exists (
      select 1 from public.group_invitations
      where group_id = p_group_id and invitee_id = mid and status = 'pending'
    );
    insert into public.group_invitations (group_id, invitee_id, inviter_id)
    values (p_group_id, mid, auth.uid());
  end loop;
end;
$$;

revoke all on function public.set_group_members(uuid, uuid[]) from public;
grant execute on function public.set_group_members(uuid, uuid[]) to authenticated;


-- ########################  BEGIN schema.v3.sql  ###########################

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

drop function if exists public.get_conversations(timestamptz, int);
create or replace function public.get_conversations(
  after timestamptz default null, page_size int default 5
)
returns table (
  kind             text,
  peer_id          uuid,
  peer_username    varchar,
  peer_avatar_key  varchar,
  peer_avatar_url  text,
  group_id         uuid,
  group_name       varchar,
  group_color      varchar,
  group_avatar_key varchar,
  group_avatar_url text,
  last_share_id    uuid,
  last_snippet     text,
  last_sender_id   uuid,
  last_at          timestamptz,
  unread_count     int
)
language sql security invoker set search_path = public stable
as $$
  with
  peer_share_rows as (
    select
      case when s.sender_id = auth.uid() then sr.recipient_id else s.sender_id end as peer_id,
      s.sender_id, s.created_at,
      coalesce(s.note, s.og_title, s.title, s.url) as snippet,
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
      coalesce(m.content, m.og_title, m.title, m.file_name, m.url) as snippet,
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
           (array_agg(snippet   order by created_at desc))[1] as last_snippet,
           (array_agg(sender_id order by created_at desc))[1] as last_sender_id,
           sum(is_unread)::int as unread_count
    from peer_rows
    where peer_id is not null
    group by peer_id
  ),
  group_share_rows as (
    select s.group_id, s.sender_id, s.created_at,
           coalesce(s.note, s.og_title, s.title, s.url) as snippet,
           case when sr.recipient_id is not null and sr.read = false then 1 else 0 end as is_unread
    from public.shares s
    join public.group_members gm on gm.group_id = s.group_id and gm.member_id = auth.uid()
    left join public.share_recipients sr on sr.share_id = s.id and sr.recipient_id = auth.uid()
    where s.group_id is not null
  ),
  group_msg_rows as (
    select m.group_id, m.sender_id, m.created_at,
           coalesce(m.content, m.og_title, m.title, m.file_name, m.url) as snippet,
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
           (array_agg(snippet   order by created_at desc))[1] as last_snippet,
           (array_agg(sender_id order by created_at desc))[1] as last_sender_id,
           sum(is_unread)::int as unread_count
    from group_rows
    group by group_id
  ),
  unified as (
    select 'peer'::text as kind, p.id as peer_id, p.username as peer_username,
           p.avatar_key as peer_avatar_key, p.avatar_url as peer_avatar_url,
           null::uuid as group_id, null::varchar as group_name, null::varchar as group_color,
           null::varchar as group_avatar_key, null::text as group_avatar_url,
           null::uuid as last_share_id, pa.last_snippet, pa.last_sender_id, pa.last_at, pa.unread_count
    from peer_agg pa
    join public.profiles p on p.id = pa.peer_id
    union all
    select 'group'::text, null::uuid, null::varchar, null::varchar, null::text,
           g.id, g.name, g.color, g.avatar_key, g.avatar_url,
           null::uuid, ga.last_snippet, ga.last_sender_id, ga.last_at, ga.unread_count
    from group_agg ga
    join public.groups g on g.id = ga.group_id
  )
  select * from unified
  where (after is null or last_at < after)
  order by last_at desc nulls last
  limit greatest(1, least(page_size, 50));
$$;

grant execute on function public.get_conversations(timestamptz, int) to authenticated;

-- Unread chat-message count for the toolbar badge (added to the existing
-- unread_share_count by the service worker, so the badge reflects both).
create or replace function public.unread_message_count()
returns int
language sql security invoker set search_path = public stable
as $$
  select count(*)::int
  from public.message_recipients mr
  where mr.recipient_id = auth.uid() and mr.read = false;
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
-- 10. Creator badge — flag specific accounts as "Creator"
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
