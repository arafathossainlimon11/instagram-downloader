'use strict';

const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { Readable } = require('stream');

/* ---------- Configuration ---------- */
const PORT = process.env.PORT || 3000;
const SITE_URL = (process.env.SITE_URL || 'https://reelsaver.online').replace(/\/+$/, '');

// Environment variables take priority (recommended on Render/Vercel); the fallbacks are your credentials.
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'a3b126029bmshfb86807dc38830dp1a8c53jsncf074cc292fc';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'instagram-downloader-download-instagram-videos-stories1.p.rapidapi.com';
const RAPIDAPI_ENDPOINT = 'https://' + RAPIDAPI_HOST + '/index';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const app = express();
app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10kb' }));

/* ---------- Rate limiting ---------- */
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests. Please wait a few minutes and try again.' },
});
const proxyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 400,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests. Please slow down.',
});

/* ---------- URL validation ---------- */
const ALLOWED_PAGE_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am', 'www.instagr.am']);

function normalizeInstagramUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch (e) {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!ALLOWED_PAGE_HOSTS.has(u.hostname.toLowerCase())) return null;
  const p = u.pathname;
  const ok =
    /^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?/.test(p) ||
    /^\/stories\/[A-Za-z0-9._]+\/\d+\/?/.test(p) ||
    /^\/share\/(?:p|reel|r)?\/?[A-Za-z0-9_-]+\/?/.test(p);
  if (!ok) return null;
  const clean = new URL(u.origin + p);
  if (u.searchParams.has('img_index') && /\/p\//.test(p)) {
    clean.searchParams.set('img_index', u.searchParams.get('img_index'));
  }
  return clean.toString();
}

function sanitizeFilename(name) {
  const cleaned = String(name || 'reelsaver').replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return cleaned || 'reelsaver';
}

/* ---------- Proxy host allow-list (Instagram CDN + hosts returned by the API) ---------- */
const CDN_SUFFIXES = ['cdninstagram.com', 'fbcdn.net', 'instagram.com'];
const dynamicHosts = new Map(); // hostname -> expiry timestamp
const DYNAMIC_HOST_TTL = 30 * 60 * 1000;
const IP_LITERAL = /^(\d{1,3}\.){3}\d{1,3}$|:/;

function registerHost(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const h = u.hostname.toLowerCase();
    if (u.protocol !== 'https:' || !h.includes('.') || IP_LITERAL.test(h) || h === 'localhost') return;
    if (dynamicHosts.size > 500) dynamicHosts.delete(dynamicHosts.keys().next().value);
    dynamicHosts.set(h, Date.now() + DYNAMIC_HOST_TTL);
  } catch (e) {
    /* ignore */
  }
}

function isAllowedHost(hostname) {
  const h = hostname.toLowerCase();
  if (CDN_SUFFIXES.some((s) => h === s || h.endsWith('.' + s))) return true;
  const exp = dynamicHosts.get(h);
  if (exp && exp > Date.now()) return true;
  if (exp) dynamicHosts.delete(h);
  return false;
}

/* ---------- RapidAPI response parsing ---------- */
const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic)$/i;
const THUMB_KEY = /thumb|cover|preview|poster|display|image|photo|picture/i;
const VIDEO_KEY = /video|download|media|mp4|hd|sd|src|link|url/i;

function pathOf(u) {
  try {
    return new URL(u).pathname;
  } catch (e) {
    return '';
  }
}

