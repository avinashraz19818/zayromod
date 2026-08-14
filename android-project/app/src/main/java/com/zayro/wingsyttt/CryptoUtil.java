package com.zayro.wingsyttt;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.MessageDigest;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Runtime decryption layer for hardened builds.
 *
 * Every non-.bin asset inside the APK is AES-256-GCM encrypted with a
 * build-unique key (SHA-256 of the per-build password handed out by the
 * native library). At startup all assets are decrypted into the app-private
 * directory (getFilesDir()), which no other app can read without root.
 *
 * If any asset fails to decrypt, the raw blob is copied as a fallback so the
 * app can never brick itself — worst case that single asset is unencrypted.
 */
public class CryptoUtil {

    private static final byte[] ASSET_MAGIC = {'Z', 'A', 'Y', 'R', 'O', 'A', '0', '1'};
    private static final int NONCE_LEN = 12;
    private static final int TAG_LEN = 16;

    private CryptoUtil() {}

    public static byte[] sha256(byte[] data) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(data);
    }

    public static byte[] decryptAsset(byte[] blob, byte[] key) throws Exception {
        if (blob == null || blob.length < 8 + NONCE_LEN + TAG_LEN) {
            throw new Exception("asset blob too short");
        }
        for (int i = 0; i < 8; i++) {
            if (blob[i] != ASSET_MAGIC[i]) throw new Exception("asset magic mismatch");
        }
        byte[] nonce = new byte[NONCE_LEN];
        byte[] tag = new byte[TAG_LEN];
        System.arraycopy(blob, 8, nonce, 0, NONCE_LEN);
        System.arraycopy(blob, 8 + NONCE_LEN, tag, 0, TAG_LEN);
        byte[] enc = new byte[blob.length - 8 - NONCE_LEN - TAG_LEN];
        System.arraycopy(blob, 8 + NONCE_LEN + TAG_LEN, enc, 0, enc.length);

        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"),
                new GCMParameterSpec(TAG_LEN * 8, nonce));
        // GCM authenticates when ciphertext+tag are passed together in one
        // doFinal() call. Append the 16-byte tag to the ciphertext first.
        byte[] combined = new byte[enc.length + tag.length];
        System.arraycopy(enc, 0, combined, 0, enc.length);
        System.arraycopy(tag, 0, combined, enc.length, tag.length);
        return c.doFinal(combined);
    }

    public static byte[] readAll(InputStream is) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    /**
     * Decrypt every hardened asset into <code>getFilesDir()/za/</code>.
     * .bin files (HTML blobs) are intentionally left in assets — they are
     * decrypted in memory by MainActivity.
     */
    public static void decryptAssetsToDir(Context ctx, String password) {
        try {
            byte[] key = sha256(password.getBytes("UTF-8"));
            File dir = new File(ctx.getFilesDir(), "za");
            dir.mkdirs();

            String[] names = ctx.getAssets().list("");
            if (names == null) return;

            for (String name : names) {
                if (name.toLowerCase().endsWith(".bin")) continue;
                byte[] blob = null;
                try {
                    InputStream is = ctx.getAssets().open(name);
                    blob = readAll(is);
                    is.close();
                    byte[] plain = decryptAsset(blob, key);
                    FileOutputStream fos = new FileOutputStream(new File(dir, name));
                    fos.write(plain);
                    fos.close();
                } catch (Exception e) {
                    // Fallback: keep the raw bytes so the app still works.
                    if (blob != null && blob.length > 0) {
                        try {
                            FileOutputStream fos = new FileOutputStream(new File(dir, name));
                            fos.write(blob);
                            fos.close();
                        } catch (Exception ignored) {}
                    }
                }
            }
        } catch (Exception ignored) {}
    }
}