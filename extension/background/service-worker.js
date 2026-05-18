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
    'lastNotifiedAt', 'lastGroupNotifiedAt',
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
  chrome.sidePanel.open({ tabId: tab.id });
});

// ---------------------------------------------------------------------------
// Message router (sidepanel + content script ⇄ service worker)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'GET_AUTH':
      getSession().then(sendResponse);
      return true;

    case 'SET_AUTH':
      setSession(message.payload).then(() => {
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
    const unread = await rpc('unread_share_count');
    setBadge(unread || 0);
    if ((unread || 0) > 0) await notifyNewShares();
    await notifyNewGroupInvites();
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

async function notifyNewGroupInvites() {
  const { notificationsEnabled = true, lastGroupNotifiedAt } =
    await chrome.storage.local.get(['notificationsEnabled', 'lastGroupNotifiedAt']);
  if (notificationsEnabled === false) return;

  const rows = await rpc('list_new_group_memberships', { after: lastGroupNotifiedAt || null });
  if (!rows || rows.length === 0) return;

  if (!lastGroupNotifiedAt) {
    const newest = rows.reduce((a, b) => (a.joined_at > b.joined_at ? a : b)).joined_at;
    await chrome.storage.local.set({ lastGroupNotifiedAt: newest });
    return;
  }

  const fresh = rows
    .filter((r) => r.joined_at > lastGroupNotifiedAt)
    .sort((a, b) => (a.joined_at < b.joined_at ? -1 : 1));

  for (const r of fresh) {
    chrome.notifications.create(`tania-group-${r.group_id}`, {
      type:     'basic',
      iconUrl:  chrome.runtime.getURL('icons/icon-128.png'),
      title:    'Added to a group',
      message:  `You were added to "${r.group_name}".`,
      priority: 0,
    });
  }

  if (fresh.length > 0) {
    const newest = fresh[fresh.length - 1].joined_at;
    await chrome.storage.local.set({ lastGroupNotifiedAt: newest });
  }
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
  getSession().then(({ accessToken }) => {
    if (accessToken) {
      startPolling();
      pollUnreadCount();
    }
  });
}

chrome.runtime.onStartup.addListener(resumeIfSignedIn);
chrome.runtime.onInstalled.addListener(resumeIfSignedIn);

console.log('[Tania] Service worker started.');
