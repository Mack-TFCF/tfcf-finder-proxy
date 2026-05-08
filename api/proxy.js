// TFCF Property Lookup Proxy
// Deploy to Vercel — free tier is plenty for this usage.
// This file handles all three external API calls the finder needs:
//   1. Census geocoder   → converts address to lat/lng
//   2. LA County ArcGIS  → parcel data for most Altadena/foothill addresses
//   3. LA City GeoHub    → parcel/zoning data for Palisades addresses

export default async function handler(req, res) {
  // Allow requests from your Squarespace domain and localhost
  const allowedOrigins = [
    'https://www.foothillcatalog.org',
    'https://foothillcatalog.org',
    'https://stingray-chameleon-tcpt.squarespace.com',
    'http://localhost:3000',
    'http://localhost:8080',
  ];

  const origin = req.headers.origin || '';
  const corsOrigin = allowedOrigins.includes(origin)
    ? origin
    : allowedOrigins[0];

  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { target, ...params } = req.query;

  // ── Validate target ──
  const ALLOWED_TARGETS = {
    census: 'https://geocoding.geo.census.gov',
    lacounty: 'https://arcgis.gis.lacounty.gov',
    lacity: 'https://gis.lacity.org',
  };

  if (!target || !ALLOWED_TARGETS[target]) {
    return res.status(400).json({ error: 'Invalid target. Must be: census, lacounty, or lacity' });
  }

  // ── Build upstream URL ──
  let upstreamUrl;
  try {
    if (target === 'census') {
      const address = params.address;
      if (!address) return res.status(400).json({ error: 'Missing address param' });
      upstreamUrl = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
    }

    else if (target === 'lacounty') {
      const { lat, lng } = params;
      if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng params' });
      const fields = [
        'AIN','SitusFullAddress','SitusCityName',
        'YearBuilt','SQFTmain','SQFTlot',
        'Bedrooms','Bathrooms','Units',
        'ZoningCode','AssessedValue',
        'FrontFeetLot','DepthFeetLot',
        'RecordingDate','SalePrice'
      ].join(',');
      upstreamUrl = `https://arcgis.gis.lacounty.gov/arcgis/rest/services/assessor/Assessor_Parcels_Data/MapServer/0/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=${fields}&returnGeometry=false&f=json`;
    }

    else if (target === 'lacity') {
      const { lat, lng } = params;
      if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng params' });
      upstreamUrl = `https://gis.lacity.org/arcgis/rest/services/Map_Services/LADBS_Zoning/MapServer/0/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=APN,ADDRESS,ZONE_CLASS,ZONE_SUMMARY,LOTAREA&returnGeometry=false&f=json`;
    }
  } catch (e) {
    return res.status(400).json({ error: 'Failed to build upstream URL' });
  }

  // ── Fetch from upstream ──
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const upstream = await fetch(upstreamUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'TFCF-PropertyFinder/1.0' },
    });
    clearTimeout(timeout);

    if (!upstream.ok) {
      return res.status(502).json({ error: `Upstream returned ${upstream.status}` });
    }

    const data = await upstream.json();

    // Cache responses for 24h — parcel data doesn't change daily
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');

    return res.status(200).json(data);

  } catch (e) {
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: 'Upstream timed out' });
    }
    return res.status(502).json({ error: 'Upstream fetch failed', detail: e.message });
  }
}
