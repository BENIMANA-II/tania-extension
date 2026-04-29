/**
 * Tania — Link Utilities
 *
 * URL validation, platform detection, and metadata extraction.
 */

// --- Platform Definitions ---

const PLATFORMS = [
  {
    id: 'twitter',
    name: 'Twitter / X',
    color: '#1d9bf0',
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`,
    patterns: [
      /^https?:\/\/(www\.)?(twitter|x)\.com\/\w+\/status\/\d+/,
      /^https?:\/\/(www\.)?(twitter|x)\.com\/\w+\/?$/,
    ],
    extractInfo(url) {
      const statusMatch = url.match(/(?:twitter|x)\.com\/(\w+)\/status\/(\d+)/);
      if (statusMatch) return { user: `@${statusMatch[1]}`, type: 'post' };
      const profileMatch = url.match(/(?:twitter|x)\.com\/(\w+)\/?$/);
      if (profileMatch) return { user: `@${profileMatch[1]}`, type: 'profile' };
      return null;
    },
  },
  {
    id: 'youtube',
    name: 'YouTube',
    color: '#ff0000',
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`,
    patterns: [
      /^https?:\/\/(www\.)?youtube\.com\/watch\?v=[\w-]+/,
      /^https?:\/\/youtu\.be\/[\w-]+/,
      /^https?:\/\/(www\.)?youtube\.com\/shorts\/[\w-]+/,
      /^https?:\/\/(www\.)?youtube\.com\/@[\w-]+/,
    ],
    extractInfo(url) {
      const videoMatch = url.match(/(?:watch\?v=|youtu\.be\/|shorts\/)([\w-]+)/);
      if (videoMatch) {
        const isShort = url.includes('/shorts/');
        return { videoId: videoMatch[1], type: isShort ? 'short' : 'video' };
      }
      const channelMatch = url.match(/youtube\.com\/@([\w-]+)/);
      if (channelMatch) return { channel: `@${channelMatch[1]}`, type: 'channel' };
      return null;
    },
  },
  {
    id: 'instagram',
    name: 'Instagram',
    color: '#e4405f',
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>`,
    patterns: [
      /^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[\w-]+/,
      /^https?:\/\/(www\.)?instagram\.com\/[\w.]+\/?$/,
    ],
    extractInfo(url) {
      const postMatch = url.match(/instagram\.com\/(p|reel|tv)\/([\w-]+)/);
      if (postMatch) return { code: postMatch[2], type: postMatch[1] };
      const userMatch = url.match(/instagram\.com\/([\w.]+)\/?$/);
      if (userMatch && !['p', 'reel', 'tv', 'explore', 'accounts'].includes(userMatch[1])) {
        return { user: `@${userMatch[1]}`, type: 'profile' };
      }
      return null;
    },
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    color: '#000000',
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1v-3.5a6.37 6.37 0 00-.79-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 0010.86 4.43v-7.15a8.16 8.16 0 005.58 2.09V11.1a4.84 4.84 0 01-5.58-1.07V6.69h5.58z"/></svg>`,
    patterns: [
      /^https?:\/\/(www\.)?tiktok\.com\/@[\w.]+\/video\/\d+/,
      /^https?:\/\/(www\.)?tiktok\.com\/@[\w.]+\/?$/,
      /^https?:\/\/vm\.tiktok\.com\/[\w]+/,
    ],
    extractInfo(url) {
      const videoMatch = url.match(/tiktok\.com\/@([\w.]+)\/video\/(\d+)/);
      if (videoMatch) return { user: `@${videoMatch[1]}`, type: 'video' };
      const userMatch = url.match(/tiktok\.com\/@([\w.]+)\/?$/);
      if (userMatch) return { user: `@${userMatch[1]}`, type: 'profile' };
      if (url.includes('vm.tiktok.com')) return { type: 'video' };
      return null;
    },
  },
  {
    id: 'reddit',
    name: 'Reddit',
    color: '#ff4500',
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0A12 12 0 000 12a12 12 0 0012 12 12 12 0 0012-12A12 12 0 0012 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 01-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 01.042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 014.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 01.14-.197.35.35 0 01.238-.042l2.906.617a1.214 1.214 0 011.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 00-.231.094.33.33 0 000 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 00.029-.463.33.33 0 00-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 00-.232-.094z"/></svg>`,
    patterns: [
      /^https?:\/\/(www\.)?reddit\.com\/r\/\w+\/comments\/\w+/,
      /^https?:\/\/(www\.)?reddit\.com\/r\/\w+\/?$/,
    ],
    extractInfo(url) {
      const postMatch = url.match(/reddit\.com\/r\/(\w+)\/comments\/(\w+)/);
      if (postMatch) return { subreddit: `r/${postMatch[1]}`, type: 'post' };
      const subMatch = url.match(/reddit\.com\/r\/(\w+)\/?$/);
      if (subMatch) return { subreddit: `r/${subMatch[1]}`, type: 'subreddit' };
      return null;
    },
  },
  {
    id: 'github',
    name: 'GitHub',
    color: '#24292e',
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`,
    patterns: [
      /^https?:\/\/(www\.)?github\.com\/[\w-]+\/[\w.-]+/,
      /^https?:\/\/(www\.)?github\.com\/[\w-]+\/?$/,
    ],
    extractInfo(url) {
      const repoMatch = url.match(/github\.com\/([\w-]+)\/([\w.-]+)/);
      if (repoMatch) return { owner: repoMatch[1], repo: repoMatch[2], type: 'repo' };
      const userMatch = url.match(/github\.com\/([\w-]+)\/?$/);
      if (userMatch) return { user: userMatch[1], type: 'profile' };
      return null;
    },
  },
  {
    id: 'linkedin',
    name: 'LinkedIn',
    color: '#0a66c2',
    icon: `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>`,
    patterns: [
      /^https?:\/\/(www\.)?linkedin\.com\/(posts|pulse|feed|in)\/[\w-]+/,
    ],
    extractInfo(url) {
      const postMatch = url.match(/linkedin\.com\/(posts|pulse)\/([\w-]+)/);
      if (postMatch) return { type: postMatch[1] };
      const profileMatch = url.match(/linkedin\.com\/in\/([\w-]+)/);
      if (profileMatch) return { user: profileMatch[1], type: 'profile' };
      return null;
    },
  },
];

// --- URL Validation ---

export function isValidUrl(str) {
  try {
    const url = new URL(str);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// --- Extract URL from drop data ---

export function extractUrl(dataTransfer) {
  // Try text/uri-list first (standard for dragged links)
  const uriList = dataTransfer.getData('text/uri-list');
  if (uriList) {
    // uri-list can contain multiple URLs separated by newlines; comments start with #
    const firstUrl = uriList
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'));
    if (firstUrl && isValidUrl(firstUrl)) return firstUrl;
  }

  // Fallback to text/plain
  const text = dataTransfer.getData('text/plain').trim();
  if (text && isValidUrl(text)) return text;

  // Try to find a URL inside the text
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  if (urlMatch && isValidUrl(urlMatch[0])) return urlMatch[0];

  return null;
}

// --- Platform Detection ---

export function detectPlatform(url) {
  for (const platform of PLATFORMS) {
    for (const pattern of platform.patterns) {
      if (pattern.test(url)) {
        const info = platform.extractInfo(url);
        return {
          id: platform.id,
          name: platform.name,
          color: platform.color,
          icon: platform.icon,
          info,
        };
      }
    }
  }
  return null;
}

// --- Build display data for a dropped link ---

export function buildLinkPreview(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname.replace('www.', '');
  } catch {
    hostname = url;
  }

  const platform = detectPlatform(url);

  const preview = {
    url,
    hostname,
    platform,
    label: '',
    sublabel: hostname,
  };

  if (platform?.info) {
    const { info } = platform;
    switch (platform.id) {
      case 'twitter':
        preview.label = info.user || '';
        preview.sublabel = info.type === 'post' ? `${info.user} — post` : `${info.user} — profile`;
        break;
      case 'youtube':
        if (info.type === 'video') preview.sublabel = 'YouTube video';
        else if (info.type === 'short') preview.sublabel = 'YouTube Short';
        else if (info.channel) preview.sublabel = `YouTube — ${info.channel}`;
        break;
      case 'instagram':
        preview.sublabel = info.user
          ? `Instagram — ${info.user}`
          : `Instagram ${info.type}`;
        break;
      case 'tiktok':
        preview.sublabel = info.user
          ? `TikTok — ${info.user}`
          : 'TikTok video';
        break;
      case 'reddit':
        preview.sublabel = info.subreddit
          ? `Reddit — ${info.subreddit}`
          : 'Reddit';
        break;
      case 'github':
        if (info.repo) preview.sublabel = `GitHub — ${info.owner}/${info.repo}`;
        else if (info.user) preview.sublabel = `GitHub — ${info.user}`;
        break;
      case 'linkedin':
        preview.sublabel = info.user
          ? `LinkedIn — ${info.user}`
          : `LinkedIn ${info.type}`;
        break;
    }
  }

  return preview;
}
