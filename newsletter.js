// Newsletter "Current Auctions" section, built live from BidPath.
//
//   GET /newsletter                 Preview page with a "Copy HTML" button (paste into an EmailOctopus Code element)
//   GET /newsletter/auctions.html   Just the email-safe HTML section
//   GET /feed/auctions              Same data as JSON (title, image, url, closes, timer, blurb, ...)
//   Add ?refresh=1 to any of these to re-write the AI blurbs.

const crypto = require('crypto');
const fetch = require('node-fetch');

const BIDPATH_API = 'https://bid.birdsnestauctions.com/api/graphql';
const SITE = 'https://bid.birdsnestauctions.com';
const CLAUDE_PROXY = process.env.CLAUDE_PROXY_URL || 'https://bna-claude-proxy.onrender.com/v1/messages';
const BLURB_MODEL = process.env.BLURB_MODEL || 'claude-sonnet-4-6';
const PUBLIC_URL = process.env.PUBLIC_URL || 'https://bna-proxy.onrender.com';
const TZ = 'America/New_York';
const CLOSING_SOON_HOURS = 48;

const C = { teal: '#2D6B5E', coral: '#E8806B', text: '#1a1a1a', muted: '#555555' };

// ---------- BidPath ----------
const AUCTIONS_QUERY = `{ auctions(offset:0, limit:50, filter:{ auctionStatus:[ACTIVE, STARTED, PAUSED] }) {
  id lotCount
  info { name auctionStatus progressStatus isTestAuction image(size: xl) description
    seo { urlParam }
    customFields { pickUpDay { value } pickUpLocation { value } } }
  ... on TimedAuction { auctionSchedule { biddingStartDate closingStartDate endDate } }
} }`;

async function fetchAuctions(integrationKey) {
  const r = await fetch(BIDPATH_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Integration-Key': integrationKey },
    body: JSON.stringify({ query: AUCTIONS_QUERY }),
  });
  const data = await r.json();
  if (data.errors) throw new Error(data.errors.map(e => e.message).join('; '));
  return data.data.auctions || [];
}

// ---------- text helpers ----------
const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–', hellip: '…', eacute: 'é', deg: '°' };
function htmlToText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

// Drop the pickup / shipping boilerplate that opens every BidPath description.
function auctionStory(descriptionHtml) {
  return htmlToText(descriptionHtml)
    .split('\n')
    .filter(line => !/pick ?-?up|we ship|shipping fulfil+ment|search for .?shipping|picked up within/i.test(line))
    .filter(line => !(line.replace(/[^A-Za-z]/g, '').length > 3 && line === line.toUpperCase())) // ALL-CAPS address/date headers
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstSentences(text, n = 2) {
  // Split on sentence ends, but not after abbreviations like "Co." or "No."
  const parts = text.split(/(?<!\b(?:Co|No|St|Mr|Mrs|Dr|Jr|Sr|Inc|Ltd|vs|approx)\.)(?<!\b[A-Z]\.[A-Z]\.)(?<=[.!?])\s+(?=[A-Z“"(])/);
  return parts.slice(0, n).join(' ').trim();
}

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------- dates ----------
function parts(ms) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h12' })
    .formatToParts(new Date(ms));
  return Object.fromEntries(p.map(x => [x.type, x.value]));
}
// "Thursday, Oct. 15, 2026, at 7:05 PM" — matches the current newsletter wording
function closeLabel(ms) {
  const p = parts(ms);
  const mon = p.month === 'May' ? 'May' : p.month + '.';
  return `${p.weekday}, ${mon} ${p.day}, ${p.year}, at ${p.hour}:${p.minute} ${p.dayPeriod}`;
}
function shortDay(ms) {
  const p = parts(ms);
  return `${p.weekday.slice(0, 3)}, ${p.month} ${p.day}`;
}
// "2026-10-15T19:05" in Eastern, for the timer link
function easternStamp(ms) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ms));
  const o = Object.fromEntries(p.map(x => [x.type, x.value]));
  return `${o.year}-${o.month}-${o.day}T${o.hour}:${o.minute}`;
}
// BidPath custom date fields come back as plain Eastern "2026-10-17 10:00:00"
function pickupDay(value) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}
function titleCaseTown(v) {
  return String(v || '').replace(/\.$/, '').trim().toLowerCase()
    .replace(/\b([a-z])/g, c => c.toUpperCase())
    .replace(/,\s*([a-z]{2})$/i, (_, st) => ', ' + st.toUpperCase());
}

