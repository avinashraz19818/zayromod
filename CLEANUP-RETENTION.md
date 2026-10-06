# CLEANUP, RETENTION & VERIFY — Sab Kuch Ek Jagah

Is document me wo saare tools hain jo "template change nahi ho raha", "faltu
files", "links change" aur "Firebase storage full" problems ke liye banaye gaye
hain. **Default behaviour hamesha SAFE hai** — kuch bhi delete tabhi hota hai
jab aap khud `mode=run` do.

---

## 1) Template / APK verify — "APK purane template se bana hai ya naye se?"

Purani problem: same naam ki APK (jaise `MAGIC_TOOL.apk`) kai orders me thi,
aur server kabhi kisi aur order ki purani APK serve kar deta tha — isliye
"template change karne pe bhi purana hi dikhta tha". Fix: APK ab **sirf usi
order ke build folder** se milti hai, aur agar file hi maujood nahi to saaf
error aata hai (galat APK kabhi nahi).

Naya build apne andar ek marker rakhta hai:

```
<!--zayro-build {"v":1,"b":"build_414_...","o":414,"t":"design.html","h":"sha256...","ts":...}-->
```

Isse pata chalta hai APK **kis template file + kis hash** se bana tha.

**Admin panel se:** Orders page → har order ke saamne **Verify** button.
Result: `up-to-date` / `stale` / `apk-missing` + APK ka template vs abhi ka
template + **links comparison** (register/deposit/wingo/firebase path).

**CLI se (VPS):**

```bash
node scripts/verify-order.js              # koi id na do → recent orders ki list
node scripts/verify-order.js --last       # sabse naye order ko verify karo
node scripts/verify-order.js 414          # real APK
node scripts/verify-order.js 414 fake     # fake APK
node scripts/verify-order.js 414 fs12     # extra fake site (#12)
# exit code 2 = mismatch (rebuild chahiye)
```

Purane (marker ke bina) APKs ke liye content-similarity ka **estimate** milta
hai (≥97% = same design). Pakka proof ke liye ek rebuild karo — uske baad
marker aa jayega aur exact comparison hoga.

### Links change ke baad

- **live-link wale APKs** (naye): links runtime pe `<firebasePath>/config` se
  aate hain → change instant hai, rebuild nahi chahiye. Verify report me
  `links.changed` dikhega lekin `note` batayega ki rebuild ki zaroorat nahi.
- **purane APKs**: ek baar `Rebuild` (ya user panel se domain change) karo —
  wo APK ko live-link mode me upgrade kar deta hai.
- Admin panel → Orders → **Link Sync** button: DB ke links ko Firebase me
  force-write karta hai (turant, bina rebuild).

---

## 2) Local disk cleanup (builds / uploads / templates / backups / junk)

Kya delete hota hai (aur kya **kabhi nahi**):

| Item | Kab delete hota hai | Safety |
|---|---|---|
| Orphan build dirs | Order DB me nahi hai | DB reference check |
| Purane/duplicate rebuild dirs | Us order ka referenced APK is folder me nahi | Referenced APK wale folders rehte hain |
| `project/` leftover | Build fail ke baad bacha gradle copy | Sirf tab jab order ka APK doosre folder me ho |
| `*.idsig` | v4 signing off hai | Bekaar files |
| Purane APK folders | Sirf jab `apkRetentionDays > 0` | Default 0 = OFF (delivered APKs safe) |
| uploads/ orphan | Kisi design/order/icon/PWA/coin-request/announcement me nahi | Poora DB scan |
| templates/ orphan | Kisi design/settings me nahi | Default OFF (`--templates` se on) |
| Purane DB backups | Latest N (default 5) ke ilawa | `backup_keep_count` (max 50) |
| Legacy junk | `*.before-*`, `*.backup.*`, orphan `.db-shm/-wal` | **Live DB ke wal/shm kabhi nahi** hattate |
| Fresh files (< 24 h) | Kabhi nahi | Naya upload / chal raha build galti se na kate (`--min-age-hours=0` se off) |

**Admin panel se:** Settings → *Storage & Firebase Cleanup* card →
`Scan Disk` (dry-run) → `Cleanup DRY-RUN` → result dekh ke → `Cleanup RUN`.

**CLI se (VPS):**

```bash
node scripts/cleanup-junk.js                      # dry-run report
node scripts/cleanup-junk.js --run                # actually clean
node scripts/cleanup-junk.js --run --apk-days=60  # 60+ din purane delivered APK bhi
node scripts/cleanup-junk.js --run --templates    # unreferenced templates bhi
node scripts/cleanup-junk.js --min-age-hours=0    # 24h ki safety guard off (default 24)
```

