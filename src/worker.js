// MPK AHWAYA ARADHANA - SMKN 1 Cilacap  (versi Cloudflare Workers)
// Data (JSON) + foto upload disimpan di Workers KV (binding: MPK_KV). File statis dari folder public/.

let env, db, cur;
const DB_KEY = 'db';
const enc = new TextEncoder();

/* ---------------- Helper kripto ---------------- */
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64u = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');
const safeEq = (a, b) => { a = String(a); b = String(b); let d = a.length ^ b.length; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0); return d === 0; };

async function pbkdf2(pw, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}
async function hashPw(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$100000$${b64(salt)}$${b64(await pbkdf2(pw, salt, 100000))}`;
}
async function verifyPw(pw, stored) {
  const [t, it, s, h] = String(stored).split('$');
  if (t !== 'pbkdf2') return false;
  return safeEq(b64(await pbkdf2(pw, unb64(s), +it)), h);
}
const secret = () => env.SESSION_SECRET || db.secret;
async function sign(data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
const SESSION_MS = 8 * 3600e3;
const sessionSig = exp => sign(`admin|${exp}|${db.admin.hash}`); // ganti password => semua sesi lama batal

/* ---------------- Database (JSON di KV) ---------------- */
const defaults = async () => ({
  seq: 100,
  admin: { username: 'admin', hash: await hashPw(env.ADMIN_PASSWORD || 'admin123'), def: !env.ADMIN_PASSWORD },
  secret: randHex(32),
  setting: {
    tagline: 'Satu suara, satu aksi, satu Cilacap yang berdaya.',
    tentang: 'MPK Ahwaya Aradhana adalah Majelis Perwakilan Kelas SMK Negeri 1 Cilacap. Kami hadir sebagai jembatan aspirasi siswa, pengawas kegiatan OSIS, dan penggerak demokrasi di lingkungan sekolah.',
    visi: 'Mewujudkan MPK yang aspiratif, transparan, dan berintegritas demi sekolah yang partisipatif.',
    misi: 'Menampung dan menindaklanjuti aspirasi siswa secara terbuka\nMengawasi program kerja OSIS secara objektif dan konstruktif\nMempublikasikan kegiatan dan laporan kerja secara berkala\nMenumbuhkan budaya kritis, santun, dan bertanggung jawab',
    alamat: 'SMK Negeri 1 Cilacap, Cilacap, Jawa Tengah',
    wa: '6281234567890', instagram: 'https://instagram.com/', email: 'mpk@smkn1cilacap.sch.id'
  },
  komisi: [
    { id: 1, ikon: '⚖️', nama: 'Komisi A - Organisasi & Hukum', deskripsi: 'Menjaga aturan dan tata organisasi.', tugas: 'Mengawasi AD/ART\nMenyusun peraturan internal', ketua: '' },
    { id: 2, ikon: '📣', nama: 'Komisi B - Aspirasi & Advokasi', deskripsi: 'Mengelola dan menindaklanjuti aspirasi siswa.', tugas: 'Menerima aspirasi\nMenyampaikan ke pihak sekolah', ketua: '' }
  ],
  anggota: [], kegiatan: [], aspirasi: []
});
async function loadDb() {
  const raw = await env.MPK_KV.get(DB_KEY, 'json');
  if (raw) return raw;
  const d = await defaults();
  await env.MPK_KV.put(DB_KEY, JSON.stringify(d));
  return d;
}
const save = () => { cur.dirty = true; };
const nextId = () => ++db.seq;

/* ---------------- Foto upload (KV) ---------------- */
const IMG_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const MAX_IMG = 3 * 1024 * 1024;
function saveImg(f) { cur.files.push(f); return f.filename; }
function rmImg(name) { if (name) cur.del.push(name); }
async function serveImg(name, e) {
  if (!/^[\w.-]+$/.test(name)) return new Response('Not found', { status: 404 });
  const { value, metadata } = await e.MPK_KV.getWithMetadata('img:' + name, 'arrayBuffer');
  if (!value) return new Response('Not found', { status: 404 });
  return new Response(value, { headers: { 'content-type': metadata?.type || 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' } });
}

/* ---------------- Mini router (pengganti Express) ---------------- */
const routes = [];
const addRoute = (method, p, fns) => {
  const keys = [];
  const re = new RegExp('^' + p.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, fns });
};
const app = {
  get: (p, ...f) => addRoute('GET', p, f),
  post: (p, ...f) => addRoute('POST', p, f),
  use: f => routes.push({ method: '*', re: /^.*$/, keys: [], fns: [f] })
};
const upload = { single: () => (req, res, next) => next() }; // form sudah di-parse di handle()

let chain = Promise.resolve(); // satu permintaan dinamis sekali jalan per isolate (cegah tabrakan tulis)
const locked = fn => { const run = chain.then(fn); chain = run.catch(() => { }); return run; };

async function handle(request, e) {
  env = e;
  const url = new URL(request.url);
  const method = request.method === 'HEAD' ? 'GET' : request.method;
  db = await loadDb();
  const c = cur = { dirty: false, files: [], del: [] };
  const startHash = db.admin.hash;

  // sesi (cookie bertanda tangan)
  const session = { admin: false, destroy(cb) { this.admin = false; this._destroy = true; cb && cb(); } };
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(request.headers.get('cookie') || '');
  let hadCookie = false;
  if (m) {
    const [exp, sig] = m[1].split('.');
    if (+exp > Date.now() && sig && safeEq(sig, await sessionSig(exp))) { session.admin = true; hadCookie = true; }
  }

  const req = {
    method, path: url.pathname, query: Object.fromEntries(url.searchParams), params: {}, body: {}, file: null, session,
    ip: request.headers.get('cf-connecting-ip') || 'local'
  };
  if (method === 'POST' && /form/i.test(request.headers.get('content-type') || '')) {
    try {
      const fd = await request.formData();
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') req.body[k] = v;
        else if (k === 'foto' && v.size > 0 && v.size <= MAX_IMG && IMG_TYPES[v.type])
          req.file = { filename: Date.now() + '-' + randHex(4) + IMG_TYPES[v.type], buf: await v.arrayBuffer(), type: v.type };
      }
    } catch { return new Response('Permintaan tidak valid', { status: 400 }); }
  }

  const out = { status: 200, headers: new Headers(), body: null };
  const res = {
    status(n) { out.status = n; return res; },
    send(b) { out.body = b; out.headers.set('content-type', 'text/html; charset=utf-8'); return res; },
    redirect(to) {
      if (to === 'back') { try { const r = new URL(request.headers.get('referer')); to = r.pathname + r.search; } catch { to = '/admin'; } }
      out.status = 302; out.headers.set('location', to); out.body = null; return res;
    }
  };

  const fns = [];
  for (const r of routes) {
    if (r.method !== '*' && r.method !== method) continue;
    const mm = r.re.exec(url.pathname);
    if (!mm) continue;
    const params = {};
    r.keys.forEach((k, i) => { try { params[k] = decodeURIComponent(mm[i + 1]); } catch { params[k] = mm[i + 1]; } });
    r.fns.forEach(fn => fns.push([fn, params]));
  }
  let idx = 0;
  const next = async () => { const it = fns[idx++]; if (!it) return; req.params = it[1]; await it[0](req, res, next); };
  try { await next(); } catch (err) { console.error(err); return new Response('Terjadi kesalahan pada server.', { status: 500 }); }

  // simpan perubahan
  for (const f of c.files) await env.MPK_KV.put('img:' + f.filename, f.buf, { metadata: { type: f.type } });
  if (c.dirty) await env.MPK_KV.put(DB_KEY, JSON.stringify(db));
  for (const n of c.del) await env.MPK_KV.delete('img:' + n);

  const secure = url.protocol === 'https:' ? '; Secure' : '';
  if (session._destroy) out.headers.append('set-cookie', `sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
  else if (session.admin && (!hadCookie || db.admin.hash !== startHash)) {
    const exp = Date.now() + SESSION_MS;
    out.headers.append('set-cookie', `sid=${exp}.${await sessionSig(exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${secure}`);
  }
  out.headers.set('cache-control', 'no-store');
  return new Response(request.method === 'HEAD' ? null : out.body, { status: out.status, headers: out.headers });
}

