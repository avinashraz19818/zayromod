package com.mizanmods.shell;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.IOException;

/** Offline asset-only shell. No remote navigation, permissions or native bridge. */
public class MainActivity extends Activity {
    private WebView web;
    private static final String ORIGIN = "https://app.mizanmods.invalid/";
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this);
        web.setOnApplyWindowInsetsListener((v, insets) -> {
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(web);
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMixedContentMode(0);
        WebView.setWebContentsDebuggingEnabled(false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith(ORIGIN)) {
                    String file = url.substring(ORIGIN.length());
                    if (file.equals("popup.html") || file.equals("popup.css") || file.equals("popup.js") || file.equals("mark.svg")) {
                        String mime = file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : file.endsWith(".svg") ? "image/svg+xml" : "application/javascript";
                        try { return new WebResourceResponse(mime, "UTF-8", getAssets().open(file)); } catch (IOException ignored) {}
                    }
                }
                return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
            }
        });
        web.loadUrl(ORIGIN + "popup.html");
    }
    @Override protected void onDestroy() {
        if (web != null) { web.stopLoading(); web.destroy(); }
        super.onDestroy();
    }
}
