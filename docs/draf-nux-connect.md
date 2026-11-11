# Draf Nux Connect — Spesifikasi Ekstensi Wallet Nusacoin

Dokumen ini adalah draf spesifikasi untuk membangun ekstensi browser "Connect Wallet" untuk Nusacoin, dengan pola interaksi seperti MetaMask tetapi disesuaikan dengan model UTXO (Unspent Transaction Output). Dokumen ini ditulis agar pekerjaan pembangunan bisa dilakukan di tempat lain — oleh tim atau pengembang lain — tanpa harus mengulang riset dan keputusan yang sudah diambil.

## Keputusan yang sudah dikunci

Tiga keputusan menentukan seluruh rancangan di bawah ini, dan tidak perlu diperdebatkan ulang saat pembangunan dimulai.

- Ruang lingkupnya adalah demo dApp (decentralized application) saja. Bukan dompet produksi untuk dana besar, bukan integrasi pembayaran toko, dan bukan portal sekolah — semua itu fase berikutnya bila demo terbukti jalan.

- Ekstensi harus mudah dipasang di browser. Pengguna akhir tidak menjalankan build step apa pun: ia menerima folder atau ZIP hasil rilis, lalu memasangnya lewat mode pengembang browser.

- Backend tidak dibangun baru. Nusacoin sudah memiliki Electrum Rust (electrs) yang berjalan dan sudah dipakai dompet web yang ada, sehingga ekstensi memakai layanan yang sama lewat API REST-nya.

Konsekuensi dari keputusan pertama: fitur dipangkas sampai yang terkecil yang masih membuktikan alur lengkap — situs meminta koneksi, pengguna menyetujui, situs membaca saldo, situs meminta pembayaran, pengguna menyetujui transaksi yang sudah diterjemahkan, dan transaksi terkirim ke jaringan.

## Parameter jaringan Nusacoin

Parameter berikut terverifikasi dari README repo `TaobotX11/walletweb-dark`, yaitu dompet web yang melayani dompet.nusacoin.org. Nilai ini menjadi konstanta jaringan di kode ekstensi dan tidak boleh ditebak atau diambil dari parameter Bitcoin.

| Parameter | Mainnet | Keterangan |
| --- | --- | --- |
| Bech32 HRP | `nu` | Awalan alamat SegWit |
| Coin type (BIP44) | 662 | Untuk derivasi BIP84 |
| P2PKH version byte | `0x35` | Alamat legacy berawalan N |
| P2SH version byte | `0x4b` | Alamat berawalan X |
| WIF version byte | `0x57` | Format ekspor kunci privat |
| Jalur derivasi | `m/84'/662'/0'/0/0` | BIP84, akun pertama, alamat terima pertama |
| Dust limit | 546 nusan | Output di bawah ini tidak ekonomis dibuat |
| Satuan terkecil | 1 nusan = 0,00000001 NUX | Semua hitungan internal dalam nusan (integer) |

Hal lain yang sudah diketahui tentang jaringan: SegWit aktif, algoritma proof-of-work adalah X11, dan waktu blok sekitar 6 menit — angka terakhir ini penting untuk teks di antarmuka, karena konfirmasi pertama memang tidak secepat jaringan lain dan pengguna demo perlu diberi tahu sejak awal.

Untuk testnet baru diketahui sebagian: P2PKH `0x6f` dan P2SH `0xc4`. Parameter testnet lainnya — HRP bech32, WIF, dan endpoint indexer testnet — belum terverifikasi, sehingga MVP berjalan di mainnet dengan dana kecil dan testnet dicantumkan sebagai pekerjaan lanjutan, bukan janji di versi pertama.

## Arsitektur ekstensi

Ekstensi dibangun sebagai Manifest V3 (MV3), standar ekstensi Chrome, Brave, dan Edge saat ini. Ada empat komponen, dan pemisahannya bukan formalitas: pemisahan inilah yang membuat kunci privat tidak pernah bisa dijangkau halaman web.

