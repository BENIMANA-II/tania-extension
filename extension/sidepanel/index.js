/**
 * Tania — Side Panel
 *
 * Full flow: auth → views (inbox / friends / settings) → share.
 */

// --- Theme ---

function getSystemTheme() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  const saved = localStorage.getItem('tania-theme') || 'system';
  const resolved = saved === 'system' ? getSystemTheme() : saved;
  document.documentElement.setAttribute('data-theme', resolved);
}

function initThemeToggle() {
  const $toggle = document.getElementById('theme-toggle');
  if (!$toggle) return;
  const saved = localStorage.getItem('tania-theme') || 'system';
  $toggle.querySelectorAll('.theme-toggle__btn').forEach(btn => {
    btn.classList.toggle('theme-toggle__btn--active', btn.dataset.themeChoice === saved);
  });
  $toggle.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-choice]');
    if (!btn) return;
    const choice = btn.dataset.themeChoice;
    localStorage.setItem('tania-theme', choice);
    $toggle.querySelectorAll('.theme-toggle__btn').forEach(b => {
      b.classList.toggle('theme-toggle__btn--active', b.dataset.themeChoice === choice);
    });
    applyTheme();
  });
}

applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// --- Compact mode ---

function applyCompact() {
  const on = localStorage.getItem('tania-compact') === '1';
  document.documentElement.setAttribute('data-compact', on ? 'true' : 'false');
}

function initCompactToggle() {
  const $btn = document.getElementById('compact-toggle');
  if (!$btn) return;
  $btn.addEventListener('click', () => {
    const next = localStorage.getItem('tania-compact') === '1' ? '0' : '1';
    localStorage.setItem('tania-compact', next);
    applyCompact();
  });
}

applyCompact();

import { api, getAuth, setAuth, clearAuth } from '../shared/api.js';
import { extractUrl, isValidUrl, buildLinkPreview } from './lib/link-utils.js';
import { AVATAR_PRESETS, avatarHtml } from './lib/avatars.js';

// --- State ---

let currentUser = null;
let conversationsCache = [];
let conversationsPollingId = null;
let currentThread = null;
let pendingLink = null;
let unreadCount = 0;
let pendingRequestCount = 0;
let currentView = 'inbox';
const selectedFriends = new Set();
let selectedPickerGroupId = null;

// --- DOM: Auth ---

const $loginView      = document.getElementById('view-login');
const $appView        = document.getElementById('view-app');
const $signinForm     = document.getElementById('signin-form');
const $signinEmail    = document.getElementById('signin-email');
const $signinPassword = document.getElementById('signin-password');
const $signinBtn      = document.getElementById('signin-btn');
const $signinError    = document.getElementById('signin-error');
const $signupForm     = document.getElementById('signup-form');
const $signupEmail    = document.getElementById('signup-email');
const $signupUsername = document.getElementById('signup-username');
const $signupPassword = document.getElementById('signup-password');
const $signupBtn      = document.getElementById('signup-btn');
const $signupError    = document.getElementById('signup-error');
const $showSignup     = document.getElementById('show-signup');
const $showSignin     = document.getElementById('show-signin');

// --- DOM: Shared ---

const $errorBanner  = document.getElementById('error-banner');
const $errorText    = document.getElementById('error-banner-text');
const $errorClose   = document.getElementById('error-banner-close');
const $toast        = document.getElementById('toast');
const $navUnread    = document.getElementById('nav-unread-badge');
const $navPending   = document.getElementById('nav-pending-badge');

// --- DOM: Views ---

const $viewInbox     = document.getElementById('view-inbox');
const $viewThread    = document.getElementById('view-thread');
const $viewSaved     = document.getElementById('view-saved');
const $viewFriends   = document.getElementById('view-friends');
const $viewSettings  = document.getElementById('view-settings');

// --- DOM: Inbox (conversations) ---

const $dropZone           = document.getElementById('drop-zone');
const $dropText           = $dropZone.querySelector('.drop-zone__text');
const $conversationsLoading = document.getElementById('conversations-loading');
const $conversationsList  = document.getElementById('conversations-list');
const $conversationsSearch = document.getElementById('conversations-search');

// --- DOM: Thread ---

const $threadBack       = document.getElementById('thread-back');
const $threadHeader     = document.getElementById('thread-header-info');
const $threadMessages   = document.getElementById('thread-messages');
const $threadShareToggle = document.getElementById('thread-share-toggle');
const $threadShareForm  = document.getElementById('thread-share-form');
const $threadUrlInput   = document.getElementById('thread-url-input');
const $threadNoteInput  = document.getElementById('thread-note-input');
const $threadShareBtn   = document.getElementById('thread-share-btn');

// --- DOM: Friends ---

const $inviteStatus      = document.getElementById('invite-status');
const $addFriendResults  = document.getElementById('add-friend-results');
const $pendingSection = document.getElementById('pending-section');
const $pendingCount   = document.getElementById('pending-count');
const $pendingList    = document.getElementById('pending-list');
const $outgoingSection = document.getElementById('outgoing-section');
const $outgoingList   = document.getElementById('outgoing-list');
const $friendsCount   = document.getElementById('friends-count');
const $friendsLoading = document.getElementById('friends-loading');
const $friendsList    = document.getElementById('friends-list');
const $friendsSearch  = document.getElementById('friends-search');

// --- DOM: Settings ---

const $settingsUsername      = document.getElementById('settings-username');
const $settingsEmail        = document.getElementById('settings-email');
const $settingsLogout       = document.getElementById('settings-logout');
const $settingsEditBtn      = document.getElementById('settings-edit-username');
const $settingsUsernameForm = document.getElementById('settings-username-form');
const $settingsUsernameInput = document.getElementById('settings-username-input');
const $settingsUsernameCancel = document.getElementById('settings-username-cancel');
const $settingsUsernameError = document.getElementById('settings-username-error');

// --- DOM: Picker ---

const $picker            = document.getElementById('friend-picker');
const $pickerClose       = document.getElementById('picker-close');
const $pickerPreview     = document.getElementById('picker-preview');
const $pickerFriends     = document.getElementById('picker-friends');
const $pickerCircles     = document.getElementById('picker-circles');
const $pickerCirclesWrap = document.getElementById('picker-circles-wrap');
const $pickerNote        = document.getElementById('picker-note');
const $pickerSend        = document.getElementById('picker-send');
const $pickerSearch      = document.getElementById('picker-search');

// --- DOM: Start-conversation overlay ---

const $startConvBtn      = document.getElementById('start-conv-btn');
const $startConvPicker   = document.getElementById('start-conv-picker');
const $startConvClose    = document.getElementById('start-conv-close');
const $startConvSearch   = document.getElementById('start-conv-search');
const $startConvFriends  = document.getElementById('start-conv-friends');

// ============================================================
//  SESSION EXPIRY — auto-logout when JWT expires
// ============================================================

window.addEventListener('tania:session-expired', () => {
  currentUser = null;
  conversationsCache = [];
  conversationsCursor = null;
  conversationsAtEnd = false;
  $conversationsList.innerHTML = '';
  showLogin();
  showToast('Session expired. Please sign in again.', 'error');
});

// ============================================================
//  AUTH
// ============================================================

const $loader = document.getElementById('view-loader');

/** Show the loader, hiding all other views. Returns after the given duration. */
function showLoader(durationMs = 3000) {
  $loginView.hidden = true;
  $appView.hidden = true;
  $picker.hidden = true;
  $loader.hidden = false;
  $loader.classList.remove('loader--hiding');
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

/** Fade out the loader. */
function hideLoader() {
  return new Promise((resolve) => {
    $loader.classList.add('loader--hiding');
    $loader.addEventListener('transitionend', () => {
      $loader.hidden = true;
      resolve();
    }, { once: true });
  });
}

async function init() {
  initThemeToggle();
  initCompactToggle();
  const { token, user } = await getAuth();

  await showLoader(5000);
  await hideLoader();

  if (token && user) {
    currentUser = user;
    showApp();
    // If the cached session predates avatar support, refresh from the server.
    if (currentUser.avatarKey === undefined) {
      api.getMyProfile().then(({ user: u }) => {
        currentUser = u;
        renderSettingsAvatar();
      }).catch(() => {});
    }
  } else {
    showLogin();
  }
}

// --- Saved login suggestions ---

let savedLoginsList = [];

function loadSavedLogins() {
  try {
    savedLoginsList = JSON.parse(localStorage.getItem('tania-saved-logins')) || [];
  } catch { savedLoginsList = []; }
}

function saveLogin(email, username) {
  loadSavedLogins();
  const exists = savedLoginsList.some(l => l.email === email && l.username === username);
  if (!exists) {
    savedLoginsList.unshift({ email, username });
    if (savedLoginsList.length > 10) savedLoginsList.length = 10;
    localStorage.setItem('tania-saved-logins', JSON.stringify(savedLoginsList));
  }
}

function setupSuggest(input, listEl, getItems) {
  let active = -1;

  function render() {
    listEl.innerHTML = '';
    active = -1;
    const items = getItems(input.value);
    if (!items.length) { listEl.hidden = true; return; }
    items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'email-suggest__item';
      li.textContent = item;
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = item;
        listEl.hidden = true;
      });
      listEl.appendChild(li);
    });
    listEl.hidden = false;
  }

  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('blur', () => { listEl.hidden = true; });
  input.addEventListener('keydown', (e) => {
    if (listEl.hidden) return;
    const items = listEl.querySelectorAll('.email-suggest__item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = Math.min(active + 1, items.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(active - 1, 0);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      input.value = items[active].textContent;
      listEl.hidden = true;
      return;
    } else {
      return;
    }
    items.forEach((li, i) => li.classList.toggle('email-suggest__item--active', i === active));
  });
}

// Sign-in: emails only (Supabase Auth keys on email, not username)
setupSuggest(
  $signinEmail,
  document.getElementById('signin-suggestions'),
  (filter) => {
    const q = filter.toLowerCase();
    const seen = new Set();
    const out = [];
    for (const l of savedLoginsList) {
      if (l.email && !seen.has(l.email) && (!q || l.email.toLowerCase().includes(q))) {
        seen.add(l.email);
        out.push(l.email);
      }
    }
    return out;
  },
);

