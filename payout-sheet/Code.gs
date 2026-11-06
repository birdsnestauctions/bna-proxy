/**
 * Bird's Nest Auctions — Payout Portal storage.
 *
 * This script turns the Google Sheet it lives in into the portal's database.
 * Only the BNA proxy talks to it, using a shared secret saved in Script Properties
 * under PORTAL_SECRET. Staff never open this script; they use the portal.
 *
 * Setup is in the README the portal came with. In short:
 *   1. Extensions → Apps Script, paste this file, save.
 *   2. Project Settings → Script Properties → add PORTAL_SECRET (any long random text).
 *   3. Run setup() once and approve access.
 *   4. Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → copy the URL.
 */

const TABS = {
  Sales:       ['auctionId', 'saleNo', 'name', 'type', 'clientName', 'clientEmail', 'closeDate', 'stage',
                'soldTotal', 'estPayout', 'checks', 'openCount', 'owedByBuyers', 'invoiceAccess',
                'lastSync', 'createdBy', 'createdAt', 'updatedBy', 'updatedAt'],
  Payees:      ['auctionId', 'payeeKey', 'name', 'email', 'rate', 'rateReason', 'payout',
                'printed', 'checkNo', 'mailedOn', 'emailed', 'paidAt', 'paidBy', 'updatedBy', 'updatedAt'],
  Lots:        ['auctionId', 'lotNo', 'lotItemId', 'name', 'category', 'initials', 'consignorEmail',
                'closeStatus', 'closePrice', 'status', 'price', 'invoicePrice', 'gsOverride', 'payeeOverride',
                'note', 'lastSync'],
  Fees:        ['id', 'auctionId', 'payeeKey', 'label', 'amount', 'note', 'addedBy', 'addedAt'],
  Adjustments: ['id', 'auctionId', 'saleName', 'lotNo', 'itemName', 'kind', 'origPrice', 'newPrice', 'status',
                'reason', 'text', 'clientPaid', 'highValueOk', 'invoiceNote', 'fix', 'fixDone',
                'detectedAt', 'decidedBy', 'decidedAt'],
  Log:         ['at', 'user', 'action', 'tab', 'key', 'detail'],
};

const KEYS = {
  Sales: ['auctionId'], Payees: ['auctionId', 'payeeKey'], Lots: ['auctionId', 'lotNo'],
  Fees: ['id'], Adjustments: ['id'],
};

function setup() {
  const ss = SpreadsheetApp.getActive();
  Object.keys(TABS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const head = TABS[name];
    const have = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [];
    const missing = head.filter(h => have.indexOf(h) === -1);
    if (missing.length) sh.getRange(1, have.filter(String).length + 1, 1, missing.length).setValues([missing]);
    // Store everything as plain text so lot numbers, emails and dates are never reformatted by Sheets.
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight('bold');
  });
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
}

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    const secret = PropertiesService.getScriptProperties().getProperty('PORTAL_SECRET');
    if (!secret || req.secret !== secret) throw new Error('Not authorized');
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try { out = { ok: true, data: handle(req) }; }
    finally { lock.releaseLock(); }
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function handle(req) {
  switch (req.op) {
    case 'ping':      return { ok: true };
    case 'read':      return read(req.tabs || Object.keys(KEYS), req.auctionId);
    case 'upsert':    return upsert(req.tab, req.rows || [], req.user || '');
    case 'remove':    return remove(req.tab, req.row || {}, req.user || '');
    default: throw new Error('Unknown op ' + req.op);
  }
}

function sheet(name) {
  if (!TABS[name]) throw new Error('Unknown tab ' + name);
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Missing tab ' + name + '. Run setup() once.');
  return sh;
}

function rows(name) {
  const sh = sheet(name);
  const last = sh.getLastRow();
  if (last < 2) return { sh, head: sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0], data: [] };
  const vals = sh.getRange(1, 1, last, sh.getLastColumn()).getValues();
  return { sh, head: vals[0], data: vals.slice(1) };
}

function toObj(head, r) {
  const o = {};
  head.forEach((h, i) => { if (h) o[h] = r[i] instanceof Date ? r[i].toISOString() : r[i]; });
  return o;
}

function read(tabs, auctionId) {
  const out = {};
  tabs.forEach(t => {
    const { head, data } = rows(t);
    const ai = head.indexOf('auctionId');
    out[t] = data
      .filter(r => auctionId == null || ai === -1 || String(r[ai]) === String(auctionId))
      .map(r => toObj(head, r));
  });
  return out;
}

function keyOf(keys, o) { return keys.map(k => String(o[k])).join('|'); }

function upsert(tab, list, user) {
  if (!KEYS[tab]) throw new Error('Tab ' + tab + ' is read-only');
  const keys = KEYS[tab];
  const { sh, head, data } = rows(tab);
  const index = {};
  data.forEach((r, i) => { index[keyOf(keys, toObj(head, r))] = i; });
  const now = new Date().toISOString();
  const appended = [];
  const logs = [];
  list.forEach(o => {
    keys.forEach(k => { if (o[k] === undefined || o[k] === '') throw new Error(tab + ' row is missing ' + k); });
    if (head.indexOf('updatedAt') !== -1) { o.updatedAt = now; o.updatedBy = user; }
    const k = keyOf(keys, o);
    if (k in index) {
      const i = index[k];
      const changed = [];
      head.forEach((h, c) => {
        if (h && o[h] !== undefined && String(data[i][c]) !== String(o[h])) {
          if (h !== 'updatedAt' && h !== 'updatedBy' && h !== 'lastSync') changed.push(h + ': ' + data[i][c] + ' → ' + o[h]);
          data[i][c] = o[h];
        }
      });
      if (changed.length && tab !== 'Lots') logs.push([now, user, 'update', tab, k, changed.join('; ').slice(0, 500)]);
    } else {
      appended.push(head.map(h => (o[h] === undefined ? '' : o[h])));
      if (tab !== 'Lots') logs.push([now, user, 'add', tab, k, '']);
    }
  });
  if (data.length) sh.getRange(2, 1, data.length, head.length).setValues(data);
  if (appended.length) sh.getRange(sh.getLastRow() + 1, 1, appended.length, head.length).setValues(appended);
  if (logs.length) {
    const lg = sheet('Log');
    lg.getRange(lg.getLastRow() + 1, 1, logs.length, logs[0].length).setValues(logs);
  }
  return { saved: list.length };
}

function remove(tab, o, user) {
  if (tab !== 'Fees') throw new Error('Only fees can be removed');
  const { sh, head, data } = rows(tab);
  const k = keyOf(KEYS[tab], o);
  for (let i = 0; i < data.length; i++) {
    if (keyOf(KEYS[tab], toObj(head, data[i])) === k) {
      sh.deleteRow(i + 2);
      sheet('Log').appendRow([new Date().toISOString(), user, 'remove', tab, k, JSON.stringify(toObj(head, data[i])).slice(0, 500)]);
      return { removed: 1 };
    }
  }
  return { removed: 0 };
}
