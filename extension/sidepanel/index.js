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



import { api, getAuth, setAuth, clearAuth, refreshSession } from '../shared/api.js';
import { isValidUrl, buildLinkPreview } from './lib/link-utils.js';
import { AVATAR_PRESETS, avatarHtml } from './lib/avatars.js';
import {
  subscribeToConversation,
  unsubscribeFromConversation,
  sendTypingIndicator,
} from '../shared/realtime.js';

// --- State ---

let currentUser = null;
let conversationsCache = [];
let conversationsPollingId = null;
let currentThread = null;
let currentThreadItems = []; // last-rendered feed items (shares + messages) for optimistic inserts
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

const $conversationsLoading = document.getElementById('conversations-loading');
const $conversationsList  = document.getElementById('conversations-list');
const $conversationsSearch = document.getElementById('conversations-search');
const $conversationsSearchClear = document.getElementById('conversations-search-clear');
const $markAllReadBtn = document.getElementById('mark-all-read-btn');
const $inboxContextMenu = document.getElementById('inbox-context-menu');

// --- DOM: Thread ---

const $threadBack       = document.getElementById('thread-back');
const $threadHeader     = document.getElementById('thread-header-info');
const $threadMessages   = document.getElementById('thread-messages');
const $typingIndicator  = document.getElementById('typing-indicator');

// --- DOM: Thread composer (message input) ---

const $composer         = document.getElementById('thread-composer');
const $composerInput    = document.getElementById('composer-input');
const $composerSend     = document.getElementById('composer-send');
const $composerAttach   = document.getElementById('composer-attach');
const $composerFile     = document.getElementById('composer-file');
const $composerAttachment = document.getElementById('composer-attachment');

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
const $startConvFooter    = document.getElementById('start-conv-footer');
const $startConvMessage   = document.getElementById('start-conv-message');
const $startConvGroupName = document.getElementById('start-conv-group-name');
const $startConvSeparate  = document.getElementById('start-conv-separate');
const $startConvGo        = document.getElementById('start-conv-go');

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
  chrome.runtime.sendMessage({ type: 'SIDEPANEL_OPENED' }).catch(() => {});
  initThemeToggle();
  let { token, refreshToken, expiresAt, user } = await getAuth();

  // If the token is expired or close to expiring, try refreshing now
  // so we don't show the app then immediately redirect to login.
  if (token && refreshToken && expiresAt && expiresAt - Date.now() < 120_000) {
    try {
      const refreshed = await refreshSession();
      token = refreshed.accessToken;
      user = refreshed.user;
    } catch (err) {
      // Only clear local state for auth errors (401), not network errors
      if (err.status === 401) {
        token = null;
        user = null;
      }
    }
  }

  const { openedFromBubble } = await chrome.storage.local.get('openedFromBubble');
  const loaderDuration = openedFromBubble ? 3000 : 5000;
  if (openedFromBubble) chrome.storage.local.remove('openedFromBubble');

  await showLoader(loaderDuration);
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
  renderSettingsUsername();
  $settingsEmail.textContent = currentUser.email;
  loadCreatorIds();
  renderSettingsAvatar();
  switchView('inbox');
  startPolling();
  refreshPendingCount();
}

// ---- Creator badge ---------------------------------------------------------
// Ids of "Creator" accounts (profiles.is_creator). Loaded once on app open;
// used to badge those users wherever their name appears.
let creatorIds = new Set();

function loadCreatorIds() {
  api.getCreatorIds()
    .then(({ ids }) => {
      creatorIds = new Set(ids);
      // Re-render anything already on screen so badges appear without a reload.
      if (currentView === 'inbox' && !currentThread) renderConversationsList();
      renderSettingsUsername();
    })
    .catch(() => {});
}

function renderSettingsUsername() {
  if (currentUser && $settingsUsername) {
    $settingsUsername.innerHTML = escapeHtml(currentUser.username) + creatorBadge(currentUser.id);
  }
}

function isCreator(id) {
  return !!id && creatorIds.has(id);
}

// Small inline verified "bluetick" badge to drop in right after a username.
function creatorBadge(id) {
  return isCreator(id)
    ? ' <span class="creator-badge" title="Creator" aria-label="Verified Creator" role="img">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
      + '</span>'
    : '';
}

async function logout() {
  await clearAuth();
  currentUser = null;
  conversationsCache = [];
  conversationsCursor = null;
  conversationsAtEnd = false;
  conversationsLoading = false;
  currentThread = null;
  unsubscribeFromConversation();
  hideTyping();
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
  pendingGroupInviteCount = 0;
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

// --- Minimize sidepanel to floating bubble ---

const $minimizeBtn = document.getElementById('minimize-btn');
if ($minimizeBtn) {
  $minimizeBtn.addEventListener('click', async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      await chrome.runtime.sendMessage({ type: 'MINIMIZE_SIDEPANEL', tabId: tab?.id });
    } catch {}
    window.close();
  });
}

// --- Clear chat history ---

const $settingsClearHistory = document.getElementById('settings-clear-history');

if ($settingsClearHistory) {
  // Inline confirm replaces native confirm() — that dialog was unreliable in
  // some Chrome side-panel builds (silently no-op'd). The new flow:
  //   Click Clear → button swaps for [Cancel] [Clear inbox]; Cancel is the
  //   default focus + Esc closes; Enter commits. After clear, a toast with
  //   Undo lets the user restore everything (the cursor is reversible).

  const refreshInboxAfterChange = () => {
    conversationsCache = [];
    conversationsCursor = null;
    conversationsAtEnd = false;
    if ($conversationsList) $conversationsList.innerHTML = '';
    if (currentThread) {
      currentThread = null;
      $viewThread.hidden = true;
      $viewInbox.hidden = false;
      resetComposer();
    }
    refreshUnreadCount();
    if (currentView === 'inbox') loadConversations();
  };

  $settingsClearHistory.addEventListener('click', () => {
    const row = $settingsClearHistory.closest('.settings-card__row');
    if (!row) return;
    if (row.querySelector('.settings-clear-row__confirm')) return;

    const confirmEl = document.createElement('div');
    confirmEl.className = 'settings-clear-row__confirm';
    confirmEl.setAttribute('role', 'group');
    confirmEl.setAttribute('aria-label', 'Confirm clear inbox');
    confirmEl.innerHTML = `
      <button type="button" class="btn btn--ghost btn--sm" data-clear-cancel>Cancel</button>
      <button type="button" class="btn btn--sm settings-clear-row__yes" data-clear-yes>Clear inbox</button>
    `;
    $settingsClearHistory.hidden = true;
    row.appendChild(confirmEl);

    const cancelBtn = confirmEl.querySelector('[data-clear-cancel]');
    const yesBtn    = confirmEl.querySelector('[data-clear-yes]');
    // Cancel is the safe default — focus it so Enter doesn't commit and Esc
    // and Space both cancel the destructive action.
    cancelBtn.focus();

    const cleanup = () => {
      confirmEl.remove();
      $settingsClearHistory.hidden = false;
      document.removeEventListener('keydown', onKey);
      $settingsClearHistory.focus();
    };

    const commit = async () => {
      yesBtn.disabled = true;
      cancelBtn.disabled = true;
      yesBtn.textContent = 'Clearing…';
      try {
        await api.clearInbox();
        refreshInboxAfterChange();
        cleanup();
        showToast('Inbox cleared', 'success', {
          label: 'Undo',
          onClick: async () => {
            try {
              await api.undoClearInbox();
              refreshInboxAfterChange();
              showToast('Inbox restored', 'success');
            } catch (err) {
              showToast(err.message || 'Could not restore inbox', 'error');
            }
          },
        });
      } catch (err) {
        showToast(err.message || 'Could not clear inbox', 'error');
        yesBtn.disabled = false;
        cancelBtn.disabled = false;
        yesBtn.textContent = 'Clear inbox';
      }
    };

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(); }
      else if (e.key === 'Enter' && e.target === yesBtn) { e.preventDefault(); commit(); }
    };
    document.addEventListener('keydown', onKey);

    cancelBtn.addEventListener('click', cleanup);
    yesBtn.addEventListener('click', commit);
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
  unsubscribeFromConversation();
  hideTyping();

  for (const [key, el] of Object.entries(views)) {
    el.hidden = key !== name;
  }

  // Retrigger the enter animation so tab switches crossfade/slide in (rather
  // than appearing instantly). Reflow between remove/add restarts it.
  const active = views[name];
  if (active) {
    active.classList.remove('view-content--enter');
    void active.offsetWidth;
    active.classList.add('view-content--enter');
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
// Optional `action` parameter: { label, onClick } adds an inline action
// button (e.g. Undo) and stretches the toast lifetime. Callers that only
// pass a message + type keep the original 2.5s behavior.
function showToast(message, type = 'success', action = null) {
  clearTimeout(toastTimer);
  $toast.innerHTML = '';
  const text = document.createElement('span');
  text.className = 'toast__text';
  text.textContent = message;
  $toast.appendChild(text);

  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast__action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      clearTimeout(toastTimer);
      $toast.classList.remove('toast--visible');
      try { action.onClick(); } catch { /* noop */ }
    });
    $toast.appendChild(btn);
  }

  $toast.className = `toast toast--${type}${action ? ' toast--with-action' : ''} toast--visible`;
  const duration = action ? 6500 : 2500;
  toastTimer = setTimeout(() => $toast.classList.remove('toast--visible'), duration);
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
  if ($markAllReadBtn) $markAllReadBtn.hidden = unreadCount === 0;
}

// ============================================================
//  PENDING FRIEND REQUEST COUNT (nav badge)
// ============================================================

let pendingGroupInviteCount = 0;

async function refreshPendingCount() {
  try {
    const [{ count }, invitationsResult] = await Promise.all([
      api.getPendingCount(),
      api.listMyGroupInvitations().catch(() => ({ invitations: [] })),
    ]);
    pendingRequestCount = count;
    pendingGroupInviteCount = (invitationsResult.invitations || []).length;
    renderPendingBadge();
  } catch {
    // Non-critical
  }
}

function renderPendingBadge() {
  const total = pendingRequestCount + pendingGroupInviteCount;
  if (total > 0) {
    $navPending.textContent = total > 99 ? '99+' : String(total);
    $navPending.hidden = false;
  } else {
    $navPending.hidden = true;
  }
}

// SW pushes this when its poll picks up new group invitations. Refresh the
// Groups view if it's already on screen, and re-pull the badge count.
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'NEW_GROUP_INVITATIONS') {
    refreshPendingCount();
    if (currentView === 'friends') loadGroups();
  }
});

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

    // We're online and have the inbox — mark incoming messages delivered so
    // senders see "Delivered" before the thread is opened. Fire-and-forget.
    if (reset) api.markAllDelivered().catch(() => {});

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
  filtered.forEach((c, i) => $conversationsList.appendChild(renderConversationRow(c, i)));
}

if ($conversationsSearch) {
  $conversationsSearch.addEventListener('input', () => {
    renderConversationsList();
    if ($conversationsSearchClear) $conversationsSearchClear.hidden = !$conversationsSearch.value;
  });
}