// Sign-up email: show saved emails only
setupSuggest(
  $signupEmail,
  document.getElementById('signup-suggestions'),
  (filter) => {
    const q = filter.toLowerCase();
    const seen = new Set();
    const out = [];
    for (const l of savedLoginsList) {
      if (l.email && !seen.has(l.email) && (!q || l.email.toLowerCase().includes(q))) {
        seen.add(l.email);
        out.push(l.email);
      }
    }
    return out;
  },
);

function showLogin() {
  $loginView.hidden = false;
  $appView.hidden = true;
  $picker.hidden = true;
  stopPolling();

  // Reset auth forms to sign-in by default
  $signinForm.hidden = false;
  $signupForm.hidden = true;
  $signinEmail.value = '';
  $signinPassword.value = '';
  $signupEmail.value = '';
  $signupUsername.value = '';
  $signupPassword.value = '';
  $signinError.hidden = true;
  $signupError.hidden = true;

  loadSavedLogins();
}

function showApp() {
  $loginView.hidden = true;
  $appView.hidden = false;
  $settingsUsername.textContent = currentUser.username;
  $settingsEmail.textContent = currentUser.email;
  renderSettingsAvatar();
  switchView('inbox');
  startPolling();
  refreshPendingCount();
}

async function logout() {
  await clearAuth();
  currentUser = null;
  conversationsCache = [];
  conversationsCursor = null;
  conversationsAtEnd = false;
  conversationsLoading = false;
  currentThread = null;
  resetViewState();

  await showLoader(2000);
  await hideLoader();
  showLogin();
}

/** Clear all transient UI state so nothing leaks between sessions. */
function resetViewState() {
  // Inbox
  if ($conversationsList) $conversationsList.innerHTML = '';
  if ($conversationsSearch) $conversationsSearch.value = '';
  if ($viewThread) $viewThread.hidden = true;
  currentFriendsTab = 'friends';

  // Friends
  $inviteStatus.hidden = true;
  $pendingList.innerHTML = '';
  $pendingSection.hidden = true;
  $outgoingList.innerHTML = '';
  $outgoingSection.hidden = true;
  $friendsList.innerHTML = '';
  $friendsSearch.value = '';
  if ($addFriendResults) { $addFriendResults.innerHTML = ''; $addFriendResults.hidden = true; }
  cachedFriendRows = [];
  friendsListCursor = null;
  friendsListAtEnd = false;
  friendsListLoading = false;
  friendsCurrentQuery = '';
  pendingRequestCount = 0;
  renderPendingBadge();

  // Groups
  if ($groupsList) {
    groupsCache = [];
    renderGroupsList();
    if ($groupEditor) $groupEditor.hidden = true;
  }

  // Saved
  if ($savedList) {
    $savedList.innerHTML = '';
    $savedLoadMore.hidden = true;
    savedCursor = null;
  }
  if ($savedUrlInput) {
    $savedUrlInput.value = '';
    $savedNoteInput.value = '';
    $savedNoteInput.hidden = true;
    $savedAddBtn.hidden = true;
    $savedFormError.hidden = true;
  }
  if ($savedSearch) $savedSearch.value = '';
  savedCache = [];

  // Settings
  $settingsUsernameForm.hidden = true;
  $settingsEditBtn.hidden = false;
  $settingsUsernameError.hidden = true;

  // Errors
  hideError();
}

// --- Toggle between sign in and sign up ---

$showSignup.addEventListener('click', () => {
  $signinForm.hidden = true;
  $signupForm.hidden = false;
  $signinError.hidden = true;
  $signupError.hidden = true;
  $signupEmail.focus();
});

$showSignin.addEventListener('click', () => {
  $signupForm.hidden = true;
  $signinForm.hidden = false;
  $signinError.hidden = true;
  $signupError.hidden = true;
  $signinEmail.focus();
});

// --- Sign In ---

$signinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $signinError.hidden = true;
  $signinBtn.disabled = true;
  $signinBtn.textContent = 'Signing in...';

  try {
    const email    = $signinEmail.value.trim();
    const password = $signinPassword.value;
    const result   = await api.signin(email, password);
    currentUser = result.user;
    saveLogin(result.user.email, result.user.username);

    await showLoader(3000);
    await hideLoader();
    showApp();
  } catch (err) {
    $signinError.textContent = err.message;
    $signinError.hidden = false;
  } finally {
    $signinBtn.disabled = false;
    $signinBtn.textContent = 'Sign in';
  }
});

// --- Sign Up ---

$signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $signupError.hidden = true;
  $signupBtn.disabled = true;
  $signupBtn.textContent = 'Creating account...';

  try {
    const email    = $signupEmail.value.trim();
    const username = $signupUsername.value.trim();
    const password = $signupPassword.value;
    const result   = await api.signup(email, username, password);
    currentUser = result.user;
    saveLogin(email, username);

    await showLoader(3000);
    await hideLoader();
    showApp();
  } catch (err) {
    $signupError.textContent = err.message;
    $signupError.hidden = false;
  } finally {
    $signupBtn.disabled = false;
    $signupBtn.textContent = 'Sign up';
  }
});

$settingsLogout.addEventListener('click', logout);

// --- Clear chat history ---

const $settingsClearHistory = document.getElementById('settings-clear-history');
if ($settingsClearHistory) {
  $settingsClearHistory.addEventListener('click', async () => {
    const ok = confirm(
      'Clear your inbox?\n\n' +
      'This hides every share that\'s been sent to you from your Chats tab.\n\n' +
      'Shares you\'ve sent are NOT deleted — the people you sent them to ' +
      'will still see them, and if any of them replies the conversation ' +
      'will reappear here.\n\n' +
      'This can\'t be undone for you.'
    );
    if (!ok) return;

    $settingsClearHistory.disabled = true;
    const prevLabel = $settingsClearHistory.textContent;
    $settingsClearHistory.textContent = 'Clearing…';
    try {
      await api.clearChatHistory();
      conversationsCache = [];
      conversationsCursor = null;
      conversationsAtEnd = false;
      if ($conversationsList) $conversationsList.innerHTML = '';
      if (currentThread) {
        currentThread = null;
        $viewThread.hidden = true;
        $viewInbox.hidden = false;
        closeThreadShareForm();
      }
      refreshUnreadCount();
      if (currentView === 'inbox') loadConversations();
      showToast('Inbox cleared', 'success');
    } catch (err) {
      showToast(err.message || 'Could not clear inbox', 'error');
    } finally {
      $settingsClearHistory.disabled = false;
      $settingsClearHistory.textContent = prevLabel;
    }
  });
}

// --- Username editing ---

$settingsEditBtn.addEventListener('click', () => {
  $settingsUsernameInput.value = currentUser.username;
  $settingsUsernameForm.hidden = false;
  $settingsUsernameError.hidden = true;
  $settingsEditBtn.hidden = true;
  $settingsUsernameInput.focus();
});

$settingsUsernameCancel.addEventListener('click', () => {
  $settingsUsernameForm.hidden = true;
  $settingsEditBtn.hidden = false;
});

$settingsUsernameForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const newUsername = $settingsUsernameInput.value.trim();
  if (!newUsername || newUsername === currentUser.username) {
    $settingsUsernameForm.hidden = true;
    $settingsEditBtn.hidden = false;
    return;
  }
  try {
    $settingsUsernameError.hidden = true;
    const { user } = await api.updateUsername(newUsername);
    currentUser = user;
    $settingsUsername.textContent = user.username;
    $settingsUsernameForm.hidden = true;
    $settingsEditBtn.hidden = false;
  } catch (err) {
    $settingsUsernameError.textContent = err.message;
    $settingsUsernameError.hidden = false;
  }
});

// ============================================================
//  VIEW SWITCHING
// ============================================================

const views = { inbox: $viewInbox, saved: $viewSaved, friends: $viewFriends, settings: $viewSettings };
const navButtons = document.querySelectorAll('.nav__btn');

function switchView(name) {
  currentView = name;

  // Always exit the thread view when switching tabs
  $viewThread.hidden = true;
  currentThread = null;

  for (const [key, el] of Object.entries(views)) {
    el.hidden = key !== name;
  }

  navButtons.forEach((btn) => {
    btn.classList.toggle('nav__btn--active', btn.dataset.view === name);
  });

  if (name === 'inbox')   loadConversations();
  if (name === 'saved')   loadBookmarks();
  if (name === 'friends') { loadFriends(); loadGroups(); setFriendsTab(currentFriendsTab); }
}

// --- Friends sub-tabs (Friends / Groups inside the Friends view) ---

let currentFriendsTab = 'friends';

function setFriendsTab(name) {
  currentFriendsTab = name;
  $viewFriends.classList.toggle('view-friends--tab-groups',  name === 'groups');
  $viewFriends.classList.toggle('view-friends--tab-friends', name === 'friends');
  document.querySelectorAll('.friends-tabs__btn').forEach((btn) => {
    btn.classList.toggle('friends-tabs__btn--active', btn.dataset.friendsTab === name);
  });
}

document.querySelectorAll('.friends-tabs__btn').forEach((btn) => {
  btn.addEventListener('click', () => setFriendsTab(btn.dataset.friendsTab));
});

navButtons.forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ============================================================
//  ERROR / TOAST
// ============================================================

function showError(msg) {
  $errorText.textContent = msg;
  $errorBanner.hidden = false;
}

function hideError() { $errorBanner.hidden = true; }
$errorClose.addEventListener('click', hideError);

let toastTimer;
function showToast(message, type = 'success') {
  clearTimeout(toastTimer);
  $toast.textContent = message;
  $toast.className = `toast toast--${type} toast--visible`;
  toastTimer = setTimeout(() => $toast.classList.remove('toast--visible'), 2500);
}

// ============================================================
//  UNREAD COUNT
// ============================================================

async function refreshUnreadCount() {
  try {
    const { unread } = await api.getUnreadCount();
    unreadCount = unread;
    renderNavBadge();
    chrome.runtime.sendMessage({ type: 'UPDATE_BADGE' });
  } catch {
    // Non-critical
  }
}

function renderNavBadge() {
  if (unreadCount > 0) {
    $navUnread.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
    $navUnread.hidden = false;
  } else {
    $navUnread.hidden = true;
  }
}

// ============================================================
//  PENDING FRIEND REQUEST COUNT (nav badge)
// ============================================================

