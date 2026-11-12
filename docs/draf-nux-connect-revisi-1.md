# Revisi 1 — Draf Nux Connect (amendemen atas `draf-nux-connect.md`)

Tanggal: 2026-11-11. Dokumen ini memuat teks perbaikan yang siap ditempel ke
spesifikasi asli. Setiap butir menyebut lokasi di dokumen asli dan status
keputusannya.

Ringkasan keputusan yang masuk revisi ini:

| # | Butir | Status |
| --- | --- | --- |
| 3 | Jalur derivasi change ditulis eksplisit (BIP84) | Disetujui 2026-11-11 |
| 4 | Gerbang izin origin untuk semua method | Disetujui 2026-11-11 |
| 5 | Pustaka dikunci: bitcoinjs-lib | Diputuskan 2026-11-11 (battle-tested) |
| 6 | Parameter testnet dilengkapi dari chainparams Core | Dilengkapi 2026-11-11, terverifikasi dari source |
| 7 | MVP digeser testnet-first (WAJIB) | Diputuskan 2026-11-11 |
| 8 | Notifikasi koin masuk masuk ruang lingkup MVP | Disetujui 2026-11-11 |
| 9 | Saldo terkonfirmasi = >= 1 konfirmasi | Disahkan 2026-11-11 |
| 10 | Pagar feeRate kiriman dApp: maksimum 546 nusan/vbyte | Disahkan 2026-11-11 (rumusan tarif; versi "total fee" sempat tertulis karena salah tulis dan sudah ditarik kembali) |
| 1 | Mekanisme sesi vault MV3: `chrome.storage.session` | DISAHKAN 2026-11-11 |
| 2 | Format sign message: legacy persis Nusacoin Core | DISAHKAN 2026-11-11 |

---

## Butir 3 — Jalur derivasi (MENGGANTI baris jalur derivasi di tabel parameter, dan menambah paragraf)

Baris tabel baru:

| Jalur derivasi terima | `m/84'/662'/0'/0/<index>` | BIP84, akun pertama, rantai eksternal; index mulai 0 |
| Jalur derivasi change | `m/84'/662'/0'/1/<index>` | BIP84, akun pertama, rantai internal; index mulai 0, naik per transaksi yang menghasilkan change |

Paragraf tambahan setelah tabel parameter:

> Jalur derivasi ditulis lengkap dan tidak boleh ditebak oleh pelaksana.
> Dompet yang baik mendokumentasikan jalurnya secara eksplisit: rantai
> eksternal (`/0/`) hanya untuk alamat terima, rantai internal (`/1/`) hanya
> untuk alamat change, dan kedua index mulai dari 0. Alamat pertama pada
> rantai eksternal, `m/84'/662'/0'/0/0`, adalah alamat yang dipakai uji
> kesesuaian terhadap dompet web.

## Butir 4 — Gerbang izin origin (MENAMBAH sub-bagian di "Izin per situs")

> Semua method provider — termasuk method baca yang tidak membuka jendela
> persetujuan seperti `nux_getAccounts` dan `nux_getBalance` — hanya menjawab
> untuk origin yang sudah terhubung. Bagi origin yang belum terhubung,
> `nux_getAccounts` mengembalikan daftar kosong dan method lain ditolak
> dengan kode 4100. Terpasangnya ekstensi di browser tidak memberi situs mana
> pun hak membaca apa pun; satu-satunya jalan masuk adalah persetujuan
> koneksi oleh pengguna. (Kehadiran objek `window.nux` sendiri dapat dideteksi
> halaman — hal itu diterima pada MVP karena demo dApp membutuhkannya untuk
> menampilkan petunjuk pemasangan; yang digerbang adalah datanya, bukan
> keberadaannya.)

## Butir 5 — Pustaka (MENGGANTI paragraf "Teknologi yang disarankan")

