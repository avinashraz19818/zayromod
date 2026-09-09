package com.zayro.wingsyttt;

import android.animation.*;
import android.app.*;
import android.app.Activity;
import android.app.DialogFragment;
import android.app.Fragment;
import android.app.FragmentManager;
import android.content.*;
import android.content.res.*;
import android.graphics.*;
import android.graphics.drawable.*;
import android.media.*;
import android.net.*;
import android.os.*;
import android.text.*;
import android.text.style.*;
import android.util.*;
import android.view.*;
import android.view.View.*;
import android.view.animation.*;
import android.webkit.*;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.*;
import com.zayro.wingsyttt.databinding.*;
import java.io.*;
import java.text.*;
import java.util.*;
import java.util.regex.*;
import org.json.*;

public class MainActivity extends Activity {
	
	// JS bridge ka type — intro listeners se playSound call karne ke liye
	public interface ZayroBridge {
		void speak(String t);
		void playSound(String f);
		void stopSound();
		void retryContent();
		void openExternal(String url);
	}
	
	// ── REMOTE CONTENT — XOR-MASKED ──
	private static final byte[] APP_SERVER_URL_M = new byte[]{ 0, 0 };
	private static final byte[] APP_PATH_M = new byte[]{ 0, 0 };
	private static final byte[] FW_PASSWORD_M = new byte[]{ 0, 0 };
	private static final int XOR_KEY = 0x5A;
	
	private static String decodeX(byte[] m) {
		if (m == null || m.length == 0) return "";
		char[] c = new char[m.length];
		for (int i = 0; i < m.length; i++) c[i] = (char) ((m[i] ^ XOR_KEY) & 0xFF);
		return new String(c);
	}
	
	private MainBinding binding;

	// ── POPUP / PAYMENT OVERLAY TRACKING ──
	private final List<WebView> popupWebViews = new ArrayList<>();
	private android.widget.FrameLayout rootLayout;
	private WebView mainWebView; // wP reference for back handling
	
	@Override
	protected void onCreate(Bundle _savedInstanceState) {
		super.onCreate(_savedInstanceState);
		binding = MainBinding.inflate(getLayoutInflater());
		setContentView(binding.getRoot());
		initialize(_savedInstanceState);
		initializeLogic();
	}
	
	private void initialize(Bundle _savedInstanceState) {
		binding.webview1.setWebViewClient(new WebViewClient() {
			@Override
			public void onPageStarted(WebView _param1, String _param2, Bitmap _param3) {
				super.onPageStarted(_param1, _param2, _param3);
			}
			@Override
			public void onPageFinished(WebView _param1, String _param2) {
				super.onPageFinished(_param1, _param2);
			}
		});
	}
	
	// ── Remote content helpers ──
	private final Runnable[] contentLoader = new Runnable[1];
	private final java.util.concurrent.atomic.AtomicBoolean fetchBusy = new java.util.concurrent.atomic.AtomicBoolean(true);
	
	private byte[] fetchAppContent() {
		java.net.HttpURLConnection c = null;
		try {
			String server = decodeX(APP_SERVER_URL_M);
			String cpath = decodeX(APP_PATH_M);
			if (server.length() == 0 || cpath.length() == 0) return null;
			String url = server + "/api/app-content/" + cpath + "?t=" + System.currentTimeMillis();
			c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
			c.setConnectTimeout(10000);
			c.setReadTimeout(20000);
			c.setRequestProperty("User-Agent", "ZayroApp/1.0");
			c.setRequestProperty("Accept", "application/octet-stream");
			int code = c.getResponseCode();
			if (code != 200) return null;
			java.io.InputStream is = c.getInputStream();
			java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
			byte[] b = new byte[8192];
			int n;
			while ((n = is.read(b)) != -1) bos.write(b, 0, n);
			is.close();
			return bos.toByteArray();
		} catch (Exception e) {
			android.util.Log.e("DW", "fetch: " + e.getMessage());
			return null;
		} finally {
			if (c != null) { try { c.disconnect(); } catch (Exception e) {} }
		}
	}

