/**
 * Tania — Background Service Worker
 *
 * Responsibilities:
 * - Open side panel on extension icon click
 * - Own auth state in chrome.storage.local + serve it to sidepanel/api.js
 * - Refresh Supabase access tokens before expiry
 * - Poll for unread count and update the toolbar badge
 * - Look up shared URLs for the content-script "this was shared with you" banner
 */

import { getSupabaseConfig } from '../shared/constants.js';

const POLL_ALARM            = 'tania-poll-unread';
const POLL_INTERVAL_MINUTES = 1;
const REFRESH_BUFFER_MS     = 60_000;

// ---------------------------------------------------------------------------
// Config + auth state — single source of truth lives in chrome.storage.local
// ---------------------------------------------------------------------------

const getConfig = getSupabaseConfig;

async function getSession() {
  const data = await chrome.storage.local.get(['accessToken', 'refreshToken', 'expiresAt', 'user']);
  return {
    accessToken:  data.accessToken  || null,
    refreshToken: data.refreshToken || null,
    expiresAt:    data.expiresAt    || 0,
    user:         data.user         || null,
  };
}

async function setSession(session) {
  await chrome.storage.local.set({
    accessToken:  session.accessToken,
    refreshToken: session.refreshToken,
    expiresAt:    session.expiresAt,
    user:         session.user,
  });
}

async function clearSession() {
  await chrome.storage.local.remove([
    'accessToken', 'refreshToken', 'expiresAt', 'user',
    'lastNotifiedAt', 'lastMsgNotifiedAt', 'lastInviteNotifiedAt',
    'lastAcceptedInviteAt', 'friendIdsSeen',
  ]);
}

// ---------------------------------------------------------------------------
// Token refresh (de-duplicated — parallel callers share the same refresh)
// ---------------------------------------------------------------------------

let refreshInFlight = null;

async function refreshAccessToken() {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const { refreshToken } = await getSession();
    if (!refreshToken) throw new Error('No refresh token');

    const { url, anonKey } = await getConfig();
    const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anonKey },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!res.ok) {
      await clearSession();
      throw new Error('Refresh failed');
    }

    const data = await res.json();
    const session = {
      accessToken:  data.access_token,
      refreshToken: data.refresh_token,
      expiresAt:    Date.now() + (data.expires_in || 3600) * 1000,
      user: data.user
        ? {
            id:       data.user.id,
            email:    data.user.email,
            username: data.user.user_metadata?.username || (await getSession()).user?.username || null,
          }
        : (await getSession()).user,
    };
    await setSession(session);
    return session;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

/**
 * Authenticated request to Supabase. Returns parsed JSON or null.
 * Throws on auth failure so callers can clear state.
 */
