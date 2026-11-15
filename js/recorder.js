// Record yourself playing along with a track: the backing (straight from the
// app's audio output) and the microphone are captured side by side in the
// same audio clock, then mixed and exported as WAV or MP3.

const WORKLET = `
class JLRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.port.onmessage = (e) => { this.on = e.data === 'start'; };
  }
  process(inputs) {
    if (this.on) {
      const back = inputs[0] || [];
      const mic = inputs[1] || [];
      const n = (back[0] || mic[0] || []).length || 128;
      const zero = new Float32Array(n);
      this.port.postMessage([
        (back[0] || zero).slice(), (back[1] || back[0] || zero).slice(), (mic[0] || zero).slice(),
      ]);
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
  node.port.onmessage = (e) => {
    chunks.push(e.data);
    const mic = e.data[2];
    for (let i = 0; i < mic.length; i += 8) peak = Math.max(peak, Math.abs(mic[i]));
  };

  const track = stream.getAudioTracks()[0];
  const settings = (track && track.getSettings && track.getSettings()) || {};
  // How late the microphone hears the track: output + input latency (estimated).
  const latency = (raw.baseLatency || 0) + (raw.outputLatency || 0) + (settings.latency || 0.01);

  return {
    start() { node.port.postMessage('start'); },
    level() { const p = peak; peak = 0; return p; },
    stop() {
      node.port.postMessage('stop');
      try { Tone.getDestination().disconnect(node); } catch (e) { /* ignore */ }
      micSrc.disconnect();
      node.disconnect();
      silent.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      const len = chunks.reduce((n, c) => n + c[0].length, 0);
      const take = { sampleRate: raw.sampleRate, latency, backL: new Float32Array(len), backR: new Float32Array(len), mic: new Float32Array(len) };
      let o = 0;
      for (const [l, r, m] of chunks) {
        take.backL.set(l, o);
        take.backR.set(r, o);
        take.mic.set(m, o);
        o += l.length;
      }
      return take;
    },
  };
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
