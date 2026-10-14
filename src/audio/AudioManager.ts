export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  enabled = true;

  private ensureCtx() {
    if (this.ctx) return this.ctx;
    const Ctor = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.masterGain = this.ctx!.createGain();
    this.masterGain.gain.value = 0.6;
    this.masterGain.connect(this.ctx!.destination);
    return this.ctx;
  }

  resume() {
    const c = this.ensureCtx();
    if (c && c.state === 'suspended') c.resume();
  }

  setEnabled(v: boolean) { this.enabled = v; }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, sweepTo?: number) {
    if (!this.enabled) return;
    const ctx = this.ensureCtx();
    if (!ctx || !this.masterGain) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (sweepTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, sweepTo), now + dur);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(vol, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(g).connect(this.masterGain);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  private noiseBurst(dur: number, vol: number, filterHz = 1200) {
    if (!this.enabled) return;
    const ctx = this.ensureCtx();
    if (!ctx || !this.masterGain) return;
    const now = ctx.currentTime;
    const bufferSize = Math.floor(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterHz;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filter).connect(g).connect(this.masterGain);
    src.start(now);
    src.stop(now + dur + 0.02);
  }

  launch() {
    this.tone(320, 0.14, 'triangle', 0.22, 90);
    this.noiseBurst(0.09, 0.18, 2400);
  }

  seedHitSeed() {
    // sharp thwack: quick noise + low tone
    this.noiseBurst(0.05, 0.55, 3800);
    this.tone(180, 0.14, 'square', 0.28, 60);
    this.tone(420, 0.05, 'triangle', 0.12, 220);
  }

  seedHitObstacle() {
    this.noiseBurst(0.04, 0.35, 2600);
    this.tone(240, 0.07, 'square', 0.14, 110);
  }

  rollTick(intensity: number) {
    if (intensity < 0.05) return;
    this.noiseBurst(0.03, Math.min(0.08, intensity * 0.08), 900);
  }

  score() {
    this.tone(660, 0.09, 'triangle', 0.22, 990);
    setTimeout(() => this.tone(990, 0.14, 'triangle', 0.2, 1400), 60);
  }

  victory() {
    const notes = [523, 659, 784, 1046];
    notes.forEach((f, i) => setTimeout(() => this.tone(f, 0.28, 'triangle', 0.25), i * 120));
  }

  /** Topie blast: a deep boom with a sharp crack on top and a rolling rumble. */
  topieBlast() {
    this.noiseBurst(0.06, 0.9, 5200);            // crack
    this.tone(110, 0.7, 'sawtooth', 0.42, 28);   // boom
    this.tone(60, 0.9, 'sine', 0.5, 24);         // sub
    this.noiseBurst(0.55, 0.6, 650);             // blast body
    setTimeout(() => this.noiseBurst(0.8, 0.25, 280), 140); // rumble tail
    setTimeout(() => { this.tone(880, 0.12, 'triangle', 0.2, 1320); this.tone(1320, 0.2, 'triangle', 0.16, 1760); }, 260);
  }

  gameOverBust() {
    this.noiseBurst(0.35, 0.5, 700);
    this.tone(120, 0.5, 'sawtooth', 0.25, 40);
  }
}
