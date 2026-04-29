/**
 * Tania — Content Script
 *
 * Two responsibilities:
 * 1. Capture dragstart on links → forward to service worker
 * 2. Check if the current page was shared → show "Shared by" banner
 *
 * Banner uses Shadow DOM for full style isolation from the host page.
 * All banner logic is wrapped in try-catch to avoid breaking host pages.
 */

// ============================================================
//  1. DRAG CAPTURE
// ============================================================

document.addEventListener('dragstart', (e) => {
  const anchor = e.target.closest('a[href]');
  if (!anchor) return;

  chrome.runtime.sendMessage({
    type: 'LINK_DROPPED',
    payload: {
      url: anchor.href,
      title: anchor.textContent.trim().slice(0, 300),
    },
  });
});

// ============================================================
//  2. SHARED LINK BANNER
// ============================================================

(function checkCurrentPage() {
  const url = window.location.href;

  // Skip non-http pages (extensions, chrome://, etc.)
  if (!url.startsWith('http')) return;

  chrome.runtime.sendMessage(
    { type: 'CHECK_URL', payload: { url } },
    (response) => {
      // Guard against extension context invalidation
      if (chrome.runtime.lastError || !response?.found) return;

      // Wrap banner rendering in try-catch to never break the host page
      try {
        showBanner(response);
      } catch (err) {
        console.warn('[Tania] Banner render failed:', err.message);
      }
    }
  );
})();

function showBanner({ sender, note, sharedAt, shareId }) {
  // Don't show if already dismissed this session for this share
  const dismissKey = `tania-dismissed-${shareId}`;
  if (sessionStorage.getItem(dismissKey)) return;

  // --- Create host element ---
  const host = document.createElement('div');
  host.id = 'tania-banner-host';
  const shadow = host.attachShadow({ mode: 'closed' });

  // --- Styles (fully isolated) ---
  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .banner {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      max-width: 320px;
      padding: 12px 14px;
      background: #1c1917;
      color: #fafaf9;
      border-radius: 12px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.2);
      font-size: 13px;
      line-height: 1.45;
      animation: tania-slide-in 0.3s ease;
      cursor: default;
    }

    .banner--hiding {
      animation: tania-slide-out 0.25s ease forwards;
    }

    @keyframes tania-slide-in {
      from { opacity: 0; transform: translateY(12px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    @keyframes tania-slide-out {
      from { opacity: 1; transform: translateY(0) scale(1); }
      to   { opacity: 0; transform: translateY(8px) scale(0.96); }
    }

    .icon {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: #6366f1;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      margin-top: 1px;
    }

    .body {
      flex: 1;
      min-width: 0;
    }

    .title {
      font-weight: 600;
      margin-bottom: 2px;
    }

    .accent {
      color: #a5b4fc;
    }

    .note {
      font-size: 12px;
      color: #a8a29e;
      font-style: italic;
      margin-top: 3px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .time {
      font-size: 11px;
      color: #78716c;
      margin-top: 3px;
    }

    .close {
      flex-shrink: 0;
      width: 22px;
      height: 22px;
      border: none;
      background: none;
      color: #78716c;
      cursor: pointer;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      transition: color 0.15s, background 0.15s;
    }

    .close:hover {
      color: #fafaf9;
      background: rgba(255,255,255,0.1);
    }
  `;

  // --- Banner markup ---
  const banner = document.createElement('div');
  banner.className = 'banner';

  const initial = sender[0].toUpperCase();
  const timeStr = formatTime(sharedAt);

  banner.innerHTML = `
    <span class="icon">${initial}</span>
    <div class="body">
      <div class="title">Shared by <span class="accent">${esc(sender)}</span></div>
      ${note ? `<div class="note">${esc(note)}</div>` : ''}
      <div class="time">${timeStr}</div>
    </div>
    <button class="close" title="Dismiss">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
  `;

  shadow.appendChild(style);
  shadow.appendChild(banner);
  document.documentElement.appendChild(host);

  // --- Dismiss ---
  function dismiss() {
    banner.classList.add('banner--hiding');
    sessionStorage.setItem(dismissKey, '1');
    banner.addEventListener('animationend', () => host.remove(), { once: true });
  }

  shadow.querySelector('.close').addEventListener('click', dismiss);

  // Auto-dismiss after 8 seconds
  setTimeout(dismiss, 8000);
}

// --- Utilities ---

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function formatTime(dateStr) {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}
