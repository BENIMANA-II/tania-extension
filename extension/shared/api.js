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

    if (session.user) {
      const rows = await request(`/rest/v1/profiles?id=eq.${session.user.id}&select=username,avatar_key,avatar_url`);
      if (rows && rows[0]) {
        if (!session.user.username) session.user.username = rows[0].username;
        session.user.avatarKey = rows[0].avatar_key;
        session.user.avatarUrl = rows[0].avatar_url;
      }
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

  async updateAvatar(avatarKey) {
    const { user } = await getAuth();
    if (!user) throw new ApiError('Not signed in', 401);

    const updated = await request(
      `/rest/v1/profiles?id=eq.${user.id}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ avatar_key: avatarKey, avatar_url: null }),
      }
    );
    if (!updated || !updated[0]) throw new ApiError('Update failed', 500);

    const next = { ...user, avatarKey: updated[0].avatar_key, avatarUrl: null };
    const { token, refreshToken, expiresAt } = await getAuth();
    await setAuth({ accessToken: token, refreshToken, expiresAt, user: next });
    return { user: next };
  },

  async uploadProfileAvatar(file) {
    const { user } = await getAuth();
    if (!user) throw new ApiError('Not signed in', 401);
    const blob = await compressImage(file);
    const path = `${user.id}/${Date.now()}.jpg`;
    const publicUrl = await uploadToAvatarsBucket(path, blob);
    await request(
      `/rest/v1/profiles?id=eq.${user.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ avatar_url: publicUrl, avatar_key: null }),
      }
    );
    const next = { ...user, avatarUrl: publicUrl, avatarKey: null };
    const { token, refreshToken, expiresAt } = await getAuth();
    await setAuth({ accessToken: token, refreshToken, expiresAt, user: next });
    return { user: next };
  },

  async uploadGroupAvatar(groupId, file) {
    const blob = await compressImage(file);
    const path = `groups/${groupId}/${Date.now()}.jpg`;
    const publicUrl = await uploadToAvatarsBucket(path, blob);
    await request(
      `/rest/v1/groups?id=eq.${groupId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ avatar_url: publicUrl, avatar_key: null }),
      }
    );
    return { avatarUrl: publicUrl };
  },

  async getMyProfile() {
    const { user } = await getAuth();
    if (!user) throw new ApiError('Not signed in', 401);
    const rows = await request(`/rest/v1/profiles?id=eq.${user.id}&select=username,avatar_key,avatar_url`);
    if (!rows || !rows[0]) return { user };
    const merged = {
      ...user,
      username:  rows[0].username,
      avatarKey: rows[0].avatar_key,
      avatarUrl: rows[0].avatar_url,
    };
    const { token, refreshToken, expiresAt } = await getAuth();
    await setAuth({ accessToken: token, refreshToken, expiresAt, user: merged });
    return { user: merged };
  },

  // ---- Friends ----

  async getFriends() {
    const rows = await rpc('get_friends_view');

    const friends         = [];
    const pendingIncoming = [];
    const pendingOutgoing = [];

    for (const r of rows || []) {
      const entry = {
        id: r.friendship_id,
        user: { id: r.user_id, username: r.username, avatarKey: r.avatar_key, avatarUrl: r.avatar_url },
      };
      if      (r.kind === 'friend')   friends.push({ ...entry, since: r.ts });
      else if (r.kind === 'incoming') pendingIncoming.push({ ...entry, receivedAt: r.ts });
      else                            pendingOutgoing.push({ ...entry, sentAt: r.ts });
    }
    return { friends, pendingIncoming, pendingOutgoing };
  },

  async listMyFriends({ q, after, pageSize } = {}) {
    const rows = await rpc('list_my_friends', {
      q:         q || null,
      after:     after || null,
      page_size: pageSize || 5,
    });
    return {
      friends: (rows || []).map((r) => ({
        id: r.friendship_id,
        user: {
          id:        r.user_id,
          username:  r.username,
          avatarKey: r.avatar_key,
          avatarUrl: r.avatar_url,
        },
        since:       r.since,
        mutualCount: r.mutual_count || 0,
      })),
    };
  },

  async searchUsers(q) {
    if (!q || q.trim().length < 1) return { users: [] };
    const rows = await rpc('search_users_v2', { q: q.trim() });
    return {
      users: (rows || []).map((r) => ({
        id:          r.id,
        username:    r.username,
        avatarKey:   r.avatar_key,
        avatarUrl:   r.avatar_url,
        status:      r.status,
        mutualCount: r.mutual_count || 0,
      })),
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

  async share(url, recipientIds, { title, note, platform, groupId } = {}) {
    const shareId = await rpc('share_with_friends', {
      p_url:           url,
      p_recipient_ids: recipientIds || null,
      p_title:         title || null,
      p_note:          note || null,
      p_platform:      platform || null,
      p_group_id:      groupId || null,
    });

    triggerOgFetch(shareId, url).catch(() => {});
    return { share: { id: shareId } };
  },

  // ---- Conversations (inbox grouped by peer / group) ----

  async getConversations({ after, pageSize } = {}) {
    const rows = await rpc('get_conversations', {
      after:     after || null,
      page_size: pageSize || 5,
    });
    return {
      conversations: (rows || []).map((r) => ({
        kind:         r.kind,
        peer:         r.kind === 'peer'  ? { id: r.peer_id,  username: r.peer_username,  avatarKey: r.peer_avatar_key, avatarUrl: r.peer_avatar_url  } : null,
        group:        r.kind === 'group' ? { id: r.group_id, name: r.group_name, color: r.group_color, avatarKey: r.group_avatar_key, avatarUrl: r.group_avatar_url } : null,
        lastShareId:  r.last_share_id,
        lastSnippet:  r.last_snippet,
        lastSenderId: r.last_sender_id,
        lastAt:       r.last_at,
        unreadCount:  r.unread_count || 0,
      })),
    };
  },

  async getConversationThread({ peerId, groupId, pageSize } = {}) {
    const rows = await rpc('get_conversation_thread', {
      p_peer_id:  peerId  || null,
      p_group_id: groupId || null,
      page_size:  pageSize || 50,
    });
    const messages = (rows || []).map((r) => ({
      id:            r.id,
      url:           r.url,
      title:         r.title,
      note:          r.note,
      platform:      r.platform,
      ogTitle:       r.og_title,
      ogDescription: r.og_description,
      ogImage:       r.og_image,
      sender:        { id: r.sender_id, username: r.sender_username, avatarKey: r.sender_avatar_key, avatarUrl: r.sender_avatar_url },
      direction:     r.direction,
      read:          r.read,
      sharedAt:      r.shared_at,
      replies:       (r.replies || []).map((rep) => ({
        id:            rep.id,
        authorId:      rep.author_id,
        author:        rep.author,
        avatarKey:     rep.avatar_key,
        avatarUrl:     rep.avatar_url,
        body:          rep.body,
        createdAt:     rep.created_at,
        parentReplyId: rep.parent_reply_id || null,
        parentAuthor:  rep.parent_author   || null,
        parentExcerpt: rep.parent_excerpt  || null,
      })),
    }));
    return { messages };
  },

  async markConversationRead({ peerId, groupId } = {}) {
    await rpc('mark_conversation_read', {
      p_peer_id:  peerId  || null,
      p_group_id: groupId || null,
    });
    return { message: 'Marked as read' };
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

  // Clears the current user's *incoming* messages only.
  //
  // Drops every share_recipients row where the user is the recipient — those
  // shares disappear from their inbox. Sent shares are left alone, so the
  // people the user has shared with still see them, and a reply from any of
  // those recipients will surface the conversation again.
  //
  // RLS (`share_recipients_delete_participant`) gates the delete to the
  // user's own recipient rows.
  async clearChatHistory() {
    const { user } = await getAuth();
    if (!user) throw new Error('Not signed in');
    await request(
      `/rest/v1/share_recipients?recipient_id=eq.${user.id}`,
      { method: 'DELETE' }
    );
    return { message: 'Inbox cleared' };
  },

  // ---- Bookmarks (personal archive) ----

  async saveBookmark(url, { title, note, platform, overwrite } = {}) {
    const id = await rpc('save_bookmark', {
      p_url:       url,
      p_title:     title || null,
      p_note:      note || null,
      p_platform:  platform || null,
      p_overwrite: !!overwrite,
    });
    return { bookmark: { id } };
  },

  async saveBookmarkFromShare(shareId, note) {
    const id = await rpc('save_bookmark_from_share', {
      p_share_id: shareId,
      p_note:     note || null,
    });
    return { bookmark: { id } };
  },

  async listBookmarks(cursor) {
    const rows = await rpc('list_bookmarks', { after: cursor || null, page_size: 20 });
    const bookmarks = (rows || []).map((r) => ({
      id:            r.id,
      url:           r.url,
      title:         r.title,
      note:          r.note,
      platform:      r.platform,
      ogTitle:       r.og_title,
      ogDescription: r.og_description,
      ogImage:       r.og_image,
      sourceShareId: r.source_share_id,
      savedAt:       r.saved_at,
    }));
    const nextCursor = bookmarks.length === 20 ? bookmarks[bookmarks.length - 1].savedAt : null;
    return { bookmarks, nextCursor };
  },

  async deleteBookmark(bookmarkId) {
    await request(`/rest/v1/bookmarks?id=eq.${bookmarkId}`, { method: 'DELETE' });
    return { message: 'Bookmark removed' };
  },

  // ---- Replies on shares ----

  async listReplies(shareId) {
    const rows = await rpc('list_share_replies', { p_share_id: shareId });
    return {
      replies: (rows || []).map((r) => ({
        id:            r.id,
        authorId:      r.author_id,
        author:        r.author_username,
        body:          r.body,
        createdAt:     r.created_at,
        parentReplyId: r.parent_reply_id || null,
        parentAuthor:  r.parent_author   || null,
        parentExcerpt: r.parent_excerpt  || null,
      })),
    };
  },

  async postReply(shareId, body, parentReplyId) {
    const rows = await rpc('post_share_reply', {
      p_share_id:        shareId,
      p_body:            body,
      p_parent_reply_id: parentReplyId || null,
    });
    const r = rows?.[0];
    if (!r) throw new ApiError('Reply failed', 500);
    return {
      reply: {
        id:            r.id,
        authorId:      r.author_id,
        author:        r.author_username,
        body:          r.body,
        createdAt:     r.created_at,
        parentReplyId: r.parent_reply_id || null,
        parentAuthor:  r.parent_author   || null,
        parentExcerpt: r.parent_excerpt  || null,
      },
    };
  },

  async deleteReply(replyId) {
    await request(`/rest/v1/share_replies?id=eq.${replyId}`, { method: 'DELETE' });
    return { message: 'Reply removed' };
  },

  async replyCountsForShares(shareIds) {
    if (!shareIds || shareIds.length === 0) return { counts: {} };
    const rows = await rpc('reply_counts_for_shares', { p_share_ids: shareIds });
    const counts = {};
    for (const r of rows || []) counts[r.share_id] = r.count;
    return { counts };
  },

  // ---- Groups (shared multi-user spaces) ----

  async getGroups() {
    const rows = await rpc('get_groups_view');
    return {
      groups: (rows || []).map((g) => ({
        id:          g.id,
        name:        g.name,
        color:       g.color,
        avatarKey:   g.avatar_key,
        avatarUrl:   g.avatar_url,
        createdBy:   g.created_by,
        createdAt:   g.created_at,
        role:        g.role,
        memberCount: g.member_count,
        members:     (g.members || []).map((m) => ({
          id:        m.id,
          username:  m.username,
          avatarKey: m.avatar_key,
          avatarUrl: m.avatar_url,
          role:      m.role,
        })),
      })),
    };
  },

  async createGroup(name, { color, avatarKey } = {}) {
    const id = await rpc('create_group', {
      p_name:       name,
      p_color:      color || '#6366f1',
      p_avatar_key: avatarKey || null,
    });
    return { group: { id, name, color: color || '#6366f1', avatarKey, memberCount: 1, members: [] } };
  },

  async updateGroup(id, { name, color, avatarKey } = {}) {
    await rpc('update_group', {
      p_id:         id,
      p_name:       name || null,
      p_color:      color || null,
      p_avatar_key: avatarKey || null,
    });
    return { message: 'Group updated' };
  },

  async deleteGroup(id) {
    await request(`/rest/v1/groups?id=eq.${id}`, { method: 'DELETE' });
    return { message: 'Group deleted' };
  },

  async setGroupMembers(groupId, memberIds) {
    // Note: this RPC now *invites* new members rather than adding them
    // directly — the new member only appears in `getGroups()` after they
    // accept their invitation. Existing-member removals still happen
    // immediately. See schema.v2.sql for details.
    await rpc('set_group_members', {
      p_group_id:   groupId,
      p_member_ids: memberIds,
    });
    return { message: 'Members updated' };
  },

  // ---- Group invitations ----

  async inviteToGroup(groupId, inviteeIds) {
    const sent = await rpc('invite_to_group', {
      p_group_id:    groupId,
      p_invitee_ids: inviteeIds,
    });
    return { sent: sent || 0 };
  },

  async listMyGroupInvitations() {
    const rows = await rpc('list_my_pending_group_invitations');
    return {
      invitations: (rows || []).map((r) => ({
        id:        r.id,
        group:     {
          id:        r.group_id,
          name:      r.group_name,
          color:     r.group_color,
          avatarKey: r.group_avatar_key,
          avatarUrl: r.group_avatar_url,
        },
        inviter:   {
          id:        r.inviter_id,
          username:  r.inviter_username,
          avatarKey: r.inviter_avatar_key,
          avatarUrl: r.inviter_avatar_url,
        },
        memberCount: r.member_count || 0,
        createdAt:   r.created_at,
      })),
    };
  },

  // Admin-side: pending invites for a group, for the "Pending — cancel" rows
  // in the group editor. Returns [] for non-admins (RPC filters them out).
  async listGroupInvitations(groupId) {
    const rows = await rpc('list_group_pending_invitations', { p_group_id: groupId });
    return {
      invitations: (rows || []).map((r) => ({
        id:        r.id,
        invitee:   {
          id:        r.invitee_id,
          username:  r.invitee_username,
          avatarKey: r.invitee_avatar_key,
          avatarUrl: r.invitee_avatar_url,
        },
        inviterId: r.inviter_id,
        createdAt: r.created_at,
      })),
    };
  },

  async respondGroupInvitation(invitationId, accept) {
    await rpc('respond_to_group_invitation', {
      p_invitation_id: invitationId,
      p_accept:        !!accept,
    });
    return { message: accept ? 'Joined' : 'Declined' };
  },

  async cancelGroupInvitation(invitationId) {
    await rpc('cancel_group_invitation', { p_invitation_id: invitationId });
    return { message: 'Invitation cancelled' };
  },
};

// ---------------------------------------------------------------------------
// Avatar uploads — compress to ~256px JPEG and PUT into the public `avatars` bucket
// ---------------------------------------------------------------------------

async function compressImage(file, maxDim = 256, quality = 0.85) {
  const reader = new FileReader();
  const dataUrl = await new Promise((res, rej) => {
    reader.onload = () => res(reader.result);
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });
  // Center-crop to a square so the avatar looks correct in a circle.
  const side = Math.min(img.width, img.height);
  const sx = (img.width  - side) / 2;
  const sy = (img.height - side) / 2;
  const target = Math.min(maxDim, side);
  const canvas = document.createElement('canvas');
  canvas.width = target;
  canvas.height = target;
  canvas.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, target, target);
  return new Promise((res, rej) => canvas.toBlob((b) => b ? res(b) : rej(new Error('canvas.toBlob failed')), 'image/jpeg', quality));
}

async function uploadToAvatarsBucket(path, blob) {
  const { url, anonKey } = await getSupabaseConfig();
  const { token } = await getAuth();
  if (!token) throw new ApiError('Not signed in', 401);
  const res = await fetch(`${url}/storage/v1/object/avatars/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anonKey,
      'Content-Type': 'image/jpeg',
      'x-upsert': 'true',
      'Cache-Control': 'public, max-age=31536000',
    },
    body: blob,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ApiError(`Upload failed: ${body || res.status}`, res.status);
  }
  // Public bucket → predictable URL. Bust caches with the timestamp in the path.
  return `${url}/storage/v1/object/public/avatars/${path}`;
}

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
