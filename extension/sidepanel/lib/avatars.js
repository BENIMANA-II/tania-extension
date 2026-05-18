/**
 * Tania — avatar presets
 *
 * The user picks one key, stored in profiles.avatar_key. We render the
 * matching emoji on a fixed background color. If no key is set, we fall
 * back to an initial + a hash-derived background so every user still has
 * a stable, distinguishable avatar.
 */

export const AVATAR_PRESETS = [
  { key: 'fox',     emoji: '🦊', bg: '#fb923c' },
  { key: 'bear',    emoji: '🐻', bg: '#a16207' },
  { key: 'panda',   emoji: '🐼', bg: '#525252' },
  { key: 'cat',     emoji: '🐱', bg: '#f59e0b' },
  { key: 'dog',     emoji: '🐶', bg: '#d97706' },
  { key: 'rabbit',  emoji: '🐰', bg: '#f472b6' },
  { key: 'owl',     emoji: '🦉', bg: '#7c3aed' },
  { key: 'penguin', emoji: '🐧', bg: '#0ea5e9' },
  { key: 'koala',   emoji: '🐨', bg: '#64748b' },
  { key: 'frog',    emoji: '🐸', bg: '#16a34a' },
  { key: 'octopus', emoji: '🐙', bg: '#c026d3' },
  { key: 'unicorn', emoji: '🦄', bg: '#a855f7' },
  { key: 'wave',    emoji: '🌊', bg: '#0891b2' },
  { key: 'flame',   emoji: '🔥', bg: '#dc2626' },
  { key: 'leaf',    emoji: '🍃', bg: '#15803d' },
  { key: 'star',    emoji: '⭐', bg: '#eab308' },
];

const FALLBACK_PALETTE = [
  '#6366f1', '#22c55e', '#f59e0b', '#ef4444',
  '#06b6d4', '#a855f7', '#ec4899', '#0ea5e9',
];

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function avatarForKey(key) {
  return AVATAR_PRESETS.find((a) => a.key === key) || null;
}

export function fallbackForName(name) {
  const idx = hashString(name || '?') % FALLBACK_PALETTE.length;
  return { initial: (name || '?')[0].toUpperCase(), bg: FALLBACK_PALETTE[idx] };
}

/** Stable color identity for a user: their preset's bg if they have one,
 *  otherwise a hash-derived fallback. Used to tint chat bubbles. */
export function colorForUser(username, avatarKey) {
  const preset = avatarForKey(avatarKey);
  if (preset) return preset.bg;
  return fallbackForName(username).bg;
}

/**
 * Return inline HTML for an avatar circle. Sizes: 'sm' (24), 'md' (32), 'lg' (40).
 * Priority: avatarUrl (uploaded image) > avatarKey (emoji preset) > initial fallback.
 */
export function avatarHtml(username, avatarKey, size = 'md', avatarUrl = null) {
  const cls = `avatar avatar--${size}`;
  if (avatarUrl) {
    return `<span class="${cls} avatar--photo" title="${escape(username)}"><img class="avatar__img" src="${escape(avatarUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer"></span>`;
  }
  const preset = avatarForKey(avatarKey);
  if (preset) {
    return `<span class="${cls}" style="background:${preset.bg}" title="${escape(username)}"><span class="avatar__emoji">${preset.emoji}</span></span>`;
  }
  const fb = fallbackForName(username);
  return `<span class="${cls}" style="background:${fb.bg}" title="${escape(username)}"><span class="avatar__initial">${fb.initial}</span></span>`;
}

function escape(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
