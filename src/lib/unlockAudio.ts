// src/lib/unlockAudio.ts
export async function unlockIOSAudioOnce(): Promise<void> {
  try {
    const AC: any = (window.AudioContext || (window as any).webkitAudioContext);
    if (AC) {
      const ctx = new AC();
      if (ctx.state === "suspended") await ctx.resume();

      // Petit "ping" très court pour iOS (débloque souvent l'audio)
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      g.gain.value = 0.001; // très bas
      o.frequency.value = 880;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();

      setTimeout(() => {
        try {
          o.stop();
          ctx.close?.();
        } catch {}
      }, 40);
    }
  } catch {}

  // Débloquer / "amorcer" speechSynthesis (best-effort)
  try {
    const synth = window.speechSynthesis;
    synth?.getVoices?.();
    // Une annonce ultra courte; tu peux aussi enlever si tu ne veux rien entendre sur le portail.
    const u = new SpeechSynthesisUtterance("Navigation.");
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;
    window.speechSynthesis.speak(u);

    // Optionnel: arrêter tout de suite pour éviter d'entendre "Navigation."
    setTimeout(() => {
      try {
        window.speechSynthesis.cancel();
      } catch {}
    }, 80);
  } catch {}
}