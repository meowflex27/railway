import express from 'express';
import axios from 'axios';
import cors from 'cors';
import cheerio from 'cheerio';

const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_API_KEY = 'ea97a714a43a0e3481592c37d2c7178a';
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const subjectCache = new Map();

app.use(cors());

app.get('/api/moviebox', async (req, res) => {
  const { id, type = 'movie' } = req.query;

  if (!id || isNaN(Number(id))) {
    res.status(400).json({ error: 'Invalid or missing TMDB ID' });
    return;
  }

  try {
    const cacheKey = `${type}-${id}`;
    if (subjectCache.has(cacheKey)) {
      const cached = subjectCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        return res.json(cached.data);
      }
    }

    const tmdbRes = await axios.get(`https://api.themoviedb.org/3/${type}/${id}?api_key=${TMDB_API_KEY}&language=en-US`);
    const { title, name, release_date, first_air_date } = tmdbRes.data;
    const year = (release_date || first_air_date || '').split('-')[0];
    const searchTitle = title || name;

    const subjectId = await getSubjectId(searchTitle, year);
    if (!subjectId) {
      return res.json({
        type,
        title: searchTitle,
        year,
        subjectId: null,
        detailPath: '❌ Not found',
        detailsUrl: null,
        hasResource: false,
        downloadData: null
      });
    }

    const html = await fetchMovieboxHTML(subjectId);
    const detailPath = extractDetailPathFromHtml(html, subjectId);

    let downloadData = null;
    let hasResource = false;

    if (detailPath) {
      downloadData = await fetchDownloadData(subjectId);
      hasResource = downloadData?.data?.hasResource || false;
    }

    const data = {
      type,
      title: searchTitle,
      year,
      subjectId,
      detailPath: detailPath || '❌ Not found',
      detailsUrl: detailPath
        ? `https://moviebox.ph/movies/${detailPath}?id=${subjectId}`
        : `https://moviebox.ph/?id=${subjectId}`,
      hasResource,
      downloadData
    };

    subjectCache.set(cacheKey, { data, timestamp: Date.now() });
    res.json(data);

  } catch (err) {
    console.error('Fetch error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 🔎 Moviebox Search Helper
async function getSubjectId(title: string, year?: string): Promise<string | null> {
  const encoded = encodeURIComponent(title);
  const url = `https://moviebox.ph/api/search?keyword=${encoded}`;
  try {
    const res = await axios.get(url);
    const allResults = res.data?.data?.all || [];
    const match = allResults.find((item: any) => {
      return item?.title?.toLowerCase() === title.toLowerCase() &&
        (!year || item?.year?.toString() === year.toString());
    });
    return match?.id || null;
  } catch (e) {
    console.warn('Subject ID lookup failed');
    return null;
  }
}

// 🧠 Extract Detail Path Using cheerio + subjectId
function extractDetailPathFromHtml(html: string, subjectId: string): string | null {
  const $ = cheerio.load(html);
  let foundPath: string | null = null;

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && href.includes('/movies/') && href.includes(subjectId)) {
      const match = href.match(/\/movies\/([^?]+)/);
      if (match && match[1]) {
        foundPath = match[1];
        return false; // break loop
      }
    }
  });

  return foundPath;
}

// 🔽 Fetch HTML page by subjectId
async function fetchMovieboxHTML(subjectId: string): Promise<string> {
  const url = `https://moviebox.ph/?id=${subjectId}`;
  const res = await axios.get(url);
  return res.data;
}

// 📥 Download resource info
async function fetchDownloadData(subjectId: string): Promise<any> {
  const url = `https://moviebox.ph/api/resource/list?subjectId=${subjectId}`;
  const res = await axios.get(url);
  return res.data;
}

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});