async function refreshPendingCount() {
  try {
    const { count } = await api.getPendingCount();
    pendingRequestCount = count;
    renderPendingBadge();
  } catch {
    // Non-critical
  }
}

function renderPendingBadge() {
  if (pendingRequestCount > 0) {
    $navPending.textContent = pendingRequestCount > 99 ? '99+' : String(pendingRequestCount);
    $navPending.hidden = false;
  } else {
    $navPending.hidden = true;
  }
}

// ============================================================
//  CONVERSATIONS (inbox grouped by peer / group)
// ============================================================

function buildPlatformBadge(preview) {
  return preview.platform
    ? `<span class="preview-card__badge" style="--badge-color: ${preview.platform.color}">
        ${preview.platform.icon}
        <span>${preview.platform.name}</span>
      </span>`
    : `<span class="preview-card__badge preview-card__badge--generic">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
        <span>Link</span>
      </span>`;
}

function groupAvatarHtml(group, size = 'md') {
  if (group.avatarUrl) return avatarHtml(group.name, null, size, group.avatarUrl);
  if (group.avatarKey) return avatarHtml(group.name, group.avatarKey, size);
  return `<span class="avatar avatar--${size} avatar--group" style="background:${escapeAttr(group.color || '#6366f1')}"><span class="avatar__initial">${escapeHtml((group.name || '?')[0].toUpperCase())}</span></span>`;
}

let conversationsCursor = null;
let conversationsAtEnd = false;
let conversationsLoading = false;
let conversationsObserver = null;
const CONVERSATIONS_PAGE_SIZE = 5;

async function loadConversations({ reset = true } = {}) {
  if (conversationsLoading) return;
  conversationsLoading = true;
  if (reset) $conversationsLoading.hidden = false;

  try {
    const cursor = reset ? null : conversationsCursor;
    const { conversations } = await api.getConversations({
      after:    cursor,
      pageSize: CONVERSATIONS_PAGE_SIZE,
    });
    hideError();

    if (reset) conversationsCache = [];
    conversationsCache.push(...conversations);

    if (conversations.length > 0) {
      conversationsCursor = conversations[conversations.length - 1].lastAt;
    }
    conversationsAtEnd = conversations.length < CONVERSATIONS_PAGE_SIZE;

    renderConversationsList();
    ensureConversationsScrollSentinel();
    refreshUnreadCount();
  } catch (err) {
    showError(err.message);
  } finally {
    $conversationsLoading.hidden = true;
    conversationsLoading = false;
  }
}

function ensureConversationsScrollSentinel() {
  $conversationsList.querySelectorAll('.conversations-list__sentinel').forEach((s) => s.remove());
  if (conversationsAtEnd) return;
  const sentinel = document.createElement('li');
  sentinel.className = 'conversations-list__sentinel';
  sentinel.innerHTML = '<div class="spinner"></div>';
  $conversationsList.appendChild(sentinel);
  if (!conversationsObserver) {
    conversationsObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) loadConversations({ reset: false });
      }
    }, { root: null, rootMargin: '160px' });
  }
  conversationsObserver.observe(sentinel);
}

function conversationsMatch(c, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const name = c.kind === 'peer' ? c.peer.username : c.group.name;
  if (name && name.toLowerCase().includes(needle)) return true;
  if (c.lastSnippet && c.lastSnippet.toLowerCase().includes(needle)) return true;
  return false;
}

function renderConversationsList() {
  $conversationsList.innerHTML = '';
  const q = ($conversationsSearch?.value || '').trim();
  const filtered = q ? conversationsCache.filter((c) => conversationsMatch(c, q)) : conversationsCache;

  if (conversationsCache.length === 0) {
    $conversationsList.innerHTML = `
      <li class="feed__empty-state">
        <svg class="feed__empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/>
        </svg>
        <p class="feed__empty-title">No conversations yet</p>
        <p class="feed__empty-text">Share a link with a friend or group to start a chat</p>
      </li>`;
    return;
  }

  if (filtered.length === 0) {
    $conversationsList.innerHTML = `
      <li class="feed__empty-state">
        <p class="feed__empty-title">No matches</p>
        <p class="feed__empty-text">Nothing matched "${escapeHtml(q)}"</p>
      </li>`;
    return;
  }
  filtered.forEach((c) => $conversationsList.appendChild(renderConversationRow(c)));
}

if ($conversationsSearch) {
  $conversationsSearch.addEventListener('input', renderConversationsList);
}

function renderConversationRow(c) {
  const li = document.createElement('li');
  li.className = 'conv-row' + (c.unreadCount > 0 ? ' conv-row--unread' : '');
  const avatar = c.kind === 'peer'
    ? avatarHtml(c.peer.username, c.peer.avatarKey, 'md', c.peer.avatarUrl)
    : groupAvatarHtml(c.group, 'md');
  const name = c.kind === 'peer' ? escapeHtml(c.peer.username) : escapeHtml(c.group.name);
  const groupTag = c.kind === 'group' ? '<span class="conv-row__tag">Group</span>' : '';
  const youPrefix = c.lastSenderId && currentUser && c.lastSenderId === currentUser.id
    ? '<span class="conv-row__you">You: </span>' : '';
  const snippet = escapeHtml(truncate(c.lastSnippet || '', 64));
  const time = c.lastAt ? timeAgo(c.lastAt) : '';

  li.innerHTML = `
    ${avatar}
    <div class="conv-row__info">
      <div class="conv-row__head">
        <span class="conv-row__name">${name}${groupTag}</span>
        <span class="conv-row__time">${time}</span>
      </div>
      <div class="conv-row__snippet-line">
        <span class="conv-row__snippet">${youPrefix}${snippet}</span>
        ${c.unreadCount > 0 ? `<span class="conv-row__unread">${c.unreadCount > 9 ? '9+' : c.unreadCount}</span>` : ''}
      </div>
    </div>
  `;
  li.addEventListener('click', () => openConversation(c));
  return li;
}

// ============================================================
//  CONVERSATION THREAD
// ============================================================

async function openConversation(conv) {
  currentThread = conv;
  $viewInbox.hidden = true;
  $viewThread.hidden = false;
  closeThreadShareForm();
  renderThreadHeader(conv);
  $threadMessages.innerHTML = '<div class="feed__loading"><div class="spinner"></div><span>Loading...</span></div>';

  const opts = conv.kind === 'peer'
    ? { peerId: conv.peer.id }
    : { groupId: conv.group.id };

  try {
    const { messages } = await api.getConversationThread(opts);
    renderThreadMessages(messages);
    api.markConversationRead(opts).then(() => refreshUnreadCount()).catch(() => {});
  } catch (err) {
    $threadMessages.innerHTML = `<p class="replies__error">${escapeHtml(err.message)}</p>`;
  }
}

function renderThreadHeader(conv) {
  if (conv.kind === 'peer') {
    $threadHeader.innerHTML = `
      ${avatarHtml(conv.peer.username, conv.peer.avatarKey, 'md', conv.peer.avatarUrl)}
      <div class="thread-header__text">
        <h2 class="thread-header__title">${escapeHtml(conv.peer.username)}</h2>
      </div>
    `;
  } else {
    const memberSummary = conv.group && conv.group.members
      ? `${conv.group.members.length} members`
      : 'Group';
    $threadHeader.innerHTML = `
      ${groupAvatarHtml(conv.group, 'md')}
      <div class="thread-header__text">
        <h2 class="thread-header__title">${escapeHtml(conv.group.name)}</h2>
        <span class="thread-header__sub">${memberSummary}</span>
      </div>
    `;
  }
}

function renderThreadMessages(messages) {
  if (!messages || messages.length === 0) {
    $threadMessages.innerHTML = `<div class="thread-empty"><p>No messages yet — share a link below.</p></div>`;
    return;
  }

  // Build a unified chronological event stream: each share is one event, and
  // each text reply attached to a share is its own event. Replies still show
  // inline under the parent share card for at-a-glance context, AND appear as
  // standalone bubbles in the conversation flow at their actual reply time.
  const events = [];
  for (const m of messages) {
    events.push({ type: 'share', at: m.sharedAt, share: m });
    for (const r of (m.replies || [])) {
      events.push({ type: 'reply', at: r.createdAt, reply: r, parentShare: m });
    }
  }
  events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  $threadMessages.innerHTML = '';
  for (const e of events) {
    if (e.type === 'share') $threadMessages.appendChild(renderThreadMessage(e.share));
    else                    $threadMessages.appendChild(renderThreadReplyMessage(e.reply, e.parentShare));
  }
  requestAnimationFrame(() => { $threadMessages.scrollTop = $threadMessages.scrollHeight; });
}

