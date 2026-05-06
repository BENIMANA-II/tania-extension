/**
 * Tania — Supabase API Client
 *
 * Talks directly to Supabase Auth + PostgREST + RPCs. No vendored SDK,
 * no separate backend — the extension is self-contained at install time.
 *
 * Auth state lives in chrome.storage.local (managed via the service worker
 * so the badge poller and the sidepanel see the same session).
 */

import { getSupabaseConfig } from './constants.js';

// ---------------------------------------------------------------------------
// Auth helpers — talk to the service worker, which owns chrome.storage.local
// ---------------------------------------------------------------------------

export function getAuth() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_AUTH' }, (res) => {
      resolve({
        token:        res?.accessToken || null,
        refreshToken: res?.refreshToken || null,
        expiresAt:    res?.expiresAt || 0,
        user:         res?.user || null,
      });
    });
  });
}

export function setAuth(session) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'SET_AUTH', payload: session }, resolve);
  });
}

export function clearAuth() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'CLEAR_AUTH' }, resolve);
  });
}

// ---------------------------------------------------------------------------
// Low-level fetch wrapper with automatic token refresh
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let refreshPromise = null;

/**
 * Refresh the access token using the refresh token.
 * De-duplicated: parallel callers all await the same in-flight refresh.
 */
async function refreshSession() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const { refreshToken } = await getAuth();
    if (!refreshToken) throw new ApiError('No refresh token', 401);

    const { url, anonKey } = await getSupabaseConfig();
    const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!res.ok) {
      await clearAuth();
      try { window.dispatchEvent(new CustomEvent('tania:session-expired')); } catch {}
      throw new ApiError('Session expired. Please sign in again.', 401);
    }

    const data = await res.json();
    const session = sessionFromAuthResponse(data);

    // Refresh responses don't always include user_metadata.username — keep
    // the previously-known username so the UI doesn't suddenly show "null".
    if (session.user && !session.user.username) {
      const prev = await getAuth();
      if (prev.user?.username) session.user.username = prev.user.username;
    }

    await setAuth(session);
    return session;
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

/**
 * Authenticated request to PostgREST or an RPC. Refreshes if the access
 * token is within 60s of expiry; converts 401 into a session-expired event.
 */