export default {
  async fetch(request, e) {
    if (!e.MPK_KV) return new Response('KV namespace "MPK_KV" belum terpasang. Lihat README.md langkah 2.', { status: 500 });
    const p = new URL(request.url).pathname;
    if (p.startsWith('/uploads/') && request.method === 'GET') return serveImg(p.slice(9), e);
    return locked(() => handle(request, e));
  }
};

/* ---------------- Util ---------------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
const fmtDate = d => d ? new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
const img = (f, alt = '') => f ? `<img src="/uploads/${esc(f)}" alt="${esc(alt)}" loading="lazy">` : `<div class="noimg">${esc((alt || '?')[0])}</div>`;
const hits = {};
function limit(key, max, ms) { const n = Date.now(); hits[key] = (hits[key] || []).filter(t => n - t < ms); if (hits[key].length >= max) return false; hits[key].push(n); return true; }

/* ---------------- Layout ---------------- */
function page(req, title, body, active = '') {
  const s = db.setting;
  const nav = [['/', 'Beranda'], ['/komisi', 'Komisi'], ['/anggota', 'Anggota'], ['/kegiatan', 'Kegiatan'], ['/aspirasi', 'Aspirasi']]
    .map(([h, t]) => `<a href="${h}" class="${active === h ? 'on' : ''}">${t}</a>`).join('');
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | MPK Ahwaya Aradhana</title><link rel="icon" href="/img/logo-mpk.jpg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600;800&family=Plus+Jakarta+Sans:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/style.css"></head><body>
<header class="top"><div class="wrap bar"><a class="brand" href="/"><img src="/img/logo-mpk.jpg" alt="MPK"><span><b>AHWAYA ARADHANA</b><small>MPK SMKN 1 Cilacap</small></span></a>
<input type="checkbox" id="mb" hidden><label for="mb" class="burger">☰</label><nav>${nav}${req.session.admin ? '<a href="/admin" class="pill">Admin</a>' : ''}</nav></div></header>
<main>${body}</main>
<footer><div class="wrap fgrid"><div><img src="/img/logo-smk.jpg" alt="SMKN 1 Cilacap" class="flogo"><p>${esc(s.alamat)}</p></div>
<div><h4>Hubungi</h4><p><a href="https://wa.me/${esc(s.wa)}">WhatsApp</a> · <a href="${esc(s.instagram)}">Instagram</a><br>${esc(s.email)}</p></div>
<div><h4>Akses</h4><p><a href="/aspirasi">Kirim Aspirasi</a><br><a href="/admin/login">Masuk Pengurus</a></p></div></div>
<div class="copy">© ${new Date().getFullYear()} MPK Ahwaya Aradhana · SMK Negeri 1 Cilacap</div></footer></body></html>`;
}

/* ---------------- Halaman Publik ---------------- */
app.get('/', (req, res) => {
  const s = db.setting;
  const keg = [...db.kegiatan].sort((a, b) => b.tanggal.localeCompare(a.tanggal)).slice(0, 3);
  const inti = db.anggota.filter(a => a.tipe === 'Inti').sort((a, b) => a.urutan - b.urutan);
  res.send(page(req, 'Beranda', `
<section class="hero"><div class="wrap hgrid"><div>
<span class="tag">Majelis Perwakilan Kelas</span><h1>MPK<br><em>Ahwaya Aradhana</em></h1><p class="lead">${esc(s.tagline)}</p>
<div class="cta"><a class="btn" href="/aspirasi">Sampaikan Aspirasi</a><a class="btn ghost" href="/kegiatan">Lihat Kegiatan</a></div></div>
<div class="logos"><img src="/img/logo-mpk.jpg" alt="Logo MPK"><img src="/img/logo-smk.jpg" alt="Logo SMKN 1 Cilacap"></div></div></section>
<section class="wrap sec stats"><div><b>${db.anggota.length}</b><span>Anggota</span></div><div><b>${db.komisi.length}</b><span>Komisi</span></div>
<div><b>${db.kegiatan.length}</b><span>Kegiatan</span></div><div><b>${db.aspirasi.filter(a => a.status === 'Selesai').length}</b><span>Aspirasi Selesai</span></div></section>
<section class="wrap sec two"><div><h2>Tentang Kami</h2><p>${esc(s.tentang)}</p></div>
<div class="card"><h3>Visi</h3><p>${esc(s.visi)}</p><h3>Misi</h3><ul>${lines(s.misi).map(m => `<li>${esc(m)}</li>`).join('')}</ul></div></section>
<section class="wrap sec"><div class="head"><h2>Komisi</h2><a href="/komisi">Semua →</a></div><div class="grid">${db.komisi.map(k => `<div class="card kom"><i>${esc(k.ikon)}</i><h3>${esc(k.nama)}</h3><p>${esc(k.deskripsi)}</p></div>`).join('')}</div></section>
${inti.length ? `<section class="wrap sec"><div class="head"><h2>Pengurus Inti</h2><a href="/anggota">Semua →</a></div><div class="grid g4">${inti.map(memberCard).join('')}</div></section>` : ''}
<section class="wrap sec"><div class="head"><h2>Kegiatan Terbaru</h2><a href="/kegiatan">Riwayat →</a></div>
<div class="grid">${keg.map(kegCard).join('') || '<p class="muted">Belum ada kegiatan.</p>'}</div></section>`, '/'));
});
const memberCard = a => `<div class="card mem">${img(a.foto, a.nama)}<h3>${esc(a.nama)}</h3><b>${esc(a.jabatan)}</b><small>${esc(a.kelas)}</small></div>`;
const kegCard = k => `<a class="card keg" href="/kegiatan/${k.id}">${img(k.foto, k.judul)}<div><small>${fmtDate(k.tanggal)}</small><h3>${esc(k.judul)}</h3><p>${esc(k.deskripsi.slice(0, 110))}…</p></div></a>`;

app.get('/komisi', (req, res) => res.send(page(req, 'Komisi', `<section class="wrap sec"><h1 class="ph">Komisi MPK</h1><div class="grid">
${db.komisi.map(k => {
  const ang = db.anggota.filter(a => a.komisiId == k.id);
  return `<div class="card kom big"><i>${esc(k.ikon)}</i><h3>${esc(k.nama)}</h3><p>${esc(k.deskripsi)}</p>
  <h4>Tugas & Fungsi</h4><ul>${lines(k.tugas).map(t => `<li>${esc(t)}</li>`).join('')}</ul>
  <h4>Anggota (${ang.length})</h4><p class="muted">${ang.map(a => esc(a.nama)).join(', ') || '-'}</p></div>`;
}).join('')}</div></section>`, '/komisi')));

app.get('/anggota', (req, res) => {
  const sorted = [...db.anggota].sort((a, b) => a.urutan - b.urutan);
  const inti = sorted.filter(a => a.tipe === 'Inti');
  const groups = db.komisi.map(k => ({ k, m: sorted.filter(a => a.tipe !== 'Inti' && a.komisiId == k.id) })).filter(g => g.m.length);
  res.send(page(req, 'Anggota', `<section class="wrap sec"><h1 class="ph">Struktur & Anggota</h1>
<h2>Pengurus Inti</h2><div class="grid g4">${inti.map(memberCard).join('') || '<p class="muted">Belum ada data.</p>'}</div>
${groups.map(g => `<h2 class="mt">${esc(g.k.nama)}</h2><div class="grid g4">${g.m.map(memberCard).join('')}</div>`).join('')}</section>`, '/anggota'));
});

app.get('/kegiatan', (req, res) => {
  const list = [...db.kegiatan].sort((a, b) => b.tanggal.localeCompare(a.tanggal));
  res.send(page(req, 'Riwayat Kegiatan', `<section class="wrap sec"><h1 class="ph">Riwayat Kegiatan</h1>
<div class="timeline">${list.map(k => `<div class="tl"><time>${fmtDate(k.tanggal)}</time>${kegCard(k)}</div>`).join('') || '<p class="muted">Belum ada kegiatan.</p>'}</div></section>`, '/kegiatan'));
});
app.get('/kegiatan/:id', (req, res) => {
  const k = db.kegiatan.find(x => x.id == req.params.id);
  if (!k) return res.status(404).send(page(req, '404', '<section class="wrap sec"><h1>Kegiatan tidak ditemukan</h1></section>'));
  res.send(page(req, k.judul, `<article class="wrap sec narrow"><small>${fmtDate(k.tanggal)}</small><h1>${esc(k.judul)}</h1>${k.foto ? `<div class="cover">${img(k.foto, k.judul)}</div>` : ''}${esc(k.deskripsi).split('\n').map(p => `<p>${p}</p>`).join('')}<a href="/kegiatan">← Kembali</a></article>`, '/kegiatan'));
});

/* ---------------- Aspirasi ---------------- */
const KATEGORI = ['Sarana & Prasarana', 'Kegiatan Belajar', 'Kegiatan OSIS/Ekskul', 'Kebersihan & Lingkungan', 'Layanan Sekolah', 'Lainnya'];
const badge = s => `<span class="st st-${esc(s)}">${esc(s)}</span>`;

app.get('/aspirasi', (req, res) => {
  const kode = (req.query.kode || '').trim().toUpperCase();
  const found = kode && db.aspirasi.find(a => a.kode === kode);
  const pub = db.aspirasi.filter(a => a.publik).sort((a, b) => b.id - a.id).slice(0, 12);
  res.send(page(req, 'Portal Aspirasi', `<section class="wrap sec"><h1 class="ph">Portal Aspirasi</h1>
${req.query.ok ? `<div class="alert ok">Aspirasi terkirim! Simpan kode pelacakan Anda: <b class="code">${esc(req.query.ok)}</b></div>` : ''}
${req.query.err ? `<div class="alert err">${esc(req.query.err)}</div>` : ''}
<div class="two"><form method="post" action="/aspirasi" class="card form"><h3>Kirim Aspirasi</h3>
<label>Nama<input name="nama" maxlength="60" placeholder="Boleh dikosongkan jika anonim"></label>
<label>Kelas<input name="kelas" maxlength="20" placeholder="contoh: XI TKJ 2"></label>
<label>Kategori<select name="kategori">${KATEGORI.map(k => `<option>${k}</option>`).join('')}</select></label>
<label>Isi Aspirasi<textarea name="isi" rows="5" required minlength="10" maxlength="1500"></textarea></label>
<label class="chk"><input type="checkbox" name="anonim" value="1"> Kirim sebagai anonim</label>
<input type="text" name="website" class="hp" tabindex="-1" autocomplete="off"><button class="btn">Kirim</button></form>
<div><form method="get" class="card form"><h3>Lacak Aspirasi</h3><label>Kode<input name="kode" value="${esc(kode)}" placeholder="ASP-XXXXXX"></label><button class="btn ghost dark">Cek Status</button></form>
${kode ? `<div class="card mt">${found ? `<p>${badge(found.status)} <small>${fmtDate(found.tanggal)}</small></p><p>${esc(found.isi)}</p>${found.balasan ? `<div class="reply"><b>Tanggapan MPK:</b><br>${esc(found.balasan)}</div>` : '<p class="muted">Belum ada tanggapan.</p>'}` : '<p>Kode tidak ditemukan.</p>'}</div>` : ''}</div></div>
<h2 class="mt">Aspirasi Terpublikasi</h2><div class="grid">${pub.map(a => `<div class="card"><p>${badge(a.status)} <small>${esc(a.kategori)}</small></p><p>${esc(a.isi)}</p>${a.balasan ? `<div class="reply"><b>Tanggapan:</b> ${esc(a.balasan)}</div>` : ''}<small class="muted">— ${a.anonim ? 'Anonim' : esc(a.nama || 'Siswa')}</small></div>`).join('') || '<p class="muted">Belum ada.</p>'}</div></section>`, '/aspirasi'));
});
app.post('/aspirasi', (req, res) => {
  const b = req.body;
  if (b.website) return res.redirect('/aspirasi');
  if (!limit('asp' + req.ip, 5, 3600e3)) return res.redirect('/aspirasi?err=' + encodeURIComponent('Terlalu banyak kiriman, coba lagi nanti.'));
  if (!b.isi || b.isi.trim().length < 10) return res.redirect('/aspirasi?err=' + encodeURIComponent('Isi aspirasi minimal 10 karakter.'));
  const kode = 'ASP-' + randHex(3).toUpperCase();
  db.aspirasi.push({
    id: nextId(), kode, nama: (b.nama || '').slice(0, 60), kelas: (b.kelas || '').slice(0, 20),
    kategori: KATEGORI.includes(b.kategori) ? b.kategori : 'Lainnya', isi: b.isi.trim().slice(0, 1500),
    anonim: !!b.anonim, status: 'Baru', balasan: '', publik: false, tanggal: new Date().toISOString()
  });
  save(); res.redirect('/aspirasi?ok=' + kode);
});

/* ---------------- Admin ---------------- */
const needAdmin = (req, res, next) => req.session.admin ? next() : res.redirect('/admin/login');
function adminPage(req, title, body, active) {
  const menu = [['/admin', 'Dashboard'], ['/admin/aspirasi', 'Aspirasi'], ['/admin/kegiatan', 'Kegiatan'], ['/admin/komisi', 'Komisi'], ['/admin/anggota', 'Anggota & Struktur'], ['/admin/pengaturan', 'Pengaturan Situs'], ['/admin/password', 'Akun']];
  return page(req, 'Admin - ' + title, `<div class="wrap adm"><aside>${menu.map(([h, t]) => `<a href="${h
