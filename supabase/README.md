# Tania — Supabase backend

Tania uses Supabase (hosted Postgres + Auth + Edge Functions) so the
Chrome extension installs with just **Load unpacked** — no server to run.

## One-time setup

### 1. Create a Supabase project

1. Sign up / log in at [supabase.com](https://supabase.com).
2. Create a new project. Wait for it to provision (~2 minutes).
3. From **Settings → API**, copy:
   - **Project URL** (e.g. `https://abcd.supabase.co`)
   - **anon / public** key (long JWT starting with `eyJ...`)
   - **service_role** key — **keep this secret**, you'll use it once below.

### 2. Apply the schema

Open **SQL Editor** in the Supabase dashboard, paste the contents of
[`schema.sql`](./schema.sql), and run it. This creates:

- Tables: `profiles`, `friendships`, `shares`, `share_recipients`
- Row Level Security policies (the security gate — without these, the
  embedded anon key would let anyone read any row)
- A trigger that auto-creates a `profiles` row whenever a new
  `auth.users` row appears (reads `username` from signup metadata)
- Helper RPCs (`get_feed`, `get_sent`, `share_with_friends`, etc.)
  that the extension calls instead of building queries client-side

### 3. Enable email + password auth

**Authentication → Providers → Email**: ensure "Enable Email provider"
is on. For local development you can also disable "Confirm email" so
new signups land directly in the app — for production, leave it on.

### 4. Deploy the Edge Function

The `og-fetch` function fetches Open Graph metadata for shared links
(can't run client-side because most sites don't allow CORS).

Install the [Supabase CLI](https://supabase.com/docs/guides/cli),
then from the repo root:

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy og-fetch --no-verify-jwt
```

The `--no-verify-jwt` flag is intentional: the function re-validates
the caller's JWT implicitly when it does the PostgREST update (RLS
gates `shares.update` to `sender_id = auth.uid()`). Saves a round-trip.

### 5. Wire the extension to your project

Edit [`extension/shared/constants.js`](../extension/shared/constants.js)
and replace the two placeholder strings with your project URL + anon
key:

```js
export const SUPABASE_URL      = 'https://abcd.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
```

Then repackage / reload the extension (see the project root README).

## Why is the anon key safe to embed?

The anon key authenticates the *project*, not the *user*. By itself it
grants no access to any row — every query runs through the RLS policies
in `schema.sql`, which check `auth.uid()` against row ownership.

What you must **never** embed is the **service_role** key. That one
bypasses RLS. It only belongs in the Edge Function (where Supabase
injects it from env), or on a server you control.

## Verifying the security gate

The single most important policy is
`share_recipients_insert_friend_only`. It prevents a malicious client
from sharing to anyone they want. Smoke test it like this:

1. Sign up two accounts (A and B) in the dashboard.
2. **Don't** befriend them.
3. From an SQL editor session impersonating A, try:
   ```sql
   set request.jwt.claim.sub = '<A-uuid>';
   insert into share_recipients (share_id, recipient_id)
   values ('<some-share-A-owns>', '<B-uuid>');
   ```
4. It should fail with `new row violates row-level security policy`.
   If it succeeds, **the policies are not protecting you** — re-run
   `schema.sql` and check for errors in the SQL log.

## Schema migration vs. fresh install

`schema.sql` is written for a fresh project. If you need to evolve it
later, prefer additive migrations (new tables, new columns with
defaults, new policies) over breaking changes. The drafted RPCs are
all `create or replace`, so they're safe to re-run.
