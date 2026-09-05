// ─────────────────────────────────────────────────────────────────────────────
// native-payload.cpp — POPUP HTML ka native .so loader (ZPAY01 container).
//
//   Java: NativePayload.getPopupHtml(dexPassword)
//     → nativeGetPopupHtml(password)
//     → pepper reconstruct (header se: unmask + unrotate)
//     → pwFull = password + "|zpay1|" + pepperHex
//     → zpay_decrypt_payload (MAC verify, phir AES-256-CTR decrypt)
//     → plaintext bytes Java ko (sirf memory me, disk par kabhi nahi)
//
// Koi bhi failure (empty payload / galat key / tamper / exception) par NULL
// return hota hai — Java existing REMOTE content flow par gir jata hai.
// App kabhi crash nahi hota, koi secret log nahi hota.
// ─────────────────────────────────────────────────────────────────────────────
#include <jni.h>
#include <stdlib.h>
#include <string.h>

#include "crypto/payload_crypto.h"
#include "payload/popup_payload.h"

static void zpay_memzero_local(void* p, size_t n) {
    volatile unsigned char* v = (volatile unsigned char*)p;
    while (n--) *v++ = 0;
}

static const char kPepperSep[] = "|zpay1|";

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_zayro_wingsyttt_NativePayload_nativeGetPopupHtml(JNIEnv* env, jclass,
                                                          jstring password) {
    if (env == NULL || password == NULL) return NULL;
    // Placeholder / empty payload → turant null (remote fallback).
    if (ZPAY_PAYLOAD_LEN < (unsigned long)(ZPAY_HEADER_MIN + ZPAY_TAG_LEN)) return NULL;
    if (ZPAY_PAYLOAD_LEN > (unsigned long)(ZPAY_HEADER_MIN + ZPAY_MAX_CT + ZPAY_TAG_LEN)) return NULL;

    const char* pwChars = env->GetStringUTFChars(password, NULL);
    if (pwChars == NULL) return NULL; // OOM — exception pending, null lautao
    size_t pwLen = strlen(pwChars);
    if (pwLen < 4 || pwLen > 256) {
        env->ReleaseStringUTFChars(password, pwChars);
        return NULL;
    }

    char pepperHex[33];
    zpay_rebuild_pepper_hex(ZPAY_PEPPER_M, ZPAY_PEPPER_MASK, ZPAY_PEPPER_ROT, pepperHex);

    // pwFull = password + "|zpay1|" + pepperHex
    size_t sepLen = strlen(kPepperSep);
    size_t fullLen = pwLen + sepLen + 32;
    char* full = (char*)malloc(fullLen + 1);
    jbyteArray result = NULL;
    if (full != NULL) {
        memcpy(full, pwChars, pwLen);
        memcpy(full + pwLen, kPepperSep, sepLen);
        memcpy(full + pwLen + sepLen, pepperHex, 32);
        full[fullLen] = 0;

        uint8_t* plain = NULL;
        size_t plainLen = 0;
        int rc = zpay_decrypt_payload(ZPAY_PAYLOAD, (size_t)ZPAY_PAYLOAD_LEN,
                                      (const uint8_t*)full, fullLen,
                                      &plain, &plainLen);
        zpay_memzero_local(full, fullLen);
        free(full);
        full = NULL;

        if (rc == 0 && plain != NULL && plainLen > 0 && plainLen <= ZPAY_MAX_CT) {
            // jbyteArray me copy — Java WebView ko degi, disk par nahi likhegi
            jsize jlen = (jsize)plainLen;
            result = env->NewByteArray(jlen);
            if (result != NULL) {
                env->SetByteArrayRegion(result, 0, jlen, (const jbyte*)plain);
                if (env->ExceptionCheck()) {
                    env->ExceptionClear();
                    env->DeleteLocalRef(result);
                    result = NULL;
                }
            }
            zpay_memzero_local(plain, plainLen);
            free(plain);
        } else {
            if (plain != NULL) {
                zpay_memzero_local(plain, plainLen);
                free(plain);
            }
            result = NULL; // tamper / wrong key → remote fallback
        }
    }

    zpay_memzero_local(pepperHex, sizeof(pepperHex));
    env->ReleaseStringUTFChars(password, pwChars);
    return result;
}

// Diagnostics (koi secret nahi): payload Info packed int.
//   -1 = bilkul payload nahi (placeholder / too small)
//   else (ctLen & 0xFFFFFF) | (version << 24)
extern "C" JNIEXPORT jint JNICALL
Java_com_zayro_wingsyttt_NativePayload_nativePayloadInfo(JNIEnv*, jclass) {
    if (ZPAY_PAYLOAD_LEN < (unsigned long)(ZPAY_HEADER_MIN + ZPAY_TAG_LEN)) return -1;
    const uint8_t* p = ZPAY_PAYLOAD;
    // magic check (non-constant-time OK — ye sirf info hai, gate nahi)
    for (int i = 0; i < ZPAY_MAGIC_LEN; i++) {
        if (p[i] != ZPAY_MAGIC[i]) return -1;
    }
    uint32_t ctLen = (uint32_t)p[12 + 16 + 16] |
                     ((uint32_t)p[12 + 16 + 16 + 1] << 8) |
                     ((uint32_t)p[12 + 16 + 16 + 2] << 16) |
                     ((uint32_t)p[12 + 16 + 16 + 3] << 24);
    if (ctLen == 0 || ctLen > ZPAY_MAX_CT) return -1;
    size_t want = (size_t)ZPAY_HEADER_MIN + (size_t)ctLen + (size_t)ZPAY_TAG_LEN;
    if ((size_t)ZPAY_PAYLOAD_LEN != want) return -1;
    return (jint)(((uint32_t)1 << 24) | (ctLen & 0xFFFFFFu));
}