if ($conversationsSearchClear) {
  $conversationsSearchClear.addEventListener('click', () => {
    $conversationsSearch.value = '';
    $conversationsSearchClear.hidden = true;
    $conversationsSearch.focus();
    renderConversationsList();
  });
}

if ($markAllReadBtn) {
  $markAllReadBtn.addEventListener('click', async () => {
    $markAllReadBtn.disabled = true;
    try {
      await api.markAllRead();
      // Clear the local cache's unread counts
      for (const c of conversationsCache) c.unreadCount = 0;
      renderConversationsList();
      refreshUnreadCount();
      showToast('All conversations marked as read', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      $markAllReadBtn.disabled = false;
    }
  });
}

// Inbox context menu
let contextMenuTarget = null;

document.addEventListener('click', () => {
  if ($inboxContextMenu) $inboxContextMenu.hidden = true;
  contextMenuTarget = null;
});

$conversationsList.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.conv-row');
  if (!row || !$inboxContextMenu) return;
  e.preventDefault();
  contextMenuTarget = row;
  const conv = conversationsCache.find((c) => {
    const name = c.kind === 'peer' ? c.peer.username : c.group.name;
    return row.querySelector('.conv-row__name')?.textContent?.trim() === name;
  });
  $inboxContextMenu.querySelector('[data-context-mark-read]')?.toggleAttribute('disabled', !conv || conv.unreadCount === 0);
  $inboxContextMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 170)}px`;
  $inboxContextMenu.style.top = `${e.clientY}px`;
  $inboxContextMenu.hidden = false;
});

$inboxContextMenu?.addEventListener('click', async (e) => {
  const markReadBtn = e.target.closest('[data-context-mark-read]');
  if (markReadBtn && contextMenuTarget) {
    const name = contextMenuTarget.querySelector('.conv-row__name')?.textContent?.trim();
    const conv = conversationsCache.find((c) => {
      const n = c.kind === 'peer' ? c.peer.username : c.group.name;
      return n === name;
    });
    if (conv) {
      try {
        const opts = conv.kind === 'peer' ? { peerId: conv.peer.id } : { groupId: conv.group.id };
        await api.markConversationRead(opts);
        await api.markMessagesRead(opts);
        conv.unreadCount = 0;
        renderConversationsList();
        refreshUnreadCount();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }
  }
  $inboxContextMenu.hidden = true;
  contextMenuTarget = null;
});

// Ctrl/Cmd+F focuses the inbox search
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    if (currentView === 'inbox' && $viewThread.hidden && $conversationsSearch) {
      e.preventDefault();
      $conversationsSearch.focus();
    }
  }
  // Escape closes the context menu
  if (e.key === 'Escape' && $inboxContextMenu && !$inboxContextMenu.hidden) {
    $inboxContextMenu.hidden = true;
    contextMenuTarget = null;
  }
});

const SNIPPET_TYPE_LABEL = {
  text:     '',
  image:    '\ud83d\udcf7 Photo',
  document: '\ud83d\udcce Document',
  link:     '\ud83d\udd17 Link',
  share:    '\ud83d\udce4 Shared a link',
};

function renderConversationRow(c, idx = 0) {
  const li = document.createElement('li');
  li.className = 'conv-row' + (c.unreadCount > 0 ? ' conv-row--unread' : '');
  li.style.setProperty('--i', idx);
  const avatar = c.kind === 'peer'
    ? avatarHtml(c.peer.username, c.peer.avatarKey, 'md', c.peer.avatarUrl)
    : groupAvatarHtml(c.group, 'md');
  const name = c.kind === 'peer'
    ? escapeHtml(c.peer.username) + creatorBadge(c.peer.id)
    : escapeHtml(c.group.name);
  const groupTag = c.kind === 'group' ? '<span class="conv-row__tag">Group</span>' : '';
  const youPrefix = c.lastSenderId && currentUser && c.lastSenderId === currentUser.id
    ? '<span class="conv-row__you">You: </span>' : '';
  const typeLabel = SNIPPET_TYPE_LABEL[c.lastMessageType] || '';
  const snippet = typeLabel
    ? `<span class="conv-row__snippet-type">${typeLabel}</span>`
    : escapeHtml(truncate(c.lastSnippet || '', 64));
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
  resetComposer();
  hideTyping();
  renderThreadHeader(conv);
  $threadMessages.innerHTML = '<div class="feed__loading"><div class="spinner"></div><span>Loading...</span></div>';

  subscribeThreadRealtime(conv); // fire-and-forget; safe to await elsewhere
  await loadThread(conv);
}

// Fetch + render the current thread without touching the realtime subscription
// (so a live message can refresh the view without churning the channel).
async function loadThread(conv) {
  const opts = conv.kind === 'peer'
    ? { peerId: conv.peer.id }
    : { groupId: conv.group.id };

  try {
    const { items } = await api.getConversationFeed(opts);
    if (currentThread !== conv) return; // navigated away mid-fetch
    renderThreadMessages(items);
    // Mark both legacy shares and chat messages as read.
    Promise.all([
      api.markConversationRead(opts),
      api.markMessagesRead(opts),
    ]).then(() => refreshUnreadCount()).catch(() => {});
  } catch (err) {
    if (currentThread === conv) {
      $threadMessages.innerHTML = `<p class="replies__error">${escapeHtml(err.message)}</p>`;
    }
  }
}

// ---- Realtime: live messages + typing indicator -------------------------

let typingHideTimer = null;
let typingBroadcastThrottle = 0;
let receiptReloadTimer = null;

async function subscribeThreadRealtime(conv) {
  let conversationId;
  try {
    conversationId = conv.kind === 'group'
      ? conv.group.id
      : await api.getPeerConversationId(conv.peer.id);
  } catch {
    return; // no realtime if we can't resolve the channel id; polling still covers it
  }
  if (currentThread !== conv) return; // navigated away while resolving

  await subscribeToConversation(conversationId, {
    onMessage: (row) => {
      // A new/edited message in the open thread — reload to surface it. Skip
      // our own inserts (loadThread already ran after we sent).
      if (currentThread === conv && row && row.sender_id !== currentUser?.id) {
        loadThread(conv);
      }
    },
    onReceipt: () => {
      // A recipient flipped delivered/read on one of our messages. Debounced
      // reload so a burst of receipts triggers a single refresh.
      if (currentThread !== conv) return;
      clearTimeout(receiptReloadTimer);
      receiptReloadTimer = setTimeout(() => {
        if (currentThread === conv) loadThread(conv);
      }, 500);
    },
    onTyping: (payload) => {
      if (currentThread === conv && payload && payload.userId !== currentUser?.id) {
        showTyping(payload.username);
      }
    },
  });
}

function showTyping(username) {
  if (!$typingIndicator) return;
  $typingIndicator.querySelector('.typing-indicator__text').textContent =
    username ? `${username} is typing…` : 'typing…';
  $typingIndicator.hidden = false;
  clearTimeout(typingHideTimer);
  typingHideTimer = setTimeout(hideTyping, 3000);
}

function hideTyping() {
  clearTimeout(typingHideTimer);
  if ($typingIndicator) $typingIndicator.hidden = true;
}

// Broadcast that we're typing, throttled to at most once per second.
function broadcastTyping() {
  if (!currentThread) return;
  const now = Date.now();
  if (now - typingBroadcastThrottle < 1000) return;
  typingBroadcastThrottle = now;
  sendTypingIndicator(currentUser?.username || null);
}

function renderThreadHeader(conv) {
  if (conv.kind === 'peer') {
    $threadHeader.innerHTML = `
      ${avatarHtml(conv.peer.username, conv.peer.avatarKey, 'md', conv.peer.avatarUrl)}
      <div class="thread-header__text">
        <h2 class="thread-header__title">${escapeHtml(conv.peer.username)}${creatorBadge(conv.peer.id)}</h2>
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

function renderThreadMessages(items) {
  currentThreadItems = items || [];
  if (!items || items.length === 0) {
    $threadMessages.innerHTML = `<div class="thread-empty"><p>No messages yet — say hi or share a link below.</p></div>`;
    return;
  }

  // Unified chronological event stream. A chat message is one event. A legacy
  // link-share is one event, plus one event per text reply attached to it
  // (replies show inline under the share card AND as standalone bubbles).
  const events = [];
  for (const it of items) {
    if (it.kind === 'message') {
      events.push({ type: 'message', at: it.createdAt, message: it });
    } else {
      events.push({ type: 'share', at: it.sharedAt, share: it });
      for (const r of (it.replies || [])) {
        events.push({ type: 'reply', at: r.createdAt, reply: r, parentShare: it });
      }
    }
  }
  events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  $threadMessages.innerHTML = '';
  for (const e of events) {
    if (e.type === 'message')      $threadMessages.appendChild(renderChatMessage(e.message));
    else if (e.type === 'share')   $threadMessages.appendChild(renderThreadMessage(e.share));
    else                           $threadMessages.appendChild(renderThreadReplyMessage(e.reply, e.parentShare));
  }
  // Only smooth-scroll for new items (keep initial loads instant)
  const isNewItem = events.length > 0 && ($threadMessages.children.length === 0 || events.length <= 2);
  if (isNewItem) {
    requestAnimationFrame(() => { $threadMessages.scrollTop = $threadMessages.scrollHeight; });
  } else {
    $threadMessages.scrollTo({ top: $threadMessages.scrollHeight, behavior: 'smooth' });
  }
}