> Teknologi: TypeScript dengan bundler ringan, dan pustaka **bitcoinjs-lib**
> (beserta pendamping standarnya: bip32, ecpair, tiny-secp256k1, bip39) —
> dipilih karena paling teruji (battle-tested) dan ekosistem PSBT-nya paling
> luas. Parameter jaringan Nusacoin dipasang sebagai objek network kustom
> lewat konfigurasi (`bech32: 'nu'`, `pubKeyHash: 0x35`, `scriptHash: 0x4b`,
> `wif: 0x57`), bukan modifikasi kode pustaka. Syarat mutlak tetap berlaku:
> bila suatu pustaka tidak mendukung BIP84, PSBT, atau parameter kustom,
> pustaka itu gugur. Konsekuensi yang disadari: bundling untuk browser
> memerlukan polyfill Buffer dari bundler — itu beban sisi pengembang,
> pengguna tetap menerima ZIP yang sudah terbangun.

Dan pertanyaan terbuka nomor 2 (pilihan pustaka) DINYATAKAN TERJAWAB oleh
butir ini.

## Butir 6 — Testnet (MENGGANTI paragraf testnet yang "baru diketahui sebagian")

> ### Parameter testnet (terverifikasi dari `src/chainparams.cpp`, repo `TaobotX11/nusacoin`)
>
> | Parameter | Testnet |
> | --- | --- |
> | Bech32 HRP | `tn` |
> | P2PKH version byte | `0x6f` (111) |
> | P2SH version byte | `0xc4` (196) |
> | WIF version byte | `0xef` (239) |
> | Port P2P bawaan | 38573 |
> | Message start (magic P2P) | `0x0b110907` |
> | Extended key publik / privat | `0x043587cf` / `0x04358394` (standar tpub/tprv) |
>
> Catatan jujur: chainparams tidak menetapkan coin type — angka itu konvensi
> dompet, bukan konstanta daemon. BIP44/SLIP-0044 mencadangkan coin type 1
> untuk semua testnet, sehingga jalur testnet mengikuti struktur yang sama
> menjadi `m/84'/1'/0'/0/<index>` dan `m/84'/1'/0'/1/<index>`; nilai ini
> ditandai sebagai konvensi, untuk dicocokkan dengan dompet web bila dompet
> web kelak mendukung testnet.
>
> Endpoint REST publik testnet ADA: `https://apinuxtest.taobot.org` — sudah
> dipakai PUNDI Wallet untuk testnet sejak Oktober 2026, dan diverifikasi
> live 2026-11-11: `/blocks/tip/height` menjawab 1381, `/fee-estimates`
> menjawab tarif datar 1.0 untuk semua target, dan alamat `tn1...` pada blok
> tip terbaca normal. (Koreksi atas draf revisi ini sendiri: pernyataan
> sebelumnya bahwa endpoint publik testnet belum ada adalah keliru.)
>
> Jadi status testnet menjadi: **parameter lengkap DAN endpoint publik
> tersedia — tidak ada lagi pengganjal teknis**. Testnet tetap di luar ruang
> lingkup MVP sesuai keputusan awal, tetapi alasan asli keputusan itu
> (parameter testnet baru terverifikasi sebagian) sudah gugur; apakah MVP
> digeser menjadi testnet-first adalah keputusan baru yang belum diputuskan
> saat itu (kemudian diputuskan pada Butir 7).

Dan pertanyaan terbuka nomor 5 (parameter testnet) DINYATAKAN TERJAWAB
sepenuhnya oleh butir ini.

## Butir 1 — Sesi vault MV3 (MENAMBAH sub-bagian di "Vault terenkripsi") — DISAHKAN 2026-11-11

> Mekanisme sesi terbuka: karena service worker MV3 dibunuh browser saat
> diam, keadaan vault terbuka tidak disimpan di memori worker. Kunci pembuka
> vault (bukan kata sandi, bukan mnemonic) disimpan di
> `chrome.storage.session` dengan tingkat akses `TRUSTED_CONTEXTS`, sehingga
> hanya konteks ekstensi sendiri yang dapat membacanya, isinya hanya hidup
> di memori browser, dan terhapus saat browser ditutup. Penguncian otomatis
> 15 menit ditegakkan dengan `chrome.alarms` — alarm tetap berjalan walau
> worker mati — dan saat terkunci isi sesi dihapus. Sesi juga selalu kosong
> saat browser baru mulai. Payload permintaan yang menunggu persetujuan
> tidak mengandung bahan kunci dan dipegang oleh jendela persetujuan itu
> sendiri.