async function authedRequest(path, options = {}) {
  let { accessToken, expiresAt } = await getSession();
  const { url, anonKey } = await getConfig();

  if (accessToken && expiresAt - Date.now() < REFRESH_BUFFER_MS) {
    try {
      ({ accessToken } = await refreshAccessToken());
    } catch {
      throw new Error('Session expired');
    }
  }

  if (!accessToken) throw new Error('Not signed in');

  const res = await fetch(`${url}${path}`, {
    ...options,
    headers: {
      apikey:         anonKey,
      'Content-Type': 'application/json',
      Authorization:  `Bearer ${accessToken}`,
      ...options.headers,
    },
  });

  if (res.status === 401) {
    await clearSession();
    throw new Error('Session expired');
  }
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function rpc(name, params = {}) {
  return authedRequest(`/rest/v1/rpc/${name}`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

// ---------------------------------------------------------------------------
// Open side panel on icon click
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener((tab) => {
  chrome.storage.local.set({ isMinimized: false });
  chrome.sidePanel.open({ tabId: tab.id });
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, { type: 'HIDE_TANIA_BUBBLE' }).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// Message router (sidepanel + content script ⇄ service worker)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_AUTH':
      getSession().then(sendResponse);
      return true;

    case 'SET_AUTH':
      setSession(message.payload).then(async () => {
        // Seed notification cursors to "now" so the very first share/message/invite
        // that arrives after sign-in does fire a notification. Without this, the
        // notify* helpers each silently seed on their first run and swallow it.
        const nowIso = new Date().toISOString();
        const seed = {};
        const existing = await chrome.storage.local.get([
          'lastNotifiedAt', 'lastMsgNotifiedAt', 'lastInviteNotifiedAt', 'lastAcceptedInviteAt',
        ]);
        if (!existing.lastNotifiedAt)         seed.lastNotifiedAt         = nowIso;
        if (!existing.lastMsgNotifiedAt)      seed.lastMsgNotifiedAt      = nowIso;
        if (!existing.lastInviteNotifiedAt)   seed.lastInviteNotifiedAt   = nowIso;
        if (!existing.lastAcceptedInviteAt)   seed.lastAcceptedInviteAt   = nowIso;
        if (Object.keys(seed).length) await chrome.storage.local.set(seed);
        // friendIdsSeen seeds itself on first poll (the helper does this
        // explicitly so we don't have to RPC during sign-in here).

        sendResponse({ ok: true });
        startPolling();
        pollUnreadCount();
      });
      return true;

    case 'CLEAR_AUTH':
      clearSession().then(() => {
        sendResponse({ ok: true });
        stopPolling();
        clearBadge();
      });
      return true;

    case 'LINK_DROPPED':
      chrome.runtime.sendMessage({ type: 'RECEIVE_LINK', payload: message.payload });
      sendResponse({ ok: true });
      return false;

    case 'UPDATE_BADGE':
      pollUnreadCount();
      sendResponse({ ok: true });
      return false;

    case 'CHECK_URL':
      checkSharedUrl(message.payload.url).then(sendResponse);
      return true;

    case 'OPEN_SIDEPANEL': {
      const tabId = sender.tab?.id;
      if (tabId) {
        chrome.storage.local.set({ openedFromBubble: true, isMinimized: false });
        chrome.sidePanel.open({ tabId });
        // Hide bubble on all tabs
        chrome.tabs.query({}, (tabs) => {
          for (const t of tabs) {
            chrome.tabs.sendMessage(t.id, { type: 'HIDE_TANIA_BUBBLE' }).catch(() => {});
          }
        });
      }
      sendResponse({ ok: true });
      return false;
    }

    case 'SIDEPANEL_OPENED': {
      chrome.storage.local.set({ isMinimized: false });
      chrome.tabs.query({}, (tabs) => {
        for (const t of tabs) {
          chrome.tabs.sendMessage(t.id, { type: 'HIDE_TANIA_BUBBLE' }).catch(() => {});
        }
      });
      sendResponse({ ok: true });
      return false;
    }

    case 'MINIMIZE_SIDEPANEL': {
      chrome.storage.local.set({ isMinimized: true });
      // Show bubble on all tabs
      chrome.tabs.query({}, (tabs) => {
        for (const t of tabs) {
          chrome.tabs.sendMessage(t.id, { type: 'SHOW_TANIA_BUBBLE' }).catch(() => {});
        }
      });
      sendResponse({ ok: true });
      return false;
    }

    default:
      return false;
  }
});

// ---------------------------------------------------------------------------
// URL lookup for content-script banners
// ---------------------------------------------------------------------------

async function checkSharedUrl(url) {
  try {
    const { accessToken } = await getSession();
    if (!accessToken) return { found: false };

    const rows = await rpc('lookup_share_by_url', { p_url: url });
    if (!rows || rows.length === 0) return { found: false };

    const r = rows[0];
    return {
      found:    true,
      sender:   r.sender_username,
      note:     r.note,
      sharedAt: r.shared_at,
      shareId:  r.share_id,
      read:     r.read,
    };
  } catch (err) {
    if (err.message === 'Session expired') {
      clearBadge();
      stopPolling();
    }
    return { found: false };
  }
}

// ---------------------------------------------------------------------------
// Badge polling via chrome.alarms
// ---------------------------------------------------------------------------

function startPolling() {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_INTERVAL_MINUTES });
}

