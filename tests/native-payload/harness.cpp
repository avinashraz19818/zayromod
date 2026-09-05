// ─────────────────────────────────────────────────────────────────────────────
// harness.cpp — HOST test driver (Android ke bina crypto verify karne ke liye).
// Yahi crypto/*.cpp sources compile hote hain jo .so me jaate hain — isliye
// yahan pass hona matlab device par bhi same algorithm chalega.
//
// Modes:
//   harness selftest
//     SHA-256("abc") + AES-256 (FIPS-197 vector) + HMAC-SHA256 (RFC 4231 #1)
//     + PBKDF2 cross-check Node se aaye expected value ke against.
//     usage: harness selftest <pbkdf2Hex>
//       (pbkdf2Hex = PBKDF2-HMAC-SHA256("password","salt",100000,64) hex, Node se)
//   harness decrypt <container.bin> <pwfull.txt> <out.bin>
//     zpay_decrypt_payload → exit 0 + out likho, ya exit 1.
//   harness decrypt-header <dexpassword> <expect.bin>
//     ZPAY_TEST_HEADER me di gayi generated header include karke full chain:
//     pepper rebuild → pwFull → decrypt → expect.bin se byte-compare.
//     Compile: g++ ... -DZPAY_TEST_HEADER="popup_payload.h" -I<gendir>
// ─────────────────────────────────────────────────────────────────────────────
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "crypto/sha256.h"
#include "crypto/aes.h"
#include "crypto/payload_crypto.h"

#ifdef ZPAY_TEST_HEADER
#include ZPAY_TEST_HEADER
#endif

static std::vector<unsigned char> readFile(const char* path) {
    std::vector<unsigned char> v;
    FILE* f = fopen(path, "rb");
    if (!f) return v;
    unsigned char buf[8192];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) v.insert(v.end(), buf, buf + n);
    fclose(f);
    return v;
}

static std::string toHex(const unsigned char* d, size_t n) {
    static const char* H = "0123456789abcdef";
    std::string s;
    s.reserve(n * 2);
    for (size_t i = 0; i < n; i++) {
        s.push_back(H[(d[i] >> 4) & 0xF]);
        s.push_back(H[d[i] & 0xF]);
    }
    return s;
}

static int doSelftest(const char* pbkdf2Hex) {
    int fails = 0;

    // 1) SHA-256("abc") — FIPS 180-4
    {
        unsigned char out[32];
        zpay_sha256((const unsigned char*)"abc", 3, out);
        std::string got = toHex(out, 32);
        std::string want = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        if (got != want) { printf("SHA256-abc FAIL got=%s\n", got.c_str()); fails++; }
        else printf("SHA256-abc OK\n");
    }

    // 2) AES-256 ECB single block — FIPS-197 Appendix C.3
    {
        unsigned char key[32];
        for (int i = 0; i < 32; i++) key[i] = (unsigned char)i;
        unsigned char pt[16] = {0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
                                0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff};
        unsigned char ct[16];
        zpay_aes256_ctx ctx;
        zpay_aes256_init(&ctx, key);
        zpay_aes256_encrypt_block(&ctx, pt, ct);
        std::string got = toHex(ct, 16);
        std::string want = "8ea2b7ca516745bfeafc49904b496089";
        if (got != want) { printf("AES256-FIPS197 FAIL got=%s\n", got.c_str()); fails++; }
        else printf("AES256-FIPS197 OK\n");
    }

    // 3) AES-256-CTR multi-block vs Node reference (iv=0, key=0..31, 64 bytes 0..63)
    //    Expected Node se hardcode nahi — CTR property check: decrypt(encrypt(x))==x
    //    + keystream determinism (do baar same output). Real cross-check decrypt
    //    mode me Node-generated container se hota hai.
    {
        unsigned char key[32];
        for (int i = 0; i < 32; i++) key[i] = (unsigned char)(i * 7 + 1);
        unsigned char iv[16];
        for (int i = 0; i < 16; i++) iv[i] = (unsigned char)i;
        unsigned char msg[100];
        for (int i = 0; i < 100; i++) msg[i] = (unsigned char)(i * 3 + 5);
        unsigned char c1[100], c2[100], back[100];
        zpay_aes256_ctr(key, iv, msg, c1, 100);
        zpay_aes256_ctr(key, iv, msg, c2, 100);
        zpay_aes256_ctr(key, iv, c1, back, 100);
        if (memcmp(c1, c2, 100) != 0 || memcmp(back, msg, 100) != 0) {
            printf("AES256-CTR FAIL\n"); fails++;
        } else printf("AES256-CTR OK\n");
    }

    // 4) HMAC-SHA256 — RFC 4231 Test Case 1
    {
        unsigned char key[20];
        memset(key, 0x0b, sizeof(key));
        const char* data = "Hi There";
        unsigned char out[32];
        zpay_hmac_sha256(key, sizeof(key), (const unsigned char*)data, strlen(data), out);
        std::string got = toHex(out, 32);
        std::string want = "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7";
        if (got != want) { printf("HMAC-SHA256-RFC4231 FAIL got=%s\n", got.c_str()); fails++; }
        else printf("HMAC-SHA256-RFC4231 OK\n");
    }

    // 5) PBKDF2-HMAC-SHA256 — Node crypto ke against cross-check
    {
        const char* pw = "password";
        const char* salt = "salt";
        unsigned char dk[64];
        if (zpay_pbkdf2_hmac_sha256((const unsigned char*)pw, strlen(pw),
                                    (const unsigned char*)salt, strlen(salt),
                                    100000, dk, 64) != 0) {
            printf("PBKDF2 FAIL (rc)\n"); fails++;
        } else {
            std::string got = toHex(dk, 64);
            if (got != std::string(pbkdf2Hex)) {
                printf("PBKDF2 FAIL got=%s\n", got.c_str()); fails++;
            } else printf("PBKDF2-100k OK\n");
        }
    }

    // 6) ct compare sanity
    {
        unsigned char a[4] = {1, 2, 3, 4}, b[4] = {1, 2, 3, 4}, c[4] = {1, 2, 3, 5};
        if (zpay_ct_compare(a, b, 4) != 0 || zpay_ct_compare(a, c, 4) == 0) {
            printf("CT-COMPARE FAIL\n"); fails++;
        } else printf("CT-COMPARE OK\n");
    }

    printf(fails ? "SELFTEST: %d FAILURES\n" : "SELFTEST: ALL OK\n", fails);
    return fails ? 1 : 0;
}

