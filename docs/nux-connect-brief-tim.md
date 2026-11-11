# NUX Connect — Brief Arah Proyek untuk Tim

Dokumen pengarahan resmi proyek ekstensi browser dompet Nusacoin (NUX).
Seluruh keputusan di dokumen ini sudah dikunci; pembangunan tinggal
mengikuti. Spesifikasi induk: `draf-nux-connect.md` beserta amendemen
`draf-nux-connect-revisi-1.md` (10 butir, semua sah per 2026-11-11).

## 1. Apa yang dibangun

Ekstensi browser "Connect Wallet" untuk Nusacoin dengan pola interaksi
seperti MetaMask, disesuaikan dengan model UTXO — padanan Nusacoin dari
pola provider EIP-1193 di Ethereum dan WebLN di Bitcoin Lightning.
Ruang lingkup versi pertama: **demo dApp saja**. Bukan dompet produksi
untuk dana besar, bukan integrasi toko, bukan portal sekolah.

## 2. Arah yang sudah dikunci (tidak dibuka kembali)

- **Testnet-first, wajib.** MVP berjalan di testnet lebih dulu; jaringan
  bawaan ekstensi adalah testnet dengan backend
  `https://apinuxtest.taobot.org`. Konfigurasi mainnet disiapkan tetapi
  dikunci; mainnet hanya dibuka setelah kriteria selesai testnet
  terpenuhi **dan** audit keamanan lolos.
- **Pemasangan tanpa build step bagi pengguna:** ZIP rilis berisi folder
  yang sudah terbangun, dipasang lewat Load unpacked. Sisi pengembang
  memakai TypeScript + bundler ringan.
- **Backend tidak dibangun baru:** electrs gaya Esplora yang sudah
  berjalan (mainnet `https://apinux.taobot.org`, testnet
  `https://apinuxtest.taobot.org`). Seluruh endpoint yang dibutuhkan
  sudah diverifikasi hidup, termasuk `/fee-estimates` (tarif datar 1.0).
- **Pustaka dikunci: bitcoinjs-lib** (battle-tested), parameter Nusacoin
  sebagai objek network kustom lewat konfigurasi — bukan modifikasi kode
  pustaka.

## 3. Arsitektur (Manifest V3, empat komponen)

Provider inpage (`window.nux`, satu-satunya permukaan bagi dApp) →
content script (jembatan pesan) → background service worker (vault, izin
per situs, penyusunan dan penandatanganan transaksi) → antarmuka (popup
+ jendela persetujuan terpisah). Kunci privat tidak pernah dapat
dijangkau halaman web; yang keluar ke situs hanya alamat, tanda tangan,
dan txid. Provider menyediakan 8 method `nux_*` (`nux_requestAccounts`,
`nux_getAccounts`, `nux_getBalance`, `nux_getNetwork`,
`nux_sendTransaction`, `nux_signMessage`, `nux_signPsbt`,
`nux_sendPsbt`), event `accountsChanged` dan `networkChanged`, serta
kode error 4001 / 4100 / 4200 / -32602. Semua jumlah dalam nusan integer.

## 4. Keputusan teknis hasil Revisi 1 (ringkasan)

1. **Sesi vault MV3:** kunci pembuka vault (bukan kata sandi, bukan
   mnemonic) disimpan di `chrome.storage.session` dengan akses
   `TRUSTED_CONTEXTS`; auto-lock 15 menit ditegakkan `chrome.alarms`.
   Frasa hanya pernah tersimpan terenkripsi (AES-GCM) di vault; private
   key tidak pernah tersimpan — diturunkan sesaat saat menandatangani.
2. **Sign message = format legacy Nusacoin Core, persis:** magic
   `Nusacoin Signed Message:\n`, double-SHA256 atas magic + pesan
   (length-prefixed), tanda tangan recoverable `SignCompact` base64 —
   dapat diverifikasi silang oleh Core (`verifymessage`) dan dompet web.
   BIP322 tidak dipakai.
3. **Jalur derivasi tertulis eksplisit (BIP84):** terima
   `m/84'/662'/0'/0/<index>`, change `m/84'/662'/0'/1/<index>`, index
   mulai 0. Jalur tidak boleh ditebak pelaksana.
4. **Semua method tergating izin origin,** termasuk method baca: situs
   yang belum terhubung menerima daftar akun kosong / penolakan 4100.
   Terpasangnya ekstensi tidak memberi hak baca apa pun; koneksi hanya
   lewat persetujuan pengguna.
