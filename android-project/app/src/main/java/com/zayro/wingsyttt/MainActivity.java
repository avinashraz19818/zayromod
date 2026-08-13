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
		
		final Object BR = new Object() {
			@android.webkit.JavascriptInterface
			public void speak(String t) {
				if (T[0] != null) T[0].speak(t, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "z");
			}
			
			@android.webkit.JavascriptInterface
			public void playSound(final String f) {
				new Thread(new Runnable() { public void run() {
						android.media.MediaPlayer p = null;
						try {
							p = new android.media.MediaPlayer(); AP.set(p);
							android.content.res.AssetFileDescriptor a = getAssets().openFd(f);
							p.setDataSource(a.getFileDescriptor(), a.getStartOffset(), a.getLength()); a.close();
							final android.media.MediaPlayer fp = p;
							p.setOnCompletionListener(new android.media.MediaPlayer.OnCompletionListener() {
								public void onCompletion(android.media.MediaPlayer m) { AP.compareAndSet(fp, null); m.release(); }
							});
							p.prepare(); p.start();
						} catch (Exception e) {
							if (p != null) { AP.compareAndSet(p, null); try { p.release(); } catch (Exception x) {} }
						}
					}}).start();
			}
			
			@android.webkit.JavascriptInterface
			public void stopSound() {
				Object o = AP.getAndSet(null);
				if (o != null) {
					android.media.MediaPlayer p = (android.media.MediaPlayer) o;
					try { if (p.isPlaying()) p.stop(); } catch (Exception e) {}
					try { p.release(); } catch (Exception e) {}
				}
			}
		};
		
		wP.addJavascriptInterface(BR, "ZAYRO");
		
		// Play Intro sound on splash loading (Full 5 Secs)
		try {
			android.media.MediaPlayer introPlayer = new android.media.MediaPlayer();
			android.content.res.AssetFileDescriptor afd = getAssets().openFd("intro.mp3");
			introPlayer.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
			afd.close();
			introPlayer.prepare();
			introPlayer.start();
		} catch (Exception e) {}
		
		// ── CRYPTO FILE LOADER DECRYPTORS ──
		final SecurityUtil sec = new SecurityUtil();
		final byte[] MK = sec.getMarker();
		final String PW = sec.getDecryptKey();
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