// ─────────────────────────────────────────────────────────────────────────────
// payload_crypto.h — "ZPAY01" container verify + decrypt (pure C++, no JNI).
//
// Format (utils/native-payload.js ke saath byte-compatible hona chahiye):
//   magic[8] "ZPAY01\0\1" | iters u32LE | salt[16] | iv[16] | ctLen u32LE |
//   ciphertext[ctLen] | tag[32] = HMAC-SHA256(macKey, sab-kuch-tag-se-pehle)
// Keys: dk = PBKDF2-HMAC-SHA256(pwFull, salt, iters, 64);
//       encKey = dk[0:32], macKey = dk[32:64].
//
// Yahi file host unit-test me bhi compile hoti hai (same algorithm verify).
// ─────────────────────────────────────────────────────────────────────────────
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define ZPAY_MAGIC_LEN 8
#define ZPAY_SALT_LEN 16
#define ZPAY_IV_LEN 16
#define ZPAY_TAG_LEN 32
#define ZPAY_HEADER_MIN (8 + 4 + 16 + 16 + 4)
#define ZPAY_MAX_CT (8u * 1024u * 1024u) // 8 MB sanity cap

extern const uint8_t ZPAY_MAGIC[ZPAY_MAGIC_LEN];

// HMAC-SHA256 one-shot
void zpay_hmac_sha256(const uint8_t* key, size_t keyLen,
                      const uint8_t* msg, size_t msgLen,
                      uint8_t out[32]);

// PBKDF2-HMAC-SHA256 (dkLen max 64 yahan; hamare liye 64 chahiye)
int zpay_pbkdf2_hmac_sha256(const uint8_t* pw, size_t pwLen,
                            const uint8_t* salt, size_t saltLen,
                            uint32_t iterations,
                            uint8_t* dk, size_t dkLen);

// Constant-time compare (0 = equal)
int zpay_ct_compare(const uint8_t* a, const uint8_t* b, size_t len);

// Build-time obfuscated pepper reconstruct (generated header constants se).
// masked/mask: 16 bytes each; rot: 0..15. outHex33: 32 lowercase hex + NUL.
// (native-payload.cpp aur host test dono YAHI function use karte hain.)
void zpay_rebuild_pepper_hex(const uint8_t masked[16], const uint8_t mask[16],
                             unsigned int rot, char outHex33[33]);

// Container verify + decrypt.
//   payload/payloadLen : embedded bytes (header se)
//   pwFull/pwFullLen   : perBuildPassword + "|zpay1|" + pepperHex
//   outPlain           : malloc'd plaintext (caller free kare); outLen me length
// Returns: 0 = OK, nonzero = fail (koi partial plaintext bahar nahi aata).
// NOTE: pehle HMAC verify hota hai, TABHI decrypt (Encrypt-then-MAC).
int zpay_decrypt_payload(const uint8_t* payload, size_t payloadLen,
                         const uint8_t* pwFull, size_t pwFullLen,
                         uint8_t** outPlain, size_t* outLen);

#ifdef __cplusplus
}
#endif