- Provider inpage — skrip kecil yang disuntikkan ke halaman dan menyediakan objek `window.nux`. Inilah satu-satunya permukaan yang dilihat dApp. Ia tidak memegang kunci, saldo, atau logika transaksi; tugasnya hanya meneruskan permintaan.

- Content script — jembatan antara halaman dan ekstensi. Ia meneruskan pesan dari provider ke background lewat mekanisme pesan ekstensi, dan menolak pesan yang tidak berasal dari frame halaman itu sendiri.

- Background service worker — otak ekstensi. Di sinilah vault berada, izin per situs disimpan, transaksi disusun, dan tanda tangan dibuat. Ia hanya bangun saat ada permintaan dan kembali tidur sesudahnya, sesuai model MV3.

- Antarmuka pengguna — dua bentuk: popup toolbar untuk urusan dompet (saldo, alamat, kunci/buka vault, daftar situs terhubung), dan jendela persetujuan terpisah yang dibuka background setiap kali dApp meminta koneksi, tanda tangan, atau pembayaran. Jendela persetujuan terpisah dipilih karena popup toolbar tertutup begitu pengguna berpindah fokus — perilaku yang berbahaya di tengah keputusan menyetujui transaksi.

Aliran datanya satu arah dan sempit: dApp berbicara ke provider, provider ke content script, content script ke background, dan background — bila perlu persetujuan — membuka jendela persetujuan. Hasil akhir kembali lewat jalur yang sama. Tidak ada jalur langsung dari halaman ke vault dalam bentuk apa pun.

Teknologi yang disarankan: TypeScript dengan bundler ringan, dan pustaka Bitcoin yang sudah mendukung kustomisasi parameter jaringan (version byte, HRP, coin type) serta PSBT (Partially Signed Bitcoin Transaction). Pilihan pustaka persisnya terbuka, tetapi syaratnya mutlak: parameter jaringan di atas harus bisa dipasang sebagai konfigurasi, bukan hasil modifikasi kode pustaka. Bila pustaka tidak mendukung satu pun dari BIP84, PSBT, atau parameter kustom, pustaka itu gugur.

## Provider API `window.nux`

API meniru pola EIP-1193 yang dipakai MetaMask — satu method `request`, janji (Promise) untuk semua panggilan, dan peristiwa (event) untuk perubahan akun — agar pengembang dApp yang pernah memakai MetaMask langsung merasa familiar. Isinya disesuaikan dengan UTXO: tidak ada konsep gas, nonce, atau saldo akun tunggal ala Ethereum.

### Method

| Method | Parameter | Hasil | Persetujuan pengguna |
| --- | --- | --- | --- |
| `nux_requestAccounts` | — | Daftar alamat aktif | Ya, jendela koneksi |
| `nux_getAccounts` | — | Daftar alamat yang sudah diizinkan situs ini | Tidak |
| `nux_getBalance` | `{ address? }` | Saldo terkonfirmasi dan belum terkonfirmasi, dalam nusan | Tidak |
| `nux_getNetwork` | — | `mainnet` atau `testnet` | Tidak |
| `nux_sendTransaction` | `{ to, amount, feeRate? }` | ID transaksi (txid) | Ya, jendela transaksi |
| `nux_signMessage` | `{ message }` | Tanda tangan dalam base64 | Ya, jendela tanda tangan |
| `nux_signPsbt` | `{ psbt, signInputs? }` | PSBT bertanda tangan, dalam base64 | Ya, jendela transaksi |
| `nux_sendPsbt` | `{ psbt }` | txid, setelah PSBT difinalisasi dan disiarkan | Ya, jendela transaksi |

Jumlah (`amount`) selalu dalam nusan dan selalu bilangan bulat. dApp tidak pernah mengirim jumlah dalam NUX desimal, karena desimal adalah sumber kesalahan pembulatan yang klasik di pembayaran.