// ---------- AI blurbs (cached per auction + description) ----------
const blurbCache = new Map();

function blurbPrompt(a, story) {
  return `Here is the full description of an upcoming Bird's Nest Auctions estate auction in Southern New Hampshire or northeastern Massachusetts.

Auction title: ${a.info.name}
Lot count: ${a.lotCount} (if you mention a number, use it or round down to ${Math.floor(a.lotCount / 10) * 10}+)

Description:
${story}

Write a newsletter blurb of 2-3 sentences (about 45-70 words) in the voice of Bird's Nest Auctions, picking the most exciting standouts from the description. Study these real examples carefully and match this voice exactly:

"The office team has been busy putting this auction together - find sterling silver, home goods, ephemera, linens and much more!"

"This home in Dover has a really nice assortment of higher end furniture and decor, vintage apparel, costume jewelry, pretty quilts and Pendleton blankets, and so much more."

"This auction at our HQ is bringing the mix this week: vintage goods, eye-catching artwork, his & hers bikes, and a handful of unexpected gems (looking at you, Henriot Quimper France Breton Faience plates and men's Seiko watches) that make this one worth a closer look."

"There are over 470 lots from this Windham estate, with Bauhaus seating, MCM carved tables, Capodimonte figurines, vintage holiday glassware, and a 1967 Disneyland LP. There's also patio furniture and deals on essentials for you to scoop up."

"This auction in Londonderry leans into the charm; an easy mix of everyday home goods, quirky collectibles, and fun vintage finds, with a standout sterling silver flatware set."

"This Raymond estate brings the garden to you, packed with outdoor décor, planters, birdhouses, and raised beds. This is the post-winter therapy we all need. (Also, please check out the cutest McCoy planter we have ever seen.)"

PRIORITY ORDER for standouts: precious metals & jewelry; signed/named art; named collectibles (pottery makers, Tiffany, Waterford, Lionel, militaria, vintage toys); antique rugs; genuinely collectible named furniture (MCM, Drexel, Stickley); notable tools.

VOICE RULES — follow these strictly:
- Sound like a real person who has been in the house and is tipping off a friend
- Name specific weird or exciting items with genuine enthusiasm
- Parenthetical asides with personality are welcome
- NEVER use: "collectors," "run of," "treasure trove," "curated" (unless quoting a title), "don't miss out," "something for everyone"
- Don't mention pickup days, shipping, or closing times
- No marketing-speak, no generic filler
- Return only the blurb text, no headers, no quotes, no formatting`;
}

async function writeBlurb(a, story) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const r = await fetch(CLAUDE_PROXY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: BLURB_MODEL, max_tokens: 400, messages: [{ role: 'user', content: blurbPrompt(a, story) }] }),
      signal: ctrl.signal,
    });
    const raw = await r.text();
    let data; try { data = JSON.parse(raw); } catch { throw new Error(`Claude proxy ${r.status}: ${raw.slice(0, 200)}`); }
    const text = data?.content?.[0]?.text?.trim();
    if (!text) throw new Error(`Claude proxy ${r.status}: ${data?.error?.message || JSON.stringify(data).slice(0, 200)}`);
    return text.replace(/^["“]|["”]$/g, '').trim();
  } finally {
    clearTimeout(timer);
  }
}

async function getBlurb(a, story, refresh) {
  const key = a.id + ':' + crypto.createHash('sha1').update(story).digest('hex');
  if (!refresh && blurbCache.has(key)) return blurbCache.get(key);
  let blurb, ai = true, error = null;
  try {
    blurb = await writeBlurb(a, story);
  } catch (err) {
    console.error(`Blurb failed for auction ${a.id}:`, err.message);
    blurb = firstSentences(story, 2);
    ai = false;
    error = err.name === 'AbortError' ? 'Timed out waiting for the Claude proxy' : err.message;
  }
  const result = { blurb, ai, error };
  if (ai) blurbCache.set(key, result); // don't cache fallbacks; try AI again next time
  return result;
}