function renderThreadMessage(m) {
  const wrapper = document.createElement('div');
  wrapper.className = `thread-msg thread-msg--${m.direction}`;
  wrapper.dataset.shareId = m.id;
  const preview = buildLinkPreview(m.url);
  const displayUrl = truncateUrl(m.url, 50);
  const displayTitle = m.ogTitle || m.title || displayUrl;
  const time = timeAgo(m.sharedAt);
  const senderAvatar = avatarHtml(m.sender.username, m.sender.avatarKey, 'sm', m.sender.avatarUrl);
  const repliesHtml = (m.replies || []).map((r) => renderInlineReply(r)).join('');

  wrapper.innerHTML = `
    <div class="thread-msg__row">
      ${senderAvatar}
      <div class="thread-msg__card">
        <div class="thread-msg__head">
          <span class="thread-msg__sender">${escapeHtml(m.sender.username)}</span>
          <span class="thread-msg__time">${time}</span>
        </div>
        <div class="thread-msg__compact">
          ${buildPlatformBadge(preview)}
          <p class="thread-msg__title" title="${escapeAttr(displayTitle)}">${escapeHtml(displayTitle)}</p>
        </div>
        <div class="thread-msg__inline-replies" data-share-id="${escapeAttr(m.id)}">${repliesHtml}</div>
        <div class="thread-msg__expanded">
          ${m.note ? `<p class="thread-msg__note">${escapeHtml(m.note)}</p>` : ''}
          <a class="thread-msg__url" href="${escapeAttr(m.url)}" target="_blank" rel="noopener">${escapeHtml(displayUrl)}</a>
          <div class="thread-msg__footer">
            <form class="thread-msg__reply-form" data-share-id="${escapeAttr(m.id)}">
              <input class="input thread-msg__reply-body" type="text" placeholder="Reply with text or a link..." maxlength="1000" autocomplete="off">
              <input class="input thread-msg__reply-note" type="text" placeholder="Add a note (optional)" maxlength="500" hidden>
              <button type="submit" class="btn btn--primary btn--sm thread-msg__reply-btn" hidden>Send</button>
            </form>
            <button class="thread-msg__action-btn" data-archive="${escapeAttr(m.id)}" title="Save to archive">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  return wrapper;
}

function renderInlineReply(r) {
  const isMine = currentUser && r.authorId === currentUser.id;
  return `
    <div class="thread-msg__inline-reply${isMine ? ' thread-msg__inline-reply--mine' : ''}" data-reply-id="${escapeAttr(r.id)}">
      <span class="thread-msg__inline-reply-author">${escapeHtml(r.author)}</span>
      <span class="thread-msg__inline-reply-body">${escapeHtml(r.body)}</span>
      ${isMine ? `<button class="thread-msg__inline-reply-delete" data-reply-delete="${escapeAttr(r.id)}" title="Delete">&times;</button>` : ''}
    </div>
  `;
}

function renderThreadReplyMessage(r, parentShare) {
  const isMine = currentUser && r.authorId === currentUser.id;
  const wrapper = document.createElement('div');
  wrapper.className = `thread-reply-msg thread-reply-msg--${isMine ? 'out' : 'in'}`;
  wrapper.dataset.replyId = r.id;
  const authorAvatar = avatarHtml(r.author, r.avatarKey, 'sm', r.avatarUrl);
  const time = timeAgo(r.createdAt);
  const parentTitle = parentShare
    ? (parentShare.ogTitle || parentShare.title || truncateUrl(parentShare.url, 40))
    : null;

  wrapper.innerHTML = `
    <div class="thread-reply-msg__row">
      ${authorAvatar}
      <div class="thread-reply-msg__bubble">
        <div class="thread-reply-msg__head">
          <span class="thread-reply-msg__author">${escapeHtml(r.author)}</span>
          <span class="thread-reply-msg__time">${time}</span>
        </div>
        ${parentTitle ? `<a class="thread-reply-msg__ref" href="#share-${escapeAttr(parentShare.id)}" data-jump-share="${escapeAttr(parentShare.id)}">↪ ${escapeHtml(parentTitle)}</a>` : ''}
        <p class="thread-reply-msg__body">${escapeHtml(r.body)}</p>
        ${isMine ? `<button class="thread-reply-msg__delete" data-reply-delete="${escapeAttr(r.id)}" title="Delete">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>` : ''}
      </div>
    </div>
  `;
  return wrapper;
}

$threadMessages.addEventListener('click', async (e) => {
  const archiveBtn = e.target.closest('[data-archive]');
  if (archiveBtn) {
    e.preventDefault();
    e.stopPropagation();
    const shareId = archiveBtn.dataset.archive;
    archiveBtn.disabled = true;
    try {
      await api.saveBookmarkFromShare(shareId);
      showToast('Saved to archive', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      archiveBtn.disabled = false;
    }
    return;
  }
  const delBtn = e.target.closest('[data-reply-delete]');
  if (delBtn) {
    e.preventDefault();
    e.stopPropagation();
    const id = delBtn.dataset.replyDelete;
    try {
      await api.deleteReply(id);
      // Remove every copy of this reply — inline note under the parent
      // share AND the standalone bubble in the conversation flow.
      $threadMessages.querySelectorAll(`[data-reply-id="${id}"]`).forEach((el) => el.remove());
    } catch (err) {
      showToast(err.message, 'error');
    }
    return;
  }

  const jumpRef = e.target.closest('[data-jump-share]');
  if (jumpRef) {
    e.preventDefault();
    const target = $threadMessages.querySelector(`.thread-msg[data-share-id="${jumpRef.dataset.jumpShare}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('thread-msg--flash');
      setTimeout(() => target.classList.remove('thread-msg--flash'), 1500);
    }
    return;
  }

  // Don't toggle when interacting with the link, the reply composer, an
  // inline reply row, or a standalone reply bubble.
  if (e.target.closest('.thread-msg__url, .thread-msg__reply-form, .thread-msg__inline-reply, .thread-reply-msg')) return;

  const card = e.target.closest('.thread-msg');
  if (card) {
    card.classList.toggle('thread-msg--expanded');
    if (card.classList.contains('thread-msg--expanded')) {
      const input = card.querySelector('.thread-msg__reply-body');
      if (input) setTimeout(() => input.focus(), 50);
    }
  }
});

// Progressive reveal inside a reply form. Send shows as soon as there's
// content; the optional note field only shows when the input parses as a
// URL (i.e. the reply is about to become a link-share card).
$threadMessages.addEventListener('input', (e) => {
  const bodyInput = e.target.closest('.thread-msg__reply-body');
  if (!bodyInput) return;
  const form = bodyInput.closest('.thread-msg__reply-form');
  const noteInput = form.querySelector('.thread-msg__reply-note');
  const sendBtn   = form.querySelector('.thread-msg__reply-btn');
  const text = bodyInput.value.trim();
  sendBtn.hidden = text.length === 0;
  noteInput.hidden = !isValidUrl(text);
});

$threadMessages.addEventListener('submit', async (e) => {
  const form = e.target.closest('.thread-msg__reply-form');
  if (!form) return;
  e.preventDefault();
  if (!currentThread) return;

  const bodyInput = form.querySelector('.thread-msg__reply-body');
  const noteInput = form.querySelector('.thread-msg__reply-note');
  const sendBtn   = form.querySelector('.thread-msg__reply-btn');
  const text = bodyInput.value.trim();
  if (!text) return;

  sendBtn.disabled = true;
  try {
    if (isValidUrl(text)) {
      // URL → send a new share into the conversation; renders as a card on reload.
      const preview = buildLinkPreview(text);
      await api.share(
        text,
        currentThread.kind === 'peer' ? [currentThread.peer.id] : null,
        {
          note:     noteInput.value.trim() || undefined,
          platform: preview.platform?.id || undefined,
          title:    preview.sublabel || undefined,
          groupId:  currentThread.kind === 'group' ? currentThread.group.id : undefined,
        }
      );
      bodyInput.value = '';
      noteInput.value = '';
      noteInput.hidden = true;
      sendBtn.hidden = true;
      showToast('Shared', 'success');
      openConversation(currentThread); // reload to surface the new card
    } else {
      // Plain text → posted as a reply attached to the parent share. Reload
      // the conversation so the reply appears both as an inline note under
      // the parent card AND as its own bubble in the chronological flow.
      const parentShareId = form.dataset.shareId;
      await api.postReply(parentShareId, text);
      bodyInput.value = '';
      noteInput.value = '';
      noteInput.hidden = true;
      sendBtn.hidden = true;
      openConversation(currentThread);
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    sendBtn.disabled = false;
  }
});

$threadBack.addEventListener('click', () => {
  $viewThread.hidden = true;
  $viewInbox.hidden = false;
  currentThread = null;
  closeThreadShareForm();
  loadConversations();
});

// In-chat share composer — hidden by default, toggled by the + button in the
// thread header. Note field + Send button reveal progressively after a valid
// URL is typed (mirrors the Saved-tab pattern). Submits into currentThread.

function closeThreadShareForm() {
  $threadShareForm.hidden = true;
  $threadUrlInput.value = '';
  $threadNoteInput.value = '';
  $threadNoteInput.hidden = true;
  $threadShareBtn.hidden = true;
}

function refreshThreadShareFormState() {
  const url = $threadUrlInput.value.trim();
  const valid = isValidUrl(url);
  $threadNoteInput.hidden = !valid;
  $threadShareBtn.hidden = !valid;
  if (!valid) $threadNoteInput.value = '';
}

$threadShareToggle.addEventListener('click', () => {
  if ($threadShareForm.hidden) {
    $threadShareForm.hidden = false;
    setTimeout(() => $threadUrlInput.focus(), 30);
  } else {
    closeThreadShareForm();
  }
});

$threadUrlInput.addEventListener('input', refreshThreadShareFormState);

$threadShareForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentThread) return;
  const url = $threadUrlInput.value.trim();
  if (!isValidUrl(url)) {
    showToast('Enter a valid URL', 'error');
    return;
  }
  $threadShareBtn.disabled = true;
  try {
    const preview = buildLinkPreview(url);
    await api.share(
      url,
      currentThread.kind === 'peer' ? [currentThread.peer.id] : null,
      {
        note:     $threadNoteInput.value.trim() || undefined,
        platform: preview.platform?.id || undefined,
        title:    preview.sublabel || undefined,
        groupId:  currentThread.kind === 'group' ? currentThread.group.id : undefined,
      }
    );
    closeThreadShareForm();
    showToast('Shared', 'success');
    openConversation(currentThread); // reload thread to show the new message
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    $threadShareBtn.disabled = false;
  }
});

// --- Polling ---

function startPolling() {
  stopPolling();
  conversationsPollingId = setInterval(() => {
    if (currentView === 'inbox' && !currentThread) loadConversations();
    refreshUnreadCount();
    refreshPendingCount();
  }, 30_000);
}

function stopPolling() {
  if (conversationsPollingId) {
    clearInterval(conversationsPollingId);
    conversationsPollingId = null;
  }
}

// ============================================================
//  FRIENDS VIEW
// ============================================================

let cachedFriendRows = [];           // rendered friend-row elements
let friendsListCursor = null;        // `since` of the last loaded friend
let friendsListLoading = false;
let friendsListAtEnd = false;
let friendsCurrentQuery = '';
let friendsScrollObserver = null;
const FRIENDS_PAGE_SIZE = 5;

function friendRowHtml(f) {
  const mutualLabel = f.mutualCount > 0
    ? `<span class="friend-row__mutuals">${f.mutualCount} mutual friend${f.mutualCount === 1 ? '' : 's'}</span>`
    : '';
  return `
    <div class="friend-row__info">
      ${avatarHtml(f.user.username, f.user.avatarKey, 'sm', f.user.avatarUrl)}
      <div class="friend-row__text">
        <span class="friend-row__name">${escapeHtml(f.user.username)}</span>
        <span class="friend-row__since">Friends since ${new Date(f.since).toLocaleDateString()}</span>
        ${mutualLabel}
      </div>
    </div>
  `;
}

