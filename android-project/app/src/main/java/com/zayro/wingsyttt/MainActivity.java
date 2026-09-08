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
	// (bare call compile nahi hota kyunki method BR ke andar hota hai).
	public interface ZayroBridge {
		void speak(String t);
		void playSound(String f);
		void stopSound();
		void retryContent();
	}
	
	// ── REMOTE CONTENT — XOR-MASKED (DEX me koi plaintext nahi) ──
	// Popup HTML APK me nahi hota — app launch pe server se encrypted HTML
	// fetch hota hai. Server URL / content path / decrypt password XOR-mask
	// hoke build time pe apkbuilder.js byte arrays bhar deta hai — strings
	// table me kuch nahi milta (360 Jiagu laga ho to poora DEX encrypted).
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
				final String _url = _param2;
				
				super.onPageStarted(_param1, _param2, _param3);
			}
			
			@Override
			public void onPageFinished(WebView _param1, String _param2) {
				final String _url = _param2;
				
				super.onPageFinished(_param1, _param2);
			}
		});
	}
	
	// ── Remote content helpers ──
	// contentLoader + fetchBusy initializeLogic se pehle hi ready rehte hain
	// (final array holder — lambdas ke andar reassign karna aasan ho).
	private final Runnable[] contentLoader = new Runnable[1];
	private final java.util.concurrent.atomic.AtomicBoolean fetchBusy = new java.util.concurrent.atomic.AtomicBoolean(true);
	
	// ── IN-APP WINDOW SYSTEM — koi bhi URL APK ke ANDAR khulega ──
	// Game site (iframe ke andar) deposit/payment ke liye window.open() ya
	// target="_blank" chalata hai, ya window.top.location se app UI hijack
	// karta hai. Pehle SupportMultipleWindows=false ki wajah se naya URL
	// poora app UI (top-frame) le leta tha → app UI gayab → WHITE SCREEN.
	// Ab har naya window ek in-app overlay browser (back/close buttons ke
	// saath) me khulta hai — bahar browser kabhi nahi, white screen kabhi nahi.
	private android.widget.FrameLayout appRoot;
	private android.webkit.WebView mainWeb;
	private android.widget.FrameLayout overlayRoot;
	private android.widget.FrameLayout overlayHolder;
	private android.webkit.WebView overlayWeb;
	private android.widget.TextView overlayTitle;
	private final java.util.List<android.webkit.WebView> overlayWebViews = new java.util.ArrayList<android.webkit.WebView>();
	private android.webkit.ValueCallback<android.net.Uri[]> fileChooser;
	private static final int FILE_CHOOSER_REQ = 10001;
	private static final String APP_UA = "Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
	
	private byte[] fetchAppContent() {
		java.net.HttpURLConnection c = null;
		try {
			String server = decodeX(APP_SERVER_URL_M);
			String cpath = decodeX(APP_PATH_M);
			if (server.length() == 0 || cpath.length() == 0) return null;
			// Cache-buster: har fetch pe taya timestamp — purana cached
			// content kabhi na mile (design edit turant dikhe).
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
	
	private void initializeLogic() {
		// ── SECURITY LAYER (protectedRelease builds) ──
		// Signature/tamper verify + risk scoring. FAILED hone par remote
		// content BLOCKED (neeche wale loader me check hota hai). Debug/
		// release builds me SecurityManager kuch nahi karta (IS_PROTECTED=0).
		try {
			SecurityManager.initialize(MainActivity.this);
			if (!SecurityManager.verifyAssetIntegrity(MainActivity.this)) {
				// koi packaged asset chheda gaya — tampered
				android.util.Log.e("SEC", "asset integrity fail");
			}
		} catch (Exception e) {}
		
		// ═══════════════════════════════════════════════════════════════════
		// SIMPLE FLOW (no security vault) — intro Java se, popup/loading HTML
		// encrypted .bin files se, baaki sab assets PLAIN.
		// ═══════════════════════════════════════════════════════════════════
		final android.widget.FrameLayout root = new android.widget.FrameLayout(this);
		final android.webkit.WebView wP = new android.webkit.WebView(this);
		final android.webkit.WebView wL = new android.webkit.WebView(this);
		
		// In-app window system ke references (onBackPressed / overlay ke liye)
		appRoot = root;
		mainWeb = wP;
		
		wP.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null);
		
		// ── ADVANCED WEBSETTINGS CONFIGURATION ──
		android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
		cm.setAcceptCookie(true);
		try { cm.setAcceptThirdPartyCookies(wP, true); } catch (Exception e) {}

		android.webkit.WebSettings s2 = wP.getSettings();
		s2.setJavaScriptEnabled(true); 
		s2.setDomStorageEnabled(true);
		s2.setDatabaseEnabled(true);
		s2.setAllowFileAccess(true);
		s2.setAllowContentAccess(true);
		s2.setAllowFileAccessFromFileURLs(true); 
		s2.setAllowUniversalAccessFromFileURLs(true); 
		s2.setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
		s2.setMediaPlaybackRequiresUserGesture(false);
		
		s2.setJavaScriptCanOpenWindowsAutomatically(true);
		// MULTI-WINDOW ON — pehle false tha, is wajah se onCreateWindow ka
		// handler KABHI fire nahi hota tha (dead code). window.open()/
		// target="_blank" (deposit/payment pages) poore app UI ko replace
		// kar dete the — wahi white screen bug. Ab har naya window app ke
		// ANDAR in-app browser overlay me khulta hai (client neeche hai).
		s2.setSupportMultipleWindows(true);
		
		s2.setUserAgentString(APP_UA);
		wP.setBackgroundColor(0x00000000);
		
		android.webkit.WebSettings s3 = wL.getSettings();
		s3.setJavaScriptEnabled(true); 
		s3.setDomStorageEnabled(true);
		s3.setAllowFileAccessFromFileURLs(true); 
		s3.setAllowUniversalAccessFromFileURLs(true);
		s3.setMediaPlaybackRequiresUserGesture(false);
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
		
		// Current player + current sound name + pending sound (intro ke baad).
		// INTRO_DONE: intro ek hi baar bajega (kisi bhi page ka duplicate
		// intro request ignore hoga — double audio impossible).
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
				// big/small results Android TTS se bolte hain (MP3 nahi hota)
				if (lowerName.equals("big.mp3") || lowerName.equals("small.mp3")) {
					if (T[0] != null) T[0].speak(lowerName.equals("big.mp3") ? "Big" : "Small", android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "zayro_result");
					return;
				}
				final String playableName = lowerName.equals("loginw.mp3") ? "bypass.mp3" : soundName;
				// INTRO DOUBLE-PLAY GUARD: intro Java se ek hi baar bajta hai.
				// Kisi page (loading/popup) ka intro.mp3 request kabhi accept
				// nahi hota — na intro ke dauraan, na uske baad.
				if (playableName.equals("intro.mp3") && (INTRO_DONE.get() || "intro.mp3".equals(CUR_NAME.get()))) return;
				// Intro chal raha hai to naya sound abhi mat bajao — intro khatam
				// hote hi ye pending sound baj jayega (intro kabhi nahi katega).
				if ("intro.mp3".equals(CUR_NAME.get())) {
					PENDING.set(playableName);
					return;
				}
				new Thread(new Runnable() { public void run() {
						android.media.MediaPlayer p = null;
					try {
							p = new android.media.MediaPlayer();
							// Same sound already playing hai to restart mat karo
							android.media.MediaPlayer cur = (android.media.MediaPlayer) AP.get();
							if (playableName.equals(CUR_NAME.get()) && cur != null) {
								try { if (cur.isPlaying()) { try { p.release(); } catch (Exception x) {} return; } } catch (Exception e) {}
							}
							// MP3s PLAIN assets me hain — seedha yahi se play
							android.content.res.AssetFileDescriptor a = getAssets().openFd(playableName);
							p.setDataSource(a.getFileDescriptor(), a.getStartOffset(), a.getLength()); a.close();
							// Ek hi sound ek time pe — purana stop karke naya
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
				// MP3 ko YAHAN nahi rokta — sound hamesha pura bajta hai.
				// Naya playSound() aane par purana khud stop ho jata hai.
			}
			
			@android.webkit.JavascriptInterface
			public void retryContent() {
				// Error screen ka RETRY button — dobara fetch karo
				if (fetchBusy.compareAndSet(false, true)) {
					try { if (contentLoader[0] != null) contentLoader[0].run(); } catch (Exception e) {}
				}
			}
		};
		
		wP.addJavascriptInterface(BR, "ZAYRO");
		wL.addJavascriptInterface(BR, "ZAYRO");
		
		// ── INTRO — app khulte hi turant, PLAIN asset se ──
		try {
			android.media.MediaPlayer introPlayer = new android.media.MediaPlayer();
			android.content.res.AssetFileDescriptor afd = getAssets().openFd("intro.mp3");
			introPlayer.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
			afd.close();
			introPlayer.prepare();
			// Strong reference — GC kabhi beech me release nahi kar sakta
			AP.set(introPlayer);
			CUR_NAME.set("intro.mp3");
			final android.media.MediaPlayer ip = introPlayer;
			introPlayer.setOnCompletionListener(new android.media.MediaPlayer.OnCompletionListener() {
				public void onCompletion(android.media.MediaPlayer m) {
					if ("intro.mp3".equals(CUR_NAME.get())) CUR_NAME.set("");
					AP.compareAndSet(ip, null);
					m.release();
					INTRO_DONE.set(true);
					// Intro ke baad pending sound (agar koi tha) play karo
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
		
		// ── POPUP HTML — REMOTE FETCH (APK me kuch nahi hota) ──
		// Server se encrypted .bin aata hai → fixed password se decrypt →
		// wP me load. Fail ho to retry (5 attempts), phir bhi fail ho to
		// error screen + RETRY button (ZAYRO.retryContent).
		final byte[] MK = {(byte)0xDE,(byte)0xAD,(byte)0xBE,(byte)0xEF,(byte)0xCA,(byte)0xFE,(byte)0xBA,(byte)0xBE};
		final String PW = decodeX(FW_PASSWORD_M);
		byte[] _buf = new byte[8192]; int _n;
		
		contentLoader[0] = new Runnable() { public void run() {
			new Thread(new Runnable() { public void run() {
					try {
						// ── SECURITY GATE: tampered/signature-fail → content BLOCK ──
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
		
		// ── IN-APP WINDOW CLIENT — deposit/payment popups sab ANDAR ──
		// window.open() / target="_blank" (payment gateway, cashier page,
		// telegram, koi bhi URL) yahan pakda jata hai aur app ke andar hi
		// ek overlay browser me khulta hai. Game iframe ki state safe rehti
		// hai, app UI kabhi replace nahi hota.
		wP.setWebChromeClient(new android.webkit.WebChromeClient() {
			@Override
			public boolean onCreateWindow(android.webkit.WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
				try {
					android.webkit.WebView popup = buildOverlayWebView();
					presentOverlayWebView(popup);
					android.webkit.WebView.WebViewTransport transport = (android.webkit.WebView.WebViewTransport) resultMsg.obj;
					transport.setWebView(popup);
					resultMsg.sendToTarget();
					return true;
				} catch (Exception e) {
					return false;
				}
			}
			
			@Override
			public void onCloseWindow(android.webkit.WebView window) {
				// Popup ne khud window.close() kiya (payment complete) —
				// overlay automatically band.
				final android.webkit.WebView cw = window;
				runOnUiThread(new Runnable() { public void run() {
					if (overlayWeb != null && overlayWeb == cw) closeOverlay();
				}});
			}
			
			@Override
			public boolean onShowFileChooser(android.webkit.WebView view, android.webkit.ValueCallback<android.net.Uri[]> filePathCallback, android.webkit.WebChromeClient.FileChooserParams fileChooserParams) {
				// Deposit screenshot / UTR proof upload — app ke andar se
				return startFileChooser(filePathCallback);
			}
		});
		
		wP.setWebViewClient(new android.webkit.WebViewClient() {
			@Override
			public void onReceivedSslError(android.webkit.WebView view, android.webkit.SslErrorHandler handler, android.net.http.SslError error) {
				handler.proceed();
			}
			
			@Override
			public boolean shouldOverrideUrlLoading(android.webkit.WebView view, android.webkit.WebResourceRequest request) {
				android.net.Uri u = request.getUrl();
				if (u == null) return false;
				// TOP-FRAME GUARD: game iframe agar window.top.location /
				// target="_top" se app UI hijack kare — main app page KABHI
				// replace nahi hoti. URL game iframe ke andar route ho jata
				// hai (panel ka route monitor isi pe chalta hai).
				if (request.isForMainFrame()) {
					String sch = u.getScheme() == null ? "" : u.getScheme().toLowerCase(java.util.Locale.US);
					if (sch.equals("http") || sch.equals("https")) {
						routeToGameFrame(u.toString());
						return true;
					}
				}
				return handleSpecialScheme(u);
			}
			
			@Override
			public boolean shouldOverrideUrlLoading(android.webkit.WebView view, String url) {
				// Legacy overload (API < 24) — iframe navigation bhi yahan
				// aa sakta hai, isliye sirf special schemes handle karo;
				// http/https normal load hone do.
				try {
					return handleSpecialScheme(android.net.Uri.parse(url));
				} catch (Exception e) {
					return false;
				}
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
						root.removeView(wL);
					}
				});
				fa.start();
			}
		}, 5000);
		
	}
	
	// ═══════════════════════════════════════════════════════════════════
	// IN-APP WINDOW SYSTEM — sab URLs APK ke andar
	// ═══════════════════════════════════════════════════════════════════
	private int dp(int v) {
		return Math.round(v * getResources().getDisplayMetrics().density);
	}
	
	// JS string literal ke liye escape (iframe.src me URL daalte waqt)
	private static String jsEsc(String s) {
		if (s == null) return "";
		StringBuilder b = new StringBuilder(s.length() + 8);
		for (int i = 0; i < s.length(); i++) {
			char c = s.charAt(i);
			if (c == '\\' || c == '\'' || c == '"') { b.append('\\').append(c); }
			else if (c == '\n' || c == '\r' || c == '\t') { b.append(' '); }
			else { b.append(c); }
		}
		return b.toString();
	}
	
	// Top-frame hijack URL ko sahi jagah route karo:
	//   • Same-site URL (game ka apna page) → game iframe me — panel ka
	//     register/deposit/wingo route monitoring isi iframe se chalta hai.
	//   • Cross-site URL (payment gateway, telegram...) → in-app browser
	//     overlay me — wo pages X-Frame-Options se iframe me blank hote hain.
	//   • Frame na mile (rare) → in-app browser overlay.
	private void routeToGameFrame(final String url) {
		final android.webkit.WebView mw = mainWeb;
		if (mw == null) { openInAppBrowser(url); return; }
		runOnUiThread(new Runnable() { public void run() {
			try {
				String u = jsEsc(url);
				String js = "(function(){var f=document.getElementById('target-game-frame')||document.getElementById('gameFrame')||document.getElementById('gameIframe');"
					+ "if(!f){return 3;}"
					+ "var cur=f.getAttribute('src')||'';"
					+ "if(!cur||cur==='about:blank'){f.src='" + u + "';return 1;}"
					+ "try{var a=document.createElement('a');a.href=cur;var b=document.createElement('a');b.href='" + u + "';"
					+ "if((a.hostname||'')!==(b.hostname||'')){return 3;}}catch(e){return 3;}"
					+ "f.src='" + u + "';return 1;})()";
				mw.evaluateJavascript(js, new android.webkit.ValueCallback<String>() {
					public void onReceiveValue(String v) {
						String r = v == null ? "" : v.replace("\"", "").trim();
						if (!"1".equals(r)) openInAppBrowser(url);
					}
				});
			} catch (Exception e) {
				openInAppBrowser(url);
			}
		}});
	}
	
	// http/https ke alawa scheme (upi://, intent://, tel:, mailto:,
	// whatsapp://, market:// ...) WebView me render NAHI ho sakta — UPI
	// payment apps wagairah ke liye system Intent try karo. Launch fail
	// ho to chup-chaap ignore (white screen kabhi nahi). http/https ka
	// hamesha false (app ke andar hi load hoga).
	private boolean handleSpecialScheme(android.net.Uri uri) {
		try {
			if (uri == null || uri.getScheme() == null) return false;
			String sch = uri.getScheme().toLowerCase(java.util.Locale.US);
			if (sch.equals("http") || sch.equals("https")) return false;
			if (sch.equals("file") || sch.equals("blob") || sch.equals("data")
				|| sch.equals("about") || sch.equals("javascript")) return false;
			android.content.Intent it;
			if (sch.equals("intent")) {
				it = android.content.Intent.parseUri(uri.toString(), android.content.Intent.URI_INTENT_SCHEME);
			} else {
				it = new android.content.Intent(android.content.Intent.ACTION_VIEW, uri);
			}
			it.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
			try {
				startActivity(it);
			} catch (Exception e) {
				// intent:// ka browser_fallback_url — in-app me kholo
				String fb = null;
				try { fb = it.getStringExtra("browser_fallback_url"); } catch (Exception ex) {}
				if (fb != null && (fb.startsWith("http://") || fb.startsWith("https://"))) {
					openInAppBrowser(fb);
				}
			}
			return true;
		} catch (Exception e) {
			return true;
		}
	}
	
	// WebView ko safely destroy karo (callback ke andar se direct destroy
	// risky hota hai — main thread pe post karke).
	private void destroyWebViewSafe(final android.webkit.WebView wv) {
		if (wv == null) return;
		new android.os.Handler(android.os.Looper.getMainLooper()).post(new Runnable() { public void run() {
			try { wv.stopLoading(); } catch (Exception e) {}
			try { wv.destroy(); } catch (Exception e) {}
		}});
	}
	
	// Overlay browser ka top bar + holder (ek hi baar banta hai)
	private void buildOverlay() {
		overlayRoot = new android.widget.FrameLayout(this);
		overlayRoot.setBackgroundColor(0xFF05070D);
		
		android.widget.LinearLayout col = new android.widget.LinearLayout(this);
		col.setOrientation(android.widget.LinearLayout.VERTICAL);
		col.setLayoutParams(new android.widget.FrameLayout.LayoutParams(-1, -1));
		
		android.widget.LinearLayout bar = new android.widget.LinearLayout(this);
		bar.setOrientation(android.widget.LinearLayout.HORIZONTAL);
		bar.setBackgroundColor(0xFF10141F);
		bar.setGravity(android.view.Gravity.CENTER_VERTICAL);
		bar.setLayoutParams(new android.widget.LinearLayout.LayoutParams(-1, dp(46)));
		
		android.widget.TextView backBtn = new android.widget.TextView(this);
		backBtn.setText("‹");
		backBtn.setTextColor(0xFFFFFFFF);
		backBtn.setTextSize(26);
		backBtn.setPadding(dp(16), 0, dp(10), 0);
		backBtn.setGravity(android.view.Gravity.CENTER);
		backBtn.setOnClickListener(new android.view.View.OnClickListener() {
			public void onClick(android.view.View v) {
				if (overlayWeb != null && overlayWeb.canGoBack()) overlayWeb.goBack();
				else closeOverlay();
			}
		});
		
		overlayTitle = new android.widget.TextView(this);
		overlayTitle.setTextColor(0xFFE6EAF2);
		overlayTitle.setTextSize(13);
		overlayTitle.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
		overlayTitle.setSingleLine(true);
		overlayTitle.setText("Loading…");
		android.widget.LinearLayout.LayoutParams tl = new android.widget.LinearLayout.LayoutParams(0, -1, 1f);
		tl.gravity = android.view.Gravity.CENTER_VERTICAL;
		overlayTitle.setLayoutParams(tl);
		
		android.widget.TextView closeBtn = new android.widget.TextView(this);
		closeBtn.setText("✕");
		closeBtn.setTextColor(0xFFFF5470);
		closeBtn.setTextSize(17);
		closeBtn.setPadding(dp(10), 0, dp(16), 0);
		closeBtn.setGravity(android.view.Gravity.CENTER);
		closeBtn.setOnClickListener(new android.view.View.OnClickListener() {
			public void onClick(android.view.View v) {
				closeOverlay();
			}
		});
		
		bar.addView(backBtn);
		bar.addView(overlayTitle);
		bar.addView(closeBtn);
		
		android.view.View sep = new android.view.View(this);
		sep.setBackgroundColor(0xFF232A3D);
		sep.setLayoutParams(new android.widget.LinearLayout.LayoutParams(-1, Math.max(1, dp(1))));
		
		overlayHolder = new android.widget.FrameLayout(this);
		overlayHolder.setLayoutParams(new android.widget.LinearLayout.LayoutParams(-1, 0, 1f));
		
		col.addView(bar);
		col.addView(sep);
		col.addView(overlayHolder);
		overlayRoot.addView(col);
	}
	
	// Overlay window me WebView dikhao (purana dettach ho jata hai — destroy
	// Nahi karte: WebView popup lifecycle me opener ko uske popup se pehle
	// destroy karna crash kar sakta hai. Sab closeOverlay me ulte order me
	// (popup pehle, opener baad me) destroy hote hain.)
	private void presentOverlayWebView(final android.webkit.WebView wv) {
		if (wv == null || appRoot == null) return;
		try {
			if (overlayRoot == null) buildOverlay();
			if (overlayHolder != null) overlayHolder.removeAllViews();
			if (!overlayWebViews.contains(wv)) overlayWebViews.add(wv);
			overlayWeb = wv;
			wv.setLayoutParams(new android.widget.FrameLayout.LayoutParams(-1, -1));
			if (overlayHolder != null) overlayHolder.addView(wv);
			if (overlayTitle != null) overlayTitle.setText("Loading…");
			if (overlayRoot.getParent() == null) {
				appRoot.addView(overlayRoot, new android.widget.FrameLayout.LayoutParams(-1, -1));
			}
			overlayRoot.setVisibility(android.view.View.VISIBLE);
			overlayRoot.bringToFront();
			overlayRoot.requestLayout();
		} catch (Exception e) {
			android.util.Log.e("DW", "present overlay: " + e.getMessage());
		}
	}
	
	// Overlay band — sab WebViews safely destroy (naye/popup pehle, opener
	// baad me — WebView popup lifecycle ka rule), references clean
	private void closeOverlay() {
		try {
			if (overlayRoot != null && appRoot != null) appRoot.removeView(overlayRoot);
		} catch (Exception e) {}
		overlayWeb = null;
		overlayRoot = null;
		overlayHolder = null;
		overlayTitle = null;
		destroyAllOverlayWebViews();
	}
	
	private void destroyAllOverlayWebViews() {
		if (overlayWebViews.isEmpty()) return;
		// Copy karke reverse order me — posted destroys FIFO execute hote
		// hain, isliye sabse naye (popup) pehle destroy honge.
		final android.webkit.WebView[] all = overlayWebViews.toArray(new android.webkit.WebView[overlayWebViews.size()]);
		overlayWebViews.clear();
		for (int i = all.length - 1; i >= 0; i--) destroyWebViewSafe(all[i]);
	}
	
	// Koi bhi URL app ke andar hi kholo — in-app overlay browser me
	private void openInAppBrowser(final String url) {
		if (url == null || url.length() == 0) return;
		runOnUiThread(new Runnable() { public void run() {
			try {
				android.webkit.WebView wv = buildOverlayWebView();
				presentOverlayWebView(wv);
				wv.loadUrl(url);
			} catch (Exception e) {
				android.util.Log.e("DW", "openInAppBrowser: " + e.getMessage());
			}
		}});
	}
	
	// ── Overlay (in-app browser) WebView — deposit/payment pages isi me ──
	// Cookies/JS/DOM storage sab shared rehte hain — game session bani
	// rehti hai. Nested popups bhi isi overlay me khulte hain.
	private android.webkit.WebView buildOverlayWebView() {
		final android.webkit.WebView wv = new android.webkit.WebView(this);
		try { wv.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null); } catch (Exception e) {}
		android.webkit.WebSettings st = wv.getSettings();
		st.setJavaScriptEnabled(true);
		st.setDomStorageEnabled(true);
		st.setDatabaseEnabled(true);
		st.setAllowFileAccess(true);
		st.setAllowContentAccess(true);
		st.setAllowFileAccessFromFileURLs(true);
		st.setAllowUniversalAccessFromFileURLs(true);
		st.setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
		st.setMediaPlaybackRequiresUserGesture(false);
		st.setJavaScriptCanOpenWindowsAutomatically(true);
		st.setSupportMultipleWindows(true);
		st.setSupportZoom(true);
		st.setBuiltInZoomControls(true);
		st.setDisplayZoomControls(false);
		st.setUseWideViewPort(true);
		st.setLoadWithOverviewMode(true);
		st.setUserAgentString(APP_UA);
		wv.setBackgroundColor(0xFF05070D);
		try { android.webkit.CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true); } catch (Exception e) {}
		
		wv.setWebViewClient(new android.webkit.WebViewClient() {
			@Override
			public void onReceivedSslError(android.webkit.WebView view, android.webkit.SslErrorHandler handler, android.net.http.SslError error) {
				handler.proceed();
			}
			@Override
			public boolean shouldOverrideUrlLoading(android.webkit.WebView view, android.webkit.WebResourceRequest request) {
				// Overlay me http/https normal load hota hai — sirf UPI/
				// intent jaise schemes bahar (system app) jaate hain
				return handleSpecialScheme(request.getUrl());
			}
			@Override
			public boolean shouldOverrideUrlLoading(android.webkit.WebView view, String url) {
				try {
					return handleSpecialScheme(android.net.Uri.parse(url));
				} catch (Exception e) {
					return false;
				}
			}
			@Override
			public void onPageFinished(android.webkit.WebView view, String url) {
				super.onPageFinished(view, url);
				try {
					if (overlayTitle != null && overlayWeb == view) {
						String host = android.net.Uri.parse(url).getHost();
						overlayTitle.setText(host == null || host.length() == 0 ? "Loading…" : host);
					}
				} catch (Exception e) {}
			}
		});
		
		wv.setWebChromeClient(new android.webkit.WebChromeClient() {
			@Override
			public boolean onCreateWindow(android.webkit.WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
				// Nested popup — isi overlay window me replace ho jao
				try {
					android.webkit.WebView nested = buildOverlayWebView();
					presentOverlayWebView(nested);
					android.webkit.WebView.WebViewTransport tr = (android.webkit.WebView.WebViewTransport) resultMsg.obj;
					tr.setWebView(nested);
					resultMsg.sendToTarget();
					return true;
				} catch (Exception e) {
					return false;
				}
			}
			@Override
			public void onCloseWindow(android.webkit.WebView window) {
				final android.webkit.WebView cw = window;
				runOnUiThread(new Runnable() { public void run() {
					if (overlayWeb != null && overlayWeb == cw) closeOverlay();
				}});
			}
			@Override
			public boolean onShowFileChooser(android.webkit.WebView view, android.webkit.ValueCallback<android.net.Uri[]> filePathCallback, android.webkit.WebChromeClient.FileChooserParams fileChooserParams) {
				return startFileChooser(filePathCallback);
			}
		});
		
		wv.setDownloadListener(new android.webkit.DownloadListener() {
			public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
				// Receipt/invoice download — system browser ke through
				try {
					android.content.Intent it = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(url));
					it.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
					startActivity(it);
				} catch (Exception e) {}
			}
		});
		return wv;
	}
	
	// File upload picker (deposit screenshot / UTR proof)
	private boolean startFileChooser(android.webkit.ValueCallback<android.net.Uri[]> cb) {
		if (fileChooser != null) {
			try { fileChooser.onReceiveValue(null); } catch (Exception e) {}
		}
		fileChooser = cb;
		try {
			android.content.Intent ci = new android.content.Intent(android.content.Intent.ACTION_GET_CONTENT);
			ci.addCategory(android.content.Intent.CATEGORY_OPENABLE);
			ci.setType("*/*");
			startActivityForResult(android.content.Intent.createChooser(ci, "Select File"), FILE_CHOOSER_REQ);
			return true;
		} catch (Exception e) {
			fileChooser = null;
			return false;
		}
	}
	
	@Override
	public void onBackPressed() {
		// Pehle in-app browser window (deposit/payment): usme back
		// navigation, warna close. Phir main webview. Warna default exit.
		if (overlayRoot != null && overlayWeb != null) {
			if (overlayWeb.canGoBack()) { overlayWeb.goBack(); return; }
			closeOverlay();
			return;
		}
		if (mainWeb != null && mainWeb.canGoBack()) { mainWeb.goBack(); return; }
		super.onBackPressed();
	}
	
	@Override
	protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {
		if (requestCode == FILE_CHOOSER_REQ) {
			if (fileChooser != null) {
				android.net.Uri[] results = null;
				if (resultCode == RESULT_OK && data != null && data.getData() != null) {
					results = new android.net.Uri[]{ data.getData() };
				}
				try { fileChooser.onReceiveValue(results); } catch (Exception e) {}
				fileChooser = null;
			}
			return;
		}
		super.onActivityResult(requestCode, resultCode, data);
	}
	
	@Override
	protected void onDestroy() {
		overlayWeb = null;
		overlayRoot = null;
		overlayHolder = null;
		overlayTitle = null;
		fileChooser = null;
		destroyAllOverlayWebViews();
		super.onDestroy();
	}
	
}
