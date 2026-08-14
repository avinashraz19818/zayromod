package com.zayro.wingsyttt;

public class SecurityUtil {
    static {
        System.loadLibrary("zayrosecurity");
    }

    // Per-build decrypt password (XOR-masked inside the .so — no plaintext strings)
    public native String getDecryptKey();

    // Expected signing-certificate SHA-256, burned in at build time.
    // Empty array == integrity check disabled for this build.
    public native byte[] getCertHash();

    public native byte[] getMarker();
}