## Butir 2 — Format sign message (MENAMBAH sub-bagian di "Keamanan dan vault") — DISAHKAN 2026-11-11

> Format tanda tangan pesan dikunci mengikuti format legacy Nusacoin Core
> secara persis, supaya tanda tangan dapat diverifikasi silang oleh Core
> (`verifymessage`) dan dompet web: awalan (magic) `Nusacoin Signed
> Message:\n`; hash pesan adalah double-SHA256 atas awalan dan pesan yang
> masing-masing diberi panjang awalan (sesuai `MessageHash` di
> `src/util/message.cpp` Core); tanda tangan adalah tanda tangan ECDSA
> yang dapat dipulihkan (recoverable, 65 byte, sesuai `SignCompact`) yang
> dikodekan base64. Offset byte kepala ala Electrum untuk alamat SegWit
> TIDAK dipakai — Core memulihkan kunci publik dengan format compact
> standar, dan penyimpangan dari format Core akan membuat verifikasi di
> Core gagal. BIP322 tidak dipakai pada MVP: belum ada alat Nusacoin yang
> memverifikasinya.

## Butir 7 — MVP testnet-first (WAJIB) — menggantikan keputusan MVP mainnet di draf asli

Keputusan 2026-11-11: MVP **wajib testnet-first**. Keputusan ini
membatalkan keputusan lama di draf asli ("MVP berjalan di mainnet dengan
dana kecil") yang alasannya adalah parameter testnet yang belum lengkap —
alasan yang sudah gugur oleh butir 6. Teks pengganti untuk bagian-bagian
draf asli:

**Di bagian Parameter jaringan**, kalimat penutup diganti menjadi:

> MVP berjalan di **testnet** lebih dulu (jaringan bawaan ekstensi:
> testnet, backend `https://apinuxtest.taobot.org`). Mainnet bukan bagian
> dari MVP; konfigurasinya disiapkan tetapi dikunci, dan hanya dibuka
> setelah kriteria selesai testnet terpenuhi DAN audit keamanan lolos —
> sesuai aturan tetap tim: pembuktian di testnet sebelum mainnet, audit
> sebelum live.

**Di bagian Ruang lingkup MVP:**

- Yang termasuk: "Satu akun testnet, satu alamat terima SegWit (bech32
  `tn`), dan alamat change internal" — menggantikan bunyi mainnet
  sebelumnya. Jaringan bawaan `nux_getNetwork` mengembalikan `testnet`.
- Yang tidak termasuk: "Mainnet — konfigurasi disiapkan tetapi dikunci
  sampai gerbang testnet + audit terlewati" — menggantikan baris
  "Testnet — parameternya belum lengkap terverifikasi", yang dicabut.

**Di bagian Kriteria selesai**, butir skenario demo diganti menjadi:

> - Skenario demo berjalan ujung-ke-ujung di **testnet**: connect, saldo
>   terbaca benar, pengiriman muncul di backend testnet dan mendapat
>   konfirmasi, penolakan ditangani halus, dan tanda tangan pesan
>   terverifikasi.

Catatan yang tidak berubah dan tidak tertukar:

- Uji alamat pertama terhadap dompet web tetap menjadi jangkar derivasi —
  uji itu vektor offline memakai parameter mainnet (`nu`) dari mnemonic
  yang sama; ia tidak bergantung pada jaringan tempat MVP bertransaksi.
  Jalur testnet (`tn`, coin type konvensi 1) dibuktikan hidup lewat
  penerimaan alamat oleh electrs testnet dan skenario kirim testnet itu
  sendiri.
- Prasyarat demo: dompet demo perlu diisi koin testnet lebih dulu oleh tim
  (tidak ada faucet publik); jumlahnya bebas karena nilainya nol.
- Peringatan "dana kecil" di UI berubah konteks menjadi penanda jaringan
  TESTNET yang mencolok, supaya tidak ada pengguna yang mengira saldo
  testnet adalah dana sungguhan — dan sebaliknya saat mainnet kelak dibuka.

## Butir 8 — Notifikasi koin masuk (MENAMBAH fitur ke ruang lingkup MVP) — Disetujui 2026-11-11