// Render a chat message bubble: text / link / image / document, with edit +
// delete affordances on the user's own messages and delivery/read status.
function renderChatMessage(m) {
  const wrapper = document.createElement('div');
  const mine = m.direction === 'out';
  wrapper.className = `chat-msg chat-msg--${m.direction}`;
  wrapper.dataset.messageId = m.id;
  wrapper.id = `message-${m.id}`;

  const time = timeAgo(m.createdAt);
  const senderAvatar = avatarHtml(m.sender.username, m.sender.avatarKey, 'sm', m.sender.avatarUrl);

  let bodyHtml;
  // Detect reply quote prefix: "> @username: text\n\nactual message"
  let replyQuoteHtml = '';
  let cleanContent = m.content || '';
  const replyMatch = cleanContent.match(/^>\s*@([^:]+):\s*(.+?)\n{2,}/s);
  if (replyMatch) {
    replyQuoteHtml = `<span class="reply-quote">↪ @${escapeHtml(replyMatch[1])}: ${linkifyText(replyMatch[2])}</span>`;
    cleanContent = cleanContent.slice(replyMatch[0].length);
  }
  if (m.deleted) {
    bodyHtml = `<p class="chat-msg__deleted">message deleted</p>`;
  } else if (m.messageType === 'image') {
    bodyHtml = `
      <img class="chat-msg__image" src="${escapeAttr(m.url)}" alt="${escapeAttr(m.fileName || 'image')}" data-lightbox="${escapeAttr(m.url)}" loading="lazy">
      ${cleanContent ? `<p class="chat-msg__text">${replyQuoteHtml}${linkifyText(cleanContent)}</p>` : replyQuoteHtml}
    `;
  } else if (m.messageType === 'document') {
    bodyHtml = `
      <a class="chat-msg__doc" href="${escapeAttr(m.url)}" target="_blank" rel="noopener" download>
        <svg class="chat-msg__doc-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span class="chat-msg__doc-meta">
          <span class="chat-msg__doc-name">${escapeHtml(m.fileName || 'Document')}</span>
          ${m.fileSize ? `<span class="chat-msg__doc-size">${formatFileSize(m.fileSize)}</span>` : ''}
        </span>
      </a>
      ${cleanContent ? `<p class="chat-msg__text">${replyQuoteHtml}${linkifyText(cleanContent)}</p>` : replyQuoteHtml}
    `;
  } else if (m.messageType === 'link') {
    const preview = buildLinkPreview(m.url);
    const title = m.ogTitle || m.title || truncateUrl(m.url, 50);
    bodyHtml = `
      ${cleanContent ? `<p class="chat-msg__text">${replyQuoteHtml}${linkifyText(cleanContent)}</p>` : replyQuoteHtml}
      <a class="chat-msg__link-card" href="${escapeAttr(m.url)}" target="_blank" rel="noopener">
        ${m.ogImage ? `<img class="chat-msg__link-img" src="${escapeAttr(m.ogImage)}" alt="" loading="lazy">` : ''}
        <span class="chat-msg__link-body">
          ${buildPlatformBadge(preview)}
          <span class="chat-msg__link-title">${escapeHtml(title)}</span>
          ${m.ogDescription ? `<span class="chat-msg__link-desc">${escapeHtml(m.ogDescription)}</span>` : ''}
          <span class="chat-msg__link-url">${escapeHtml(truncateUrl(m.url, 44))}</span>
        </span>
      </a>
    `;
  } else {
    bodyHtml = `<p class="chat-msg__text">${replyQuoteHtml}${linkifyText(cleanContent)}</p>`;
  }

  const editable = mine && !m.deleted &&
    (Date.now() - new Date(m.createdAt).getTime() < 24 * 3600 * 1000);
  const menuHtml = !m.deleted ? `
    <div class="chat-msg__menu">
      <button class="chat-msg__menu-btn" data-menu-toggle="${escapeAttr(m.id)}" title="More" aria-label="More actions">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
      </button>
      <div class="chat-msg__menu-dropdown" data-menu="${escapeAttr(m.id)}">
        <button class="chat-msg__menu-item" data-reply-message="${escapeAttr(m.id)}" data-reply-author="${escapeAttr(m.sender.username)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
          Reply
        </button>
        <button class="chat-msg__menu-item" data-save-message="${escapeAttr(m.id)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>
          Save
        </button>
        ${editable && m.messageType === 'text' ? `<button class="chat-msg__menu-item" data-edit-message="${escapeAttr(m.id)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>
          Edit
        </button>` : ''}
        ${mine ? `<button class="chat-msg__menu-item chat-msg__menu-item--danger" data-delete-message="${escapeAttr(m.id)}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
          Delete
        </button>` : ''}
      </div>
    </div>` : '';

  const statusHtml = (mine && !m.deleted) ? `<span class="chat-msg__status">${receiptLabel(m)}</span>` : '';
  const editedHtml = m.edited && !m.deleted ? ` <span class="chat-msg__edited">(edited)</span>` : '';

  wrapper.innerHTML = `
    <div class="chat-msg__row">
      ${mine ? '' : senderAvatar}
      <div class="chat-msg__bubble">
        ${mine ? '' : `<span class="chat-msg__sender">${escapeHtml(m.sender.username)}${creatorBadge(m.sender.id)}</span>`}
        ${bodyHtml}
        <span class="chat-msg__meta">
          ${statusHtml}
          <span class="chat-msg__time">${time}${editedHtml}</span>
        </span>
      </div>
      ${menuHtml}
    </div>
  `;
  return wrapper;
}

// "Sent" / "Delivered" / "Read" for peer; "Seen by N" for groups.
function receiptLabel(m) {
  if (!m.recipientCount) return 'Sent';
  if (m.recipientCount === 1) {
    if (m.readCount > 0)      return 'Read';
    if (m.deliveredCount > 0) return 'Delivered';
    return 'Sent';
  }
  if (m.readCount > 0) return `Seen by ${m.readCount}`;
  return 'Sent';
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Turn bare URLs in plain text into clickable links (escaping the rest).
function linkifyText(text) {
  const parts = String(text).split(/(https?:\/\/[^\s]+)/g);
  return parts.map((p) =>
    /^https?:\/\//.test(p)
      ? `<a href="${escapeAttr(p)}" target="_blank" rel="noopener">${escapeHtml(truncateUrl(p, 50))}</a>`
      : escapeHtml(p)
  ).join('');
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
          <span class="thread-msg__sender">${escapeHtml(m.sender.username)}${creatorBadge(m.sender.id)}</span>
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
  // When this reply quotes another reply, surface a tiny ↪ above it so the
  // chain is visible even in the compact inline list under the share card.
  const quotedLine = r.parentReplyId && r.parentAuthor
    ? `<span class="thread-msg__inline-reply-quote" data-jump-reply="${escapeAttr(r.parentReplyId)}">↪ ${escapeHtml(r.parentAuthor)}</span>`
    : '';
  return `
    <div class="thread-msg__inline-reply${isMine ? ' thread-msg__inline-reply--mine' : ''}" data-reply-id="${escapeAttr(r.id)}">
      ${quotedLine}
      <span class="thread-msg__inline-reply-author">${escapeHtml(r.author)}${creatorBadge(r.authorId)}</span>
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
  wrapper.id = `reply-${r.id}`;
  const authorAvatar = avatarHtml(r.author, r.avatarKey, 'sm', r.avatarUrl);
  const time = timeAgo(r.createdAt);
  const parentTitle = parentShare
    ? (parentShare.ogTitle || parentShare.title || truncateUrl(parentShare.url, 40))
    : null;

  // If this reply quotes another reply, render the quote pill INSTEAD of the
  // share-link ref — the quote is more specific context and saves a row.
  // Clicking it scrolls to and flashes the parent reply bubble.
  const refHtml = (r.parentReplyId && r.parentAuthor)
    ? `<a class="thread-reply-msg__ref thread-reply-msg__ref--reply" href="#reply-${escapeAttr(r.parentReplyId)}" data-jump-reply="${escapeAttr(r.parentReplyId)}" title="${escapeAttr(r.parentExcerpt || '')}">↪ ${escapeHtml(r.parentAuthor)}: ${escapeHtml(r.parentExcerpt || '')}</a>`
    : (parentTitle
        ? `<a class="thread-reply-msg__ref" href="#share-${escapeAttr(parentShare.id)}" data-jump-share="${escapeAttr(parentShare.id)}">↪ ${escapeHtml(parentTitle)}</a>`
        : '');

  // Reply-on-reply: small "Reply" button on the bubble. Available to every
  // viewer (not just the author). Toggling reveals an inline text-only
  // composer below — links/shares belong on the + composer at the top of
  // the thread, replies-to-replies stay conversational.
  const replyBtnHtml = parentShare
    ? `<button class="thread-reply-msg__reply-btn" data-reply-to-reply="${escapeAttr(r.id)}" title="Reply to ${escapeAttr(r.author)}">
         <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
       </button>`
    : '';

  // Composer is hidden by default; the reply button reveals it. Lives
  // outside the bubble so it can span the bubble's width without picking
  // up the bubble's max-width / accent tint. Submit posts to the same
  // parent share with parent_reply_id set to this reply's id.
  const composerHtml = parentShare
    ? `<form class="thread-reply-msg__reply-form" data-share-id="${escapeAttr(parentShare.id)}" data-parent-reply-id="${escapeAttr(r.id)}" hidden>
         <div class="thread-reply-msg__reply-quote">Replying to <strong>${escapeHtml(r.author)}</strong></div>
         <div class="thread-reply-msg__reply-row">
           <input class="input thread-reply-msg__reply-body" type="text" placeholder="Reply to ${escapeAttr(r.author)}..." maxlength="1000" autocomplete="off" aria-label="Reply to ${escapeAttr(r.author)}">
           <button type="button" class="thread-reply-msg__reply-cancel" data-reply-cancel title="Cancel" aria-label="Cancel reply">&times;</button>
           <button type="submit" class="btn btn--primary btn--sm thread-reply-msg__reply-send" hidden>Send</button>
         </div>
         <p class="thread-reply-msg__reply-error" role="alert" hidden></p>
       </form>`
    : '';

  wrapper.innerHTML = `
    <div class="thread-reply-msg__row">
      ${authorAvatar}
      <div class="thread-reply-msg__bubble">
        <div class="thread-reply-msg__head">
          <span class="thread-reply-msg__author">${escapeHtml(r.author)}${creatorBadge(r.authorId)}</span>
          <span class="thread-reply-msg__time">${time}</span>
        </div>
        ${refHtml}
        <p class="thread-reply-msg__body">${escapeHtml(r.body)}</p>
        <div class="thread-reply-msg__actions">
          ${replyBtnHtml}
          ${isMine ? `<button class="thread-reply-msg__delete" data-reply-delete="${escapeAttr(r.id)}" title="Delete">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>` : ''}
        </div>
      </div>
    </div>
    ${composerHtml}
  `;
  return wrapper;
}

// Insert a freshly posted reply into the DOM without reloading the thread
// (keeps scroll position; no jarring full re-render). Appends the standalone
// bubble at the end of the flow and echoes it inline under the parent share.
function insertReplyOptimistically(reply, shareId) {
  if (currentUser) {
    reply.author    = reply.author   || currentUser.username;
    reply.authorId  = reply.authorId || currentUser.id;
    reply.avatarKey = currentUser.avatarKey;
    reply.avatarUrl = currentUser.avatarUrl;
  }
  const parentShare = currentThreadItems.find((it) => it.kind === 'share' && it.id === shareId);
  if (parentShare) {
    parentShare.replies = parentShare.replies || [];
    parentShare.replies.push(reply);
  }

  const bubble = renderThreadReplyMessage(reply, parentShare || { id: shareId });
  bubble.classList.add('thread-reply-msg--entering');
  $threadMessages.appendChild(bubble);

  const inlineHost = $threadMessages.querySelector(`.thread-msg__inline-replies[data-share-id="${shareId}"]`);
  if (inlineHost) inlineHost.insertAdjacentHTML('beforeend', renderInlineReply(reply));

  requestAnimationFrame(() => {
    bubble.classList.remove('thread-reply-msg--entering');
    bubble.scrollIntoView({ behavior: 'smooth', block: 'center' });
    bubble.classList.add('thread-reply-msg--flash');
    setTimeout(() => bubble.classList.remove('thread-reply-msg--flash'), 1500);
  });
}

function openReplyForm(form) {
  form.hidden = false;
  const input = form.querySelector('.thread-reply-msg__reply-body');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (input) {
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => input.focus({ preventScroll: true }), 60);
    }
  }));
}

// Animated collapse, then reset the composer. Optionally restore focus to the
// control that opened it (keyboard users land back where they were).
function closeReplyForm(form, restoreFocusEl) {
  if (!form || form.hidden) {
    if (restoreFocusEl) restoreFocusEl.focus();
    return;
  }
  form.classList.add('thread-reply-msg__reply-form--closing');
  setTimeout(() => {
    form.hidden = true;
    form.classList.remove('thread-reply-msg__reply-form--closing');
    const input = form.querySelector('.thread-reply-msg__reply-body');
    const send  = form.querySelector('.thread-reply-msg__reply-send');
    const err   = form.querySelector('.thread-reply-msg__reply-error');
    if (input) input.value = '';
    if (send)  send.hidden = true;
    if (err) { err.hidden = true; err.textContent = ''; }
  }, 160);
  if (restoreFocusEl) restoreFocusEl.focus();
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
      // Fade + collapse out every copy — the inline note under the parent
      // share AND the standalone bubble in the conversation flow.
      $threadMessages.querySelectorAll(`[data-reply-id="${id}"]`).forEach((el) => {
        el.classList.add('reply-removing');
        setTimeout(() => el.remove(), 240);
      });
      // Keep the in-memory model in sync for later optimistic inserts.
      for (const it of currentThreadItems) {
        if (it.kind === 'share' && Array.isArray(it.replies)) {
          it.replies = it.replies.filter((rp) => rp.id !== id);
        }
      }
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

  // Quote pill on a reply bubble (or its inline echo under the share card)
  // jumps to the parent reply and flashes it. Same animation as share jump.
  const jumpReplyRef = e.target.closest('[data-jump-reply]');
  if (jumpReplyRef) {
    e.preventDefault();
    const target = $threadMessages.querySelector(`.thread-reply-msg[data-reply-id="${jumpReplyRef.dataset.jumpReply}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.add('thread-reply-msg--flash');
      setTimeout(() => target.classList.remove('thread-reply-msg--flash'), 1500);
    }
    return;
  }

  // Cancel button inside the reply-to-reply composer — collapse it back and
  // return focus to the bubble's Reply button.
  const cancelBtn = e.target.closest('[data-reply-cancel]');
  if (cancelBtn) {
    e.preventDefault();
    e.stopPropagation();
    const form = cancelBtn.closest('.thread-reply-msg__reply-form');
    const replyBtn = cancelBtn.closest('.thread-reply-msg')?.querySelector('.thread-reply-msg__reply-btn');
    closeReplyForm(form, replyBtn);
    return;
  }

  // Reply-on-reply: toggle the inline composer below the reply bubble. Only
  // one composer open at a time — opening one closes any other open ones to
  // avoid stacking multiple half-typed drafts.
  const replyOnReplyBtn = e.target.closest('[data-reply-to-reply]');
  if (replyOnReplyBtn) {
    e.preventDefault();
    e.stopPropagation();
    const replyMsg = replyOnReplyBtn.closest('.thread-reply-msg');
    const form = replyMsg && replyMsg.querySelector(':scope > .thread-reply-msg__reply-form');
    if (!form) return;
    const willOpen = form.hidden;
    $threadMessages.querySelectorAll('.thread-reply-msg__reply-form:not([hidden])').forEach((other) => {
      if (other !== form) closeReplyForm(other);
    });
    if (willOpen) {
      openReplyForm(form);
    } else {
      closeReplyForm(form, replyOnReplyBtn);
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
      // Double rAF so the expansion's added height is in the layout before we
      // scroll; block:'nearest' lets the browser pick the closest scrollable
      // ancestor whether body or .thread-messages is the active scroller.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (input) {
          input.scrollIntoView({ block: 'center', behavior: 'smooth' });
          setTimeout(() => input.focus({ preventScroll: true }), 60);
        }
      }));
    }
  }
});

