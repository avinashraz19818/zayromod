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

## Remote Content + Popup Protection

### Popup HTML — assets me encrypted (primary, offline)
- Popup HTML har build me **APK ke assets folder me `zayro.bin`** ke roop
  me bundled hota hai — AES-256-CBC + PBKDF2 (per-build password) se
  encrypted (utils/encrypt.js). App ise offline decrypt karke load karta
  hai.
- Loading HTML bhi assets me hi aata hai (`loading.bin` / dhani builds me
  `lodale.bin` bhi) — same encryption, sirf splash ke liye.
- Encryption format: `MARKER(8) | salt(16) | iv(16) | AES-256-CBC | padding(64)`,
  key = PBKDF2WithHmacSHA256(password, salt, 100000 iter, 256-bit).
- Password DEX me XOR-masked byte array (0x5A) ke roop me jaata hai —
  plaintext nahi milta.

### Remote HTML (fallback, automatic)
- Asset missing/corrupt ho ya purana APK ho to app server se
  `GET /api/app-content/:path` (encrypted .bin, HTTPS) fetch karta hai.
- Server route public hai par response encrypted hai.
- App me network fail ho to RETRY button dikhta hai.

### 360 / DEX packers — REMOVED
- **360 Jiagu (official) aur Frezrik Jiagu (open-source DEX packer) dono
  pipeline se completely remove ho chuke hain** — koi packer step, script,
  env var ya native module nahi bacha.
- Build flow ab simple hai: Gradle → zipalign → apksigner → final APK.
- `libnativesecurity.so` (HTML popup .so vault) bhi hata diya gaya — APK
  me ab koi .so nahi jata, NDK ki zarurat nahi.
- VPS pe `/opt/jiagu` ya `/opt/frezrik` pade hon to unhe delete kar
  (~285MB free) aur `.env` se `JIAGU_*` / `FREZRIK_*` lines hata dena
  (ab ignore hoti hain).

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
