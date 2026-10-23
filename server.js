'use strict';

const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const path = require('path');

const PORT = process.env.PORT || 3000;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || 'a3b126029bmshfb86807dc38830dp1a8c53jsncf074cc292fc';
const RAPIDAPI_HOST = process.env.RAPIDAPI_HOST || 'instagram-downloader-download-instagram-videos-stories1.p.rapidapi.com';

const app = express();
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10kb' }));

// Rate limiter
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { success: false, error: 'Too many requests. Please try again in a few minutes.' }
});

/* ---------- Main API Endpoint ---------- */
app.post('/api/download', apiLimiter, async (req, res) => {
  const { url } = req.body;

  if (!url || !url.includes('instagram.com')) {
    return res.status(400).json({
      success: false,
      error: 'Please enter a valid Instagram Reel or Video URL.'
    });
  }

  try {
    const apiUrl = `https://${RAPIDAPI_HOST}/index?url=${encodeURIComponent(url)}`;
    
    const apiRes = await fetch(apiUrl, {
      method: 'GET',
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': RAPIDAPI_HOST
      }
    });

    if (!apiRes.ok) {
      throw new Error(`API responded with status ${apiRes.status}`);
    }

    const data = await apiRes.json();

    // Extracting download links flexibly based on RapidAPI response structure
    let downloadUrl = null;
    let isVideo = true;
    let title = 'Instagram Reel Video';
    let thumbnail = '';

    if (Array.isArray(data) && data.length > 0) {
      downloadUrl = data[0].media || data[0].url || data[0].download_url;
      thumbnail = data[0].thumbnail || '';
    } else if (typeof data === 'object' && data !== null) {
      downloadUrl = data.media || data.url || data.download_url || (data.result && data.result[0]?.url);
      thumbnail = data.thumbnail || data.cover || '';
      if (data.title) title = data.title;
      if (data.type === 'image' || (downloadUrl && downloadUrl.includes('.jpg'))) isVideo = false;
    }

    if (!downloadUrl) {
      return res.status(404).json({
        success: false,
        error: 'Unable to extract video link from this post. Make sure the post is public.'
      });
    }

    return res.json({
      success: true,
      downloadUrl: downloadUrl,
      title: title,
      thumbnail: thumbnail,
      isVideo: isVideo
    });

  } catch (err) {
    console.error('[API Error]:', err.message);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch media from Instagram. Please try again later.'
    });
  }
});

/* ---------- Frontend Serving ---------- */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((req, res) => {
  res.redirect('/');
});

app.listen(PORT, () => {
  console.log(`ReelSaver server is active on port ${PORT}`);
});
