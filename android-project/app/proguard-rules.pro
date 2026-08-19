# Advanced APK Protection & Obfuscation
-dontwarn **
-ignorewarnings

# Aggressive obfuscation
-repackageclasses 'o'
-allowaccessmodification
-overloadaggressively

# Remove all logs in production
-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
    public static *** i(...);
    public static *** w(...);
    public static *** e(...);
}

# String encryption (obfuscate all strings)
-adaptclassstrings

# Hide all source file info
-renamesourcefileattribute ""
-keepattributes !SourceFile,!SourceDir

# Remove debug attributes
-keepattributes !LocalVariableTable,!LocalVariableTypeTable

# Keep only essential Android components
-keep public class * extends android.app.Activity
-keep public class * extends android.app.Service
-keep public class * extends android.content.BroadcastReceiver
-keep public class * extends android.app.Application

# Native methods protection - CRITICAL
-keepclasseswithmembernames class * {
    native <methods>;
}

# Keep SecurityUtil native methods
-keep class com.zayro.wingsyttt.SecurityUtil {
    native <methods>;
}

# Enum safety
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# WebView JavaScript interface (if using WebView)
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Prevent reflection issues
-keepattributes Signature
-keepattributes *Annotation*

# Remove unused code
-assumenosideeffects class kotlin.jvm.internal.Intrinsics {
    public static void check*(...);
    public static void throw*(...);
}

# Additional optimization
-optimizations !code/simplification/arithmetic,!code/simplification/cast,!field/*,!class/merging/*
-optimizationpasses 5

# ── WebView JavaScript bridge (ZAYRO / ZAYROUI) ──
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# ── Native security module (agar enable ho) ──
-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}

# ── SecurityManager ka state access reflection se nahi hota — obfuscation OK,
#    par class remove na ho (MainActivity directly use karta hai) ──
-keep class com.zayro.wingsyttt.SecurityManager { *; }

# ── JSON parsing (org.json) reflection-safe ──
-keep class org.json.** { *; }
