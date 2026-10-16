// Xtream / IPTV akış proxy'si (Vercel Node serverless).
// Çağrı: /api/x?url=<http(s) adres>[&ua=...][&ref=...]
// - http://host:PORT (özel port) ve IP adreslerine bağlanır (Cloudflare Worker'ların 1003 hatası yok)
// - 301/302 yönlendirmelerini sunucu tarafında takip eder (IP'ye yönlenenler dahil)
// - m3u8 içindeki segment/anahtar adreslerini yine bu proxy'ye çevirir
// - Range başlığını iletir (film/dizi sarma), CORS başlıklarını ekler
// Vercel süre sınırı (vercel.json maxDuration) dolunca sonsuz TS akışı kesilir; HLS (m3u8) etkilenmez.
const { Readable } = require('stream');

const DEF_UA = 'VLC/3.0.20 LibVLC/3.0.20';
const ALLOW = (process.env.XT_ALLOW || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); // boş = hepsi

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range,Content-Type');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges,Content-Type');
}
function isPrivate(h) {
  if (process.env.XT_ALLOW_PRIVATE === '1') return false; // yalnızca yerel test için
  h = h.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return h === '::1' || h.startsWith('[');
  const a = +m[1], b = +m[2];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
function allowed(u) {
  if (!/^https?:$/.test(u.protocol)) return false;
  if (isPrivate(u.hostname)) return false;
  if (ALLOW.length && !ALLOW.some(a => u.hostname.toLowerCase() === a || u.hostname.toLowerCase().endsWith('.' + a))) return false;
  return true;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end('method'); }

  const q = new URL(req.url, 'http://x').searchParams;
  let target;
  try { target = new URL(q.get('url') || ''); } catch (e) { res.statusCode = 400; return res.end('url?'); }
  if (!allowed(target)) { res.statusCode = 403; return res.end('izin yok'); }

  const self = '/api/x?url=';
  const base = (req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host + self;
  const ua = q.get('ua') || DEF_UA, ref = q.get('ref') || '';
  const headers = { 'User-Agent': ua, Accept: '*/*', Connection: 'keep-alive' };
  if (ref) headers.Referer = ref;
  if (req.headers.range) headers.Range = req.headers.range;

  const ac = new AbortController();
  res.on('close', () => ac.abort());

  let cur = target, up = null;
  try {
    for (let i = 0; i < 6; i++) {
      up = await fetch(cur, { method: req.method, headers, redirect: 'manual', signal: ac.signal });
      if (up.status >= 300 && up.status < 400 && up.headers.get('location')) {
        const nx = new URL(up.headers.get('location'), cur);
        if (!allowed(nx)) { res.statusCode = 403; return res.end('yönlendirme izin yok'); }
        try { up.body && up.body.cancel(); } catch (e) {}
        cur = nx; continue;
      }
      break;
    }
  } catch (e) {
    if (ac.signal.aborted) return;
    res.statusCode = 502; return res.end('kaynak hatası: ' + String(e && e.message || e).slice(0, 120));
  }

  const ct = up.headers.get('content-type') || '';
  const isM3u8 = /mpegurl/i.test(ct) || /\.m3u8($|\?)/i.test(cur.pathname + cur.search);
  if (isM3u8 && req.method === 'GET') {
    const txt = await up.text();
    if (/^\s*#EXTM3U/.test(txt)) {
      const extra = (q.get('ua') ? '&ua=' + encodeURIComponent(q.get('ua')) : '') + (ref ? '&ref=' + encodeURIComponent(ref) : '');
      const wrap = u => base + encodeURIComponent(new URL(u, cur).href) + extra;
      const out = txt.split(/\r?\n/).map(l => {
        const t = l.trim();
        if (!t) return l;
        if (t.startsWith('#')) return l.replace(/URI="([^"]+)"/g, (m, u) => 'URI="' + wrap(u) + '"');
        return wrap(t);
      }).join('\n');
      res.statusCode = up.status;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(out);
    }
    // m3u8 görünümlü ama içerik başka (ham TS / hata metni): olduğu gibi ilet
    res.statusCode = up.status;
    if (ct) res.setHeader('Content-Type', ct);
    return res.end(txt);
  }

  res.statusCode = up.status;
  ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach(h => { const v = up.headers.get(h); if (v) res.setHeader(h, v); });
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'HEAD' || !up.body) return res.end();
  const rs = Readable.fromWeb(up.body);
  rs.on('error', () => { try { res.end(); } catch (e) {} });
  rs.pipe(res);
};