function renderFriendRow(f) {
  const li = document.createElement('li');
  li.className = 'friend-row';
  li.dataset.username = f.user.username.toLowerCase();
  li.innerHTML = friendRowHtml(f);
  return li;
}

function showFriendsEmpty(reason = 'none') {
  $friendsList.innerHTML = `
    <li class="feed__empty-state">
      <svg class="feed__empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
      </svg>
      <p class="feed__empty-title">${reason === 'search' ? 'No matches' : 'No friends yet'}</p>
      <p class="feed__empty-text">${reason === 'search' ? 'Try a different search' : 'Search above to add one'}</p>
    </li>`;
}

async function loadMoreFriends({ reset = false } = {}) {
  if (friendsListLoading) return;
  if (!reset && friendsListAtEnd) return;
  friendsListLoading = true;

  if (reset) {
    friendsListCursor = null;
    friendsListAtEnd = false;
    cachedFriendRows = [];
    $friendsList.innerHTML = '';
  }

  try {
    const { friends } = await api.listMyFriends({
      q:        friendsCurrentQuery || null,
      after:    friendsListCursor,
      pageSize: FRIENDS_PAGE_SIZE,
    });

    friends.forEach((f) => {
      const li = renderFriendRow(f);
      $friendsList.appendChild(li);
      cachedFriendRows.push(li);
    });

    if (friends.length > 0) {
      friendsListCursor = friends[friends.length - 1].since;
    }
    if (friends.length < FRIENDS_PAGE_SIZE) friendsListAtEnd = true;

    if (cachedFriendRows.length === 0) {
      showFriendsEmpty(friendsCurrentQuery ? 'search' : 'none');
    } else {
      ensureFriendsScrollSentinel();
    }
  } catch (err) {
    showError(err.message);
  } finally {
    friendsListLoading = false;
  }
}

function ensureFriendsScrollSentinel() {
  // Remove any prior sentinel.
  $friendsList.querySelectorAll('.friends-list__sentinel').forEach((s) => s.remove());
  if (friendsListAtEnd) return;
  const sentinel = document.createElement('li');
  sentinel.className = 'friends-list__sentinel';
  sentinel.innerHTML = '<div class="spinner"></div>';
  $friendsList.appendChild(sentinel);
  if (!friendsScrollObserver) {
    friendsScrollObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) loadMoreFriends();
      }
    }, { root: null, rootMargin: '120px' });
  }
  friendsScrollObserver.observe(sentinel);
}

async function loadFriends() {
  $friendsLoading.hidden = false;
  $pendingList.innerHTML = '';
  $outgoingList.innerHTML = '';
  $friendsSearch.value = '';
  friendsCurrentQuery = '';

  try {
    const { pendingIncoming, pendingOutgoing } = await api.getFriends();
    hideError();

    pendingRequestCount = pendingIncoming.length;
    renderPendingBadge();

    if (pendingIncoming.length > 0) {
      $pendingSection.hidden = false;
      $pendingCount.textContent = pendingIncoming.length;
      pendingIncoming.forEach((req) => {
        const li = document.createElement('li');
        li.className = 'friend-row';
        li.innerHTML = `
          <div class="friend-row__info">
            ${avatarHtml(req.user.username, req.user.avatarKey, 'sm', req.user.avatarUrl)}
            <span class="friend-row__name">${escapeHtml(req.user.username)}</span>
          </div>
          <div class="friend-row__actions">
            <button class="btn btn--sm btn--primary" data-accept="${escapeAttr(req.id)}">Accept</button>
          </div>
        `;
        $pendingList.appendChild(li);
      });
    } else {
      $pendingSection.hidden = true;
    }

    if (pendingOutgoing.length > 0) {
      $outgoingSection.hidden = false;
      pendingOutgoing.forEach((req) => {
        const li = document.createElement('li');
        li.className = 'friend-row';
        li.innerHTML = `
          <div class="friend-row__info">
            ${avatarHtml(req.user.username, req.user.avatarKey, 'sm', req.user.avatarUrl)}
            <span class="friend-row__name">${escapeHtml(req.user.username)}</span>
          </div>
          <span class="friend-row__status">Pending</span>
        `;
        $outgoingList.appendChild(li);
      });
    } else {
      $outgoingSection.hidden = true;
    }

    $friendsCount.textContent = '';
    await loadMoreFriends({ reset: true });
  } catch (err) {
    $friendsList.innerHTML = `
      <li class="feed__error-state">
        <svg class="feed__error-icon" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <p class="feed__error-text">${escapeHtml(err.message)}</p>
        <button class="btn btn--ghost" id="friends-retry">Try again</button>
      </li>`;
    showError(err.message);
    document.getElementById('friends-retry')?.addEventListener('click', () => loadFriends());
  } finally {
    $friendsLoading.hidden = true;
  }
}

// --- Unified search: filter friends list + surface non-friends to add ---

function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i < 0) return escapeHtml(text);
  return (
    escapeHtml(text.slice(0, i)) +
    `<mark class="search-mark">${escapeHtml(text.slice(i, i + q.length))}</mark>` +
    escapeHtml(text.slice(i + q.length))
  );
}

let friendsSearchTimer = null;
let friendsSearchSeq = 0;

$friendsSearch.addEventListener('input', () => {
  const query = $friendsSearch.value.trim();
  $inviteStatus.hidden = true;

  // Server-side search of my friends — reset pagination on each keystroke
  // (debounced) so the list always reflects the full match set.
  clearTimeout(friendsSearchTimer);
  friendsCurrentQuery = query.toLowerCase();

  if (query.length === 0) {
    $addFriendResults.innerHTML = '';
    $addFriendResults.hidden = true;
    loadMoreFriends({ reset: true });
    return;
  }

  const mySeq = ++friendsSearchSeq;
  friendsSearchTimer = setTimeout(async () => {
    if (mySeq !== friendsSearchSeq) return;
    // Refresh friends list (server-side, paginated)
    loadMoreFriends({ reset: true });
    // Look up non-friend matches in parallel for the "Add new" card.
    try {
      const { users } = await api.searchUsers(query);
      if (mySeq !== friendsSearchSeq) return;
      const candidates = users.filter((u) => u.status !== 'accepted');
      renderAddFriendResults(candidates, query);
    } catch {
      $addFriendResults.hidden = true;
    }
  }, 180);
});

function renderAddFriendResults(users, query) {
  $addFriendResults.innerHTML = '';
  if (users.length === 0) {
    $addFriendResults.hidden = true;
    return;
  }
  for (const u of users) {
    const li = document.createElement('li');
    li.className = 'invite-search-row';
    li.dataset.username = u.username;
    const mutualLabel = u.mutualCount > 0
      ? `<span class="search-mutuals">${u.mutualCount} mutual</span>` : '';
    let actionHtml;
    if (u.status === 'pending') {
      actionHtml = '<span class="search-status search-status--pending">Pending</span>';
    } else {
      actionHtml = `<button class="btn btn--primary btn--sm" data-add-username="${escapeAttr(u.username)}">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add
      </button>`;
    }
    li.innerHTML = `
      ${avatarHtml(u.username, u.avatarKey, 'sm', u.avatarUrl)}
      <div class="invite-search-row__info">
        <span class="search-username">${highlightMatch(u.username, query)}</span>
        ${mutualLabel}
      </div>
      ${actionHtml}
    `;
    $addFriendResults.appendChild(li);
  }
  $addFriendResults.hidden = false;
}

$addFriendResults.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-add-username]');
  if (!btn) return;
  const username = btn.dataset.addUsername;
  btn.disabled = true;
  btn.textContent = '...';
  try {
    await api.inviteFriend(username);
    $inviteStatus.textContent = `Request sent to ${username}`;
    $inviteStatus.className = 'invite-status invite-status--success';
    $inviteStatus.hidden = false;
    $friendsSearch.value = '';
    $addFriendResults.innerHTML = '';
    $addFriendResults.hidden = true;
    loadFriends();
  } catch (err) {
    $inviteStatus.textContent = err.message;
    $inviteStatus.className = 'invite-status invite-status--error';
    $inviteStatus.hidden = false;
    btn.disabled = false;
    btn.textContent = 'Add';
  }
});

// --- Accept friend request ---

$pendingList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-accept]');
  if (!btn) return;

  const friendshipId = btn.dataset.accept;
  btn.disabled = true;
  btn.textContent = '...';

  try {
    await api.acceptFriend(friendshipId);
    showToast('Friend added!', 'success');
    loadFriends(); // Refresh the whole list
  } catch (err) {
    showToast(err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Accept';
  }
});

// ============================================================
//  DROP ZONE → FRIEND PICKER → SHARE
// ============================================================

let dragCounter = 0;

$dropZone.addEventListener('dragenter', (e) => {
  e.preventDefault();
  dragCounter++;
  $dropZone.classList.add('drop-zone--active');
});

$dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

$dropZone.addEventListener('dragleave', () => {
  dragCounter--;
  if (dragCounter === 0) $dropZone.classList.remove('drop-zone--active');
});

$dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dragCounter = 0;
  $dropZone.classList.remove('drop-zone--active');

  const url = extractUrl(e.dataTransfer);
  if (!url) {
    showToast('Not a valid URL', 'error');
    rejectAnimation();
    return;
  }

  openPicker(url);
  successAnimation();
});

document.addEventListener('paste', (e) => {
  if (e.target.closest('input, textarea')) return;
  const text = e.clipboardData.getData('text/plain').trim();
  if (!isValidUrl(text)) return;
  openPicker(text);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'RECEIVE_LINK' && currentUser) {
    const { url } = message.payload;
    if (isValidUrl(url)) openPicker(url);
  }
});

// ============================================================
//  FRIEND PICKER (share overlay)
// ============================================================

let pickerGroupsCache = [];

