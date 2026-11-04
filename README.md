# MPK AHWAYA ARADHANA - SMKN 1 Cilacap (Cloudflare Workers)

Proyek ini harus di-deploy dengan **wrangler** (bukan upload drag & drop), karena punya halaman admin,
login, dan upload foto. Data disimpan di Workers KV, foto upload juga di KV.

## Deploy (sekali setup)
Butuh Node.js 18+ dan akun Cloudflare.

1. Di folder proyek:  `npm install`  lalu  `npx wrangler login`
2. Buat penyimpanan KV:  `npx wrangler kv namespace create MPK_KV`
   Salin `id` yang muncul, tempel ke `wrangler.jsonc` menggantikan `ISI_ID_KV_DI_SINI`.
3. (Disarankan) Set password admin awal, supaya tidak memakai admin123:
   `npx wrangler secret put ADMIN_PASSWORD`   (hanya berlaku saat data pertama kali dibuat)
4. Deploy:  `npx wrangler deploy`
5. Pasang domain: Dashboard Cloudflare -> Workers & Pages -> mpk-ahwaya-aradhana
   -> Settings -> Domains & Routes -> Add -> Custom Domain.
   (Jika domain itu sebelumnya terpasang di proyek Pages lama, lepas dulu dari proyek tersebut.)

Admin: `https://domainanda/admin/login`  (username `admin`; password = ADMIN_PASSWORD, atau `admin123` jika tidak diset -> segera ganti di menu Akun).

## Update berikutnya
Cukup `npx wrangler deploy` lagi. Data di KV tidak terhapus.

## Coba lokal
`npx wrangler dev` lalu buka http://localhost:8787 (KV disimulasikan lokal).

## Catatan
- Ukuran foto maksimal 3 MB (jpg/png/webp/gif).
- Perubahan dari admin bisa butuh hingga sekitar 1 menit untuk terlihat di lokasi server Cloudflare lain (sifat KV).