function walk(node, key, found, depth) {
  if (depth > 8 || node === null || node === undefined) return;
  if (typeof node === 'string') {
    if (/^https?:\/\//i.test(node)) found.push({ key: key || '', url: node.trim() });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, key, found, depth + 1));
    return;
  }
  if (typeof node === 'object') {
    Object.keys(node).forEach((k) => walk(node[k], k, found, depth + 1));
  }
}

function firstString(obj, keys) {
  for (let i = 0; i < keys.length; i++) {
    const v = obj && obj[keys[i]];
    if (typeof v === 'string' && v.trim() && !/^https?:\/\//i.test(v.trim())) return v.trim();
  }
  return null;
}

function parseRapidResponse(data) {
  const found = [];
  walk(data, '', found, 0);

  const videos = [];
  const thumbs = [];
  const images = [];
  const seen = new Set();

  found.forEach((f) => {
    const p = pathOf(f.url);
    const dedupeKey = f.url.split('?')[0];
    if (!p || seen.has(dedupeKey)) return;

    const looksVideo = VIDEO_EXT.test(p) || /[?&](mime_type|_nc_vs)=.*video/i.test(f.url) || /video_dash|\/v\/t\d+[^/]*\/.*\.mp4/i.test(f.url);
    const looksImage = IMAGE_EXT.test(p);

    if (looksVideo) {
      seen.add(dedupeKey);
      videos.push(f.url);
    } else if (looksImage) {
      seen.add(dedupeKey);
      if (/thumb|cover|preview|poster/i.test(f.key)) thumbs.push(f.url);
      else images.push(f.url);
    }
  });

  // Fallback: unknown extension but the key clearly names a video/download link
  if (!videos.length) {
    found.forEach((f) => {
      const p = pathOf(f.url);
      const dedupeKey = f.url.split('?')[0];
      if (!p || seen.has(dedupeKey) || IMAGE_EXT.test(p)) return;
      if (/video|download|media|mp4/i.test(f.key) && !THUMB_KEY.test(f.key.replace(/media/i, ''))) {
        seen.add(dedupeKey);
        videos.push(f.url);
      }
    });
  }

  const root = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const nested = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data : {};

  const title =
    firstString(root, ['title', 'caption', 'description', 'text']) ||
    firstString(nested, ['title', 'caption', 'description', 'text']) ||
    'Instagram video';
  const uploader =
    firstString(root, ['username', 'owner', 'author', 'user', 'uploader']) ||
    firstString(nested, ['username', 'owner', 'author', 'user', 'uploader']) ||
    null;
  const duration = Number(root.duration || nested.duration || root.video_duration || nested.video_duration) || null;

  const items = [];
  if (videos.length) {
    videos.forEach((v, i) => {
      const thumb = thumbs.length === videos.length ? thumbs[i] : thumbs[0] || images[0] || null;
      items.push({
        type: 'video',
        title: videos.length > 1 ? null : title,
        thumbnail: thumb,
        duration: videos.length === 1 ? duration : null,
        formats: [{ label: 'MP4 Video', ext: 'mp4', height: 0, size: null, url: v }],
      });
    });
  } else if (images.length) {
    images.forEach((img) => {
      const ext = (pathOf(img).split('.').pop() || 'jpg').toLowerCase();
      items.push({
        type: 'image',
        title: images.length > 1 ? null : title,
        thumbnail: null,
        duration: null,
        formats: [{ label: 'Original Image', ext: ext, height: 0, size: null, url: img }],
      });
    });
  }

  return { items, title, uploader };
}

/* ---------- Error mapping ---------- */
function mapUpstreamStatus(status, bodyText) {
  const t = String(bodyText || '').toLowerCase();
  if (status === 401 || status === 403) {
    if (t.includes('not subscribed') || t.includes('subscribe')) {
      return { status: 502, message: 'The download service is not available right now. Please try again later.' };
    }
    return { status: 502, message: 'The download service rejected the request. Please try again later.' };
  }
  if (status === 429) {
    return { status: 429, message: 'The service is receiving too many requests right now. Please try again in a minute.' };
  }
  if (status === 404 || status === 422 || status === 400) {
    return { status: 404, message: 'We could not find this post. Make sure the link is correct and the post is public.' };
  }
  if (status >= 500) {
    return { status: 502, message: 'The download service is temporarily unavailable. Please try again shortly.' };
  }
  return { status: 502, message: 'We could not fetch this video right now. Please try again shortly.' };
}

function mapBodyMessage(msg) {
  const t = String(msg || '').toLowerCase();
  if (t.includes('private')) {
    return { status: 403, message: 'This post is private. Only public posts can be downloaded.' };
  }
  if (t.includes('not found') || t.includes('invalid') || t.includes('unavailable') || t.includes('no media') || t.includes('not exist')) {
    return { status: 404, message: 'We could not find this post. Make sure the link is correct and the post is public.' };
  }
  if (t.includes('limit') || t.includes('quota')) {
    return { status: 429, message: 'The service is receiving too many requests right now. Please try again in a minute.' };
  }
  return null;
}

/* ---------- Small in-memory cache ---------- */
const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return hit.v;
}
function cacheSet(key, value) {
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  cache.set(key, { t: Date.now(), v: value });
}

/* ---------- Core: call RapidAPI ---------- */
async function fetchFromRapidApi(igUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 40000);
  try {
    const endpoint = new URL(RAPIDAPI_ENDPOINT);
    endpoint.searchParams.set('url', igUrl);

    const response = await fetch(endpoint.toString(), {
      method: 'GET',
      headers: {
        'X-RapidAPI-Key': RAPIDAPI_KEY,
        'X-RapidAPI-Host': RAPIDAPI_HOST,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      json = null;
    }

    if (!response.ok) {
      const bodyMsg = json && (json.message || json.error || json.detail);
      const fromBody = bodyMsg ? mapBodyMessage(bodyMsg) : null;
      const err = new Error('Upstream HTTP ' + response.status);
      err.mapped = fromBody || mapUpstreamStatus(response.status, text);
      err.raw = text.slice(0, 300);
      throw err;
    }

    if (json === null) {
      const err = new Error('Upstream returned non-JSON response');
      err.mapped = { status: 502, message: 'We received an unexpected response from the download service. Please try again.' };
      err.raw = text.slice(0, 300);
      throw err;
    }

    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function handleDownload(req, res) {
  const rawUrl = (req.body && req.body.url) || req.query.url;
  const cleanUrl = normalizeInstagramUrl(rawUrl);
  if (!cleanUrl) {
    return res.status(400).json({
      success: false,
      error: 'Please enter a valid Instagram Reel, video or post link.',
    });
  }

  const cached = cacheGet(cleanUrl);
  if (cached) return res.json(cached);

  try {
    const data = await fetchFromRapidApi(cleanUrl);

    // Some APIs return 200 with an error payload
    const errField = data && (data.error || (data.success === false && data.message) || (data.status === 'error' && data.message));
    if (errField) {
      const mapped = mapBodyMessage(errField) || {
        status: 404,
        message: 'No downloadable media was found for this link.',
      };
      return res.status(mapped.status).json({ success: false, error: mapped.message });
    }

    const parsed = parseRapidResponse(data);
    if (!parsed.items.length) {
      return res.status(404).json({
        success: false,
        error: 'No downloadable video was found in this post. Make sure it is public and contains a video.',
      });
    }

    parsed.items.forEach((item) => {
      item.formats.forEach((f) => registerHost(f.url));
      if (item.thumbnail) registerHost(item.thumbnail);
    });

    const firstVideo = parsed.items.find((i) => i.type === 'video');
    const idMatch = cleanUrl.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);

    const payload = {
      success: true,
      id: sanitizeFilename(idMatch ? idMatch[1] : 'reelsaver'),
      title: String(parsed.title).slice(0, 160),
      uploader: parsed.uploader,
      videoUrl: firstVideo ? firstVideo.formats[0].url : null,
      thumbnail: firstVideo ? firstVideo.thumbnail : null,
      items: parsed.items,
    };

    cacheSet(cleanUrl, payload);
    return res.json(payload);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return res.status(504).json({ success: false, error: 'The download service took too long to respond. Please try again.' });
    }
    if (err && err.mapped) {
      console.error('[rapidapi-error]', cleanUrl, err.message, err.raw || '');
      return res.status(err.mapped.status).json({ success: false, error: err.mapped.message });
    }
    console.error('[server-error]', cleanUrl, err && err.message ? err.message : err);
    return res.status(502).json({
      success: false,
      error: 'We could not fetch this video right now. Please try again shortly.',
    });
  }
}

/* ---------- API routes ---------- */
app.post('/api/download', apiLimiter, handleDownload);
app.get('/api/download', apiLimiter, handleDownload);

/* ---------- Streaming proxy (preview + forced download) ---------- */
app.get('/api/proxy', proxyLimiter, async (req, res) => {
  let target;
  try {
    target = new URL(String(req.query.url || ''));
  } catch (e) {
    return res.status(400).send('Invalid URL');
  }
  if (target.protocol !== 'https:' || !isAllowedHost(target.hostname)) {
    return res.status(403).send('Host not allowed');
  }

  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  try {
    const headers = { 'User-Agent': USER_AGENT, Referer: 'https://www.instagram.com/' };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = await fetch(target.toString(), { headers, signal: controller.signal, redirect: 'follow' });

    if (upstream.url) {
      let finalHost = '';
      try {
        finalHost = new URL(upstream.url).hostname;
      } catch (e) {
        finalHost = '';
      }
      if (!finalHost || (!isAllowedHost(finalHost) && finalHost !== target.hostname)) {
        controller.abort();
        return res.status(403).send('Redirect host not allowed');
      }
    }

    if (!upstream.ok && upstream.status !== 206) {
      return res
        .status(upstream.status === 403 || upstream.status === 410 ? 410 : 502)
        .send('The media link has expired. Please fetch the video again.');
    }

    res.status(upstream.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'].forEach((h) => {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    });
    if (!upstream.headers.get('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=300');

    if (req.query.download === '1') {
      const name = sanitizeFilename(req.query.filename);
      res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    }

    if (!upstream.body) return res.end();
    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    console.error('[proxy-error]', err.message);
    if (!res.headersSent) res.status(502).send('Could not fetch the media.');
    else res.destroy();
  }
});

/* ---------- SEO helper routes ---------- */
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    ['User-agent: *', 'Allow: /', 'Disallow: /api/', '', 'Sitemap: ' + SITE_URL + '/sitemap.xml', ''].join('\n')
  );
});

app.get('/sitemap.xml', (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  res.type('application/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      '  <url>\n' +
      '    <loc>' + SITE_URL + '/</loc>\n' +
      '    <lastmod>' + today + '</lastmod>\n' +
      '    <changefreq>weekly</changefreq>\n' +
      '    <priority>1.0</priority>\n' +
      '  </url>\n' +
      '</urlset>\n'
  );
});

app.get('/og-image.svg', (req, res) => {
  res.type('image/svg+xml').send(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e91e63"/><stop offset="1" stop-color="#c2185b"/></linearGradient></defs>' +
      '<rect width="1200" height="630" fill="url(#g)"/>' +
      '<circle cx="1020" cy="120" r="180" fill="#fff" opacity=".08"/>' +
      '<circle cx="140" cy="560" r="220" fill="#fff" opacity=".08"/>' +
      '<rect x="90" y="215" width="200" height="200" rx="52" fill="#fff"/>' +
      '<path d="M165 270v90l75-45z" fill="#e91e63"/>' +
      '<text x="330" y="290" font-family="Arial, Helvetica, sans-serif" font-size="80" font-weight="800" fill="#fff">ReelSaver</text>' +
      '<text x="330" y="365" font-family="Arial, Helvetica, sans-serif" font-size="42" fill="#fff" opacity=".92">Instagram Video &amp; Reel Downloader</text>' +
      '<text x="330" y="425" font-family="Arial, Helvetica, sans-serif" font-size="30" fill="#fff" opacity=".8">Free · HD MP4 · No Login</text>' +
      '</svg>'
  );
});

app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

/* ---------- Frontend ---------- */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use('/api', (req, res) => res.status(404).json({ success: false, error: 'Endpoint not found.' }));

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[server-error]', err.message);
  if (res.headersSent) return next(err);
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Invalid request body.' });
  }
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

const server = app.listen(PORT, () => {
  console.log('ReelSaver running on port ' + PORT);
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
