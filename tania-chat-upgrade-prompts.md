# Tania Chat Upgrade — Implementation Prompts

> 17 prompts organized by theme for transforming Tania from a link-sharing extension into a full chat application.

---

## Group 1: Branding Cleanup

### Prompt 1: Remove SPYDER branding from loader

**Goal:** Remove the "SPYDER" text and spider SVG icons from the splash loader.

**File:** `extension/sidepanel/index.html:26`

**Change:** In the `.loader__credit` element, remove the spyder SVGs and the `<span class="spyder-brand">SPYDER</span>` text. The loader credit line should be removed entirely or replaced with a simple "Tania" branding.

**File:** `extension/sidepanel/styles/panel.css:342-363`

**Change:** Remove the `.loader__credit`, `.spyder-brand`, and `.spyder-icon` CSS rules.

---

## Group 2: Schema & Backend (Supabase)

### Prompt 2: Create messages table + extend schema

**File:** `supabase/schema.v2.sql`

**Goal:** Add a `messages` table alongside the existing `shares` table. A `messages` row represents a single chat message — text, image, file, or link. Shares become a type of message.

**New table `public.messages`:**

```sql
create table public.messages (
  id              uuid primary key default uuid_generate_v4(),
  conversation_id uuid not null,
  sender_id       uuid not null references public.profiles(id) on delete cascade,
  content         text,
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
  created_at      timestamptz not null default now()
);
```

**Conceptually:**
- For peer-to-peer conversations, derive a stable `conversation_id` (e.g., `uuid_generate_v5(uuid_ns_oid(), least(sender_id, recipient_id) || greatest(sender_id, recipient_id))`) so both sides share the same conversation ID.
- For group conversations, `conversation_id = group_id`.
- Link shares from the old `shares` table continue to work; new messages go into `messages`.
- The `shares` table remains for backward compatibility with existing data.

**RLS policies for `messages`:**
- SELECT: user must be a participant in the conversation (sender, recipient in peer conversation, or group member for group conversations).
- INSERT: sender_id must = auth.uid(). For peer messages, the recipient must be an accepted friend. For group messages, the sender must be a group member.
- UPDATE: only the sender can edit (within a time window, e.g., 24h), only `content` and `edited_at` fields.
- Soft-delete: sender sets `deleted_at`.

**Helper function for peer conversation lookup:**
```sql
create or replace function public.get_peer_conversation_id(p_peer_id uuid)
returns uuid language sql stable as $$
  select uuid_generate_v5(uuid_ns_oid(), least(auth.uid()::text, p_peer_id::text) || greatest(auth.uid()::text, p_peer_id::text));
$$;
```

**Indexes:** Create indexes on `messages(conversation_id, created_at desc)` and `messages(sender_id)`.

---

### Prompt 3: Fix access control security

**Goal:** Ensure users cannot access messages, chats, or conversations they are not participants in.

**Audit all RLS policies in:** `supabase/schema.sql` and `supabase/schema.v2.sql`

**Check each table:**

1. **`messages`** (new) — SELECT policy must check: user is sender OR (for peer convos) user is the recipient OR (for group convos) user is a group member. Use security-definer helpers to break recursive checks.

2. **`shares`** — Verify the existing `shares_select_participant` policy correctly restricts:
   - sender can see their sent shares
   - recipients can see shares sent to them
   - group members can see group shares (already covered)
   - No one else can see the row

3. **`share_recipients`** — Verify `share_recipients_select` correctly restricts to the recipient or the share sender.

4. **`share_replies`** — Verify `share_replies_select_participant` uses `is_share_visible_to_me` which checks sender, recipient, or group member.

5. **`bookmarks`** — Fine (owner only).

6. **`groups` / `group_members`** — Verify `groups_select_member` and `group_members_select_member` only show data to members.

**Add a security audit RPC** that a developer can run to list all rows a user can see across all tables, to verify no leakage.

---

### Prompt 4: Group invitations system

**Goal:** When someone adds a user to a group, the user receives an invitation that they must accept before appearing as a member.

**Current behavior:** `set_group_members` in `supabase/schema.v2.sql:549` directly inserts into `group_members`.

**New approach:**

