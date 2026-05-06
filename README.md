# Tania

Share with your circle. A Chrome extension that lives in the side panel.

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

## Develop

Edit files under `extension/`, then click the reload icon for Tania on `chrome://extensions`.

## Run against your own Supabase project

If you're forking Tania and want it to talk to **your** backend instead of the published one, see [`supabase/README.md`](./supabase/README.md) — it's a five-step setup (create project, run schema, enable email auth, deploy edge function, paste URL + anon key into `extension/shared/constants.js`).

## License

ISC