// Progressive reveal inside a reply form. Send shows as soon as there's
// content; the optional note field only shows when the input parses as a
// URL (i.e. the reply is about to become a link-share card).
$threadMessages.addEventListener('input', (e) => {
  const bodyInput = e.target.closest('.thread-msg__reply-body');
  if (bodyInput) {
    const form = bodyInput.closest('.thread-msg__reply-form');
    const noteInput = form.querySelector('.thread-msg__reply-note');
    const sendBtn   = form.querySelector('.thread-msg__reply-btn');
    const text = bodyInput.value.trim();
    sendBtn.hidden = text.length === 0;
    noteInput.hidden = !isValidUrl(text);
    return;
  }

  // Reply-on-reply composer (text-only — no URL→share path here).
  const bubbleInput = e.target.closest('.thread-reply-msg__reply-body');
  if (bubbleInput) {
    const sendBtn = bubbleInput.closest('.thread-reply-msg__reply-form')
                               .querySelector('.thread-reply-msg__reply-send');
    sendBtn.hidden = bubbleInput.value.trim().length === 0;
  }
});

$threadMessages.addEventListener('submit', async (e) => {
  // Reply-on-reply composer (attached to a standalone reply bubble): always
  // text-only, posts a new reply to the parent share with parent_reply_id
  // pointing at the reply we're replying to.
  const replyToReplyForm = e.target.closest('.thread-reply-msg__reply-form');
  if (replyToReplyForm) {
    e.preventDefault();
    if (!currentThread) return;
    const bodyInput = replyToReplyForm.querySelector('.thread-reply-msg__reply-body');
    const sendBtn   = replyToReplyForm.querySelector('.thread-reply-msg__reply-send');
    const errEl     = replyToReplyForm.querySelector('.thread-reply-msg__reply-error');
    const text = bodyInput.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending…';
    if (errEl) errEl.hidden = true;
    try {
      const { reply } = await api.postReply(
        replyToReplyForm.dataset.shareId,
        text,
        replyToReplyForm.dataset.parentReplyId,
      );
      replyToReplyForm.hidden = true;        // close instantly (the new bubble takes focus)
      bodyInput.value = '';
      sendBtn.hidden  = true;
      insertReplyOptimistically(reply, replyToReplyForm.dataset.shareId);
      showToast('Reply posted', 'success');  // role=status → announced to SR
    } catch (err) {
      // Keep the composer open + text intact; show the error inline.
      if (errEl) { errEl.textContent = err.message; errEl.hidden = false; }
      else showToast(err.message, 'error');
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send';
    }
    return;
  }

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
      // Plain text → reply on the parent share. Insert optimistically so the
      // reply appears inline under the card AND as a bubble in the flow,
      // without a jarring full reload that loses scroll position.
      const parentShareId = form.dataset.shareId;
      const { reply } = await api.postReply(parentShareId, text);
      bodyInput.value = '';
      noteInput.value = '';
      noteInput.hidden = true;
      sendBtn.hidden = true;
      insertReplyOptimistically(reply, parentShareId);
      showToast('Reply posted', 'success');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    sendBtn.disabled = false;
  }
});

// Esc closes the reply-on-reply composer (Enter sends via native form submit).
$threadMessages.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const form = e.target.closest('.thread-reply-msg__reply-form');
  if (!form) return;
  e.preventDefault();
  const replyBtn = form.closest('.thread-reply-msg')?.querySelector('.thread-reply-msg__reply-btn');
  closeReplyForm(form, replyBtn);
});

$threadBack.addEventListener('click', () => {
  $viewThread.hidden = true;
  $viewInbox.hidden = false;
  currentThread = null;
  unsubscribeFromConversation();
  hideTyping();
  resetComposer();
  loadConversations();
});

// ============================================================
//  THREAD MESSAGE COMPOSER (text / link / image / document)
// ============================================================
// Always-visible bottom composer. Typing a URL sends a link message; an
// attached file sends an image/document message; otherwise plain text. The
// same input doubles as an inline editor for the user's own text messages.

let composerAttachment = null; // { messageType, filePath, url, fileName, fileSize, mimeType }
let composerEditingId  = null; // message id being edited, or null
let composerReplyTo    = null; // { id, username, content } when replying to a message

function resetComposer() {
  composerAttachment = null;
  composerEditingId  = null;
  composerReplyTo    = null;
  if ($composerInput) {
    $composerInput.value = '';
    $composerInput.style.height = '';
  }
  if ($composerAttachment) {
    $composerAttachment.hidden = true;
    $composerAttachment.innerHTML = '';
  }
  renderComposerReplyIndicator();
  refreshComposerState();
}

