/*
 * Generated per-build by utils/encrypt.js — do not edit.
 * Contains the build-unique XOR-masked decrypt key and the expected signing
 * certificate hash. No plaintext secrets are stored in this binary.
 */
#include <jni.h>
#include <string>

static const int gPwLen = 30;
static const int gCertLen = 0;
static const unsigned char gPwMask[30] = {0,208,41,207,150,223,81,61,165,208,145,239,154,200,144,153,141,101,10,196,167,194,132,159,144,73,151,248,172,2};
static const unsigned char gPwData[30] = {122,177,80,189,249,183,48,79,193,181,255,134,244,175,246,248,225,9,104,165,196,169,180,175,160,121,167,200,156,50};
static const unsigned char gCertMask[0] = {};
static const unsigned char gCertData[0] = {};

// Recover the build password at runtime (never stored in plaintext).
static void zayroRecoverPassword(char* out, int maxLen) {
    int len = gPwLen < (maxLen - 1) ? gPwLen : (maxLen - 1);
    for (int i = 0; i < len; i++) out[i] = (char)(gPwMask[i] ^ gPwData[i]);
    out[len] = '\0';
}

// Recover the expected signing-certificate SHA-256 at runtime.
static void zayroRecoverCertHash(unsigned char* out, int maxLen) {
    int len = gCertLen < maxLen ? gCertLen : maxLen;
    for (int i = 0; i < len; i++) out[i] = (unsigned char)(gCertMask[i] ^ gCertData[i]);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_zayro_wingsyttt_SecurityUtil_getDecryptKey(JNIEnv* env, jobject) {
    char key[96];
    zayroRecoverPassword(key, sizeof(key));
    return env->NewStringUTF(key);
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_zayro_wingsyttt_SecurityUtil_getCertHash(JNIEnv* env, jobject) {
    jbyte out[64];
    int len = gCertLen;
    if (len <= 0) return env->NewByteArray(0);
    if (len > 64) len = 64;
    zayroRecoverCertHash((unsigned char*)out, len);
    jbyteArray result = env->NewByteArray(len);
    env->SetByteArrayRegion(result, 0, len, out);
    return result;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_zayro_wingsyttt_SecurityUtil_getMarker(JNIEnv* env, jobject) {
    jbyte marker[] = {(jbyte)0xDE, (jbyte)0xAD, (jbyte)0xBE, (jbyte)0xEF,
                      (jbyte)0xCA, (jbyte)0xFE, (jbyte)0xBA, (jbyte)0xBE};
    jbyteArray result = env->NewByteArray(8);
    env->SetByteArrayRegion(result, 0, 8, marker);
    return result;
}
