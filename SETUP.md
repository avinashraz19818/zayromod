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
│   ├── encrypt.js         — HTML → .bin encryption
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

## Admin Login
Default: admin / admin123 (change in .env)
Admin URL: yourdomain.com/admin/