function renderComposerReplyIndicator() {
  let el = document.getElementById('composer-reply-indicator');
  if (!composerReplyTo) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'composer-reply-indicator';
    el.className = 'composer__reply-indicator';
    $composer.insertBefore(el, $composer.firstChild);
  }
  const previewText = (composerReplyTo.content || '').slice(0, 80);
  el.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
    <strong>${escapeHtml(composerReplyTo.username)}</strong>
    <span class="composer__reply-indicator-preview">${escapeHtml(previewText)}${composerReplyTo.content && composerReplyTo.content.length > 80 ? '…' : ''}</span>
    <button class="composer__reply-indicator-cancel" data-cancel-reply type="button" title="Cancel reply">&times;</button>
  `;
  el.querySelector('[data-cancel-reply]').addEventListener('click', () => {
    composerReplyTo = null;
    renderComposerReplyIndicator();
    $composerInput.focus();
  });
}

function refreshComposerState() {
  if (!$composerSend) return;
  const hasText = $composerInput.value.trim().length > 0;
  $composerSend.disabled = !hasText && !composerAttachment;
}

function autoGrowComposer() {
  $composerInput.style.height = 'auto';
  $composerInput.style.height = `${Math.min($composerInput.scrollHeight, 120)}px`;
}

function renderComposerAttachment() {
  if (!composerAttachment) {
    $composerAttachment.hidden = true;
    $composerAttachment.innerHTML = '';
    return;
  }
  const a = composerAttachment;
  const thumb = a.messageType === 'image'
    ? `<img class="composer__attachment-thumb" src="${escapeAttr(a.url)}" alt="">`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
  $composerAttachment.hidden = false;
  $composerAttachment.innerHTML = `
    ${thumb}
    <span class="composer__attachment-name">${escapeHtml(a.fileName)}</span>
    <button type="button" class="composer__attachment-remove" title="Remove">&times;</button>
  `;
  $composerAttachment.querySelector('.composer__attachment-remove').addEventListener('click', () => {
    composerAttachment = null;
    renderComposerAttachment();
    refreshComposerState();
  });
}

$composerInput.addEventListener('input', () => {
  autoGrowComposer();
  refreshComposerState();
  broadcastTyping();
});

// Enter sends; Shift+Enter inserts a newline.
$composerInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $composer.requestSubmit();
  }
});

$composerAttach.addEventListener('click', () => $composerFile.click());

$composerFile.addEventListener('change', async () => {
  const file = $composerFile.files && $composerFile.files[0];
  $composerFile.value = '';
  if (!file) return;
  $composerAttachment.hidden = false;
  $composerAttachment.innerHTML = `<span class="composer__attachment-name">Uploading ${escapeHtml(file.name)}…</span>`;
  refreshComposerState();
  try {
    composerAttachment = await api.uploadMessageFile(file);
    renderComposerAttachment();
  } catch (err) {
    composerAttachment = null;
    renderComposerAttachment();
    showToast(err.message, 'error');
  }
  refreshComposerState();
});

$composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentThread) return;
  const text = $composerInput.value.trim();
  const attachment = composerAttachment;
  if (!text && !attachment) return;

  // Editing an existing text message?
  if (composerEditingId) {
    const id = composerEditingId;
    $composerSend.disabled = true;
    try {
      await api.editMessage(id, text);
      resetComposer();
      loadThread(currentThread);
    } catch (err) {
      showToast(err.message, 'error');
      $composerSend.disabled = false;
    }
    return;
  }

  const target = currentThread.kind === 'peer'
    ? { peerId: currentThread.peer.id }
    : { groupId: currentThread.group.id };

  $composerSend.disabled = true;
  $composerSend.classList.add('composer__send--sending');
  try {
    // When replying, prefix content with a quote of the original message
    const replyPrefix = composerReplyTo
      ? `> @${composerReplyTo.username}: ${composerReplyTo.content}\n\n`
      : '';
    const fullText = replyPrefix + text;
    if (attachment) {
      await api.sendMessage({
        ...target,
        content:     fullText || undefined,
        messageType: attachment.messageType,
        url:         attachment.url,
        filePath:    attachment.filePath,
        fileName:    attachment.fileName,
        fileSize:    attachment.fileSize,
        mimeType:    attachment.mimeType,
      });
    } else if (isValidUrl(text)) {
      const preview = buildLinkPreview(text);
      await api.sendMessage({
        ...target,
        content:     replyPrefix || undefined,
        messageType: 'link',
        url:         text,
        platform:    preview.platform?.id || undefined,
        title:       preview.sublabel || undefined,
      });
    } else {
      await api.sendMessage({ ...target, content: fullText, messageType: 'text' });
    }
    $composerSend.classList.remove('composer__send--sending');
    $composerSend.classList.add('composer__send--sent');
    setTimeout(() => $composerSend.classList.remove('composer__send--sent'), 400);
    resetComposer();
    loadThread(currentThread);
  } catch (err) {
    $composerSend.classList.remove('composer__send--sending');
    showToast(err.message, 'error');
    refreshComposerState();
  }
});

// Edit / delete / reply / save a chat message, or open an image lightbox (delegated).
$threadMessages.addEventListener('click', (e) => {
  const menuBtn = e.target.closest('[data-menu-toggle]');
  if (menuBtn) {
    const id = menuBtn.getAttribute('data-menu-toggle');
    const menu = document.querySelector(`[data-menu="${id}"]`);
    if (!menu) return;
    const isOpen = menu.classList.toggle('chat-msg__menu-dropdown--open');
    if (isOpen) {
      // Close other open menus
      document.querySelectorAll('.chat-msg__menu-dropdown--open').forEach((m) => {
        if (m !== menu) m.classList.remove('chat-msg__menu-dropdown--open');
      });
      const closeMenu = (ev) => {
        if (!ev.target.closest('[data-menu-toggle]') && !ev.target.closest('[data-menu]')) {
          menu.classList.remove('chat-msg__menu-dropdown--open');
          document.removeEventListener('click', closeMenu);
        }
      };
      setTimeout(() => document.addEventListener('click', closeMenu), 0);
    }
    return;
  }

  const replyBtn = e.target.closest('[data-reply-message]');
  if (replyBtn) {
    const id = replyBtn.getAttribute('data-reply-message');
    const author = replyBtn.getAttribute('data-reply-author');
    const bubble = document.getElementById(`message-${id}`);
    const textEl = bubble && bubble.querySelector('.chat-msg__text');
    composerReplyTo = { id, username: author, content: textEl ? textEl.textContent : '' };
    resetComposer();
    composerReplyTo = { id, username: author, content: textEl ? textEl.textContent : '' };
    renderComposerReplyIndicator();
    $composerInput.focus();
    // Close open menus
    document.querySelectorAll('.chat-msg__menu-dropdown--open').forEach((m) => m.classList.remove('chat-msg__menu-dropdown--open'));
    return;
  }

  const editBtn = e.target.closest('[data-edit-message]');
  if (editBtn) {
    const id = editBtn.getAttribute('data-edit-message');
    const bubble = document.getElementById(`message-${id}`);
    const textEl = bubble && bubble.querySelector('.chat-msg__text');
    composerEditingId = id;
    $composerInput.value = textEl ? textEl.textContent : '';
    $composerInput.focus();
    autoGrowComposer();
    refreshComposerState();
    // Close open menus
    document.querySelectorAll('.chat-msg__menu-dropdown--open').forEach((m) => m.classList.remove('chat-msg__menu-dropdown--open'));
    return;
  }
  const delBtn = e.target.closest('[data-delete-message]');
  if (delBtn) {
    api.deleteMessage(delBtn.getAttribute('data-delete-message'))
      .then(() => {
        loadThread(currentThread);
        if (currentView === 'inbox') loadConversations();
      })
      .catch((err) => showToast(err.message, 'error'));
    return;
  }
  const saveBtn = e.target.closest('[data-save-message]');
  if (saveBtn) {
    api.saveMessageToArchive(saveBtn.getAttribute('data-save-message'))
      .then(() => showToast('Saved to your archive', 'success'))
      .catch((err) => showToast(err.message, 'error'));
    return;
  }
  const img = e.target.closest('[data-lightbox]');
  if (img) openLightbox(img.getAttribute('data-lightbox'));
});

function openLightbox(src) {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Image preview');
  overlay.innerHTML = `
    <button class="lightbox__close" type="button" aria-label="Close preview">&times;</button>
    <img class="lightbox__img" src="${escapeAttr(src)}" alt="">
  `;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  // Backdrop-click only — clicking the image itself shouldn't dismiss it.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.lightbox__close').addEventListener('click', close);
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  overlay.querySelector('.lightbox__close').focus();
}

// --- Polling ---

function startPolling() {
  stopPolling();
  // Realtime now drives the open conversation; this poll is just a fallback
  // for the inbox list / badge / pending counts, so 60s is plenty.
  conversationsPollingId = setInterval(() => {
    if (currentView === 'inbox' && !currentThread) loadConversations();
    refreshUnreadCount();
    refreshPendingCount();
  }, 60_000);
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
        <span class="friend-row__name">${escapeHtml(f.user.username)}${creatorBadge(f.user.id)}</span>
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
            <span class="friend-row__name">${escapeHtml(req.user.username)}${creatorBadge(req.user.id)}</span>
          </div>
          <div class="friend-row__actions">
            <button class="btn btn--sm btn--ghost" data-decline="${escapeAttr(req.id)}">Decline</button>
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
            <span class="friend-row__name">${escapeHtml(req.user.username)}${creatorBadge(req.user.id)}</span>
          </div>
          <div class="friend-row__actions">
            <span class="friend-row__status">Pending</span>
            <button class="btn btn--sm btn--ghost" data-cancel="${escapeAttr(req.id)}" title="Cancel request">Cancel</button>
          </div>
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
        <span class="search-username">${highlightMatch(u.username, query)}${creatorBadge(u.id)}</span>
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

// --- Accept / decline friend request ---

$pendingList.addEventListener('click', async (e) => {
  const acceptBtn  = e.target.closest('[data-accept]');
  const declineBtn = e.target.closest('[data-decline]');
  const btn = acceptBtn || declineBtn;
  if (!btn) return;

  const friendshipId = btn.dataset.accept || btn.dataset.decline;
  const row = btn.closest('.friend-row');
  if (row) row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  const originalText = btn.textContent;
  btn.textContent = '...';

  try {
    if (acceptBtn) {
      await api.acceptFriend(friendshipId);
      showToast('Friend added!', 'success');
    } else {
      await api.declineFriend(friendshipId);
      showToast('Request declined', 'success');
    }
    loadFriends();
  } catch (err) {
    showToast(err.message, 'error');
    if (row) row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    btn.textContent = originalText;
  }
});

// --- Cancel outgoing friend request ---

if ($outgoingList) {
  $outgoingList.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-cancel]');
    if (!btn) return;
    const friendshipId = btn.dataset.cancel;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = '...';
    try {
      await api.declineFriend(friendshipId);
      showToast('Request cancelled', 'success');
      loadFriends();
    } catch (err) {
      showToast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

// ============================================================
//  EXTERNAL LINK CAPTURE → FRIEND PICKER → SHARE
// ============================================================
// The inbox drop zone is gone; the primary way to share a link is now the
// in-conversation composer. These two entry points remain for links that
// originate *outside* a conversation — pasting a URL into the panel, or the
// content-script "share this page" action — and route to the friend picker.

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
        <span class="picker__name">${escapeHtml(f.user.username)}${creatorBadge(f.user.id)}</span>
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
const startConvSelected = new Set(); // friend ids selected for the new chat/group

async function openStartConvPicker() {
  if (!$startConvPicker) return;
  $startConvPicker.hidden = false;
  $startConvSearch.value = '';
  startConvSelected.clear();
  updateStartConvFooter();
  $startConvFriends.innerHTML =
    '<div class="feed__loading"><div class="spinner"></div><span>Loading friends...</span></div>';

  try {
    const { friends } = await api.getFriends();
    startConvFriendsCache = friends;
    if (friends.length === 0) {
      $startConvFriends.innerHTML = `
        <div class="start-conv__empty">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
          <p class="start-conv__empty-title">No friends yet</p>
          <span class="start-conv__empty-hint">Add friends on the Friends tab to start chatting.</span>
        </div>`;
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
    $startConvFriends.innerHTML = `<p class="picker__empty">No friends match “${escapeHtml(q)}”</p>`;
    return;
  }

  $startConvFriends.innerHTML = '';
  matches.forEach((f) => {
    const selected = startConvSelected.has(f.user.id);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `start-conv__friend${selected ? ' start-conv__friend--selected' : ''}`;
    row.dataset.friendId = f.user.id;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', selected ? 'true' : 'false');
    row.innerHTML = `
      ${avatarHtml(f.user.username, f.user.avatarKey, 'md', f.user.avatarUrl)}
      <span class="picker__name">${escapeHtml(f.user.username)}${creatorBadge(f.user.id)}</span>
      <span class="start-conv__check" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
      </span>
    `;
    row.addEventListener('click', () => toggleStartConvSelection(f.user.id, row));
    $startConvFriends.appendChild(row);
  });
}

function toggleStartConvSelection(id, row) {
  if (startConvSelected.has(id)) startConvSelected.delete(id);
  else startConvSelected.add(id);
  const on = startConvSelected.has(id);
  row.classList.toggle('start-conv__friend--selected', on);
  row.setAttribute('aria-selected', on ? 'true' : 'false');
  updateStartConvFooter();
}

function startConvSelectedUsers() {
  return [...startConvSelected]
    .map((id) => startConvFriendsCache.find((f) => f.user.id === id)?.user)
    .filter(Boolean);
}

// Sensible default name from the picked friends (editable), e.g. "Ana, Bo +2".
function defaultGroupName() {
  const names = startConvSelectedUsers().map((u) => u.username);
  if (names.length === 0) return '';
  const base = names.length <= 3
    ? names.join(', ')
    : `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
  return base.slice(0, 40);
}