> **Fresh-file guard:** jo bhi file/folder 24 ghante se naya hai wo chhoda jata
> hai (admin abhi upload kar raha ho ya build chal raha ho). Isliye pehli run
> me kuch kam files dikh sakti hain — agli run me purani hone par chali jayengi.
> Report me `fresh (chhode)` line se pata chalta hai kitni skip hui.

Har run ki report `backups/cleanup-reports/cleanup-<timestamp>.json` me
save hoti hai — baad me check kar sakte ho ki kya-kya gaya.

---

## 3) Firebase storage full — retention system

Firebase RTDB me do tarah ka data pil raha tha:

1. `users/<key>` — purane login users (kai MB).
2. Poora path (`config` + `users`) — jinka order delete ho chuka ya jo bahut
   purana hai.

### Defaults (safe)

| Setting | Default | Matlab |
|---|---|---|
| `fb_retention_enabled` | 0 (off) | Automatic roz ka run. **1 karne se pehle ek baar dry-run dekho.** |
| `fb_retention_users_retention_days` | 30 | 30 din se purane `users/<key>` delete |
| `fb_retention_path_retention_days` | 45 | 45 din se purane inactive paths |
| `fb_retention_clean_orphans` | 1 | DB me na hone wale paths saaf |
| `fb_retention_protect_live_link` | 1 | `live_link_enabled=1` order **kabhi** touch nahi |
| `fb_retention_auto_delete_paths` | 0 | Poora path auto-delete **off** (manual/UI se) |
| `storage_cleanup_enabled` | 0 | Local disk auto-cleanup off |
| `storage_apk_retention_days` | 0 | Delivered APK auto-delete off |

### Har delete se pehle BACKUP

- Poora path delete hone se pehle: `backups/firebase/<stamp>__<path>.json`
- Users TTL me jaane wali entries: `backups/firebase/<stamp>__<path>__users-ttl.json`
  (`scope:"users"`, sirf delete hui keys — restore se wapas `PUT` ho jati hain)
- Backup fail ho jaye to **delete bhi nahi hota** (safety first).
- Restore: Admin panel → Firebase section → *Restore backup*, ya
  `POST /api/admin/firebase/restore-backup {file}`.

### Orphan path ka pehla-din rule

Koi path pehli baar "orphan" dikhe to uski `firstSeen` date
`backups/firebase/orphan-index.json` me save hoti hai. Wo path tab tak delete
nahi hota jab tak `path_retention_days` uske firstSeen se na guzar jaye — isse
kisi ka abhi-abhi bana active path galti se nahi udta.

### Admin panel se

Settings → *Storage & Firebase Cleanup* →
`Firebase Usage` (scan) → `Firebase DRY-RUN` → `Firebase RUN`.

### Automatic (roz)

`scheduler` server start hone ke 15 min baad pehla run karta hai, phir har
24 ghante. Report admin Telegram log channel me bhi jaati hai:

```
[retention] daily run: firebase users deleted=1234, paths deleted=2, local freed=356MB, errors=0
```

Scheduler ko on karne ke liye Settings → *Also auto-run daily* = `1` (ya
`fb_retention_enabled=1`) — pehle ek mahine ka data dry-run me dekh lena.

---

## 4) Recommended pehla din (VPS par)

```bash
# 1) Disk ka poora picture (kuch delete nahi hoga)
node scripts/cleanup-junk.js

# 2) APK verify — jo order shikayat me tha
node scripts/verify-order.js <orderId>

# 3) Disk cleanup run (report dekhne ke baad)
node scripts/cleanup-junk.js --run

# 4) Firebase dry-run (admin panel se ya:)
node scripts/cleanup-junk.js --firebase

# 5) Sab theek lage to admin panel → Settings → auto-run = 1
```

## 5) Zaroori VPS checklist (agar abhi bhi issue aaye)

- [ ] `GOOGLE_APPLICATION_CREDENTIALS` wali SA JSON file maujood hai?
      (`GET /api/admin/firebase/selftest` → `{ok:true}`)
- [ ] `BASE_URL` set hai? (fake APKs ka server-live mode iske bina Firebase
      mode me chalta hai)
- [ ] `ANDROID_HOME` + `aapt2`/`zipalign`/`apksigner` PATH me hain?
- [ ] PM2 ka `cwd` project root hai? (warna `builds/`, `templates/` galat
      jagah banenge)
- [ ] Rebuild ke baad `Verify` button dobara dabao — `up-to-date` aana chahiye.
