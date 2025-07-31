// Install these if you haven't:
// npm install express axios cors redis express-rate-limit

import express from 'express';
import axios from 'axios';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createClient } from 'redis';

const app = express();
const PORT = 3000;
const TMDB_API_KEY = 'ea97a714a43a0e3481592c37d2c7178a';
const CACHE_TTL = 600; // 10 minutes (in seconds for Redis)

// Redis setup
const redisClient = createClient();
redisClient.on('error', err => console.error('❌ Redis Error:', err));
await redisClient.connect();

// Rate limiter middleware (50 reqs per 15 min per IP)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: '🚫 Too many requests from this IP. Try again later.'
});

app.use(cors());
app.use(limiter);

async function getCache(key) {
  const data = await redisClient.get(key);
  return data ? JSON.parse(data) : null;
}

async function setCache(key, value) {
  await redisClient.setEx(key, CACHE_TTL, JSON.stringify(value));
}

async function refreshCacheAsync(key, fetchFn) {
  try {
    const fresh = await fetchFn();
    await setCache(key, fresh);
  } catch (err) {
    console.warn(`⚠️ Failed to refresh cache for ${key}:`, err.message);
  }
}

async function axiosGetWithRetry(url, options = {}, retries = 4, timeout = 5000) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await axios.get(url, { ...options, timeout });
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = status === 403 || status === 429 || !status;
      if (isRetryable && attempt < retries - 1) {
        const delay = Math.min(3000, 500 * 2 ** attempt);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

function extractSubjectId(html, title) {
  const regex = new RegExp(`"(\d{16,})",\s*"[^"]*",\s*"${title.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}"`, 'i');
  const match = html.match(regex);
  return match ? match[1] : null;
}

function extractDetailPathFromHtml(html, subjectId, title) {
  const slug = title.trim().toLowerCase().replace(/['’]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-';
  const idPattern = new RegExp(`"(${subjectId})"`);
  const idMatch = idPattern.exec(html);
  if (!idMatch) return null;
  const before = html.substring(0, idMatch.index);
  const detailPathRegex = new RegExp(`"((?:${slug})[^"]+)"`, 'gi');
  let match, lastMatch = null;
  while ((match = detailPathRegex.exec(before)) !== null) lastMatch = match[1];
  return lastMatch;
}

function getCommonHeaders(detailsUrl) {
  return {
    'accept': 'application/json',
    'referer': detailsUrl || 'https://moviebox.ph/',
    'origin': 'https://moviebox.ph',
    'user-agent': 'Mozilla/5.0',
    'x-client-info': JSON.stringify({ timezone: 'Asia/Manila' }),
    'x-source': 'h5',
    'accept-language': 'en-US,en;q=0.9'
  };
}

async function handleMovieboxFetch(tmdbId, isTV = false, season = 0, episode = 0) {
  const cacheKey = `${tmdbId}-${season}-${episode}`;
  const cached = await getCache(cacheKey);
  if (cached) {
    if (cached._stale) refreshCacheAsync(cacheKey, () => fetchFreshData(tmdbId, isTV, season, episode));
    return cached;
  }
  const fresh = await fetchFreshData(tmdbId, isTV, season, episode);
  await setCache(cacheKey, fresh);
  return fresh;
}

async function fetchFreshData(tmdbId, isTV = false, season = 0, episode = 0) {
  const tmdbUrl = `https://api.themoviedb.org/3/${isTV ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  const tmdbResp = await axios.get(tmdbUrl);
  const title = isTV ? tmdbResp.data.name : tmdbResp.data.title;
  const year = (isTV ? tmdbResp.data.first_air_date : tmdbResp.data.release_date)?.split('-')[0];

  const searchKeyword = `${title} ${year}`;
  const searchUrl = `https://moviebox.ph/web/searchResult?keyword=${encodeURIComponent(searchKeyword)}`;
  const searchResp = await axiosGetWithRetry(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 5000 });
  const html = searchResp.data;
  const subjectId = extractSubjectId(html, title);
  if (!subjectId) throw new Error('❌ subjectId not found');

  const detailPath = extractDetailPathFromHtml(html, subjectId, title);
  const detailsUrl = detailPath ? `https://moviebox.ph/movies/${detailPath}?id=${subjectId}` : null;

  const downloadUrl = `https://moviebox.ph/wefeed-h5-bff/web/subject/download?subjectId=${subjectId}&se=${season}&ep=${episode}`;
  const downloadResp = await axiosGetWithRetry(downloadUrl, { headers: getCommonHeaders(detailsUrl), timeout: 4000 });

  return {
    type: isTV ? 'tv' : 'movie',
    title,
    year,
    subjectId,
    detailPath: detailPath || '❌ Not found',
    detailsUrl: detailsUrl || '❌ Not available',
    downloadData: downloadResp.data
  };
}

app.get('/movie/:tmdbId', async (req, res) => {
  try {
    const result = await handleMovieboxFetch(req.params.tmdbId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/tv/:tmdbId', async (req, res) => {
  try {
    const result = await handleMovieboxFetch(req.params.tmdbId, true);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/tv/:tmdbId/:season/:episode', async (req, res) => {
  const { tmdbId, season, episode } = req.params;
  try {
    const result = await handleMovieboxFetch(tmdbId, true, season, episode);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
