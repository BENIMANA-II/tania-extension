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

import { api, getAuth, setAuth, clearAuth } from '../shared/api.js';
import { extractUrl, isValidUrl, buildLinkPreview } from './lib/link-utils.js';

// --- State ---

let currentUser = null;
let feedCursor = null;
let feedPollingId = null;
let pendingLink = null;
let unreadCount = 0;
let pendingRequestCount = 0;
let currentView = 'inbox';
const selectedFriends = new Set();

// --- DOM: Auth ---

const $loginView     = document.getElementById('view-login');
const $appView       = document.getElementById('view-app');
const $signinForm    = document.getElementById('signin-form');
const $signinId      = document.getElementById('signin-identifier');
const $signinBtn     = document.getElementById('signin-btn');
const $signinError   = document.getElementById('signin-error');
const $signupForm    = document.getElementById('signup-form');
const $signupEmail   = document.getElementById('signup-email');
const $signupUsername = document.getElementById('signup-username');
const $signupBtn     = document.getElementById('signup-btn');
const $signupError   = document.getElementById('signup-error');
const $showSignup    = document.getElementById('show-signup');
const $showSignin    = document.getElementById('show-signin');

// --- DOM: Shared ---

const $errorBanner  = document.getElementById('error-banner');
const $errorText    = document.getElementById('error-banner-text');
const $errorClose   = document.getElementById('error-banner-close');
const $toast        = document.getElementById('toast');
const $navUnread    = document.getElementById('nav-unread-badge');
const $navPending   = document.getElementById('nav-pending-badge');

// --- DOM: Views ---

const $viewInbox      = document.getElementById('view-inbox');
const $viewSent       = document.getElementById('view-sent');
const $viewSentDetail = document.getElementById('view-sent-detail');
const $viewFriends    = document.getElementById('view-friends');
const $viewSettings   = document.getElementById('view-settings');

// --- DOM: Inbox ---

const $dropZone     = document.getElementById('drop-zone');
const $dropText     = $dropZone.querySelector('.drop-zone__text');
const $feedLoading  = document.getElementById('feed-loading');
const $feedList     = document.getElementById('feed-list');
const $loadMore     = document.getElementById('feed-load-more');

// --- DOM: Friends ---

const $inviteForm     = document.getElementById('invite-form');
const $inviteUsername  = document.getElementById('invite-username');
const $inviteBtn      = document.getElementById('invite-btn');
const $inviteStatus   = document.getElementById('invite-status');
const $inviteSearchResults = document.getElementById('invite-search-results');
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

const $picker        = document.getElementById('friend-picker');
const $pickerClose   = document.getElementById('picker-close');
const $pickerPreview = document.getElementById('picker-preview');
const $pickerFriends = document.getElementById('picker-friends');
const $pickerNote    = document.getElementById('picker-note');
const $pickerSend    = document.getElementById('picker-send');

// ============================================================
//  SESSION EXPIRY — auto-logout when JWT expires
// ============================================================

