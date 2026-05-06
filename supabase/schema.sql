-- Tania — Supabase schema + RLS policies
--
-- Run this in the Supabase SQL editor on a fresh project.
-- Auth is provided by Supabase (auth.users); this file only defines
-- the public-schema tables, the policies that enforce friend-only
-- visibility, and the trigger that auto-creates a profile on signup.
--
-- Auth model: email + password (Supabase auth.users). Users pick their own
-- password at signup. The `username` lives in `public.profiles` for display +
-- friend search. Sign-in is by email + password (the original "sign in by
-- username" shortcut is replaced — Supabase Auth keys on email).

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------
-- One row per auth.users row. Holds the username (the public handle).
-- Email lives on auth.users — we don't duplicate it here.

create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   varchar(30) not null unique
             check (username ~ '^[a-zA-Z0-9_-]+$' and char_length(username) >= 2),
  created_at timestamptz not null default now()
);

create index profiles_username_lower_idx on public.profiles (lower(username));

-- ---------------------------------------------------------------------------
-- friendships
-- ---------------------------------------------------------------------------

create table public.friendships (
  id            uuid primary key default uuid_generate_v4(),
  requester_id  uuid not null references public.profiles(id) on delete cascade,
  addressee_id  uuid not null references public.profiles(id) on delete cascade,
  status        varchar(10) not null default 'pending'
                check (status in ('pending', 'accepted', 'declined')),
  created_at    timestamptz not null default now(),
  unique (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);

create index friendships_requester_idx on public.friendships (requester_id);
create index friendships_addressee_idx on public.friendships (addressee_id);

-- ---------------------------------------------------------------------------
-- shares
-- ---------------------------------------------------------------------------

create table public.shares (
  id              uuid primary key default uuid_generate_v4(),
  sender_id       uuid not null references public.profiles(id) on delete cascade,
  url             text not null check (char_length(url) <= 2048
                    and (url like 'http://%' or url like 'https://%')),
  title           varchar(300),
  note            varchar(500),
  platform        varchar(30),
  og_title        varchar(500),
  og_description  varchar(1000),
  og_image        text,
  site_icon       text,
  created_at      timestamptz not null default now()
);

create index shares_sender_created_idx on public.shares (sender_id, created_at desc);

-- ---------------------------------------------------------------------------
-- share_recipients
-- ---------------------------------------------------------------------------

create table public.share_recipients (
  id            uuid primary key default uuid_generate_v4(),
  share_id      uuid not null references public.shares(id) on delete cascade,
  recipient_id  uuid not null references public.profiles(id) on delete cascade,
  delivered     boolean not null default false,
  delivered_at  timestamptz,
  read          boolean not null default false,
  read_at       timestamptz,
  unique (share_id, recipient_id)
);

create index share_recipients_recipient_idx on public.share_recipients (recipient_id);
create index share_recipients_share_idx     on public.share_recipients (share_id);

-- ---------------------------------------------------------------------------
-- Helper: are two users accepted friends?
-- ---------------------------------------------------------------------------
-- Used by RLS policies to gate share creation/visibility.
-- SECURITY DEFINER so the function can read friendships even when the
-- caller's RLS would otherwise hide rows during recursive evaluation.

create or replace function public.are_friends(a uuid, b uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.friendships
    where status = 'accepted'
      and ((requester_id = a and addressee_id = b)
        or (requester_id = b and addressee_id = a))
  );
$$;

revoke all on function public.are_friends(uuid, uuid) from public;
grant execute on function public.are_friends(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Helpers: share-membership checks (RLS-bypassing)
-- ---------------------------------------------------------------------------
-- Used inside RLS policies to break the otherwise-recursive cycle between
-- `shares` and `share_recipients`. Without these, the shares SELECT policy
-- would query share_recipients (which has its own SELECT policy that queries
-- shares), triggering Postgres's "infinite recursion detected in policy"
-- error the moment a recipient (non-sender) reads a share.
--
-- SECURITY DEFINER lets the function read both tables ignoring RLS; we still
-- gate access by checking auth.uid() inside the function body.

create or replace function public.is_share_sender(p_share_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.shares
    where id = p_share_id and sender_id = auth.uid()
  );
$$;

revoke all on function public.is_share_sender(uuid) from public;
grant execute on function public.is_share_sender(uuid) to authenticated;

create or replace function public.is_share_recipient(p_share_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.share_recipients
    where share_id = p_share_id and recipient_id = auth.uid()
  );
$$;

revoke all on function public.is_share_recipient(uuid) from public;
grant execute on function public.is_share_recipient(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Trigger: create a profile row when a new auth.users row is inserted
-- ---------------------------------------------------------------------------
-- The username is read from raw_user_meta_data.username, which the client
-- passes when calling supabase.auth.signInWithOtp({ email, options: { data: { username } } }).
-- If username is missing or already taken, the signup will fail loudly
-- (the auth.users row still exists; the client should retry profile creation
-- or surface the error and let the user pick a new username).

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  uname text;
begin
  uname := nullif(trim(new.raw_user_meta_data->>'username'), '');
  if uname is null then
    -- No username supplied — skip profile creation; client must call
    -- a separate "claim username" RPC to set one before using the app.
    return new;
  end if;

  insert into public.profiles (id, username)
  values (new.id, uname);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- RLS — enable on all tables
-- ---------------------------------------------------------------------------

alter table public.profiles         enable row level security;
alter table public.friendships      enable row level security;
alter table public.shares           enable row level security;
alter table public.share_recipients enable row level security;

-- ---------------------------------------------------------------------------
-- profiles policies
-- ---------------------------------------------------------------------------
-- Anyone signed in can SELECT (id, username) — needed for friend search.
-- Only the owner can INSERT (handled by trigger normally) or UPDATE their row.
-- No DELETE policy — deletion happens via auth.users cascade.

create policy profiles_select_authenticated
  on public.profiles for select
  to authenticated
  using (true);

create policy profiles_insert_self
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

create policy profiles_update_self
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- friendships policies
-- ---------------------------------------------------------------------------
-- SELECT: requester or addressee can see the row.
-- INSERT: caller must be the requester. The pair-uniqueness CHECK and the
--         "no self" CHECK above prevent dupes / self-friending.
-- UPDATE: addressee can flip pending → accepted/declined.
--         (The "re-invite after decline" flow is implemented as a delete +
--         re-insert from the client to keep policies simple.)
-- DELETE: either party can remove the friendship.

create policy friendships_select_participant
  on public.friendships for select
  to authenticated
  using (auth.uid() in (requester_id, addressee_id));

create policy friendships_insert_as_requester
  on public.friendships for insert
  to authenticated
  with check (requester_id = auth.uid() and status = 'pending');

create policy friendships_update_as_addressee
  on public.friendships for update
  to authenticated
  using (addressee_id = auth.uid() and status = 'pending')
  with check (addressee_id = auth.uid() and status in ('accepted', 'declined'));

create policy friendships_delete_participant
  on public.friendships for delete
  to authenticated
  using (auth.uid() in (requester_id, addressee_id));

-- ---------------------------------------------------------------------------
-- shares policies
-- ---------------------------------------------------------------------------
-- SELECT: sender, or anyone listed in share_recipients.
-- INSERT: sender_id must equal auth.uid(). (Recipient-must-be-friend is
--         enforced by share_recipients INSERT policy below — which fires
--         in the same transaction when the client inserts both rows.)
-- UPDATE: only sender, and only metadata fields (og_*, title, note).
--         OG fields are most often written by an Edge Function — Edge
--         Functions running with the service_role key bypass RLS, so this
--         policy is for the rare client-side update.
-- DELETE: only sender. share_recipients rows cascade.

create policy shares_select_participant
  on public.shares for select
  to authenticated
  using (
    sender_id = auth.uid()
    or public.is_share_recipient(id)
  );

create policy shares_insert_as_sender
  on public.shares for insert
  to authenticated
  with check (sender_id = auth.uid());

create policy shares_update_as_sender
  on public.shares for update
  to authenticated
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid());

create policy shares_delete_as_sender
  on public.shares for delete
  to authenticated
  using (sender_id = auth.uid());

-- ---------------------------------------------------------------------------
-- share_recipients policies
-- ---------------------------------------------------------------------------
-- SELECT: the recipient, or the sender of the parent share.
-- INSERT: caller must be the sender of the parent share AND must be friends
--         with the recipient. This is the critical security gate — without
--         it, a malicious client could share to anyone.
-- UPDATE: only the recipient, and only the read/delivered flags.
-- DELETE: recipient (dismiss) or sender (revoke). share-cascade handles
--         the "share deleted" case automatically.

create policy share_recipients_select
  on public.share_recipients for select
  to authenticated
  using (
    recipient_id = auth.uid()
    or public.is_share_sender(share_id)
  );

create policy share_recipients_insert_friend_only
  on public.share_recipients for insert
  to authenticated
  with check (
    public.is_share_sender(share_id)
    and public.are_friends(auth.uid(), recipient_id)
  );

create policy share_recipients_update_as_recipient
  on public.share_recipients for update
  to authenticated
  using (recipient_id = auth.uid())
  with check (recipient_id = auth.uid());

create policy share_recipients_delete_participant
  on public.share_recipients for delete
  to authenticated
  using (
    recipient_id = auth.uid()
    or public.is_share_sender(share_id)
  );

-- ---------------------------------------------------------------------------
-- RPC: pending-incoming-count (for nav badge)
-- ---------------------------------------------------------------------------
-- The extension could just count via a SELECT, but exposing it as an RPC
-- means we can return a single integer without round-tripping rows.

create or replace function public.pending_friend_request_count()
returns integer
language sql
security invoker
set search_path = public
stable
as $$
  select count(*)::int from public.friendships
  where addressee_id = auth.uid() and status = 'pending';
$$;

grant execute on function public.pending_friend_request_count() to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: unread-share-count (for nav badge)
-- ---------------------------------------------------------------------------

create or replace function public.unread_share_count()
returns integer
language sql
security invoker
set search_path = public
stable
as $$
  select count(*)::int from public.share_recipients
  where recipient_id = auth.uid() and read = false;
$$;

grant execute on function public.unread_share_count() to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: get_friends_view
-- ---------------------------------------------------------------------------
-- One round-trip replacement for `GET /friends`. Returns one row per
-- friendship (friend / incoming / outgoing). The client splits by `kind`.

create or replace function public.get_friends_view()
returns table (
  kind          text,        -- 'friend' | 'incoming' | 'outgoing'
  friendship_id uuid,
  user_id       uuid,
  username      varchar,
  ts            timestamptz  -- friendship created_at
)
language sql
security invoker
set search_path = public
stable
as $$
  select
    case
      when f.status = 'accepted'           then 'friend'
      when f.requester_id = auth.uid()     then 'outgoing'
      else                                      'incoming'
    end                                              as kind,
    f.id                                             as friendship_id,
    case when f.requester_id = auth.uid()
         then f.addressee_id else f.requester_id end as user_id,
    p.username,
    f.created_at                                     as ts
  from public.friendships f
  join public.profiles p
    on p.id = case when f.requester_id = auth.uid()
                   then f.addressee_id
                   else f.requester_id end
  where (f.requester_id = auth.uid() or f.addressee_id = auth.uid())
    and f.status in ('accepted', 'pending')
  order by f.created_at desc;
$$;

grant execute on function public.get_friends_view() to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: search_users
-- ---------------------------------------------------------------------------
-- Replaces `GET /friends/search?q=`. Returns up to 10 users matching the
-- partial username, with the caller's friendship status to each.

create or replace function public.search_users(q text)
returns table (
  id       uuid,
  username varchar,
  status   text  -- 'pending' | 'accepted' | 'declined' | null
)
language sql
security invoker
set search_path = public
stable
as $$
  select
    p.id,
    p.username,
    (
      select f.status from public.friendships f
      where (f.requester_id = auth.uid() and f.addressee_id = p.id)
         or (f.requester_id = p.id          and f.addressee_id = auth.uid())
      limit 1
    ) as status
  from public.profiles p
  where p.id <> auth.uid()
    and char_length(q) >= 2
    and p.username ilike '%' || q || '%'
  order by p.username asc
  limit 10;
$$;

grant execute on function public.search_users(text) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: get_feed
-- ---------------------------------------------------------------------------
-- Replaces `GET /feed`. Keyset-paginated by `after` (a timestamptz from the
-- previous page's last item — the client passes `shared_at` of the last row).

create or replace function public.get_feed(
  after     timestamptz default null,
  page_size int         default 20
)
returns table (
  id              uuid,
  url             text,
  title           varchar,
  note            varchar,
  platform        varchar,
  og_title        varchar,
  og_description  varchar,
  og_image        text,
  sender_id       uuid,
  sender_username varchar,
  delivered       boolean,
  read            boolean,
  read_at         timestamptz,
  shared_at       timestamptz
)
language sql
security invoker
set search_path = public
stable
as $$
  select
    s.id,
    s.url,
    s.title,
    s.note,
    s.platform,
    s.og_title,
    s.og_description,
    s.og_image,
    sender.id        as sender_id,
    sender.username  as sender_username,
    sr.delivered,
    sr.read,
    sr.read_at,
    s.created_at     as shared_at
  from public.share_recipients sr
  join public.shares   s      on s.id      = sr.share_id
  join public.profiles sender on sender.id = s.sender_id
  where sr.recipient_id = auth.uid()
    and (after is null or s.created_at < after)
  order by s.created_at desc
  limit greatest(1, least(page_size, 50));
$$;

grant execute on function public.get_feed(timestamptz, int) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: mark_feed_delivered
-- ---------------------------------------------------------------------------
-- After fetching feed rows, the client calls this to flip undelivered rows
-- to delivered. (The original Express route fired this off as a side effect;
-- we keep it explicit here so get_feed stays a pure SELECT.)

create or replace function public.mark_feed_delivered(share_ids uuid[])
returns void
language sql
security invoker
set search_path = public
as $$
  update public.share_recipients
     set delivered = true,
         delivered_at = coalesce(delivered_at, now())
   where recipient_id = auth.uid()
     and share_id     = any(share_ids)
     and delivered    = false;
$$;

grant execute on function public.mark_feed_delivered(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: get_sent
-- ---------------------------------------------------------------------------
-- Replaces `GET /sent`. Returns shares the caller authored, with each
-- recipient's delivery + read status nested as JSON.

create or replace function public.get_sent(
  after     timestamptz default null,
  page_size int         default 20
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
  shared_at      timestamptz,
  recipients     json
)
language sql
security invoker
set search_path = public
stable
as $$
  select
    s.id,
    s.url,
    s.title,
    s.note,
    s.platform,
    s.og_title,
    s.og_description,
    s.og_image,
    s.created_at as shared_at,
    coalesce(
      (
        select json_agg(json_build_object(
          'username',    p.username,
          'delivered',   sr.delivered,
          'deliveredAt', sr.delivered_at,
          'seen',        sr.read,
          'seenAt',      sr.read_at
        ) order by p.username)
        from public.share_recipients sr
        join public.profiles p on p.id = sr.recipient_id
        where sr.share_id = s.id
      ),
      '[]'::json
    ) as recipients
  from public.shares s
  where s.sender_id = auth.uid()
    and (after is null or s.created_at < after)
  order by s.created_at desc
  limit greatest(1, least(page_size, 50));
$$;

grant execute on function public.get_sent(timestamptz, int) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: lookup_share_by_url
-- ---------------------------------------------------------------------------
-- Replaces `GET /shares/lookup?url=`. Used by the content-script banner.

create or replace function public.lookup_share_by_url(p_url text)
returns table (
  share_id        uuid,
  sender_username varchar,
  note            varchar,
  read            boolean,
  shared_at       timestamptz
)
language sql
security invoker
set search_path = public
stable
as $$
  select
    s.id,
    sender.username,
    s.note,
    sr.read,
    s.created_at
  from public.share_recipients sr
  join public.shares   s      on s.id      = sr.share_id
  join public.profiles sender on sender.id = s.sender_id
  where sr.recipient_id = auth.uid()
    and s.url = p_url
  order by s.created_at desc
  limit 1;
$$;

grant execute on function public.lookup_share_by_url(text) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: share_with_friends
-- ---------------------------------------------------------------------------
-- Replaces `POST /share`. Atomic: if any recipient isn't an accepted friend,
-- the share_recipients RLS check fails and the whole transaction rolls back —
-- so partial sends are impossible.

create or replace function public.share_with_friends(
  p_url           text,
  p_recipient_ids uuid[],
  p_title         text default null,
  p_note          text default null,
  p_platform      text default null
)
returns uuid                                      -- the new share's id
language plpgsql
security invoker
set search_path = public
as $$
declare
  new_id uuid;
  rid    uuid;
begin
  if p_recipient_ids is null or array_length(p_recipient_ids, 1) is null then
    raise exception 'at least one recipient required' using errcode = '22023';
  end if;

  insert into public.shares (sender_id, url, title, note, platform)
  values (auth.uid(), p_url, p_title, p_note, p_platform)
  returning id into new_id;

  foreach rid in array p_recipient_ids loop
    insert into public.share_recipients (share_id, recipient_id)
    values (new_id, rid);
  end loop;

  return new_id;
end;
$$;

grant execute on function public.share_with_friends(text, uuid[], text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: invite_friend
-- ---------------------------------------------------------------------------
-- Replaces `POST /friends/invite`. Looks up the username, validates it isn't
-- self, and inserts (or "re-invites" if a previous decline exists) atomically.
-- Returns the friendship row.

create or replace function public.invite_friend(p_username text)
returns table (
  id           uuid,
  requester_id uuid,
  addressee_id uuid,
  status       varchar,
  created_at   timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  target_id  uuid;
  existing   public.friendships%rowtype;
begin
  select prof.id into target_id
  from public.profiles prof
  where prof.username = p_username;

  if target_id is null then
    raise exception 'User not found' using errcode = 'P0002';
  end if;

  if target_id = auth.uid() then
    raise exception 'Cannot add yourself' using errcode = '22023';
  end if;

  -- Look for an existing friendship in either direction
  select * into existing
  from public.friendships f
  where (f.requester_id = auth.uid() and f.addressee_id = target_id)
     or (f.requester_id = target_id  and f.addressee_id = auth.uid());

  if found then
    if existing.status = 'accepted' then
      raise exception 'Already friends' using errcode = '23505';
    end if;
    if existing.status = 'pending' then
      raise exception 'Request already pending' using errcode = '23505';
    end if;
    -- declined → delete and re-insert as a fresh pending request
    delete from public.friendships where id = existing.id;
  end if;

  insert into public.friendships (requester_id, addressee_id, status)
  values (auth.uid(), target_id, 'pending');

  return query
    select f.id, f.requester_id, f.addressee_id, f.status, f.created_at
    from public.friendships f
    where f.requester_id = auth.uid() and f.addressee_id = target_id;
end;
$$;

grant execute on function public.invite_friend(text) to authenticated;

-- ---------------------------------------------------------------------------
-- RPC: claim_username
-- ---------------------------------------------------------------------------
-- Used when signup didn't include a username (the trigger's fallback path).
-- The client calls this after auth.signUp to set the username on the profile.

create or replace function public.claim_username(p_username text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_username !~ '^[a-zA-Z0-9_-]+$' or char_length(p_username) < 2
     or char_length(p_username) > 30 then
    raise exception 'Invalid username' using errcode = '22023';
  end if;

  insert into public.profiles (id, username)
  values (auth.uid(), p_username)
  on conflict (id) do update set username = excluded.username
  where public.profiles.id = auth.uid();
end;
$$;

grant execute on function public.claim_username(text) to authenticated;