function updateStartConvFooter() {
  if (!$startConvFooter) return;
  const n = startConvSelected.size;
  const isGroup = n >= 2;
  $startConvFooter.hidden = n === 0;
  $startConvMessage.hidden = n === 0;
  $startConvGroupName.hidden = !isGroup;
  $startConvSeparate.hidden = !isGroup;

  $startConvGo.disabled = n === 0;
  $startConvGo.textContent = isGroup ? `Create group · ${n}` : 'Start chat';

  // "Send separately" broadcasts the typed message to each friend as a 1:1, so
  // it needs a message.
  const hasMsg = $startConvMessage.value.trim().length > 0;
  $startConvSeparate.disabled = !hasMsg;
  $startConvSeparate.textContent = `Send separately · ${n}`;

  if (isGroup) {
    if (!$startConvGroupName.value.trim()) $startConvGroupName.value = defaultGroupName();
  } else {
    $startConvGroupName.value = '';
  }
}

function closeStartConvPicker() {
  if (!$startConvPicker) return;
  $startConvPicker.hidden = true;
  startConvFriendsCache = [];
  startConvSelected.clear();
  if ($startConvMessage)   $startConvMessage.value = '';
  if ($startConvGroupName) $startConvGroupName.value = '';
  if ($startConvSeparate)  $startConvSeparate.hidden = true;
  if ($startConvFooter)    $startConvFooter.hidden = true;
}

function startConversationWith(user) {
  closeStartConvPicker();
  openConversation({
    kind:            'peer',
    peer:            { id: user.id, username: user.username, avatarKey: user.avatarKey, avatarUrl: user.avatarUrl },
    group:           null,
    lastShareId:     null,
    lastSnippet:     '',
    lastMessageType: null,
    lastSenderId:    null,
    lastAt:          null,
    unreadCount:     0,
  });
}

// A typed URL becomes a link message; anything else is plain text — mirrors the
// in-thread composer.
function startConvMessagePayload(text) {
  if (isValidUrl(text)) {
    const preview = buildLinkPreview(text);
    return { messageType: 'link', url: text, platform: preview.platform?.id || undefined, title: preview.sublabel || undefined };
  }
  return { content: text, messageType: 'text' };
}

// Primary action. One friend → open the 1:1 (sending an optional first
// message). Two or more → create a group, invite them, optionally post the
// message into it, then open the group thread.
async function commitStartConv() {
  const users = startConvSelectedUsers();
  if (users.length === 0) return;
  const msg = $startConvMessage.value.trim();

  if (users.length === 1) {
    const peer = users[0];
    $startConvGo.disabled = true;
    try {
      if (msg) await api.sendMessage({ peerId: peer.id, ...startConvMessagePayload(msg) });
      startConversationWith(peer);
    } catch (err) {
      showToast(err.message, 'error');
      $startConvGo.disabled = false;
    }
    return;
  }

  const name = ($startConvGroupName.value.trim() || defaultGroupName() || 'New group').slice(0, 40);
  const prevText = $startConvGo.textContent;
  $startConvGo.disabled = true;
  $startConvGo.textContent = 'Creating…';
  try {
    const { group } = await api.createGroup(name);
    await api.inviteToGroup(group.id, users.map((u) => u.id));
    if (msg) await api.sendMessage({ groupId: group.id, ...startConvMessagePayload(msg) });
    closeStartConvPicker();
    openConversation({
      kind:         'group',
      peer:         null,
      group:        { id: group.id, name: group.name || name, color: group.color || '#6366f1', avatarKey: null, avatarUrl: null },
      lastShareId:  null,
      lastSnippet:  '',
      lastSenderId: null,
      lastAt:       null,
      unreadCount:  0,
    });
    showToast(`Group “${name}” created — invites sent`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
    $startConvGo.disabled = false;
    $startConvGo.textContent = prevText;
  }
}

// Deliver the typed message to each selected friend as its own 1:1 — no group.
// Lands back on the inbox where the new conversations surface.
async function sendSeparately() {
  const users = startConvSelectedUsers();
  const msg = $startConvMessage.value.trim();
  if (users.length < 2 || !msg) return;
  const payload = startConvMessagePayload(msg);
  const prev = $startConvSeparate.textContent;
  $startConvSeparate.disabled = true;
  $startConvGo.disabled = true;
  $startConvSeparate.textContent = 'Sending…';
  try {
    await Promise.all(users.map((u) => api.sendMessage({ peerId: u.id, ...payload })));
    closeStartConvPicker();
    showToast(`Sent to ${users.length} friends`, 'success');
    if (currentView === 'inbox') loadConversations();
    refreshUnreadCount();
  } catch (err) {
    showToast(err.message, 'error');
    $startConvSeparate.disabled = false;
    $startConvSeparate.textContent = prev;
    $startConvGo.disabled = false;
  }
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
if ($startConvMessage)  $startConvMessage.addEventListener('input', updateStartConvFooter);
if ($startConvSeparate) $startConvSeparate.addEventListener('click', sendSeparately);
if ($startConvGo)       $startConvGo.addEventListener('click', commitStartConv);

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
  if (!url) return '';
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
const $groupInvitationsSection = document.getElementById('group-invitations-section');
const $groupInvitationsList    = document.getElementById('group-invitations-list');
const $groupInvitationsCount   = document.getElementById('group-invitations-count');
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
const $groupEditorPreviewAvatar = document.getElementById('group-editor-preview-avatar');
const $groupEditorPreviewName   = document.getElementById('group-editor-preview-name');
const $groupEditorMemberCount   = document.getElementById('group-editor-member-count');
const $groupEditorDeleteConfirm = document.getElementById('group-editor-delete-confirm');
const $groupEditorDeleteCancel  = document.getElementById('group-editor-delete-cancel');
const $groupEditorDeleteYes     = document.getElementById('group-editor-delete-yes');

const GROUP_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#64748b'];

let groupsCache = [];
let editingGroup = null;
let groupEditorColor = GROUP_COLORS[0];
let groupEditorAvatarKey = null;
let groupEditorAvatarUrl = null;
let groupEditorMembers = new Set();
// Friends keyed by id for the lifetime of the open editor — lets the cancel
// handler rebuild a normal checkbox row after a pending invite is cancelled.
let groupEditorFriendsById = new Map();

async function loadGroups() {
  try {
    const [{ groups }, invitationsResult] = await Promise.all([
      api.getGroups(),
      api.listMyGroupInvitations().catch(() => ({ invitations: [] })),
    ]);
    groupsCache = groups;
    renderGroupsList();
    renderGroupInvitations(invitationsResult.invitations || []);
  } catch (err) {
    showError(err.message);
  }
}

function renderGroupInvitations(invitations) {
  $groupInvitationsList.innerHTML = '';
  if (!invitations.length) {
    $groupInvitationsSection.hidden = true;
    return;
  }
  $groupInvitationsSection.hidden = false;
  $groupInvitationsCount.textContent = invitations.length;
  invitations.forEach((inv) => {
    const li = document.createElement('li');
    li.className = 'circle-row circle-row--invitation';
    li.dataset.invitationId = inv.id;
    const groupForAvatar = {
      name: inv.group.name, color: inv.group.color,
      avatarKey: inv.group.avatarKey, avatarUrl: inv.group.avatarUrl,
    };
    li.innerHTML = `
      ${groupAvatarHtml(groupForAvatar, 'sm')}
      <div class="circle-row__info">
        <span class="circle-row__name">${escapeHtml(inv.group.name)}</span>
        <span class="circle-row__members">Invited by ${escapeHtml(inv.inviter.username)} · ${inv.memberCount} member${inv.memberCount === 1 ? '' : 's'}</span>
      </div>
      <div class="circle-row__actions">
        <button class="btn btn--sm btn--primary" data-invitation-accept="${escapeAttr(inv.id)}">Accept</button>
        <button class="btn btn--sm btn--ghost" data-invitation-decline="${escapeAttr(inv.id)}">Decline</button>
      </div>
    `;
    $groupInvitationsList.appendChild(li);
  });
}

// Single delegated handler for Accept/Decline. Disables both buttons while
// the request is in flight to prevent double-clicks; refreshes the list on
// completion so accepted groups appear and declined invites disappear.
$groupInvitationsList.addEventListener('click', async (e) => {
  const acceptBtn  = e.target.closest('[data-invitation-accept]');
  const declineBtn = e.target.closest('[data-invitation-decline]');
  const btn = acceptBtn || declineBtn;
  if (!btn) return;
  const row = btn.closest('.circle-row--invitation');
  const id  = btn.dataset.invitationAccept || btn.dataset.invitationDecline;
  const accept = !!acceptBtn;
  row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  try {
    await api.respondGroupInvitation(id, accept);
    showToast(accept ? 'Joined group' : 'Invitation declined', 'success');
    loadGroups();
  } catch (err) {
    showToast(err.message, 'error');
    row.querySelectorAll('button').forEach((b) => { b.disabled = false; });
  }
});

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

// Live preview of how the group will look (avatar honours the selected
// emoji/photo + colour; name reflects the input). Reuses groupAvatarHtml so
// it matches the real chat UI exactly.
function updateGroupEditorPreview() {
  if (!$groupEditorPreviewAvatar) return;
  const name = $groupEditorName.value.trim();
  $groupEditorPreviewAvatar.innerHTML = groupAvatarHtml(
    { name: name || 'Group', color: groupEditorColor, avatarKey: groupEditorAvatarKey, avatarUrl: groupEditorAvatarUrl },
    'lg'
  );
  $groupEditorPreviewName.textContent = name || (editingGroup ? editingGroup.name : 'New group');
}

function updateGroupEditorMemberCount() {
  if (!$groupEditorMemberCount) return;
  const n = groupEditorMembers.size;
  $groupEditorMemberCount.textContent = n ? ` · ${n}` : '';
}

function renderGroupColorSwatches() {
  $groupEditorColors.innerHTML = '';
  GROUP_COLORS.forEach((color) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'circle-color-swatch';
    if (color === groupEditorColor) btn.classList.add('circle-color-swatch--active');
    btn.style.background = color;
    btn.setAttribute('aria-label', `Colour ${color}`);
    btn.addEventListener('click', () => {
      groupEditorColor = color;
      renderGroupColorSwatches();
      updateGroupEditorPreview();
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
    updateGroupEditorPreview();
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
      updateGroupEditorPreview();
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
      updateGroupEditorPreview();
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
  $groupEditorName.classList.remove('input--invalid');
  $groupEditorError.hidden = true;
  $groupEditorDelete.hidden = !group;
  hideDeleteConfirm();
  renderGroupColorSwatches();
  renderGroupAvatarSwatches();
  updateGroupEditorPreview();
  updateGroupEditorMemberCount();

  $groupEditor.hidden = false;
  $groupEditorName.focus();
  $groupEditorMembers.innerHTML = '<div class="feed__loading"><div class="spinner"></div><span>Loading friends...</span></div>';
  if ($groupEditorMemberSearch) $groupEditorMemberSearch.value = '';

  try {
    // Existing groups may have outstanding invites — fetch them alongside the
    // friend list so invited-but-not-joined friends render as "Pending" rows
    // instead of plain checkboxes. New groups have none.
    const [{ friends }, { invitations: pending }] = await Promise.all([
      api.getFriends(),
      editingGroup
        ? api.listGroupInvitations(editingGroup.id).catch(() => ({ invitations: [] }))
        : Promise.resolve({ invitations: [] }),
    ]);
    groupEditorFriendsById = new Map(friends.map((f) => [f.user.id, f.user]));
    if (friends.length === 0) {
      $groupEditorMembers.innerHTML = `
        <div class="start-conv__empty">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
          <p class="start-conv__empty-title">No friends yet</p>
          <span class="start-conv__empty-hint">Add friends on the Friends tab, then come back to build a group.</span>
        </div>`;
      return;
    }
    const pendingByInvitee = new Map(pending.map((inv) => [inv.invitee.id, inv.id]));
    $groupEditorMembers.innerHTML = '';
    friends.forEach((f) => {
      $groupEditorMembers.appendChild(
        buildGroupEditorFriendRow(f.user, pendingByInvitee.get(f.user.id) || null)
      );
    });
    updateGroupEditorMemberCount();
  } catch (err) {
    $groupEditorMembers.innerHTML = `<p class="picker__empty">${escapeHtml(err.message)}</p>`;
  }
}

// Build one row for the editor's friend list. Friends with a pending invite
// render as a non-interactive "Pending" row with a Cancel (×) button (they
// can't be re-added while invited); everyone else gets the usual member
// checkbox. Both carry data-username so the search filter keeps working.
function buildGroupEditorFriendRow(user, pendingInvitationId) {
  if (pendingInvitationId) {
    const row = document.createElement('div');
    row.className = 'picker__friend picker__friend--pending';
    row.dataset.username = user.username.toLowerCase();
    row.dataset.userId = user.id;
    row.innerHTML = `
      ${avatarHtml(user.username, user.avatarKey, 'sm', user.avatarUrl)}
      <span class="picker__name">${escapeHtml(user.username)}${creatorBadge(user.id)}</span>
      <span class="picker__pending-pill">Pending</span>
      <button type="button" class="picker__cancel-invite"
              data-cancel-invitation="${escapeAttr(pendingInvitationId)}"
              data-user-id="${escapeAttr(user.id)}" title="Cancel invitation">&times;</button>
    `;
    return row;
  }
  const item = document.createElement('label');
  item.className = 'picker__friend';
  item.dataset.username = user.username.toLowerCase();
  item.dataset.userId = user.id;
  const checked = groupEditorMembers.has(user.id) ? 'checked' : '';
  item.innerHTML = `
    <input type="checkbox" class="picker__checkbox" value="${escapeAttr(user.id)}" ${checked}>
    ${avatarHtml(user.username, user.avatarKey, 'sm', user.avatarUrl)}
    <span class="picker__name">${escapeHtml(user.username)}${creatorBadge(user.id)}</span>
  `;
  const cb = item.querySelector('input');
  cb.addEventListener('change', () => {
    if (cb.checked) groupEditorMembers.add(user.id);
    else            groupEditorMembers.delete(user.id);
    item.classList.toggle('picker__friend--checked', cb.checked);
    updateGroupEditorMemberCount();
  });
  if (cb.checked) item.classList.add('picker__friend--checked');
  return item;
}

function closeGroupEditor() {
  $groupEditor.hidden = true;
  editingGroup = null;
  groupEditorMembers.clear();
  groupEditorFriendsById.clear();
  hideDeleteConfirm();
}

// Disable/enable every control in the editor (used during save).
function setGroupEditorBusy(busy) {
  [$groupEditorName, $groupEditorMemberSearch, $groupEditorClose, $groupEditorDelete]
    .forEach((el) => { if (el) el.disabled = busy; });
  $groupEditor.querySelectorAll('.group-avatar-swatch, .circle-color-swatch, .picker__checkbox, .picker__cancel-invite')
    .forEach((el) => { el.disabled = busy; });
  $groupEditor.classList.toggle('group-editor--busy', busy);
}

function showDeleteConfirm() {
  if (!$groupEditorDeleteConfirm) return;
  $groupEditorDeleteConfirm.hidden = false;
  $groupEditorDelete.hidden = true;
  $groupEditorSave.hidden = true;
  $groupEditorDeleteYes.focus();
}

function hideDeleteConfirm() {
  if (!$groupEditorDeleteConfirm) return;
  $groupEditorDeleteConfirm.hidden = true;
  $groupEditorSave.hidden = false;
  $groupEditorDelete.hidden = !editingGroup;
}

$newGroupBtn.addEventListener('click', () => openGroupEditor(null));
$groupEditorClose.addEventListener('click', closeGroupEditor);

// Live preview + clear the invalid state as the user types; Enter saves.
if ($groupEditorName) {
  $groupEditorName.addEventListener('input', () => {
    $groupEditorName.classList.remove('input--invalid');
    if (!$groupEditorError.hidden) $groupEditorError.hidden = true;
    updateGroupEditorPreview();
  });
  $groupEditorName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $groupEditorSave.click(); }
  });
}

// Esc closes the editor (unless a delete confirmation is showing — then it
// just dismisses that).
$groupEditor.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  if ($groupEditorDeleteConfirm && !$groupEditorDeleteConfirm.hidden) hideDeleteConfirm();
  else closeGroupEditor();
});

