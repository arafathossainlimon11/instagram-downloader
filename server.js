'use strict';

const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { Readable } = require('stream');

const PORT = process.env.PORT || 3000;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || '677f6077f6msh81af4e26e4f5359p1e9f7djsna06f2cb6db3b';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'instagram-downloader-download-instagram-videos-stories1.p.rapidapi.com';

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
  let mainTitle = data?.caption || data?.title || 'Instagram Media';

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
    let height = entry.height || entry.quality || 1080;
    let size = entry.size || entry.filesize || null;
    let type = entry.type || (url && url.includes('.jpg') ? 'image' : 'video');

    if (url) {
      items.push({
        type: type === 'image' ? 'image' : 'video',
        url: url,
        thumbnail: thumbnail,
        height: height,
        size: size,
        title: entry.title || mainTitle
      });
    }
  });

  return { items, title: mainTitle };
}

app.post('/api/download', apiLimiter, async (req, res) => {
  const { url } = req.body;

  if (!url || (!url.includes('instagram.com') && !url.includes('instagr.am'))) {
    return res.status(400).json({
      success: false,
      error: 'Please enter a valid Instagram link.'
    });
  }

  try {
    const apiUrl = `https://${RAPIDAPI_HOST}/fetch?url=${encodeURIComponent(url)}`;
    
    const apiRes = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      }
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      console.error(`[RapidAPI-Error] Status: ${apiRes.status}, Body: ${errBody}`);
      return res.status(apiRes.status).json({
        success: false,
        error: `RapidAPI Error (${apiRes.status}): ${errBody || 'Failed to fetch from provider'}`
      });
    }

    const json = await apiRes.json();
    const { items, title } = parseRapidApiResponse(json);

    if (!items || items.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No downloadable media found. Make sure the Instagram post is public.'
      });
    }

    return res.json({
      success: true,
      title: title,
      items: items
    });

  } catch (err) {
    console.error('[Download-Error]:', err.message);
    return res.status(500).json({
      success: false,
      error: `Server Error: ${err.message || 'Could not fetch Instagram video.'}`
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