async function request(path, options = {}) {
  const { url, anonKey } = await getSupabaseConfig();
  let { token, expiresAt } = await getAuth();

  if (token && expiresAt && expiresAt - Date.now() < 60_000) {
    try {
      const refreshed = await refreshSession();
      token = refreshed.accessToken;
    } catch {
      throw new ApiError('Session expired. Please sign in again.', 401);
    }
  }

  const headers = {
    apikey: anonKey,
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(`${url}${path}`, { ...options, headers });
  } catch {
    throw new ApiError('Cannot reach Supabase. Check your internet.', 0);
  }

  if (response.status === 401) {
    await clearAuth();
    try { window.dispatchEvent(new CustomEvent('tania:session-expired')); } catch {}
    throw new ApiError('Session expired. Please sign in again.', 401);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(
      body.message || body.error || body.msg || `Request failed (${response.status})`,
      response.status
    );
  }

  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function rpc(name, params = {}) {
  return request(`/rest/v1/rpc/${name}`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// ---------------------------------------------------------------------------
// Auth helpers — direct calls to /auth/v1 (no JWT yet, so they bypass request())
// ---------------------------------------------------------------------------

function sessionFromAuthResponse(data) {
  return {
    accessToken:  data.access_token,
    refreshToken: data.refresh_token,
    expiresAt:    Date.now() + (data.expires_in || 3600) * 1000,
    user: data.user
      ? {
          id:       data.user.id,
          email:    data.user.email,
          username: data.user.user_metadata?.username || null,
        }
      : null,
  };
}

async function authRequest(path, body) {
  const { url, anonKey } = await getSupabaseConfig();
  let response;
  try {
    response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('Cannot reach Supabase. Check your internet.', 0);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(
      data.error_description || data.msg || data.error || `Request failed (${response.status})`,
      response.status
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// Public API — same surface the sidepanel imports
// ---------------------------------------------------------------------------

export const api = {
  // ---- Auth ----

  async signup(email, username, password) {
    const data = await authRequest('/auth/v1/signup', {
      email,
      password,
      data: { username },
    });

    // Supabase returns either a full session (auto-confirm enabled — the
    // default for fresh projects) or just a user record (email confirmation
    // required). The latter is friendlier to surface as an explicit error.
    if (data.access_token) {
      const session = sessionFromAuthResponse(data);
      if (session.user && !session.user.username) session.user.username = username;
      await setAuth(session);
      return { token: session.accessToken, user: session.user };
    }

    throw new ApiError(
      'Check your inbox to confirm your email before signing in.',
      200
    );
  },

  async signin(email, password) {
    const data = await authRequest('/auth/v1/token?grant_type=password', {
      email,
      password,
    });
    const session = sessionFromAuthResponse(data);

    // user_metadata.username may be missing for accounts created before
    // the trigger landed — fall back to the profiles table.
    if (session.user && !session.user.username) {
      const rows = await request(`/rest/v1/profiles?id=eq.${session.user.id}&select=username`);
      if (rows && rows[0]) session.user.username = rows[0].username;
    }

    await setAuth(session);
    return { token: session.accessToken, user: session.user };
  },

  async me() {
    const { user } = await getAuth();
    if (!user) throw new ApiError('Not signed in', 401);
    return { user };
  },

  async updateUsername(username) {
    const { user } = await getAuth();
    if (!user) throw new ApiError('Not signed in', 401);

    const updated = await request(
      `/rest/v1/profiles?id=eq.${user.id}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ username }),
      }
    );
    if (!updated || !updated[0]) throw new ApiError('Update failed', 500);

    const next = { ...user, username: updated[0].username };
    const { token, refreshToken, expiresAt } = await getAuth();
    await setAuth({ accessToken: token, refreshToken, expiresAt, user: next });
    return { user: next };
  },

  // ---- Friends ----

  async getFriends() {
    const rows = await rpc('get_friends_view');

    const friends         = [];
    const pendingIncoming = [];
    const pendingOutgoing = [];

    for (const r of rows || []) {
      const entry = { id: r.friendship_id, user: { id: r.user_id, username: r.username } };
      if      (r.kind === 'friend')   friends.push({ ...entry, since: r.ts });
      else if (r.kind === 'incoming') pendingIncoming.push({ ...entry, receivedAt: r.ts });
      else                            pendingOutgoing.push({ ...entry, sentAt: r.ts });
    }
    return { friends, pendingIncoming, pendingOutgoing };
  },

  async searchUsers(q) {
    if (!q || q.trim().length < 2) return { users: [] };
    const rows = await rpc('search_users', { q: q.trim() });
    return {
      users: (rows || []).map((r) => ({ id: r.id, username: r.username, status: r.status })),
    };
  },

  async inviteFriend(username) {
    const rows = await rpc('invite_friend', { p_username: username });
    return { friendship: rows?.[0] || null };
  },

  async acceptFriend(friendshipId) {
    const updated = await request(
      `/rest/v1/friendships?id=eq.${friendshipId}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'accepted' }),
      }
    );
    if (!updated || !updated[0]) throw new ApiError('Request not found or already handled', 404);
    return { friendship: updated[0] };
  },

  async getPendingCount() {
    const count = await rpc('pending_friend_request_count');
    return { count: count || 0 };
  },

  // ---- Shares ----

  async share(url, recipientIds, { title, note, platform } = {}) {
    const shareId = await rpc('share_with_friends', {
      p_url:           url,
      p_recipient_ids: recipientIds,
      p_title:         title || null,
      p_note:          note || null,
      p_platform:      platform || null,
    });

    triggerOgFetch(shareId, url).catch(() => {});
    return { share: { id: shareId } };
  },

  async getFeed(cursor) {
    const rows = await rpc('get_feed', { after: cursor || null, page_size: 20 });
    const feed = (rows || []).map((r) => ({
      id:            r.id,
      url:           r.url,
      title:         r.title,
      note:          r.note,
      platform:      r.platform,
      ogTitle:       r.og_title,
      ogDescription: r.og_description,
      ogImage:       r.og_image,
      sender:        { id: r.sender_id, username: r.sender_username },
      delivered:     true,
      read:          r.read,
      readAt:        r.read_at,
      sharedAt:      r.shared_at,
    }));

    if (feed.length > 0) {
      rpc('mark_feed_delivered', { share_ids: feed.map((f) => f.id) }).catch(() => {});
    }

    const nextCursor = feed.length === 20 ? feed[feed.length - 1].sharedAt : null;
    return { feed, nextCursor };
  },

  async getSent(cursor) {
    const rows = await rpc('get_sent', { after: cursor || null, page_size: 20 });
    const sent = (rows || []).map((r) => ({
      id:            r.id,
      url:           r.url,
      title:         r.title,
      note:          r.note,
      platform:      r.platform,
      ogTitle:       r.og_title,
      ogDescription: r.og_description,
      ogImage:       r.og_image,
      sharedAt:      r.shared_at,
      recipients:    r.recipients || [],
    }));

    const nextCursor = sent.length === 20 ? sent[sent.length - 1].sharedAt : null;
    return { sent, nextCursor };
  },

  async markRead(shareId) {
    const { user } = await getAuth();
    await request(
      `/rest/v1/share_recipients?share_id=eq.${shareId}&recipient_id=eq.${user.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ read: true, read_at: new Date().toISOString() }),
      }
    );
    return { message: 'Marked as read' };
  },

  async dismissShare(shareId) {
    const { user } = await getAuth();
    await request(
      `/rest/v1/share_recipients?share_id=eq.${shareId}&recipient_id=eq.${user.id}`,
      { method: 'DELETE' }
    );
    return { message: 'Share dismissed' };
  },

  async getUnreadCount() {
    const unread = await rpc('unread_share_count');
    return { unread: unread || 0 };
  },
};

// ---------------------------------------------------------------------------
// Edge Function: og-fetch (fire-and-forget enrichment)
// ---------------------------------------------------------------------------

async function triggerOgFetch(shareId, url) {
  const cfg = await getSupabaseConfig();
  const { token } = await getAuth();
  if (!token) return;

  await fetch(`${cfg.url}/functions/v1/og-fetch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey:         cfg.anonKey,
      Authorization:  `Bearer ${token}`,
    },
    body: JSON.stringify({ shareId, url }),
  });
}
