// SPDX-License-Identifier: Apache-2.0
// dsp.js - the audio preparation of tools/audio2ua.py in JavaScript: trim,
// level, look-ahead limiter, fades.  Works on Float32Array samples in -1..1.
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else root.UADSP = m;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function peakOf(x) {
    let p = 0;
    for (let i = 0; i < x.length; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > p) p = a; }
    return p;
  }

  // [a, b): the audio with leading and trailing silence capped at keepS
  function trimRange(x, rate, keepS, floorDb) {
    const peak = peakOf(x);
    if (peak <= 0) return [0, x.length];
    const th = peak * Math.pow(10, floorDb / 20);
    let first = 0, last = x.length - 1;
    while (first < x.length && Math.abs(x[first]) <= th) first++;
    while (last > first && Math.abs(x[last]) <= th) last--;
    const keep = Math.round(keepS * rate);
    return [Math.max(0, first - keep), Math.min(x.length, last + keep + 1)];
  }

  // the level that `pct` percent of the samples are above
  function levelAbovePct(x, pct) {
    const bins = new Uint32Array(4096), peak = peakOf(x);
    if (peak <= 0) return 0;
    for (let i = 0; i < x.length; i++) bins[Math.min(4095, Math.floor(Math.abs(x[i]) / peak * 4096))]++;
    let need = x.length * pct / 100, k = 4095;
    while (k > 0 && need > bins[k]) need -= bins[k--];
    return (k + 0.5) / 4096 * peak;
  }

  // Look-ahead peak limiter: the gain starts to fall lookMs before a peak
  // and recovers with a releaseMs time constant.  Returns the stats.
  function limit(x, rate, ceiling, lookMs, releaseMs) {
    const n = Math.max(1, Math.round(lookMs * rate / 1000)), N = x.length;
    const need = new Float32Array(N);
    for (let i = 0; i < N; i++) { const a = Math.abs(x[i]); need[i] = a > ceiling ? ceiling / a : 1; }
    // sliding minimum over i-n .. i+n
    const mn = new Float32Array(N), dq = new Int32Array(N);
    let head = 0, tailq = 0;
    for (let i = 0; i < N + n; i++) {
      if (i < N) {
        while (tailq > head && need[dq[tailq - 1]] >= need[i]) tailq--;
        dq[tailq++] = i;
      }
      const c = i - n;
      if (c >= 0) {
        while (dq[head] < c - n) head++;
        mn[c] = need[dq[head]];
      }
    }
    // instant attack, exponential release
    const g = new Float32Array(N), a = Math.exp(-1000 / (releaseMs * rate));
    let cur = 1;
    for (let i = 0; i < N; i++) { cur = mn[i] < cur ? mn[i] : 1 - (1 - cur) * a; g[i] = cur; }
    // smooth the attack into a ramp (a moving average over n), never above what is needed
    let acc = 0, reduced = 0, over1 = 0, maxRed = 0;
    const half = n >> 1;
    for (let i = -half; i < n - half; i++) acc += g[Math.min(N - 1, Math.max(0, i))];
    for (let i = 0; i < N; i++) {
      let v = acc / n;
      if (v > mn[i]) v = mn[i];
      acc += g[Math.min(N - 1, i + n - half)] - g[Math.max(0, i - half)];
      if (v < 0.9886) reduced++;            // 0.1 dB
      if (v < 0.8913) over1++;              // 1 dB
      if (v < 1) { const r = -20 * Math.log10(v); if (r > maxRed) maxRed = r; }
      x[i] *= v;
    }
    return { reducedPct: 100 * reduced / Math.max(1, N), over1Pct: 100 * over1 / Math.max(1, N), maxDb: maxRed };
  }

  function fade(x, rate, fadeS) {
    const n = Math.min(Math.round(fadeS * rate), x.length >> 1);
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos(Math.PI * i / n);
      x[i] *= w; x[x.length - 1 - i] *= w;
    }
  }

  // -1..1 to the encoder's unsigned 16-bit targets, with tailSamples of silence
  function toTarget(x, tailSamples) {
    const t = new Uint16Array(x.length + (tailSamples || 0)).fill(32768);
    for (let i = 0; i < x.length; i++) {
      const v = Math.round(x[i] * 32767) + 32768;
      t[i] = v < 0 ? 0 : v > 65535 ? 65535 : v;
    }
    return t;
  }

  function snrDb(ref, got) {
    let sig = 0, err = 0;
    for (let i = 0; i < ref.length; i++) { const r = ref[i] - 32768, e = got[i] - ref[i]; sig += r * r; err += e * e; }
    return err ? 10 * Math.log10(sig / err) : Infinity;
  }

  return { peakOf, trimRange, levelAbovePct, limit, fade, toTarget, snrDb };
});
