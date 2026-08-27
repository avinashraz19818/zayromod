const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'apkbuilder.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    coins INTEGER DEFAULT 0,
    telegram_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS designs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    price_coins INTEGER NOT NULL DEFAULT 10,
    type TEXT NOT NULL DEFAULT 'normal',
    popup_html_file TEXT NOT NULL,
    java_type TEXT NOT NULL DEFAULT 'normal',
    preview_image TEXT,
    preview_video TEXT,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS design_preview_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    design_id INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(design_id) REFERENCES designs(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_design_preview_images_design
    ON design_preview_images(design_id, sort_order, id);

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    design_id INTEGER NOT NULL,
    app_name TEXT NOT NULL,
    package_name TEXT NOT NULL,
    register_url TEXT NOT NULL,
    deposit_url TEXT NOT NULL,
    wingo_url TEXT NOT NULL,
    domain TEXT NOT NULL,
    firebase_path TEXT NOT NULL,
    min_deposit INTEGER NOT NULL DEFAULT 300,
    brand_title TEXT NOT NULL,
    icon_file TEXT,
    status TEXT DEFAULT 'pending',
    apk_file TEXT,
    fake_register_url TEXT,
    fake_apk_file TEXT,
    fake_firebase_path TEXT,
    live_link_enabled INTEGER NOT NULL DEFAULT 0,
    build_log TEXT,
    coins_spent INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(design_id) REFERENCES designs(id)
  );

  -- Multiple fake sites per order — har fake site ka apna APK banta hai
  -- (apna register link + firebase path). Primary fake (orders.fake_*)
  -- alag rehta hai, ye EXTRA fake sites hain (jitne chahe utne).
  CREATE TABLE IF NOT EXISTS order_fake_sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    register_url TEXT NOT NULL,
    deposit_url TEXT,
    wingo_url TEXT,
    domain TEXT,
    firebase_path TEXT,
    apk_file TEXT,
    status TEXT DEFAULT 'pending',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS coin_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    coins_requested INTEGER NOT NULL,
    amount_paid REAL NOT NULL,
    utr TEXT NOT NULL,
    telegram_msg_id INTEGER,
    status TEXT DEFAULT 'pending',
    approved_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  INSERT OR IGNORE INTO settings(key,value) VALUES
    ('upi_qr_image',''),
    ('upi_id',''),
    ('coin_rate','1'),
    ('site_name','APK Builder'),
    ('telegram_bot_token',''),
    ('telegram_admin_id',''),
    ('loading_html_file','loading.html'),
    ('addon_fake_price','5'),
    ('invite_code_change_price','10');
`);

// Migrations — safe on existing DB
  try { db.exec("ALTER TABLE designs ADD COLUMN fake_popup_html_file TEXT DEFAULT ''"); } catch(e) {}
  try { db.exec("ALTER TABLE designs ADD COLUMN original_price_coins INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE designs ADD COLUMN fake_price_coins INTEGER DEFAULT 5"); } catch(e) {}
  try { db.exec("ALTER TABLE orders ADD COLUMN domain_change_count INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE orders ADD COLUMN invite_code_change_count INTEGER DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE orders ADD COLUMN live_link_enabled INTEGER NOT NULL DEFAULT 0"); } catch(e) {}
  try { db.exec("ALTER TABLE orders ADD COLUMN fake_firebase_path TEXT"); } catch(e) {}
  try { db.exec("INSERT OR IGNORE INTO settings(key,value) VALUES('domain_change_price','10')"); } catch(e) {}
  try { db.exec("INSERT OR IGNORE INTO settings(key,value) VALUES('invite_code_change_price','10')"); } catch(e) {}
  try { db.exec("INSERT OR IGNORE INTO settings(key,value) VALUES('backup_keep_count','10')"); } catch(e) {}
  try { db.exec("ALTER TABLE coin_requests ADD COLUMN screenshot_file TEXT DEFAULT ''"); } catch(e) {}
  try { db.exec("ALTER TABLE users ADD COLUMN plain_password TEXT DEFAULT ''"); } catch(e) {}
  // Google login: NULL default zaroori hai — UNIQUE index multiple NULLs
  // allow karta hai (normal registrations me google_id khali/NA rahega).
  try { db.exec("ALTER TABLE users ADD COLUMN google_id TEXT"); } catch(e) {}
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)"); } catch(e) {}
  try { db.exec("ALTER TABLE orders ADD COLUMN app_name_style TEXT DEFAULT 'normal'"); } catch(e) {}
  try { db.exec("INSERT OR IGNORE INTO settings(key,value) VALUES('site_url','')"); } catch(e) {}
  // Canonical design category. Legacy type/java_type/variant columns remain for
  // build compatibility, but the admin now manages one clear category only.
  try { db.exec("ALTER TABLE designs ADD COLUMN category TEXT DEFAULT 'zayro'"); } catch(e) {}
  try { db.exec("ALTER TABLE designs ADD COLUMN variant TEXT DEFAULT 'real'"); } catch(e) {}
  try {
    db.exec(`
      UPDATE designs SET category = CASE
        WHEN LOWER(COALESCE(category,'')) = 'dhani'
          OR LOWER(COALESCE(java_type,'')) IN ('dhani','premium')
          OR LOWER(COALESCE(name,'')) LIKE '%dhani%' THEN 'dhani'
        ELSE 'zayro'
      END;
      UPDATE designs SET
        type='normal',
        java_type=CASE WHEN category='dhani' THEN 'dhani' ELSE 'normal' END,
        variant='real';
    `);
  } catch(e) {}
  // Legacy order field retained for existing databases.
  try { db.exec("ALTER TABLE orders ADD COLUMN design_variant TEXT DEFAULT 'real'"); } catch(e) {}
  try { db.exec("ALTER TABLE orders ADD COLUMN coupon_code TEXT DEFAULT ''"); } catch(e) {}
  try { db.exec("ALTER TABLE orders ADD COLUMN discount_coins INTEGER DEFAULT 0"); } catch(e) {}

  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS coupons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL DEFAULT 'fixed',
        value INTEGER NOT NULL DEFAULT 0,
        max_uses INTEGER NOT NULL DEFAULT 0,
        used_count INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        expires_at TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS popup_announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        image_url TEXT,
        button_text TEXT,
        button_url TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch(e) {}
  try { db.exec("INSERT OR IGNORE INTO settings(key,value) VALUES('telegram_support_user','')"); } catch(e) {}
  try { db.exec("INSERT OR IGNORE INTO settings(key,value) VALUES('telegram_channel_url','')"); } catch(e) {}
  try { db.exec("INSERT OR IGNORE INTO settings(key,value) VALUES('telegram_log_channel_id','')"); } catch(e) {}
  try { db.exec("INSERT OR IGNORE INTO settings(key,value) VALUES('telegram_log_enabled','1')"); } catch(e) {}

module.exports = db;