1. **Create `public.group_invitations` table:**
```sql
create table public.group_invitations (
  id           uuid primary key default uuid_generate_v4(),
  group_id     uuid not null references public.groups(id) on delete cascade,
  inviter_id   uuid not null references public.profiles(id) on delete cascade,
  invitee_id   uuid not null references public.profiles(id) on delete cascade,
  status       varchar(10) not null default 'pending'
               check (status in ('pending', 'accepted', 'declined')),
  created_at   timestamptz not null default now(),
  unique (group_id, invitee_id)
);
alter table public.group_invitations enable row level security;
```

2. **RLS for group_invitations:**
- SELECT: invitee can see their pending invites; inviter/admin can see invites they sent/manage.
- INSERT: only group admins can invite (policy checks `is_group_admin`).
- UPDATE: invitee can accept/decline their own pending invite.

3. **Modify `set_group_members`** to not directly insert members. Instead, split into:
   - `invite_to_group(group_id, invitee_ids)` — creates pending invitations (admin only)
   - `respond_to_group_invitation(invitation_id, accept)` — invitee accepts/declines
   - `cancel_group_invitation(invitation_id)` — admin cancels a pending invite

4. **Update the `get_groups_view`** RPC to exclude users with pending/declined invitations (only show groups where `group_members` row exists with status `active`).

5. **Add `list_my_pending_group_invitations` RPC** that returns pending invites for the current user with group details + inviter info.

6. **Modify `get_groups_view`** to add a `status` column ('member') or include pending invitations in a separate field.

**Also update the notifications system** in `extension/background/service-worker.js` to poll for new group invitations and fire notifications.

---

### Prompt 5: Group permissions model

**Goal:** Enforce proper role-based permissions for groups.

**Current schema:** `group_members` has `role` column with `admin` or `member`.

**Changes needed:**

1. **RLS for `groups` table:**
   - SELECT: any member (already done)
   - UPDATE: only admins can update `name`. Both admins and members can update `avatar_key` and `avatar_url`.

   Modify `groups_update_admin` policy or create a more granular one:
   ```sql
   create policy groups_update_member_fields on public.groups for update
     to authenticated
     using (public.is_group_member(id))
     with check (
       public.is_group_member(id)
       and (
         -- admins can change everything
         public.is_group_admin(id)
         or
         -- members can only change avatar fields
         (new.avatar_key is not distinct from old.avatar_key
          and new.avatar_url is not distinct from old.avatar_url
          and new.name = old.name
          and new.color = old.color)
       )
     );
   ```

2. **`group_members` RLS:**
   - SELECT: any group member can see the member list (already done)
   - INSERT: only admins can add members (already done, but now this inserts into `group_invitations` instead)
   - DELETE: only admins can remove other members; a member can leave themselves (already done)

3. **Update `update_group` RPC** to check admin status for name changes but allow any member for avatar changes.

4. **Update `delete_group`** — only admins.

---

## Group 3: Real-time Infrastructure

### Prompt 6: Supabase Realtime setup

**Goal:** Set up Supabase Realtime for live messaging, typing indicators, and presence.

**Files to create/modify:**
- `extension/shared/realtime.js` (new file)
- `extension/background/service-worker.js`
- `extension/sidepanel/index.js`

**Implementation:**

1. **Create `extension/shared/realtime.js`** — a Realtime client wrapper:
   ```js
   import { getSupabaseConfig } from './constants.js';
   import { getAuth } from './api.js';

   let channel = null;

   export function subscribeToConversation(conversationId, callbacks) {
     // callbacks: { onMessage, onTyping, onPresence }
   }

   export function unsubscribeFromConversation(conversationId) {}

   export async function sendTypingIndicator(conversationId) {}

   export async function broadcastPresence(conversationId, status) {}
   ```

   Use the Supabase Realtime JavaScript client or the raw WebSocket endpoint. The Realtime endpoint is: `wss://<project>.supabase.co/realtime/v1/websocket?apikey=<anon-key>&vsn=1.0.0`

2. **Realtime channels:**
   - `conversation:{id}` — for new messages, typing indicators, presence
   - Subscribe when opening a thread, unsubscribe when leaving

