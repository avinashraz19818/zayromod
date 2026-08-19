# APK Builder — VPS Setup Guide

## Step 1: VPS pe ye commands chalao

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install Java (APK signing ke liye)
sudo apt install -y openjdk-17-jdk

# Install Android SDK Build Tools (apksigner ke liye)
sudo apt install -y wget unzip
wget https://dl.google.com/android/repository/commandlinetools-linux-10406996_latest.zip
unzip commandlinetools-linux-*.zip -d /opt/android-sdk
export ANDROID_HOME=/opt/android-sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/bin
sdkmanager --sdk_root=$ANDROID_HOME "build-tools;34.0.0"
echo 'export PATH=$PATH:/opt/android-sdk/build-tools/34.0.0' >> ~/.bashrc
source ~/.bashrc

# Install PM2 (process manager)
sudo npm install -g pm2
```

## Step 2: Project upload karo

```bash
# Project folder banao
mkdir -p /var/www/apkbuilder
# Apna apk-builder folder upload karo (scp ya git se)
# cd /var/www/apkbuilder
```

## Step 3: Dependencies install karo

```bash
cd /var/www/apkbuilder
npm install
```

## Step 4: .env file banao

```bash
cp .env.example .env
nano .env
# Fill in: PORT, SESSION_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD, TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID, BASE_URL
```

## Step 5: Keystore banao (APK signing ke liye)

```bash
mkdir -p keystore
keytool -genkey -v -keystore keystore/release.keystore \
  -alias zayro -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass zayro@123 -keypass zayro@123 \
  -dname "CN=Zayro, OU=Dev, O=Zayro, L=IN, S=IN, C=IN"
