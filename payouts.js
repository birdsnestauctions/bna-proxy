// Payout portal API for bna-proxy.
//
//   POST /payouts/api/login          { username, password } -> { session, user }
//   GET  /payouts/api/overview        Sales, Payees, Adjustments for the dashboard and refunds page
//   GET  /payouts/api/auctions        Closed BidPath auctions not yet in the portal
//   GET  /payouts/api/sale/:id        Everything stored for one sale
//   POST /payouts/api/sync            { auctionId, type?, clientName?, clientEmail? } pull lots from BidPath, flag refunds
//   POST /payouts/api/save            { tab, rows }   save edits (fees, payees, adjustments, lot overrides, sale)
//   POST /payouts/api/remove          { tab: 'Fees', row: { id } }
//   POST /payouts/api/missive-draft   { to, subject, body } create an unsent Missive draft
//
// Environment (set on Render):
//   PORTAL_SHEET_URL   Apps Script web app URL for the payout Google Sheet
//   PORTAL_SECRET      Long random text; the same value goes in the Apps Script's Script Properties
//   PORTAL_USERS       Comma-separated BidPath usernames or emails allowed in (anyone @birdsnestauctions.com is always allowed)
//   CONSIGNOR_FIELD    Optional. BidPath lot custom field holding consignor initials, e.g. consignorInitials
//   MISSIVE_TOKEN      Optional. Missive API token for creating draft emails

const crypto = require('crypto');
const fetch = require('node-fetch');

const BIDPATH_API = process.env.BIDPATH_API || 'https://bid.birdsnestauctions.com/api/graphql';
const SESSION_HOURS = 10;

function env(name) { return (process.env[name] || '').trim(); }
function sessionKey() {
  const s = env('PORTAL_SECRET');
  if (!s) throw httpError(500, 'The portal is not set up yet: PORTAL_SECRET is missing on Render.');
  return crypto.createHmac('sha256', s).update('portal-session').digest();
}
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// ---------- sessions ----------
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function verify(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) throw httpError(401, 'Please sign in.');
  const want = crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
  if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) throw httpError(401, 'Please sign in again.');
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (Date.now() > p.x) throw httpError(401, 'Your session expired. Please sign in again.');
  return p;
}
function allowed(user) {
  const email = String(user.email || '').toLowerCase();
  const name = String(user.username || '').toLowerCase();
  if (email.endsWith('@birdsnestauctions.com') || name.endsWith('@birdsnestauctions.com')) return true;
  const list = env('PORTAL_USERS').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  return list.includes(email) || list.includes(name);
}

// ---------- BidPath ----------
async function bidpath(query, bearer, integrationKey) {
  const headers = { 'Content-Type': 'application/json', 'X-Integration-Key': integrationKey };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const r = await fetch(BIDPATH_API, { method: 'POST', headers, body: JSON.stringify({ query }) });
  const json = await r.json().catch(() => ({}));
  if (r.status === 401) throw httpError(401, 'BidPath login expired. Please sign in again.');
  return json;
}
function denied(json) {
  return (json.errors || []).some(e => /access denied|not authori[sz]ed|forbidden/i.test(e.message || '') || e?.extensions?.code === 403);
}

// ---------- Google Sheet (Apps Script) ----------
async function sheet(op, payload = {}) {
  const url = env('PORTAL_SHEET_URL');
  if (!url) throw httpError(500, 'The portal is not set up yet: PORTAL_SHEET_URL is missing on Render.');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ ...payload, op, secret: env('PORTAL_SECRET') }),
    redirect: 'follow',
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { throw httpError(502, 'The payout sheet did not answer correctly. Check the Apps Script deployment.'); }
  if (!json.ok) throw httpError(502, `Payout sheet: ${json.error}`);
  return json.data;
}

