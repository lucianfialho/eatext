// api/rss.js — server-side RSS proxy
// Fetches any RSS/Atom feed and returns the raw XML.
// Runs on Vercel Node.js runtime — no CORS restrictions.

export default async function handler(req, res) {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing ?url= parameter' });
  }

  // Only allow http/https URLs
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http/https allowed' });
  }

  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'EatText-RSS-Reader/1.0' },
      signal: AbortSignal.timeout(8000),
    });

    const body = await upstream.text();

    res.setHeader('Content-Type', 'text/xml; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    res.status(upstream.ok ? 200 : upstream.status).send(body);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}
