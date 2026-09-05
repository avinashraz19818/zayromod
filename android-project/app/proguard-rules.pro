# Standard Android R8 optimization and minification rules
-dontwarn **
-ignorewarnings

# Optimization passes
-optimizationpasses 5

# Remove all debug logs in production
-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
    public static *** i(...);
    public static *** w(...);
    public static *** e(...);
    public static *** wtf(...);
}

# Keep only essential Android components
-keep public class * extends android.app.Activity
-keep public class * extends android.app.Service
-keep public class * extends android.content.BroadcastReceiver
-keep public class * extends android.app.Application

# Native methods protection
-keepclasseswithmembernames class * {
    native <methods>;
}

# Enum safety
-keepclassmembers enum * {
    public static **[] values();
    public static ** valueOf(java.lang.String);
}

# WebView JavaScript interface (ZAYRO / ZAYROUI)
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# Prevent reflection issues
-keepattributes Signature
-keepattributes *Annotation*

# SecurityManager
-keep class com.zayro.wingsyttt.SecurityManager { *; }

# NativePayload — JNI names explicit hain (native-payload.cpp), rename hua to
# native calls toot jayenge. Class + native methods dono preserve rakho.
-keep class com.zayro.wingsyttt.NativePayload { *; }

# JSON parsing
-keep class org.json.** { *; }
