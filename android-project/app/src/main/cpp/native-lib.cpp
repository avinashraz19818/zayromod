#include <jni.h>
#include <string>

// Obfuscated decrypt key - split across multiple functions
static const char* getPart1() { return "zayro"; }
static const char* getPart2() { return "avi@"; }
static const char* getPart3() { return "132"; }

extern "C" JNIEXPORT jstring JNICALL
Java_com_zayro_wingsyttt_SecurityUtil_getDecryptKey(JNIEnv* env, jobject) {
    // Assemble key at runtime
    std::string key = std::string(getPart1()) + getPart2() + getPart3();
    return env->NewStringUTF(key.c_str());
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_zayro_wingsyttt_SecurityUtil_getMarker(JNIEnv* env, jobject) {
    // Obfuscated marker bytes
    jbyte marker[] = {(jbyte)0xDE, (jbyte)0xAD, (jbyte)0xBE, (jbyte)0xEF,
                      (jbyte)0xCA, (jbyte)0xFE, (jbyte)0xBA, (jbyte)0xBE};
    jbyteArray result = env->NewByteArray(8);
    env->SetByteArrayRegion(result, 0, 8, marker);
    return result;
}
