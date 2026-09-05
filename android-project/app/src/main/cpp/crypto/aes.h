// ─────────────────────────────────────────────────────────────────────────────
// aes.h — chhota AES-256 (encrypt-block + CTR). FIPS-197.
// Sirf encryption direction chahiye (CTR decrypt == encrypt keystream XOR).
// ─────────────────────────────────────────────────────────────────────────────
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint8_t roundKey[240]; // 60 words for AES-256
} zpay_aes256_ctx;

void zpay_aes256_init(zpay_aes256_ctx* ctx, const uint8_t key[32]);
void zpay_aes256_encrypt_block(const zpay_aes256_ctx* ctx, const uint8_t in[16], uint8_t out[16]);

// AES-256-CTR (counter = 128-bit big-endian, Node crypto ke jaisa).
// out/in alag ya same buffer ho sakte hain.
void zpay_aes256_ctr(const uint8_t key[32], const uint8_t iv[16],
                     const uint8_t* in, uint8_t* out, size_t len);

#ifdef __cplusplus
}
#endif
