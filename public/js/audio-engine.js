/**
 * ⚡ ZAYRO HIGH-DEFINITION AUDIO ENGINE (Web Audio API Synthesizer)
 * Premium, zero-latency procedural UI sound generator.
 * Works 100% offline with zero external audio assets.
 */
(function() {
  let audioCtx = null;
  let isMuted = false; // Always ON by default

  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  // Unlock audio context on first user interaction
  const unlockAudio = () => {
    getAudioContext();
    window.removeEventListener('click', unlockAudio);
    window.removeEventListener('touchstart', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
  };
  window.addEventListener('click', unlockAudio, { passive: true });
  window.addEventListener('touchstart', unlockAudio, { passive: true });
  window.addEventListener('keydown', unlockAudio, { passive: true });

  const SoundFX = {
    // 🎧 Satisfying Deep Crystal Pop / Haptic Tap (Rich, punchy and loud)
    click: (ctx) => {
      const now = ctx.currentTime;
      // 1) Main resonant pop (sine + triangle)
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(620, now);
      osc1.frequency.exponentialRampToValueAtTime(160, now + 0.055);
      gain1.gain.setValueAtTime(0.42, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.055);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.06);

      // 2) High crisp glass click transient
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(1800, now);
      osc2.frequency.exponentialRampToValueAtTime(950, now + 0.025);
      gain2.gain.setValueAtTime(0.25, now);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now);
      osc2.stop(now + 0.03);
    },

    // 📑 Tab / Nav Switch Chime
    tab: (ctx) => {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(520, now);
      osc.frequency.exponentialRampToValueAtTime(1040, now + 0.065);
      gain.gain.setValueAtTime(0.35, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.065);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.07);
    },

    // 🚀 APK Build Started (Sci-Fi Power Surge & Synth Ignition)
    buildStart: (ctx) => {
      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sawtooth';
      osc1.frequency.setValueAtTime(110, now);
      osc1.frequency.exponentialRampToValueAtTime(580, now + 0.45);
      gain1.gain.setValueAtTime(0.02, now);
      gain1.gain.linearRampToValueAtTime(0.35, now + 0.2);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(440, now + 0.08);
      osc2.frequency.exponentialRampToValueAtTime(1320, now + 0.45);
      gain2.gain.setValueAtTime(0.001, now);
      gain2.gain.setValueAtTime(0.30, now + 0.08);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

      osc1.connect(gain1);
      osc2.connect(gain2);
      gain1.connect(ctx.destination);
      gain2.connect(ctx.destination);
      osc1.start(now);
      osc2.start(now + 0.08);
      osc1.stop(now + 0.55);
      osc2.stop(now + 0.55);
    },

    // 🏆 APK Build Completed (Triumphant High-Definition Victory Chime)
    buildComplete: (ctx) => {
      const now = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.50, 1318.51]; // C5, E5, G5, C6, E6
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const startTime = now + (idx * 0.08);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, startTime);
        gain.gain.setValueAtTime(0.001, startTime);
        gain.gain.linearRampToValueAtTime(0.38, startTime + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.5);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startTime);
        osc.stop(startTime + 0.55);
      });
    },

    // 🪙 Golden Coin Metallic Ring
    coin: (ctx) => {
      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();
      osc1.type = 'sine';
      osc2.type = 'triangle';
      osc1.frequency.setValueAtTime(2093, now); // C7
      osc1.frequency.setValueAtTime(2793.83, now + 0.06); // F7
      osc2.frequency.setValueAtTime(4186, now + 0.06); // C8
      gain.gain.setValueAtTime(0.36, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);
      osc1.start(now);
      osc2.start(now + 0.06);
      osc1.stop(now + 0.5);
      osc2.stop(now + 0.5);
    },

    // ✨ Success Notification Chime
    success: (ctx) => {
      const now = ctx.currentTime;
      [587.33, 880].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const start = now + (i * 0.09);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.01, start);
        gain.gain.linearRampToValueAtTime(0.35, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, start + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.4);
      });
    },

    // 📢 Popup Announcement Ambient Chime
    popup: (ctx) => {
      const now = ctx.currentTime;
      const freqs = [523.25, 659.25, 783.99];
      freqs.forEach((f, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f, now + (i * 0.05));
        gain.gain.setValueAtTime(0.01, now + (i * 0.05));
        gain.gain.linearRampToValueAtTime(0.28, now + (i * 0.05) + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, now + (i * 0.05) + 0.45);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + (i * 0.05));
        osc.stop(now + (i * 0.05) + 0.5);
      });
    },

    // ❌ Error Buzz
    error: (ctx) => {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(180, now);
      osc.frequency.setValueAtTime(130, now + 0.08);
      gain.gain.setValueAtTime(0.30, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.25);
    }
  };

  window.playAudio = function(soundName) {
    if (isMuted) return;
    try {
      const ctx = getAudioContext();
      if (!ctx) return;
      if (SoundFX[soundName]) {
        SoundFX[soundName](ctx);
      } else if (SoundFX.click) {
        SoundFX.click(ctx);
      }
    } catch (e) {
      // Audio autoplay policy fallback
    }
  };

  window.playSound = function(soundName) {
    window.playAudio(soundName);
  };

  window.toggleAudioMute = function() {
    isMuted = !isMuted;
    if (!isMuted) window.playAudio('click');
    return !isMuted;
  };

  window.isAudioMuted = function() {
    return isMuted;
  };

  // Bind click sounds to all interactive elements automatically
  document.addEventListener('click', (e) => {
    const target = e.target.closest('button, a, .btn, .nav-link, .nav-item, .stat-card, .design-card, .tab-btn, .font-btn, .mode-card, input[type="radio"], input[type="checkbox"]');
    if (target) {
      if (target.classList.contains('nav-link') || target.classList.contains('nav-item') || target.classList.contains('tab-btn')) {
        window.playAudio('tab');
      } else {
        window.playAudio('click');
      }
    }
  }, { passive: true });
})();
