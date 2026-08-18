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
		void openGateway(String url);
		void closeGateway();
	}
	
	// ── Payment gateway overlay ──
	// Deposit pe click karke payment gateway (Razorpay/Cashfree/UPI…) ke
	// domain pe jaate hi game iframe BLACK ho jata tha — gateways khud ko
	// iframe ke andar load hone se block karti hain (X-Frame-Options).
	// Ab gateway ka URL app ke ANDAR hi full-screen WebView overlay me
	// khulta hai, payment proper hota hai, aur wapas game domain pe aate
	// hi overlay khud band ho kar game iframe reload kar deta hai.
	// GAME_DOMAIN build time pe apkbuilder.js yahan inject karta hai.
	private static final String GAME_DOMAIN = "";
	private android.widget.FrameLayout rootContainer = null;
	private android.webkit.WebView popupView = null;
	private android.widget.FrameLayout gatewayOverlay = null;
	private android.webkit.WebView gatewayView = null;
	private String gatewayReturnUrl = null;
	
	private MainBinding binding;
	
	@Override
	protected void onCreate(Bundle _savedInstanceState) {
		super.onCreate(_savedInstanceState);
		binding = MainBinding.inflate(getLayoutInflater());
		setContentView(binding.getRoot());
		initialize(_savedInstanceState);
		initializeLogic();
	}
	
	// Subdomain-aware game URL check: www.xyz.com = game, api.xyz.com /
	// pay.xyz.com = payment gateway (overlay tabhi band hoga jab asli game
	// page pe wapas aayein).
	private boolean isGameUrl(String u) {
		try {
			if (GAME_DOMAIN == null || GAME_DOMAIN.length() == 0) return false;
			String host = new java.net.URL(u).getHost();
			if (host == null) return false;
			host = host.toLowerCase();
			if (host.equals(GAME_DOMAIN)) return true;
			if (host.endsWith("." + GAME_DOMAIN)) {
				String sub = host.substring(0, host.length() - GAME_DOMAIN.length() - 1);
				if (sub.contains("pay") || sub.contains("api") || sub.contains("gateway") || sub.contains("cashier") || sub.contains("checkout")) return false;
				return true;
			}
			return false;
		} catch (Exception e) { return false; }
	}
	
	@Override
	public void onBackPressed() {
		if (gatewayOverlay != null) { hideGatewayOverlay(); return; }
		super.onBackPressed();
	}
	
	// ── Payment gateway overlay (in-app full screen) ──
	private void showGatewayOverlay(final String url) {
		runOnUiThread(new Runnable() { public void run() {
			try {
				if (url == null || url.length() == 0) return;
				if (!(url.startsWith("http://") || url.startsWith("https://"))) return;
				if (gatewayOverlay != null) {
					if (gatewayView != null) gatewayView.loadUrl(url);
					return;
				}
				final android.widget.FrameLayout ov = new android.widget.FrameLayout(MainActivity.this);
				ov.setBackgroundColor(0xFF0B0F1A);
				ov.setLayoutParams(new android.widget.FrameLayout.LayoutParams(-1, -1));
				
				final android.webkit.WebView gv = new android.webkit.WebView(MainActivity.this);
				android.webkit.WebSettings gs = gv.getSettings();
				gs.setJavaScriptEnabled(true);
				gs.setDomStorageEnabled(true);
				gs.setAllowFileAccess(true);
				gs.setAllowContentAccess(true);
				gs.setAllowFileAccessFromFileURLs(true);
				gs.setAllowUniversalAccessFromFileURLs(true);
				gs.setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
				gs.setSupportMultipleWindows(true);
				gs.setJavaScriptCanOpenWindowsAutomatically(true);
				gs.setMediaPlaybackRequiresUserGesture(false);
				gs.setUserAgentString("Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
				ov.addView(gv, new android.widget.FrameLayout.LayoutParams(-1, -1));
				
				// Close (✕) button
				final android.widget.TextView closeBtn = new android.widget.TextView(MainActivity.this);
				closeBtn.setText("\u2715");
				closeBtn.setTextColor(0xFFFFFFFF);
				closeBtn.setTextSize(20f);
				closeBtn.setPadding(28, 28, 28, 28);
				closeBtn.setOnClickListener(new android.view.View.OnClickListener() {
					public void onClick(android.view.View v) { hideGatewayOverlay(); }
				});
				ov.addView(closeBtn, new android.widget.FrameLayout.LayoutParams(-2, -2, android.view.Gravity.TOP | android.view.Gravity.END));
				
				final android.webkit.WebViewClient gwClient = new android.webkit.WebViewClient() {
					@Override
					public boolean shouldOverrideUrlLoading(android.webkit.WebView view, android.webkit.WebResourceRequest request) {
						final String u = request.getUrl().toString();
						// UPI / payment app deep links → external app me kholo
						if (u != null && (u.startsWith("upi://") || u.startsWith("intent://") || u.startsWith("phonepe://") || u.startsWith("paytmmp://") || u.startsWith("tez://") || u.startsWith("gpay://") || u.startsWith("bhimgpay://"))) {
							try {
								android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(u));
								i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
								MainActivity.this.startActivity(i);
							} catch (Exception e) {}
							return true;
						}
						// Payment wapas game domain pe aa gaya → overlay band + game reload
						if (isGameUrl(u)) {
							gatewayReturnUrl = u;
							hideGatewayOverlay();
							return true;
						}
						gv.loadUrl(u);
						return true;
					}
				};
				gv.setWebViewClient(gwClient);
				
				// Agar gateway overlay ke ANDAR bhi load fail/block ho jaye (bahut
				// rare) — to us URL ko device ke default browser me khol dete hain,
				// user ka payment kabhi atakta nahi.
				gv.setWebViewClient(new android.webkit.WebViewClient() {
					@Override
					public void onReceivedError(android.webkit.WebView view, int errorCode, String description, String failingUrl) {
						if (failingUrl != null && (failingUrl.startsWith("http://") || failingUrl.startsWith("https://")) && failingUrl.equals(view.getUrl())) {
							try {
								android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(failingUrl));
								i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
								MainActivity.this.startActivity(i);
							} catch (Exception e) {}
						}
						hideGatewayOverlay();
					}
				});
				gv.setWebChromeClient(new android.webkit.WebChromeClient() {
					@Override
					public boolean onCreateWindow(android.webkit.WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
						android.webkit.WebView temp = new android.webkit.WebView(view.getContext());
						temp.getSettings().setJavaScriptEnabled(true);
						temp.setWebViewClient(new android.webkit.WebViewClient() {
							@Override
							public boolean shouldOverrideUrlLoading(android.webkit.WebView v, android.webkit.WebResourceRequest request) {
								final String u = request.getUrl().toString();
								if (u != null && (u.startsWith("upi://") || u.startsWith("intent://") || u.startsWith("phonepe://") || u.startsWith("paytmmp://") || u.startsWith("tez://") || u.startsWith("gpay://") || u.startsWith("bhimgpay://"))) {
									try {
										android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse(u));
										i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
										MainActivity.this.startActivity(i);
									} catch (Exception e) {}
									return true;
								}
								if (isGameUrl(u)) {
									gatewayReturnUrl = u;
									hideGatewayOverlay();
									return true;
								}
								gv.loadUrl(u);
								return true;
							}
						});
						android.webkit.WebView.WebViewTransport transport = (android.webkit.WebView.WebViewTransport) resultMsg.obj;
						transport.setWebView(temp);
						resultMsg.sendToTarget();
						return true;
					}
				});
				
				gatewayView = gv;
				gatewayOverlay = ov;
				if (rootContainer != null) rootContainer.addView(ov);
				gv.loadUrl(url);
			} catch (Exception e) {}
		}});
	}
	
	private void hideGatewayOverlay() {
		runOnUiThread(new Runnable() { public void run() {
			try {
				if (gatewayOverlay != null && gatewayOverlay.getParent() != null) {
					((android.view.ViewGroup) gatewayOverlay.getParent()).removeView(gatewayOverlay);
				}
				if (gatewayView != null) {
					gatewayView.stopLoading();
					gatewayView.destroy();
				}
			} catch (Exception e) {}
			gatewayOverlay = null;
			gatewayView = null;
			// Game iframe reload — naya balance/state aa jaye
			if (popupView != null) {
				try {
					String ret = gatewayReturnUrl;
					String js = "try{if(window.__zayroGwClosed)window.__zayroGwClosed();var f=document.getElementById('target-game-frame');if(f){var __ret="
						+ (ret != null ? org.json.JSONObject.quote(ret) : "null")
						+ ";var __gd='" + GAME_DOMAIN + "';f.src=__ret?__ret:(__gd&&__gd.length>0?('https://'+__gd+'/'):f.src);}}catch(e){}";
					popupView.evaluateJavascript(js, null);
				} catch (Exception e) {}
			}
			gatewayReturnUrl = null;
		}});
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
		// ═══════════════════════════════════════════════════════════════════
		// SIMPLE FLOW (no security vault) — intro Java se, popup/loading HTML
		// encrypted .bin files se, baaki sab assets PLAIN.
		// ═══════════════════════════════════════════════════════════════════
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
		
		s2.setJavaScriptCanOpenWindowsAutomatically(true);
		s2.setSupportMultipleWindows(true); 
		
		s2.setUserAgentString("Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36");
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
			public void openGateway(String u) { showGatewayOverlay(u); }
			
			@android.webkit.JavascriptInterface
			public void closeGateway() { hideGatewayOverlay(); }
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
		
		// ── HTML .bin DECRYPT (fixed key) ──
		final byte[] MK = {(byte)0xDE,(byte)0xAD,(byte)0xBE,(byte)0xEF,(byte)0xCA,(byte)0xFE,(byte)0xBA,(byte)0xBE};
		final String PW = "zayroavi@132";
		byte[] _buf = new byte[8192]; int _n;
		
		try {
			java.io.InputStream is = getAssets().open("zayro.bin");
			java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
			while ((_n = is.read(_buf)) != -1) bos.write(_buf, 0, _n); is.close();
			final byte[] bd = bos.toByteArray();
			new Thread(new Runnable() { public void run() {
					try {
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
					} catch (Exception e) { android.util.Log.e("DW", "popup dec: " + e.getMessage()); }
				}}).start();
		} catch (Exception e) { android.util.Log.e("DW", "popup open: " + e.getMessage()); }
		
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
			@Override
			public boolean shouldOverrideUrlLoading(android.webkit.WebView view, android.webkit.WebResourceRequest request) {
				return false;
			}
		});
		
		root.addView(wP); 
		root.addView(wL);
		setContentView(root);
		rootContainer = root;
		popupView = wP;
		
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
