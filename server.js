import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_API_KEY = 'ea97a714a43a0e3481592c37d2c7178a';
const CACHE_TTL = 10 * 60 * 1000;

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

async function axiosGetWithRetry(url, options = {}, retries = 4, timeout = 5000) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await axios.get(url, { ...options, timeout });
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = status === 403 || status === 429 || !status;
      if (isRetryable && attempt < retries - 1) {
        const delay = Math.min(3000, 500 * 2 ** attempt);
        console.warn(`⚠️ Retry (${attempt + 1}): ${status || 'Timeout'} on ${url} – waiting ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

function extractSubjectId(html, title) {
  const rows = [...html.matchAll(/"(\d{16,})",\s*"[^"]*",\s*"([^"]+)"/g)];
  const cleanedTitle = title.toLowerCase().replace(/[^a-z0-9]/gi, '');

  for (const [, id, candidateTitle] of rows) {
    const cleanedCandidate = candidateTitle.toLowerCase().replace(/[^a-z0-9]/gi, '');
    if (
      cleanedCandidate.includes(cleanedTitle) ||
      cleanedTitle.includes(cleanedCandidate) ||
      cleanedCandidate.startsWith(cleanedTitle.slice(0, 6))
    ) {
      return id;
    }
  }

  return null;
}

function extractDetailPathFromHtml(html, subjectId, title) {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') + '-';

  const idIndex = html.indexOf(`"${subjectId}"`);
  if (idIndex === -1) return null;

  const before = html.substring(0, idIndex);
  const detailPathRegex = new RegExp(`"((?:${slug})[^"]+)"`, 'gi');
  let match, lastMatch = null;
  while ((match = detailPathRegex.exec(before)) !== null) {
    lastMatch = match[1];
  }

  return lastMatch || null;
}

function getCommonHeaders(detailsUrl) {
  return {
    accept: 'application/json',
    referer: detailsUrl || 'https://moviebox.ph/',
    origin: 'https://moviebox.ph',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36',
    'x-client-info': JSON.stringify({ timezone: 'Asia/Manila' }),
    'x-source': 'h5',
    'accept-language': 'en-US,en;q=0.9'
  };
}

async function handleMovieboxFetch(tmdbId, isTV = false, season = 0, episode = 0) {
  const cacheKey = `${tmdbId}-${season}-${episode}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const tmdbUrl = `https://api.themoviedb.org/3/${isTV ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  const { data: tmdbData } = await axios.get(tmdbUrl);

  const title = isTV ? tmdbData.name : tmdbData.title;
  const year = (isTV ? tmdbData.first_air_date : tmdbData.release_date)?.split('-')[0];

  let titleVariants = [title];
  if (!isTV) {
    try {
      const altUrl = `https://api.themoviedb.org/3/movie/${tmdbId}/alternative_titles?api_key=${TMDB_API_KEY}`;
      const { data: altData } = await axios.get(altUrl);
      const altTitles = altData.titles.map(t => t.title);
      titleVariants = [...new Set([title, ...altTitles])];
    } catch {
      console.warn(`⚠️ No alt titles for TMDB ID ${tmdbId}`);
    }
  }

  let subjectId = null;
  let html = '';
  let usedTitle = '';

  for (const variant of titleVariants) {
    const keyword = `${variant} ${year}`;
    const searchUrl = `https://moviebox.ph/web/searchResult?keyword=${encodeURIComponent(keyword)}`;
    const searchResp = await axiosGetWithRetry(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    html = searchResp.data;
    subjectId = extractSubjectId(html, variant);
    if (subjectId) {
      usedTitle = variant;
      break;
    }
  }

  if (!subjectId) throw new Error('❌ subjectId not found');

  const detailPath = extractDetailPathFromHtml(html, subjectId, usedTitle);
  const detailsUrl = detailPath ? `https://moviebox.ph/movies/${detailPath}?id=${subjectId}` : null;

  const downloadUrl = `https://moviebox.ph/wefeed-h5-bff/web/subject/download?subjectId=${subjectId}&se=${season}&ep=${episode}`;
  const downloadResp = await axiosGetWithRetry(downloadUrl, {
    headers: getCommonHeaders(detailsUrl)
  });

  const result = {
    type: isTV ? 'tv' : 'movie',
    title: usedTitle,
    year,
    subjectId,
    detailPath: detailPath || '❌ Not found',
    detailsUrl: detailsUrl || '❌ Not available',
    downloadData: downloadResp.data
  };

  setCache(cacheKey, result);
  return result;
}

// === ROUTES ===

app.get('/movie/:tmdbId', async (req, res) => {
  const start = Date.now();
  try {
    const result = await handleMovieboxFetch(req.params.tmdbId);
    console.log(`⏱️ /movie/${req.params.tmdbId} in ${Date.now() - start}ms`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/tv/:tmdbId', async (req, res) => {
  const start = Date.now();
  try {
    const result = await handleMovieboxFetch(req.params.tmdbId, true);
    console.log(`⏱️ /tv/${req.params.tmdbId} in ${Date.now() - start}ms`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/tv/:tmdbId/:season/:episode', async (req, res) => {
  const { tmdbId, season, episode } = req.params;
  const start = Date.now();
  try {
    const result = await handleMovieboxFetch(tmdbId, true, season, episode);
    console.log(`⏱️ /tv/${tmdbId}/${season}/${episode} in ${Date.now() - start}ms`);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/all-moviebox-movies', async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const url = `https://moviebox.ph/wefeed-h5-bff/web/homepage/recommendSubject?page=${page}&pageSize=100`;

  try {
    const response = await axiosGetWithRetry(url, {
      headers: getCommonHeaders()
    });
    res.json({ page, data: response.data });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch movie list', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running at http://localhost:${PORT}`);
});
