/**
 * ⚡ ZAYRO CYBERPUNK AUDIO ENGINE (Web Audio API Synthesizer)
 * High-definition, zero-latency procedural UI sound generator.
 * Works 100% offline without external audio files.
 */
(function() {
  let audioCtx = null;
  let isMuted = localStorage.getItem('zayro_sound_muted') === 'true';

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

  // Unlock audio context on user interaction
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
    // 🖱️ Crisp Futuristic Click
    click: (ctx) => {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, now);
      osc.frequency.exponentialRampToValueAtTime(1400, now + 0.04);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.05);
    },

    // 📑 Tab / Navigation Switch
    tab: (ctx) => {
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(450, now);
      osc.frequency.exponentialRampToValueAtTime(900, now + 0.07);
      gain.gain.setValueAtTime(0.10, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.07);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.08);
    },

    // 🚀 APK Build Started (Sci-Fi Power surge)
    buildStart: (ctx) => {
      const now = ctx.currentTime;
      // Sub oscillator
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sawtooth';
      osc1.frequency.setValueAtTime(120, now);
      osc1.frequency.exponentialRampToValueAtTime(440, now + 0.45);
      gain1.gain.setValueAtTime(0.01, now);
      gain1.gain.linearRampToValueAtTime(0.15, now + 0.2);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

      // Cyber chime
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(600, now + 0.1);
      osc2.frequency.exponentialRampToValueAtTime(1200, now + 0.45);
      gain2.gain.setValueAtTime(0.001, now);
      gain2.gain.setValueAtTime(0.12, now + 0.1);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

      osc1.connect(gain1);
      osc2.connect(gain2);
      gain1.connect(ctx.destination);
      gain2.connect(ctx.destination);
      osc1.start(now);
      osc2.start(now + 0.1);
      osc1.stop(now + 0.55);
      osc2.stop(now + 0.55);
    },

    // 🏆 APK Build Completed (Triumphant Major Triad Victory Chime)
    buildComplete: (ctx) => {
      const now = ctx.currentTime;
      const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const startTime = now + (idx * 0.09);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, startTime);
        gain.gain.setValueAtTime(0.001, startTime);
        gain.gain.linearRampToValueAtTime(0.14, startTime + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.45);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startTime);
        osc.stop(startTime + 0.5);
      });
    },

    // ✈️ Telegram Sent / Bot Notification Chime
    telegramSent: (ctx) => {
      const now = ctx.currentTime;
      // High chime
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(987.77, now); // B5
      osc1.frequency.setValueAtTime(1318.51, now + 0.08); // E6
      gain1.gain.setValueAtTime(0.15, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.4);

      // Shimmer
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'triangle';
      osc2.frequency.setValueAtTime(1760, now + 0.08);
      gain2.gain.setValueAtTime(0.08, now + 0.08);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.08);
      osc2.stop(now + 0.4);
    },

    // 🪙 Golden Coin Ring
    coin: (ctx) => {
      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();
      osc1.type = 'sine';
      osc2.type = 'triangle';
      osc1.frequency.setValueAtTime(1975.53, now); // B6
      osc1.frequency.setValueAtTime(2637.02, now + 0.07); // E7
      osc2.frequency.setValueAtTime(3951.07, now + 0.07); // B7
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);
      osc1.start(now);
      osc2.start(now + 0.07);
      osc1.stop(now + 0.45);
      osc2.stop(now + 0.45);
    },

    // 📢 Popup Announcement Ambient Chime
    popup: (ctx) => {
      const now = ctx.currentTime;
      const freqs = [440, 554.37, 659.25];
      freqs.forEach((f, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f, now + (i * 0.05));
        gain.gain.setValueAtTime(0.01, now + (i * 0.05));
        gain.gain.linearRampToValueAtTime(0.08, now + (i * 0.05) + 0.04);
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
      osc.frequency.setValueAtTime(140, now + 0.08);
      gain.gain.setValueAtTime(0.12, now);
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

  window.toggleAudioMute = function() {
    isMuted = !isMuted;
    localStorage.setItem('zayro_sound_muted', isMuted ? 'true' : 'false');
    updateAudioToggleUI();
    if (!isMuted) window.playAudio('click');
    return !isMuted;
  };

  window.isAudioMuted = function() {
    return isMuted;
  };

  function updateAudioToggleUI() {
    document.querySelectorAll('.sound-toggle-btn').forEach(btn => {
      btn.innerHTML = isMuted
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg> <span class="snd-lbl">Muted</span>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg> <span class="snd-lbl">Sound ON</span>';
      btn.classList.toggle('muted', isMuted);
    });
  }

  // Bind click sounds to buttons, links, tabs automatically
  document.addEventListener('click', (e) => {
    const target = e.target.closest('button, a, .btn, .nav-link, .stat-card, .design-card, .tab-btn, .font-btn, input[type="radio"], input[type="checkbox"]');
    if (target) {
      if (target.classList.contains('nav-link') || target.classList.contains('tab-btn')) {
        window.playAudio('tab');
      } else {
        window.playAudio('click');
      }
    }
  }, { passive: true });

  document.addEventListener('DOMContentLoaded', updateAudioToggleUI);
})();
