package com.zayro.wingsyttt;

import android.app.Application;
import android.content.Context;

/**
 * Simple app class — context holder (SecurityManager environment checks
 * ke liye) + startup security initialization.
 */
public class SketchApplication extends Application {

    private static Application instance;

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        // Security checks jaldi se shuru — MainActivity bhi initialize
        // karta hai (double init safe hai, guard hai andar).
        try {
            SecurityManager.initialize(this);
        } catch (Throwable t) { }
    }

    public static Application get() {
        return instance;
    }
}