Draf asli tidak mengatur notifikasi sama sekali. Butir ini menambahkannya
ke daftar "Yang termasuk" dalam Ruang lingkup MVP, dengan teks berikut:

> ### Notifikasi koin masuk
>
> - **Dua permukaan.** (1) Notifikasi sistem browser lewat
>   `chrome.notifications`, tampil walau popup tertutup, selalu menyebut
>   jaringan secara eksplisit — pada MVP bunyinya "[TESTNET] NUX masuk:
>   +<jumlah> nusan — menunggu konfirmasi" — supaya tidak pernah tertukar
>   dengan dana mainnet. (2) Lencana (badge) pada ikon toolbar dan entri
>   pada daftar aktivitas di popup; badge terhapus saat popup dibuka.
> - **Mekanisme polling, bukan push.** Service worker dibangunkan berkala
>   oleh `chrome.alarms` (interval bawaan ±1 menit) untuk memeriksa electrs
>   jaringan aktif: daftar UTXO dan status mempool alamat yang dipantau,
>   dibandingkan dengan himpunan txid yang sudah pernah dilihat (tersimpan
>   di `chrome.storage.local`). UTXO baru yang memenuhi aturan di bawah
>   memicu notifikasi. Tidak ada server pendorong (push) yang dibangun —
>   API bawaan browser cukup, dan pola ini sengaja dipilih agar tetap
>   ringan. Izin manifest yang ditambahkan: `notifications` dan `alarms`.
> - **Waktu tembak.** Notifikasi pertama ditembak saat transaksi terlihat
>   di mempool (0 konfirmasi). Pada konfirmasi pertama, status entri di
>   daftar aktivitas popup berubah menjadi "terkonfirmasi" dan notifikasi
>   sistem kedua ditembak ("+<jumlah> nusan — terkonfirmasi", dengan id
>   berbeda dari notifikasi pertama). Jadi satu transaksi menghasilkan
>   dua notifikasi dengan status berbeda: jeda penambangan terjadwal bisa
>   panjang, sehingga konfirmasi perlu diberitahukan tersendiri.
>   (Diubah 2026-11-12; sebelumnya hanya satu notifikasi.)
> - **Aturan anti-change (wajib).** Notifikasi hanya untuk UTXO pada
>   alamat rantai terima (`/0/x`) yang transaksi pembuatnya TIDAK memakai
>   input dari alamat dompet sendiri — diperiksa dari `vin.prevout` pada
>   `GET /tx/<txid>` di electrs. Output change milik sendiri tidak pernah
>   memicu notifikasi. (Pelajaran dari dompet lain di tim: notifikasi
>   "koin masuk" untuk kembalian sendiri adalah kebisingan yang
>   membingungkan pengguna.)
> - **Berjalan saat vault terkunci.** Yang dipantau adalah alamat publik;
>   pemantauan tidak memerlukan vault terbuka dan isi notifikasi tidak
>   mengandung bahan sensitif apa pun.
> - **Batas yang dinyatakan apa adanya.** Ada jeda sampai satu interval
>   polling; bila browser tertutup, tidak ada notifikasi sampai browser
>   dibuka lagi — selisihnya tertangkap pada pemeriksaan pertama setelah
>   browser berjalan dan tetap diberitahukan saat itu.
> - **Pengaturan.** Saklar notifikasi di popup, bawaan menyala, dapat
>   dimatikan pengguna.

## Butir 9 — Definisi saldo terkonfirmasi (MENAMBAH definisi di Provider API & Backend) — Disahkan 2026-11-11

> Saldo **terkonfirmasi** adalah jumlah UTXO dengan **>= 1 konfirmasi**
> — pada respons alamat Esplora, inilah bagian `chain_stats`. Saldo
> **belum terkonfirmasi** adalah bagian `mempool_stats` (0 konfirmasi).
> Definisi ini berlaku sama untuk tampilan popup dan hasil
> `nux_getBalance`; tidak ada ambang lain (dengan blok Nusacoin yang
> renggang, ambang lebih tinggi membuat demo tidak praktis, dan pemisahan
> kedua angka di API memang sudah tersedia).