// ---------- build the feed ----------
async function buildFeed(integrationKey, { refresh = false } = {}) {
  const now = Date.now();
  const raw = await fetchAuctions(integrationKey);
  const live = raw
    .filter(a => !a.info.isTestAuction && a.auctionSchedule?.closingStartDate)
    .map(a => ({ a, closeMs: Date.parse(a.auctionSchedule.closingStartDate) }))
    .filter(x => x.closeMs > now)
    .sort((x, y) => x.closeMs - y.closeMs);

  return Promise.all(live.map(async ({ a, closeMs }) => {
    const story = auctionStory(a.info.description);
    const { blurb, ai, error } = await getBlurb(a, story, refresh);
    const opensMs = Date.parse(a.auctionSchedule.biddingStartDate || '') || null;
    const upcoming = a.info.progressStatus === 'UPCOMING' || (opensMs && opensMs > now);
    const closingSoon = !upcoming && closeMs - now <= CLOSING_SOON_HOURS * 3600 * 1000;
    const stamp = easternStamp(closeMs);
    return {
      id: a.id,
      title: a.info.name,
      url: `${SITE}/auctions/catalog/id/${a.id}/${a.info.seo?.urlParam || ''}`.replace(/\/$/, ''),
      image: a.info.image,
      town: titleCaseTown(a.info.customFields?.pickUpLocation?.value),
      pickup: pickupDay(a.info.customFields?.pickUpDay?.value),
      lotCount: a.lotCount,
      closes: new Date(closeMs).toISOString(),
      closesLabel: closeLabel(closeMs),
      timer: `${PUBLIC_URL}/timer?end=${stamp}`,
      tag: upcoming && opensMs ? `Opens ${shortDay(opensMs)}` : closingSoon ? 'Closing soon!' : '',
      blurb,
      blurbIsAI: ai,
      ...(error ? { blurbError: error } : {}),
    };
  }));
}

// ---------- email HTML ----------
// Two columns that sit side by side on desktop and stack on phones,
// using inline-block (no media queries needed) plus Outlook ghost tables.
function cardHtml(x) {
  const details = [x.lotCount ? `${x.lotCount} lots` : '', x.pickup && x.town ? `Pickup ${x.pickup} in ${x.town}` : x.town].filter(Boolean).join(' &nbsp;·&nbsp; ');
  return `
<!-- ${esc(x.title)} -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
  <tr><td style="padding:0 0 32px 0;font-size:0;text-align:center;">
    <!--[if mso]><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="250" valign="top"><![endif]-->
    <div style="display:inline-block;width:100%;max-width:250px;vertical-align:top;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:0 10px 14px 10px;">
        <a href="${esc(x.url)}" target="_blank"><img src="${esc(x.image)}" width="230" alt="${esc(x.title)}" style="display:block;width:100%;max-width:230px;height:auto;border:0;border-radius:4px;margin:0 auto;"></a>
      </td></tr></table>
    </div>
    <!--[if mso]></td><td width="310" valign="top"><![endif]-->
    <div style="display:inline-block;width:100%;max-width:310px;vertical-align:top;text-align:left;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:0 10px;font-family:Arial,Helvetica,sans-serif;color:${C.text};">
        <img src="${esc(x.timer)}" width="290" alt="Closes ${esc(x.closesLabel)}" style="display:block;width:100%;max-width:290px;height:auto;border:0;margin:0 0 12px 0;">
        ${x.tag ? `<p style="margin:0 0 4px 0;font-size:15px;font-weight:bold;color:${C.coral};">${esc(x.tag)}</p>` : ''}
        <p style="margin:0 0 10px 0;font-size:20px;line-height:26px;font-weight:bold;color:${C.text};"><a href="${esc(x.url)}" target="_blank" style="color:${C.text};text-decoration:none;">${esc(x.title)}</a></p>
        <p style="margin:0 0 4px 0;font-size:15px;line-height:21px;font-weight:bold;">Closes on ${esc(x.closesLabel)}</p>
        ${details ? `<p style="margin:0 0 12px 0;font-size:13px;line-height:19px;color:${C.muted};">${details}</p>` : ''}
        <p style="margin:0 0 16px 0;font-size:15px;line-height:22px;">${esc(x.blurb)}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:4px;background:${C.teal};">
          <a href="${esc(x.url)}" target="_blank" style="display:inline-block;padding:11px 22px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:4px;">View Auction</a>
        </td></tr></table>
      </td></tr></table>
    </div>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr>
</table>`;
}

