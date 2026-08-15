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
	
	private void initializeLogic() {
		final android.widget.FrameLayout root = new android.widget.FrameLayout(this);
		final android.webkit.WebView wP = new android.webkit.WebView(this);
		final android.webkit.WebView wL = new android.webkit.WebView(this);
		
		wP.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null);
		
		// ── ADVANCED WEBSETTINGS CONFIGURATION ──
		android.webkit.WebSettings s2 = wP.getSettings();
		s2.setJavaScriptEnabled(true); 
		s2.setDomStorageEnabled(true);
		s2.setAllowFileAccess(true);
		s2.setAllowContentAccess(true);
		s2.setAllowFileAccessFromFileURLs(true); 
		s2.setAllowUniversalAccessFromFileURLs(true); 
		s2.setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
		s2.setMediaPlaybackRequiresUserGesture(false);
		
		// Strict multi-tab block parameters
		s2.setJavaScriptCanOpenWindowsAutomatically(true);
		s2.setSupportMultipleWindows(true); 
		
		s2.setUserAgentString("Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
		wP.setBackgroundColor(0x00000000);
		
		android.webkit.WebSettings s3 = wL.getSettings();
		s3.setJavaScriptEnabled(true); 
		s3.setDomStorageEnabled(true);
		s3.setAllowFileAccessFromFileURLs(true); 
		s3.setAllowUniversalAccessFromFileURLs(true);
		// Allow the loading page (redload.html) to play audio without a tap —
		// both via ZAYRO.playSound and plain HTML5 <audio>/new Audio().
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
		
		final java.util.concurrent.atomic.AtomicReference AP = new java.util.concurrent.atomic.AtomicReference(null);
		// Name of the sound currently playing ("" when none). Used so pages
		// that re-trigger the same sound don't restart it mid-play.
		final java.util.concurrent.atomic.AtomicReference CUR_NAME = new java.util.concurrent.atomic.AtomicReference("");

		// ── INTRO — starts the INSTANT the app opens ──
		// Java plays intro.mp3 immediately from plain assets (no decrypt, no
		// WebView wait). The loading page may also request it — the
		// same-sound guard in playSound() skips the duplicate. stopSound()
		// can't stop it, and the popup page waits until it finishes.
		try {
			android.media.MediaPlayer introPlayer = new android.media.MediaPlayer();
			android.content.res.AssetFileDescriptor _afd = getAssets().openFd("intro.mp3");
			introPlayer.setDataSource(_afd.getFileDescriptor(), _afd.getStartOffset(), _afd.getLength());
			_afd.close();
			AP.set(introPlayer);
			CUR_NAME.set("intro.mp3");
			final android.media.MediaPlayer _ip = introPlayer;
			introPlayer.setOnCompletionListener(new android.media.MediaPlayer.OnCompletionListener() {
				public void onCompletion(android.media.MediaPlayer m) {
					if ("intro.mp3".equals(CUR_NAME.get())) CUR_NAME.set("");
					AP.compareAndSet(_ip, null);
					m.release();
				}
			});
			introPlayer.setOnErrorListener(new android.media.MediaPlayer.OnErrorListener() {
				public boolean onError(android.media.MediaPlayer m, int what, int extra) {
					if ("intro.mp3".equals(CUR_NAME.get())) CUR_NAME.set("");
					AP.compareAndSet(_ip, null);
					m.release();
					return true;
				}
			});
			introPlayer.prepare();
			introPlayer.start();
		} catch (Exception e) {}
		
		final Object BR = new Object() {
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
				new Thread(new Runnable() { public void run() {
						android.media.MediaPlayer p = null;
					try {
							p = new android.media.MediaPlayer();
							// If this exact sound is already playing, let it
							// finish instead of restarting it (this is what
							// made sounds "thoda sa chal ke ruk jana").
							android.media.MediaPlayer cur = (android.media.MediaPlayer) AP.get();
							if (playableName.equals(CUR_NAME.get()) && cur != null) {
								try { if (cur.isPlaying()) { try { p.release(); } catch (Exception x) {} return; } } catch (Exception e) {}
							}
							// MP3s are stored PLAIN inside the APK assets (no
							// encryption), so they play straight from assets.
							// The za/ check only keeps old installs (from earlier
							// encrypted builds) working.
							java.io.File sf = new java.io.File(getFilesDir(), "za/" + playableName);
							if (sf.exists()) {
								p.setDataSource(sf.getAbsolutePath());
							} else {
								android.content.res.AssetFileDescriptor a = getAssets().openFd(playableName);
								p.setDataSource(a.getFileDescriptor(), a.getStartOffset(), a.getLength()); a.close();
							}
							// One sound at a time: stop whatever is currently
							// playing before starting, so sounds never overlap
							// or cut each other off half-way.
							android.media.MediaPlayer prev = (android.media.MediaPlayer) AP.getAndSet(p);
							if (prev != null) {
								try { if (prev.isPlaying()) prev.stop(); } catch (Exception e) {}
								try { prev.release(); } catch (Exception e) {}
							}
							CUR_NAME.set(playableName);
							final android.media.MediaPlayer fp = p;
							p.setOnCompletionListener(new android.media.MediaPlayer.OnCompletionListener() {
								public void onCompletion(android.media.MediaPlayer m) { if (playableName.equals(CUR_NAME.get())) CUR_NAME.set(""); AP.compareAndSet(fp, null); m.release(); }
							});
							p.setOnErrorListener(new android.media.MediaPlayer.OnErrorListener() {
								public boolean onError(android.media.MediaPlayer m, int what, int extra) { if (playableName.equals(CUR_NAME.get())) CUR_NAME.set(""); AP.compareAndSet(fp, null); m.release(); return true; }
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
				// NOTE: the MediaPlayer sound is intentionally NOT stopped here.
				// Pages call stopSound() on EVERY state change (including right
				// after startup), which used to cut sounds (intro, deposit…)
				// off mid-play. Now a sound always plays to the end; a new
				// playSound() replaces it only when a different sound starts.
			}
		};
		
		wP.addJavascriptInterface(BR, "ZAYRO");
		// Loading page (redload.html) gets the SAME ZAYRO bridge, so any
		// audio logic added there (ZAYRO.playSound/stopSound) works exactly
		// like on the popup page.
		wL.addJavascriptInterface(BR, "ZAYRO");
		
		// ── CRYPTO FILE LOADER DECRYPTORS ──
		final SecurityUtil sec = new SecurityUtil();
		final byte[] MK = sec.getMarker();
		final String PW = sec.getDecryptKey();

		// ── HARDENING: decrypt all encrypted assets into app-private storage ──
		// PNGs/MP3s/fonts/icon live in the APK as AES-256-GCM ciphertext; they
		// are restored to getFilesDir()/za/ here so the WebView and MediaPlayer
		// can use them. Outside this app nothing can read that folder.
		final String ZD = new java.io.File(getFilesDir(), "za").getAbsolutePath();
		CryptoUtil.decryptAssetsToDir(MainActivity.this, PW);
		byte[] _buf = new byte[8192]; int _n;

		// ── Popup (game) page — loads after the loading screen ──
		// The popup HTML is decrypted now but only loaded into wP once the
		// loading screen's 5s window is over. The page's JS calls stopSound()
		// on init, which used to cut sounds mid-play; keeping it out until
		// then lets the loading page's own sound finish.
		final byte[] bd;
		{
			byte[] _tmp = null;
			try {
				java.io.InputStream is = getAssets().open("zayro.bin");
				java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
				while ((_n = is.read(_buf)) != -1) bos.write(_buf, 0, _n); is.close();
				_tmp = bos.toByteArray();
			} catch (Exception e) { android.util.Log.e("DW", "popup open: " + e.getMessage()); }
			bd = _tmp;
		}

		final java.util.concurrent.atomic.AtomicBoolean popupLoaded = new java.util.concurrent.atomic.AtomicBoolean(false);
		final Runnable loadPopupNow = new Runnable() { public void run() {
			if (!popupLoaded.compareAndSet(false, true)) return;
			new Thread(new Runnable() { public void run() {
					try {
						if (bd == null) throw new Exception("no zayro.bin");
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
								wP.loadDataWithBaseURL("file://" + ZD + "/", html, "text/html", "UTF-8", null);
							}});
					} catch (Exception e) { android.util.Log.e("DW", "popup dec: " + e.getMessage()); }
				}}).start();
		}};

		// Popup waits for the loading page's intro to finish before loading,
		// so the intro can NEVER be cut short (slow devices par bhi).
		final Runnable loadPopup = new Runnable() { public void run() {
			try {
				android.media.MediaPlayer cur = (android.media.MediaPlayer) AP.get();
				if ("intro.mp3".equals(CUR_NAME.get()) && cur != null && cur.isPlaying()) {
					// Intro abhi chal raha hai — thoda ruk kar dobara try karo.
					// 'this' = yehi Runnable (self-reference Java me allowed nahi
					// hota final var ke initializer me, isliye 'this' use karte hain).
					if (!popupLoaded.get()) {
						new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(this, 600);
					}
					return;
				}
			} catch (Exception ignored) {}
			loadPopupNow.run();
		}};

		// ── Intro sound — now owned by the loading page ──
		// Java plays NO sound here anymore. The loading page triggers its own
		// sounds via ZAYRO.playSound(), exactly like popup pages, so there is
		// never a double intro. The popup page loads once the loading screen's
		// 5s window is over (or once the intro has actually finished).
		new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(loadPopup, 5000);
		
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
								wL.loadDataWithBaseURL("file://" + ZD + "/", html, "text/html", "UTF-8", null);
							}});
					} catch (Exception e) { android.util.Log.e("DW", "lodale dec: " + e.getMessage()); }
				}}).start();
		} catch (Exception e) { android.util.Log.e("DW", "lodale open: " + e.getMessage()); }
		
		
		// ── WEBCHROME POPUP INTENT HOOK CLIENT ──
		wP.setWebChromeClient(new android.webkit.WebChromeClient() {
			@Override
			public boolean onCreateWindow(android.webkit.WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
				android.webkit.WebView tempView = new android.webkit.WebView(view.getContext());
				tempView.getSettings().setJavaScriptEnabled(true);
				tempView.setWebViewClient(new android.webkit.WebViewClient() {
					@Override
					public boolean shouldOverrideUrlLoading(android.webkit.WebView v, android.webkit.WebResourceRequest request) {
						final String url = request.getUrl().toString();
						wP.post(new Runnable() {
							public void run() {
								wP.evaluateJavascript("var iframe = document.getElementById('target-game-frame'); if(iframe) { iframe.src = '" + url + "'; }", null);
							}
						});
						return true;
					}
					@Override
					public boolean shouldOverrideUrlLoading(android.webkit.WebView v, String url) {
						final String fUrl = url;
						wP.post(new Runnable() {
							public void run() {
								wP.evaluateJavascript("var iframe = document.getElementById('target-game-frame'); if(iframe) { iframe.src = '" + fUrl + "'; }", null);
							}
						});
						return true;
					}
				});
				
				android.webkit.WebView.WebViewTransport transport = (android.webkit.WebView.WebViewTransport) resultMsg.obj;
				transport.setWebView(tempView);
				resultMsg.sendToTarget();
				return true;
			}
		});
		
		wP.setWebViewClient(new android.webkit.WebViewClient() {
			private void reportGameUrl(final android.webkit.WebView view, final String url) {
				if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) return;
				view.post(new Runnable() {
					@Override public void run() {
						try {
							String quoted = org.json.JSONObject.quote(url);
							view.evaluateJavascript("try{if(typeof window.setUrl==='function')window.setUrl(" + quoted + ");}catch(e){}", null);
						} catch (Exception ignored) {}
					}
				});
			}

			private boolean isPageRequest(android.webkit.WebResourceRequest request, String url) {
				try {
					String accept = request.getRequestHeaders().get("Accept");
					if (accept != null && accept.toLowerCase().contains("text/html")) return true;
					String destination = request.getRequestHeaders().get("Sec-Fetch-Dest");
					if (destination != null) {
						destination = destination.toLowerCase();
						if (destination.equals("document") || destination.equals("iframe") || destination.equals("frame")) return true;
					}
				} catch (Exception ignored) {}
				// Never infer panel state from JSON/API/image resources. Their URLs can
				// contain words such as wingo or wallet while Register is still open.
				return false;
			}

			@Override
			public boolean shouldOverrideUrlLoading(android.webkit.WebView view, android.webkit.WebResourceRequest request) {
				reportGameUrl(view, request.getUrl().toString());
				return false;
			}

			@Override
			public boolean shouldOverrideUrlLoading(android.webkit.WebView view, String url) {
				reportGameUrl(view, url);
				return false;
			}

			@Override
			public android.webkit.WebResourceResponse shouldInterceptRequest(android.webkit.WebView view, android.webkit.WebResourceRequest request) {
				String url = request.getUrl().toString();
				if (isPageRequest(request, url)) reportGameUrl(view, url);
				return super.shouldInterceptRequest(view, request);
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
	
}