function stopPolling() {
  chrome.alarms.clear(POLL_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) pollUnreadCount();
});

async function pollUnreadCount() {
  try {
    const { accessToken } = await getSession();
    if (!accessToken) {
      clearBadge();
      return;
    }
    const [shareUnread, msgUnread, pendingInvites] = await Promise.all([
      rpc('unread_share_count'),
      rpc('unread_message_count'),
      rpc('list_my_pending_group_invitations').catch(() => []),
    ]);
    const inviteCount = Array.isArray(pendingInvites) ? pendingInvites.length : 0;
    setBadge((shareUnread || 0) + (msgUnread || 0) + inviteCount);
    if ((shareUnread || 0) > 0) await notifyNewShares();
    if ((msgUnread || 0) > 0) await notifyNewMessages();
    await notifyNewGroupInvitations();
    await notifyAcceptedGroupInvitations();
    await notifyAcceptedFriendRequests();
  } catch (err) {
    if (err.message === 'Session expired') {
      clearBadge();
      stopPolling();
    }
    // Network errors fall through silently — next alarm will retry
  }
}

// ---------------------------------------------------------------------------
// New-share notifications
// ---------------------------------------------------------------------------
// On every poll where unread > 0, fetch the most recent feed page and fire
// a system notification for any share with sharedAt > lastNotifiedAt.
// First poll after install/sign-in seeds lastNotifiedAt without firing —
// otherwise we'd notify retroactively for every existing unread share.

async function notifyNewShares() {
  const { notificationsEnabled = true, lastNotifiedAt } =
    await chrome.storage.local.get(['notificationsEnabled', 'lastNotifiedAt']);

  if (notificationsEnabled === false) return;

  const rows = await rpc('get_feed', { after: null, page_size: 5 });
  if (!rows || rows.length === 0) return;

  // Seed on first run: record the newest share without notifying.
  if (!lastNotifiedAt) {
    const newest = rows.reduce((a, b) => (a.shared_at > b.shared_at ? a : b)).shared_at;
    await chrome.storage.local.set({ lastNotifiedAt: newest });
    return;
  }

  const fresh = rows
    .filter((r) => r.shared_at > lastNotifiedAt && r.read === false)
    .sort((a, b) => (a.shared_at < b.shared_at ? -1 : 1));

  for (const r of fresh) {
    const title = `${r.sender_username} shared a link`;
    const body  = r.note || r.og_title || r.title || r.url;
    chrome.notifications.create(`tania-share-${r.id}`, {
      type:     'basic',
      iconUrl:  chrome.runtime.getURL('icons/icon-128.png'),
      title,
      message:  String(body).slice(0, 200),
      priority: 0,
    });
  }

  if (fresh.length > 0) {
    const newest = fresh[fresh.length - 1].shared_at;
    await chrome.storage.local.set({ lastNotifiedAt: newest });
  }
}