async function openPicker(url) {
  pendingLink = buildLinkPreview(url);
  selectedFriends.clear();
  selectedPickerGroupId = null;
  pickerGroupsCache = [];
  $pickerNote.value = '';
  $pickerSend.disabled = true;
  $pickerCirclesWrap.hidden = true;
  if ($pickerSearch) $pickerSearch.value = '';

  const platform = pendingLink.platform;
  $pickerPreview.innerHTML = `
    <div class="picker__link">
      ${platform ? `<span class="preview-card__badge" style="--badge-color: ${platform.color}">${platform.icon}<span>${platform.name}</span></span>` : ''}
      <p class="picker__link-url">${escapeHtml(truncateUrl(url, 50))}</p>
    </div>
  `;

  $pickerFriends.innerHTML = '<div class="feed__loading"><div class="spinner"></div><span>Loading friends...</span></div>';
  $picker.hidden = false;

  try {
    const [{ friends }, { groups }] = await Promise.all([
      api.getFriends(),
      api.getGroups().catch(() => ({ groups: [] })),
    ]);

    pickerGroupsCache = groups.filter((g) => g.memberCount > 1);
    renderPickerGroups();

    if (friends.length === 0 && pickerGroupsCache.length === 0) {
      $pickerFriends.innerHTML = '<p class="picker__empty">No friends or groups yet. Add some on the Friends tab!</p>';
      return;
    }

    $pickerFriends.innerHTML = '';
    friends.forEach((f) => {
      const item = document.createElement('label');
      item.className = 'picker__friend';
      item.innerHTML = `
        <input type="checkbox" class="picker__checkbox" value="${escapeAttr(f.user.id)}">
        ${avatarHtml(f.user.username, f.user.avatarKey, 'sm', f.user.avatarUrl)}
        <span class="picker__name">${escapeHtml(f.user.username)}</span>
      `;
      $pickerFriends.appendChild(item);
    });
  } catch (err) {
    $pickerFriends.innerHTML = `<p class="picker__empty">${escapeHtml(err.message)}</p>`;
  }
}

function renderPickerGroups() {
  if (pickerGroupsCache.length === 0) {
    $pickerCirclesWrap.hidden = true;
    return;
  }
  $pickerCirclesWrap.hidden = false;
  $pickerCircles.innerHTML = '';
  pickerGroupsCache.forEach((g) => {
    const active = g.id === selectedPickerGroupId;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'picker__circle-chip' + (active ? ' picker__circle-chip--active' : '');
    chip.dataset.groupId = g.id;
    const dotHtml = (g.avatarUrl || g.avatarKey)
      ? groupAvatarHtml(g, 'sm')
      : `<span class="picker__circle-dot" style="background:${escapeAttr(g.color)}"></span>`;
    chip.innerHTML = `
      ${dotHtml}
      <span class="picker__circle-name">${escapeHtml(g.name)}</span>
      <span class="picker__circle-count">${g.memberCount}</span>
    `;
    chip.addEventListener('click', () => selectPickerGroup(active ? null : g.id));
    $pickerCircles.appendChild(chip);
  });
}

function selectPickerGroup(groupId) {
  selectedPickerGroupId = groupId;
  if (groupId) {
    // Group-target: clear individual selection, disable friend checkboxes
    selectedFriends.clear();
    $pickerFriends.querySelectorAll('.picker__checkbox').forEach((cb) => {
      cb.checked = false;
      cb.disabled = true;
    });
    $pickerFriends.classList.add('picker__list--locked');
  } else {
    $pickerFriends.querySelectorAll('.picker__checkbox').forEach((cb) => { cb.disabled = false; });
    $pickerFriends.classList.remove('picker__list--locked');
  }
  $pickerSend.disabled = !groupId && selectedFriends.size === 0;
  renderPickerGroups();
}

function closePicker() {
  $picker.hidden = true;
  pendingLink = null;
  selectedFriends.clear();
  selectedPickerGroupId = null;
  $pickerFriends.querySelectorAll('.picker__checkbox').forEach((cb) => { cb.disabled = false; });
  $pickerFriends.classList.remove('picker__list--locked');
}

$pickerClose.addEventListener('click', closePicker);
$picker.addEventListener('click', (e) => { if (e.target === $picker) closePicker(); });

$pickerFriends.addEventListener('change', (e) => {
  const cb = e.target.closest('.picker__checkbox');
  if (!cb) return;
  if (cb.checked) selectedFriends.add(cb.value);
  else selectedFriends.delete(cb.value);
  $pickerSend.disabled = !selectedPickerGroupId && selectedFriends.size === 0;
});

// Filter the picker friend list as the user types.
if ($pickerSearch) {
  $pickerSearch.addEventListener('input', () => {
    const q = $pickerSearch.value.trim().toLowerCase();
    $pickerFriends.querySelectorAll('.picker__friend').forEach((row) => {
      const name = (row.querySelector('.picker__name')?.textContent || '').toLowerCase();
      row.hidden = q !== '' && !name.includes(q);
    });
  });
}

// ============================================================
//  START CONVERSATION (Inbox FAB → friend list → open thread)
// ============================================================

let startConvFriendsCache = [];

async function openStartConvPicker() {
  if (!$startConvPicker) return;
  $startConvPicker.hidden = false;
  $startConvSearch.value = '';
  $startConvFriends.innerHTML =
    '<div class="feed__loading"><div class="spinner"></div><span>Loading friends...</span></div>';

  try {
    const { friends } = await api.getFriends();
    startConvFriendsCache = friends;
    if (friends.length === 0) {
      $startConvFriends.innerHTML =
        '<p class="picker__empty">No friends yet. Add some on the Friends tab!</p>';
      return;
    }
    renderStartConvFriends('');
    $startConvSearch.focus();
  } catch (err) {
    $startConvFriends.innerHTML = `<p class="picker__empty">${escapeHtml(err.message)}</p>`;
  }
}

function renderStartConvFriends(query) {
  const q = (query || '').trim().toLowerCase();
  const matches = q
    ? startConvFriendsCache.filter((f) => f.user.username.toLowerCase().includes(q))
    : startConvFriendsCache;

  if (matches.length === 0) {
    $startConvFriends.innerHTML = `<p class="picker__empty">No friends match "${escapeHtml(q)}"</p>`;
    return;
  }

  $startConvFriends.innerHTML = '';
  matches.forEach((f) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'start-conv__friend';
    row.dataset.friendId = f.user.id;
    row.innerHTML = `
      ${avatarHtml(f.user.username, f.user.avatarKey, 'sm', f.user.avatarUrl)}
      <span class="picker__name">${escapeHtml(f.user.username)}</span>
    `;
    row.addEventListener('click', () => startConversationWith(f.user));
    $startConvFriends.appendChild(row);
  });
}

function closeStartConvPicker() {
  if (!$startConvPicker) return;
  $startConvPicker.hidden = true;
  startConvFriendsCache = [];
}

function startConversationWith(user) {
  closeStartConvPicker();
  openConversation({
    kind:         'peer',
    peer:         { id: user.id, username: user.username, avatarKey: user.avatarKey, avatarUrl: user.avatarUrl },
    group:        null,
    lastShareId:  null,
    lastSnippet:  '',
    lastSenderId: null,
    lastAt:       null,
    unreadCount:  0,
  });
}

if ($startConvBtn)   $startConvBtn.addEventListener('click', openStartConvPicker);
if ($startConvClose) $startConvClose.addEventListener('click', closeStartConvPicker);
if ($startConvPicker) {
  $startConvPicker.addEventListener('click', (e) => {
    if (e.target === $startConvPicker) closeStartConvPicker();
  });
}
if ($startConvSearch) {
  $startConvSearch.addEventListener('input', () => renderStartConvFriends($startConvSearch.value));
}

$pickerSend.addEventListener('click', async () => {
  if (!pendingLink) return;
  if (!selectedPickerGroupId && selectedFriends.size === 0) return;

  $pickerSend.disabled = true;
  $pickerSend.textContent = 'Sending...';

  try {
    const platform = pendingLink.platform;
    await api.share(
      pendingLink.url,
      selectedPickerGroupId ? null : [...selectedFriends],
      {
        title:    pendingLink.sublabel || undefined,
        note:     $pickerNote.value.trim() || undefined,
        platform: platform?.id || undefined,
        groupId:  selectedPickerGroupId || undefined,
      }
    );

    closePicker();
    showToast('Shared!', 'success');
    if (currentView === 'inbox' && !currentThread) loadConversations();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    $pickerSend.disabled = false;
    $pickerSend.textContent = 'Send';
  }
});

// ============================================================
//  DROP ZONE ANIMATIONS
// ============================================================

function successAnimation() {
  $dropZone.classList.add('drop-zone--success');
  $dropText.textContent = 'Link captured!';
  setTimeout(() => {
    $dropZone.classList.remove('drop-zone--success');
    $dropText.textContent = 'Drag a link here to share';
  }, 1200);
}

function rejectAnimation() {
  $dropZone.classList.add('drop-zone--error');
  $dropText.textContent = 'Not a valid link';
  setTimeout(() => {
    $dropZone.classList.remove('drop-zone--error');
    $dropText.textContent = 'Drag a link here to share';
  }, 1500);
}

// ============================================================
//  UTILITIES
// ============================================================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1).trimEnd() + '…' : str;
}

function truncateUrl(url, max) {
  try {
    const u = new URL(url);
    const display = u.hostname.replace('www.', '') + u.pathname + u.search + u.hash;
    return display.length > max ? display.slice(0, max) + '...' : display;
  } catch {
    return url.length > max ? url.slice(0, max) + '...' : url;
  }
}