### Peristiwa dan kesalahan

Provider memancarkan peristiwa `accountsChanged` saat akun aktif berubah atau izin situs dicabut, dan `networkChanged` saat jaringan berganti. Kesalahan dikembalikan sebagai penolakan Promise dengan kode yang konsisten: `4001` untuk penolakan oleh pengguna, `4100` untuk method yang tidak diizinkan bagi situs ini, `4200` untuk method yang tidak didukung, dan `-32602` untuk parameter yang tidak sah. Penolakan oleh pengguna adalah hasil yang normal, bukan kegagalan sistem, dan dApp demo harus menanganinya tanpa menampilkan pesan kesalahan yang menakutkan.

## Backend: electrs bisa dipakai, lewat API REST gaya Esplora

Jawaban atas pertanyaan awalnya adalah ya — electrs bisa digunakan, dan ekstensi tidak perlu menjalankan electrs sendiri. Dompet web yang sudah ada (`TaobotX11/walletweb-dark`) memakai electrs sebagai sumber datanya lewat API REST gaya Esplora di `https://apinux.taobot.org`, sehingga ekstensi cukup berbicara ke endpoint yang sama.

Satu catatan teknis agar tidak salah paham saat pembangunan: electrs bawaan (upstream) tidak mendukung altcoin begitu saja, jadi instans yang melayani Nusacoin pastilah hasil patch atau fork yang disesuaikan parameter jaringannya. Bagi ekstensi hal ini tidak relevan — yang relevan adalah kontrak API REST-nya.

Endpoint yang dibutuhkan ekstensi dari API gaya Esplora tersebut:

- Data alamat: saldo dan riwayat transaksi per alamat.
- Daftar UTXO per alamat: bahan baku penyusunan transaksi.
- Detail transaksi: status dan jumlah konfirmasi.
- Penyiaran transaksi: mengirim raw transaction yang sudah ditandatangani.
- Perkiraan biaya: tarif per vbyte untuk pilihan kecepatan.

Sebelum pembangunan dimulai, kelima kelompok endpoint ini perlu diuji satu-satu terhadap `https://apinux.taobot.org` dan hasilnya dicatat — terutama perkiraan biaya, karena tidak semua instans Esplora mengeksposnya. Bila perkiraan biaya tidak tersedia, ekstensi memakai tarif bawaan yang konservatif dan menampilkannya apa adanya di jendela persetujuan, bukan menyembunyikannya.

Alternatif yang tercatat bila suatu saat dibutuhkan protokol Electrum murni (bukan REST): repo `electrumx-nusacoin`, yaitu ElectrumX versi Python untuk Nusacoin. Untuk MVP, REST dipilih karena browser dan ekstensi MV3 memang hidup di dunia HTTP, sedangkan protokol Electrum mentah berbasis soket TCP yang tidak tersedia bagi ekstensi.

## Alur transaksi UTXO

Berbeda dengan model akun, di UTXO tidak ada "saldo yang dikurangi". Dompet memilih koin-koin masuk (input), membuat output untuk penerima, dan mengembalikan sisanya sebagai output kembalian (change) ke alamat dompet sendiri. Biaya (fee) adalah selisih antara jumlah input dan jumlah output — tidak ada kolom fee yang terpisah di dalam transaksi itu sendiri.

Alur untuk `nux_sendTransaction` berjalan dalam delapan langkah:

