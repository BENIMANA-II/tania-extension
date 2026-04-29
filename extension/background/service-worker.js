/**
 * Tania — Background Service Worker
 *
 * Responsibilities:
 * - Open side panel on extension icon click
 * - Route messages between content scripts and side panel
 * - Manage auth state in chrome.storage
 * - Poll for unread count and update extension badge
 */

const API_BASE_DEFAULT = 'http://localhost:3000/api';
const POLL_ALARM = 'tania-poll-unread';
const POLL_INTERVAL_MINUTES = 1;

/** Resolve API base from storage (supports production override). */
async function getApiBase() {
  const data = await chrome.storage.local.get(['apiBase']);
  return data.apiBase || API_BASE_DEFAULT;
}

// --- Open side panel on icon click ---

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// --- Central message router ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'GET_AUTH':
      chrome.storage.local.get(['token', 'user'], (data) => {
        sendResponse({ token: data.token || null, user: data.user || null });
      });
      return true;

    case 'SET_AUTH':
      chrome.storage.local.set({
        token: message.payload.token,
        user: message.payload.user,
      }, () => {
        sendResponse({ ok: true });
        // Start polling now that we're logged in
        startPolling();
        pollUnreadCount();
      });
      return true;

    case 'CLEAR_AUTH':
      chrome.storage.local.remove(['token', 'user'], () => {
        sendResponse({ ok: true });
        stopPolling();
        clearBadge();
      });
      return true;

    case 'LINK_DROPPED':
      chrome.runtime.sendMessage({
        type: 'RECEIVE_LINK',
        payload: message.payload,
      });
      sendResponse({ ok: true });
      return false;

    case 'UPDATE_BADGE':
      pollUnreadCount();
      sendResponse({ ok: true });
      return false;

    case 'CHECK_URL':
      checkSharedUrl(message.payload.url).then(sendResponse);
      return true; // async

    default:
      return false;
  }
});

// --- URL lookup for content script banners ---

async function checkSharedUrl(url) {
  try {
    const apiBase = await getApiBase();
    const data = await chrome.storage.local.get(['token']);
    if (!data.token) return { found: false };

    const response = await fetch(
      `${apiBase}/shares/lookup?url=${encodeURIComponent(url)}`,
      { headers: { 'Authorization': `Bearer ${data.token}` } }
    );

    if (response.status === 204) return { found: false };
    if (response.status === 401) {
      // Token expired — clear state so side panel picks it up
      await chrome.storage.local.remove(['token', 'user']);
      clearBadge();
      stopPolling();
      return { found: false };
    }
    if (!response.ok) return { found: false };

    const result = await response.json();
    return { found: true, ...result };
  } catch (err) {
    console.warn('[Tania] checkSharedUrl error:', err.message);
    return { found: false };
  }
}

// --- Badge polling via chrome.alarms ---

function startPolling() {
  chrome.alarms.create(POLL_ALARM, {
    periodInMinutes: POLL_INTERVAL_MINUTES,
  });
}

function stopPolling() {
  chrome.alarms.clear(POLL_ALARM);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) {
    pollUnreadCount();
  }
});

async function pollUnreadCount() {
  try {
    const apiBase = await getApiBase();
    const data = await chrome.storage.local.get(['token']);
    if (!data.token) {
      clearBadge();
      return;
    }

    const response = await fetch(`${apiBase}/notifications/count`, {
      headers: { 'Authorization': `Bearer ${data.token}` },
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Token expired — clear badge and auth
        await chrome.storage.local.remove(['token', 'user']);
        clearBadge();
        stopPolling();
      }
      return;
    }

    const { unread } = await response.json();
    setBadge(unread);
  } catch {
    // Network error — silently ignore, will retry on next alarm
  }
}

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

// --- On startup: check if logged in, start polling ---

chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['token'], (data) => {
    if (data.token) {
      startPolling();
      pollUnreadCount();
    }
  });
});

// Also run on install / update
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['token'], (data) => {
    if (data.token) {
      startPolling();
      pollUnreadCount();
    }
  });
});

console.log('[Tania] Service worker started.');