3. **Replace 30s polling** in `extension/background/service-worker.js` with:
   - A Realtime subscription for new conversations/unread count changes
   - Or keep polling at a reduced interval (60s) as fallback but use Realtime for the active conversation

4. **Add Realtime client as dependency** — either use the Supabase JS SDK or implement a lightweight WebSocket client.

---

### Prompt 7: Typing indicators with Realtime

**Goal:** Show when another user is typing in the current conversation.

**Files:**
- `extension/shared/realtime.js`
- `extension/sidepanel/index.js`

**Implementation:**

1. **In `realtime.js`:** When the user types in the message input, broadcast a `typing:start` event on the conversation channel. After 2 seconds of no typing, broadcast `typing:stop`.

2. **In `index.js`:**
   - Listen for `typing:start` / `typing:stop` events on the subscribed channel.
   - Show a "User is typing..." indicator below the message list (or in the header).
   - Use a debounce: if multiple typing events arrive, keep showing the indicator. Hide after a timeout (e.g., 3 seconds after the last `typing:start` or on `typing:stop`).

3. **Add a `<div id="typing-indicator">`** to `index.html` in the thread view, positioned between messages and the composer.

4. **CSS** — subtle, non-intrusive indicator, e.g., italic text with a small animated dots.

---

## Group 4: Chat Features

### Prompt 8: Freeform text messages + remove top drop zone

**Goal:** Users can type and send freeform text messages. Remove the dedicated link-sharing drop zone at the top of the inbox view. Drag-drop links works inside the chat composer.

**Files:**
- `extension/sidepanel/index.html`
- `extension/sidepanel/index.js`
- `extension/sidepanel/styles/panel.css`

**Changes to `index.html`:**
1. Remove the `<section id="drop-zone" class="drop-zone">` block entirely.
2. Keep the "Start chat" button.
3. The thread view's share composer (`#thread-share-form`) becomes a general message composer. Rename it conceptually. Add a text input area for composing messages.
4. Add a "+" or attach button in the composer for image/document uploads.
5. Keep the URL input field — when a user pastes a URL and hits send, it sends as a `link` type message with preview.

**Changes to `index.js`:**
1. Remove `dropZone` event listeners (`dragenter`, `dragover`, `dragleave`, `drop`).
2. Remove the `openPicker()` flow entirely (the friend picker for link sharing is replaced by inline chat).
3. Remove `successAnimation()` and `rejectAnimation()` functions.
4. Replace the thread share form with a general message composer:
   - Text input (not just URL)
   - When a user types a URL, auto-detect and show preview
   - Send button sends a `messages` row with appropriate type
5. Remove friend picker overlay logic (`#friend-picker`, `openPicker`, `closePicker`, etc.) or repurpose it.

**Changes to `panel.css`:**
1. Remove all `.drop-zone*` CSS rules.
2. Remove picker overlay styles or keep them for other uses.

---

### Prompt 9: Link previews render inline in text messages

**Goal:** When a URL is detected in a text message, render a link preview card inline within the message bubble (not as a separate UI element).

**File:** `extension/sidepanel/index.js`

**Implementation:**

1. In the thread message renderer, when displaying a message of type `link`, show:
   - The message bubble containing the text
   - Below the text (or replacing it), a link preview card similar to the existing `preview-card` but styled to fit inside the chat bubble
   - The card shows: platform badge (if detected), OG title, OG description, OG image, URL

2. Modify `renderThreadMessage` to handle the new `messages` structure:
   - If `message_type === 'link'`, render the link preview inside the bubble
   - If `message_type === 'image'`, render the image
   - If `message_type === 'text'`, render just the text

3. Keep `buildLinkPreview` and `buildPlatformBadge` from `link-utils.js` — use them when rendering link-type messages.

---

### Prompt 10: Image and document uploads in chat

**Goal:** Users can upload images and documents (no videos) in the chat composer.

**Files:**
- `extension/shared/api.js`
- `extension/sidepanel/index.js`
- `extension/sidepanel/index.html`
- `supabase/schema.v2.sql`

**Implementation:**

