# FIX: Deposit page icons fullscreen popup (✕ overlay) me khulna + broken icons

## Symptoms (jo screenshots me tha)
1. Deposit page kholte hi har channel icon (UPI-QR, Innate UPI-QR, PAYTM, ARPay…)
   **ek-ek karke fullscreen black overlay me** aata tha, upar right corner me ✕ button.
   Sab band karne ke baad hi deposit page dikhta tha.
2. Deposit page par wahi icons **broken image (toote hue glyph)** dikhte the.

## Root cause
`MainActivity.java` ka payment-URL detection bahut zyada broad tha:

- `shouldInterceptRequest()` **har sub-resource request** par bhi call hota hai
  (`isForMainFrame() == false` sirf iframe nahi, balke `<img>`, CSS, JS requests bhi
  hoti hai). Deposit page (jo `#target-game-frame` iframe ke andar game-site se aata
  hai) ke icon images ke URLs me `upi`, `qr`, `paytm`, `arpay`, `/pay` jaise tokens
  the → purana code har icon ke liye `createPopupWebView()` + `popup.loadUrl(iconUrl)`
  kar deta tha → **har icon ek alag fullscreen popup WebView me** khul jaata tha
  (wahi ✕ wala overlay).
- Saath hi, `/pay` / `checkout` wale icon URLs ke liye image response ki jagah
  **HTML stub** ("Opening payment...") return hota tha → `<img>` HTML render nahi
  kar sakta → **broken icons**.
- Injected JS hooks (`iframe.src` setter + `setInterval` on `#target-game-frame`)
  bhi bare `'pay'/'upi'/'qr'` keywords use karte the → deposit page ka apna URL bhi
  popup me chala jaata tha, aur `iframe.src` set hona ruk jaata tha.

## Fix (sirf `MainActivity.java` me)
1. **Naye guards:** `isImageOrAssetUrl()` / `isImageRequest()` — image extension
   (`.png/.jpg/.webp/.gif/.svg/.ico/.bmp/.avif`) ya `Accept: image/…` header wale
   requests ko kabhi payment navigation nahi maana jaayega.
2. **`isPaymentUrl()` strict kiya** — sirf real gateway keywords:
   `razorpay, cashfree, payu.com, ccavenue, billdesk, instamojo, checkout,
   /gateway, paytm.com, phonepe.com, bharatpe, arpay, dhaniwin, 13l, usdt,
   /pg/, /pay/, /pay?, /pay#, pay.html, payment.php, upi://, /payment/`
   (bare `upi`, `qr`, `pay`, `amount=`, `txn` wale heuristics hataaye).
3. **`shouldInterceptRequest()` se popup side-effect hataya** — ab yahan se popup
   sirf tab khulta hai jab request ek **document** ho (`Accept: text/html`) aur
   strict gateway URL ho (X-Frame-Options white-screen case). Image requests
   early-return ho jaati hai, response replace nahi hota.
4. **`shouldOverrideUrlLoading()` (iframe branch)** — ab sirf `isPaymentUrl()`
   (strict) par popup; deposit/wallet/recharge/register/game navigations iframe
   me normal chalti hai.
5. **Injected JS hooks simplify** — `iframe.src` setter hook aur `setInterval`
   hook **hataaye** (ye kaam ab Java side navigation-level par hota hai).
   `window.open` + click hook rake, unme bhi `IMG` regex guard + strict `GW`
   regex (sirf `_blank` links ya real gateway URLs hijack hote hai).
6. **Popup dedupe:** `openPopupOnce()` — same URL ke liye 5 second me ek hi popup,
   taaki overlay stacking dobara na ho.

## Kya behavior ab milega
- Deposit page khulte hi icons normal grid me load honge (koi fullscreen overlay nahi).
- Icons broken nahi honge (image responses kabhi replace nahi hote).
- Real payment gateway (Razorpay/Cashfree/ARPay checkout etc.) ab bhi popup
  overlay me khulega (white-screen fix barkarar), ✕ se band hoga.
- `window.open` / `_blank` links ab bhi app ke andar popup me khulenge.

## Test checklist (APK rebuild ke baad)
1. Deposit page kholo → icons turant grid me dikhe, koi ✕ overlay na aaye.
2. Koi bhi method select karke Deposit dabao → gateway popup overlay me khule,
   ✕ se band ho, iframe white/black na ho.
3. Deposit history / wallet / recharge pages normal iframe me khule.
4. Logcat me `DW` tag se popup URLs dekh sakte ho agar kuch unexpected ho.

## Files changed
- `android-project/app/src/main/java/com/zayro/wingsyttt/MainActivity.java`

Rebuild: apne normal apkbuilder flow se (`utils/apkbuilder.js` / gradle) naya APK
banao — fix sirf Java side hai, templates/server me koi change nahi.