function timeAgo(dateStr) {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

// ============================================================
//  AVATAR PICKER (settings)
// ============================================================

const $settingsAvatarCurrent = document.getElementById('settings-avatar-current');
const $settingsAvatarEdit    = document.getElementById('settings-avatar-edit');
const $settingsAvatarPicker  = document.getElementById('settings-avatar-picker');
const $settingsAvatarFile    = document.getElementById('settings-avatar-file');

function renderSettingsAvatar() {
  if (!$settingsAvatarCurrent || !currentUser) return;
  $settingsAvatarCurrent.innerHTML = avatarHtml(
    currentUser.username || '?',
    currentUser.avatarKey,
    'md',
    currentUser.avatarUrl
  );
}

function renderAvatarPickerGrid() {
  $settingsAvatarPicker.innerHTML = '';

  // Upload tile — opens the file input.
  const uploadBtn = document.createElement('button');
  uploadBtn.type = 'button';
  uploadBtn.className = 'group-avatar-swatch group-avatar-swatch--upload' + (currentUser?.avatarUrl ? ' group-avatar-swatch--active' : '');
  uploadBtn.title = 'Upload photo';
  uploadBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
  uploadBtn.addEventListener('click', () => $settingsAvatarFile.click());
  $settingsAvatarPicker.appendChild(uploadBtn);

  // None / initials option
  const noneBtn = document.createElement('button');
  noneBtn.type = 'button';
  noneBtn.className = 'group-avatar-swatch group-avatar-swatch--none' + (!currentUser?.avatarKey && !currentUser?.avatarUrl ? ' group-avatar-swatch--active' : '');
  noneBtn.title = 'Initial only';
  noneBtn.innerHTML = `<span class="group-avatar-swatch__x">∅</span>`;
  noneBtn.addEventListener('click', () => pickAvatar(null));
  $settingsAvatarPicker.appendChild(noneBtn);

  AVATAR_PRESETS.forEach((a) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'group-avatar-swatch' + (currentUser?.avatarKey === a.key && !currentUser?.avatarUrl ? ' group-avatar-swatch--active' : '');
    btn.style.background = a.bg;
    btn.title = a.key;
    btn.innerHTML = `<span class="group-avatar-swatch__emoji">${a.emoji}</span>`;
    btn.addEventListener('click', () => pickAvatar(a.key));
    $settingsAvatarPicker.appendChild(btn);
  });
}

