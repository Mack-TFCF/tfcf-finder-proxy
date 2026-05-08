// TFCF Property Lookup Proxy
// Deploy to Vercel. Set ANTHROPIC_API_KEY in Vercel environment variables.
//
// Targets:
//   cams      — LA County CAMS geocoder (parcel-level accuracy)
//   census    — US Census geocoder (fallback)
//   lacounty  — LA County AGOL FeatureServer (countywide parcels incl. City of LA)
//   claude    — Anthropic API (AI narratives — key never exposed to browser)

export default async function handler(req, res) {

  // ── CORS ──
  // Only allow known origins. Unknown origins get 403, not wildcard.
  const allowedOrigins = [
    'https://www.foothillcatalog.org',
    'https://foothillcatalog.org',
    'https://stingray-chameleon-tcpt.squarespace.com',
    'http://localhost:3000',
    'http://localhost:8080',
  ];

  const origin = req.headers.origin || '';
  if (origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({ error: 'Origin not allowed' });
  }
  const corsOrigin = origin || allowedOrigins[0];

  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Honor Cache-Control: no-cache from client — bypass edge cache
  const noCache = req.headers['cache-control'] === 'no-cache';
  const cacheHeader = noCache
    ? 'no-store'
    : 's-maxage=3600, stale-while-revalidate=86400';

  const target = req.method === 'POST'
    ? (req.body?.target || '')
    : (req.query?.target || '');

  const ALLOWED_TARGETS = ['census', 'cams', 'lacounty', 'claude'];
  if (!target || !ALLOWED_TARGETS.includes(target)) {
    return res.status(400).json({ error: 'Invalid target' });
  }

  // ── Helpers ──

  // Sanitize user input before interpolating into ArcGIS WHERE clauses
  function sanitizeForSQL(str) {
    if (!str || typeof str !== 'string') return '';
    return str
      .replace(/'/g, '')       // remove single quotes (SQL injection)
      .replace(/;/g, '')       // remove semicolons
      .replace(/--/g, '')      // remove SQL comment syntax
      .slice(0, 200);          // hard length cap
  }

  async function fetchOne(url, options = {}) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 12000);
    try {
      const r = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          'User-Agent': 'TFCF-PropertyFinder/1.0',
          ...(options.headers || {}),
        },
      });
      clearTimeout(tid);
      if (!r.ok) return null;
      return await r.json();
    } catch(e) {
      clearTimeout(tid);
      return null;
    }
  }

  // ── CAMS geocoder ──
  if (target === 'cams') {
    const { address } = req.query;
    if (!address || address.length > 200) return res.status(400).json({ error: 'Missing or invalid address' });
    const url = `https://geocode.gis.lacounty.gov/geocode/rest/services/CAMS_Locator/GeocodeServer/findAddressCandidates?SingleLine=${encodeURIComponent(address)}&outFields=Loc_name,Score,Match_addr&maxLocations=1&outSR=4326&f=json`;
    const data = await fetchOne(url);
    if (!data) return res.status(502).json({ error: 'CAMS geocoder unavailable' });
    res.setHeader('Cache-Control', cacheHeader);
    return res.status(200).json(data);
  }

  // ── Census geocoder ──
  if (target === 'census') {
    const { address } = req.query;
    if (!address || address.length > 200) return res.status(400).json({ error: 'Missing or invalid address' });
    const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
    const data = await fetchOne(url);
    if (!data) return res.status(502).json({ error: 'Census geocoder unavailable' });
    res.setHeader('Cache-Control', cacheHeader);
    return res.status(200).json(data);
  }

  // ── LA County parcel lookup ──
  if (target === 'lacounty') {
    const { lat, lng, address } = req.query;

    const AGOL_FS = 'https://services3.arcgis.com/GVgbJbqm8hXASVYi/arcgis/rest/services/LA_County_Parcels/FeatureServer/0';
    const agolFields = 'AIN,SitusFullAddress,SitusCity,SitusZIP,YearBuilt1,SQFTmain1,Bedrooms1,Bathrooms1,Units1,UseType,UseCode,Roll_LandBaseYear,Roll_ImpBaseYear,CENTER_LAT,CENTER_LON,Shape__Area,Shape__Length';

    // Strategy 1: WHERE clause by address — most reliable for fire lots
    if (address) {
      const raw = address.toUpperCase()
        .replace(/,.*$/, '')
        .replace(/\s+(APT|UNIT|STE|#)\s*\S+/i, '')
        .trim();
      const situsAddr = sanitizeForSQL(raw);

      const cityMatch = address.match(/,\s*([^,]+),\s*CA/i);
      const city = cityMatch ? sanitizeForSQL(cityMatch[1].trim().toUpperCase()) : null;

      const whereClause = city
        ? `SitusFullAddress LIKE '${situsAddr}%' AND SitusCity LIKE '${city}%'`
        : `SitusFullAddress LIKE '${situsAddr}%'`;

      const url = `${AGOL_FS}/query?where=${encodeURIComponent(whereClause)}&outFields=${agolFields}&returnGeometry=true&outSR=4326&resultRecordCount=6&f=json`;
      const data = await fetchOne(url);
      if (data?.features?.length > 0) {
        res.setHeader('Cache-Control', cacheHeader);
        return res.status(200).json(data);
      }

      const stripped = sanitizeForSQL(situsAddr.replace(/^(\d+)\s+[NSEW]\s+/, '$1 '));
      if (stripped !== situsAddr) {
        const whereStripped = city
          ? `SitusFullAddress LIKE '${stripped}%' AND SitusCity LIKE '${city}%'`
          : `SitusFullAddress LIKE '${stripped}%'`;
        const url2 = `${AGOL_FS}/query?where=${encodeURIComponent(whereStripped)}&outFields=${agolFields}&returnGeometry=true&outSR=4326&resultRecordCount=6&f=json`;
        const data2 = await fetchOne(url2);
        if (data2?.features?.length > 0) {
          res.setHeader('Cache-Control', cacheHeader);
          return res.status(200).json(data2);
        }
      }
    }

    // Strategy 2: Spatial query by coordinates
    if (lat && lng) {
      const safeLat = parseFloat(lat);
      const safeLng = parseFloat(lng);
      if (isNaN(safeLat) || isNaN(safeLng)) return res.status(400).json({ error: 'Invalid coordinates' });
      const url = `${AGOL_FS}/query?geometry=${safeLng},${safeLat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=${agolFields}&returnGeometry=true&outSR=4326&f=json`;
      const data = await fetchOne(url);
      if (data?.features?.length > 0) {
        res.setHeader('Cache-Control', cacheHeader);
        return res.status(200).json(data);
      }
    }

    return res.status(200).json({ features: [] });
  }

  // ── Claude API — key lives only on the server, never sent to browser ──
  if (target === 'claude') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'AI narratives not configured' });

    const { prompt, max_tokens = 200 } = req.body || {};
    if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Missing prompt' });
    if (prompt.length > 2000) return res.status(400).json({ error: 'Prompt too long' });

    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 20000);

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001', // fast + cheap for short narratives
          max_tokens,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      clearTimeout(tid);
      if (!r.ok) return res.status(502).json({ error: 'Claude API error' });
      const data = await r.json();
      return res.status(200).json({ text: data.content?.[0]?.text || '' });
    } catch(e) {
      clearTimeout(tid);
      return res.status(504).json({ error: 'Claude API timed out' });
    }
  }
}
