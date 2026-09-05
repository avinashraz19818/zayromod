// ─────────────────────────────────────────────────────────────────────────────
// sha256.h — chhota self-contained SHA-256 (public-domain style, FIPS 180-4).
// Koi external dependency nahi — Android NDK + host test dono me compile hota.
// ─────────────────────────────────────────────────────────────────────────────
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t state[8];
    uint64_t bitlen;
    uint8_t  data[64];
    size_t   datalen;
} zpay_sha256_ctx;

void zpay_sha256_init(zpay_sha256_ctx* ctx);
void zpay_sha256_update(zpay_sha256_ctx* ctx, const uint8_t* data, size_t len);
void zpay_sha256_final(zpay_sha256_ctx* ctx, uint8_t out[32]);

// one-shot helper
void zpay_sha256(const uint8_t* data, size_t len, uint8_t out[32]);

#ifdef __cplusplus
}
#endif