if ($groupEditorMemberSearch) {
  $groupEditorMemberSearch.addEventListener('input', () => {
    const q = $groupEditorMemberSearch.value.trim().toLowerCase();
    $groupEditorMembers.querySelectorAll('.picker__friend').forEach((row) => {
      const u = row.dataset.username || '';
      row.hidden = q && !u.includes(q);
    });
  });
}

// Cancel a pending invite from within the editor. On success the row reverts
// to a normal (unchecked) checkbox row so the admin can re-invite if they
// change their mind — re-applying the active search filter so it doesn't
// reappear under a query it shouldn't match.
$groupEditorMembers.addEventListener('click', async (e) => {
  const cancelBtn = e.target.closest('[data-cancel-invitation]');
  if (!cancelBtn) return;
  e.preventDefault();
  const invitationId = cancelBtn.dataset.cancelInvitation;
  const userId       = cancelBtn.dataset.userId;
  const row          = cancelBtn.closest('.picker__friend');
  cancelBtn.disabled = true;
  try {
    await api.cancelGroupInvitation(invitationId);
    showToast('Invitation cancelled', 'success');
    const user = groupEditorFriendsById.get(userId);
    if (user && row) {
      groupEditorMembers.delete(userId);
      const fresh = buildGroupEditorFriendRow(user, null);
      const q = $groupEditorMemberSearch ? $groupEditorMemberSearch.value.trim().toLowerCase() : '';
      if (q && !(fresh.dataset.username || '').includes(q)) fresh.hidden = true;
      row.replaceWith(fresh);
    } else if (row) {
      row.remove();
    }
    updateGroupEditorMemberCount();
  } catch (err) {
    showToast(err.message, 'error');
    cancelBtn.disabled = false;
  }
});

$groupEditor.addEventListener('click', (e) => { if (e.target === $groupEditor) closeGroupEditor(); });

$groupEditorSave.addEventListener('click', async () => {
  const name = $groupEditorName.value.trim();
  if (!name) {
    $groupEditorError.textContent = 'Please name the group';
    $groupEditorError.hidden = false;
    $groupEditorName.classList.add('input--invalid');
    $groupEditorName.focus();
    return;
  }
  $groupEditorError.hidden = true;
  $groupEditorName.classList.remove('input--invalid');
  setGroupEditorBusy(true);
  $groupEditorSave.disabled = true;
  $groupEditorSave.classList.add('btn--loading');
  $groupEditorSave.textContent = 'Saving';

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
    // Detect added-vs-existing so the toast can honestly say "invites sent"
    // only when there's actually a new member who'll receive one. (Removing
    // someone or renaming the group shouldn't claim invites were sent.)
    const existingMemberIds = new Set(
      (editingGroup?.members || [])
        .map((m) => m.id)
        .filter((id) => !currentUser || id !== currentUser.id)
    );
    const newlyAdded = [...groupEditorMembers].filter((id) => !existingMemberIds.has(id));
    await api.setGroupMembers(groupId, [...groupEditorMembers]);

    // set_group_members silently skips non-friends and existing invites, so
    // we can't trust newlyAdded.length. Verify by checking what the server
    // *actually* has as pending invites for this group.
    let actualPending = newlyAdded.length;
    if (newlyAdded.length > 0) {
      try {
        const pending = await api.listGroupInvitations(groupId);
        const pendingIds = new Set((pending.invitations || []).map((p) => p.invitee?.id));
        actualPending = newlyAdded.filter((id) => pendingIds.has(id)).length;
      } catch {
        // Ignore — fall back to optimistic count
      }
    }

    let toastMsg;
    let toastKind = 'success';
    if (newlyAdded.length === 0) {
      toastMsg = editingGroup ? 'Group saved' : 'Group created';
    } else if (actualPending === 0) {
      toastMsg = 'No invites sent — make sure they\'re still friends';
      toastKind = 'error';
    } else if (actualPending < newlyAdded.length) {
      toastMsg = `${actualPending} of ${newlyAdded.length} invites sent (others skipped)`;
    } else {
      toastMsg = editingGroup
        ? `Invites sent to ${actualPending} friend${actualPending === 1 ? '' : 's'}`
        : `Group created — ${actualPending} invite${actualPending === 1 ? '' : 's'} sent`;
    }
    showToast(toastMsg, toastKind);
    closeGroupEditor();
    loadGroups();
  } catch (err) {
    $groupEditorError.textContent = err.message;
    $groupEditorError.hidden = false;
  } finally {
    setGroupEditorBusy(false);
    $groupEditorSave.disabled = false;
    $groupEditorSave.classList.remove('btn--loading');
    $groupEditorSave.textContent = 'Save';
  }
});

// Delete now uses an inline, in-overlay confirmation (no native confirm()).
$groupEditorDelete.addEventListener('click', () => {
  if (editingGroup) showDeleteConfirm();
});
if ($groupEditorDeleteCancel) $groupEditorDeleteCancel.addEventListener('click', hideDeleteConfirm);
if ($groupEditorDeleteYes) {
  $groupEditorDeleteYes.addEventListener('click', async () => {
    if (!editingGroup) return;
    $groupEditorDeleteYes.disabled = true;
    $groupEditorDeleteYes.classList.add('btn--loading');
    $groupEditorDeleteYes.textContent = 'Deleting';
    try {
      await api.deleteGroup(editingGroup.id);
      showToast('Group deleted', 'success');
      closeGroupEditor();
      loadGroups();
    } catch (err) {
      showToast(err.message, 'error');
      $groupEditorDeleteYes.disabled = false;
      $groupEditorDeleteYes.classList.remove('btn--loading');
      $groupEditorDeleteYes.textContent = 'Delete';
    }
  });
}

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
const $savedReveal     = document.getElementById('saved-form-reveal');
const $savedAttach     = document.getElementById('saved-attach');
const $savedFile       = document.getElementById('saved-file');
const $savedAttachment = document.getElementById('saved-attachment');

