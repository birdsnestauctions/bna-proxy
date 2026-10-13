// Countdown timer GIF for emails.
// GET /timer?end=2026-10-15T19:05            (Eastern time assumed when no offset given)
// Optional: &bg=ffffff &fg=2D6B5E &accent=E8806B &label=6B7280
//
// Each request renders a fresh 60-second animated GIF counting down from "now",
// so every email open shows the correct time remaining.

const path = require('path');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');

GlobalFonts.registerFromPath(path.join(__dirname, 'fonts/dm-sans-latin-700-normal.woff2'), 'BNA Bold');
GlobalFonts.registerFromPath(path.join(__dirname, 'fonts/dm-sans-latin-600-normal.woff2'), 'BNA Semi');

const TZ = 'America/New_York';
const SCALE = 2;              // render at 2x so it stays crisp on phones
const W = 300, H = 76;        // display size in the email (px)
const FRAMES = 60;            // one per second

// ---------- time helpers ----------
function tzOffsetMs(utcMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p = Object.fromEntries(parts.map(x => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - utcMs;
}

// Accepts: unix seconds, ISO with offset/Z, or a plain local "YYYY-MM-DDTHH:MM" (treated as Eastern).
function parseEnd(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{9,11}$/.test(s)) return Number(s) * 1000;
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s)) {
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m.map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, se || 0);
  let t = guess - tzOffsetMs(guess, TZ);
  t = guess - tzOffsetMs(t, TZ); // second pass handles DST edges
  return t;
}

const hex = (v, fallback) => (/^[0-9a-f]{6}$/i.test(v || '') ? '#' + v : fallback);

// ---------- drawing ----------
function drawFrame(ctx, secondsLeft, colors) {
  const w = W * SCALE, h = H * SCALE;
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  if (secondsLeft <= 0) {
    ctx.fillStyle = colors.fg;
    ctx.font = `${26 * SCALE}px "BNA Bold"`;
    ctx.fillText('Bidding has closed', w / 2, h / 2 + 9 * SCALE);
    return;
  }

  const d = Math.floor(secondsLeft / 86400);
  const hr = Math.floor((secondsLeft % 86400) / 3600);
  const mi = Math.floor((secondsLeft % 3600) / 60);
  const se = secondsLeft % 60;
  const units = [
    [String(d).padStart(2, '0'), 'DAYS'],
    [String(hr).padStart(2, '0'), 'HOURS'],
    [String(mi).padStart(2, '0'), 'MINUTES'],
    [String(se).padStart(2, '0'), 'SECONDS'],
  ];

  const col = w / 4;
  const numY = 46 * SCALE, labelY = 66 * SCALE;
  units.forEach(([num, label], i) => {
    const cx = col * i + col / 2;
    ctx.fillStyle = colors.fg;
    ctx.font = `${40 * SCALE}px "BNA Bold"`;
    ctx.fillText(num, cx, numY);
    ctx.fillStyle = colors.label;
    ctx.font = `${10 * SCALE}px "BNA Semi"`;
    ctx.fillText(label, cx, labelY);
    if (i < 3) {
      ctx.fillStyle = colors.accent;
      ctx.font = `${32 * SCALE}px "BNA Bold"`;
      ctx.fillText(':', col * (i + 1), numY - 4 * SCALE);
    }
  });
}

function renderGif(endMs, nowMs, colors) {
  const canvas = createCanvas(W * SCALE, H * SCALE);
  const ctx = canvas.getContext('2d');
  const start = Math.floor((endMs - nowMs) / 1000);
  const frameCount = start <= 0 ? 1 : Math.min(FRAMES, start + 1);

  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    drawFrame(ctx, Math.max(0, start - i), colors);
    frames.push(ctx.getImageData(0, 0, W * SCALE, H * SCALE).data);
  }

  // One shared palette (built from the first frame) keeps colours stable.
  // The last slot is reserved as "transparent" so later frames only redraw
  // the pixels that changed (mostly the seconds digits) — keeps the file small.
  const palette = quantize(frames[0], 63);
  const TRANSPARENT = palette.length;
  palette.push([255, 0, 255]);
  const gif = GIFEncoder();
  let prev = null;
  frames.forEach((rgba, i) => {
    const full = applyPalette(rgba, palette.slice(0, TRANSPARENT));
    const index = full.slice();
    if (prev) {
      for (let p = 0; p < index.length; p++) if (full[p] === prev[p]) index[p] = TRANSPARENT;
    }
    gif.writeFrame(index, W * SCALE, H * SCALE, {
      palette: i === 0 ? palette : undefined,
      delay: 1000,
      repeat: -1,          // play once, then hold on the last frame
      transparent: i > 0,
      transparentIndex: TRANSPARENT,
      dispose: 1,          // keep previous frame underneath
    });
    prev = full;
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}

// Small cache so a burst of opens in the same second reuses one render.
const cache = new Map();
function cached(key, make) {
  if (cache.has(key)) return cache.get(key);
  const v = make();
  cache.set(key, v);
  if (cache.size > 100) cache.delete(cache.keys().next().value);
  return v;
}

function timerHandler(req, res) {
  const endMs = parseEnd(req.query.end);
  if (endMs == null) {
    return res.status(400).send('Missing or invalid "end". Example: /timer?end=2026-10-15T19:05');
  }
  const colors = {
    bg: hex(req.query.bg, '#FFFFFF'),
    fg: hex(req.query.fg, '#2D6B5E'),
    accent: hex(req.query.accent, '#E8806B'),
    label: hex(req.query.label, '#6B7280'),
  };
  const nowSec = Math.floor(Date.now() / 1000);
  const key = [endMs, nowSec, colors.bg, colors.fg, colors.accent, colors.label].join('|');
  try {
    const buf = cached(key, () => renderGif(endMs, nowSec * 1000, colors));
    res.set({
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.send(buf);
  } catch (err) {
    console.error('Timer error:', err);
    res.status(500).send('Timer error');
  }
}

module.exports = { timerHandler, parseEnd, renderGif };