async function pickAvatar(key) {
  try {
    const { user } = await api.updateAvatar(key);
    currentUser = user;
    renderSettingsAvatar();
    renderAvatarPickerGrid();
    showToast('Avatar updated', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

if ($settingsAvatarFile) {
  $settingsAvatarFile.addEventListener('change', async () => {
    const file = $settingsAvatarFile.files?.[0];
    if (!file) return;
    showToast('Uploading photo...', 'success');
    try {
      const { user } = await api.uploadProfileAvatar(file);
      currentUser = user;
      renderSettingsAvatar();
      renderAvatarPickerGrid();
      showToast('Photo uploaded', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      $settingsAvatarFile.value = '';
    }
  });
}

if ($settingsAvatarEdit) {
  $settingsAvatarEdit.addEventListener('click', () => {
    $settingsAvatarPicker.hidden = !$settingsAvatarPicker.hidden;
    if (!$settingsAvatarPicker.hidden) renderAvatarPickerGrid();
  });
}

// ============================================================
//  NOTIFICATIONS TOGGLE (settings)
// ============================================================

const $notificationsToggle = document.getElementById('settings-notifications-toggle');

if ($notificationsToggle) {
  chrome.storage.local.get(['notificationsEnabled'], (data) => {
    $notificationsToggle.checked = data.notificationsEnabled !== false;
  });

  $notificationsToggle.addEventListener('change', () => {
    chrome.storage.local.set({ notificationsEnabled: $notificationsToggle.checked });
    showToast($notificationsToggle.checked ? 'Notifications on' : 'Notifications off', 'success');
  });
}

// ============================================================
//  GROUPS (shared multi-user spaces)
// ============================================================

const $groupsList       = document.getElementById('groups-list');
const $groupsEmpty      = document.getElementById('groups-empty');
const $newGroupBtn      = document.getElementById('new-group-btn');
const $groupEditor      = document.getElementById('group-editor');
const $groupEditorTitle = document.getElementById('group-editor-title');
const $groupEditorName  = document.getElementById('group-editor-name');
const $groupEditorAvatars = document.getElementById('group-editor-avatars');
const $groupEditorAvatarFile = document.getElementById('group-editor-avatar-file');
const $groupEditorColors  = document.getElementById('group-editor-colors');
const $groupEditorMembers = document.getElementById('group-editor-members');
const $groupEditorMemberSearch = document.getElementById('group-editor-member-search');
const $groupEditorError = document.getElementById('group-editor-error');
const $groupEditorClose = document.getElementById('group-editor-close');
const $groupEditorSave  = document.getElementById('group-editor-save');
const $groupEditorDelete = document.getElementById('group-editor-delete');

const GROUP_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#64748b'];

let groupsCache = [];
let editingGroup = null;
let groupEditorColor = GROUP_COLORS[0];
let groupEditorAvatarKey = null;
let groupEditorAvatarUrl = null;
let groupEditorMembers = new Set();

async function loadGroups() {
  try {
    const { groups } = await api.getGroups();
    groupsCache = groups;
    renderGroupsList();
  } catch (err) {
    showError(err.message);
  }
}

function renderGroupsList() {
  $groupsList.innerHTML = '';
  if (groupsCache.length === 0) {
    $groupsList.appendChild($groupsEmpty);
    $groupsEmpty.hidden = false;
    return;
  }
  $groupsEmpty.hidden = true;
  groupsCache.forEach((g) => {
    const li = document.createElement('li');
    li.className = 'circle-row';
    li.dataset.groupId = g.id;
    const memberSummary = g.members.slice(0, 3).map((m) => escapeHtml(m.username)).join(', ');
    const extra = g.memberCount > 3 ? ` +${g.memberCount - 3}` : '';
    li.innerHTML = `
      ${groupAvatarHtml(g, 'sm')}
      <div class="circle-row__info">
        <span class="circle-row__name">${escapeHtml(g.name)}</span>
        <span class="circle-row__members">${g.memberCount <= 1 ? 'Just you — add members' : memberSummary + extra}</span>
      </div>
      <button class="btn-icon circle-row__edit" type="button" title="Edit">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
      </button>
    `;
    li.querySelector('.circle-row__edit').addEventListener('click', (e) => {
      e.stopPropagation();
      openGroupEditor(g);
    });
    li.addEventListener('click', () => openGroupEditor(g));
    $groupsList.appendChild(li);
  });
}

function renderGroupColorSwatches() {
  $groupEditorColors.innerHTML = '';
  GROUP_COLORS.forEach((color) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'circle-color-swatch';
    if (color === groupEditorColor) btn.classList.add('circle-color-swatch--active');
    btn.style.background = color;
    btn.addEventListener('click', () => {
      groupEditorColor = color;
      renderGroupColorSwatches();
    });
    $groupEditorColors.appendChild(btn);
  });
}

function renderGroupAvatarSwatches() {
  $groupEditorAvatars.innerHTML = '';

  // Upload tile (only enabled when the group already exists — uploads need a target group_id).
  const uploadBtn = document.createElement('button');
  uploadBtn.type = 'button';
  uploadBtn.className = 'group-avatar-swatch group-avatar-swatch--upload' + (groupEditorAvatarUrl ? ' group-avatar-swatch--active' : '');
  uploadBtn.title = editingGroup ? 'Upload photo' : 'Save the group first to upload a photo';
  uploadBtn.disabled = !editingGroup;
  uploadBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;
  if (editingGroup) uploadBtn.addEventListener('click', () => $groupEditorAvatarFile.click());
  $groupEditorAvatars.appendChild(uploadBtn);

  // "None" option
  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'group-avatar-swatch group-avatar-swatch--none' + (groupEditorAvatarKey == null && !groupEditorAvatarUrl ? ' group-avatar-swatch--active' : '');
  none.title = 'Initial only';
  none.innerHTML = `<span class="group-avatar-swatch__x">∅</span>`;
  none.addEventListener('click', () => {
    groupEditorAvatarKey = null;
    renderGroupAvatarSwatches();
  });
  $groupEditorAvatars.appendChild(none);

  AVATAR_PRESETS.forEach((a) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'group-avatar-swatch' + (groupEditorAvatarKey === a.key && !groupEditorAvatarUrl ? ' group-avatar-swatch--active' : '');
    btn.style.background = a.bg;
    btn.title = a.key;
    btn.innerHTML = `<span class="group-avatar-swatch__emoji">${a.emoji}</span>`;
    btn.addEventListener('click', () => {
      groupEditorAvatarKey = a.key;
      renderGroupAvatarSwatches();
    });
    $groupEditorAvatars.appendChild(btn);
  });
}

if ($groupEditorAvatarFile) {
  $groupEditorAvatarFile.addEventListener('change', async () => {
    const file = $groupEditorAvatarFile.files?.[0];
    if (!file || !editingGroup) return;
    showToast('Uploading photo...', 'success');
    try {
      const { avatarUrl } = await api.uploadGroupAvatar(editingGroup.id, file);
      groupEditorAvatarUrl = avatarUrl;
      groupEditorAvatarKey = null;
      editingGroup.avatarUrl = avatarUrl;
      editingGroup.avatarKey = null;
      renderGroupAvatarSwatches();
      showToast('Photo uploaded', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      $groupEditorAvatarFile.value = '';
    }
  });
}

async function openGroupEditor(group) {
  editingGroup = group || null;
  groupEditorColor = group?.color || GROUP_COLORS[0];
  groupEditorAvatarKey = group?.avatarKey || null;
  groupEditorAvatarUrl = group?.avatarUrl || null;
  groupEditorMembers = new Set((group?.members || []).map((m) => m.id).filter((id) => !currentUser || id !== currentUser.id));

  $groupEditorTitle.textContent = group ? 'Edit group' : 'New group';
  $groupEditorName.value = group?.name || '';
  $groupEditorError.hidden = true;
  $groupEditorDelete.hidden = !group;
  renderGroupColorSwatches();
  renderGroupAvatarSwatches();

  $groupEditor.hidden = false;
  $groupEditorName.focus();
  $groupEditorMembers.innerHTML = '<div class="feed__loading"><div class="spinner"></div><span>Loading friends...</span></div>';
  if ($groupEditorMemberSearch) $groupEditorMemberSearch.value = '';

  try {
    const { friends } = await api.getFriends();
    if (friends.length === 0) {
      $groupEditorMembers.innerHTML = '<p class="picker__empty">Add some friends first.</p>';
      return;
    }
    $groupEditorMembers.innerHTML = '';
    friends.forEach((f) => {
      const item = document.createElement('label');
      item.className = 'picker__friend';
      item.dataset.username = f.user.username.toLowerCase();
      const checked = groupEditorMembers.has(f.user.id) ? 'checked' : '';
      item.innerHTML = `
        <input type="checkbox" class="picker__checkbox" value="${escapeAttr(f.user.id)}" ${checked}>
        ${avatarHtml(f.user.username, f.user.avatarKey, 'sm', f.user.avatarUrl)}
        <span class="picker__name">${escapeHtml(f.user.username)}</span>
      `;
      const cb = item.querySelector('input');
      cb.addEventListener('change', () => {
        if (cb.checked) groupEditorMembers.add(f.user.id);
        else            groupEditorMembers.delete(f.user.id);
      });
      $groupEditorMembers.appendChild(item);
    });
  } catch (err) {
    $groupEditorMembers.innerHTML = `<p class="picker__empty">${escapeHtml(err.message)}</p>`;
  }
}

function closeGroupEditor() {
  $groupEditor.hidden = true;
  editingGroup = null;
  groupEditorMembers.clear();
}

$newGroupBtn.addEventListener('click', () => openGroupEditor(null));
$groupEditorClose.addEventListener('click', closeGroupEditor);

if ($groupEditorMemberSearch) {
  $groupEditorMemberSearch.addEventListener('input', () => {
    const q = $groupEditorMemberSearch.value.trim().toLowerCase();
    $groupEditorMembers.querySelectorAll('.picker__friend').forEach((row) => {
      const u = row.dataset.username || '';
      row.hidden = q && !u.includes(q);
    });
  });
}
$groupEditor.addEventListener('click', (e) => { if (e.target === $groupEditor) closeGroupEditor(); });

$groupEditorSave.addEventListener('click', async () => {
  const name = $groupEditorName.value.trim();
  if (!name) {
    $groupEditorError.textContent = 'Name required';
    $groupEditorError.hidden = false;
    return;
  }
  $groupEditorError.hidden = true;
  $groupEditorSave.disabled = true;
  $groupEditorSave.textContent = 'Saving...';

  try {
    let groupId;
    if (editingGroup) {
      groupId = editingGroup.id;
      const changed =
        name !== editingGroup.name ||
        groupEditorColor !== editingGroup.color ||
        groupEditorAvatarKey !== editingGroup.avatarKey;
      if (changed) {
        await api.updateGroup(groupId, { name, color: groupEditorColor, avatarKey: groupEditorAvatarKey });
      }
    } else {
      const { group } = await api.createGroup(name, { color: groupEditorColor, avatarKey: groupEditorAvatarKey });
      groupId = group.id;
    }
    await api.setGroupMembers(groupId, [...groupEditorMembers]);
    showToast(editingGroup ? 'Group saved' : 'Group created', 'success');
    closeGroupEditor();
    loadGroups();
  } catch (err) {
    $groupEditorError.textContent = err.message;
    $groupEditorError.hidden = false;
  } finally {
    $groupEditorSave.disabled = false;
    $groupEditorSave.textContent = 'Save';
  }
});

$groupEditorDelete.addEventListener('click', async () => {
  if (!editingGroup) return;
  if (!confirm(`Delete group "${editingGroup.name}"? All conversation history stays in members' inboxes but the group disappears.`)) return;
  $groupEditorDelete.disabled = true;
  try {
    await api.deleteGroup(editingGroup.id);
    showToast('Group deleted', 'success');
    closeGroupEditor();
    loadGroups();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    $groupEditorDelete.disabled = false;
  }
});

// ============================================================
//  SAVED VIEW (personal bookmark archive)
// ============================================================

const $savedLoading  = document.getElementById('saved-loading');
const $savedList     = document.getElementById('saved-list');
const $savedLoadMore = document.getElementById('saved-load-more');
const $savedSearch    = document.getElementById('saved-search');
const $savedForm      = document.getElementById('saved-form');
const $savedUrlInput  = document.getElementById('saved-url-input');
const $savedNoteInput = document.getElementById('saved-note-input');
const $savedAddBtn    = document.getElementById('saved-add-btn');
const $savedFormError = document.getElementById('saved-form-error');

let savedCursor = null;
let isSavedLoadingMore = false;
let savedCache = [];

async function loadBookmarks(append = false) {
  if (!append) {
    $savedLoading.hidden = false;
    $savedList.innerHTML = '';
    savedCursor = null;
    savedCache = [];
  }

  try {
    const { bookmarks, nextCursor } = await api.listBookmarks(append ? savedCursor : undefined);
    savedCursor = nextCursor;
    savedCache.push(...bookmarks);
    renderSavedList();
    $savedLoadMore.hidden = !nextCursor;
  } catch (err) {
    if (!append) {
      $savedList.innerHTML = `
        <li class="feed__error-state">
          <p class="feed__error-text">${escapeHtml(err.message)}</p>
          <button class="btn btn--ghost" id="saved-retry">Try again</button>
        </li>`;
      document.getElementById('saved-retry')?.addEventListener('click', () => loadBookmarks());
    }
    showError(err.message);
  } finally {
    $savedLoading.hidden = true;
    isSavedLoadingMore = false;
    $savedLoadMore.disabled = false;
    $savedLoadMore.textContent = 'Load more';
  }
}

function bookmarkMatchesQuery(b, q) {
  if (!q) return true;
  const fields = [b.note, b.url, b.title, b.ogTitle, b.ogDescription];
  return fields.some((f) => typeof f === 'string' && f.toLowerCase().includes(q));
}

function renderSavedList() {
  const q = ($savedSearch?.value || '').trim().toLowerCase();
  $savedList.innerHTML = '';

  if (savedCache.length === 0) {
    $savedList.innerHTML = `
      <li class="feed__empty-state">
        <svg class="feed__empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/>
        </svg>
        <p class="feed__empty-title">Nothing saved yet</p>
        <p class="feed__empty-text">Save links from your inbox, or paste one above</p>
      </li>`;
    return;
  }

  const matches = q ? savedCache.filter((b) => bookmarkMatchesQuery(b, q)) : savedCache;
  if (matches.length === 0) {
    const moreHint = savedCursor ? ' Try Load more to search older links.' : '';
    $savedList.innerHTML = `
      <li class="feed__empty-state">
        <p class="feed__empty-title">No matches</p>
        <p class="feed__empty-text">Nothing matched "${escapeHtml(q)}".${moreHint}</p>
      </li>`;
    return;
  }
  matches.forEach(renderBookmarkItem);
}

function renderBookmarkItem(b) {
  const preview = buildLinkPreview(b.url);
  const li = document.createElement('li');
  li.className = 'preview-card';
  li.dataset.bookmarkId = b.id;

  const displayTitle = b.ogTitle || b.title;
  const displayUrl = truncateUrl(b.url, 55);
  const time = timeAgo(b.savedAt);

  const mediaHtml = b.ogImage
    ? `<a class="preview-card__media" href="${escapeAttr(b.url)}" target="_blank" rel="noopener">
         <img class="preview-card__image" src="${escapeAttr(b.ogImage)}" alt="" loading="lazy" referrerpolicy="no-referrer">
       </a>`
    : '';

  li.innerHTML = `
    <div class="preview-card__header">
      ${buildPlatformBadge(preview)}
      <div class="preview-card__header-actions">
        <button class="preview-card__icon-btn" title="Remove" data-bookmark-delete="${escapeAttr(b.id)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>
        </button>
      </div>
    </div>
    ${mediaHtml}
    ${displayTitle ? `<p class="preview-card__title">${escapeHtml(displayTitle)}</p>` : ''}
    ${b.ogDescription ? `<p class="preview-card__og-desc">${escapeHtml(b.ogDescription)}</p>` : ''}
    ${b.note ? `<p class="preview-card__note">${escapeHtml(b.note)}</p>` : ''}
    <a class="preview-card__url-link" href="${escapeAttr(b.url)}" target="_blank" rel="noopener">${escapeHtml(displayUrl)}</a>
    <div class="preview-card__footer">
      <span class="preview-card__time">Saved ${time}</span>
    </div>
  `;
  const img = li.querySelector('.preview-card__image');
  if (img) {
    img.addEventListener('error', () => {
      img.closest('.preview-card__media')?.remove();
    });
  }
  $savedList.appendChild(li);
}

$savedList.addEventListener('click', async (e) => {
  const delBtn = e.target.closest('[data-bookmark-delete]');
  if (!delBtn) return;
  e.preventDefault();
  e.stopPropagation();
  const id = delBtn.dataset.bookmarkDelete;
  const card = delBtn.closest('.preview-card');
  try {
    await api.deleteBookmark(id);
    savedCache = savedCache.filter((b) => b.id !== id);
    card.style.transition = 'opacity 0.2s, transform 0.2s';
    card.style.opacity = '0';
    card.style.transform = 'translateX(20px)';
    setTimeout(() => {
      card.remove();
      if (savedCache.length === 0) loadBookmarks();
      else if ($savedList.children.length === 0) renderSavedList();
    }, 200);
    showToast('Removed', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

$savedLoadMore.addEventListener('click', () => {
  if (isSavedLoadingMore) return;
  isSavedLoadingMore = true;
  $savedLoadMore.disabled = true;
  $savedLoadMore.textContent = 'Loading...';
  loadBookmarks(true);
});

if ($savedSearch) {
  $savedSearch.addEventListener('input', renderSavedList);
}

// ============================================================
//  SAVED FORM (progressive: paste URL → reveal note + save)
// ============================================================

function refreshSavedFormState() {
  const url = $savedUrlInput.value.trim();
  const valid = isValidUrl(url);
  $savedNoteInput.hidden = !valid;
  $savedAddBtn.hidden = !valid;
  if (!valid) {
    $savedNoteInput.value = '';
    $savedFormError.hidden = true;
  }
}

$savedUrlInput.addEventListener('input', refreshSavedFormState);

$savedForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = $savedUrlInput.value.trim();
  if (!isValidUrl(url)) {
    $savedFormError.textContent = 'Enter a valid URL';
    $savedFormError.hidden = false;
    return;
  }
  $savedFormError.hidden = true;
  $savedAddBtn.disabled = true;
  try {
    const preview = buildLinkPreview(url);
    await api.saveBookmark(url, {
      note:     $savedNoteInput.value.trim() || undefined,
      platform: preview.platform?.id || undefined,
      title:    preview.sublabel || undefined,
    });
    $savedUrlInput.value = '';
    $savedNoteInput.value = '';
    refreshSavedFormState();
    showToast('Saved', 'success');
    loadBookmarks();
  } catch (err) {
    $savedFormError.textContent = err.message;
    $savedFormError.hidden = false;
  } finally {
    $savedAddBtn.disabled = false;
  }
});

// ============================================================
//  BOOT
// ============================================================

init();