1. **Supabase:** Add a storage bucket `chat-uploads` (similar to the existing `avatars` bucket). RLS policies:
   - SELECT: any authenticated user can read (public bucket)
   - INSERT: any authenticated user can upload to their own folder (`<user_id>/...`)
   - Only images (JPEG, PNG, GIF, WebP) and documents (PDF, DOC, DOCX, TXT, etc.) allowed — enforced via MIME type check in the application.

2. **API client (`api.js`):** Add methods:
   - `api.uploadMessageFile(file, conversationId)` — compress images (like existing avatar compression), upload to storage, return file path + URL
   - `api.sendMessage({ conversationId, content, messageType, filePath, fileName, fileSize, mimeType, url, platform, title })`

3. **UI:** Add an attach button in the message composer that opens a file picker. Show a preview of the selected file before sending. Send as a `message_type = 'image'` or `'document'`.

4. **Rendering:** In the thread, render:
   - Images: inline image with lightbox click
   - Documents: icon + filename + download link

---

### Prompt 11: Message editing and deletion

**Goal:** Users can edit or delete (soft-delete) their own messages.

**Files:**
- `extension/shared/api.js`
- `extension/sidepanel/index.js`

**API methods to add to `api.js`:**
```js
async editMessage(messageId, newContent) {
  await request(`/rest/v1/messages?id=eq.${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ content: newContent, edited_at: new Date().toISOString() }),
  });
  return { message: 'Edited' };
}

