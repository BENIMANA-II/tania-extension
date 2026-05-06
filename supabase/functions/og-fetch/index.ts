// Tania — og-fetch Edge Function
//
// Fetches Open Graph metadata for a freshly-created share and writes it
// back into the `shares` row. Runs server-side because the browser can't
// fetch arbitrary cross-origin pages (no CORS on most sites).
//
// Auth: passes the caller's JWT through to PostgREST when updating the
// share. RLS (`shares_update_as_sender`) ensures only the original sender
// can mutate their share — so this function doesn't need the service_role
// key at all.
//
// Deploy:
//   supabase functions deploy og-fetch --no-verify-jwt
// (We pass --no-verify-jwt because we re-validate the JWT implicitly via
// the PostgREST update; saves a Supabase auth round-trip.)

const OG_TIMEOUT_MS = 5000;
const MAX_BYTES     = 16 * 1024;

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let payload: { shareId?: string; url?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { shareId, url } = payload;
  if (!shareId || !url) return json({ error: 'shareId and url required' }, 400);
  if (!/^https?:\/\//.test(url)) return json({ error: 'Only http(s) URLs' }, 400);

  const auth = req.headers.get('Authorization');
  if (!auth) return json({ error: 'Missing Authorization header' }, 401);

  const og = await fetchOgMetadata(url);

  // No interesting metadata? Nothing to update — early return.
  if (!og.ogTitle && !og.ogDescription && !og.ogImage && !og.siteIcon) {
    return json({ updated: false });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey     = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) {
    return json({ error: 'Function misconfigured (missing env)' }, 500);
  }

  // Update via PostgREST as the calling user — RLS gates write access to
  // shares.sender_id = auth.uid(), so a stranger can't poison someone else's
  // share even if they guess the shareId.
  const patchRes = await fetch(`${supabaseUrl}/rest/v1/shares?id=eq.${shareId}`, {
    method: 'PATCH',
    headers: {
      apikey:         anonKey,
      Authorization:  auth,
      'Content-Type': 'application/json',
      Prefer:         'return=minimal',
    },
    body: JSON.stringify({
      og_title:       og.ogTitle,
      og_description: og.ogDescription,
      og_image:       og.ogImage,
      site_icon:      og.siteIcon,
    }),
  });

  if (!patchRes.ok) {
    return json({ error: `Update failed (${patchRes.status})` }, patchRes.status);
  }

  return json({ updated: true, og });
});

// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

interface OgMeta {
  ogTitle:       string | null;
  ogDescription: string | null;
  ogImage:       string | null;
  siteIcon:      string | null;
}

async function fetchOgMetadata(url: string): Promise<OgMeta> {
  const empty: OgMeta = { ogTitle: null, ogDescription: null, ogImage: null, siteIcon: null };

  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), OG_TIMEOUT_MS);

    const response = await fetch(url, {
      signal:   controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Tania/0.1 (Link Preview Bot)',
        Accept:       'text/html',
      },
    });
    clearTimeout(timeout);

    if (!response.ok) return empty;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return empty;

    // Read only the first MAX_BYTES — meta tags always live in <head>.
    const reader  = response.body!.getReader();
    const decoder = new TextDecoder();
    let html = '';
    while (html.length < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    reader.cancel();

    return {
      ogTitle:       extractMeta(html, 'og:title')       || extractMeta(html, 'twitter:title')       || extractTitle(html),
      ogDescription: extractMeta(html, 'og:description') || extractMeta(html, 'twitter:description'),
      ogImage:       extractMeta(html, 'og:image')       || extractMeta(html, 'twitter:image'),
      siteIcon:      extractIcon(html, url),
    };
  } catch {
    return empty;
  }
}

function extractIcon(html: string, pageUrl: string): string | null {
  const patterns = [
    /<link[^>]+rel=["'](?:shortcut\s+)?icon["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut\s+)?icon["']/i,
    /<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']apple-touch-icon["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return resolveUrl(m[1], pageUrl);
  }
  try {
    return new URL('/favicon.ico', pageUrl).href;
  } catch {
    return null;
  }
}

function resolveUrl(href: string, base: string): string {
  try { return new URL(href, base).href; } catch { return href; }
}

function extractMeta(html: string, property: string): string | null {
  const propRe = escapeRegex(property);
  const a = html.match(new RegExp(
    `<meta[^>]+(?:property|name)=["']${propRe}["'][^>]+content=["']([^"']+)["']`, 'i'
  ));
  if (a) return decodeEntities(a[1]).slice(0, 500);

  const b = html.match(new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${propRe}["']`, 'i'
  ));
  if (b) return decodeEntities(b[1]).slice(0, 500);

  return null;
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? decodeEntities(m[1].trim()).slice(0, 300) : null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&#x27;/g, "'");
}
