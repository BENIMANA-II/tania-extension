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

create or replace function public.list_share_replies(p_share_id uuid)
returns table (
  id uuid, author_id uuid, author_username varchar,
  author_avatar_key varchar, body varchar, created_at timestamptz
)
language sql security invoker set search_path = public stable
as $$
  select r.id, r.author_id, p.username, p.avatar_key, r.body, r.created_at
  from public.share_replies r
  join public.profiles p on p.id = r.author_id
  where r.share_id = p_share_id
  order by r.created_at asc;
$$;

grant execute on function public.list_share_replies(uuid) to authenticated;

create or replace function public.post_share_reply(p_share_id uuid, p_body text)
returns table (
  id uuid, author_id uuid, author_username varchar,
  author_avatar_key varchar, body varchar, created_at timestamptz
)
language plpgsql security invoker set search_path = public
as $$
declare new_id uuid;
begin
  insert into public.share_replies (share_id, author_id, body)
  values (p_share_id, auth.uid(), p_body)
  returning share_replies.id into new_id;
  return query
    select r.id, r.author_id, p.username, p.avatar_key, r.body, r.created_at
    from public.share_replies r
    join public.profiles p on p.id = r.author_id
    where r.id = new_id;
end;
$$;

grant execute on function public.post_share_reply(uuid, text) to authenticated;

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
