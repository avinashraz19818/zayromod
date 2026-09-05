package com.zayro.wingsyttt;

/**
 * NativePayload — popup HTML ka native .so loader (safe wrapper).
 *
 * Build pipeline har APK me popup HTML ka authenticated-encrypted snapshot
 * libnativesecurity.so ke andar embed karta hai (ZPAY01 container). Ye class
 * use decrypt karke WebView ko deti hai — bina disk par likhe.
 *
 * Design guarantees:
 *  - Koi bhi failure (lib missing, empty payload, galat key, tamper) par
 *    null return hota hai — caller existing REMOTE content flow par gir jata
 *    hai. App kabhi crash nahi hota.
 *  - Koi secret log nahi hota, koi plaintext file nahi banti.
 *  - R8 keep rule (proguard-rules.pro) JNI name ko rename hone se bachata hai.
 */
public final class NativePayload {

    private NativePayload() {}

    private static volatile boolean loadTried = false;
    private static volatile boolean loadOk = false;

    private static synchronized void ensureLoaded() {
        if (loadTried) return;
        loadTried = true;
        try {
            System.loadLibrary("nativesecurity");
            loadOk = true;
        } catch (Throwable t) {
            loadOk = false;
        }
    }

    /**
     * Popup HTML lao (native decrypt). Null = native se nahi mila → caller
     * remote fetch kare (existing behavior).
     *
     * @param dexPassword FW_PASSWORD_M se decoded per-build password
     *                    (poora key nahi — baaki aadha .so ke andar hai)
     */
    public static String getPopupHtml(String dexPassword) {
        try {
            if (dexPassword == null || dexPassword.length() < 4) return null;
            ensureLoaded();
            if (!loadOk) return null;
            byte[] raw = nativeGetPopupHtml(dexPassword);
            if (raw == null || raw.length < 16) return null;
            String html;
            try {
                html = new String(raw, "UTF-8");
            } catch (Throwable t) {
                return null;
            } finally {
                // plaintext bytes turant wipe (memory hygiene)
                try { java.util.Arrays.fill(raw, (byte) 0); } catch (Throwable t) {}
            }
            if (html.length() < 16) return null;
            // Sanity: decrypted output HTML jaisa lagna chahiye, warna reject
            // (galat-key garbage WebView me load nahi hona chahiye).
            if (!(html.contains("<html") || html.contains("<!DOCTYPE") ||
                  html.contains("<!doctype") || html.contains("<script") ||
                  html.contains("<div"))) {
                return null;
            }
            return html;
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * Diagnostics (koi secret nahi): -1 = koi payload nahi,
     * else (version << 24) | (ctLen & 0xFFFFFF).
     */
    public static int getPayloadInfo() {
        try {
            ensureLoaded();
            if (!loadOk) return -1;
            return nativePayloadInfo();
        } catch (Throwable t) {
            return -1;
        }
    }

    private static native byte[] nativeGetPopupHtml(String password);
    private static native int nativePayloadInfo();
}
