package com.zayro.wingsyttt;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.os.Debug;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.security.MessageDigest;
import java.util.Locale;

import org.json.JSONObject;

/**
 * SecurityManager — centralized security API (protectedRelease builds).
 *
 * Security states:
 *   SECURITY_OK       → sab normal
 *   SECURITY_WARNING  → suspicious environment (root/frida etc.) — app
 *                       chalti hai par sensitive operations restricted
 *   SECURITY_FAILED   → signature/tamper verify fail — protected content
 *                       BLOCKED (remote HTML fetch nahi hota)
 *
 * Build-time patched values (apkbuilder.js XOR-mask karke bharta hai):
 *   EXPECTED_CERT_SHA256_M — production keystore certificate ka SHA-256 hex
 *   IS_PROTECTED_M         — '1' sirf protectedRelease me
 *
 * False-positive se bachne ke liye: root/frida signals sirf WARNING banate
 * hain (block nahi). Sirf SIGNATURE mismatch hi hard-FAILED hai.
 */
public class SecurityManager {

    public static final int SECURITY_OK = 0;
    public static final int SECURITY_WARNING = 1;
    public static final int SECURITY_FAILED = 2;

    // ── Build-time patched (XOR-masked byte arrays) ──
    private static final byte[] EXPECTED_CERT_SHA256_M = new byte[]{ 0, 0 };
    private static final byte[] IS_PROTECTED_M = new byte[]{ 0 };
    private static final int XOR_KEY = 0x5A;

    private static volatile int state = SECURITY_OK;
    private static volatile boolean initialized = false;
    private static int riskScore = 0;

    // Native module (optional — native-security.gradle ke saath compile hota hai)
    private static boolean nativeLoaded = false;
    static {
        try { System.loadLibrary("nativesecurity"); nativeLoaded = true; } catch (Throwable t) { nativeLoaded = false; }
    }

    private static native int nativeIsDebuggerAttached();
    private static native int nativeDetectFrida();

    // ── XOR helpers (build-time constants decode) ──
    private static String decodeX(byte[] m) {
        if (m == null || m.length == 0) return "";
        char[] c = new char[m.length];
        for (int i = 0; i < m.length; i++) c[i] = (char) ((m[i] ^ XOR_KEY) & 0xFF);
        return new String(c);
    }

    public static boolean isProtectedBuild() {
        try { return "1".equals(decodeX(IS_PROTECTED_M)); } catch (Exception e) { return false; }
    }

    // ── Central API ──
    public static void initialize(Context ctx) {
        if (initialized) return;
        initialized = true;
        if (!isProtectedBuild()) { state = SECURITY_OK; return; }

        try {
            // 1) Signature — hard check
            String expected = decodeX(EXPECTED_CERT_SHA256_M);
            if (expected == null || expected.length() < 40 || !verifySignature(ctx, expected)) {
                state = SECURITY_FAILED;
                return;
            }

            // 2) Risk scoring (multiple signals — koi ek weak signal block nahi)
            riskScore = 0;
            riskScore += debuggerChecks();
            riskScore += environmentChecks();

            if (riskScore >= 51) state = SECURITY_FAILED;      // debugger/compromised
            else if (riskScore >= 21) state = SECURITY_WARNING; // root/frida etc.
            else state = SECURITY_OK;
        } catch (Throwable t) {
            state = SECURITY_FAILED;
        }
    }

    public static int getSecurityState() { return state; }
    public static boolean isAuthorized() { return state != SECURITY_FAILED; }
    public static int getRiskScore() { return riskScore; }