1. dApp memanggil `request({ method: 'nux_sendTransaction', params: [{ to, amount }] })`.
2. Provider meneruskan permintaan ke background; background memeriksa situs ini sudah terhubung, bila belum, koneksi diminta dulu.
3. Background mengambil daftar UTXO alamat aktif dari backend dan memilih input — strategi MVP: pilih UTXO terbesar lebih dulu sampai jumlahnya menutup nominal ditambah perkiraan fee.
4. Background menyusun transaksi: satu output penerima, satu output change ke alamat kembalian milik dompet sendiri (bila sisa melebihi dust limit 546 nusan; bila tidak, sisa dilipat menjadi fee), dan fee dihitung dari ukuran transaksi dalam vbyte dikali tarif terpilih.
5. Jendela persetujuan dibuka menampilkan hasil terjemahan transaksi (lihat bagian keamanan), bukan data mentah.
6. Bila pengguna menyetujui dan vault terbuka, background menandatangani setiap input.
7. Transaksi final disiarkan lewat backend, dan txid dikembalikan ke dApp.
8. dApp menampilkan txid dan tautan pelacakan; status konfirmasi dipantau dari backend, dengan penjelasan bahwa blok Nusacoin sekitar 6 menit.

### Peran PSBT

PSBT adalah format standar untuk transaksi yang belum selesai ditandatangani, dan di Nux Connect ia adalah batas aman antara dApp dan dompet. Lewat `nux_signPsbt`, dApp boleh menyusun transaksinya sendiri — misalnya untuk alur pembayaran yang lebih rumit di masa depan — tetapi penandatanganan tetap terjadi di dalam ekstensi, setelah pengguna melihat terjemahannya.

Aturan PSBT untuk MVP:

- Ekstensi hanya menandatangani input yang berasal dari alamat dompet pengguna sendiri, dan menolak input asing tanpa penjelasan yang jelas di layar.
- Ekstensi memverifikasi ulang jumlah setiap output dan fee total dari PSBT, tidak memercayai ringkasan yang dikirim dApp.
- PSBT yang mengubah alamat change ke pihak lain ditolak; change harus kembali ke dompet.
- Setelah ditandatangani, PSBT dikembalikan ke dApp (`nux_signPsbt`) atau sekalian difinalisasi dan disiarkan oleh ekstensi (`nux_sendPsbt`), sesuai method yang dipanggil.

## Keamanan dan vault

Karena ekstensi ini mengelola kunci yang mengendalikan dana sungguhan — walau dalam demo jumlahnya kecil — tiga hal berikut adalah syarat minimum, bukan fitur tambahan.

### Vault terenkripsi

- Dompet dibuat atau diimpor dari mnemonic (frasa pemulihan). Derivasi mengikuti BIP84 dengan parameter jaringan di atas, sehingga alamat pertama hasil derivasi harus sama dengan alamat yang dihasilkan dompet web yang sudah ada — ini uji kesesuaian pertama yang wajib lolos.
- Mnemonic tidak pernah disimpan sebagai teks biasa. Ia disimpan terenkripsi dengan kunci yang diturunkan dari kata sandi pengguna, di penyimpanan lokal ekstensi.
- Kunci privat hanya ada di memori selama vault terbuka, dan terhapus saat vault dikunci — manual oleh pengguna, atau otomatis setelah waktu diam yang diatur. Nilai bawaan yang disarankan: 15 menit.
- Tidak ada method provider yang mengembalikan mnemonic atau kunci privat, dalam keadaan apa pun. dApp hanya pernah menerima alamat, tanda tangan, dan txid.

### Izin per situs

- Koneksi bersifat per origin: menyetujui satu situs tidak memberi akses apa pun ke situs lain.
- Daftar situs terhubung tampil di popup, dan izin bisa dicabut kapan saja; pencabutan memancarkan `accountsChanged` ke situs bersangkutan.
- Permintaan dari situs yang belum terhubung selalu berhenti di jendela koneksi terlebih dulu — tidak ada koneksi diam-diam.

### Layar persetujuan yang menerjemahkan, bukan menampilkan mentah

Jendela persetujuan adalah pertahanan utama pengguna, jadi isinya diatur ketat:

