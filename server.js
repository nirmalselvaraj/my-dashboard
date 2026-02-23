import express  from 'express';
import axios    from 'axios';
import Parser   from 'rss-parser';
import Redis    from 'ioredis';
import path     from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app    = express();
const parser = new Parser({ timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
const PORT   = process.env.PORT || 3000;

/* ── Redis ─────────────────────────────────────────────────────────────── */
const redis = new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: true });
redis.on('error', err => console.error('[redis]', err.message));
await redis.connect().catch(() => console.warn('[redis] could not connect — running without cache'));

const CACHE_TTL = 300; // 5 minutes in seconds

async function cacheGet(key) {
  try { const v = await redis.get(key); return v ? JSON.parse(v) : null; }
  catch { return null; }
}

async function cacheSet(key, value) {
  try { await redis.set(key, JSON.stringify(value), 'EX', CACHE_TTL); }
  catch { /* ignore */ }
}

/* ── static files ─────────────────────────────────────────────────────── */
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

/* ═══════════════════════════════════════════════════════════════════════
   WEATHER  —  wttr.in  (cached per lat/lon)
   ═══════════════════════════════════════════════════════════════════════ */
async function fetchWeatherData(lat, lon) {
  const [current, forecast] = await Promise.all([
    axios.get(`https://wttr.in/${encodeURIComponent(lat)},${encodeURIComponent(lon)}?format=j1`, {
      timeout: 10000,
      headers: { 'User-Agent': 'curl/7.68.0', Accept: 'application/json' }
    }),
    axios.get('https://api.open-meteo.com/v1/forecast', {
      timeout: 10000,
      params: {
        latitude: lat, longitude: lon,
        daily: 'temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max,windspeed_10m_max',
        temperature_unit: 'fahrenheit',
        wind_speed_unit: 'mph',
        forecast_days: 7,
        timezone: 'auto'
      }
    })
  ]);
  return { current: current.data, forecast: forecast.data.daily };
}