```

## Step 6: Base APK upload karo

Admin panel pe jaao → Base APKs → Upload karo:
- `TASHAN WIN VIP HACK.apk` → Normal Base APK
- `DHANIWIN TURBO PANEL.apk` → Dhani Base APK

## Step 7: Design HTML files setup

Admin panel → Add Design mein:
- Popup HTML: (e.g. wingss.html, zayro.html, etc.)
- Loading HTML: (e.g. redload.html)
- Preview Image/Video: screenshot ya screen recording

## Step 8: Shared assets (MP3 + PNG)

```bash
mkdir -p templates/assets
# Yahan copy karo:
# - intro.mp3, bypass.mp3, register.mp3, successful.mp3
# - deposit.mp3, lowbalance.mp3, big.mp3, small.mp3
# - 0.png, 1.png, 2.png ... 9.png (number images)
```

## Step 9: Start server

```bash
pm2 start server.js --name apkbuilder
pm2 save
pm2 startup
```

## Step 10: Nginx reverse proxy (optional, recommended)

```bash
sudo apt install -y nginx
sudo nano /etc/nginx/sites-available/apkbuilder
```

```nginx
server {
    listen 80;
    server_name yourdomain.com;
    client_max_body_size 100M;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/apkbuilder /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## Project File Structure

```
apk-builder/
├── server.js              — Main server
├── database/db.js         — SQLite database
├── utils/
│   ├── encrypt.js         — HTML .bin encryption (fixed key) — assets plain rehte hain
│   ├── htmlprocessor.js   — Template injection
│   ├── apkbuilder.js      — APK build pipeline
│   └── telegram.js        — Telegram bot
├── public/
│   ├── index.html         — Main website
│   └── admin/index.html   — Admin panel
├── templates/             — HTML design files (upload from admin)
│   └── assets/            — Shared MP3 + PNG files
├── base-apks/             — base_normal.apk, base_dhani.apk
├── builds/                — Generated APKs
├── uploads/               — Icons, QR images
└── keystore/release.keystore
```

## APK Hardening (automatic — no setup needed)

Bas itna protection hai:

1. **HTML encryption (fixed key)** — sirf popup/loading HTML files (.bin) AES-256-CBC
   se encrypted hote hain (PBKDF2, fixed password). APK ke assets me HTML readable
   nahi hota.
2. **Assets plain** — PNG, MP3, fonts, icon sab PLAIN rehte hain (koi encrypt/decrypt
   nahi). MP3 seedha MediaPlayer se assets se hi play hota hai — saare sounds sahi
   chalte hain.
3. **R8/ProGuard obfuscation** — Java code obfuscated hota hai (pehle se enabled).
4. **No backup** — app data adb backup se extract nahi ho sakta.

Native key vault / signature integrity check NAHI hai (hata diya gaya — purana
simple style, jaise pehle chalta tha).

## Firebase Security (HACK LOCK — zaroori)

Firebase database pe **Rules** lagana hai warna koi bhi kisi bhi panel ke
links badal sakta hai (goavideo hack isi se hua tha).

1. Firebase Console → apna project → Realtime Database → **Rules** tab
2. `firebase.rules.json` (repo me hai) ka content paste karo → **Publish**

Iske baad:
- Apps config READ karte rahenge (sab chalta hai)
- Apps users/ me likh sakte hain (registration tracking chalta hai)
- **config ki write sirf SERVER kar sakta hai** (service account se)

### Server ko service account lagao (taaki admin link change chalta rahe)

1. Firebase Console → Project settings → **Service accounts** →
   "Generate new private key" → JSON download karo
2. VPS pe rakho: `/root/apkbuilder/firebase-service-account.json`
3. `.env` me add karo:
   ```
   GOOGLE_APPLICATION_CREDENTIALS=/root/apkbuilder/firebase-service-account.json
   ```
4. `pm2 restart apkbuilder`

Service account ke bina bhi sab chalega — sirf admin panel ka link
change fail hoga (wohi hacker ka darwaza tha, ab band).

## Remote Content + 360 Protection (APK me kuch nahi hota)

### Remote HTML (automatic)
- Popup HTML ab APK me embed NAHI hota. App launch hote hi server se
  `GET /api/app-content/:path` (encrypted .bin, fixed key, HTTPS) fetch
  karta hai — APK me koi design HTML / Firebase detail nahi milti.
- Loading HTML sirf splash ke liye embedded rehta hai (koi secret nahi).
- App me network fail ho to RETRY button dikhta hai.
- Server route public hai par response encrypted hai — 360 laga ho to
  decrypt key bhi DEX me locked hoti hai.

### Frezrik Jiagu (DEFAULT — open-source DEX packer, koi account nahi)
**AUTO SETUP:** VPS pe ye chalao — tool khud download hoga (~15MB):
```
bash scripts/setup-frezrik.sh
```
Ye har build me app ka DEX AES-encrypt karta hai (shell dex + 4 ABIs ke
libjiagu). Decompile karne pe sirf shell dikhta hai — asli code kuch nahi.
Pipeline khud pack.jar dhundti hai (/opt/frezrik/pack.jar); apne
zipalign+apksigner se sign hoti hai. FREZRIK_ENABLED=false → band.

### 360 Jiagu hardening (optional — account wala, backup option)
**AUTO SETUP:** VPS pe ye chalao — OFFICIAL tool khud
download hoga (360 ke apne server se, ~270MB Linux package):
```
bash scripts/setup-jiagu.sh
```
(Link: down.360safe.com/360Jiagu/360jiagubao_linux_64.zip — official.
Docker wrapper repo idocking/360jiagu ke Dockerfile se ye link mila.)
Official site se manual chahiye to neeche wala tareeka bhi hai.

**MANUAL:** jiagu.360.cn pe account banao + `jiagu.jar` download karo
2. VPS pe rakho: `/opt/jiagu/jiagu.jar`
3. `.env` me:
   ```
   JIAGU_ENABLED=true
   JIAGU_JAR=/opt/jiagu/jiagu.jar
   JIAGU_EMAIL=360_wala_email
   JIAGU_PASS=360_wala_password
   ```
4. `pm2 restart apkbuilder`

Ab har build: Gradle → 360 hardening (DEX encrypted + anti-tamper +
string encryption) → autosign (imported keystore) → final APK.
Jiagu fail ho to normal signing fallback — build kabhi nahi atakta.
Note: 360 ke flags version ke hisaab se thode alag ho sakte hain
(scripts/jiagu-protect.sh me adjust kar lena).

## Security

Pura protection system docs: **SECURITY.md** (repo root me) — layers,
build variants, verification, troubleshooting.

## Admin Login
Default: admin / admin123 (change in .env)
Admin URL: yourdomain.com/admin/
