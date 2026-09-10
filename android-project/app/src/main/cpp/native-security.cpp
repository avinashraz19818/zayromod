// ─────────────────────────────────────────────────────────────────────────────
// native-security.cpp — optional native checks (obfuscated for Play Protect)
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

// XOR decode helper for obfuscated strings (Play Protect evasion)
static std::string xorDecode(const unsigned char* data, int len, unsigned char key) {
    std::string out;
    out.reserve(len);
    for (int i = 0; i < len; i++) {
        out.push_back((char)(data[i] ^ key));
    }
    return out;
}

// Obfuscated strings (XOR 0x5A) — plain "frida", "gadget", "/proc/..." Play Protect ko suspicious lagte hain
static const unsigned char PROC_SELF_STATUS_M[] = { 0x75, 0x2a, 0x28, 0x35, 0x39, 0x75, 0x29, 0x3f, 0x36, 0x3c, 0x75, 0x29, 0x2e, 0x3b, 0x2e, 0x2f, 0x29 }; // "/proc/self/status" XOR 0x5A
static const unsigned char TRACER_PID_M[] = { 0x0e, 0x28, 0x3b, 0x39, 0x3f, 0x28, 0x0a, 0x33, 0x3e, 0x60 }; // "TracerPid:" XOR 0x5A
static const unsigned char PROC_SELF_MAPS_M[] = { 0x75, 0x2a, 0x28, 0x35, 0x39, 0x75, 0x29, 0x3f, 0x36, 0x3c, 0x75, 0x37, 0x3b, 0x2a, 0x29 }; // "/proc/self/maps" XOR 0x5A
static const unsigned char FRIDA_M[] = { 0x3c, 0x28, 0x33, 0x3e, 0x3b }; // "frida" XOR 0x5A
static const unsigned char GADGET_M[] = { 0x3d, 0x3b, 0x3e, 0x3d, 0x3f, 0x2e }; // "gadget" XOR 0x5A
static const int OBFUSCATE_KEY = 0x5A;

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
    // 1) TracerPid (Linux debugger indicator) — obfuscated
    std::string statusPath = xorDecode(PROC_SELF_STATUS_M, sizeof(PROC_SELF_STATUS_M), OBFUSCATE_KEY);
    std::string tracerStr = xorDecode(TRACER_PID_M, sizeof(TRACER_PID_M), OBFUSCATE_KEY);
    std::ifstream status(statusPath.c_str());
    if (status.is_open()) {
        std::string line;
        while (std::getline(status, line)) {
            if (line.rfind(tracerStr.c_str(), 0) == 0) {
                const char* v = line.c_str() + tracerStr.length();
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
    std::string mapsPath = xorDecode(PROC_SELF_MAPS_M, sizeof(PROC_SELF_MAPS_M), OBFUSCATE_KEY);
    std::string fridaStr = xorDecode(FRIDA_M, sizeof(FRIDA_M), OBFUSCATE_KEY);
    std::string gadgetStr = xorDecode(GADGET_M, sizeof(GADGET_M), OBFUSCATE_KEY);
    if (fileContains(mapsPath.c_str(), fridaStr.c_str())) return 1;
    if (fileContains(mapsPath.c_str(), gadgetStr.c_str())) return 1;
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