async deleteMessage(messageId) {
  await request(`/rest/v1/messages?id=eq.${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ deleted_at: new Date().toISOString() }),
  });
  return { message: 'Deleted' };
}
```

**UI changes in `index.js`:**

1. On each message bubble (outgoing), add a context menu or "..." button with Edit and Delete options.
2. **Edit:** Replace the message text with an inline input pre-filled with the current content. On save, call `api.editMessage()` and update the UI. Show "(edited)" next to edited messages.
3. **Delete:** Call `api.deleteMessage()`. Replace the message content with "[deleted]" or remove the bubble entirely with an animation, depending on preference.
4. Only show edit/delete on the user's own messages.
5. Enforce an edit window (e.g., 24 hours) — check `created_at` before showing the edit button.

---

### Prompt 12: Read receipts / delivery status

**Goal:** Show delivery status and read receipts for messages.

**Schema:** Add a `message_recipients` table or extend the `messages` table:
```sql
create table public.message_recipients (
  id           uuid primary key default uuid_generate_v4(),
  message_id   uuid not null references public.messages(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  delivered    boolean not null default false,
  delivered_at timestamptz,
  read         boolean not null default false,
  read_at      timestamptz,
  unique (message_id, recipient_id)
);
```

**RLS:** Same pattern as `share_recipients` — recipient can update `read` and `delivered`, sender can see the status.

**UI changes in `index.js`:**
1. Below each outgoing message, show a small status indicator:
   - "Sent" (default)
   - "Delivered" (when `delivered = true`)
   - "Read" (when `read = true`) — show a read icon or "Seen"
2. For group messages, show the count of read receipts (e.g., "Seen by 3")
3. Update the status in real-time via Realtime subscriptions.

**In `background/service-worker.js`:**
- When a conversation thread is open, mark messages as delivered.
- When the user scrolls to a message or it's in view, mark it as read after a short delay.

---

## Group 5: UI/UX Changes

### Prompt 13: Fixed header + navbar, scrollable chat area

**Goal:** The header and bottom navigation should remain fixed while the chat area scrolls independently.

**Current issue:** The `#view-app` layout doesn't properly constrain the chat area between the header and nav.

**Files:**
- `extension/sidepanel/styles/panel.css`
- `extension/sidepanel/index.html`

**CSS Changes:**

```css
/* Make view-app a full-height flex column */
#view-app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

/* Header stays at top */
.header {
  flex-shrink: 0;
  position: sticky;
  top: 0;
  z-index: 40;
}

/* Inbox view fills remaining space and scrolls */
.view-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* Thread messages scroll independently */
.thread-messages {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}

/* Nav stays at bottom */
.nav {
  flex-shrink: 0;
  position: sticky;
  bottom: 0;
}
```

**Apply this to all views** (`#view-inbox`, `#view-thread`, `#view-saved`, `#view-friends`, `#view-settings`). Use flexbox to ensure each view fills the available space between header and nav.

**Thread view** specifically needs the messages area to grow and scroll, while the composer stays at the bottom.

---

### Prompt 14: Show sender info on saved bookmarks

**Goal:** In the Saved tab, each bookmark displays who originally shared the link.

**File:** `extension/sidepanel/index.js`

**Changes:**

1. **Schema:** The `bookmarks` table already has `source_share_id`. The `save_bookmark_from_share` RPC needs to also store the sender username. Either:
   - Add `source_sender_id` and `source_sender_username` columns to `bookmarks`, populated when saving from a share.
   - Or join through `shares` table when listing bookmarks.

2. **`list_bookmarks` RPC:** Modify to include `source_sender_username` and `source_sender_avatar` by joining through `source_share_id -> shares -> profiles`.

3. **`renderBookmarkItem`:** Add a line showing who shared it:
   ```html
   <div class="bookmark__sender">
     Shared by <span class="bookmark__sender-name">${escapeHtml(b.sourceSenderUsername)}</span>
   </div>
   ```

4. **For manually saved bookmarks** (not from a share), show "Saved by you" or omit.

---

### Prompt 15: Save images/files to Saved tab

**Goal:** Users can save any message (including images and files) to their personal Saved archive, not just links.

**File:** `extension/shared/api.js`
**File:** `extension/sidepanel/index.js`

**Changes to `api.js`:**

1. Add a general `saveMessageToArchive` method:
```js
async saveMessageToArchive(messageId) {
  const id = await rpc('save_message_to_archive', { p_message_id: messageId });
  return { bookmark: { id } };
}
```

2. Create the RPC `save_message_to_archive` that copies the message's content (text, file path, etc.) into the `bookmarks` table, setting appropriate fields:
   - For images: `url` = storage URL of the image, `title` = file name, `note` = message content
   - For documents: same approach
   - For links: similar to existing `save_bookmark_from_share`

**UI changes in `index.js`:**
- Add a "Save" button to every message bubble (not just shares).
- The saved view already renders cards — extend `renderBookmarkItem` to handle image and document bookmarks (show thumbnail for images, file icon + name for documents).

**Extension to `bookmarks` table:**
Add columns `message_type`, `file_path`, `file_name`, `mime_type`, `source_message_id` to handle non-link bookmarks.

---

### Prompt 16: Show other users' profile pictures in chat

**Goal:** User avatars (profile pictures) are displayed in the chat UI — in the conversation list, thread headers, and inline in message bubbles.

**Current state:** The `avatarHtml()` function already handles this. It checks `avatarUrl` (uploaded photo) first, then `avatarKey` (emoji preset), then falls back to initial.

**Files to check/update:**
- `extension/sidepanel/index.js`
- `extension/sidepanel/lib/avatars.js`
- `extension/shared/api.js`

**Steps:**

1. **Ensure all RPCs return `avatar_url`** — The v2 schema already added `avatar_url` to most RPCs. Verify:
   - `get_conversations` returns `peer_avatar_url`
   - `get_conversation_thread` returns `sender_avatar_url` and reply `avatar_url`
   - `get_friends_view` returns `avatar_url`
   - `search_users_v2` returns `avatar_url`
   - `get_groups_view` returns member `avatar_url`

2. **In `renderConversationRow`** — pass `c.peer.avatarUrl` to `avatarHtml()` (already done).

3. **In `renderThreadMessage`** — the sender avatar is already rendered. Ensure the `avatarUrl` field from the API response is passed.

4. **In `friendRowHtml`** and other friend rendering — already passes `avatarUrl`.

5. **Add missing avatar renders** wherever a username is displayed without an avatar (group member lists, pending requests, etc.).

6. **Ensure `api.getMyProfile()`** updates `currentUser.avatarUrl` so settings displays the correct avatar.

---

## Group 6: Cleanup & Removal

### Prompt 17: Remove Express server dependency

**Goal:** The extension works Supabase-only. The Express server is deprecated but can remain in the repo for reference.

**Action:** This is informational — the extension already talks to Supabase directly via `shared/api.js`. No code changes needed, just document that the server is optional.

**If desired:** Remove the server from CI/CD, README references, etc. But the code can stay as-is.
