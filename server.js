'use strict';

const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const youtubeDl = require('youtube-dl-exec');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { Readable } = require('stream');

const PORT = process.env.PORT || 3000;
const SITE_URL = (process.env.SITE_URL || 'https://reelsaver.online').replace(/\/+$/, '');
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

/* ---------- Optional Instagram cookies (helps with rate-limits / login walls) ---------- */
let cookiesFile = null;
if (process.env.IG_COOKIES && process.env.IG_COOKIES.trim()) {
  try {
    cookiesFile = path.join(os.tmpdir(), 'ig_cookies.txt');
    fs.writeFileSync(cookiesFile, process.env.IG_COOKIES.replace(/\\n/g, '\n'), { mode: 0o600 });
  } catch (err) {
    console.error('Could not write cookies file:', err.message);
    cookiesFile = null;
  }
}

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

/* ---------- Helpers ---------- */
const ALLOWED_PAGE_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am', 'www.instagr.am']);
const ALLOWED_CDN_SUFFIXES = ['cdninstagram.com', 'fbcdn.net', 'instagram.com'];
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp']);

function normalizeInstagramUrl(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
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
  if (u.searchParams.has('img_index') && /\/p\//.test(p)) clean.searchParams.set('img_index', u.searchParams.get('img_index'));
  return clean.toString();
}

function isAllowedCdnHost(hostname) {
  const h = hostname.toLowerCase();
  return ALLOWED_CDN_SUFFIXES.some((s) => h === s || h.endsWith('.' + s));
}

function sanitizeFilename(name) {
  const cleaned = String(name || 'reelsaver').replace(/[^\w.\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return cleaned || 'reelsaver';
}

function isCombined(f) {
  return (
    f &&
    f.url &&
    f.vcodec &&
    f.vcodec !== 'none' &&
    f.acodec &&
    f.acodec !== 'none' &&
    String(f.protocol || 'https').startsWith('http')
  );
}

function buildItem(entry) {
  const byHeight = new Map();
  (entry.formats || []).filter(isCombined).forEach((f) => {
    const h = f.height || 0;
    const prev = byHeight.get(h);
    if (!prev || (f.tbr || 0) > (prev.tbr || 0)) byHeight.set(h, f);
  });

  let formats = Array.from(byHeight.values())
    .sort((a, b) => (b.height || 0) - (a.height || 0))
    .map((f) => ({
      label: f.height ? f.height + 'p MP4' : 'MP4 Video',
      ext: f.ext || 'mp4',
      height: f.height || 0,
      size: f.filesize || f.filesize_approx || null,
      url: f.url,
    }));

  if (!formats.length && entry.url) {
    const ext = (entry.ext || 'mp4').toLowerCase();
    formats = [
      {
        label: IMAGE_EXTS.has(ext) ? 'Original Image' : entry.height ? entry.height + 'p MP4' : 'MP4 Video',
        ext,
        height: entry.height || 0,
        size: entry.filesize || entry.filesize_approx || null,
        url: entry.url,
      },
    ];
  }

  if (!formats.length && Array.isArray(entry.requested_formats)) {
    const v = entry.requested_formats.find((f) => f && f.url && f.vcodec && f.vcodec !== 'none');
    if (v) {
      formats = [
        {
          label: v.height ? v.height + 'p MP4' : 'MP4 Video',
          ext: v.ext || 'mp4',
          height: v.height || 0,
          size: v.filesize || v.filesize_approx || null,
          url: v.url,
        },
      ];
    }
  }

  if (!formats.length) return null;

  return {
    type: IMAGE_EXTS.has(formats[0].ext) ? 'image' : 'video',
    title: entry.title || null,
    thumbnail: entry.thumbnail || null,
    duration: entry.duration || null,
    formats,
  };
}

function friendlyError(err) {
  const text = String((err && (err.stderr || err.message)) || '').toLowerCase();
  if (text.includes('private') || text.includes('not available') || text.includes('login required') || text.includes('requested content is not available')) {
    return { status: 403, message: 'This post is private, restricted or requires login. Only public posts can be downloaded.' };
  }
  if (text.includes('rate-limit') || text.includes('rate limit') || text.includes('429') || text.includes('too many')) {
    return { status: 429, message: 'Instagram is limiting requests right now. Please try again in a few minutes.' };
  }
  if (text.includes('no video') || text.includes('there is no video')) {
    return { status: 404, message: 'No downloadable video was found in this post.' };
  }
  if (text.includes('404') || text.includes('not found') || text.includes('unable to extract')) {
    return { status: 404, message: 'We could not find this post. Check the link and make sure the post is public.' };
  }
  if (err && (err.timedOut || text.includes('timed out'))) {
    return { status: 504, message: 'Instagram took too long to respond. Please try again.' };
  }
  return { status: 502, message: 'We could not fetch this video right now. Please try again shortly.' };
}

/* ---------- Tiny in-memory cache (CDN links expire, so keep it short) ---------- */
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

/* ---------- API: extract media ---------- */
app.post('/api/download', apiLimiter, async (req, res) => {
  const cleanUrl = normalizeInstagramUrl(req.body && req.body.url);
  if (!cleanUrl) {
    return res.status(400).json({
      success: false,
      error: 'Please enter a valid Instagram Reel, video or post link.',
    });
  }

  const cached = cacheGet(cleanUrl);
  if (cached) return res.json(cached);

  try {
    const flags = {
      dumpSingleJson: true,
      noWarnings: true,
      noCheckCertificates: true,
      addHeader: ['referer:https://www.instagram.com/', 'user-agent:' + USER_AGENT],
    };
    if (cookiesFile) flags.cookies = cookiesFile;

    const info = await youtubeDl(cleanUrl, flags, { timeout: 55000 });

    const entries = Array.isArray(info.entries) && info.entries.length ? info.entries : [info];
    const items = entries.map(buildItem).filter(Boolean);

    if (!items.length) {
      return res.status(404).json({ success: false, error: 'No downloadable video was found in this post.' });
    }

    const payload = {
      success: true,
      id: sanitizeFilename(info.id || 'reelsaver'),
      title: info.title ? String(info.title).slice(0, 160) : 'Instagram video',
      uploader: info.uploader || info.channel || null,
      items,
    };
    cacheSet(cleanUrl, payload);
    return res.json(payload);
  } catch (err) {
    const { status, message } = friendlyError(err);
    console.error('[extract-error]', cleanUrl, String((err && err.stderr) || err.message || err).slice(0, 400));
    return res.status(status).json({ success: false, error: message });
  }
});

/* ---------- API: streaming proxy (preview + forced download) ---------- */
app.get('/api/proxy', proxyLimiter, async (req, res) => {
  let target;
  try {
    target = new URL(String(req.query.url || ''));
  } catch (e) {
    return res.status(400).send('Invalid URL');
  }
  if (target.protocol !== 'https:' || !isAllowedCdnHost(target.hostname)) {
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
      const finalHost = new URL(upstream.url).hostname;
      if (!isAllowedCdnHost(finalHost)) {
        controller.abort();
        return res.status(403).send('Redirect host not allowed');
      }
    }
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(upstream.status === 403 || upstream.status === 410 ? 410 : 502).send('The media link has expired. Please fetch the video again.');
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
  res.status(500).json({ success: false, error: 'Internal server error.' });
});

const server = app.listen(PORT, () => {
  console.log('ReelSaver running on port ' + PORT);
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
