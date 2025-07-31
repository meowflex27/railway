import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
const PORT = 3000;
const TMDB_API_KEY = 'ea97a714a43a0e3481592c37d2c7178a';
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

app.use(cors());

const subjectCache = new Map();

function setCache(key, value) {
  subjectCache.set(key, { data: value, expires: Date.now() + CACHE_TTL });
}

function getCache(key) {
  const cached = subjectCache.get(key);
  if (!cached || cached.expires < Date.now()) {
    subjectCache.delete(key);
    return null;
  }
  return cached.data;
}

// Retry helper with capped exponential backoff
async function axiosGetWithRetry(url, options = {}, retries = 4, timeout = 5000) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await axios.get(url, { ...options, timeout });
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = status === 403 || status === 429 || !status;
      if (isRetryable && attempt < retries - 1) {
        const delay = Math.min(3000, 500 * 2 ** attempt);
        console.warn(`⚠️ ${status || 'Timeout'} from ${url}, retrying in ${delay}ms (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

function extractSubjectId(html, title) {
  const regex = new RegExp(`"(\\d{16,})",\\s*"[^"]*",\\s*"${title.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}"`, 'i');
  const match = html.match(regex);
  return match ? match[1] : null;
}

function extractDetailPathFromHtml(html, subjectId, title) {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') + '-';

  const idPattern = new RegExp(`"(${subjectId})"`);
  const idMatch = idPattern.exec(html);
  if (!idMatch) return null;

  const before = html.substring(0, idMatch.index);
  const detailPathRegex = new RegExp(`"((?:${slug})[^"]+)"`, 'gi');
  let match, lastMatch = null;
  while ((match = detailPathRegex.exec(before)) !== null) {
    lastMatch = match[1];
  }

  return lastMatch || null;
}

function getCommonHeaders(detailsUrl) {
  return {
    'accept': 'application/json',
    'referer': detailsUrl || 'https://moviebox.ph/',
    'origin': 'https://moviebox.ph',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
    'x-client-info': JSON.stringify({ timezone: 'Asia/Manila' }),
    'x-source': 'h5',
    'accept-language': 'en-US,en;q=0.9'
  };
}

// === SHARED ROUTE LOGIC ===
async function handleMovieboxFetch(tmdbId, isTV = false, season = 0, episode = 0) {
  const cacheKey = `${tmdbId}-${season}-${episode}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const tmdbUrl = `https://api.themoviedb.org/3/${isTV ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  const tmdbResp = await axios.get(tmdbUrl);
  const title = isTV ? tmdbResp.data.name : tmdbResp.data.title;
  const year = (isTV ? tmdbResp.data.first_air_date : tmdbResp.data.release_date)?.split('-')[0];

  const searchKeyword = `${title} ${year}`;
  const searchUrl = `https://moviebox.ph/web/searchResult?keyword=${encodeURIComponent(searchKeyword)}`;
  const searchResp = await axiosGetWithRetry(searchUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    timeout: 5000
  });

  const html = searchResp.data;
  const subjectId = extractSubjectId(html, title);
  if (!subjectId) throw new Error('❌ subjectId not found in HTML');

  const detailPath = extractDetailPathFromHtml(html, subjectId, title);
  const detailsUrl = detailPath ? `https://moviebox.ph/movies/${detailPath}?id=${subjectId}` : null;

  const downloadUrl = `https://moviebox.ph/wefeed-h5-bff/web/subject/download?subjectId=${subjectId}&se=${season}&ep=${episode}`;
  const downloadResp = await axiosGetWithRetry(downloadUrl, {
    headers: getCommonHeaders(detailsUrl),
    timeout: 4000
  });

  const result = {
    type: isTV ? 'tv' : 'movie',
    title,
    year,
    subjectId,
    detailPath: detailPath || '❌ Not found',
    detailsUrl: detailsUrl || '❌ Not available',
    downloadData: downloadResp.data
  };

  setCache(cacheKey, result);
  return result;
}

// === MOVIE ROUTE ===
app.get('/movie/:tmdbId', async (req, res) => {
  const { tmdbId } = req.params;
  const start = Date.now();

  try {
    const result = await handleMovieboxFetch(tmdbId, false, 0, 0);
    console.log(`⏱️ /movie/${tmdbId} responded in ${Date.now() - start}ms`);
    res.json(result);
  } catch (err) {
    console.error('❌ Movie fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// === TV SHOW ROUTE ===
app.get('/tv/:tmdbId', async (req, res) => {
  const { tmdbId } = req.params;
  const start = Date.now();

  try {
    const result = await handleMovieboxFetch(tmdbId, true, 0, 0);
    console.log(`⏱️ /tv/${tmdbId} responded in ${Date.now() - start}ms`);
    res.json(result);
  } catch (err) {
    console.error('❌ TV show fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// === TV EPISODE ROUTE ===
app.get('/tv/:tmdbId/:season/:episode', async (req, res) => {
  const { tmdbId, season, episode } = req.params;
  const start = Date.now();

  try {
    const result = await handleMovieboxFetch(tmdbId, true, season, episode);
    console.log(`⏱️ /tv/${tmdbId}/${season}/${episode} responded in ${Date.now() - start}ms`);
    res.json(result);
  } catch (err) {
    console.error('❌ TV episode fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