const WRITABLE = {
  Sales: ['auctionId', 'name', 'presaleName', 'assettraxNo', 'photoDate', 'type', 'clientName', 'clientEmail', 'stage', 'soldTotal', 'estPayout', 'feeTotal', 'checks', 'openCount'],
  Payees: ['auctionId', 'payeeKey', 'name', 'email', 'rate', 'rateReason', 'payout', 'printed', 'checkNo', 'mailedOn', 'emailed', 'paidAt', 'paidBy'],
  Lots: ['auctionId', 'lotNo', 'gsOverride', 'lotRate', 'payeeOverride', 'note'],
  Fees: ['id', 'auctionId', 'payeeKey', 'kind', 'label', 'qty', 'lotNo', 'itemName', 'minimum', 'amount', 'note', 'addedBy', 'addedAt'],
  Adjustments: ['id', 'auctionId', 'reason', 'text', 'clientPaid', 'highValueOk', 'fix', 'fixDone', 'status', 'decidedBy', 'decidedAt'],
};
function clean(tab, rows) {
  const cols = WRITABLE[tab];
  if (!cols) throw httpError(400, `Can't save to ${tab}.`);
  return (rows || []).map(r => {
    const o = {};
    cols.forEach(c => { if (r[c] !== undefined) o[c] = r[c]; });
    if (tab === 'Adjustments' && o.status && !['open', 'classified'].includes(o.status)) delete o.status;
    return o;
  });
}

// ---------- sync ----------
function lotsQuery(id, offset, consignorField) {
  const extra = consignorField && /^[A-Za-z][A-Za-z0-9_]*$/.test(consignorField) ? ` ${consignorField} { value }` : '';
  return `{ auctionLots(offset: ${offset}, limit: 500, filter: { auctionId: [${id}], onlyFeatured: false, excludeClosedLots: false }) {
    info { lotNo status }
    soldPrice { hammerPrice }
    lotItem { id name categories { name }
      consignor { email username userInfo { firstName lastName } }
      customFields { staffInitials { value }${extra} } }
  } }`;
}
function invoicesQuery(id, offset) {
  return `{ legacyInvoices(offset: ${offset}, limit: 500, filter: { auctionId: [${id}] }) {
    status internalNote totals { balanceDue }
    lineItems { hammerPrice auctionLot { info { lotNo } } }
  } }`;
}

async function fetchAll(make, pick, bearer, key) {
  const out = [];
  for (let offset = 0; offset < 20000; offset += 500) {
    const json = await bidpath(make(offset), bearer, key);
    const page = pick(json);
    if (!page) return { rows: out, json };
    out.push(...page.filter(Boolean));
    if (page.length < 500) return { rows: out, json };
  }
  return { rows: out, json: {} };
}

