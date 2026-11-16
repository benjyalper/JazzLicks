// Record yourself playing along with a track: the backing (straight from the
// app's audio output) and the microphone are captured side by side in the
// same audio clock, then mixed and exported as WAV or MP3.

// Collects ~90 ms batches in the audio thread and hands them over in one
// message each, so recording barely loads the page (which also runs the
// music scheduler).
const WORKLET = `
const BATCH = 4096;
class JLRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.fresh();
    this.port.onmessage = (e) => {
      if (e.data === 'start') this.on = true;
      else if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage('done'); }
    };
  }
  fresh() {
    this.l = new Float32Array(BATCH); this.r = new Float32Array(BATCH); this.m = new Float32Array(BATCH);
    this.n = 0; this.peak = 0;
  }
  flush() {
    if (!this.n) return;
    const l = this.l.slice(0, this.n), r = this.r.slice(0, this.n), m = this.m.slice(0, this.n);
    this.port.postMessage({ l, r, m, peak: this.peak }, [l.buffer, r.buffer, m.buffer]);
    this.fresh();
  }
  process(inputs) {
    if (!this.on) return true;
    const back = inputs[0] || [];
    const mic = inputs[1] || [];
    const bl = back[0], br = back[1] || back[0], mc = mic[0];
    const len = (bl || mc || { length: 128 }).length;
    for (let i = 0; i < len; i++) {
      if (this.n === BATCH) this.flush();
      const v = mc ? mc[i] : 0;
      this.l[this.n] = bl ? bl[i] : 0;
      this.r[this.n] = br ? br[i] : 0;
      this.m[this.n] = v;
      if (v > this.peak) this.peak = v; else if (-v > this.peak) this.peak = -v;
      this.n++;
    }
    return true;
  }
}
registerProcessor('jl-recorder', JLRecorder);
`;

let workletReady = null;

function ensureWorklet() {
  if (!workletReady) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    workletReady = Tone.getContext().addAudioWorkletModule(url);
  }
  return workletReady;
}

/** Ask for the microphone (raw: no echo cancelling or level changes, so an instrument sounds natural). */
export async function openMic() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('This browser can\'t record from a microphone.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    if (e && e.name === 'NotAllowedError') throw new Error('Microphone access was blocked. Allow it for this site in the browser settings and try again.');
    if (e && e.name === 'NotFoundError') throw new Error('No microphone was found.');
    throw new Error('Could not open the microphone.');
  }
}

/**
 * Start capturing. Returns { start(), stop() → take, level() }.
 * start() begins writing (call it when the track starts playing).
 */
export async function startCapture(stream) {
  await ensureWorklet();
  const ctx = Tone.getContext();
  const raw = ctx.rawContext;
  const node = ctx.createAudioWorkletNode('jl-recorder', { numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1] });
  const micSrc = raw.createMediaStreamSource(stream);
  const silent = raw.createGain();
  silent.gain.value = 0;
  Tone.getDestination().connect(node, 0, 0);
  micSrc.connect(node, 0, 1);
  node.connect(silent);
  silent.connect(raw.destination); // keeps the recorder running

  const chunks = [];
  let peak = 0;
  let done = null;
  node.port.onmessage = (e) => {
    if (e.data === 'done') { if (done) done(); return; }
    chunks.push(e.data);
    peak = Math.max(peak, e.data.peak);
  };

  const track = stream.getAudioTracks()[0];
  const settings = (track && track.getSettings && track.getSettings()) || {};
  // How late the microphone hears the track (output + input delay): measured
  // with calibrate() on this device, or else a rough estimate.
  const measured = storedLatencyMs();
  const latency = measured !== null
    ? measured / 1000
    : (raw.baseLatency || 0) + (raw.outputLatency || 0) + (settings.latency || 0.01);

  return {
    start() { node.port.postMessage('start'); },
    level() { const p = peak; peak = 0; return p; },
    // Ends the capture and returns the take (waits for the last batch).
    async stop() {
      await new Promise((resolve) => {
        done = resolve;
        node.port.postMessage('stop');
        setTimeout(resolve, 500); // in case the audio is already suspended
      });
      try { Tone.getDestination().disconnect(node); } catch (e) { /* ignore */ }
      micSrc.disconnect();
      node.disconnect();
      silent.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      const len = chunks.reduce((n, c) => n + c.l.length, 0);
      const take = { sampleRate: raw.sampleRate, latency, calibrated: measured !== null, backL: new Float32Array(len), backR: new Float32Array(len), mic: new Float32Array(len) };
      let o = 0;
      for (const { l, r, m } of chunks) {
        take.backL.set(l, o);
        take.backR.set(r, o);
        take.mic.set(m, o);
        o += l.length;
      }
      return take;
    },
  };
}

// ---------------------------------------------------------------- calibration

const LATENCY_KEY = 'jazzlicks.micLatencyMs';

export function storedLatencyMs() {
  try {
    const v = localStorage.getItem(LATENCY_KEY);
    return v === null ? null : Number(v);
  } catch (e) {
    return null;
  }
}

function storeLatencyMs(ms) {
  try { localStorage.setItem(LATENCY_KEY, String(Math.round(ms))); } catch (e) { /* ignore */ }
}

const CAL_CLICKS = 10; // the first 2 are just to get into the pulse
const CAL_GAP = 0.6; // seconds between clicks (100 bpm)

/**
 * Find how late the microphone is against the track in a take that contains
 * clicks on the track and claps (or the clicks themselves, heard through the
 * speakers) on the microphone. Returns milliseconds, or null if unclear.
 */