window.addEventListener('tania:session-expired', () => {
  currentUser = null;
  feedCursor = null;
  $feedList.innerHTML = '';
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
  const { token, user } = await getAuth();

  await showLoader(5000);
  await hideLoader();

  if (token && user) {
    currentUser = user;
    showApp();
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

// Sign-in: show both emails and usernames
setupSuggest(
  $signinId,
  document.getElementById('signin-suggestions'),
  (filter) => {
    const q = filter.toLowerCase();
    const seen = new Set();
    const out = [];
    for (const l of savedLoginsList) {
      for (const val of [l.email, l.username]) {
        if (val && !seen.has(val) && (!q || val.toLowerCase().includes(q))) {
          seen.add(val);
          out.push(val);
        }
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
  $signinId.value = '';
  $signupEmail.value = '';
  $signupUsername.value = '';
  $signinError.hidden = true;
  $signupError.hidden = true;

  loadSavedLogins();
}

function showApp() {
  $loginView.hidden = true;
  $appView.hidden = false;
  $settingsUsername.textContent = currentUser.username;
  $settingsEmail.textContent = currentUser.email;
  switchView('inbox');
  startPolling();
  refreshPendingCount();
}

async function logout() {
  await clearAuth();
  currentUser = null;
  feedCursor = null;
  resetViewState();

  await showLoader(2000);
  await hideLoader();
  showLogin();
}

/** Clear all transient UI state so nothing leaks between sessions. */
function resetViewState() {
  // Inbox
  $feedList.innerHTML = '';
  $loadMore.hidden = true;

  // Friends
  $inviteStatus.hidden = true;
  $inviteUsername.value = '';
  $pendingList.innerHTML = '';
  $pendingSection.hidden = true;
  $outgoingList.innerHTML = '';
  $outgoingSection.hidden = true;
  $friendsList.innerHTML = '';
  $friendsSearch.value = '';
  $friendsSearch.hidden = true;
  cachedFriendRows = [];
  pendingRequestCount = 0;
  renderPendingBadge();

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
  $signinId.focus();
});

// --- Sign In ---

$signinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  $signinError.hidden = true;
  $signinBtn.disabled = true;
  $signinBtn.textContent = 'Signing in...';

  try {
    const result = await api.signin($signinId.value.trim());
    await setAuth(result.token, result.user);
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
    const email = $signupEmail.value.trim();
    const username = $signupUsername.value.trim();
    const result = await api.signup(email, username);
    await setAuth(result.token, result.user);
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
    currentUser.username = user.username;
    const { token } = await getAuth();
    await setAuth(token, user);
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

const views = { inbox: $viewInbox, sent: $viewSent, friends: $viewFriends, settings: $viewSettings };
const navButtons = document.querySelectorAll('.nav__btn');

function switchView(name) {
  currentView = name;

  // Always hide detail views when switching tabs
  $viewDetail.hidden = true;
  $viewSentDetail.hidden = true;

  // Toggle view containers
  for (const [key, el] of Object.entries(views)) {
    el.hidden = key !== name;
  }

  // Toggle nav active state
  navButtons.forEach((btn) => {
    btn.classList.toggle('nav__btn--active', btn.dataset.view === name);
  });

  // Load data on view enter
  if (name === 'inbox') loadFeed();
  if (name === 'sent') loadSent();
  if (name === 'friends') loadFriends();
}

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
//  FEED (INBOX VIEW)
// ============================================================

let isLoadingMore = false;

async function loadFeed(append = false) {
  if (!append) {
    $feedLoading.hidden = false;
    $feedList.innerHTML = '';
    feedCursor = null;
    feedItemsMap.clear();
  }

  try {
    const { feed, nextCursor } = await api.getFeed(append ? feedCursor : undefined);
    feedCursor = nextCursor;
    hideError();

    if (!append && feed.length === 0) {
      $feedList.innerHTML = `
        <li class="feed__empty-state">
          <svg class="feed__empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/>
            <path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/>
          </svg>
          <p class="feed__empty-title">Your inbox is empty</p>
          <p class="feed__empty-text">Links shared by friends will appear here</p>
        </li>`;
    } else {
      feed.forEach((item) => renderFeedItem(item));
    }

    $loadMore.hidden = !nextCursor;
    refreshUnreadCount();
  } catch (err) {
    if (!append) {
      $feedList.innerHTML = `
        <li class="feed__error-state">
          <svg class="feed__error-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <p class="feed__error-text">Could not load your feed</p>
          <button class="btn btn--ghost" id="feed-retry">Try again</button>
        </li>`;
      document.getElementById('feed-retry')?.addEventListener('click', () => loadFeed());
    }
    showError(err.message);
  } finally {
    $feedLoading.hidden = true;
    isLoadingMore = false;
    $loadMore.disabled = false;
    $loadMore.textContent = 'Load more';
  }
}

const DOUBLE_TICK_SVG = '<svg width="16" height="10" viewBox="0 0 16 10"><polyline points="1 5 4.5 8.5 8 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><polyline points="5.5 5 9 8.5 14.5 1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Store feed items so detail view can look them up
const feedItemsMap = new Map();

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

function renderFeedItem(item) {
  const preview = buildLinkPreview(item.url);
  feedItemsMap.set(item.id, { item, preview });

  const li = document.createElement('li');
  li.className = `preview-card${item.read ? '' : ' preview-card--unread'}`;
  li.dataset.shareId = item.id;

  const time = timeAgo(item.sharedAt);

  const statusHtml = item.read
    ? `<span class="preview-card__status preview-card__status--seen">${DOUBLE_TICK_SVG}</span>`
    : `<span class="preview-card__status preview-card__status--delivered">${DOUBLE_TICK_SVG}</span>`;

  li.innerHTML = `
    <div class="preview-card__header">
      ${buildPlatformBadge(preview)}
      <div class="preview-card__header-actions">
        <span class="preview-card__sender">from ${escapeHtml(item.sender.username)}</span>
        <button class="preview-card__dismiss" title="Dismiss" data-dismiss="${escapeAttr(item.id)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
    </div>
    ${item.note ? `<p class="preview-card__note">${escapeHtml(item.note)}</p>` : ''}
    <div class="preview-card__footer">
      <span class="preview-card__time">${time}</span>
      ${statusHtml}
    </div>
  `;

  $feedList.appendChild(li);
}

// --- Detail view ---

const $viewDetail = document.getElementById('view-detail');
const $detailContent = document.getElementById('detail-content');
const $detailBack = document.getElementById('detail-back');

function openDetail(shareId) {
  const entry = feedItemsMap.get(shareId);
  if (!entry) return;
  const { item, preview } = entry;
  const displayTitle = item.ogTitle || item.title;
  const displayUrl = truncateUrl(item.url, 55);
  const time = timeAgo(item.sharedAt);

  $detailContent.innerHTML = `
    <div class="detail__card">
      <div class="preview-card__header">
        ${buildPlatformBadge(preview)}
        <span class="preview-card__sender">from ${escapeHtml(item.sender.username)}</span>
      </div>
      ${item.note ? `<p class="detail__note">${escapeHtml(item.note)}</p>` : ''}
      ${displayTitle ? `<h2 class="detail__title">${escapeHtml(displayTitle)}</h2>` : ''}
      ${item.ogDescription ? `<p class="detail__desc">${escapeHtml(item.ogDescription)}</p>` : ''}
      <a class="detail__url" href="${escapeAttr(item.url)}" target="_blank" rel="noopener">

        <span>${escapeHtml(displayUrl)}</span>
      </a>
      <div class="preview-card__footer">
        <span class="preview-card__time">${time}</span>
        <span class="preview-card__status preview-card__status--seen">${DOUBLE_TICK_SVG}</span>
      </div>
    </div>
  `;

  // Hide inbox, show detail
  $viewInbox.hidden = true;
  $viewDetail.hidden = false;

  // Mark as seen + update the inbox card status
  const card = $feedList.querySelector(`[data-share-id="${shareId}"]`);
  if (card) {
    card.classList.remove('preview-card--unread');
    const statusEl = card.querySelector('.preview-card__status');
    if (statusEl) {
      statusEl.className = 'preview-card__status preview-card__status--seen';
      statusEl.innerHTML = `${DOUBLE_TICK_SVG}`;
    }
  }
  if (!item.read) {
    item.read = true;
    api.markRead(shareId).then(() => refreshUnreadCount()).catch(() => {});
  }
}

$detailBack.addEventListener('click', () => {
  $viewDetail.hidden = true;
  $viewInbox.hidden = false;
});

// --- Feed click handlers ---

$feedList.addEventListener('click', async (e) => {
  // Dismiss button
  const dismissBtn = e.target.closest('[data-dismiss]');
  if (dismissBtn) {
    e.preventDefault();
    e.stopPropagation();
    const shareId = dismissBtn.dataset.dismiss;
    const card = dismissBtn.closest('.preview-card');
    try {
      await api.dismissShare(shareId);
      card.style.transition = 'opacity 0.2s, transform 0.2s';
      card.style.opacity = '0';
      card.style.transform = 'translateX(20px)';
      setTimeout(() => card.remove(), 200);
      showToast('Dismissed', 'success');
      refreshUnreadCount();
    } catch (err) {
      showToast(err.message, 'error');
    }
    return;
  }

  // Click card to open detail
  const card = e.target.closest('.preview-card');
  if (!card) return;
  const shareId = card.dataset.shareId;
  if (shareId) openDetail(shareId);
});

// Load more with loading state
$loadMore.addEventListener('click', () => {
  if (isLoadingMore) return;
  isLoadingMore = true;
  $loadMore.disabled = true;
  $loadMore.textContent = 'Loading...';
  loadFeed(true);
});

// ============================================================
//  SENT VIEW
// ============================================================

const $sentLoading       = document.getElementById('sent-loading');
const $sentList          = document.getElementById('sent-list');
const $sentLoadMore      = document.getElementById('sent-load-more');
const $sentDetailContent = document.getElementById('sent-detail-content');
const $sentDetailBack    = document.getElementById('sent-detail-back');

let sentCursor = null;
let sentItemsMap = new Map();
let isSentLoadingMore = false;

async function loadSent(append = false) {
  if (!append) {
    $sentLoading.hidden = false;
    $sentList.innerHTML = '';
    sentCursor = null;
    sentItemsMap.clear();
  }

  try {
    const { sent, nextCursor } = await api.getSent(append ? sentCursor : undefined);
    sentCursor = nextCursor;

    if (!append && sent.length === 0) {
      $sentList.innerHTML = `
        <li class="feed__empty-state">
          <svg class="feed__empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"/>
            <polygon points="22 2 15 22 11 13 2 9 22 2"/>
          </svg>
          <p class="feed__empty-title">Nothing sent yet</p>
          <p class="feed__empty-text">Links you share will appear here</p>
        </li>`;
    } else {
      sent.forEach((item) => renderSentItem(item));
    }

    $sentLoadMore.hidden = !nextCursor;
  } catch (err) {
    if (!append) {
      $sentList.innerHTML = `
        <li class="feed__error-state">
          <svg class="feed__error-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <p class="feed__error-text">Could not load sent items</p>
          <button class="btn btn--ghost" id="sent-retry">Try again</button>
        </li>`;
      document.getElementById('sent-retry')?.addEventListener('click', () => loadSent());
    }
    showError(err.message);
  } finally {
    $sentLoading.hidden = true;
    isSentLoadingMore = false;
    $sentLoadMore.disabled = false;
    $sentLoadMore.textContent = 'Load more';
  }
}

function recipientStatusHtml(r) {
  if (r.seen) {
    return `<span class="preview-card__status preview-card__status--seen">${DOUBLE_TICK_SVG}</span>`;
  }
  if (r.delivered) {
    return `<span class="preview-card__status preview-card__status--delivered">${DOUBLE_TICK_SVG}</span>`;
  }
  return `<span class="preview-card__status preview-card__status--pending">Sent</span>`;
}

function renderSentItem(item) {
  const preview = buildLinkPreview(item.url);
  sentItemsMap.set(item.id, { item, preview });

  const li = document.createElement('li');
  li.className = 'preview-card';
  li.dataset.shareId = item.id;

  const time = timeAgo(item.sharedAt);
  const toNames = item.recipients.map(r => escapeHtml(r.username)).join(', ');

  // Overall status: worst status among recipients
  const allSeen = item.recipients.every(r => r.seen);
  const allDelivered = item.recipients.every(r => r.delivered);
  let overallStatus;
  if (allSeen) {
    overallStatus = `<span class="preview-card__status preview-card__status--seen">${DOUBLE_TICK_SVG}</span>`;
  } else if (allDelivered) {
    overallStatus = `<span class="preview-card__status preview-card__status--delivered">${DOUBLE_TICK_SVG}</span>`;
  } else {
    overallStatus = `<span class="preview-card__status preview-card__status--pending">Sent</span>`;
  }

  li.innerHTML = `
    <div class="preview-card__header">
      ${buildPlatformBadge(preview)}
      <span class="preview-card__sender">to ${toNames}</span>
    </div>
    ${item.note ? `<p class="preview-card__note">${escapeHtml(item.note)}</p>` : ''}
    <div class="preview-card__footer">
      <span class="preview-card__time">${time}</span>
      ${overallStatus}
    </div>
  `;

  $sentList.appendChild(li);
}

// Sent card click → detail
$sentList.addEventListener('click', (e) => {
  const card = e.target.closest('.preview-card');
  if (!card) return;
  const shareId = card.dataset.shareId;
  if (shareId) openSentDetail(shareId);
});

function openSentDetail(shareId) {
  const entry = sentItemsMap.get(shareId);
  if (!entry) return;
  const { item, preview } = entry;
  const displayTitle = item.ogTitle || item.title;
  const displayUrl = truncateUrl(item.url, 55);
  const time = timeAgo(item.sharedAt);

  const recipientRows = item.recipients.map(r => `
    <div class="detail__recipient">
      <span class="detail__recipient-name">${escapeHtml(r.username)}</span>
      ${recipientStatusHtml(r)}
    </div>
  `).join('');

  $sentDetailContent.innerHTML = `
    <div class="detail__card">
      <div class="preview-card__header">
        ${buildPlatformBadge(preview)}
        <span class="preview-card__time">${time}</span>
      </div>
      ${item.note ? `<p class="detail__note">${escapeHtml(item.note)}</p>` : ''}
      ${displayTitle ? `<h2 class="detail__title">${escapeHtml(displayTitle)}</h2>` : ''}
      ${item.ogDescription ? `<p class="detail__desc">${escapeHtml(item.ogDescription)}</p>` : ''}
      <a class="detail__url" href="${escapeAttr(item.url)}" target="_blank" rel="noopener">

        <span>${escapeHtml(displayUrl)}</span>
      </a>
      <div class="detail__recipients">
        <h3 class="detail__recipients-title">Recipients</h3>
        ${recipientRows}
      </div>
    </div>
  `;

  $viewSent.hidden = true;
  $viewSentDetail.hidden = false;
}

$sentDetailBack.addEventListener('click', () => {
  $viewSentDetail.hidden = true;
  $viewSent.hidden = false;
});

$sentLoadMore.addEventListener('click', () => {
  if (isSentLoadingMore) return;
  isSentLoadingMore = true;
  $sentLoadMore.disabled = true;
  $sentLoadMore.textContent = 'Loading...';
  loadSent(true);
});

// --- Polling ---

function startPolling() {
  stopPolling();
  feedPollingId = setInterval(() => {
    if (currentView === 'inbox') loadFeed();
    refreshUnreadCount();
    refreshPendingCount();
  }, 30_000);
}

function stopPolling() {
  if (feedPollingId) {
    clearInterval(feedPollingId);
    feedPollingId = null;
  }
}

// ============================================================
//  FRIENDS VIEW
// ============================================================

let cachedFriendRows = []; // Store rendered rows for search filtering

async function loadFriends() {
  $friendsLoading.hidden = false;
  $friendsList.innerHTML = '';
  $pendingList.innerHTML = '';
  $outgoingList.innerHTML = '';
  $friendsSearch.value = '';
  cachedFriendRows = [];

  try {
    const { friends, pendingIncoming, pendingOutgoing } = await api.getFriends();
    hideError();

    // Update pending badge
    pendingRequestCount = pendingIncoming.length;
    renderPendingBadge();

    // --- Pending incoming ---
    if (pendingIncoming.length > 0) {
      $pendingSection.hidden = false;
      $pendingCount.textContent = pendingIncoming.length;
      pendingIncoming.forEach((req) => {
        const li = document.createElement('li');
        li.className = 'friend-row';
        li.innerHTML = `
          <div class="friend-row__info">
            <span class="friend-row__avatar">${req.user.username[0].toUpperCase()}</span>
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

    // --- Pending outgoing ---
    if (pendingOutgoing.length > 0) {
      $outgoingSection.hidden = false;
      pendingOutgoing.forEach((req) => {
        const li = document.createElement('li');
        li.className = 'friend-row';
        li.innerHTML = `
          <div class="friend-row__info">
            <span class="friend-row__avatar">${req.user.username[0].toUpperCase()}</span>
            <span class="friend-row__name">${escapeHtml(req.user.username)}</span>
          </div>
          <span class="friend-row__status">Pending</span>
        `;
        $outgoingList.appendChild(li);
      });
    } else {
      $outgoingSection.hidden = true;
    }

    // --- Accepted friends ---
    $friendsCount.textContent = friends.length || '';

    // Show search input when there are 5+ friends
    $friendsSearch.hidden = friends.length < 5;

    if (friends.length === 0) {
      $friendsList.innerHTML = `
        <li class="feed__empty-state">
          <svg class="feed__empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>
          </svg>
          <p class="feed__empty-title">No friends yet</p>
          <p class="feed__empty-text">Add a friend above to start sharing</p>
        </li>`;
    } else {
      friends.forEach((f) => {
        const li = document.createElement('li');
        li.className = 'friend-row';
        li.dataset.username = f.user.username.toLowerCase();
        li.innerHTML = `
          <div class="friend-row__info">
            <span class="friend-row__avatar">${f.user.username[0].toUpperCase()}</span>
            <div>
              <span class="friend-row__name">${escapeHtml(f.user.username)}</span>
              <span class="friend-row__since">Friends since ${new Date(f.since).toLocaleDateString()}</span>
            </div>
          </div>
        `;
        $friendsList.appendChild(li);
        cachedFriendRows.push(li);
      });
    }
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

// --- Friends search filter ---

$friendsSearch.addEventListener('input', () => {
  const query = $friendsSearch.value.trim().toLowerCase();
  for (const row of cachedFriendRows) {
    const username = row.dataset.username || '';
    row.hidden = query && !username.includes(query);
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

// --- User search (autocomplete while typing username) ---

let searchTimeout = null;

$inviteUsername.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  const q = $inviteUsername.value.trim();
  if (q.length < 2) {
    $inviteSearchResults.hidden = true;
    return;
  }
  searchTimeout = setTimeout(async () => {
    try {
      const { users } = await api.searchUsers(q);
      if ($inviteUsername.value.trim().length < 2) return; // input cleared while waiting
      $inviteSearchResults.innerHTML = '';
      if (users.length === 0) {
        $inviteSearchResults.innerHTML = '<li class="invite-search-empty">No users found</li>';
      } else {
        for (const u of users) {
          const li = document.createElement('li');
          let statusHtml = '';
          if (u.status === 'accepted') {
            statusHtml = '<span class="search-status search-status--accepted">Friends</span>';
          } else if (u.status === 'pending') {
            statusHtml = '<span class="search-status search-status--pending">Pending</span>';
          }
          li.innerHTML = `<span class="search-username">${u.username}</span>${statusHtml}`;
          li.addEventListener('click', () => {
            $inviteUsername.value = u.username;
            $inviteSearchResults.hidden = true;
          });
          $inviteSearchResults.appendChild(li);
        }
      }
      $inviteSearchResults.hidden = false;
    } catch {
      $inviteSearchResults.hidden = true;
    }
  }, 300);
});

// Close search dropdown when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.invite-input-wrap')) {
    $inviteSearchResults.hidden = true;
  }
});

// --- Invite friend ---

$inviteForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $inviteUsername.value.trim();
  if (!username) return;

  $inviteBtn.disabled = true;
  $inviteStatus.hidden = true;

  try {
    await api.inviteFriend(username);
    $inviteStatus.textContent = `Request sent to ${username}`;
    $inviteStatus.className = 'invite-status invite-status--success';
    $inviteStatus.hidden = false;
    $inviteUsername.value = '';
    $inviteSearchResults.hidden = true;
    loadFriends(); // Refresh to show in outgoing
  } catch (err) {
    $inviteStatus.textContent = err.message;
    $inviteStatus.className = 'invite-status invite-status--error';
    $inviteStatus.hidden = false;
  } finally {
    $inviteBtn.disabled = false;
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

async function openPicker(url) {
  pendingLink = buildLinkPreview(url);
  selectedFriends.clear();
  $pickerNote.value = '';
  $pickerSend.disabled = true;

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
    const { friends } = await api.getFriends();
    if (friends.length === 0) {
      $pickerFriends.innerHTML = '<p class="picker__empty">No friends yet. Add friends first!</p>';
      return;
    }

    $pickerFriends.innerHTML = '';
    friends.forEach((f) => {
      const item = document.createElement('label');
      item.className = 'picker__friend';
      item.innerHTML = `
        <input type="checkbox" class="picker__checkbox" value="${escapeAttr(f.user.id)}">
        <span class="picker__avatar">${f.user.username[0].toUpperCase()}</span>
        <span class="picker__name">${escapeHtml(f.user.username)}</span>
      `;
      $pickerFriends.appendChild(item);
    });
  } catch (err) {
    $pickerFriends.innerHTML = `<p class="picker__empty">${escapeHtml(err.message)}</p>`;
  }
}

function closePicker() {
  $picker.hidden = true;
  pendingLink = null;
  selectedFriends.clear();
}

$pickerClose.addEventListener('click', closePicker);
$picker.addEventListener('click', (e) => { if (e.target === $picker) closePicker(); });

$pickerFriends.addEventListener('change', (e) => {
  const cb = e.target.closest('.picker__checkbox');
  if (!cb) return;
  if (cb.checked) selectedFriends.add(cb.value);
  else selectedFriends.delete(cb.value);
  $pickerSend.disabled = selectedFriends.size === 0;
});

$pickerSend.addEventListener('click', async () => {
  if (!pendingLink || selectedFriends.size === 0) return;

  $pickerSend.disabled = true;
  $pickerSend.textContent = 'Sending...';

  try {
    const platform = pendingLink.platform;
    await api.share(
      pendingLink.url,
      [...selectedFriends],
      {
        title: pendingLink.sublabel || undefined,
        note: $pickerNote.value.trim() || undefined,
        platform: platform?.id || undefined,
      }
    );

    closePicker();
    showToast('Shared!', 'success');
    if (currentView === 'inbox') loadFeed();
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
//  BOOT
// ============================================================

init();