function parseNotes(text) {
  const out = [];
  String(text || '').split(/\n+/).forEach(line => {
    const m = line.match(/refund\s+lot\s*#?\s*([A-Za-z0-9-]+)/i);
    if (m) out.push({ lotNo: m[1], note: line.trim() });
  });
  return out;
}

async function syncSale(body, sess, key) {
  const id = parseInt(body.auctionId, 10);
  if (!id) throw httpError(400, 'Missing auction id.');
  const now = new Date().toISOString();
  const consignorField = env('CONSIGNOR_FIELD');

  const info = await bidpath(`{ auction(id: ${id}) { id info { name saleNo progressStatus }
    ... on TimedAuction { auctionSchedule { endDate } } } }`, sess.b, key);
  const auction = info?.data?.auction;
  if (!auction) throw httpError(404, `BidPath has no auction ${id}.`);
  const isClosed = auction.info.progressStatus === 'CLOSED';

  const lotsRes = await fetchAll(o => lotsQuery(id, o, consignorField), j => j?.data?.auctionLots, sess.b, key);
  if (!lotsRes.rows.length && lotsRes.json.errors) throw httpError(502, `BidPath: ${lotsRes.json.errors[0].message}`);

  // Invoices are optional: they add buyer balances, refund notes, and catch refunds made before the portal saw the sale.
  let invoiceAccess = true, owed = 0;
  const invLine = {}, notes = {};
  const inv = await fetchAll(o => invoicesQuery(id, o), j => j?.data?.legacyInvoices, sess.b, key);
  if (denied(inv.json) && !inv.rows.length) invoiceAccess = false;
  inv.rows.forEach(v => {
    if (v.status !== 'CANCELED') owed += Number(v.totals?.balanceDue) || 0;
    (v.lineItems || []).forEach(li => {
      const n = li?.auctionLot?.info?.lotNo;
      if (n != null) invLine[String(n)] = Number(li.hammerPrice) || 0;
    });
    parseNotes(v.internalNote).forEach(x => { notes[x.lotNo] = (notes[x.lotNo] ? notes[x.lotNo] + '\n' : '') + x.note; });
  });

  const stored = await sheet('read', { tabs: ['Sales', 'Lots', 'Adjustments', 'Payees'], auctionId: id });
  const sale = stored.Sales[0] || {};
  const type = body.type || sale.type || 'estate';
  const oldLots = {}; stored.Lots.forEach(l => { oldLots[String(l.lotNo)] = l; });
  const oldAdj = {}; stored.Adjustments.forEach(a => { oldAdj[String(a.lotNo)] = a; });
  const payeeRows = {}; stored.Payees.forEach(p => { payeeRows[String(p.payeeKey)] = p; });

  const lotRows = [], adjRows = [], newPayees = {};
  lotsRes.rows.forEach(l => {
    const lotNo = String(l.info.lotNo);
    const status = l.info.status;
    const price = l.soldPrice ? Number(l.soldPrice.hammerPrice) || 0 : 0;
    const item = l.lotItem || {};
    const cf = item.customFields || {};
    const initials = consignorField && cf[consignorField] ? String(cf[consignorField].value || '').trim().toUpperCase() : '';
    const c = item.consignor || null;
    const prev = oldLots[lotNo];
    const onInvoice = lotNo in invLine;

    // Snapshot the sold price the first time the portal sees the lot. If the invoice shows a higher
    // price (or the lot was sold but is now unsold), the refund happened before the portal: use the invoice.
    // While the auction is live there is no snapshot yet: bids are not final.
    const hasSnap = prev && prev.closeStatus !== '' && prev.closeStatus != null;
    let closeStatus = hasSnap ? prev.closeStatus : (isClosed ? status : '');
    let closePrice = hasSnap ? Number(prev.closePrice) || 0 : (isClosed ? price : '');
    if (!hasSnap && isClosed && onInvoice && (invLine[lotNo] > price || status !== 'SOLD')) { closeStatus = 'SOLD'; closePrice = invLine[lotNo]; }

    lotRows.push({
      auctionId: id, lotNo, lotItemId: item.id, name: item.name || '', category: (item.categories || [])[0]?.name || '',
      initials, consignorEmail: c?.email || '', closeStatus, closePrice, status, price,
      invoicePrice: onInvoice ? invLine[lotNo] : '', lastSync: now,
    });

    if (type === 'consignment') {
      const pk = (c?.email || '').toLowerCase() || initials || 'UNASSIGNED';
      if (!payeeRows[pk] && !newPayees[pk] && pk !== 'UNASSIGNED') {
        const nm = c ? `${c.userInfo?.firstName || ''} ${c.userInfo?.lastName || ''}`.trim() : '';
        newPayees[pk] = { auctionId: id, payeeKey: pk, name: nm || pk, email: c?.email || '', rate: pk === 'BNA' ? 'house' : 'client' };
      }
    }

    // Refund detection against the snapshot.
    let kind = null, newPrice = price;
    if (!isClosed) { /* no refund detection until the sale closes */ }
    else if (closeStatus === 'SOLD' && status !== 'SOLD') { kind = 'full'; newPrice = 0; }
    else if (closeStatus === 'SOLD' && price < closePrice - 0.004) kind = 'partial';
    const a = oldAdj[lotNo];
    if (kind) {
      const row = {
        id: `${id}-${lotNo}`, auctionId: id, saleName: auction.info.name, lotNo, itemName: item.name || '',
        kind, origPrice: closePrice, newPrice, invoiceNote: notes[lotNo] || (a ? a.invoiceNote : ''),
      };
      if (!a || a.status === 'void') Object.assign(row, { status: 'open', detectedAt: now });
      else if (Number(a.newPrice) !== newPrice || a.kind !== kind) Object.assign(row, { status: 'open', decidedBy: '', decidedAt: '' });
      adjRows.push(row);
    } else if (a && a.status !== 'void') {
      adjRows.push({ id: a.id, auctionId: id, lotNo, status: 'void' }); // price was put back
    }
  });

  const endDate = auction.auctionSchedule?.endDate || sale.closeDate || '';
  const saleRow = {
    auctionId: id, saleNo: auction.info.saleNo, name: auction.info.name, type, closeDate: endDate, bidpathStatus: auction.info.progressStatus,
    owedByBuyers: invoiceAccess ? Math.round(owed * 100) / 100 : '', invoiceAccess: invoiceAccess ? 'yes' : 'no', lastSync: now,
  };
  if (!stored.Sales.length) Object.assign(saleRow, { stage: 'open', createdBy: sess.u, createdAt: now });
  else if (sale.stage === 'prep' || !sale.stage) saleRow.stage = 'open';
  if (body.clientName !== undefined) saleRow.clientName = body.clientName;
  if (body.clientEmail !== undefined) saleRow.clientEmail = body.clientEmail;

  await sheet('upsert', { tab: 'Sales', rows: [saleRow], user: sess.u });
  if (lotRows.length) await sheet('upsert', { tab: 'Lots', rows: lotRows, user: sess.u });
  if (adjRows.length) await sheet('upsert', { tab: 'Adjustments', rows: adjRows, user: sess.u });
  const np = Object.values(newPayees);
  if (np.length) await sheet('upsert', { tab: 'Payees', rows: np, user: sess.u });

  return { synced: lotRows.length, newRefunds: adjRows.filter(r => r.status === 'open').length, invoiceAccess, closed: isClosed };
}

// ---------- routes ----------
function register(app, integrationKey) {
  const wrap = fn => async (req, res) => {
    try { res.json(await fn(req)); }
    catch (e) {
      if (!e.status) console.error('payouts:', e);
      res.status(e.status || 500).json({ error: e.message || 'Something went wrong.' });
    }
  };
  const auth = req => verify((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));

  app.post('/payouts/api/login', wrap(async req => {
    const { username, password } = req.body || {};
    if (!username || !password) throw httpError(400, 'Enter your BidPath username and password.');
    const m = `mutation { auth { createToken(username: ${JSON.stringify(username)}, password: ${JSON.stringify(password)}) {
      accessToken user { email username userInfo { firstName lastName } } errors { __typename } } } }`;
    const json = await bidpath(m, null, integrationKey);
    const t = json?.data?.auth?.createToken;
    if (!t || !t.accessToken) throw httpError(401, 'BidPath did not accept that username and password.');
    const user = t.user || { username };
    if (!allowed({ email: user.email, username: user.username || username })) {
      throw httpError(403, 'This BidPath login is not on the payout portal list. Ask Katie to add you.');
    }
    const first = user.userInfo?.firstName || '';
    const label = first || user.email || username;
    const session = sign({ u: label, e: user.email || '', b: t.accessToken, x: Date.now() + SESSION_HOURS * 3600e3 });
    return { session, user: { name: label, email: user.email || '' } };
  }));

  app.get('/payouts/api/overview', wrap(async req => {
    auth(req);
    return sheet('read', { tabs: ['Sales', 'Payees', 'Adjustments', 'Fees'] });
  }));

  app.get('/payouts/api/sale/:id', wrap(async req => {
    auth(req);
    const id = String(req.params.id || '');
    if (!/^(\d+|P[A-Z0-9]+)$/.test(id)) throw httpError(400, 'That sale id is not valid.');
    return sheet('read', { tabs: ['Sales', 'Payees', 'Lots', 'Fees', 'Adjustments'], auctionId: id });
  }));

  app.get('/payouts/api/auctions', wrap(async req => {
    const s = auth(req);
    const json = await bidpath(`{ auctions(offset: 0, limit: 80, sort: { id: DESC }, filter: { progressStatus: [CLOSED, IN_PROGRESS, UPCOMING] }) {
      id info { name saleNo isTestAuction progressStatus } ... on TimedAuction { auctionSchedule { endDate } } } }`, s.b, integrationKey);
    if (!json?.data?.auctions) throw httpError(502, `BidPath: ${(json.errors || [{}])[0].message || 'no auctions returned'}`);
    return json.data.auctions.filter(a => !a.info.isTestAuction).map(a => ({
      id: a.id, name: a.info.name, saleNo: a.info.saleNo, status: a.info.progressStatus, closeDate: a.auctionSchedule?.endDate || '',
    }));
  }));

  app.post('/payouts/api/sync', wrap(async req => syncSale(req.body || {}, auth(req), integrationKey)));

  app.post('/payouts/api/save', wrap(async req => {
    const s = auth(req);
    const { tab, rows } = req.body || {};
    return sheet('upsert', { tab, rows: clean(tab, rows), user: s.u });
  }));

  app.post('/payouts/api/remove', wrap(async req => {
    const s = auth(req);
    const { tab, row } = req.body || {};
    if (tab !== 'Fees' || !row || !row.id) throw httpError(400, 'Only fees can be removed.');
    return sheet('remove', { tab, row: { id: row.id }, user: s.u });
  }));

  // A sale that isn't in BidPath yet (photo day / editing). Gets a portal id until it's linked.
  app.post('/payouts/api/create', wrap(async req => {
    const s = auth(req);
    const b = req.body || {};
    if (!String(b.name || '').trim()) throw httpError(400, 'Give the sale a name.');
    const id = 'P' + Date.now().toString(36).toUpperCase();
    const now = new Date().toISOString();
    await sheet('upsert', { tab: 'Sales', user: s.u, rows: [{
      auctionId: id, name: b.name.trim(), presaleName: b.name.trim(), type: b.type === 'consignment' ? 'consignment' : 'estate',
      clientName: b.clientName || '', clientEmail: b.clientEmail || '', photoDate: b.photoDate || '', assettraxNo: b.assettraxNo || '',
      stage: 'prep', bidpathStatus: '', createdBy: s.u, createdAt: now,
    }] });
    return { id };
  }));

  // Connect a presale record to its BidPath auction: moves fees and details over, then pulls lots.
  app.post('/payouts/api/link', wrap(async req => {
    const s = auth(req);
    const { from, auctionId } = req.body || {};
    if (!/^P/.test(String(from || '')) || !parseInt(auctionId, 10)) throw httpError(400, 'Choose the BidPath auction to link.');
    await sheet('rekey', { from: String(from), to: String(parseInt(auctionId, 10)), user: s.u });
    return syncSale({ auctionId }, s, integrationKey);
  }));

  // Daily refresh for every linked, unpaid sale, so the price snapshot is taken right after close.
  // Call: POST /payouts/api/cron with header X-Cron-Key: <PORTAL_CRON_KEY>
  app.post('/payouts/api/cron', wrap(async req => {
    if (!env('PORTAL_CRON_KEY') || req.headers['x-cron-key'] !== env('PORTAL_CRON_KEY')) throw httpError(401, 'Not authorized.');
    if (!env('PORTAL_BIDPATH_USER') || !env('PORTAL_BIDPATH_PASSWORD')) throw httpError(500, 'PORTAL_BIDPATH_USER and PORTAL_BIDPATH_PASSWORD are not set on Render.');
    const m = `mutation { auth { createToken(username: ${JSON.stringify(env('PORTAL_BIDPATH_USER'))}, password: ${JSON.stringify(env('PORTAL_BIDPATH_PASSWORD'))}) { accessToken } } }`;
    const tok = (await bidpath(m, null, integrationKey))?.data?.auth?.createToken?.accessToken;
    if (!tok) throw httpError(502, 'BidPath did not accept the portal login.');
    const sess = { u: 'Morning sync', b: tok };
    const { Sales } = await sheet('read', { tabs: ['Sales'] });
    const due = Sales.filter(x => /^\d+$/.test(String(x.auctionId)) && x.stage !== 'paid');
    const results = [];
    for (const x of due) {
      try { const r = await syncSale({ auctionId: x.auctionId }, sess, integrationKey); results.push({ sale: x.name, ...r }); }
      catch (e) { results.push({ sale: x.name, error: e.message }); }
    }
    return { synced: results.length, results };
  }));

  app.post('/payouts/api/missive-draft', wrap(async req => {
    auth(req);
    const token = env('MISSIVE_TOKEN');
    if (!token) throw httpError(501, 'Missive is not connected yet. Use Copy email instead.');
    const { to, subject, body } = req.body || {};
    if (!to || !subject || !body) throw httpError(400, 'The email needs a recipient, subject and body.');
    const r = await fetch('https://public.missiveapp.com/v1/drafts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ drafts: {
        subject, body: String(body).replace(/\n/g, '<br>'),
        to_fields: [{ address: to }],
        ...(env('MISSIVE_FROM') ? { from_field: { address: env('MISSIVE_FROM') } } : {}),
      } }),
    });
    if (!r.ok) throw httpError(502, `Missive said: ${(await r.text()).slice(0, 200)}`);
    return { ok: true };
  }));
}

module.exports = { register, sign, verify, parseNotes };