## Butir 10 — Pagar feeRate kiriman dApp (MENAMBAH aturan di Provider API & PSBT) — Disahkan 2026-11-11

> `feeRate` pilihan pada `nux_sendTransaction` hanya diterima dalam
> rentang **1 sampai 546 nusan/vbyte**. Nilai di luar rentang itu ditolak
> dengan kode -32602 (parameter tidak sah) sebelum jendela persetujuan
> dibuka; tanpa `feeRate`, ekstensi memakai tarif jaringan aktif (bawaan
> 1 nusan/vbyte). Plafon 546 memakai ulang konstanta dust jaringan sebagai
> plafon kewarasan — 546 kali tarif datar saat ini, jauh di atas kebutuhan
> transaksi sah mana pun, dan cukup untuk menahan tarif absurd kiriman
> dApp. Pemeriksaan yang sama berlaku pada PSBT: tarif tersirat hasil
> hitung ulang ekstensi (fee total dibagi vsize) yang melampaui 546
> nusan/vbyte ditolak di jendela persetujuan.
>
> Karena pagarnya menempel pada **tarif**, bukan total fee, transaksi
> dengan banyak input tetap tertangani wajar: total fee-nya membesar
> mengikuti ukuran transaksi, tarifnya tidak berubah.
>
> Riwayat butir ini: rumusan "total fee maksimum 546 nusan per transaksi"
> sempat tertulis menggantikan rumusan tarif di atas, lalu ditarik kembali
> pada hari yang sama sebagai salah tulis. Rumusan yang sah
> adalah rumusan tarif pada butir ini.

## Catatan fase lanjutan — Lightning (di luar MVP, di luar revisi ini)

Dikonfirmasi 2026-11-11: kelak NUX Connect akan ditambah fitur
Lightning, mengikuti pola Alby yang sudah terbukti di ekosistem Bitcoin.
Bentuknya dicatat sekarang supaya arahnya tidak berubah, tetapi TIDAK
mengubah ruang lingkup MVP testnet-first yang on-chain:

- Extension tetap antarmuka + provider (padanan WebLN untuk NUX); node
  Lightning TIDAK berjalan di dalam browser — MV3 tidak bisa menjadi rumah
  node yang harus selalu online.
- Node Lightning berada di luar browser: node ELNUX pengguna (aplikasi)
  atau hub, dan `lsp_server` berperan sebagai LSP penyedia channel JIT —
  peran yang sudah dijalankannya untuk ELNUX.
- Protokol penghubung extension ↔ node (padanan NWC) belum dipilih;
  itu keputusan fase Lightning, bukan fase ini.

## Pertanyaan terbuka — status terbaru setelah revisi ini

- Fee: TERJAWAB. Endpoint `/fee-estimates` ada di KEDUA instans (dicek
  2026-11-11) dan sama-sama mengembalikan tarif datar 1.0 untuk semua
  target; tarif bawaan MVP 1 nusan/vbyte. Aturan sumbernya: fee rate SELALU
  diambil dari endpoint jaringan yang sedang aktif (testnet dari
  apinuxtest.taobot.org, mainnet dari apinux.taobot.org) — tidak pernah
  lintas jaringan, karena estimasi fee mencerminkan mempool dan kebijakan
  instans jaringan itu sendiri; kedua nilai kebetulan sama hari ini hanya
  karena kedua instans mengembalikan tarif datar yang sama. Bila endpoint
  jaringan aktif gagal dijangkau, cadangannya adalah tarif bawaan 1
  nusan/vbyte, bukan endpoint jaringan lain.
- Pustaka: TERJAWAB — bitcoinjs-lib (butir 5).
- Parameter testnet: TERJAWAB — butir 6; endpoint publik juga TERJAWAB:
  apinuxtest.taobot.org (terverifikasi live 2026-11-11).
- Jaringan MVP: TERJAWAB — testnet-first, wajib (butir 7).
- Konfirmasi untuk saldo "terkonfirmasi": TERJAWAB — >= 1 konfirmasi
  (butir 9).
- Pagar kewarasan fee: TERJAWAB — feeRate kiriman dApp diterima dalam
  rentang 1–546 nusan/vbyte (butir 10).
- Tautan penjelajah resmi dari txid: masih terbuka.
