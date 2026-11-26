// SPDX-License-Identifier: Apache-2.0
// uadpcm.js - the uADPCM codec of tt_um_pettit_adpcm in JavaScript: the same
// encoder and reference decoder as tools/uadpcm.py, bit for bit, the .ua
// file, and the song library kept on a QSPI Pmod.  Browser (global UADPCM)
// or Node (module.exports).
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else root.UADPCM = m;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const PRED0 = 0x8000, STEP0 = 16, MASK = 0xffff;

  const deltaOf = (step, m) =>
    (step >> 3) + (m & 4 ? step : 0) + (m & 2 ? step >> 1 : 0) + (m & 1 ? step >> 2 : 0);
  const nextStep = (step, m) => (m & 4 ? step + (step >> (3 - (m & 3))) : step - (step >> 4));
  const newState = () => ({ pred: PRED0, step: STEP0 });

  // codes (one per element, 0..15) -> unsigned 16-bit samples, exactly as the chip
  function decode(codes, state) {
    const st = state || newState();
    let pred = st.pred, step = st.step;
    const out = new Uint16Array(codes.length);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i], d = deltaOf(step, c & 7);
      pred = (c & 8 ? pred - d : pred + d) & MASK;
      step = nextStep(step, c & 7) & MASK;
      out[i] = pred;
    }
    st.pred = pred; st.step = step;
    return out;
  }

  // unsigned 16-bit targets -> codes: for each sample the code whose result
  // is nearest, among those that keep the predictor and the step in 16 bits
  function encode(target, state) {
    const st = state || newState();
    let pred = st.pred, step = st.step;
    const codes = new Uint8Array(target.length);
    for (let i = 0; i < target.length; i++) {
      const s = target[i];
      let bestE = Infinity, bestC = 0, bestP = pred, bestS = step;
      for (let m = 0; m < 8; m++) {
        const ns = nextStep(step, m);
        if (ns > MASK) continue;
        const d = deltaOf(step, m);
        let p = pred + d;
        if (p <= MASK) {
          const e = p > s ? p - s : s - p;
          if (e < bestE) { bestE = e; bestC = m; bestP = p; bestS = ns; }
        }
        p = pred - d;
        if (p >= 0) {
          const e = p > s ? p - s : s - p;
          if (e < bestE) { bestE = e; bestC = 8 | m; bestP = p; bestS = ns; }
        }
      }
      codes[i] = bestC; pred = bestP; step = bestS;
    }
    st.pred = pred; st.step = step;
    return codes;
  }

  // two codes a byte, the first in the low nibble
  function pack(codes) {
    const out = new Uint8Array((codes.length + 1) >> 1);
    for (let i = 0; i < codes.length; i++) out[i >> 1] |= codes[i] << (4 * (i & 1));
    return out;
  }
  function unpack(bytes, n) {
    const count = n === undefined ? bytes.length * 2 : n;
    const out = new Uint8Array(count);
    for (let i = 0; i < count; i++) out[i] = (bytes[i >> 1] >> (4 * (i & 1))) & 15;
    return out;
  }

  // .ua: 'uADP', u32 samples, u32 rate, then the packed codes
  function makeUa(body, samples, rate) {
    const out = new Uint8Array(12 + body.length);
    out.set([0x75, 0x41, 0x44, 0x50]);
    const dv = new DataView(out.buffer);
    dv.setUint32(4, samples, true); dv.setUint32(8, rate, true);
    out.set(body, 12);
    return out;
  }
  function parseUa(bytes) {
    if (bytes.length < 12 || bytes[0] !== 0x75 || bytes[1] !== 0x41 || bytes[2] !== 0x44 || bytes[3] !== 0x50) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const samples = dv.getUint32(4, true), rate = dv.getUint32(8, true);
    return { samples, rate, body: bytes.subarray(12, 12 + ((samples + 1) >> 1)) };
  }

  // a short run of codes that takes the decoder from `state` back to
  // mid-scale and lets the step fall: what is sent when a stream is stopped
  function tail(state, rate, rampS, holdS) {
    const nr = Math.max(1, Math.round((rampS === undefined ? 0.04 : rampS) * rate));
    const nh = Math.round((holdS === undefined ? 0.03 : holdS) * rate);
    const t = new Uint16Array((nr + nh + 1) & ~1);
    for (let i = 0; i < t.length; i++) {
      const w = i < nr ? 0.5 + 0.5 * Math.cos(Math.PI * (i + 1) / nr) : 0;
      t[i] = Math.round(PRED0 + (state.pred - PRED0) * w);
    }
    return encode(t, state);
  }

  // ---- the library: a directory in the first 4 KiB of a store, then the
  // streams at 4 KiB-aligned offsets.  'uALB', u16 version, u16 count, 8
  // reserved; entries of 40 bytes: name[24], u32 offset, bytes, rate, samples
  const DIR_SIZE = 4096, ENTRY = 40, MAX_ENTRIES = Math.floor((DIR_SIZE - 16) / ENTRY);
  function parseDir(bytes) {
    if (bytes[0] !== 0x75 || bytes[1] !== 0x41 || bytes[2] !== 0x4c || bytes[3] !== 0x42) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = Math.min(dv.getUint16(6, true), MAX_ENTRIES), out = [];
    const td = new TextDecoder();
    for (let i = 0; i < n; i++) {
      const o = 16 + i * ENTRY;
      let e = 0;
      while (e < 24 && bytes[o + e]) e++;
      out.push({ name: td.decode(bytes.subarray(o, o + e)), offset: dv.getUint32(o + 24, true),
                 bytes: dv.getUint32(o + 28, true), rate: dv.getUint32(o + 32, true), samples: dv.getUint32(o + 36, true) });
    }
    return out;
  }
  function makeDir(entries) {
    const out = new Uint8Array(DIR_SIZE);
    out.set([0x75, 0x41, 0x4c, 0x42]);
    const dv = new DataView(out.buffer);
    dv.setUint16(4, 1, true); dv.setUint16(6, entries.length, true);
    const te = new TextEncoder();
    entries.forEach((en, i) => {
      const o = 16 + i * ENTRY;
      out.set(te.encode(en.name).subarray(0, 23), o);
      dv.setUint32(o + 24, en.offset, true); dv.setUint32(o + 28, en.bytes, true);
      dv.setUint32(o + 32, en.rate, true); dv.setUint32(o + 36, en.samples, true);
    });
    return out;
  }
  const up4k = (n) => (n + 4095) & ~4095;
  // first gap of `bytes` in a store of `size`; -1 if none
  function allocate(entries, bytes, size) {
    if (entries.length >= MAX_ENTRIES) return -1;
    const used = entries.map((e) => [e.offset, e.offset + up4k(e.bytes)]).sort((a, b) => a[0] - b[0]);
    let at = DIR_SIZE;
    for (const [a, b] of used) {
      if (a - at >= up4k(bytes)) break;
      at = Math.max(at, b);
    }
    return at + up4k(bytes) <= size ? at : -1;
  }
  function freeBytes(entries, size) {
    return size - DIR_SIZE - entries.reduce((s, e) => s + up4k(e.bytes), 0);
  }

  return { PRED0, STEP0, deltaOf, nextStep, newState, decode, encode, pack, unpack, makeUa, parseUa, tail,
           DIR_SIZE, MAX_ENTRIES, parseDir, makeDir, allocate, freeBytes, up4k };
});
