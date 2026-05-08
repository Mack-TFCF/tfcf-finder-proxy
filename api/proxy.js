// TFCF Property Lookup Proxy
// Deploy to Vercel — free tier is plenty for this usage.
// 
// Architecture:
//   Step 1 (census target):  US Census geocoder → lat/lng
//   Step 2 (lacounty target): Two strategies:
//     A) CAMS geocoder (LA County's own address system) → precise coords
//        + Identify on tiled parcel cache → parcel attributes
//     B) WHERE clause on ArcGIS Online LA County parcel FeatureServer
//   Step 3 (lacity target):  LA City GeoHub zoning layer

export default async function handler(req, res) {
  const allowedOrigins = [
    'https://www.foothillcatalog.org',
    'https://foothillcatalog.org',
    'https://stingray-chameleon-tcpt.squarespace.com',
    'http://localhost:3000',
    'http://localhost:8080',
  ];

  const origin = req.headers.origin || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : '*';

  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { target, ...params } = req.query;

  const ALLOWED_TARGETS = ['census', 'lacounty', 'lacity', 'cams'];
  if (!target || !ALLOWED_TARGETS.includes(target)) {
    return res.status(400).json({ error: 'Invalid target' });
  }

  // Fields to request from parcel service
  const fields = [
    'AIN','SitusFullAddress','SitusCityName','SitusZIP',
    'YearBuilt1','SQFTmain1','SQFTlot',
    'Bedrooms1','Bathrooms1','Units1',
    'ZoningCode','FrontFeetLot','DepthFeetLot',
    'RecordingDate','SalePrice'
  ].join(',');

  async function fetchOne(url) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 12000);
    try {
      const r = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'TFCF-PropertyFinder/1.0' },
      });
      clearTimeout(tid);
      if (!r.ok) return null;
      return await r.json();
    } catch(e) {
      clearTimeout(tid);
      return null;
    }
  }

  // ── CENSUS geocoder ──
  if (target === 'census') {
    const { address } = params;
    if (!address) return res.status(400).json({ error: 'Missing address' });
    const url = `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
    const data = await fetchOne(url);
    if (!data) return res.status(502).json({ error: 'Census geocoder unavailable' });
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json(data);
  }

  // ── CAMS geocoder (LA County's own — returns precise parcel-level coords) ──
  if (target === 'cams') {
    const { address } = params;
    if (!address) return res.status(400).json({ error: 'Missing address' });
    // outSR=4326 forces WGS84 lat/lng output — directly usable for parcel queries
    const url = `https://geocode.gis.lacounty.gov/geocode/rest/services/CAMS_Locator/GeocodeServer/findAddressCandidates?SingleLine=${encodeURIComponent(address)}&outFields=*&maxLocations=1&outSR=4326&f=json`;
    const data = await fetchOne(url);
    if (!data) return res.status(502).json({ error: 'CAMS geocoder unavailable' });
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json(data);
  }

  // ── LA COUNTY parcel lookup ──
  if (target === 'lacounty') {
    const { lat, lng, address } = params;

    const AGOL_FS = 'https://services3.arcgis.com/GVgbJbqm8hXASVYi/arcgis/rest/services/LA_County_Parcels/FeatureServer/0';
    const agolFields = 'AIN,SitusFullAddress,SitusCity,SitusZIP,YearBuilt1,SQFTmain1,Bedrooms1,Bathrooms1,Units1,UseType,UseCode,Roll_LandBaseYear,Roll_ImpBaseYear,CENTER_LAT,CENTER_LON';

    // Strategy 1: WHERE clause by address — most reliable for fire lots
    if (address) {
      const situsAddr = address.toUpperCase()
        .replace(/,.*$/, '')
        .replace(/\s+(APT|UNIT|STE|#)\s*\S+/i, '')
        .trim();

      // Extract city if present to narrow results
      const cityMatch = address.match(/,\s*([^,]+),\s*CA/i);
      const city = cityMatch ? cityMatch[1].trim().toUpperCase() : null;

      const whereClause = city
        ? `SitusFullAddress LIKE '${situsAddr}%' AND SitusCity LIKE '${city}%'`
        : `SitusFullAddress LIKE '${situsAddr}%'`;

      const url = `${AGOL_FS}/query?where=${encodeURIComponent(whereClause)}&outFields=${agolFields}&returnGeometry=false&resultRecordCount=6&f=json`;
      const data = await fetchOne(url);
      if (data?.features?.length > 0) {
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
        return res.status(200).json(data);
      }

      // Retry: strip cardinal direction (N/S/E/W) in case user omitted it
      // e.g. "437 MENDOCINO ST" should still match "437 W MENDOCINO ST"
      // Only do this if the first query returned nothing — avoids over-fetching
      const stripped = situsAddr.replace(/^(\d+)\s+[NSEW]\s+/, '$1 ');
      if (stripped !== situsAddr) {
        const whereStripped = city
          ? `SitusFullAddress LIKE '${stripped}%' AND SitusCity LIKE '${city}%'`
          : `SitusFullAddress LIKE '${stripped}%'`;
        const url2 = `${AGOL_FS}/query?where=${encodeURIComponent(whereStripped)}&outFields=${agolFields}&returnGeometry=false&resultRecordCount=6&f=json`;
        const data2 = await fetchOne(url2);
        if (data2?.features?.length > 0) {
          res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
          return res.status(200).json(data2);
        }
      }
    }

    // Strategy 2: Spatial query by coordinates
    if (lat && lng) {
      const url = `${AGOL_FS}/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=${agolFields}&returnGeometry=false&f=json`;
      const data = await fetchOne(url);
      if (data?.features?.length > 0) {
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
        return res.status(200).json(data);
      }
    }

    return res.status(200).json({ features: [] });
  }
}