static int doDecrypt(const char* containerPath, const char* pwPath, const char* outPath) {
    std::vector<unsigned char> c = readFile(containerPath);
    std::vector<unsigned char> p = readFile(pwPath);
    if (c.empty() || p.empty()) { printf("decrypt: input read fail\n"); return 1; }
    // trailing newline strip (pwfile se)
    while (!p.empty() && (p.back() == '\n' || p.back() == '\r')) p.pop_back();

    unsigned char* plain = NULL;
    size_t plainLen = 0;
    int rc = zpay_decrypt_payload(c.data(), c.size(), p.data(), p.size(), &plain, &plainLen);
    if (rc != 0 || !plain) { printf("decrypt: REJECTED (rc=%d)\n", rc); return 1; }
    FILE* f = fopen(outPath, "wb");
    if (!f) { free(plain); printf("decrypt: out write fail\n"); return 1; }
    fwrite(plain, 1, plainLen, f);
    fclose(f);
    memset(plain, 0, plainLen);
    free(plain);
    printf("decrypt: OK (%u bytes)\n", (unsigned)plainLen);
    return 0;
}

#ifdef ZPAY_TEST_HEADER
static int doDecryptHeader(const char* dexPassword, const char* expectPath) {
    if (ZPAY_PAYLOAD_LEN < (unsigned long)(ZPAY_HEADER_MIN + ZPAY_TAG_LEN)) {
        printf("decrypt-header: empty payload\n");
        return 1;
    }
    char pepperHex[33];
    zpay_rebuild_pepper_hex(ZPAY_PEPPER_M, ZPAY_PEPPER_MASK, ZPAY_PEPPER_ROT, pepperHex);
    std::string full = std::string(dexPassword) + "|zpay1|" + std::string(pepperHex, 32);

    unsigned char* plain = NULL;
    size_t plainLen = 0;
    int rc = zpay_decrypt_payload(ZPAY_PAYLOAD, (size_t)ZPAY_PAYLOAD_LEN,
                                  (const unsigned char*)full.data(), full.size(),
                                  &plain, &plainLen);
    memset(pepperHex, 0, sizeof(pepperHex));
    if (rc != 0 || !plain) { printf("decrypt-header: REJECTED (rc=%d)\n", rc); return 1; }

    std::vector<unsigned char> expect = readFile(expectPath);
    int ok = (expect.size() == plainLen && memcmp(expect.data(), plain, plainLen) == 0);
    printf(ok ? "decrypt-header: OK (%u bytes, matches)\n" : "decrypt-header: MISMATCH\n",
           (unsigned)plainLen);
    memset(plain, 0, plainLen);
    free(plain);
    return ok ? 0 : 1;
}
#endif

int main(int argc, char** argv) {
    if (argc < 2) { printf("usage: harness selftest|decrypt|decrypt-header ...\n"); return 2; }
    std::string mode = argv[1];
    if (mode == "selftest" && argc == 3) return doSelftest(argv[2]);
    if (mode == "decrypt" && argc == 5) return doDecrypt(argv[2], argv[3], argv[4]);
#ifdef ZPAY_TEST_HEADER
    if (mode == "decrypt-header" && argc == 4) return doDecryptHeader(argv[2], argv[3]);
#else
    if (mode == "decrypt-header") { printf("decrypt-header: not compiled with ZPAY_TEST_HEADER\n"); return 2; }
#endif
    printf("usage: harness selftest|decrypt|decrypt-header ...\n");
    return 2;
}
