# ── protectedRelease EXTRA rules (release rules ke upar) ──
# No logging AT ALL in protected builds
-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
    public static *** i(...);
    public static *** w(...);
    public static *** e(...);
    public static *** wtf(...);
}

# No debug attributes, no source hints
-keepattributes !SourceFile,!SourceDir,!LineNumberTable,!LocalVariableTable,!LocalVariableTypeTable,!InnerClasses,!Signature,!EnclosingMethod,!Exceptions

# Security manager ko compact rakho, par use kabhi remove na karo
-keep,allowshrinking,allowoptimization class com.zayro.wingsyttt.SecurityManager { *; }