let savedCursor = null;
let isSavedLoadingMore = false;
let savedCache = [];

function renderSavedSkeleton() {
  $savedList.innerHTML = Array.from({ length: 3 }, () => `
    <li class="saved-card saved-card--skeleton" aria-hidden="true">
      <div class="saved-card__media skeleton-block"></div>
      <div class="saved-card__body">
        <span class="skeleton-line skeleton-line--chip"></span>
        <span class="skeleton-line skeleton-line--title"></span>
        <span class="skeleton-line"></span>
        <span class="skeleton-line skeleton-line--short"></span>
      </div>
    </li>`).join('');
}

async function loadBookmarks(append = false) {
  if (!append) {
    $savedLoading.hidden = true;
    savedCursor = null;
    savedCache = [];
    renderSavedSkeleton();
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
          <svg class="feed__error-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <p class="feed__error-text">${escapeHtml(err.message)}</p>
          <button class="btn btn--ghost btn--sm" id="saved-retry">Try again</button>
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
        <p class="feed__empty-text">Paste a link or attach a file below — or tap Save on anything in your chats.</p>
      </li>`;
    return;
  }

  const matches = q ? savedCache.filter((b) => bookmarkMatchesQuery(b, q)) : savedCache;
  if (matches.length === 0) {
    const moreHint = savedCursor ? ' Try “Load more” to search older items.' : '';
    $savedList.innerHTML = `
      <li class="feed__empty-state">
        <svg class="feed__empty-icon" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <p class="feed__empty-title">No matches</p>
        <p class="feed__empty-text">Nothing matched “${escapeHtml(q)}”.${moreHint}</p>
      </li>`;
    return;
  }
  // Reflect the filtered count while searching, for quick orientation.
  if (q) {
    const countLi = document.createElement('li');
    countLi.className = 'saved-results-count';
    countLi.textContent = `${matches.length} result${matches.length === 1 ? '' : 's'} for “${q}”`;
    $savedList.appendChild(countLi);
  }
  matches.forEach(renderBookmarkItem);
}

// SVG icon set for saved cards (consistent 2px round-stroke style).
const SAVED_ICONS = {
  image:    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="M21 15l-5-5L5 21"/>',
  document: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  clock:    '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  globe:    '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 010 20 15.3 15.3 0 010-20z"/>',
  download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  trash:    '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
};
const savedIcon = (name, size = 13) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${SAVED_ICONS[name]}</svg>`;

function renderBookmarkItem(b) {
  const preview = buildLinkPreview(b.url);
  const isImage = b.messageType === 'image';
  const isDoc   = b.messageType === 'document';
  const type    = isImage ? 'image' : isDoc ? 'document' : 'link';

  const li = document.createElement('li');
  li.className = `saved-card saved-card--${type}`;
  li.dataset.bookmarkId = b.id;

  const displayTitle = b.ogTitle || b.title || (isDoc || isImage ? b.fileName : '') || '';

  // Banner media: a saved image shows itself (lightbox); a link shows its OG image.
  let mediaHtml = '';
  if (isImage && b.url) {
    mediaHtml = `<div class="saved-card__media"><img class="saved-card__img" src="${escapeAttr(b.url)}" alt="${escapeAttr(b.fileName || 'image')}" loading="lazy" data-lightbox="${escapeAttr(b.url)}"></div>`;
  } else if (type === 'link' && b.ogImage) {
    mediaHtml = `<a class="saved-card__media saved-card__media--og" href="${escapeAttr(b.url)}" target="_blank" rel="noopener"><img class="saved-card__img" src="${escapeAttr(b.ogImage)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>`;
  }

  // Type chip: platform badge for links, a labelled chip for image/document.
  const chipHtml = isImage
    ? `<span class="saved-card__chip">${savedIcon('image')} Image</span>`
    : isDoc
      ? `<span class="saved-card__chip">${savedIcon('document')} Document</span>`
      : buildPlatformBadge(preview);

  // Document download tile (documents only).
  const docHtml = (isDoc && b.url)
    ? `<a class="saved-card__doc" href="${escapeAttr(b.url)}" target="_blank" rel="noopener" download>
         <span class="saved-card__doc-icon">${savedIcon('document', 18)}</span>
         <span class="saved-card__doc-name">${escapeHtml(b.fileName || 'Document')}</span>
         <span class="saved-card__doc-dl">${savedIcon('download', 16)}</span>
       </a>`
    : '';

  const urlHtml = (b.url && type === 'link')
    ? `<a class="saved-card__url" href="${escapeAttr(b.url)}" target="_blank" rel="noopener">${savedIcon('globe', 12)}<span>${escapeHtml(truncateUrl(b.url, 46))}</span></a>`
    : '';

  const senderHtml = b.sourceSender
    ? `<span class="saved-card__sender">
         ${avatarHtml(b.sourceSender.username, b.sourceSender.avatarKey, 'sm', b.sourceSender.avatarUrl)}
         <span class="saved-card__sender-text">Shared by <b>${escapeHtml(b.sourceSender.username)}</b></span>
       </span>`
    : `<span class="saved-card__sender saved-card__sender--self">Saved by you</span>`;

  li.innerHTML = `
    <button class="saved-card__remove" data-bookmark-delete="${escapeAttr(b.id)}" title="Remove" aria-label="Remove from saved">
      ${savedIcon('trash', 14)}
    </button>
    ${mediaHtml}
    <div class="saved-card__body">
      <div class="saved-card__chiprow">${chipHtml}</div>
      ${displayTitle ? `<p class="saved-card__title">${escapeHtml(displayTitle)}</p>` : ''}
      ${b.ogDescription ? `<p class="saved-card__desc">${escapeHtml(b.ogDescription)}</p>` : ''}
      ${docHtml}
      ${b.note ? `<p class="saved-card__note">${escapeHtml(b.note)}</p>` : ''}
      ${urlHtml}
    </div>
    <div class="saved-card__footer">
      ${senderHtml}
      <span class="saved-card__time">${savedIcon('clock', 11)} ${escapeHtml(timeAgo(b.savedAt))}</span>
    </div>
  `;

  // Drop the banner if a link's OG image fails to load.
  const ogImg = li.querySelector('.saved-card__media--og .saved-card__img');
  if (ogImg) {
    ogImg.addEventListener('error', () => ogImg.closest('.saved-card__media')?.remove());
  }
  $savedList.appendChild(li);
}

$savedList.addEventListener('click', async (e) => {
  const lightImg = e.target.closest('[data-lightbox]');
  if (lightImg) {
    openLightbox(lightImg.getAttribute('data-lightbox'));
    return;
  }
  const delBtn = e.target.closest('[data-bookmark-delete]');
  if (!delBtn) return;
  e.preventDefault();
  e.stopPropagation();
  const id = delBtn.dataset.bookmarkDelete;
  const card = delBtn.closest('.saved-card');
  try {
    await api.deleteBookmark(id);
    savedCache = savedCache.filter((b) => b.id !== id);
    // Collapse the card out: fix its height, then animate to 0 (slide + fade).
    if (card) {
      card.style.height = `${card.offsetHeight}px`;
      requestAnimationFrame(() => card.classList.add('saved-card--removing'));
    }
    setTimeout(() => {
      card?.remove();
      if (savedCache.length === 0) loadBookmarks();
      else if ($savedList.children.length === 0) renderSavedList();
    }, 280);
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
//  SAVED FORM (paste a URL — or attach a file — then save)
// ============================================================
// Two ways to save: paste a link, or attach an image/document (uploaded to
// storage, then archived as a file bookmark). Note + Save reveal once either
// a valid URL is typed or a file is attached.

let savedAttachment = null; // { messageType, filePath, url, fileName, fileSize, mimeType }

function refreshSavedFormState() {
  const valid = isValidUrl($savedUrlInput.value.trim());
  const ready = valid || !!savedAttachment;
  $savedReveal.hidden = !ready;
  // While a file is attached, the URL field + attach button step aside.
  $savedUrlInput.hidden = !!savedAttachment;
  $savedAttach.hidden = !!savedAttachment;
  if (!ready) $savedFormError.hidden = true;
}

function renderSavedAttachment() {
  if (!savedAttachment) {
    $savedAttachment.hidden = true;
    $savedAttachment.innerHTML = '';
    return;
  }
  const a = savedAttachment;
  const thumb = a.messageType === 'image'
    ? `<img class="saved-form__attachment-thumb" src="${escapeAttr(a.url)}" alt="">`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;
  $savedAttachment.hidden = false;
  $savedAttachment.innerHTML = `
    ${thumb}
    <span class="saved-form__attachment-name">${escapeHtml(a.fileName)}</span>
    <button type="button" class="saved-form__attachment-remove" title="Remove">&times;</button>
  `;
  $savedAttachment.querySelector('.saved-form__attachment-remove').addEventListener('click', () => {
    savedAttachment = null;
    renderSavedAttachment();
    refreshSavedFormState();
  });
}

$savedUrlInput.addEventListener('input', refreshSavedFormState);
$savedAttach.addEventListener('click', () => $savedFile.click());

$savedFile.addEventListener('change', async () => {
  const file = $savedFile.files && $savedFile.files[0];
  $savedFile.value = '';
  if (!file) return;
  $savedFormError.hidden = true;
  $savedAttachment.hidden = false;
  $savedAttachment.innerHTML = `<span class="saved-form__attachment-name">Uploading ${escapeHtml(file.name)}…</span>`;
  $savedUrlInput.hidden = true;
  $savedAttach.hidden = true;
  try {
    savedAttachment = await api.uploadMessageFile(file);
    renderSavedAttachment();
  } catch (err) {
    savedAttachment = null;
    renderSavedAttachment();
    showToast(err.message, 'error');
  }
  refreshSavedFormState();
});

function resetSavedForm() {
  savedAttachment = null;
  $savedUrlInput.value = '';
  $savedNoteInput.value = '';
  renderSavedAttachment();
  refreshSavedFormState();
}

$savedForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const note = $savedNoteInput.value.trim() || undefined;
  $savedFormError.hidden = true;
  $savedAddBtn.disabled = true;
  try {
    if (savedAttachment) {
      await api.saveFileBookmark({
        url:         savedAttachment.url,
        filePath:    savedAttachment.filePath,
        fileName:    savedAttachment.fileName,
        mimeType:    savedAttachment.mimeType,
        messageType: savedAttachment.messageType,
        note,
      });
    } else {
      const url = $savedUrlInput.value.trim();
      if (!isValidUrl(url)) {
        $savedFormError.textContent = 'Enter a valid URL';
        $savedFormError.hidden = false;
        return;
      }
      const preview = buildLinkPreview(url);
      await api.saveBookmark(url, {
        note,
        platform: preview.platform?.id || undefined,
        title:    preview.sublabel || undefined,
      });
    }
    resetSavedForm();
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
