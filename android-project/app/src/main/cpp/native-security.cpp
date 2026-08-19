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
