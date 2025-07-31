// proxy.js
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import { createProxyMiddleware } from 'http-proxy-middleware';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('✅ Proxy is running. Ready to stream movies!');
});

app.get('/proxy', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url || !url.startsWith('http')) {
      return res.status(400).json({ error: 'Invalid or missing URL' });
    }

    const response = await axios.get(url, {
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://moviebox.ph',
      }
    });

    res.set(response.headers);
    response.data.pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'Failed to proxy URL', details: err.message });
  }
});

app.use('/stream', createProxyMiddleware({
  target: 'https://valiw.hakunaymatata.com',
  changeOrigin: true,
  pathRewrite: { '^/stream': '' },
}));

app.use('/subtitle', createProxyMiddleware({
  target: 'https://cacdn.hakunaymatata.com',
  changeOrigin: true,
  pathRewrite: { '^/subtitle': '' },
}));

app.listen(PORT, () => {
  console.log(`✅ Proxy server running on port ${PORT}`);
});
