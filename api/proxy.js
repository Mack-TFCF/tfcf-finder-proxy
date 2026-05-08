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
    const url = `https://geocode.gis.lacounty.gov/geocode/rest/services/CAMS_Locator/GeocodeServer/findAddressCandidates?SingleLine=${encodeURIComponent(address)}&outFields=*&maxLocations=1&f=json`;
    const data = await fetchOne(url);
    if (!data) return res.status(502).json({ error: 'CAMS geocoder unavailable' });
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json(data);
  }

  // ── LA COUNTY parcel lookup ──
  if (target === 'lacounty') {
    const { lat, lng, x: mx, y: my, address } = params;

    // Strategy 1: Identify on tiled cache using Web Mercator coords
    // (tiled cache only supports Identify, not query)
    // Use CAMS coords (Web Mercator) if available, else convert from WGS84
    if (mx && my) {
      const extent = `${parseFloat(mx)-50},${parseFloat(my)-50},${parseFloat(mx)+50},${parseFloat(my)+50}`;
      const url = `https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/LACounty_Parcel/MapServer/identify?geometry=${mx},${my}&geometryType=esriGeometryPoint&sr=3857&layers=all:0&tolerance=2&mapExtent=${extent}&imageDisplay=800,800,96&returnGeometry=false&f=json`;
      const data = await fetchOne(url);
      if (data?.results?.length > 0) {
        const normalized = { features: data.results.map(r => ({ attributes: r.attributes })) };
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
        return res.status(200).json(normalized);
      }
    }

    // Strategy 2: ArcGIS Online public LA County parcel FeatureServer
    // (fully queryable, supports spatial + WHERE queries)
    const AGOL_FS = 'https://services3.arcgis.com/i2dkYWmb4wHvYPda/arcgis/rest/services/LACounty_Parcels/FeatureServer/0';

    if (lat && lng) {
      const url = `${AGOL_FS}/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=${fields}&returnGeometry=false&f=json`;
      const data = await fetchOne(url);
      if (data?.features?.length > 0) {
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
        return res.status(200).json(data);
      }
    }

    // Strategy 3: WHERE clause by address on AGOL FeatureServer
    if (address) {
      const situsAddr = address.toUpperCase()
        .replace(/,.*$/, '')
        .replace(/\s+(APT|UNIT|STE|#)\s*\S+/i, '')
        .trim();
      const url = `${AGOL_FS}/query?where=SitusFullAddress+LIKE+'${encodeURIComponent(situsAddr + '%')}'&outFields=${fields}&returnGeometry=false&f=json`;
      const data = await fetchOne(url);
      if (data?.features?.length > 0) {
        res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
        return res.status(200).json(data);
      }
    }

    return res.status(200).json({ features: [] });
  }

  // ── LA CITY zoning ──
  if (target === 'lacity') {
    const { lat, lng } = params;
    if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });
    const url = `https://gis.lacity.org/arcgis/rest/services/Map_Services/LADBS_Zoning/MapServer/0/query?geometry=${lng},${lat}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=APN,ADDRESS,ZONE_CLASS,ZONE_SUMMARY,LOTAREA&returnGeometry=false&f=json`;
    const data = await fetchOne(url);
    if (!data) return res.status(200).json({ features: [] });
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate');
    return res.status(200).json(data);
  }
}

