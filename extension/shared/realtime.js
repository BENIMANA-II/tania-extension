/**
 * Tania — Realtime client wrapper
 *
 * Thin wrapper around the vendored @supabase/realtime-js client. The rest of
 * the app talks to Supabase over raw fetch (see api.js); Realtime is the one
 * place we need a persistent WebSocket, so the SDK is bundled locally at
 * shared/vendor/realtime-js.js (MV3 forbids loading remote code at runtime).
 *
 * One conversation channel is active at a time — we subscribe when a thread
 * opens and unsubscribe when it closes. Each channel carries:
 *   - postgres_changes on public.messages (new + edited messages), authorized
 *     by the user's JWT so Realtime applies the same RLS as a SELECT;
 *   - a `typing` broadcast event (ephemeral, not persisted);
 *   - presence (who's currently viewing the thread).
 */

import { RealtimeClient } from './vendor/realtime-js.js';
import { getSupabaseConfig } from './constants.js';
import { getAuth } from './api.js';

let client = null;
let activeChannel = null;
let activeConversationId = null;
let selfId = null;

async function ensureClient() {
  if (client) return client;
  const { url, anonKey } = await getSupabaseConfig();
  // http(s)://x.supabase.co → ws(s)://x.supabase.co/realtime/v1
  const endpoint = `${url.replace(/^http/, 'ws')}/realtime/v1`;
  client = new RealtimeClient(endpoint, { params: { apikey: anonKey } });
  return client;
}

/**
 * Subscribe to a conversation's live channel. Tears down any previously active
 * channel first (we only ever watch the open thread).
 *
 * @param {string} conversationId  peer-pair id (api.getPeerConversationId) or group id
 * @param {object} callbacks
 * @param {(row:object, isUpdate:boolean)=>void} [callbacks.onMessage]
 * @param {()=>void}                             [callbacks.onReceipt] delivered/read flipped
 * @param {(payload:object)=>void}               [callbacks.onTyping]
 * @param {(state:object)=>void}                 [callbacks.onPresence]
 */
export async function subscribeToConversation(conversationId, { onMessage, onReceipt, onTyping, onPresence } = {}) {
  await unsubscribeFromConversation();

  const c = await ensureClient();
  const { token, user } = await getAuth();
  selfId = user?.id || null;
  // Authorize the socket so postgres_changes is filtered by the messages RLS.
  if (token) c.setAuth(token);

  activeConversationId = conversationId;
  const channel = c.channel(`conversation:${conversationId}`, {
    config: {
      broadcast: { self: false },
      presence:  { key: selfId || 'anon' },
    },
  });

  if (onMessage) {
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
      (payload) => onMessage(payload.new, false)
    );
    channel.on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
      (payload) => onMessage(payload.new, true)
    );
  }

  if (onReceipt) {
    // Delivered/read flips on the sender's own messages (RLS shows the sender
    // those receipt rows).
    channel.on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'message_recipients', filter: `conversation_id=eq.${conversationId}` },
      () => onReceipt()
    );
  }

  if (onTyping) {
    channel.on('broadcast', { event: 'typing' }, ({ payload }) => onTyping(payload || {}));
  }

  if (onPresence) {
    channel.on('presence', { event: 'sync' }, () => onPresence(channel.presenceState()));
  }

  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED' && onPresence && selfId) {
      // Announce that we're viewing the thread.
      channel.track({ at: Date.now() }).catch(() => {});
    }
  });

  activeChannel = channel;
  return channel;
}

export async function unsubscribeFromConversation() {
  if (!activeChannel) return;
  const ch = activeChannel;
  activeChannel = null;
  activeConversationId = null;
  try {
    await ch.untrack().catch(() => {});
    await ch.unsubscribe();
  } catch {
    /* best-effort teardown */
  }
  if (client) {
    try { client.removeChannel(ch); } catch { /* noop */ }
  }
}

/**
 * Broadcast a typing ping on the active channel. Cheap + ephemeral — callers
 * debounce so we don't flood the socket on every keystroke.
 */
export function sendTypingIndicator(username) {
  if (!activeChannel) return;
  activeChannel.send({
    type:    'broadcast',
    event:   'typing',
    payload: { userId: selfId, username: username || null, at: Date.now() },
  }).catch(() => {});
}

/**
 * Update presence metadata for the active channel (e.g. mark idle/active).
 * Presence sync events are delivered to the onPresence callback above.
 */
export async function broadcastPresence(meta = {}) {
  if (!activeChannel || !selfId) return;
  try {
    await activeChannel.track({ at: Date.now(), ...meta });
  } catch {
    /* noop */
  }
}

export function getActiveConversationId() {
  return activeConversationId;
}
