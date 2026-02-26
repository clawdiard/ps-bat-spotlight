/**
 * Fetch completed auction data from Bring a Trailer's public RSS feed
 * and recent listings page. Outputs data/auctions.json for the static site.
 *
 * Runs in GitHub Actions (Node.js) — no CORS restrictions.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BaTSpotlight/1.0)' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function extractAuctions(html) {
  const auctions = [];
  // BaT listing pages contain structured data in <script type="application/ld+json">
  const ldJsonBlocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of ldJsonBlocks) {
    try {
      const jsonStr = block.replace(/<\/?script[^>]*>/gi, '').trim();
      const data = JSON.parse(jsonStr);
      if (data['@type'] === 'Product' || data['@type'] === 'ItemPage') {
        auctions.push(data);
      }
    } catch (e) { /* skip malformed */ }
  }
  return auctions;
}

function parseRSSAuctions(xml) {
  const items = [];
  const itemBlocks = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]>|<title>(.*?)<\/title>/) || [])[1] || (block.match(/<title>(.*?)<\/title>/) || [])[1] || '';
    const link = (block.match(/<link>(.*?)<\/link>/) || [])[1] || '';
    const desc = (block.match(/<description><!\[CDATA\[(.*?)\]\]>|<description>(.*?)<\/description>/) || [])[1] || '';
    const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
    const imgMatch = desc.match(/src=["'](https?:\/\/[^"']+)["']/) || link.match(/(https:\/\/bringatrailer\.com\/wp-content\/uploads\/[^"'\s]+)/);
    items.push({
      title: title.replace(/<[^>]+>/g, '').trim(),
      url: link.trim(),
      description: desc.replace(/<[^>]+>/g, '').trim().slice(0, 300),
      date: pubDate,
      image: imgMatch ? imgMatch[1] : null
    });
  }
  return items;
}

function parsePriceFromDesc(desc) {
  const m = desc.match(/\$[\d,]+/);
  return m ? m[0] : null;
}

function categorize(title) {
  const t = title.toLowerCase();
  const japanese = ['toyota', 'nissan', 'honda', 'mazda', 'subaru', 'mitsubishi', 'lexus', 'acura', 'datsun', 'suzuki', 'supra', 'skyline', 'nsx', 'rx-7', 'ae86', 'evo'];
  const european = ['porsche', 'bmw', 'mercedes', 'ferrari', 'lamborghini', 'jaguar', 'aston', 'alfa', 'lotus', 'maserati', 'bentley', 'rolls', 'audi', 'volkswagen', 'vw', 'fiat', 'lancia', 'volvo', 'saab', 'peugeot', 'citroen', 'triumph', 'mg ', 'mini'];
  if (japanese.some(j => t.includes(j))) return 'japanese';
  if (european.some(e => t.includes(e))) return 'european';
  return 'american';
}

async function main() {
  console.log('Fetching BaT RSS feed...');
  let rssData;
  try {
    rssData = await fetchPage('https://bringatrailer.com/feed/');
  } catch (e) {
    console.error('RSS fetch failed:', e.message);
    rssData = '';
  }

  const rssAuctions = parseRSSAuctions(rssData);
  console.log(`Parsed ${rssAuctions.length} items from RSS`);

  // Also try the completed auctions page
  let completedHtml = '';
  try {
    completedHtml = await fetchPage('https://bringatrailer.com/auctions/results/');
  } catch (e) {
    console.log('Completed auctions page fetch failed:', e.message);
  }

  // Extract completed auction cards from HTML
  const completedAuctions = [];
  const cardMatches = completedHtml.match(/<a[^>]*class="[^"]*listing-card[^"]*"[^>]*>[\s\S]*?<\/a>/gi) || [];
  for (const card of cardMatches.slice(0, 30)) {
    const href = (card.match(/href="([^"]+)"/) || [])[1] || '';
    const titleMatch = card.match(/listing-card-title[^>]*>([^<]+)/) || card.match(/title="([^"]+)"/);
    const imgMatch = card.match(/src="(https:\/\/[^"]+(?:\.jpg|\.jpeg|\.png|\.webp)[^"]*)"/i);
    const priceMatch = card.match(/\$[\d,]+/);
    const bidMatch = card.match(/([\d,]+)\s*(?:bid|comment)/i);
    if (titleMatch) {
      completedAuctions.push({
        title: titleMatch[1].trim(),
        url: href,
        image: imgMatch ? imgMatch[1] : null,
        price: priceMatch ? priceMatch[0] : null,
        bids: bidMatch ? parseInt(bidMatch[1].replace(',', '')) : null,
        source: 'completed'
      });
    }
  }
  console.log(`Parsed ${completedAuctions.length} completed auctions from HTML`);

  // Merge and deduplicate
  const seen = new Set();
  const allAuctions = [];

  for (const a of [...completedAuctions, ...rssAuctions]) {
    const key = a.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);

    // Parse year from title
    const yearMatch = a.title.match(/\b(19\d{2}|20[0-2]\d)\b/);
    const year = yearMatch ? yearMatch[1] : '';

    allAuctions.push({
      year,
      title: a.title.replace(/^\d{4}\s+/, ''),
      url: a.url || '',
      image: a.image || null,
      price: a.price || parsePriceFromDesc(a.description || '') || null,
      bids: a.bids || null,
      category: categorize(a.title),
      description: a.description || '',
      date: a.date || new Date().toISOString()
    });
  }

  // Sort by price descending (put priced items first)
  allAuctions.sort((a, b) => {
    const pa = a.price ? parseInt(a.price.replace(/[$,]/g, '')) : 0;
    const pb = b.price ? parseInt(b.price.replace(/[$,]/g, '')) : 0;
    return pb - pa;
  });

  const output = {
    fetchedAt: new Date().toISOString(),
    weekOf: getWeekLabel(),
    totalAuctions: allAuctions.length,
    auctions: allAuctions.slice(0, 24)
  };

  const outPath = path.join(__dirname, '..', 'data', 'auctions.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${output.auctions.length} auctions to ${outPath}`);
}

function getWeekLabel() {
  const now = new Date();
  const mon = new Date(now);
  mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const fmt = d => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  return `${fmt(mon)} – ${fmt(sun)}`;
}

main().catch(e => { console.error(e); process.exit(1); });
