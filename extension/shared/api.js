/**
 * Tania — API Client
 *
 * Fetch wrapper with auth, error handling, typed methods,
 * and automatic session expiry detection.
 */

import { getApiBase } from './constants.js';

// --- Auth helpers (talk to service worker) ---

export function getAuth() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_AUTH' }, (res) => {
      resolve({ token: res?.token || null, user: res?.user || null });
    });
  });
}

export function setAuth(token, user) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'SET_AUTH', payload: { token, user } }, resolve);
  });
}

export function clearAuth() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'CLEAR_AUTH' }, resolve);
  });
}

// --- Core fetch wrapper ---

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(endpoint, options = {}) {
  const [apiBase, { token }] = await Promise.all([getApiBase(), getAuth()]);

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(`${apiBase}${endpoint}`, {
      ...options,
      headers,
    });
  } catch (err) {
    throw new ApiError('Cannot reach server. Is the backend running?', 0);
  }

  // Handle session expiry globally — clear auth and notify the UI
  if (response.status === 401) {
    await clearAuth();
    window.dispatchEvent(new CustomEvent('tania:session-expired'));
    throw new ApiError('Session expired. Please sign in again.', 401);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError(body.error || `Request failed (${response.status})`, response.status);
  }

  return response.json();
}

// --- Typed API methods ---

export const api = {
  // Auth
  signup(email, username) {
    return request('/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ email, username }),
    });
  },

  signin(identifier) {
    return request('/auth/signin', {
      method: 'POST',
      body: JSON.stringify({ identifier }),
    });
  },

  me() {
    return request('/auth/me');
  },

  updateUsername(username) {
    return request('/auth/username', {
      method: 'PATCH',
      body: JSON.stringify({ username }),
    });
  },

  // Friends
  getFriends() {
    return request('/friends');
  },

  searchUsers(query) {
    return request(`/friends/search?q=${encodeURIComponent(query)}`);
  },

  inviteFriend(username) {
    return request('/friends/invite', {
      method: 'POST',
      body: JSON.stringify({ username }),
    });
  },

  acceptFriend(friendshipId) {
    return request('/friends/accept', {
      method: 'POST',
      body: JSON.stringify({ friendshipId }),
    });
  },

  getPendingCount() {
    return request('/friends/pending-count');
  },

  // Shares
  share(url, recipientIds, { title, note, platform } = {}) {
    return request('/share', {
      method: 'POST',
      body: JSON.stringify({ url, recipientIds, title, note, platform }),
    });
  },

  getFeed(cursor) {
    const params = cursor ? `?cursor=${cursor}` : '';
    return request(`/feed${params}`);
  },

  getSent(cursor) {
    const params = cursor ? `?cursor=${cursor}` : '';
    return request(`/sent${params}`);
  },

  markRead(shareId) {
    return request(`/shares/${shareId}/read`, { method: 'PATCH' });
  },

  dismissShare(shareId) {
    return request(`/shares/${shareId}/dismiss`, { method: 'DELETE' });
  },

  getUnreadCount() {
    return request('/notifications/count');
  },
};
