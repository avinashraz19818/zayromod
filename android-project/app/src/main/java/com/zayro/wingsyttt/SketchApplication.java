package com.zayro.wingsyttt;

import android.app.Application;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.widget.Toast;

/**
 * Runs before any activity. Verifies that the APK was signed with the original
 * keystore. If the APK has been decompiled, modified and re-signed with a
 * different key, the signature hash won't match the build-time value embedded
 * in the native library and the app refuses to run — so repackaged/cracked
 * builds fail immediately instead of working.
 */
public class SketchApplication extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        checkIntegrity();
    }

    private void checkIntegrity() {
        try {
            final SecurityUtil sec = new SecurityUtil();
            final byte[] expected = sec.getCertHash();
            if (expected == null || expected.length == 0) return; // check not embedded

            PackageInfo info = getPackageManager().getPackageInfo(
                    getPackageName(), PackageManager.GET_SIGNATURES);
            Signature[] sigs = info.signatures;
            if (sigs == null || sigs.length == 0) return;

            byte[] actual = CryptoUtil.sha256(sigs[0].toByteArray());

            boolean ok = actual.length == expected.length;
            if (ok) {
                for (int i = 0; i < actual.length; i++) {
                    if (actual[i] != expected[i]) { ok = false; break; }
                }
            }

            if (!ok) {
                try {
                    Toast.makeText(this, "App integrity check failed", Toast.LENGTH_SHORT).show();
                } catch (Exception ignored) {}
                Thread t = new Thread(new Runnable() {
                    @Override public void run() {
                        try { Thread.sleep(1400); } catch (InterruptedException ignored) {}
                        android.os.Process.killProcess(android.os.Process.myPid());
                        System.exit(0);
                    }
                });
                t.setDaemon(true);
                t.start();
            }
        } catch (Exception ignored) {}
    }
}
