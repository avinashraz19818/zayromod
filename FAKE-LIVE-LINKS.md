# FIX: Fake (no-Firebase) APK me live link / deposit change + login monitoring + warning popup

## Problem
Fake builds (`fake_*_NO_FIREBASE_API_RESULT` templates) me:
1. **Link / deposit change reflect nahi hota tha** (fake me Firebase jaan-boojh
   kar nahi hai aur login warning/monitoring bhi by-design nahi hai) — real templates me Firebase
   `<path>/config` listener links live update karta hai; fake builds me Firebase
   SDK/script stripped hota tha aur no-Firebase template me own listener nahi →
   APK build-time ke links par frozen rehta tha.
2. **Login monitoring + "ALREADY REGISTERED" warning popup gayab** — template ka
   `rtdb.ref("<path>/users/"+phone)` code stripped SDK ki wajah se silently die
   ho jaata tha (`rtdb` undefined).

## Solution — SERVER RTDB BRIDGE (template-agnostic, pipeline-level)
APK me Firebase SDK/key/config bilkul nahi jaata (security posture same).
Uski jagah build/runtime inject time ek chhota **`window.rtdb` shim** jaata hai
jo server ke naye endpoint se poll karta hai:

- `GET /api/rtdb/:path/config` → **DB se instant** config
  (registerUrl, depositUrl, wingoUrl, minDeposit, registerCondition,
  depositCondition) — admin link/deposit change ≤20 sec me APK me reflect.
- `GET /api/rtdb/:path/users/...` → **hamesha empty (null)** — fake me koi login
  warning / monitoring NAHI (product design: fake me koi bhi login kar sakta hai).
- `PUT/PATCH/DELETE /api/rtdb/:path/users/<key>` → silently accept (no-op) —
  template ka register-mark code error-free rehta hai, kuch store nahi hota.
- CORS `*` + rate-limits (read 240/min, write 60/min) — shim `file://` origin
  se fetch karta hai isliye CORS zaroori.

Shim template ke purane Firebase code (`rtdb.ref(...).on('value')`, `.set()`,
`.once()`) ko bina kisi template edit ke chala deta hai — **sab existing fake
templates (naye ShreeWin/COMPACT wale included) automatically link-change
support karne lagte hai**. Users/login-warning jaan-boojh kar OFF hai.

## Files changed
- `utils/htmlprocessor.js` — `liveMode:'server'` + `liveBase` params;
  `buildRtdbShimScript()`; server-mode me Firebase SDK tags skip/strip;
  shim live-links script se pehle inject (taaki `rtdb` define ho).
- `utils/appcontent.js` — runtime content me fake path ko server-mode +
  request-origin BASE bake; naye exports: `resolvePathContext`,
  `buildRuntimeConfig`, `readUsersNode`, `writeUsersNode`.
- `server.js` — `/api/rtdb/...` routes (CORS + rate-limit + DB/Firebase logic).
- `utils/apkbuilder.js` — fake builds me `params.liveMode='server'` +
  `BASE_URL` env se base bake (na ho to safe Firebase-mode fallback + warning log).

## VPS checklist
1. `.env` me `BASE_URL=https://<panel-domain>` set ho (build-time bake ke liye).
2. `pm2 restart apkbuilder`.
3. Admin panel se **naya fake APK build** karo (embedded content build-time
   inject hota hai). Remote-fetch wale APKs ko runtime content se bhi shim
   mil jayega (request origin se base bake hota hai).
4. Verify: `curl -s https://<panel>/api/rtdb/<fakepath>/config` → JSON dikhe.
5. Admin se link change karo → ≤20-30 sec me fake APK me naya link lag jaaye
   (game frame auto-navigate first load par; baad me poll sirf values update).
6. Fake me koi bhi number login kar sakta hai — koi warning popup NAHI
   aayega (yahi expected behavior hai).

## Notes
- Real (Firebase) builds bilkul unchanged — `liveMode` undefined = purana flow.
- Watchdog (DB source-of-truth) ke saath consistent: config endpoint DB padhta
  hai, watchdog Firebase ko DB se heal karta hai → dono jagah same values.