// Group invitations are accept-first now (v2 flow): you aren't a member until
// you accept, so we notify on a fresh *pending invite* rather than membership.
async function notifyNewGroupInvitations() {
  const { notificationsEnabled = true, lastInviteNotifiedAt } =
    await chrome.storage.local.get(['notificationsEnabled', 'lastInviteNotifiedAt']);
  if (notificationsEnabled === false) return;

  const rows = await rpc('list_new_group_invitations', { after: lastInviteNotifiedAt || null });
  if (!rows || rows.length === 0) return;

  if (!lastInviteNotifiedAt) {
    const newest = rows.reduce((a, b) => (a.created_at > b.created_at ? a : b)).created_at;
    await chrome.storage.local.set({ lastInviteNotifiedAt: newest });
    return;
  }

  const fresh = rows
    .filter((r) => r.created_at > lastInviteNotifiedAt)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

  for (const r of fresh) {
    chrome.notifications.create(`tania-invite-${r.invitation_id}`, {
      type:     'basic',
      iconUrl:  chrome.runtime.getURL('icons/icon-128.png'),
      title:    'Group invitation',
      message:  `${r.inviter_username} invited you to "${r.group_name}".`,
      priority: 0,
    });
  }

  if (fresh.length > 0) {
    const newest = fresh[fresh.length - 1].created_at;
    await chrome.storage.local.set({ lastInviteNotifiedAt: newest });
    // Nudge any open side panel to refresh its Groups view live. The panel
    // listens for this on a runtime message and re-runs loadGroups() if the
    // Friends view is currently active.
    chrome.runtime.sendMessage({ type: 'NEW_GROUP_INVITATIONS', count: fresh.length }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// New-message notifications (chat messages, not legacy shares)
// ---------------------------------------------------------------------------

const MSG_NOTIF_LABEL = {
  text:     '',
  image:    '\ud83d\udcf7 Photo',
  document: '\ud83d\udcce Document',
  link:     '\ud83d\udd17 Link',
};

async function notifyNewMessages() {
  const { notificationsEnabled = true, lastMsgNotifiedAt } =
    await chrome.storage.local.get(['notificationsEnabled', 'lastMsgNotifiedAt']);
  if (notificationsEnabled === false) return;

  const rows = await rpc('get_new_messages', { after: lastMsgNotifiedAt || null });
  if (!rows || rows.length === 0) return;

  // Seed on first run: record cursor without notifying.
  if (!lastMsgNotifiedAt) {
    const newest = rows.reduce((a, b) => (a.created_at > b.created_at ? a : b)).created_at;
    await chrome.storage.local.set({ lastMsgNotifiedAt: newest });
    return;
  }

  for (const r of rows) {
    const label = MSG_NOTIF_LABEL[r.message_type] || '';
    const body  = label || (r.snippet || '').slice(0, 200);
    const via   = r.group_name ? `${r.group_name} — ${r.sender_username}` : r.sender_username;
    const title = `${via} sent a message`;
    chrome.notifications.create(`tania-msg-${r.id}`, {
      type:     'basic',
      iconUrl:  chrome.runtime.getURL('icons/icon-128.png'),
      title,
      message:  body,
      priority: 0,
    });
  }

  if (rows.length > 0) {
    const newest = rows.reduce((a, b) => (a.created_at > b.created_at ? a : b)).created_at;
    await chrome.storage.local.set({ lastMsgNotifiedAt: newest });
  }
}

// ---------------------------------------------------------------------------
// Accept-notifications — fire when *your* friend request or group invite is
// accepted. Group side uses a server cursor on responded_at. Friend side
// has no accepted_at column, so we diff the current accepted-friend ID set
// against a stored snapshot. Both paths seed silently on first run.
// ---------------------------------------------------------------------------

async function notifyAcceptedGroupInvitations() {
  const { notificationsEnabled = true, lastAcceptedInviteAt } =
    await chrome.storage.local.get(['notificationsEnabled', 'lastAcceptedInviteAt']);
  if (notificationsEnabled === false) return;

  const rows = await rpc('list_new_accepted_group_invitations', { after: lastAcceptedInviteAt || null });
  if (!rows || rows.length === 0) return;

  if (!lastAcceptedInviteAt) {
    const newest = rows.reduce((a, b) => (a.responded_at > b.responded_at ? a : b)).responded_at;
    await chrome.storage.local.set({ lastAcceptedInviteAt: newest });
    return;
  }

  const fresh = rows
    .filter((r) => r.responded_at > lastAcceptedInviteAt)
    .sort((a, b) => (a.responded_at < b.responded_at ? -1 : 1));

  for (const r of fresh) {
    chrome.notifications.create(`tania-invite-accepted-${r.invitation_id}`, {
      type:     'basic',
      iconUrl:  chrome.runtime.getURL('icons/icon-128.png'),
      title:    'Invitation accepted',
      message:  `${r.invitee_username} joined "${r.group_name}".`,
      priority: 0,
    });
  }

  if (fresh.length > 0) {
    const newest = fresh[fresh.length - 1].responded_at;
    await chrome.storage.local.set({ lastAcceptedInviteAt: newest });
  }
}

async function notifyAcceptedFriendRequests() {
  const { notificationsEnabled = true, friendIdsSeen } =
    await chrome.storage.local.get(['notificationsEnabled', 'friendIdsSeen']);
  if (notificationsEnabled === false) return;

  // get_friends_view returns one row per friendship with kind in
  // ('friend' | 'incoming' | 'outgoing'). We only want fully-accepted ones,
  // so filter to kind='friend'. The RPC doesn't expose who-sent-vs-who-
  // accepted, so a newly-appearing friend can be either: the other party
  // accepted my request, or I just accepted theirs. We notify in both
  // cases — surfacing the new friendship is useful regardless.
  const rows = await rpc('get_friends_view').catch(() => []);
  const acceptedFriends = (rows || []).filter((r) => r.kind === 'friend');
  const currentIds = acceptedFriends.map((f) => f.user_id).filter(Boolean);

  if (!friendIdsSeen) {
    await chrome.storage.local.set({ friendIdsSeen: currentIds });
    return;
  }

  const seenSet = new Set(friendIdsSeen);
  const newlyAccepted = acceptedFriends.filter((f) => !seenSet.has(f.user_id));

  for (const f of newlyAccepted) {
    chrome.notifications.create(`tania-friend-accepted-${f.user_id}`, {
      type:     'basic',
      iconUrl:  chrome.runtime.getURL('icons/icon-128.png'),
      title:    'Friend request accepted',
      message:  `You and ${f.username} are now friends.`,
      priority: 0,
    });
  }

  await chrome.storage.local.set({ friendIdsSeen: currentIds });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  chrome.notifications.clear(notificationId);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id != null) {
      await chrome.sidePanel.open({ tabId: tab.id });
    }
  } catch {
    // Side panel open may fail outside a user gesture in some chromium builds.
  }
});