- Untuk pembayaran: alamat tujuan lengkap, jumlah dalam nusan dan NUX, fee total, tarif yang dipakai, dan jumlah keseluruhan yang keluar dari dompet — semuanya dalam bahasa manusia.
- Untuk PSBT dari dApp: daftar semua output beserta jumlahnya, peringatan mencolok untuk output yang bukan tujuan/change yang dikenali, dan fee total hasil hitung ulang ekstensi.
- Untuk tanda tangan pesan: isi pesan ditampilkan utuh, dengan peringatan bila pesan mengandung teks yang menyerupai alamat atau instruksi pembayaran.
- Origin situs peminta selalu tampil di bagian atas jendela, dan tombol setuju tidak aktif sesaat (sekitar 1 detik) agar klik refleks tidak langsung menyetujui.

Batasan yang disadari sejak awal: ekstensi demo ini bukan dompet perangkat keras dan tidak melindungi dari komputer yang sudah terinfeksi. Karena itu demo dijalankan dengan dana kecil, dan batasan ini ditulis di halaman demo, bukan disembunyikan.

## Demo dApp

Demo dApp adalah satu halaman web statis yang bisa dibuka dari file lokal maupun di-hosting. Ia tidak memiliki backend sendiri; satu-satunya ketergantungannya adalah ekstensi dan, lewat ekstensi, `https://apinux.taobot.org`.

Isi halaman, dari atas ke bawah:

- Status koneksi dan tombol Connect — menampilkan apakah `window.nux` terdeteksi; bila tidak, halaman menampilkan petunjuk pemasangan ekstensi, bukan pesan kesalahan teknis.
- Kartu akun — alamat aktif dan saldo (terkonfirmasi dan belum terkonfirmasi) setelah terhubung, dengan tombol salin alamat.
- Formulir kirim — kolom alamat tujuan dan jumlah dalam nusan, tombol kirim, lalu area hasil yang menampilkan txid setelah penyiaran.
- Formulir tanda tangan pesan — kolom teks bebas, tombol Sign, dan hasil tanda tangan; dilengkapi tombol verifikasi sederhana agar pengunjung bisa membuktikan tanda tangan itu cocok dengan alamatnya.
- Log aktivitas — daftar peristiwa di halaman itu sendiri (terhubung, akun berubah, permintaan ditolak, transaksi terkirim) agar perilaku provider terlihat jelas saat demo dipresentasikan.

Skenario demo yang harus bisa dijalankan berurutan tanpa menyentuh konsol browser: pasang ekstensi, buat dompet, buka halaman demo, Connect dan setujui, saldo terbaca, kirim jumlah kecil ke alamat kedua, tolak satu permintaan dan lihat penanganannya, lalu tanda tangani satu pesan dan verifikasi.

## Pemasangan yang mudah

Targetnya: dari mengunduh sampai dompet pertama jadi dalam waktu singkat, tanpa terminal dan tanpa alat pengembang selain mode pengembang bawaan browser.

Format distribusi MVP:

- Satu ZIP rilis berisi folder ekstensi yang sudah terbangun (manifest.json di akar folder hasil ekstrak) dan satu berkas petunjuk pemasangan berbahasa Indonesia.
- Tidak ada langkah kompilasi, instalasi dependensi, atau penyuntingan berkas konfigurasi di sisi pengguna.

Langkah pemasangan untuk Chrome, Brave, dan Edge:

1. Ekstrak ZIP ke folder mana pun yang tidak akan terhapus.
2. Buka halaman ekstensi browser (`chrome://extensions` atau setaranya).
3. Aktifkan Developer mode.
4. Klik Load unpacked dan pilih folder hasil ekstrak.
5. Sematkan ikon Nux Connect, klik ikonnya, dan buat dompet (atau impor dari mnemonic).

Dua peringatan yang wajib ada di petunjuk: folder hasil ekstrak tidak boleh dipindahkan atau dihapus setelah dipasang karena browser memuat ekstensi dari folder itu, dan ekstensi yang dipasang dengan cara ini tidak memperbarui diri secara otomatis — pembaruan berarti mengunduh ZIP baru dan memuat ulang dari folder yang sama agar data vault tidak hilang. Penerbitan ke Chrome Web Store adalah jalur pembaruan otomatis yang layak dipertimbangkan setelah demo, tetapi di luar ruang lingkup MVP.

