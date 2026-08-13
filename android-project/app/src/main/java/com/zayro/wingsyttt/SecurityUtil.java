package com.zayro.wingsyttt;

public class SecurityUtil {
    static {
        System.loadLibrary("zayrosecurity");
    }

    public native String getDecryptKey();
    public native byte[] getMarker();
}
