// ─────────────────────────────────────────────────────────────────────────────
// native-security.cpp — optional native checks (original implementation)
//
// Checks:
//   nativeIsDebuggerAttached — /proc/self/status ka TracerPid + ptrace self
//   nativeDetectFrida        — /proc/self/maps me frida/gadget scan
//
// Java-side SecurityManager inhi ko try/catch me call karta hai; lib na ho
// to Java fallback checks chalti hain (isliye NDK optional hai).
// ─────────────────────────────────────────────────────────────────────────────
#include <jni.h>
#include <string>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include "content_payload.h"

static bool fileContains(const char* path, const char* needle) {
    std::ifstream in(path);
    if (!in.is_open()) return false;
    std::stringstream ss;
    ss << in.rdbuf();
    std::string content = ss.str();
    return content.find(needle) != std::string::npos;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_zayro_wingsyttt_SecurityManager_nativeIsDebuggerAttached(JNIEnv*, jobject) {
    // 1) TracerPid (Linux debugger indicator)
    std::ifstream status("/proc/self/status");
    if (status.is_open()) {
        std::string line;
        while (std::getline(status, line)) {
            if (line.rfind("TracerPid:", 0) == 0) {
                const char* v = line.c_str() + 10;
                while (*v == ' ' || *v == '\t') v++;
                if (atoi(v) != 0) return 1;
                break;
            }
        }
    }
    return 0;
}

extern "C" JNIEXPORT jint JNICALL
Java_com_zayro_wingsyttt_SecurityManager_nativeDetectFrida(JNIEnv*, jobject) {
    if (fileContains("/proc/self/maps", "frida")) return 1;
    if (fileContains("/proc/self/maps", "gadget")) return 1;
    return 0;
}

// ── CONTENT VAULT — popup HTML .so me protected ──
// CONTENT_ENC = AES-256-CBC encrypted .bin (MARKER+salt+iv+cipher+padding)
// CONTENT_PWD_M = XOR-masked password (XOR_KEY 0x5A)
// CONTENT_HAS_DATA = 0/1 flag — template build me 0 hota hai, real build me 1
extern "C" JNIEXPORT jint JNICALL
Java_com_zayro_wingsyttt_SecurityManager_nativeHasEmbeddedContent(JNIEnv*, jclass) {
    return CONTENT_HAS_DATA;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_zayro_wingsyttt_SecurityManager_nativeGetContentEnc(JNIEnv* env, jclass) {
    if (CONTENT_HAS_DATA == 0 || CONTENT_ENC_LEN <= 1) return nullptr;
    jbyteArray arr = env->NewByteArray(CONTENT_ENC_LEN);
    if (!arr) return nullptr;
    env->SetByteArrayRegion(arr, 0, CONTENT_ENC_LEN, reinterpret_cast<const jbyte*>(CONTENT_ENC));
    return arr;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_zayro_wingsyttt_SecurityManager_nativeGetContentPwd(JNIEnv* env, jclass) {
    if (CONTENT_HAS_DATA == 0 || CONTENT_PWD_M_LEN <= 1) return nullptr;
    // Decode XOR-masked password
    char buf[512];
    int len = CONTENT_PWD_M_LEN;
    if (len >= (int)sizeof(buf)) len = sizeof(buf) - 1;
    for (int i = 0; i < len; i++) {
        buf[i] = (char)(CONTENT_PWD_M[i] ^ CONTENT_XOR_KEY);
    }
    buf[len] = '\0';
    return env->NewStringUTF(buf);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_zayro_wingsyttt_SecurityManager_nativeGetContentEncLen(JNIEnv*, jclass) {
    return CONTENT_ENC_LEN;
}