## Ruang lingkup MVP

Yang termasuk dalam versi pertama:

- Buat dan impor dompet dari mnemonic, vault terenkripsi kata sandi, kunci dan buka vault.
- Satu akun, satu alamat terima SegWit (bech32 `nu`), dan alamat change internal.
- Provider `window.nux` dengan delapan method pada tabel di atas, dua peristiwa, dan kode kesalahan yang terdokumentasi.
- Izin per situs dengan pencabutan dari popup.
- Kirim NUX satu penerima, tanda tangani pesan, tanda tangani dan kirim PSBT.
- Demo dApp satu halaman dengan skenario lengkap di atas.
- Paket ZIP siap Load unpacked beserta petunjuk pemasangan.

Yang secara sadar tidak termasuk:

- Banyak akun, banyak dompet, dan impor kunci privat tunggal (WIF) — formatnya diketahui (`0x57`) tetapi ditunda.
- Testnet — parameternya belum lengkap terverifikasi.
- Token, NFT, dan aset selain NUX asli.
- Riwayat transaksi lengkap di dalam popup; MVP cukup menampilkan saldo dan txid terakhir. Riwayat bisa dilihat di dompet web yang sudah ada.
- Penerbitan ke Chrome Web Store dan pembaruan otomatis.
- Dukungan Firefox dan Safari; MV3 versi Firefox berbeda detail dan menjadi fase tersendiri.

## Kriteria selesai dan pertanyaan terbuka

MVP dianggap selesai bila semua butir berikut terbukti, bukan sekadar terimplementasi:

- Alamat pertama hasil derivasi ekstensi sama persis dengan alamat dari mnemonic yang sama di dompet web yang sudah ada.
- Skenario demo berjalan ujung-ke-ujung di mainnet dengan dana kecil: connect, saldo terbaca benar, pengiriman muncul di backend dan mendapat konfirmasi, penolakan ditangani halus, dan tanda tangan pesan terverifikasi.
- PSBT yang dibuat dApp demo bisa ditandatangani dan disiarkan, serta PSBT yang diubah isinya secara diam-diam tertolak atau ketahuan di layar persetujuan.
- Pengguna baru bisa memasang ekstensi hanya dengan mengikuti petunjuk tertulis, tanpa bantuan.

Pertanyaan yang masih perlu dijawab tim sebelum atau selama pembangunan:

- Apakah endpoint perkiraan biaya tersedia di `https://apinux.taobot.org`, dan bila tidak, berapa tarif bawaan yang dianggap aman oleh tim?
- Pustaka Bitcoin mana yang terbukti mendukung PSBT dengan parameter jaringan kustom (HRP `nu`, version byte `0x35`/`0x4b`, coin type 662) tanpa modifikasi kode pustaka?
- Berapa konfirmasi yang dianggap cukup untuk menampilkan saldo sebagai "terkonfirmasi" di demo?
- Apakah ada endpoint atau halaman penjelajah resmi yang sebaiknya ditautkan dari txid hasil pengiriman?
- Parameter testnet lengkap (HRP bech32, WIF, endpoint indexer) — untuk fase setelah MVP.

## Sumber

- Repo dompet web Nusacoin, `TaobotX11/walletweb-dark` — sumber parameter jaringan dan bukti pemakaian electrs lewat API REST gaya Esplora di `https://apinux.taobot.org`, yang juga melayani dompet.nusacoin.org.
- Pola provider EIP-1193 (standar provider Ethereum) — acuan bentuk API `request` dan kode kesalahan, diadaptasi ke model UTXO.
- BIP39 (mnemonic), BIP84 (derivasi SegWit), dan BIP174 (PSBT) — standar yang dirujuk untuk pembuatan dompet, derivasi alamat, dan transaksi bertanda tangan sebagian.