function setBadge(count) {
  if (count > 0) {
    chrome.action.setBadgeText({ text: count > 99 ? '99+' : String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
    chrome.action.setTitle({ title: `Tania — ${count} unread` });
  } else {
    clearBadge();
  }
}

function clearBadge() {
  chrome.action.setBadgeText({ text: '' });
  chrome.action.setTitle({ title: 'Tania' });
}

// ---------------------------------------------------------------------------
// Lifecycle: resume polling on startup / install
// ---------------------------------------------------------------------------

function resumeIfSignedIn() {
  chrome.storage.local.set({ isMinimized: false });
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      chrome.tabs.sendMessage(t.id, { type: 'HIDE_TANIA_BUBBLE' }).catch(() => {});
    }
  });
  getSession().then(async ({ accessToken }) => {
    if (!accessToken) return;
    // Mirror the SET_AUTH seeding so users on a long-lived session don't lose
    // their first post-update notification to the seed-and-skip branch in the
    // notify* helpers (cursors get wiped on sign-out but not on update).
    const nowIso = new Date().toISOString();
    const existing = await chrome.storage.local.get([
      'lastNotifiedAt', 'lastMsgNotifiedAt', 'lastInviteNotifiedAt', 'lastAcceptedInviteAt',
    ]);
    const seed = {};
    if (!existing.lastNotifiedAt)         seed.lastNotifiedAt         = nowIso;
    if (!existing.lastMsgNotifiedAt)      seed.lastMsgNotifiedAt      = nowIso;
    if (!existing.lastInviteNotifiedAt)   seed.lastInviteNotifiedAt   = nowIso;
    if (!existing.lastAcceptedInviteAt)   seed.lastAcceptedInviteAt   = nowIso;
    if (Object.keys(seed).length) await chrome.storage.local.set(seed);

    startPolling();
    pollUnreadCount();
  });
}

chrome.runtime.onStartup.addListener(resumeIfSignedIn);
chrome.runtime.onInstalled.addListener(resumeIfSignedIn);

console.log('[Tania] Service worker started.');
