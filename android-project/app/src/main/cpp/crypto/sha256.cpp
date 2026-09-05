// ─────────────────────────────────────────────────────────────────────────────
// sha256.cpp — SHA-256 (FIPS 180-4). Standard constants + transforms.
// ─────────────────────────────────────────────────────────────────────────────
#include "sha256.h"

#include <string.h>

#define ZPAY_ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define ZPAY_CH(x, y, z)  (((x) & (y)) ^ (~(x) & (z)))
#define ZPAY_MAJ(x, y, z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define ZPAY_EP0(x) (ZPAY_ROR(x, 2) ^ ZPAY_ROR(x, 13) ^ ZPAY_ROR(x, 22))
#define ZPAY_EP1(x) (ZPAY_ROR(x, 6) ^ ZPAY_ROR(x, 11) ^ ZPAY_ROR(x, 25))
#define ZPAY_SIG0(x) (ZPAY_ROR(x, 7) ^ ZPAY_ROR(x, 18) ^ ((x) >> 3))
#define ZPAY_SIG1(x) (ZPAY_ROR(x, 17) ^ ZPAY_ROR(x, 19) ^ ((x) >> 10))

static const uint32_t kK[64] = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u,
    0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u,
    0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu,
    0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u,
    0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u,
    0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u,
    0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u,
    0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u,
    0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
};

static void zpay_transform(zpay_sha256_ctx* ctx, const uint8_t block[64]) {
    uint32_t w[64];
    for (int i = 0; i < 16; i++) {
        w[i] = ((uint32_t)block[i * 4] << 24) |
               ((uint32_t)block[i * 4 + 1] << 16) |
               ((uint32_t)block[i * 4 + 2] << 8) |
               ((uint32_t)block[i * 4 + 3]);
    }
    for (int i = 16; i < 64; i++) {
        w[i] = ZPAY_SIG1(w[i - 2]) + w[i - 7] + ZPAY_SIG0(w[i - 15]) + w[i - 16];
    }

    uint32_t a = ctx->state[0], b = ctx->state[1], c = ctx->state[2], d = ctx->state[3];
    uint32_t e = ctx->state[4], f = ctx->state[5], g = ctx->state[6], h = ctx->state[7];

    for (int i = 0; i < 64; i++) {
        uint32_t t1 = h + ZPAY_EP1(e) + ZPAY_CH(e, f, g) + kK[i] + w[i];
        uint32_t t2 = ZPAY_EP0(a) + ZPAY_MAJ(a, b, c);
        h = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }

    ctx->state[0] += a; ctx->state[1] += b;
    ctx->state[2] += c; ctx->state[3] += d;
    ctx->state[4] += e; ctx->state[5] += f;
    ctx->state[6] += g; ctx->state[7] += h;
}

void zpay_sha256_init(zpay_sha256_ctx* ctx) {
    ctx->datalen = 0;
    ctx->bitlen = 0;
    ctx->state[0] = 0x6a09e667u;
    ctx->state[1] = 0xbb67ae85u;
    ctx->state[2] = 0x3c6ef372u;
    ctx->state[3] = 0xa54ff53au;
    ctx->state[4] = 0x510e527fu;
    ctx->state[5] = 0x9b05688cu;
    ctx->state[6] = 0x1f83d9abu;
    ctx->state[7] = 0x5be0cd19u;
}

void zpay_sha256_update(zpay_sha256_ctx* ctx, const uint8_t* data, size_t len) {
    for (size_t i = 0; i < len; i++) {
        ctx->data[ctx->datalen++] = data[i];
        if (ctx->datalen == 64) {
            zpay_transform(ctx, ctx->data);
            ctx->bitlen += 512;
            ctx->datalen = 0;
        }
    }
}

void zpay_sha256_final(zpay_sha256_ctx* ctx, uint8_t out[32]) {
    uint64_t totalBits = ctx->bitlen + (uint64_t)ctx->datalen * 8;

    ctx->data[ctx->datalen++] = 0x80;
    if (ctx->datalen > 56) {
        while (ctx->datalen < 64) ctx->data[ctx->datalen++] = 0x00;
        zpay_transform(ctx, ctx->data);
        ctx->datalen = 0;
    }
    while (ctx->datalen < 56) ctx->data[ctx->datalen++] = 0x00;

    // 64-bit big-endian length
    for (int i = 7; i >= 0; i--) {
        ctx->data[56 + (7 - i)] = (uint8_t)((totalBits >> (i * 8)) & 0xFF);
    }
    zpay_transform(ctx, ctx->data);

    for (int i = 0; i < 8; i++) {
        out[i * 4]     = (uint8_t)((ctx->state[i] >> 24) & 0xFF);
        out[i * 4 + 1] = (uint8_t)((ctx->state[i] >> 16) & 0xFF);
        out[i * 4 + 2] = (uint8_t)((ctx->state[i] >> 8) & 0xFF);
        out[i * 4 + 3] = (uint8_t)(ctx->state[i] & 0xFF);
    }
}

void zpay_sha256(const uint8_t* data, size_t len, uint8_t out[32]) {
    zpay_sha256_ctx ctx;
    zpay_sha256_init(&ctx);
    zpay_sha256_update(&ctx, data, len);
    zpay_sha256_final(&ctx, out);
}
