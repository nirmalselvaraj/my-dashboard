import express  from 'express';
import axios    from 'axios';
import Parser   from 'rss-parser';
import Redis    from 'ioredis';
import path     from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app    = express();
const parser = new Parser({ timeout: 10000, headers: { 'User-Agent': 'Mozilla/5.0' } });
const PORT   = process.env.PORT || 3000;

/* ── Redis ─────────────────────────────────────────────────────────────── */
const redis = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { lazyConnect: true })
  : new Redis({ host: '127.0.0.1', port: 6379, lazyConnect: true });
redis.on('error', err => console.error('[redis]', err.message));
await redis.connect().catch(() => console.warn('[redis] could not connect — running without cache'));

const CACHE_TTL         = 300;   // 5 min — stocks
const WEATHER_DATA_TTL  = 7200;  // 2 hours — keep stale weather data available
const WEATHER_FRESH_TTL = 900;   // 15 min  — how long before we consider it stale

async function cacheGet(key) {
  try { const v = await redis.get(key); return v ? JSON.parse(v) : null; }
  catch { return null; }
}

async function cacheSet(key, value, ttl = CACHE_TTL) {
  try { await redis.set(key, JSON.stringify(value), 'EX', ttl); }
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

// Refreshes weather in the background and updates both Redis keys
async function refreshWeatherInBackground(lat, lon, dataKey, freshKey) {
  try {
    console.log('[weather] background refresh starting…');
    const data = await fetchWeatherData(lat, lon);
    await Promise.all([
      cacheSet(dataKey,  data, WEATHER_DATA_TTL),
      cacheSet(freshKey, 1,    WEATHER_FRESH_TTL),
    ]);
    console.log('[weather] background refresh done ✓');
  } catch (err) {
    console.error('[weather] background refresh failed:', err.message);
  }
}

app.get('/api/weather', async (req, res) => {
  const { lat, lon } = req.query;
  if (!lat || !lon) return res.status(400).json({ success: false, error: 'lat and lon are required' });

  const key   = `${parseFloat(lat).toFixed(2)}:${parseFloat(lon).toFixed(2)}`;
  const dataKey  = `weather:data:${key}`;
  const freshKey = `weather:fresh:${key}`;

  try {
    const [cached, isFresh] = await Promise.all([
      cacheGet(dataKey),
      redis.exists(freshKey).catch(() => 0),
    ]);

    if (cached && isFresh) {
      // Fresh cache — respond instantly
      console.log('[weather] cache HIT (fresh)');
      return res.json({ success: true, data: cached, cached: true });
    }

    if (cached && !isFresh) {
      // Stale cache — respond instantly with old data, refresh in background
      console.log('[weather] cache HIT (stale) — refreshing in background');
      res.json({ success: true, data: cached, cached: true, stale: true });
      refreshWeatherInBackground(lat, lon, dataKey, freshKey); // fire and forget
      return;
    }

    // No cache at all — fetch and wait (first ever request for this location)
    console.log('[weather] cache MISS — fetching');
    const data = await fetchWeatherData(lat, lon);
    await Promise.all([
      cacheSet(dataKey,  data, WEATHER_DATA_TTL),
      cacheSet(freshKey, 1,    WEATHER_FRESH_TTL),
    ]);
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
   GOOGLE PHOTOS  —  OAuth 2.0 + Photos Library API
   ═══════════════════════════════════════════════════════════════════════ */
const PHOTOS_TOKEN_KEY = 'google:photos:tokens';
const PHOTOS_CACHE_KEY = 'photos:items';
const PHOTOS_CACHE_TTL = 3600; // 1 hour
const PHOTOS_SCOPES    = ['https://www.googleapis.com/auth/photoslibrary.readonly'];

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// GET /auth/google — redirect to consent screen
app.get('/auth/google', (req, res) => {
  const oauth2Client = createOAuth2Client();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: PHOTOS_SCOPES,
    prompt: 'consent',
  });
  res.redirect(url);
});

// GET /auth/google/callback — exchange code for tokens
app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');
  try {
    const oauth2Client = createOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    await cacheSet(PHOTOS_TOKEN_KEY, tokens, 365 * 24 * 3600);
    res.send(`<html><body style="background:#030712;color:#f1f5f9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px">
      <div style="font-size:3rem">✓</div>
      <div style="font-size:1.4rem;font-weight:700">Google Photos connected!</div>
      <a href="/" style="color:#06b6d4;text-decoration:none;font-size:.95rem;padding:10px 20px;border:1px solid #06b6d4;border-radius:10px">← Back to dashboard</a>
    </body></html>`);
  } catch (err) {
    console.error('[photos auth]', err.message);
    res.status(500).send('OAuth error: ' + err.message);
  }
});

// GET /api/photos/status — is the user authenticated?
app.get('/api/photos/status', async (req, res) => {
  const tokens = await cacheGet(PHOTOS_TOKEN_KEY);
  res.json({ connected: !!tokens });
});

// GET /api/photos — fetch recent photos (cached 1 hr)
app.get('/api/photos', async (req, res) => {
  try {
    const tokens = await cacheGet(PHOTOS_TOKEN_KEY);
    if (!tokens) return res.status(401).json({ success: false, error: 'not_authenticated' });

    const cached = await cacheGet(PHOTOS_CACHE_KEY);
    if (cached) {
      console.log('[photos] cache HIT');
      return res.json({ success: true, items: cached, cached: true });
    }

    const oauth2Client = createOAuth2Client();
    oauth2Client.setCredentials(tokens);
    const { credentials } = await oauth2Client.refreshAccessToken();
    await cacheSet(PHOTOS_TOKEN_KEY, { ...tokens, ...credentials }, 365 * 24 * 3600);

    const response = await axios.get('https://photoslibrary.googleapis.com/v1/mediaItems', {
      headers: { Authorization: `Bearer ${credentials.access_token}` },
      params: { pageSize: 30 },
      timeout: 15000,
    });

    const items = (response.data.mediaItems || [])
      .filter(item => item.mediaMetadata?.photo)
      .map(item => ({
        id:            item.id,
        baseUrl:       item.baseUrl,
        filename:      item.filename,
        creationTime:  item.mediaMetadata?.creationTime,
        width:         item.mediaMetadata?.width,
        height:        item.mediaMetadata?.height,
      }));

    await cacheSet(PHOTOS_CACHE_KEY, items, PHOTOS_CACHE_TTL);
    console.log(`[photos] fetched ${items.length} photos`);
    res.json({ success: true, items, cached: false });
  } catch (err) {
    console.error('[photos]', err.message);
    if (err.response) {
      console.error('[photos] status:', err.response.status);
      console.error('[photos] body:', JSON.stringify(err.response.data));
    }
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