    // ── 1) Signature verification ──
    private static boolean verifySignature(Context ctx, String expectedSha256Hex) {
        try {
            PackageManager pm = ctx.getPackageManager();
            Signature[] sigs = null;
            try {
                if (Build.VERSION.SDK_INT >= 28) {
                    PackageInfo info = pm.getPackageInfo(ctx.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
                    if (info.signingInfo != null && info.signingInfo.getApkContentsSigners() != null) {
                        sigs = info.signingInfo.getApkContentsSigners();
                    }
                }
            } catch (Throwable t) { /* fallback neeche */ }
            if (sigs == null || sigs.length == 0) {
                PackageInfo info = pm.getPackageInfo(ctx.getPackageName(), PackageManager.GET_SIGNATURES);
                sigs = info.signatures;
            }
            if (sigs == null || sigs.length == 0) return false;

            String actual = sha256Hex(sigs[0].toByteArray()).toLowerCase(Locale.US);
            return actual.equals(expectedSha256Hex.toLowerCase(Locale.US));
        } catch (Throwable t) {
            return false;
        }
    }

    // ── 2) Asset integrity (assets/integrity.json build-time generate hota hai) ──
    public static boolean verifyAssetIntegrity(Context ctx) {
        try {
            InputStream is = ctx.getAssets().open("integrity.json");
            byte[] buf = readAll(is);
            is.close();
            JSONObject root = new JSONObject(new String(buf, "UTF-8"));
            JSONObject assets = root.optJSONObject("assets");
            if (assets == null) return true; // manifest hi nahi — skip (old build)
            java.util.Iterator<String> keys = assets.keys();
            while (keys.hasNext()) {
                String name = keys.next();
                String expected = assets.optString(name, "");
                if (expected.length() == 0) continue;
                String actual = hashAsset(ctx, name);
                if (actual == null || !actual.equalsIgnoreCase(expected)) {
                    return false; // koi asset chheda gaya
                }
            }
            return true;
        } catch (Throwable t) {
            return true; // manifest missing/corrupt → verify fail hone pe bhi block na ho
        }
    }

    private static String hashAsset(Context ctx, String name) {
        InputStream in = null;
        try {
            in = ctx.getAssets().open(name);
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] b = new byte[8192];
            int n;
            while ((n = in.read(b)) != -1) md.update(b, 0, n);
            return toHex(md.digest());
        } catch (Throwable t) {
            return null;
        } finally {
            try { if (in != null) in.close(); } catch (Throwable t) {}
        }
    }

    // ── 3) Anti-debug (Java + native fallback) ──
    private static int debuggerChecks() {
        int score = 0;
        // Native module (agar hai) — sabse reliable
        if (nativeLoaded) {
            try {
                if (nativeIsDebuggerAttached() != 0) score += 60;
                if (nativeDetectFrida() != 0) score += 30;
            } catch (Throwable t) {}
        }
        // Java checks
        if (Debug.isDebuggerConnected() || Debug.waitingForDebugger()) score += 60;
        try {
            String status = readFile("/proc/self/status");
            if (status != null && status.contains("TracerPid:\t0") == false) {
                // TracerPid non-zero → debugger attached
                if (status.contains("TracerPid:")) score += 60;
            }
        } catch (Throwable t) {}
        return score;
    }

    // ── 4) Environment risk (root/frida/xposed/test-keys) ──
    private static int environmentChecks() {
        int score = 0;
        // Root indicators
        String[] rootPaths = {
            "/system/xbin/su", "/system/bin/su", "/sbin/su", "/data/local/su",
            "/data/local/bin/su", "/data/local/xbin/su", "/system/app/Superuser.apk",
            "/sbin/.magisk", "/data/adb/magisk", "/data/adb/ksu", "/debug_ramdisk"
        };
        int rootHits = 0;
        for (String p : rootPaths) if (new File(p).exists()) rootHits++;
        if (rootHits >= 2) score += 30;
        else if (rootHits == 1) score += 15;

        // Test-keys build (release device pe custom ROM indicator)
        String tag = Build.TAGS;
        if (tag != null && tag.contains("test-keys")) score += 10;

        // Frida / Xposed via maps
        try {
            String maps = readFile("/proc/self/maps");
            if (maps != null) {
                String lower = maps.toLowerCase(Locale.US);
                if (lower.contains("frida") || lower.contains("gadget")) score += 40;
                if (lower.contains("xposed") || lower.contains("lsposed")) score += 20;
            }
        } catch (Throwable t) {}

        // Suspicious apps (packages)
        try {
            String[] suspicious = {
                "de.robv.android.xposed.installer", "com.saurik.substrate", "com.dimonvideo.luckypatcher"
            };
            Context appCtx = com.zayro.wingsyttt.SketchApplication.get();
            if (appCtx != null) {
                PackageManager pm = appCtx.getPackageManager();
                for (String s : suspicious) {
                    try { pm.getPackageInfo(s, 0); score += 10; } catch (Throwable t) {}
                }
            }
        } catch (Throwable t) {}
        return score;
    }

    // ── Utils ──
    private static String readFile(String path) {
        BufferedReader br = null;
        try {
            br = new BufferedReader(new InputStreamReader(new FileInputStream(path)));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line).append('\n');
            return sb.toString();
        } catch (Throwable t) {
            return null;
        } finally {
            try { if (br != null) br.close(); } catch (Throwable t) {}
        }
    }

    private static byte[] readAll(InputStream is) throws Exception {
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] b = new byte[8192];
        int n;
        while ((n = is.read(b)) != -1) bos.write(b, 0, n);
        return bos.toByteArray();
    }

    private static String sha256Hex(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return toHex(md.digest(data));
        } catch (Throwable t) { return ""; }
    }

    private static String toHex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format(Locale.US, "%02x", x & 0xFF));
        return sb.toString();
    }
}
