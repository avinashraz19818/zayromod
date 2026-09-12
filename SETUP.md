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

Node.js 20 or newer use karo. `package-lock.json` mein Node 20-compatible
`better-sqlite3` release locked hai; different Node ABI ke saath native module
startup crash kar sakta hai.

```bash
cd /var/www/apkbuilder
npm ci
```

## Step 4: .env file banao

```bash
cp .env.example .env
nano .env
# Fill in: BASE_URL, SESSION_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD_HASH,
# TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_CHAT_ID and the optional
# Google/Firebase values you use.
# Never commit .env, service-account JSON, database files, backups, or tokens.

# Generate a bcrypt hash for the admin password without putting the password
# in the repository or returning it through the admin UI:
node -e "require('bcryptjs').hash(process.env.ADMIN_PASSWORD_INPUT, 12).then(console.log)"
# Run that with ADMIN_PASSWORD_INPUT set only in your private shell, then put
# the printed hash in ADMIN_PASSWORD_HASH and unset ADMIN_PASSWORD_INPUT.
# Do not use ADMIN_PASSWORD; plaintext admin passwords are unsupported.
chmod 600 .env
```

## Step 5: Keystore banao (APK signing ke liye)

```bash
mkdir -p keystore
# Keep these values in a private shell/secret manager, never in Git.
read -rsp 'Keystore password: ' KEYSTORE_PASSWORD; echo
export KEYSTORE_PASSWORD
export KEYSTORE_ALIAS=zayro
keytool -genkey -v -keystore keystore/release.keystore \
  -alias "$KEYSTORE_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$KEYSTORE_PASSWORD" -keypass "$KEYSTORE_PASSWORD" \
  -dname "CN=Zayro, OU=Dev, O=Zayro, L=IN, S=IN, C=IN"
# Put KEYSTORE_PASSWORD/KEYSTORE_ALIAS in the process secret manager used by PM2.
unset KEYSTORE_PASSWORD
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
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
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
│   ├── encrypt.js         — Popup/loading HTML ko .bin me encrypt karta hai (per-build key)
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

Protection simple rakha hai — koi DEX packer (360/Frezrik) aur koi native .so
vault nahi. Jo hai sirf ye:

1. **Popup + loading HTML assets me encrypted** — dono HTML `.bin` (AES-256-CBC +
   PBKDF2) ban kar `app/src/main/assets/` me jate hain (`zayro.bin` popup,
   `loading.bin` splash). Decrypt key per-build random hoti hai aur DEX me
   XOR-masked rehti hai. APK me HTML kahin plaintext nahi milta.
2. **Assets baaki plain** — PNG, MP3, fonts, icon (WebView/MediaPlayer inhe seedha
   assets se load karte hain; encrypt karne par sounds/images toot jate hain).
3. **R8/ProGuard obfuscation** — Java code obfuscated hota hai (pehle se enabled).
4. **No backup** — app data adb backup se extract nahi ho sakta.
5. **Signature + asset-integrity check** (protectedRelease) — APK re-sign/modify ho
   to app block screen dikhati hai. Native (.so) checks hata diye gaye hain.

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

## Popup HTML — APK ke assets me (encrypted)

Popup design ka HTML ab **APK ke `assets/zayro.bin`** me hota hai — build time pe
per-build random key se AES-256-CBC encrypt hoke. App ise seedha assets se padhti
hai aur decrypt karke WebView me load karti hai.

- Pehle jo `libnativesecurity.so` vault tha (HTML ko `lib/<abi>/` .so me chhupane
  wala system) — wo **hata diya gaya**. Ab APK me koi extra native `.so` nahi hai.
- 360 Jiagu / Frezrik DEX packer bhi **hata diye** — build me koi packer nahi chalta,
  isliye Play Protect "app may be harmful" type warnings packer ki wajah se nahi
  aayengi aur build fast hoti hai.
- App ko popup ke liye **internet ki zarurat nahi** — offline bhi UI khulta hai.
- Loading splash isi tarah `assets/loading.bin` se aata hai (dhani designs ke liye
  `lodale.bin` alias bhi likha jata hai).

Note: purane APKs (jo abhi field me distribute ho chuke hain) server se remote
content fetch karte rehte hain — `/api/app-content/:path` route isliye zinda hai
(`utils/appcontent.js`). Naye builds us par depend nahi karte.

## Security

Pura protection system docs: **SECURITY.md** (repo root me) — layers,
build variants, verification, troubleshooting.

## Admin Login
There is no default administrator password. Set `ADMIN_USERNAME` and a bcrypt
`ADMIN_PASSWORD_HASH` in `.env`; production startup refuses missing, malformed,
or weak hashes.
Keep the hash and `.env` server-only. The admin UI never receives the Telegram
bot token or any other secret; secret fields are write-only for rotation.

Admin URL: `https://yourdomain.com/admin/`

## Authentication

Password registrations use bcrypt hashes and can log in immediately; email is
kept as an account identifier but email verification and password-reset email
workflows are disabled. There are no email-delivery secrets or token links to
configure.

Sessions use a SQLite store with an absolute lifetime and an idle timeout.
Production cookies are Secure, HttpOnly, SameSite=Lax, and use a `__Host-`
name. Set `TRUST_PROXY_HOPS` to the exact number of trusted reverse proxies
(usually `1` behind the Nginx configuration above; use `0` when direct). Do
not trust arbitrary `X-Forwarded-*` headers.

Login attempts are independently limited by IP and normalized account
identifier. Failed login responses remain generic. Passwords can only be
changed through the operator's existing administrative/database procedure;
do not store or transmit plaintext passwords.

### Rotating the Telegram token

Enter a new token in Admin → Settings → Telegram Bot & Support. The existing
token is never populated into the browser; leaving the field blank keeps the
current server-side value. Revoke any token that was ever committed or placed
in a database backup, then rotate it in BotFather and `.env`/the admin panel.
