// ─────────────────────────────────────────────────────────────
// PLACEHOLDER — repository me hamesha EMPTY rehta hai.
//
// Build pipeline (utils/native-payload.js) har APK build ke liye isi path par
// generated header likhta hai — SIRF build copy (builds/<id>/project/...) me.
// Is placeholder ke saath bana APK runtime par native payload me kuch nahi
// paata (nativeGetPopupHtml → null) aur existing REMOTE content flow se HTML
// fetch karta hai — bilkul pehle jaisa behavior, koi crash nahi.
// ─────────────────────────────────────────────────────────────
#pragma once

#include <stddef.h>

static const unsigned long long ZPAY_BUILD_TAG = 0ULL;
static const unsigned long ZPAY_PAYLOAD_LEN = 0UL;
static const unsigned char ZPAY_PAYLOAD[] = { 0x00 };

static const unsigned int ZPAY_PEPPER_ROT = 0;
static const unsigned char ZPAY_PEPPER_M[16] = {
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};
static const unsigned char ZPAY_PEPPER_MASK[16] = {
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
};
