import express from 'express';
import axios from 'axios';
import cors from 'cors';

const app = express();
const PORT = 3000;
const TMDB_API_KEY = 'ea97a714a43a0e3481592c37d2c7178a';

// === 1. Your original subjectId extractor ===
function extractSubjectId(html, movieTitle) {
  const regex = new RegExp(`"(\\d{16,})",\\s*"[^"]*",\\s*"${movieTitle.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')}"`, 'i');
  const match = html.match(regex);
  return match ? match[1] : null;
}

// === 2. Detail path extractor ===
function extractDetailPathFromHtml(html, subjectId, movieTitle) {
  const slug = movieTitle
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') + '-';

  const idPattern = new RegExp(`"(${subjectId})"`);
  const idMatch = idPattern.exec(html);
  if (!idMatch) {
    console.log('❌ subjectId not found in HTML for detailPath extraction');
    return null;
  }

  const before = html.substring(0, idMatch.index);
  const detailPathRegex = new RegExp(`"((?:${slug})[^"]+)"`, 'gi');
  let match, lastMatch = null;
  while ((match = detailPathRegex.exec(before)) !== null) {
    lastMatch = match[1];
  }

  if (lastMatch) {
    console.log('✅ detailPath found:', lastMatch);
    return lastMatch;
  }

  console.log('❌ detailPath not found for subjectId:', subjectId);
  return null;
}

// === MOVIE ROUTE ===
app.get('/movie/:tmdbId', async (req, res) => {
  const { tmdbId } = req.params;

  try {
    console.log('🔎 Fetching TMDb info for:', tmdbId);
    const tmdbResp = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_API_KEY}`);
    const title = tmdbResp.data.title;
    const year = tmdbResp.data.release_date?.split('-')[0];
    console.log('🎬 Title:', title, '| Year:', year);

    const searchKeyword = `${title} ${year}`;
    const searchUrl = `https://moviebox.ph/web/searchResult?keyword=${encodeURIComponent(searchKeyword)}`;
    console.log('🌐 Search URL:', searchUrl);

    const searchResp = await axios.get(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });

    const html = searchResp.data;
    console.log('📄 HTML fetched, length:', html.length);

    const subjectId = extractSubjectId(html, title);
    console.log('🆔 subjectId:', subjectId);
    if (!subjectId) return res.status(404).json({ error: '❌ subjectId not found in HTML' });

    const detailPath = extractDetailPathFromHtml(html, subjectId, title);
    const detailsUrl = detailPath ? `https://moviebox.ph/movies/${detailPath}?id=${subjectId}` : null;
    console.log('📝 detailPath:', detailPath);
    console.log('🔗 detailsUrl:', detailsUrl);

    const downloadUrl = `https://moviebox.ph/wefeed-h5-bff/web/subject/download?subjectId=${subjectId}&se=0&ep=0`;
    const downloadResp = await axios.get(downloadUrl, {
      headers: {
        'accept': 'application/json',
        'referer': detailsUrl,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'x-client-info': JSON.stringify({ timezone: 'Africa/Lagos' }),
        'x-source': 'h5',
        'cookie': [
          '_ga=GA1.1.2113914.1736365446',
          'account=6328836939160473392|0|H5|1744461404|',
          '_ym_uid=1744461405935706898',
          '_ym_d=1744461405',
          'i18n_lang=en',
          '_ga_LF2XQTEPMF=GS2.1.s1751456194$o64$g1$t1751456489$j37$l0$h0'
        ].join('; ')
      }
    });

    console.log('✅ Download data fetched');

    res.json({
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

// === TV SHOW ROUTE ===
app.get('/tv/:tmdbId/:season/:episode', async (req, res) => {
  const { tmdbId, season, episode } = req.params;

  try {
    console.log('🔎 Fetching TMDb TV info for:', tmdbId);
    const tmdbResp = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${TMDB_API_KEY}`);
    const title = tmdbResp.data.name;
    const year = tmdbResp.data.first_air_date?.split('-')[0];
    console.log('📺 Title:', title, '| Year:', year);

    const searchKeyword = `${title} ${year}`;
    const searchUrl = `https://moviebox.ph/web/searchResult?keyword=${encodeURIComponent(searchKeyword)}`;
    const searchResp = await axios.get(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });

    const html = searchResp.data;
    const subjectId = extractSubjectId(html, title);
    if (!subjectId) return res.status(404).json({ error: '❌ subjectId not found in HTML' });

    const detailPath = extractDetailPathFromHtml(html, subjectId, title);
    const detailsUrl = detailPath ? `https://moviebox.ph/movies/${detailPath}?id=${subjectId}` : null;

    const downloadUrl = `https://moviebox.ph/wefeed-h5-bff/web/subject/download?subjectId=${subjectId}&se=${season}&ep=${episode}`;
    const downloadResp = await axios.get(downloadUrl, {
      headers: {
        'accept': 'application/json',
        'referer': detailsUrl,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'x-client-info': JSON.stringify({ timezone: 'Africa/Lagos' }),
        'x-source': 'h5',
        'cookie': [
          '_ga=GA1.1.2113914.1736365446',
          'account=6328836939160473392|0|H5|1744461404|',
          '_ym_uid=1744461405935706898',
          '_ym_d=1744461405',
          'i18n_lang=en',
          '_ga_LF2XQTEPMF=GS2.1.s1751456194$o64$g1$t1751456489$j37$l0$h0'
        ].join('; ')
      }
    });

    console.log('✅ Download data fetched');

    res.json({
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