function sectionHtml(items) {
  return `<!-- BNA Current Auctions — generated ${new Date().toISOString()} -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:580px;margin:0 auto;border-collapse:collapse;">
  <tr><td style="padding:8px 10px 20px 10px;font-family:Arial,Helvetica,sans-serif;font-size:26px;font-weight:bold;color:#000000;">Current Auctions</td></tr>
  <tr><td>${items.map(cardHtml).join('\n')}</td></tr>
</table>`;
}

// ---------- preview page ----------
function previewPage(items, html) {
  const fallback = items.filter(x => !x.blurbIsAI).length;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Newsletter Auctions</title>
<style>
  body{margin:0;background:#f4f2ee;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a}
  .bar{position:sticky;top:0;z-index:2;background:#2D6B5E;color:#fff;padding:12px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .bar b{font-size:16px;margin-right:auto}
  .bar button,.bar a{background:#fff;color:#2D6B5E;border:0;border-radius:6px;padding:9px 14px;font-weight:bold;font-size:14px;cursor:pointer;text-decoration:none}
  .bar button.primary{background:#E8806B;color:#fff}
  .note{max-width:600px;margin:12px auto 0;padding:0 16px;font-size:13px;color:#555;line-height:1.5}
  .warn{color:#a4372a;font-weight:bold}
  .email{max-width:600px;margin:12px auto 40px;background:#fff;padding:24px 10px}
</style></head><body>
<div class="bar"><b>Current Auctions · ${items.length} auction${items.length === 1 ? '' : 's'}</b>
  <button class="primary" id="copy">Copy HTML</button>
  <a href="?refresh=1" onclick="this.textContent='Rewriting…'">Rewrite blurbs</a>
</div>
<p class="note">Paste into a <b>Code</b> element in your EmailOctopus newsletter, replacing the old Current Auctions section. Timers update on every open.
${fallback ? `<br><span class="warn">${fallback} blurb${fallback === 1 ? '' : 's'} couldn't be AI-written and used the first sentences instead. Try "Rewrite blurbs". (${esc(items.find(x => x.blurbError)?.blurbError || '')})</span>` : ''}
You can edit any text after pasting.</p>
<div class="email">${html}</div>
<textarea id="src" style="position:absolute;left:-9999px">${esc(html)}</textarea>
<script>
document.getElementById('copy').onclick = async function () {
  const t = document.getElementById('src').value;
  try { await navigator.clipboard.writeText(t); } catch (e) { const s = document.getElementById('src'); s.select(); document.execCommand('copy'); }
  this.textContent = 'Copied!'; setTimeout(() => this.textContent = 'Copy HTML', 2000);
};
</script></body></html>`;
}

// ---------- routes ----------
function register(app, integrationKey) {
  const handle = fn => async (req, res) => {
    try {
      const items = await buildFeed(integrationKey, { refresh: req.query.refresh === '1' });
      fn(req, res, items);
    } catch (err) {
      console.error('Newsletter error:', err);
      res.status(500).send('Could not build the auction list: ' + err.message);
    }
  };
  app.get('/feed/auctions', handle((req, res, items) => res.set('Cache-Control', 'no-store').json({ items })));
  app.get('/newsletter/auctions.html', handle((req, res, items) => res.type('html').set('Cache-Control', 'no-store').send(sectionHtml(items))));
  app.get('/newsletter', handle((req, res, items) => res.type('html').set('Cache-Control', 'no-store').send(previewPage(items, sectionHtml(items)))));
}

module.exports = { register, buildFeed, sectionHtml, previewPage, auctionStory, closeLabel, easternStamp, pickupDay, titleCaseTown };