5. **Pustaka:** bitcoinjs-lib (butir 2 di atas).
6. **Parameter testnet lengkap** dari `src/chainparams.cpp` Core:
   HRP `tn`, P2PKH `0x6f`, P2SH `0xc4`, WIF `0xef`, port P2P 38573,
   magic `0x0b110907`, extended key standar tpub/tprv. Coin type testnet
   mengikuti konvensi BIP44 (1) dan ditandai sebagai konvensi.
   Parameter mainnet: HRP `nu`, coin type 662, P2PKH `0x35`, P2SH
   `0x4b`, WIF `0x57`, dust 546 nusan.
7. **MVP testnet-first** (butir 2 di atas).
8. **Notifikasi koin masuk termasuk MVP:** polling `chrome.alarms`
   (±1 menit) ke electrs jaringan aktif; notifikasi sistem browser yang
   selalu menyebut jaringan + badge ikon + daftar aktivitas popup;
   ditembak saat transaksi terlihat di mempool; status menjadi
   terkonfirmasi pada 1 konfirmasi tanpa notifikasi kedua. Aturan
   anti-change wajib: UTXO change milik sendiri tidak pernah memicu
   notifikasi (diperiksa dari `vin.prevout`). Pemantauan berjalan saat
   vault terkunci karena yang dipantau adalah alamat publik.
9. **Saldo terkonfirmasi = >= 1 konfirmasi** (`chain_stats` Esplora);
   belum terkonfirmasi = `mempool_stats`.
10. **Pagar feeRate:** tarif kiriman dApp diterima hanya dalam rentang
    1–546 nusan/vbyte, di luar itu ditolak -32602; tarif tersirat PSBT
    hasil hitung ulang ekstensi dibatasi plafon yang sama. Fee selalu
    diambil dari endpoint jaringan yang sedang aktif — tidak pernah
    lintas jaringan; cadangan saat endpoint tak terjangkau adalah tarif
    bawaan 1 nusan/vbyte.

## 5. Keamanan (syarat minimum, bukan fitur tambahan)

Vault terenkripsi kata sandi; izin koneksi per origin dan dapat dicabut;
jendela persetujuan menampilkan transaksi yang sudah diterjemahkan
(tujuan, jumlah, fee, total keluar) dengan tombol setuju yang tidak
aktif sesaat; aturan PSBT ketat (hanya input milik dompet sendiri, fee
dihitung ulang, change yang dialihkan ditolak). Batasan yang dinyatakan
terbuka: ekstensi demo bukan dompet perangkat keras dan tidak melindungi
dari komputer yang terinfeksi.

## 6. Kriteria selesai MVP

- Alamat derivasi pertama sama persis dengan dompet web yang sudah ada
  (uji vektor dari mnemonic yang sama).
- Skenario demo berjalan ujung-ke-ujung di testnet: pasang → buat dompet
  → Connect → saldo terbaca → kirim → tolak satu permintaan → tanda
  tangani pesan dan verifikasi.
- PSBT dApp dapat ditandatangani dan disiarkan; PSBT yang diubah diam-diam
  tertolak atau ketahuan di jendela persetujuan.
- Pengguna baru dapat memasang hanya dengan petunjuk tertulis.

## 7. Fase setelah MVP (arah, bukan janji versi)

Lightning akan ditambahkan mengikuti pola Alby: ekstensi tetap
antarmuka + provider, node Lightning hidup di luar browser (node ELNUX
pengguna atau hub), dan LSP yang sudah berjalan berperan sebagai
penyedia channel JIT. Integrasi toko dan portal sekolah juga fase
berikutnya.

## 8. Pembagian ranah kontribusi

Kontribusi kode diterima melalui pull request; setiap PR mengikuti
spesifikasi induk dan amendemennya — keputusan terkunci tidak
diperdebatkan ulang di PR. Ranah yang dapat dikerjakan paralel:
(a) vault dan kriptografi (BIP39/BIP84, enkripsi, sesi MV3);
(b) provider dan jembatan pesan (inpage, content script, background);
(c) mesin transaksi UTXO (coin selection, fee, PSBT, broadcast);
(d) antarmuka (popup, jendela persetujuan, badge dan notifikasi);
(e) demo dApp dan pengujian ujung-ke-ujung di testnet.
Aturan tetap tim berlaku: tulisan teknis di repo dalam bahasa Inggris
yang rapi; pekerjaan melalui PR dan ditinjau sebelum digabung.
