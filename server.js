import express from 'express';
import axios from 'axios';
import puppeteer from 'puppeteer';
import cors from 'cors';

const app = express();
const PORT = 3000;
const TMDB_API_KEY = 'ea97a714a43a0e3481592c37d2c7178a';

app.use(cors());

// === Function to extract subjectId from HTML ===
function extractSubjectId(html, movieTitle) {
  const escapedTitle = movieTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`"title":"${escapedTitle}".*?"subjectId":"(\\d+)"`, 'i');
  const match = html.match(regex);
  return match ? match[1] : null;
}

// === /movie/:id Endpoint ===
app.get('/movie/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Step 1: Fetch movie details from TMDB
    const tmdbRes = await axios.get(`https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_API_KEY}`);
    const movie = tmdbRes.data;

    // Step 2: Build movie URL
    const movieSlug = movie.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const movieUrl = `https://moviebox.ph/movies/${movieSlug}-${movie.id}`;

    // Step 3: Use Puppeteer to get HTML
    const browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    await page.goto(movieUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const html = await page.content();
    await browser.close();

    // Step 4: Extract subjectId from HTML
    const subjectId = extractSubjectId(html, movie.title);

    if (!subjectId) {
      return res.status(404).json({ error: 'Subject ID not found.' });
    }

    // Step 5: Return subjectId and details
    return res.json({
      title: movie.title,
      year: movie.release_date?.split('-')[0] || '',
      subjectId,
      detailPath: `${movieSlug}-${subjectId}`,
      detailsUrl: `${movieUrl}?id=${subjectId}`,
    });
  } catch (error) {
    console.error('Error:', error.message);
    return res.status(500).json({ error: 'Server error.' });
  }
});

// === /proxy?url= Endpoint ===
app.get('/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('❌ Missing URL');

  try {
    // Optional: Limit domains to avoid abuse
    const allowedHosts = ['valiw.hakunaymatata.com', 'cacdn.hakunaymatata.com'];
    const parsed = new URL(url);
    if (!allowedHosts.includes(parsed.hostname)) {
      return res.status(403).send('❌ Proxy blocked: Domain not allowed');
    }

    const response = await axios({
      method: 'get',
      url,
      responseType: 'stream',
      headers: {
        'User-Agent': req.get('User-Agent') || '',
        'Referer': req.get('Referer') || ''
      }
    });

    // Pass headers from target
    for (const [key, value] of Object.entries(response.headers)) {
      res.setHeader(key, value);
    }

    response.data.pipe(res);
  } catch (err) {
    console.error('❌ Proxy failed:', err.message);
    res.status(500).send('Proxy failed');
  }
});

// === Start Server ===
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