export function measureOffset(take) {
  const sr = take.sampleRate;
  const hop = Math.round(sr * 0.001);
  const env = (x) => {
    const out = new Float32Array(Math.floor(x.length / hop));
    for (let k = 0; k < out.length; k++) {
      let m = 0;
      for (let i = k * hop; i < (k + 1) * hop; i++) m = Math.max(m, Math.abs(x[i]));
      out[k] = m;
    }
    return out;
  };
  const back = env(take.backL);
  const mic = env(take.mic);
  // Click positions on the track: rising edges after silence.
  const clicks = [];
  for (let k = 1; k < back.length; k++) {
    if (back[k] > 0.05 && back[k - 1] <= 0.05 && (!clicks.length || k - clicks[clicks.length - 1] > 300)) clicks.push(k);
  }
  if (clicks.length < 5) return null;
  // Microphone noise floor and level.
  const sorted = Float32Array.from(mic).sort();
  const floor = sorted[Math.floor(sorted.length * 0.2)];
  const loud = sorted[Math.floor(sorted.length * 0.995)];
  const thr = Math.max(floor * 6, floor + (loud - floor) * 0.25, 0.004);
  const offsets = [];
  for (const c of clicks.slice(2)) {
    // A clap can come a little early; the delay is at most ~0.45 s.
    for (let k = Math.max(1, c - 120); k < Math.min(mic.length, c + 450); k++) {
      if (mic[k] > thr && mic[k - 1] <= thr) { offsets.push(k - c); break; }
    }
  }
  if (offsets.length < 4) return null;
  offsets.sort((a, b) => a - b);
  const mid = offsets[Math.floor(offsets.length / 2)];
  const close = offsets.filter((o) => Math.abs(o - mid) <= 40);
  if (close.length < Math.max(4, offsets.length * 0.6)) return null; // too uneven to trust
  return close.reduce((a, b) => a + b, 0) / close.length;
}

/** Play clicks, record the microphone, and store the measured delay. */
export async function calibrate(onStep) {
  const capture = await startCapture(await openMic());
  const click = new Tone.Synth({
    oscillator: { type: 'square' },
    envelope: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.01 },
    volume: -6,
  }).toDestination();
  capture.start();
  const t0 = Tone.now() + 0.4;
  for (let k = 0; k < CAL_CLICKS; k++) click.triggerAttackRelease('C6', 0.03, t0 + k * CAL_GAP);
  for (let k = 0; k < CAL_CLICKS; k++) {
    const wait = (t0 + k * CAL_GAP - Tone.now()) * 1000;
    await new Promise((r) => setTimeout(r, Math.max(0, wait)));
    if (onStep) onStep(k + 1, CAL_CLICKS);
  }
  await new Promise((r) => setTimeout(r, 700));
  const take = await capture.stop();
  click.dispose();
  const ms = measureOffset(take);
  if (ms === null) return null;
  storeLatencyMs(ms);
  return Math.round(ms);
}

/**
 * Mix a take: track and microphone levels (0–2), and how many milliseconds
 * to pull the microphone earlier to line it up with the track.
 */
export function mixTake(take, { trackGain = 1, micGain = 1, offsetMs = 0 } = {}) {
  const n = take.backL.length;
  const shift = Math.round(((take.latency * 1000 + offsetMs) / 1000) * take.sampleRate);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const j = i + shift;
    const m = j >= 0 && j < n ? take.mic[j] * micGain : 0;
    L[i] = take.backL[i] * trackGain + m;
    R[i] = take.backR[i] * trackGain + m;
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  // Never clip: scale the whole mix down if it would.
  if (peak > 0.98) {
    const g = 0.98 / peak;
    for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  }
  return { L, R, sampleRate: take.sampleRate };
}

export function encodeWav({ L, R, sampleRate }) {
  const n = L.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const dv = new DataView(buf);
  const str = (o, t) => [...t].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); str(8, 'WAVE');
  str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, n * 4, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    dv.setInt16(o, Math.max(-1, Math.min(1, L[i])) * 0x7fff, true);
    dv.setInt16(o + 2, Math.max(-1, Math.min(1, R[i])) * 0x7fff, true);
    o += 4;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

let lamePromise = null;
function loadLame() {
  if (!lamePromise) {
    lamePromise = new Promise((resolve, reject) => {
      if (window.lamejs) return resolve(window.lamejs);
      const s = document.createElement('script');
      s.src = 'lib/lame.min.js';
      s.onload = () => resolve(window.lamejs);
      s.onerror = () => { lamePromise = null; reject(new Error('Could not load the MP3 encoder.')); };
      document.head.appendChild(s);
    });
  }
  return lamePromise;
}

const toInt16 = (f) => {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff;
  return out;
};

/** Encode a mix as a 192 kbps stereo MP3. `onProgress(0..1)` while it works. */
export async function encodeMp3({ L, R, sampleRate }, onProgress) {
  const lame = await loadLame();
  const enc = new lame.Mp3Encoder(2, sampleRate, 192);
  const l16 = toInt16(L);
  const r16 = toInt16(R);
  const parts = [];
  const block = 1152 * 20;
  for (let i = 0; i < l16.length; i += block) {
    const out = enc.encodeBuffer(l16.subarray(i, i + block), r16.subarray(i, i + block));
    if (out.length) parts.push(new Uint8Array(out));
    if (onProgress && (i / block) % 20 === 0) {
      onProgress(i / l16.length);
      await new Promise((r) => setTimeout(r, 0)); // keep the page responsive
    }
  }
  const end = enc.flush();
  if (end.length) parts.push(new Uint8Array(end));
  if (onProgress) onProgress(1);
  return new Blob(parts, { type: 'audio/mpeg' });
}
