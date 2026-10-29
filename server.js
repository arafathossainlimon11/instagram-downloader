'use strict';

const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { Readable } = require('stream');

const PORT = process.env.PORT || 3000;
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'instagram-downloader-download-instagram-videos-stories1.p.rapidapi.com';

// নতুন API Key
const API_KEYS = [
  '6f56e4c927msh56225b35bb61002p1a3f1djsn537757008651'
];

let activeKeyIndex = 0;

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10kb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { success: false, error: 'Too many requests. Please wait a few minutes and try again.' }
});

function parseRapidApiResponse(data) {
  let items = [];
  let mainTitle = data?.caption || data?.title || 'YouTube Media';

  if (!data) return { items, title: mainTitle };

  let rawList = [];
  if (Array.isArray(data)) {
    rawList = data;
  } else if (Array.isArray(data.items)) {
    rawList = data.items;
  } else if (Array.isArray(data.media)) {
    rawList = data.media;
  } else if (Array.isArray(data.urls)) {
    rawList = data.urls;
  } else if (Array.isArray(data.result)) {
    rawList = data.result;
  } else if (typeof data === 'object') {
    rawList = [data];
  }

  rawList.forEach((entry) => {
    if (!entry) return;
    let url = typeof entry === 'string' ? entry : (entry.download_url || entry.url || entry.media || entry.link);
    let thumbnail = entry.thumbnail_url || entry.thumbnail || entry.cover || entry.picture || data.thumbnail_url || data.thumbnail || '';
    let size = entry.size || entry.filesize || null;
    let type = entry.type || (url && url.includes('.jpg') ? 'image' : 'video');

    if (url) {
      items.push({
        type: type === 'image' ? 'image' : 'video',
        url: url,
        thumbnail: thumbnail,
        size: size,
        title: entry.title || mainTitle
      });
    }
  });

  return { items, title: mainTitle };
}

// নতুন YouTube API Request
async function fetchWithFallback(videoUrl) {
  const apiUrl = `https://${RAPIDAPI_HOST}/youtube/download`;
  let attempts = 0;

  while (attempts < API_KEYS.length) {
    const currentKey = API_KEYS[activeKeyIndex];

    try {
      const apiRes = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-rapidapi-key': currentKey,
          'x-rapidapi-host': RAPIDAPI_HOST
        },
        body: JSON.stringify({
          url: videoUrl,
          format: '1080p'
        })
      });

      if (apiRes.status === 429 || apiRes.status === 403) {
        console.warn(`[Key Switch] Key #${activeKeyIndex + 1} quota exceeded (${apiRes.status}). Switching to next key...`);
        activeKeyIndex = (activeKeyIndex + 1) % API_KEYS.length;
        attempts++;
        continue;
      }

      if (!apiRes.ok) {
        const errBody = await apiRes.text();
        throw new Error(`RapidAPI Error (${apiRes.status}): ${errBody || 'Failed to fetch'}`);
      }

      return await apiRes.json();
    } catch (err) {
      if (attempts === API_KEYS.length - 1) {
        throw err;
      }
      activeKeyIndex = (activeKeyIndex + 1) % API_KEYS.length;
      attempts++;
    }
  }

  throw new Error('All API keys have reached their quota limits.');
}

app.post('/api/download', apiLimiter, async (req, res) => {
  const { url } = req.body;

  if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
    return res.status(400).json({
      success: false,
      error: 'Please enter a valid YouTube link.'
    });
  }

  try {
    const json = await fetchWithFallback(url);
    const { items, title } = parseRapidApiResponse(json);

    if (!items || items.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No downloadable media found. Make sure the YouTube video is available.'
      });
    }

    return res.json({
      success: true,
      title: title,
      items: items
    });

  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(499).json({ success: false, error: 'Request canceled by user.' });
    }
    console.error('[Download-Error]:', err.message);
    return res.status(500).json({
      success: false,
      error: `Server Error: ${err.message || 'Could not fetch YouTube media.'}`
    });
  }
});

app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const filename = req.query.filename || 'instagram_download.mp4';

  if (!targetUrl) return res.status(400).send('URL required');

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    if (!response.ok) return res.status(502).send('Failed to fetch media');

    res.setHeader('Content-Type', response.headers.get('content-type') || 'application/octet-stream');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    }

    const stream = Readable.fromWeb(response.body);
    stream.pipe(res);
  } catch (err) {
    console.error('[Proxy-Error]:', err.message);
    if (!res.headersSent) res.status(502).send('Media streaming error');
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((req, res) => {
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
