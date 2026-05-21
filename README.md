# Tania

Share with your circle. A Chrome extension that lives in the side panel.

**v3** turns Tania into a full chat app:
- **Freeform messages** — text, links (with inline previews), images, and documents in a real composer
- **Live updates** — Supabase Realtime drives new messages, typing indicators, and read receipts
- **Read receipts** — Sent / Delivered / Read for 1:1, "Seen by N" for groups
- **Edit & delete** your own messages (24h edit window)
- **Save anything** — archive any message (link, image, or file) to your personal Saved tab, with sender attribution
- **Group invitations** — being added to a group is now accept-first

**v2** foundations:
- **Conversations** — inbox is grouped by friend or group; the Sent tab is gone
- **Groups** — shared multi-user spaces; everyone in the group sees the share and can reply
- **Replies** on every shared link, inline in the thread
- **Avatars** — pick a preset, upload a photo, or use your initials
- **Better friend search** — prefix-ranked, with mutual-friends count and highlighted matches
- **Browser notifications** when new shares/invitations arrive (toggle in Settings)

## Install (from the zip)

1. Download the latest `Tania-extension-vX.Y.Z.zip` from the [Releases](../../releases) page (or from the `releases/` folder in this repo).
2. Unzip it somewhere on your computer.
3. Open `chrome://extensions` in Chrome (or any Chromium-based browser: Edge, Brave, etc.).
4. Toggle **Developer mode** on (top-right).
5. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).
6. Pin the Tania icon to your toolbar and click it to open the side panel.

The released zip is already wired to a Supabase project — sign up with email + password and you're in.

## Repo layout

- `extension/` — the Chrome extension source (Manifest V3, side panel)
- `supabase/` — schema, RLS policies, and the `og-fetch` Edge Function
- `releases/` — packaged `.zip` builds for end users
- `server/` — **deprecated.** The original self-hosted Express/Postgres backend. The
  extension is now Supabase-only (it talks to PostgREST / Auth / Realtime / Storage
  directly via `extension/shared/`), so this is kept for reference only and is not
  required to run, build, or develop Tania.

## Develop

Edit files under `extension/`, then click the reload icon for Tania on `chrome://extensions`.

## Run against your own Supabase project

If you're forking Tania and want it to talk to **your** backend instead of the published one, see [`supabase/README.md`](./supabase/README.md) — it's a five-step setup (create project, run schema, enable email auth, deploy edge function, paste URL + anon key into `extension/shared/constants.js`).

**Schema versions.** Each migration is additive on the previous one:
- `supabase/schema.sql` — v1 base (profiles, friendships, shares).
- `supabase/schema.v2.sql` — bookmarks, replies, groups, avatars, conversation RPCs.
- `supabase/schema.v3.sql` — the chat upgrade (messages, read receipts, Realtime publication, chat-uploads bucket, unified inbox).
- `supabase/schema.v2_v3.sql` — **convenience bundle**: v2 + v3 concatenated, so you can apply everything from v2 onward in a single SQL-editor run (requires v1 already applied). After running it, enable **Realtime** on the project (the migration adds `messages` and `message_recipients` to the `supabase_realtime` publication).

## License

ISC
