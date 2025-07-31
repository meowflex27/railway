import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
const PORT = 3000;
const TMDB_API_KEY = 'ea97a714a43a0e3481592c37d2c7178a';

app.use(cors());

// Retry helper
async function axiosGetWithRetry(url, options = {}, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await axios.get(url, options);
    } catch (err) {
      const status = err.response?.status;
      if (status === 403 && attempt < retries - 1) {
        const delay = 1000 * 2 ** attempt;
        console.warn(`⚠️ 403 Forbidden from ${url}, retrying in ${delay}ms (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }
}

// Extract subjectId from HTML
function extractSubjectId(html, title) {
  const regex = new RegExp(`"(\\d{16,})",\\s*"[^"]*",\\s*"${title.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}"`, 'i');
  const match = html.match(regex);
  return match ? match[1] : null;
}

// Extract detail path from HTML
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

// === MOVIE ROUTE ===
app.get('/movie/:tmdbId', async (req, res) => {
  const { tmdbId } = req.params;

  try {
    const tmdbResp = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}`);
    const title = tmdbResp.data.title;
    const year = tmdbResp.data.release_date?.split('-')[0];

    const searchKeyword = `${title} ${year}`;
    const searchUrl = `https://moviebox.ph/web/searchResult?keyword=${encodeURIComponent(searchKeyword)}`;
    const searchResp = await axiosGetWithRetry(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });

    const html = searchResp.data;
    const subjectId = extractSubjectId(html, title);
    if (!subjectId) return res.status(404).json({ error: '❌ subjectId not found in HTML' });

    const detailPath = extractDetailPathFromHtml(html, subjectId, title);
    const detailsUrl = detailPath ? `https://moviebox.ph/movies/${detailPath}?id=${subjectId}` : null;

    const downloadUrl = `https://moviebox.ph/wefeed-h5-bff/web/subject/download?subjectId=${subjectId}&se=0&ep=0`;
    const downloadResp = await axiosGetWithRetry(downloadUrl, {
      headers: {
        'accept': 'application/json',
        'referer': detailsUrl,
        'user-agent': 'Mozilla/5.0',
        'x-client-info': JSON.stringify({ timezone: 'Africa/Lagos' }),
        'x-source': 'h5',
      }
    });

    res.json({
      type: 'movie',
      title,
      year,
      subjectId,
      detailPath: detailPath || '❌ Not found',
      detailsUrl: detailsUrl || '❌ Not available',
      downloadData: downloadResp.data
    });

  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// === TV SHOW ROUTE (default episode 0x0) ===
app.get('/tv/:tmdbId', async (req, res) => {
  const { tmdbId } = req.params;

  try {
    const tmdbResp = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`);
    const title = tmdbResp.data.name;
    const year = tmdbResp.data.first_air_date?.split('-')[0];

    const searchKeyword = `${title} ${year}`;
    const searchUrl = `https://moviebox.ph/web/searchResult?keyword=${encodeURIComponent(searchKeyword)}`;
    const searchResp = await axiosGetWithRetry(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });

    const html = searchResp.data;
    const subjectId = extractSubjectId(html, title);
    if (!subjectId) return res.status(404).json({ error: '❌ subjectId not found in HTML' });

    const detailPath = extractDetailPathFromHtml(html, subjectId, title);
    const detailsUrl = detailPath ? `https://moviebox.ph/movies/${detailPath}?id=${subjectId}` : null;

    const downloadUrl = `https://moviebox.ph/wefeed-h5-bff/web/subject/download?subjectId=${subjectId}&se=0&ep=0`;
    const downloadResp = await axiosGetWithRetry(downloadUrl, {
      headers: {
        'accept': 'application/json',
        'referer': detailsUrl,
        'user-agent': 'Mozilla/5.0',
        'x-client-info': JSON.stringify({ timezone: 'Africa/Lagos' }),
        'x-source': 'h5',
      }
    });

    res.json({
      type: 'tv',
      title,
      year,
      subjectId,
      detailPath: detailPath || '❌ Not found',
      detailsUrl: detailsUrl || '❌ Not available',
      downloadData: downloadResp.data
    });

  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// === TV SHOW EPISODE ROUTE ===
app.get('/tv/:tmdbId/:season/:episode', async (req, res) => {
  const { tmdbId, season, episode } = req.params;

  try {
    const tmdbResp = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`);
    const title = tmdbResp.data.name;
    const year = tmdbResp.data.first_air_date?.split('-')[0];

    const searchKeyword = `${title} ${year}`;
    const searchUrl = `https://moviebox.ph/web/searchResult?keyword=${encodeURIComponent(searchKeyword)}`;
    const searchResp = await axiosGetWithRetry(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });

    const html = searchResp.data;
    const subjectId = extractSubjectId(html, title);
    if (!subjectId) return res.status(404).json({ error: '❌ subjectId not found in HTML' });

    const detailPath = extractDetailPathFromHtml(html, subjectId, title);
    const detailsUrl = detailPath ? `https://moviebox.ph/movies/${detailPath}?id=${subjectId}` : null;

    const downloadUrl = `https://moviebox.ph/wefeed-h5-bff/web/subject/download?subjectId=${subjectId}&se=${season}&ep=${episode}`;
    const downloadResp = await axiosGetWithRetry(downloadUrl, {
      headers: {
        'accept': 'application/json',
        'referer': detailsUrl,
        'user-agent': 'Mozilla/5.0',
        'x-client-info': JSON.stringify({ timezone: 'Africa/Lagos' }),
        'x-source': 'h5',
      }
    });

    res.json({
      type: 'tv',
      title,
      year,
      subjectId,
      detailPath: detailPath || '❌ Not found',
      detailsUrl: detailsUrl || '❌ Not available',
      downloadData: downloadResp.data
    });

  } catch (err) {
    console.error('❌ Server error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