app.get('/api/weather', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ success: false, error: 'lat and lon are required' });

  const cacheKey = `weather:${parseFloat(lat).toFixed(2)}:${parseFloat(lon).toFixed(2)}`;

  try {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      console.log('[weather] cache HIT');
      return res.json({ success: true, data: cached, cached: true });
    }

    console.log('[weather] cache MISS — fetching');
    const data = await fetchWeatherData(lat, lon);
    await cacheSet(cacheKey, data);
    res.json({ success: true, data, cached: false });
  } catch (err) {
    console.error('[weather]', err.message);
    res.status(502).json({ success: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   STOCKS  —  Stooq (equities) + CoinGecko (crypto)  (cached globally)
   ═══════════════════════════════════════════════════════════════════════ */
const EQUITIES = [
  { symbol: 'NVDA',  stooq: 'nvda.us',  name: 'Nvidia' },
  { symbol: 'MSFT',  stooq: 'msft.us',  name: 'Microsoft' },
  { symbol: 'GOOGL', stooq: 'googl.us', name: 'Alphabet (Google)' },
  { symbol: 'WDC',   stooq: 'wdc.us',   name: 'Western Digital / SanDisk' },
  { symbol: 'CHYM',  stooq: 'chym.us',  name: 'Chime Financial' },
];

async function fetchStooqQuote(ticker, name) {
  const today = new Date();
  const d2 = today.toISOString().slice(0, 10).replace(/-/g, '');
  const past = new Date(today); past.setDate(today.getDate() - 7);
  const d1 = past.toISOString().slice(0, 10).replace(/-/g, '');

  const url = `https://stooq.com/q/d/l/?s=${ticker}&i=d&d1=${d1}&d2=${d2}`;
  const { data } = await axios.get(url, { timeout: 10000 });

  const lines = data.trim().split('\n').filter(l => l && !l.startsWith('Date'));
  if (lines.length < 2) throw new Error(`No data for ${ticker}`);

  const parse = line => {
    const [, , , , close] = line.split(',');
    return parseFloat(close);
  };

  const closes = lines.map(parse);
  const price  = closes[closes.length - 1];
  const prev   = closes[closes.length - 2];
  const change = price - prev;
  const pct    = (change / prev) * 100;

  return { symbol: ticker.toUpperCase().replace('.US', ''), shortName: name, price, change, changePercent: pct, previousClose: prev, currency: 'USD' };
}

async function fetchCryptoData() {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true';
  const { data } = await axios.get(url, { timeout: 10000 });
  return [
    { symbol: 'BTC-USD', shortName: 'Bitcoin',  price: data.bitcoin.usd,  change: null, changePercent: data.bitcoin.usd_24h_change,  previousClose: null, currency: 'USD' },
    { symbol: 'ETH-USD', shortName: 'Ethereum', price: data.ethereum.usd, change: null, changePercent: data.ethereum.usd_24h_change, previousClose: null, currency: 'USD' },
  ];
}

async function fetchAllStocks() {
  const [equityResults, cryptoResult] = await Promise.allSettled([
    Promise.allSettled(EQUITIES.map(e => fetchStooqQuote(e.stooq, e.name))),
    fetchCryptoData()
  ]);

  const equities = equityResults.status === 'fulfilled'
    ? equityResults.value.filter(r => r.status === 'fulfilled').map(r => r.value)
    : [];
  const cryptos = cryptoResult.status === 'fulfilled' ? cryptoResult.value : [];
  return [...equities, ...cryptos];
}

app.get('/api/stocks', async (req, res) => {
  const cacheKey = 'stocks:all';
  try {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      console.log('[stocks] cache HIT');
      return res.json({ success: true, data: cached, private: [], cached: true });
    }

    console.log('[stocks] cache MISS — fetching');
    const stocks = await fetchAllStocks();
    await cacheSet(cacheKey, stocks);
    res.json({ success: true, data: stocks, private: [], cached: false });
  } catch (err) {
    console.error('[stocks]', err.message);
    res.status(502).json({ success: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   NEWS  —  RSS feeds  (no cache — fast enough, content changes often)
   ═══════════════════════════════════════════════════════════════════════ */
const FEEDS = {
  techcrunch: 'https://techcrunch.com/feed/',
  ai:         'https://venturebeat.com/category/ai/feed/'
};

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

async function parseFeed(url, limit = 3) {
  const feed = await parser.parseURL(url);
  return feed.items.slice(0, limit).map(item => ({
    title:       item.title || '',
    link:        item.link  || item.guid || '',
    pubDate:     item.pubDate || item.isoDate || '',
    contentSnip: stripHtml(item.contentSnippet || item.content || '').slice(0, 160)
  }));
}

app.get('/api/news', async (req, res) => {
  try {
    const [tcResult, aiResult] = await Promise.allSettled([
      parseFeed(FEEDS.techcrunch),
      parseFeed(FEEDS.ai)
    ]);
    res.json({
      success:    true,
      techcrunch: tcResult.status === 'fulfilled' ? tcResult.value : [],
      ai:         aiResult.status === 'fulfilled'  ? aiResult.value  : [],
      errors: {
        techcrunch: tcResult.status === 'rejected' ? tcResult.reason?.message : null,
        ai:         aiResult.status === 'rejected' ? aiResult.reason?.message  : null
      }
    });
  } catch (err) {
    console.error('[news]', err.message);
    res.status(502).json({ success: false, error: err.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
   BACKGROUND REFRESHER  —  pre-warms the cache every 5 minutes so
   users never wait for a cold fetch
   ═══════════════════════════════════════════════════════════════════════ */
async function warmStocksCache() {
  try {
    console.log('[cache] refreshing stocks…');
    const stocks = await fetchAllStocks();
    await cacheSet('stocks:all', stocks);
    console.log('[cache] stocks refreshed ✓');
  } catch (err) {
    console.error('[cache] stocks refresh failed:', err.message);
  }
}

// Warm immediately on startup, then every 5 minutes
warmStocksCache();
setInterval(warmStocksCache, CACHE_TTL * 1000);

/* ── boot ─────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`Dashboard running → http://localhost:${PORT}`);
});
