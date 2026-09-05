// ─────────────────────────────────────────────────────────────────────────────
// payload_crypto.cpp — HMAC-SHA256 + PBKDF2 + ZPAY01 verify/decrypt.
// ─────────────────────────────────────────────────────────────────────────────
#include "payload_crypto.h"

#include <stdlib.h>
#include <string.h>

#include "sha256.h"
#include "aes.h"

const uint8_t ZPAY_MAGIC[ZPAY_MAGIC_LEN] = {0x5A, 0x50, 0x41, 0x59, 0x30, 0x31, 0x00, 0x01};

static void zpay_memzero(void* p, size_t n) {
    volatile uint8_t* v = (volatile uint8_t*)p;
    while (n--) *v++ = 0;
}

void zpay_hmac_sha256(const uint8_t* key, size_t keyLen,
                      const uint8_t* msg, size_t msgLen,
                      uint8_t out[32]) {
    uint8_t kbuf[64];
    memset(kbuf, 0, sizeof(kbuf));
    if (keyLen > 64) {
        zpay_sha256(key, keyLen, kbuf);
    } else if (keyLen > 0 && key != NULL) {
        memcpy(kbuf, key, keyLen);
    }

    uint8_t ipad[64], opad[64];
    for (int i = 0; i < 64; i++) {
        ipad[i] = (uint8_t)(kbuf[i] ^ 0x36);
        opad[i] = (uint8_t)(kbuf[i] ^ 0x5c);
    }

    zpay_sha256_ctx ctx;
    uint8_t inner[32];
    zpay_sha256_init(&ctx);
    zpay_sha256_update(&ctx, ipad, 64);
    if (msgLen > 0) zpay_sha256_update(&ctx, msg, msgLen);
    zpay_sha256_final(&ctx, inner);

    zpay_sha256_init(&ctx);
    zpay_sha256_update(&ctx, opad, 64);
    zpay_sha256_update(&ctx, inner, 32);
    zpay_sha256_final(&ctx, out);

    zpay_memzero(kbuf, sizeof(kbuf));
    zpay_memzero(ipad, sizeof(ipad));
    zpay_memzero(opad, sizeof(opad));
    zpay_memzero(inner, sizeof(inner));
}

int zpay_pbkdf2_hmac_sha256(const uint8_t* pw, size_t pwLen,
                            const uint8_t* salt, size_t saltLen,
                            uint32_t iterations,
                            uint8_t* dk, size_t dkLen) {
    if (!pw || !salt || !dk) return -1;
    if (dkLen == 0 || dkLen > 64) return -1;
    if (iterations < 10000 || iterations > 2000000) return -1;

    // dkLen <= 32 ke liye 1 block, 33..64 ke liye 2 blocks
    uint8_t U[32], T[32];
    size_t blocks = (dkLen + 31) / 32;
    for (size_t b = 1; b <= blocks; b++) {
        uint8_t* msg = (uint8_t*)malloc(saltLen + 4);
        if (!msg) return -1;
        memcpy(msg, salt, saltLen);
        msg[saltLen]     = (uint8_t)((b >> 24) & 0xFF);
        msg[saltLen + 1] = (uint8_t)((b >> 16) & 0xFF);
        msg[saltLen + 2] = (uint8_t)((b >> 8) & 0xFF);
        msg[saltLen + 3] = (uint8_t)(b & 0xFF);

        zpay_hmac_sha256(pw, pwLen, msg, saltLen + 4, U);
        zpay_memzero(msg, saltLen + 4);
        free(msg);
        memcpy(T, U, 32);

        for (uint32_t i = 1; i < iterations; i++) {
            zpay_hmac_sha256(pw, pwLen, U, 32, U);
            for (int k = 0; k < 32; k++) T[k] ^= U[k];
        }
        size_t off = (b - 1) * 32;
        size_t n = dkLen - off;
        if (n > 32) n = 32;
        memcpy(dk + off, T, n);
    }
    zpay_memzero(U, sizeof(U));
    zpay_memzero(T, sizeof(T));
    return 0;
}

