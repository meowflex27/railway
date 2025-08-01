import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_API_KEY = 'ea97a714a43a0e3481592c37d2c7178a';
const CACHE_TTL = 10 * 60 * 1000;

app.use(cors());
const subjectCache = new Map();

function setCache(key: string, value: any) {
  subjectCache.set(key, { data: value, expires: Date.now() + CACHE_TTL });
}

function getCache(key: string) {
  const cached = subjectCache.get(key);
  if (!cached || cached.expires < Date.now()) {
    subjectCache.delete(key);
    return null;
  }
  return cached.data;
}

async function axiosGetWithRetry(url: string, options = {}, retries = 4, timeout = 5000) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await axios.get(url, { ...options, timeout });
    } catch (err: any) {
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

function extractSubjectId(html: string, title: string) {
  const rows = [...html.matchAll(/"(\d{16,})",\s*"[^"]*",\s*"([^"]+)"/g)];
  const cleanedTitle = title.toLowerCase().replace(/[^a-z0-9]/gi, '');

  for (const [, id, candidateTitle] of rows) {
    const cleanedCandidate = candidateTitle.toLowerCase().replace(/[^a-z0-9]/gi, '');
    if (cleanedCandidate.includes(cleanedTitle) || cleanedTitle.includes(cleanedCandidate)) {
      return id;
    }

    let matchCount = 0;
    for (let c of cleanedCandidate) {
      if (cleanedTitle.includes(c)) matchCount++;
    }
    if (matchCount / cleanedCandidate.length >= 0.6) return id;
  }

  return null;
}

function extractDetailPathFromHtml(html: string, subjectId: string, title: string) {
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
  let match: RegExpExecArray | null, lastMatch: string | null = null;
  while ((match = detailPathRegex.exec(before)) !== null) {
    lastMatch = match[1];
  }

  return lastMatch || null;
}

function getCommonHeaders(detailsUrl?: string) {
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

async function getAlternativeTitles(tmdbId: string, isTV: boolean): Promise<string[]> {
  const url = `https://api.themoviedb.org/3/${isTV ? 'tv' : 'movie'}/${tmdbId}/alternative_titles?api_key=${TMDB_API_KEY}`;
  try {
    const resp = await axios.get(url);
    const titles = isTV ? (resp.data.results || []) : (resp.data.titles || []);
    return titles.map((t: any) => t.title || t.name).filter(Boolean);
  } catch (e) {
    console.warn(`⚠️ Failed to fetch alternative titles for ${tmdbId}`);
    return [];
  }
}

async function handleMovieboxFetch(tmdbId: string, isTV = false, season = 0, episode = 0) {
  season = parseInt(season as any);
  episode = parseInt(episode as any);

  const cacheKey = `${tmdbId}-${season}-${episode}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const tmdbUrl = `https://api.themoviedb.org/3/${isTV ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}`;
  const tmdbResp = await axios.get(tmdbUrl);
  const baseTitle = isTV ? tmdbResp.data.name : tmdbResp.data.title;
  const year = (isTV ? tmdbResp.data.first_air_date : tmdbResp.data.release_date)?.split('-')[0];

  const altTitles = await getAlternativeTitles(tmdbId, isTV);
  const allTitles = [baseTitle, ...altTitles];

  let subjectId = null;
  let html = null;
  let usedTitle = baseTitle;
  let detailPath = null;
  let detailsUrl = null;

  for (const title of allTitles) {
    const searchKeyword = `${title} ${year}`;
    const searchUrl = `https://moviebox.ph/web/searchResult?keyword=${encodeURIComponent(searchKeyword)}`;
    const searchResp = await axiosGetWithRetry(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    html = searchResp.data;
    subjectId = extractSubjectId(html, title);
    if (subjectId) {
      usedTitle = title;
      detailPath = extractDetailPathFromHtml(html, subjectId, title);
      detailsUrl = detailPath
        ? `https://moviebox.ph/movies/${detailPath}?id=${subjectId}`
        : `https://moviebox.ph/?id=${subjectId}`;
      break;
    }
  }

  if (!subjectId) throw new Error(`❌ subjectId not found for "${baseTitle}" or alternates`);

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
    hasResource: !!downloadResp.data?.data?.hasResource,
    downloadData: downloadResp.data
  };

  setCache(cacheKey, result);
  return result;
}

// === ROUTES ===

app.get('/movie/:tmdbId', async (req, res) => {
  const start = Date.now();
  try {
    const result = await handleMovieboxFetch(req.params.tmdbId, false, 0, 0);
    console.log(`⏱️ /movie/${req.params.tmdbId} responded in ${Date.now() - start}ms`);
    res.json(result);
  } catch (err: any) {
    console.error(`❌ Error for /movie/${req.params.tmdbId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/tv/:tmdbId', async (req, res) => {
  const start = Date.now();
  try {
    const result = await handleMovieboxFetch(req.params.tmdbId, true, 0, 0);
    console.log(`⏱️ /tv/${req.params.tmdbId} responded in ${Date.now() - start}ms`);
    res.json(result);
  } catch (err: any) {
    console.error(`❌ Error for /tv/${req.params.tmdbId}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/tv/:tmdbId/:season/:episode', async (req, res) => {
  const { tmdbId, season, episode } = req.params;
  const start = Date.now();
  try {
    const result = await handleMovieboxFetch(tmdbId, true, parseInt(season), parseInt(episode));
    console.log(`⏱️ /tv/${tmdbId}/${season}/${episode} responded in ${Date.now() - start}ms`);
    res.json(result);
  } catch (err: any) {
    console.error(`❌ Error for /tv/${tmdbId}/${season}/${episode}:`, err.message);
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
  } catch (err: any) {
    console.error('❌ Error fetching movie list:', err.message);
    res.status(500).json({ error: 'Failed to fetch movie list', details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});