	// ── Common WebView configuration ──
	private void configureWebSettings(WebSettings s) {
		s.setJavaScriptEnabled(true);
		s.setDomStorageEnabled(true);
		s.setDatabaseEnabled(true);
		s.setAllowFileAccess(true);
		s.setAllowContentAccess(true);
		s.setAllowFileAccessFromFileURLs(true);
		s.setAllowUniversalAccessFromFileURLs(true);
		s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
		s.setMediaPlaybackRequiresUserGesture(false);
		s.setJavaScriptCanOpenWindowsAutomatically(true);
		s.setSupportMultipleWindows(true);
		s.setSupportZoom(false);
		s.setBuiltInZoomControls(false);
		s.setDisplayZoomControls(false);
		s.setLoadWithOverviewMode(true);
		s.setUseWideViewPort(true);
		s.setCacheMode(WebSettings.LOAD_DEFAULT);
		s.setUserAgentString("Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
	}

	private boolean isPaymentUrl(String url) {
		if (url == null) return false;
		String lower = url.toLowerCase(Locale.US);
		// Payment gateway keywords - if URL contains these, it should open in popup overlay, not iframe
		String[] payKeywords = new String[]{
			"/pay", "checkout", "payment", "/qr", "upi", "razorpay", "cashfree", "payu", "ccavenue",
			"arpay", "usdt", "ewallet", "phonepe", "paytm", "gpay", "tez", "wallet/pay", "recharge/pay",
			"deposit/pay", "gateway", "pg.", "api/pay", "order/pay", "initiate", "processing"
		};
		for (String kw : payKeywords) {
			if (lower.contains(kw)) return true;
		}
		// If URL is from different domain than game (e.g., payment provider) - treat as payment
		// We check if URL is not about:blank and not file:// and contains .com/.in/.net but not game keywords
		// For safety, if URL has query params like amount, order, txn, etc, treat as payment
		if (lower.contains("amount=") || lower.contains("order") || lower.contains("txn") || lower.contains("transaction")) {
			return true;
		}
		return false;
	}

	private boolean handleExternalScheme(Context ctx, String url) {
		if (url == null) return false;
		String lower = url.toLowerCase(Locale.US);
		// http/https should stay inside app
		if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("file://") || lower.startsWith("about:") || lower.startsWith("data:")) {
			return false;
		}
		// Handle intent://, upi://, paytm, phonepe, gpay, etc.
		try {
			if (lower.startsWith("intent://")) {
				Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
				if (intent != null) {
					// Try to launch
					try {
						ctx.startActivity(intent);
						return true;
					} catch (Exception e) {
						// Fallback to market if package specified
						String fallback = intent.getStringExtra("browser_fallback_url");
						if (fallback != null) {
							Intent fb = new Intent(Intent.ACTION_VIEW, Uri.parse(fallback));
							ctx.startActivity(fb);
							return true;
						}
						// Try package
						String pkg = intent.getPackage();
						if (pkg != null) {
							try {
								Intent market = new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg));
								ctx.startActivity(market);
								return true;
							} catch (Exception ex) {}
						}
					}
				}
				return true;
			}
			// UPI and other app schemes
			if (lower.startsWith("upi://") || lower.startsWith("paytm") || lower.startsWith("phonepe://") || lower.startsWith("tez://") || lower.startsWith("gpay://") || lower.startsWith("whatsapp://") || lower.startsWith("tel:") || lower.startsWith("mailto:") || lower.startsWith("upi:") ) {
				Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
				intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
				ctx.startActivity(intent);
				return true;
			}
		} catch (Exception e) {
			// If we fail to handle, prevent white screen by not loading
			android.util.Log.e("DW", "external scheme fail: " + e.getMessage() + " url=" + url);
			return true;
		}
		// Unknown scheme - try generic view
		try {
			Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
			intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
			ctx.startActivity(intent);
			return true;
		} catch (Exception e) {
			return true;
		}
	}

	private WebView createPopupWebView(Context context, android.widget.FrameLayout root) {
		// Container with close button to prevent user stuck on white screen
		final FrameLayout container = new FrameLayout(context);
		FrameLayout.LayoutParams containerLp = new FrameLayout.LayoutParams(-1, -1);
		container.setLayoutParams(containerLp);
		container.setBackgroundColor(Color.WHITE);

		final WebView popup = new WebView(context);
		popup.setLayerType(View.LAYER_TYPE_HARDWARE, null);
		configureWebSettings(popup.getSettings());
		popup.setBackgroundColor(Color.WHITE);
		try {
			CookieManager cm = CookieManager.getInstance();
			cm.setAcceptThirdPartyCookies(popup, true);
		} catch (Exception e) {}

		FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(-1, -1);
		popup.setLayoutParams(lp);

		// Close button (X) top-right
		final Button closeBtn = new Button(context);
		closeBtn.setText("✕");
		closeBtn.setTextSize(18);
		closeBtn.setTextColor(Color.WHITE);
		closeBtn.setBackgroundColor(Color.parseColor("#CC000000"));
		FrameLayout.LayoutParams btnLp = new FrameLayout.LayoutParams(
			(int)(48 * context.getResources().getDisplayMetrics().density),
			(int)(48 * context.getResources().getDisplayMetrics().density)
		);
		btnLp.gravity = android.view.Gravity.TOP | android.view.Gravity.END;
		btnLp.topMargin = (int)(8 * context.getResources().getDisplayMetrics().density);
		btnLp.rightMargin = (int)(8 * context.getResources().getDisplayMetrics().density);
		closeBtn.setLayoutParams(btnLp);
		closeBtn.setOnClickListener(new View.OnClickListener() {
			public void onClick(View v) {
				try {
					root.removeView(container);
					popupWebViews.remove(popup);
					popup.destroy();
				} catch (Exception e) {}
			}
		});

		// Download listener
		popup.setDownloadListener(new DownloadListener() {
			@Override
			public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
				try {
					Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
					popup.getContext().startActivity(intent);
				} catch (Exception e) {
					android.util.Log.e("DW", "download fail: " + e.getMessage());
				}
			}
		});

		// WebViewClient for popup - keep all http/https inside app
		popup.setWebViewClient(new WebViewClient() {
			@Override
			public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
				handler.proceed(); // important for payment gateways
			}
			@Override
			public void onPageStarted(WebView view, String url, Bitmap favicon) {
				super.onPageStarted(view, url, favicon);
				// Ensure visible when loading starts
				if (view.getVisibility() != View.VISIBLE) view.setVisibility(View.VISIBLE);
			}
			@Override
			public void onPageFinished(WebView view, String url) {
				super.onPageFinished(view, url);
			}
			@Override
			public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
				String url = request.getUrl().toString();
				if (handleExternalScheme(view.getContext(), url)) return true;
				// Keep http/https inside this popup (or any popup)
				return false;
			}
			@Override
			public boolean shouldOverrideUrlLoading(WebView view, String url) {
				if (handleExternalScheme(view.getContext(), url)) return true;
				return false;
			}
			@Override
			public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
				super.onReceivedError(view, request, error);
				// Don't leave white screen - keep view visible, log error
				android.util.Log.e("DW", "popup error: " + error + " url=" + request.getUrl());
			}
			@Override
			public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
				super.onReceivedHttpError(view, request, errorResponse);
				android.util.Log.e("DW", "popup http error: " + errorResponse.getStatusCode() + " url=" + request.getUrl());
			}
		});

		// WebChromeClient for popup - handle further popups and close
		popup.setWebChromeClient(new WebChromeClient() {
			@Override
			public void onCloseWindow(WebView window) {
				try {
					// Find container parent and remove it
					ViewParent parent = window.getParent();
					if (parent instanceof FrameLayout) {
						FrameLayout cont = (FrameLayout) parent;
						// If container is the direct child of root, remove container
						ViewParent grand = cont.getParent();
						if (grand == root) {
							root.removeView(cont);
						} else {
							root.removeView(window);
						}
					} else {
						root.removeView(window);
					}
					popupWebViews.remove(window);
					window.destroy();
				} catch (Exception e) {}
			}
			@Override
			public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
				WebView newPopup = createPopupWebView(view.getContext(), root);
				WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
				transport.setWebView(newPopup);
				resultMsg.sendToTarget();
				return true;
			}
		});

		// Build container
		container.addView(popup);
		container.addView(closeBtn);
		root.addView(container);
		popupWebViews.add(popup);
		container.setVisibility(View.VISIBLE);
		popup.setVisibility(View.VISIBLE);
		return popup;
	}
	
	private void initializeLogic() {
		try {
			SecurityManager.initialize(MainActivity.this);
			if (!SecurityManager.verifyAssetIntegrity(MainActivity.this)) {
				android.util.Log.e("SEC", "asset integrity fail");
			}
		} catch (Exception e) {}
		
		final android.widget.FrameLayout root = new android.widget.FrameLayout(this);
		this.rootLayout = root;
		final android.webkit.WebView wP = new android.webkit.WebView(this);
		final android.webkit.WebView wL = new android.webkit.WebView(this);
		this.mainWebView = wP;
		
		wP.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null);
		wL.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null);
		
		// ── ADVANCED WEBSETTINGS CONFIGURATION ──
		android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
		cm.setAcceptCookie(true);
		try { cm.setAcceptThirdPartyCookies(wP, true); } catch (Exception e) {}
		try { cm.setAcceptThirdPartyCookies(wL, true); } catch (Exception e) {}

		configureWebSettings(wP.getSettings());
		configureWebSettings(wL.getSettings());

		wP.setBackgroundColor(0x00000000);
		wL.setBackgroundColor(0xFF050310);
		
		android.widget.FrameLayout.LayoutParams lp = new android.widget.FrameLayout.LayoutParams(-1, -1);
		wP.setLayoutParams(lp); 
		wL.setLayoutParams(lp);
		
		final float[] UA = {0f, 0f, 0f, 0f};
		wP.addJavascriptInterface(new Object() {
			@android.webkit.JavascriptInterface
			public void setArea(float a, float b, float c, float d) {
				UA[0]=a; UA[1]=b; UA[2]=c; UA[3]=d;
			}
		}, "ZAYROUI");
		
		final android.speech.tts.TextToSpeech[] T = {null};
		T[0] = new android.speech.tts.TextToSpeech(this, new android.speech.tts.TextToSpeech.OnInitListener() {
			public void onInit(int st) {
				if (st == 0) { T[0].setLanguage(java.util.Locale.US); T[0].setSpeechRate(0.88f); }
			}
		});
		
		final java.util.concurrent.atomic.AtomicReference AP = new java.util.concurrent.atomic.AtomicReference(null);
		final java.util.concurrent.atomic.AtomicReference CUR_NAME = new java.util.concurrent.atomic.AtomicReference("");
		final java.util.concurrent.atomic.AtomicReference PENDING = new java.util.concurrent.atomic.AtomicReference(null);
		final java.util.concurrent.atomic.AtomicBoolean INTRO_DONE = new java.util.concurrent.atomic.AtomicBoolean(false);
		
		final ZayroBridge BR = new ZayroBridge() {
			@android.webkit.JavascriptInterface
			public void speak(String t) {
				if (T[0] != null) T[0].speak(t, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "z");
			}
			
			@android.webkit.JavascriptInterface
			public void playSound(final String f) {
				if (f == null) return;
				String rawName = f.trim();
				if (rawName.length() == 0) return;
				final String soundName = new java.io.File(rawName).getName();
				String lowerName = soundName.toLowerCase(java.util.Locale.US);
				if (lowerName.equals("big.mp3") || lowerName.equals("small.mp3")) {
					if (T[0] != null) T[0].speak(lowerName.equals("big.mp3") ? "Big" : "Small", android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "zayro_result");
					return;
				}
				final String playableName = lowerName.equals("loginw.mp3") ? "bypass.mp3" : soundName;
				if (playableName.equals("intro.mp3") && (INTRO_DONE.get() || "intro.mp3".equals(CUR_NAME.get()))) return;
				if ("intro.mp3".equals(CUR_NAME.get())) {
					PENDING.set(playableName);
					return;
				}
				new Thread(new Runnable() { public void run() {
						android.media.MediaPlayer p = null;
				try {
							p = new android.media.MediaPlayer();
							android.media.MediaPlayer cur = (android.media.MediaPlayer) AP.get();
							if (playableName.equals(CUR_NAME.get()) && cur != null) {
								try { if (cur.isPlaying()) { try { p.release(); } catch (Exception x) {} return; } } catch (Exception e) {}
							}
							android.content.res.AssetFileDescriptor a = getAssets().openFd(playableName);
							p.setDataSource(a.getFileDescriptor(), a.getStartOffset(), a.getLength()); a.close();
							android.media.MediaPlayer prev = (android.media.MediaPlayer) AP.getAndSet(p);
							if (prev != null) {
								try { if (prev.isPlaying()) prev.stop(); } catch (Exception e) {}
								try { prev.release(); } catch (Exception e) {}
							}
							CUR_NAME.set(playableName);
							final android.media.MediaPlayer fp = p;
							p.setOnCompletionListener(new android.media.MediaPlayer.OnCompletionListener() {
								public void onCompletion(android.media.MediaPlayer m) {
									if (playableName.equals(CUR_NAME.get())) CUR_NAME.set("");
									AP.compareAndSet(fp, null); m.release();
								}
							});
							p.setOnErrorListener(new android.media.MediaPlayer.OnErrorListener() {
								public boolean onError(android.media.MediaPlayer m, int what, int extra) {
									if (playableName.equals(CUR_NAME.get())) CUR_NAME.set("");
									AP.compareAndSet(fp, null); m.release(); return true;
								}
							});
							p.prepare(); p.start();
						} catch (Exception e) {
							if (playableName.equals(CUR_NAME.get())) CUR_NAME.set("");
							if (p != null) { AP.compareAndSet(p, null); try { p.release(); } catch (Exception x) {} }
						}
				}}).start();
			}
			
			@android.webkit.JavascriptInterface
			public void stopSound() {
				if (T[0] != null) { try { T[0].stop(); } catch (Exception e) {} }
			}
			
			@android.webkit.JavascriptInterface
			public void retryContent() {
				if (fetchBusy.compareAndSet(false, true)) {
					try { if (contentLoader[0] != null) contentLoader[0].run(); } catch (Exception e) {}
				}
			}

			@android.webkit.JavascriptInterface
			public void openExternal(final String url) {
				// Called from JS to open any URL inside app (deposit, payment, etc.)
				if (url == null || url.trim().length() == 0) return;
				wP.post(new Runnable() {
					public void run() {
						try {
							if (handleExternalScheme(MainActivity.this, url)) return;
							// Open in popup WebView overlay to keep inside APK
							WebView popup = createPopupWebView(MainActivity.this, root);
							popup.loadUrl(url);
						} catch (Exception e) {}
					}
				});
			}
		};
		
		wP.addJavascriptInterface(BR, "ZAYRO");
		wL.addJavascriptInterface(BR, "ZAYRO");
		
		// ── INTRO ──
		try {
			android.media.MediaPlayer introPlayer = new android.media.MediaPlayer();
			android.content.res.AssetFileDescriptor afd = getAssets().openFd("intro.mp3");
			introPlayer.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
			afd.close();
			introPlayer.prepare();
			AP.set(introPlayer);
			CUR_NAME.set("intro.mp3");
			final android.media.MediaPlayer ip = introPlayer;
			introPlayer.setOnCompletionListener(new android.media.MediaPlayer.OnCompletionListener() {
				public void onCompletion(android.media.MediaPlayer m) {
					if ("intro.mp3".equals(CUR_NAME.get())) CUR_NAME.set("");
					AP.compareAndSet(ip, null);
					m.release();
					INTRO_DONE.set(true);
					Object pend = PENDING.getAndSet(null);
					if (pend != null && !"intro.mp3".equals(String.valueOf(pend))) BR.playSound((String) pend);
				}
			});
			introPlayer.setOnErrorListener(new android.media.MediaPlayer.OnErrorListener() {
				public boolean onError(android.media.MediaPlayer m, int what, int extra) {
					if ("intro.mp3".equals(CUR_NAME.get())) CUR_NAME.set("");
					AP.compareAndSet(ip, null);
					m.release();
					INTRO_DONE.set(true);
					Object pend = PENDING.getAndSet(null);
					if (pend != null && !"intro.mp3".equals(String.valueOf(pend))) BR.playSound((String) pend);
					return true;
				}
			});
			introPlayer.start();
		} catch (Exception e) {}
		
		// ── POPUP HTML — REMOTE FETCH ──
		final byte[] MK = {(byte)0xDE,(byte)0xAD,(byte)0xBE,(byte)0xEF,(byte)0xCA,(byte)0xFE,(byte)0xBA,(byte)0xBE};
		final String PW = decodeX(FW_PASSWORD_M);
		byte[] _buf = new byte[8192]; int _n;
		
		contentLoader[0] = new Runnable() { public void run() {
			new Thread(new Runnable() { public void run() {
					try {
						if (SecurityManager.getSecurityState() == SecurityManager.SECURITY_FAILED) {
							final String tamperHtml = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
								+ "<body style='margin:0;background:#0b0f1a;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:14px;text-align:center;padding:0 24px'>"
								+ "<div style='font-size:22px;font-weight:bold;color:#ff4d6d'>Security Verification Failed</div>"
								+ "<div style='color:#8892a6;font-size:13px'>This app cannot run on this device. Please install the official version.</div>"
								+ "</body></html>";
							wP.post(new Runnable() { public void run() {
									wP.loadDataWithBaseURL("file:///android_asset/", tamperHtml, "text/html", "UTF-8", null);
								}});
							fetchBusy.set(false);
							return;
						}
						byte[] bd = fetchAppContent();
						int attempt = 0;
						while (bd == null && attempt < 5) {
							attempt++;
							try { Thread.sleep(2500); } catch (Exception e) {}
							bd = fetchAppContent();
						}
						if (bd == null) {
							final String errHtml = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
								+ "<body style='margin:0;background:#050310;color:#fff;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:14px'>"
								+ "<div style='font-size:20px;font-weight:bold'>Network Problem</div>"
								+ "<div style='color:#aaa;font-size:13px;text-align:center;padding:0 24px'>Internet check karke retry karein</div>"
								+ "<button onclick='window.ZAYRO.retryContent()' style='background:#ff1e1e;color:#fff;border:none;padding:12px 34px;border-radius:999px;font-size:15px;font-weight:bold'>RETRY</button>"
								+ "</body></html>";
							wP.post(new Runnable() { public void run() {
									wP.loadDataWithBaseURL("file:///android_asset/", errHtml, "text/html", "UTF-8", null);
								}});
							fetchBusy.set(false);
							return;
						}
						int mp = -1;
						for (int i = 0; i <= bd.length - 8; i++) {
							boolean ok = true;
							for (int j = 0; j < 8; j++) if (bd[i+j] != MK[j]) { ok = false; break; }
							if (ok) { mp = i; break; }
						}
						if (mp < 0) throw new Exception("no marker");
						byte[] salt = java.util.Arrays.copyOfRange(bd, mp+8, mp+24);
						byte[] iv   = java.util.Arrays.copyOfRange(bd, mp+24, mp+40);
						byte[] enc  = java.util.Arrays.copyOfRange(bd, mp+40, bd.length-64);
						javax.crypto.SecretKeyFactory sf = javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
						byte[] kb = sf.generateSecret(new javax.crypto.spec.PBEKeySpec(PW.toCharArray(), salt, 100000, 256)).getEncoded();
						javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/CBC/PKCS5Padding");
						c.init(javax.crypto.Cipher.DECRYPT_MODE, new javax.crypto.spec.SecretKeySpec(kb, "AES"), new javax.crypto.spec.IvParameterSpec(iv));
						final String html = new String(c.doFinal(enc), "UTF-8");
						wP.post(new Runnable() { public void run() {
								wP.loadDataWithBaseURL("file:///android_asset/", html, "text/html", "UTF-8", null);
							}});
					} catch (Exception e) {
						android.util.Log.e("DW", "popup dec: " + e.getMessage());
					}
					fetchBusy.set(false);
				}}).start();
		}};
		contentLoader[0].run();
		
		try {
			java.io.InputStream is2 = getAssets().open("loading.bin");
			java.io.ByteArrayOutputStream bos2 = new java.io.ByteArrayOutputStream();
			while ((_n = is2.read(_buf)) != -1) bos2.write(_buf, 0, _n); is2.close();
			final byte[] ld = bos2.toByteArray();
			new Thread(new Runnable() { public void run() {
					try {
						int mp = -1;
						for (int i = 0; i <= ld.length - 8; i++) {
							boolean ok = true;
							for (int j = 0; j < 8; j++) if (ld[i+j] != MK[j]) { ok = false; break; }
							if (ok) { mp = i; break; }
						}
						if (mp < 0) throw new Exception("no marker");
						byte[] salt = java.util.Arrays.copyOfRange(ld, mp+8, mp+24);
						byte[] iv   = java.util.Arrays.copyOfRange(ld, mp+24, mp+40);
						byte[] enc  = java.util.Arrays.copyOfRange(ld, mp+40, ld.length-64);
						javax.crypto.SecretKeyFactory sf = javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256");
						byte[] kb = sf.generateSecret(new javax.crypto.spec.PBEKeySpec(PW.toCharArray(), salt, 100000, 256)).getEncoded();
						javax.crypto.Cipher c = javax.crypto.Cipher.getInstance("AES/CBC/PKCS5Padding");
						c.init(javax.crypto.Cipher.DECRYPT_MODE, new javax.crypto.spec.SecretKeySpec(kb, "AES"), new javax.crypto.spec.IvParameterSpec(iv));
						final String html = new String(c.doFinal(enc), "UTF-8");
						wL.post(new Runnable() { public void run() {
								wL.loadDataWithBaseURL("file:///android_asset/", html, "text/html", "UTF-8", null);
							}});
					} catch (Exception e) { android.util.Log.e("DW", "lodale dec: " + e.getMessage()); }
				}}).start();
		} catch (Exception e) { android.util.Log.e("DW", "lodale open: " + e.getMessage()); }
		
		// ── WEBCHROME + WEBVIEW CLIENT — FIXED FOR DEPOSIT / PAYMENT WHITE SCREEN ──
		wP.setWebChromeClient(new android.webkit.WebChromeClient() {
			@Override
			public void onCloseWindow(WebView window) {
				try {
					root.removeView(window);
					popupWebViews.remove(window);
					window.destroy();
				} catch (Exception e) {}
			}
			@Override
			public boolean onCreateWindow(android.webkit.WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
				// FIX: Create fully configured visible popup WebView instead of invisible tempView
				// This prevents white screen for DhaniWin, 13l, and other payment gateways
				try {
					WebView popup = createPopupWebView(view.getContext(), root);
					WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
					transport.setWebView(popup);
					resultMsg.sendToTarget();
					return true;
				} catch (Exception e) {
					android.util.Log.e("DW", "onCreateWindow fail: " + e.getMessage());
					return false;
				}
			}
		});
		
		wP.setWebViewClient(new android.webkit.WebViewClient() {
			@Override
			public void onReceivedSslError(android.webkit.WebView view, android.webkit.SslErrorHandler handler, android.net.http.SslError error) {
				handler.proceed();
			}
			@Override
			public void onPageStarted(WebView view, String url, Bitmap favicon) {
				super.onPageStarted(view, url, favicon);
			}
			@Override
			public void onPageFinished(WebView view, String url) {
				super.onPageFinished(view, url);
				// Inject JS to intercept window.open, iframe src, and external links to keep inside app
				try {
					String js = "(function(){"
						+ "if(window.__zayroHooked) return; window.__zayroHooked=true;"
						+ "function openInApp(u){ try{ if(window.ZAYRO && window.ZAYRO.openExternal){ window.ZAYRO.openExternal(u); return true; } }catch(e){} return false; }"
						+ "var origOpen=window.open;"
						+ "window.open=function(u,n,s){"
						+ "  try{ if(u){ if(openInApp(u)) return {closed:false, focus:function(){}, close:function(){}, location:{href:u}}; } }"
						+ "  }catch(e){}"
						+ "  try{ return origOpen.apply(this, arguments); }catch(e){ return null; }"
						+ "};"
						+ "try{"
						+ "  var desc=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'src');"
						+ "  if(desc && desc.set){"
						+ "    Object.defineProperty(HTMLIFrameElement.prototype,'src',{"
						+ "      get:desc.get,"
						+ "      set:function(v){"
						+ "        try{"
						+ "          var s=String(v).toLowerCase();"
						+ "          var isPay=s.includes('pay')||s.includes('checkout')||s.includes('qr')||s.includes('upi')||s.includes('payment')||s.includes('gateway')||s.includes('razorpay')||s.includes('cashfree')||s.includes('arpay')||s.includes('usdt');"
						+ "          if(isPay){ if(openInApp(v)) return; }"
						+ "        }catch(e){}"
						+ "        return desc.set.call(this,v);"
						+ "      }"
						+ "    });"
						+ "  }"
						+ "}catch(e){}"
						+ "document.addEventListener('click', function(e){"
						+ "  var a=e.target.closest && e.target.closest('a');"
						+ "  if(a && a.href){"
						+ "    var href=a.href; var low=href.toLowerCase();"
						+ "    var isPay=low.includes('pay')||low.includes('checkout')||low.includes('payment')||low.includes('qr');"
						+ "    var isBlank=(a.getAttribute('target')||'').toLowerCase()==='_blank';"
						+ "    if(isBlank||isPay){ e.preventDefault(); e.stopPropagation(); openInApp(href); }"
						+ "  }"
						+ "}, true);"
						+ "setInterval(function(){"
						+ "  try{"
						+ "    var gf=document.getElementById('target-game-frame');"
						+ "    if(gf){"
						+ "      var src=(gf.getAttribute('src')||gf.src||'').toLowerCase();"
						+ "      if(src && src!=='about:blank'){"
						+ "        var isPay=src.includes('pay')&&!src.includes('wallet')&&!src.includes('recharge');"
						+ "        if(isPay && src.includes('http')){"
						+ "          var last=window.__lastPayUrl||'';"
						+ "          if(src!==last){ window.__lastPayUrl=src; openInApp(src); }"
						+ "        }"
						+ "      }"
						+ "    }"
						+ "  }catch(e){}"
						+ "}, 1000);"
						+ "})();";
					view.evaluateJavascript(js, null);
				} catch (Exception e) {}
			}
			@Override
			public boolean shouldOverrideUrlLoading(android.webkit.WebView view, android.webkit.WebResourceRequest request) {
				String url = request.getUrl().toString();
				if (handleExternalScheme(view.getContext(), url)) return true;
				boolean isMain = true;
				try { isMain = request.isForMainFrame(); } catch (Exception e) {}
				String lower = url.toLowerCase(Locale.US);
				// If iframe is trying to load payment URL, open in popup overlay instead of iframe (prevents white screen)
				if (!isMain) {
					if (isPaymentUrl(url) || (lower.startsWith("http") && !lower.contains("wallet") && !lower.contains("recharge") && !lower.contains("register") && !lower.contains("login") && !lower.contains("wingo") && !lower.contains("lottery"))) {
						// But allow wallet/recharge pages themselves to stay in iframe, only payment gateways go to popup
						if (lower.contains("pay") || lower.contains("checkout") || lower.contains("qr") || lower.contains("upi") || lower.contains("gateway") || lower.contains("razorpay") || lower.contains("cashfree") || lower.contains("payu") || lower.contains("ccavenue") || lower.contains("arpay")) {
							try {
								final String fUrl = url;
								view.post(new Runnable() {
									public void run() {
										try {
											WebView popup = createPopupWebView(view.getContext(), root);
											popup.loadUrl(fUrl);
										} catch (Exception ex) {}
									}
								});
							} catch (Exception e) {}
							return true; // block iframe white screen
						}
					}
					// For normal iframe navigations (wallet, register, etc), allow
					return false;
				}
				// Main WebView must stay on file:// - any http/https navigation should go to popup overlay
				if (lower.startsWith("http://") || lower.startsWith("https://")) {
					try {
						WebView popup = createPopupWebView(view.getContext(), root);
						popup.loadUrl(url);
					} catch (Exception e) {
						view.loadUrl(url);
					}
					return true;
				}
				return false;
			}
			@Override
			public boolean shouldOverrideUrlLoading(android.webkit.WebView view, String url) {
				if (handleExternalScheme(view.getContext(), url)) return true;
				String lower = url.toLowerCase(Locale.US);
				if (lower.startsWith("http://") || lower.startsWith("https://")) {
					try {
						WebView popup = createPopupWebView(view.getContext(), root);
						popup.loadUrl(url);
					} catch (Exception e) {
						view.loadUrl(url);
					}
					return true;
				}
				return false;
			}
			@Override
			public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
				try {
					boolean isMain = true;
					try { isMain = request.isForMainFrame(); } catch (Exception e) {}
					if (!isMain) {
						String url = request.getUrl().toString();
						String lower = url.toLowerCase(Locale.US);
						// Detect payment gateway loading inside iframe that would cause white screen due to X-Frame-Options
						if (isPaymentUrl(url) && (lower.contains("pay") || lower.contains("checkout") || lower.contains("gateway") || lower.contains("qr"))) {
							// Don't block wallet/recharge itself, only actual payment processing URLs
							if (!lower.contains("/wallet/recharge") && !lower.contains("/wallet") || lower.contains("/pay") || lower.contains("checkout")) {
								if (lower.contains("/pay") || lower.contains("checkout") || lower.contains("razorpay") || lower.contains("cashfree") || lower.contains("upi") || lower.contains("qr")) {
									final String fUrl = url;
									view.post(new Runnable() {
										public void run() {
											try {
												if (handleExternalScheme(MainActivity.this, fUrl)) return;
												WebView popup = createPopupWebView(MainActivity.this, root);
												popup.loadUrl(fUrl);
											} catch (Exception e) {}
										}
									});
									// Return empty response to prevent white screen in iframe, let popup handle it
									// Only block if it's clearly a payment gateway, not the wallet page itself
									if (lower.contains("razorpay") || lower.contains("cashfree") || lower.contains("payu") || lower.contains("ccavenue") || (lower.contains("/pay") && !lower.contains("wallet")) || lower.contains("checkout")) {
										return new WebResourceResponse("text/html", "UTF-8", new java.io.ByteArrayInputStream(\"<html><body style='background:#000;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif'>Opening payment... If not opened, <a href='\" + url + \"' style='color:#ff3b3b'>click here</a></body></html>\".getBytes()));
									}
								}
							}
						}
					}
				} catch (Exception e) {}
				return super.shouldInterceptRequest(view, request);
			}
			@Override
			public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
				super.onReceivedError(view, request, error);
				android.util.Log.e("DW", "main error: " + error + " url=" + request.getUrl());
			}
		});

		// Loading WebView client - same handling (keep file:// only)
		wL.setWebViewClient(new WebViewClient() {
			@Override
			public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
				handler.proceed();
			}
			@Override
			public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
				String url = request.getUrl().toString();
				if (handleExternalScheme(view.getContext(), url)) return true;
				String lower = url.toLowerCase(Locale.US);
				if (lower.startsWith("http://") || lower.startsWith("https://")) {
					try {
						WebView popup = createPopupWebView(view.getContext(), root);
						popup.loadUrl(url);
					} catch (Exception e) {}
					return true;
				}
				return false;
			}
			@Override
			public boolean shouldOverrideUrlLoading(WebView view, String url) {
				if (handleExternalScheme(view.getContext(), url)) return true;
				String lower = url.toLowerCase(Locale.US);
				if (lower.startsWith("http://") || lower.startsWith("https://")) {
					try {
						WebView popup = createPopupWebView(view.getContext(), root);
						popup.loadUrl(url);
					} catch (Exception e) {}
					return true;
				}
				return false;
			}
		});
		
		root.addView(wP); 
		root.addView(wL);
		setContentView(root);
		
		new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(new Runnable() {
			public void run() {
				android.animation.ObjectAnimator fa = android.animation.ObjectAnimator.ofFloat(wL, "alpha", 1f, 0f);
				fa.setDuration(600);
				fa.addListener(new android.animation.AnimatorListenerAdapter() {
					public void onAnimationEnd(android.animation.Animator a) {
						wL.setVisibility(android.view.View.GONE);
						try { root.removeView(wL); } catch (Exception e) {}
					}
				});
				fa.start();
			}
		}, 5000);
		
	}

	@Override
	public void onBackPressed() {
		try {
			if (popupWebViews.size() > 0) {
				WebView top = popupWebViews.get(popupWebViews.size() - 1);
				if (top != null) {
					if (top.canGoBack()) {
						top.goBack();
						return;
					} else {
						try {
							ViewParent parent = top.getParent();
							if (parent instanceof FrameLayout) {
								FrameLayout cont = (FrameLayout) parent;
								ViewParent grand = cont.getParent();
								if (grand == rootLayout) {
									rootLayout.removeView(cont);
								} else {
									rootLayout.removeView(top);
								}
							} else {
								rootLayout.removeView(top);
							}
							popupWebViews.remove(top);
							top.destroy();
						} catch (Exception e) {}
						return;
					}
				}
			}
			if (mainWebView != null && mainWebView.canGoBack()) {
				String url = mainWebView.getUrl();
				if (url != null && !url.startsWith("file://")) {
					mainWebView.goBack();
					return;
				}
			}
		} catch (Exception e) {}
		super.onBackPressed();
	}

	@Override
	protected void onDestroy() {
		try {
			for (WebView wv : popupWebViews) {
				try { wv.destroy(); } catch (Exception e) {}
			}
			popupWebViews.clear();
			if (mainWebView != null) {
				try { mainWebView.destroy(); } catch (Exception e) {}
			}
		} catch (Exception e) {}
		super.onDestroy();
	}
}