int zpay_ct_compare(const uint8_t* a, const uint8_t* b, size_t len) {
    if (!a || !b) return -1;
    uint8_t diff = 0;
    for (size_t i = 0; i < len; i++) diff |= (uint8_t)(a[i] ^ b[i]);
    return diff == 0 ? 0 : 1;
}

void zpay_rebuild_pepper_hex(const uint8_t masked[16], const uint8_t mask[16],
                             unsigned int rot, char outHex33[33]) {
    static const char kHex[] = "0123456789abcdef";
    unsigned char unmasked[16];
    for (int i = 0; i < 16; i++) {
        unmasked[i] = (unsigned char)(masked[i] ^ mask[i]);
    }
    // build-time: rotated[i] = pepper[(i+rot)%16] → pepper[j] = rotated[(j-rot)&15]
    unsigned int r = rot & 15u;
    unsigned char pepper[16];
    for (int j = 0; j < 16; j++) {
        pepper[j] = unmasked[(j - (int)r + 32) & 15];
    }
    for (int i = 0; i < 16; i++) {
        outHex33[i * 2]     = kHex[(pepper[i] >> 4) & 0xF];
        outHex33[i * 2 + 1] = kHex[pepper[i] & 0xF];
    }
    outHex33[32] = 0;
    zpay_memzero(unmasked, sizeof(unmasked));
    zpay_memzero(pepper, sizeof(pepper));
}

static uint32_t zpay_read_u32le(const uint8_t* p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
           ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

int zpay_decrypt_payload(const uint8_t* payload, size_t payloadLen,
                         const uint8_t* pwFull, size_t pwFullLen,
                         uint8_t** outPlain, size_t* outLen) {
    if (outPlain) *outPlain = NULL;
    if (outLen) *outLen = 0;
    if (!payload || !pwFull || !outPlain || !outLen) return -1;
    if (pwFullLen < 8 || pwFullLen > 512) return -1;
    if (payloadLen < ZPAY_HEADER_MIN + ZPAY_TAG_LEN) return -1;

    // 1) magic
    if (zpay_ct_compare(payload, ZPAY_MAGIC, ZPAY_MAGIC_LEN) != 0) return -1;

    // 2) lengths
    uint32_t iters = zpay_read_u32le(payload + 8);
    const uint8_t* salt = payload + 12;
    const uint8_t* iv = payload + 12 + ZPAY_SALT_LEN;
    uint32_t ctLen = zpay_read_u32le(payload + 12 + ZPAY_SALT_LEN + ZPAY_IV_LEN);
    if (ctLen == 0 || ctLen > ZPAY_MAX_CT) return -1;
    size_t wantLen = (size_t)ZPAY_HEADER_MIN + (size_t)ctLen + (size_t)ZPAY_TAG_LEN;
    if (payloadLen != wantLen) return -1;
    const uint8_t* ct = payload + ZPAY_HEADER_MIN;
    const uint8_t* tag = ct + ctLen;
    size_t signedLen = (size_t)ZPAY_HEADER_MIN + (size_t)ctLen; // tag se pehle sab

    // 3) keys
    uint8_t dk[64];
    if (zpay_pbkdf2_hmac_sha256(pwFull, pwFullLen, salt, ZPAY_SALT_LEN, iters, dk, 64) != 0) {
        zpay_memzero(dk, sizeof(dk));
        return -1;
    }

    // 4) MAC verify FIRST (constant-time)
    uint8_t expect[32];
    zpay_hmac_sha256(dk + 32, 32, payload, signedLen, expect);
    int macOk = zpay_ct_compare(expect, tag, ZPAY_TAG_LEN);
    zpay_memzero(expect, sizeof(expect));
    if (macOk != 0) {
        zpay_memzero(dk, sizeof(dk));
        return -1; // tampered / wrong key — decrypt hi nahi karte
    }

    // 5) decrypt (CTR)
    uint8_t* plain = (uint8_t*)malloc(ctLen + 1);
    if (!plain) {
        zpay_memzero(dk, sizeof(dk));
        return -1;
    }
    zpay_aes256_ctr(dk, iv, ct, plain, ctLen);
    plain[ctLen] = 0;
    zpay_memzero(dk, sizeof(dk));

    *outPlain = plain;
    *outLen = ctLen;
    return 0;
}
