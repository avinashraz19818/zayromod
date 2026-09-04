package com.zayro.wingsyttt;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.os.Debug;

import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Locale;

import org.json.JSONObject;

/**
 * SecurityManager — centralized integrity and signature verification.
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

    private static volatile boolean nativeLibraryLoaded = false;

    private static native int nativeIsDebuggerAttached();
    private static native int nativeDetectFrida();

    private static void loadNativeSecurity() {
        if (nativeLibraryLoaded) return;
        try {
            System.loadLibrary("nativesecurity");
            nativeLibraryLoaded = true;
        } catch (Throwable ignored) {
            nativeLibraryLoaded = false;
        }
    }

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

        loadNativeSecurity();

        try {
            // 1) Signature — hard check
            String expected = decodeX(EXPECTED_CERT_SHA256_M);
            if (expected == null || expected.length() < 40 || !verifySignature(ctx, expected)) {
                state = SECURITY_FAILED;
                return;
            }

            // 2) Basic debugger check
            if (Debug.isDebuggerConnected() || Debug.waitingForDebugger()) {
                state = SECURITY_FAILED;
                return;
            }

            if (nativeLibraryLoaded) {
                try {
                    if (nativeIsDebuggerAttached() != 0 ||
                        nativeDetectFrida() != 0) {
                        state = SECURITY_FAILED;
                        return;
                    }
                } catch (Throwable ignored) {
                    // Java fallback remains active if native calls fail.
                }
            }

            state = SECURITY_OK;
        } catch (Throwable t) {
            state = SECURITY_OK;
        }
    }

    public static int getSecurityState() { return state; }
    public static boolean isAuthorized() { return state != SECURITY_FAILED; }
    public static int getRiskScore() { return riskScore; }

    // ── Signature verification ──
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
            } catch (Throwable t) { /* fallback */ }
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

    // ── Asset integrity ──
    public static boolean verifyAssetIntegrity(Context ctx) {
        try {
            InputStream is = ctx.getAssets().open("integrity.json");
            byte[] buf = readAll(is);
            is.close();
            JSONObject root = new JSONObject(new String(buf, "UTF-8"));
            JSONObject assets = root.optJSONObject("assets");
            if (assets == null) return true;
            java.util.Iterator<String> keys = assets.keys();
            while (keys.hasNext()) {
                String name = keys.next();
                String expected = assets.optString(name, "");
                if (expected.length() == 0) continue;
                String actual = hashAsset(ctx, name);
                if (actual == null || !actual.equalsIgnoreCase(expected)) {
                    return false;
                }
            }
            return true;
        } catch (Throwable t) {
            return true;
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
