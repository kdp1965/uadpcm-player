// SPDX-License-Identifier: Apache-2.0
// app.js - the page: drop a file, convert it (uadpcm.js, dsp.js), and play,
// save or manage it on the board (board.js over Web Serial).
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tick = () => sleep(0);
  const fmtT = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  const fmtB = (n) => (n >= 1 << 20 ? (n / (1 << 20)).toFixed(2) + " MB" : Math.ceil(n / 1024) + " KB");

  const S = {
    fileBuf: null, fileName: "", decoded: null,   // the dropped file and its decode at one rate
    song: null,          // { name, rate, samples, body, out, target, snr, note }
    start: 0,            // sample where playback starts
    cursor: -1,          // sample being played, for the waveform
    board: null, port: null, reader: null, writer: null, stores: [],
    busy: "",            // "", "convert", "stream", "stored", "save", "connect"
    stream: null, preview: null, gen: 0,
    job: null,           // the promise of the play in progress
    nowPlaying: null,    // the library entry the board is playing
  };

  function log(msg) {
    const el = $("log");
    el.textContent += new Date().toLocaleTimeString() + "  " + msg + "\n";
    el.scrollTop = el.scrollHeight;
  }
  function fail(e) { log("Error: " + (e && e.message ? e.message : e)); }

  function refresh() {
    const on = !!S.board, idle = !S.busy;
    $("connect").textContent = on ? "Disconnect" : "Connect";
    $("connect").disabled = S.busy === "connect" || !("serial" in navigator);
    $("dot").className = "dot" + (on ? " on" : "");
    $("play").disabled = !(on && S.song && idle);
    const playing = S.busy === "stream" || S.busy === "stored";
    const paused = !!(S.board && S.board.paused);
    $("stop").disabled = !playing;
    for (const id of ["pause", "libpause"]) { $(id).disabled = !playing; $(id).textContent = paused ? "Resume" : "Pause"; }
    $("save").disabled = !(on && S.song && idle);
    $("saveui").classList.toggle("hidden", !(on && S.stores.length));
    $("library").classList.toggle("hidden", !(on && S.stores.length));
    for (const b of document.querySelectorAll("#stores button")) b.disabled = !idle && !b.dataset.stop;
  }
  function setBusy(b) { S.busy = b; refresh(); }
  function progress(v) {
    const p = $("prog");
    p.classList.toggle("hidden", v === null);
    if (v !== null) p.value = v;
  }

  // ------------------------------------------------------------ the song
  // The stream being played is made from the song as it was converted: before
  // the song changes, the stream is stopped (with its fade-out) and has ended.
  async function stopStream() {
    if (S.busy !== "stream") return;
    log("Stopping playback: the song is changing");
    stop();
    if (S.job) await S.job;
  }

  function loadFile(file) {
    return file.arrayBuffer().then((buf) => loadBytes(file.name, buf));
  }

  // one of the ready-made songs in songs/ (listed in songs/songs.js)
  async function loadCanned(song) {
    if (S.busy && S.busy !== "stream") { log("Busy: stop the board first"); return; }
    log("Loading " + song.title + " (" + fmtB(song.bytes) + ")");
    let buf;
    try {
      const r = await fetch("songs/" + encodeURIComponent(song.file));
      if (!r.ok) throw new Error("HTTP " + r.status);
      buf = await r.arrayBuffer();
    } catch (e) {
      log("Could not fetch songs/" + song.file + " (" + e.message + "). The ready-made songs need the page to be served: " +
          "python3 -m http.server --directory web, or drop the .ua file here.");
      return;
    }
    await loadBytes(song.file, buf, song.title);
  }

  async function loadBytes(fileName, buf, title) {
    await stopStream();
    if (S.busy && S.busy !== "convert") { log("Busy: stop the board first"); return; }
    stopPreview();
    const file = { name: fileName };
    const bytes = new Uint8Array(buf);
    const stem = title || file.name.replace(/\.[^.]*$/, "");
    S.start = 0; S.cursor = -1;
    $("savename").value = stem.slice(0, 23);
    const ua = UADPCM.parseUa(bytes);
    if (ua) {
      S.fileBuf = null; S.decoded = null;
      const out = UADPCM.decode(UADPCM.unpack(ua.body, ua.samples));
      S.song = { name: stem, rate: ua.rate, samples: ua.samples, body: ua.body.slice(), out, target: null, note: "ready-made stream",
                 fileStem: file.name.replace(/\.[^.]*$/, "") };
      $("convui").classList.add("hidden");
      showSong();
      log("Loaded " + file.name + ": " + fmtT(ua.samples / ua.rate) + " at " + ua.rate + " Hz");
      return;
    }
    if (bytes[0] === 0x4d && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64) {
      log("MIDI files are not rendered in the browser yet: use tools/audio2ua.py and drop the .ua");
      return;
    }
    S.fileBuf = buf; S.fileName = stem; S.decoded = null;
    $("convui").classList.remove("hidden");
    await convert();
  }

  async function convert() {
    if (!S.fileBuf) return;
    await stopStream();
    const gen = ++S.gen;
    const wasBusy = S.busy;
    if (!wasBusy) setBusy("convert");
    try {
      const rate = +$("rate").value;
      $("songui").classList.remove("hidden");
      $("songname").textContent = S.fileName;
      $("stats").textContent = "Decoding ...";
      await tick();
      if (!S.decoded || S.decoded.rate !== rate) {
        // decoding in a context of the target rate resamples to it
        const ctx = new OfflineAudioContext(1, 1, rate);
        const ab = await ctx.decodeAudioData(S.fileBuf.slice(0));
        const chans = [];
        for (let c = 0; c < ab.numberOfChannels; c++) chans.push(ab.getChannelData(c));
        S.decoded = { rate, chans };
      }
      if (gen !== S.gen) return;
      const chans = S.decoded.chans, n = chans[0].length, ch = $("channel").value;
      let x = new Float32Array(n);
      if (chans.length === 1 || ch === "left") x.set(chans[0]);
      else if (ch === "right") x.set(chans[1]);
      else { for (const c of chans) for (let i = 0; i < n; i++) x[i] += c[i]; for (let i = 0; i < n; i++) x[i] /= chans.length; }

      const startS = Math.max(0, +$("start").value || 0), endS = +$("end").value || 0;
      let a = Math.min(n, Math.round(startS * rate)), b = endS > startS ? Math.min(n, Math.round(endS * rate)) : n;
      x = x.subarray(a, b);
      let notes = [];
      if ($("trim").checked && x.length) {
        const [ta, tb] = UADSP.trimRange(x, rate, Math.max(0, +$("trimkeep").value || 0), -45);
        if (ta || tb < x.length) notes.push("trimmed " + (ta / rate).toFixed(1) + " s + " + ((x.length - tb) / rate).toFixed(1) + " s");
        x = x.subarray(ta, tb);
      }
      if (x.length < 2) { $("stats").textContent = "Nothing left to play with these settings."; S.song = null; return; }
      x = x.slice();

      const ceiling = Math.min(1, Math.max(0.1, +$("ceiling").value || 0.98));
      let gain = 1, useLimit = $("limit").checked;
      if ($("levelmode").value === "auto") {
        const pct = Math.min(40, Math.max(0.01, +$("levelval").value || 2));
        const q = UADSP.levelAbovePct(x, pct);
        gain = q > 0 ? Math.max(1, ceiling / q) : 1;
        useLimit = true;
      } else gain = Math.pow(10, (+$("levelval").value || 0) / 20);
      for (let i = 0; i < x.length; i++) x[i] *= gain;
      notes.push("gain " + (20 * Math.log10(gain) >= 0 ? "+" : "") + (20 * Math.log10(gain)).toFixed(1) + " dB");
      $("stats").textContent = "Limiting ..."; await tick();
      let warn = "";
      if (useLimit) {
        const st = UADSP.limit(x, rate, ceiling, 2, 80);
        notes.push("limiter touched " + st.over1Pct.toFixed(1) + "% by more than 1 dB");
        if (st.over1Pct > 50) warn = "The limiter is working on much of the song: lower the auto boost percentage or the gain.";
      } else if (UADSP.peakOf(x) > 1) warn = "Peaks above full scale will clip: turn the limiter on or lower the gain.";
      UADSP.fade(x, rate, Math.max(0, +$("fade").value || 0));

      $("stats").textContent = "Encoding ..."; await tick();
      if (gen !== S.gen) return;
      const tailN = Math.round(0.05 * rate), target = UADSP.toTarget(x, tailN + ((x.length + tailN) & 1));
      const codes = UADPCM.encode(target), out = UADPCM.decode(codes);
      S.song = { name: S.fileName, rate, samples: target.length, body: UADPCM.pack(codes), out, target,
                 snr: UADSP.snrDb(target, out), note: notes.join(", "), warn };
      S.start = Math.min(S.start, target.length - 1);
      showSong();
    } catch (e) {
      $("stats").textContent = "Could not decode this file.";
      fail(e);
    } finally {
      if (!wasBusy && S.busy === "convert") setBusy("");
    }
  }

  let convTimer = 0;
  function convertSoon() {
    if (S.busy === "stream") stop();        // at once, not after the pause that collects several changes
    clearTimeout(convTimer);
    convTimer = setTimeout(() => convert().catch(fail), 350);
  }

  function showSong() {
    const s = S.song;
    $("songui").classList.remove("hidden");
    $("songname").textContent = s.name;
    $("songmeta").textContent = fmtT(s.samples / s.rate) + "  ·  " + s.rate + " Hz  ·  " + fmtB(s.body.length);
    $("stats").innerHTML = (s.snr !== undefined ? "Signal-to-noise <b>" + s.snr.toFixed(1) + " dB</b>  ·  " : "") + s.note +
      (s.warn ? '<br><span class="warn">' + s.warn + "</span>" : "");
    s.env = null;
    draw();
    refresh();
  }

  // ---------------------------------------------------------- the waveform
  function draw() {
    const cv = $("wave"), g = cv.getContext("2d"), W = cv.width, H = cv.height, s = S.song;
    const css = getComputedStyle(document.documentElement);
    g.clearRect(0, 0, W, H);
    if (!s) return;
    if (!s.env) {
      const lo = new Float32Array(W), hi = new Float32Array(W), n = s.out.length;
      for (let x = 0; x < W; x++) {
        const a = Math.floor(x * n / W), b = Math.max(a + 1, Math.floor((x + 1) * n / W));
        let mn = 65535, mx = 0;
        for (let i = a; i < b; i++) { const v = s.out[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        lo[x] = mn; hi[x] = mx;
      }
      s.env = { lo, hi };
    }
    const sx = Math.round(S.start / s.samples * W);
    for (let x = 0; x < W; x++) {
      g.fillStyle = css.getPropertyValue(x < sx ? "--wave-dim" : "--wave");
      const y0 = H - s.env.hi[x] / 65535 * H, y1 = H - s.env.lo[x] / 65535 * H;
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
    g.fillStyle = css.getPropertyValue("--ink");
    g.fillRect(sx, 0, 2, H);
    if (S.cursor >= 0) {
      g.fillStyle = css.getPropertyValue("--bad");
      g.fillRect(Math.round(S.cursor / s.samples * W), 0, 3, H);
    }
  }

  $("wave").addEventListener("click", (ev) => {
    const s = S.song;
    if (!s || S.busy) return;
    if (!s.target) { log("A ready-made stream plays from its beginning only"); return; }
    const r = $("wave").getBoundingClientRect();
    S.start = Math.max(0, Math.min(s.samples - 2, Math.round((ev.clientX - r.left) / r.width * s.samples))) & ~1;
    if (S.start < s.rate / 4) S.start = 0;
    draw();
  });

  // the stream from the start marker: re-encoded from the decoder's reset
  // state, with a short fade in, when it does not start at the beginning
  function bodyFromStart() {
    const s = S.song;
    if (!S.start || !s.target) return s.body;
    const t = s.target.slice(S.start), n = Math.min(t.length, Math.round(0.01 * s.rate));
    for (let i = 0; i < n; i++) t[i] = Math.round(32768 + (t[i] - 32768) * i / n);
    return UADPCM.pack(UADPCM.encode(t));
  }

  // --------------------------------------------------------------- preview
  function stopPreview() {
    if (!S.preview) return;
    try { S.preview.src.stop(); S.preview.ctx.close(); } catch (e) { /* already ended */ }
    S.preview = null;
    $("preview").textContent = "Preview here";
  }
  $("preview").addEventListener("click", () => {
    if (S.preview) { stopPreview(); return; }
    const s = S.song;
    if (!s) return;
    const ctx = new AudioContext(), n = s.samples - S.start;
    const buf = ctx.createBuffer(1, n, s.rate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (s.out[S.start + i] - 32768) / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.connect(ctx.destination); src.start();
    S.preview = { ctx, src };
    src.onended = stopPreview;
    $("preview").textContent = "Stop preview";
  });

  $("download").addEventListener("click", () => {
    const s = S.song;
    if (!s) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([UADPCM.makeUa(s.body, s.samples, s.rate)], { type: "application/octet-stream" }));
    a.download = (s.fileStem || s.name) + ".ua";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  // ------------------------------------------------------------- the board
  async function disconnect(quiet) {
    // stop what is playing and let the board finish, so that it is left silent and at its prompt
    if (S.board && S.job && (S.busy === "stream" || S.busy === "stored")) {
      stop();
      await Promise.race([S.job.catch(() => {}), sleep(4000)]);
    }
    const { reader, writer, port } = S;
    S.board = null; S.port = S.reader = S.writer = null; S.stores = [];
    try { if (reader) await reader.cancel(); } catch (e) { /* gone */ }
    try { if (writer) writer.releaseLock(); } catch (e) { /* gone */ }
    try { if (port) await port.close(); } catch (e) { /* gone */ }
    $("status").textContent = "Not connected";
    S.busy = "";
    S.nowPlaying = null; S.job = null;
    progress(null);
    libProgress(null);
    refresh();
    if (!quiet) log("Disconnected");
  }

  async function connect() {
    if (S.board) { await disconnect(); return; }
    let port;
    try { port = await navigator.serial.requestPort({ filters: [{ usbVendorId: 0x2e8a }] }); } catch (e) { return; }
    setBusy("connect");
    $("status").textContent = "Connecting ...";
    try {
      await port.open({ baudRate: 115200 });
      await port.setSignals({ dataTerminalReady: true, requestToSend: true });
      S.port = port;
      S.writer = port.writable.getWriter();
      const writer = S.writer;
      const board = new UABoard.Board({ write: (d) => writer.write(d) }, log);
      S.reader = port.readable.getReader();
      const reader = S.reader;
      (async () => {
        try {
          for (;;) { const { value, done } = await reader.read(); if (done) break; if (value) board.feed(value); }
        } catch (e) { if (S.board === board) { log("The serial link dropped"); disconnect(true); } }
      })();

      const project = $("project").value.trim();
      let bitstream = null;
      const bs = window.UA_BITSTREAM;
      if (bs && bs.name === project) {
        const raw = atob(bs.b64), bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        bitstream = { bytes, crc: UABoard.crc32(bytes) };
      }
      const info = await board.connect({ project, clock: +$("clock").value || 32000000, probe: $("probe").checked, bitstream,
                                         confirm: async (text) => window.confirm(text) });
      S.board = board;
      S.stores = info.stores.map((st, i) => ({ i, flash: st[0] === "flash", size: st[2],
        label: st[0] === "flash" ? "Flash" : st[3], entries: [], formatted: false }));
      $("status").textContent = (info.fpga ? "FPGA breakout" : "Chip " + info.run) + ", " + project +
        (S.stores.length ? "  ·  " + S.stores.map((s) => s.label + " " + (s.size >> 20) + " MB").join(", ") : "  ·  no storage Pmod");
      log("Connected: " + (info.fpga ? "FPGA breakout" : "shuttle " + info.run) + "; codes on GPIO " + info.code + ".." + (info.code + 3) +
          ", strobe on GPIO " + info.strobe + (info.uploaded ? "; bitstream uploaded" : ""));
      const sel = $("savestore");
      sel.innerHTML = "";
      for (const s of S.stores) sel.add(new Option(s.label, s.i));
      const ram = S.stores.find((s) => !s.flash);
      if (ram) sel.value = ram.i;
      await loadLibrary();
      setBusy("");
    } catch (e) {
      fail(e);
      await disconnect(true);
    }
  }

  async function loadLibrary() {
    for (const s of S.stores) {
      try {
        const d = UADPCM.parseDir(await S.board.read(s.i, 0, UADPCM.DIR_SIZE));
        s.formatted = !!d;
        s.entries = (d || []).filter((e) => e.offset >= UADPCM.DIR_SIZE && e.offset + e.bytes <= s.size);
      } catch (e) { fail(e); }
    }
    renderLibrary();
  }

  function renderLibrary() {
    const root = $("stores");
    root.innerHTML = "";
    for (const s of S.stores) {
      const div = document.createElement("div");
      div.className = "store";
      const head = document.createElement("div");
      head.className = "row";
      head.innerHTML = "<h3></h3><span class='meta'></span>";
      head.firstChild.textContent = s.label;
      head.lastChild.textContent = (s.size >> 20) + " MB  ·  " + fmtB(Math.max(0, UADPCM.freeBytes(s.entries, s.size))) + " free" +
        (s.flash ? "" : "  ·  lost when the power goes");
      div.appendChild(head);
      if (!s.entries.length) {
        const p = document.createElement("div");
        p.className = "meta"; p.textContent = "No songs.";
        div.appendChild(p);
      } else {
        const t = document.createElement("table");
        t.innerHTML = "<tr><th>Name</th><th class='num'>Length</th><th class='num'>Rate</th><th class='num'>Size</th><th></th></tr>";
        s.entries.forEach((e, k) => {
          const tr = t.insertRow();
          tr.insertCell().textContent = e.name;
          const c1 = tr.insertCell(); c1.className = "num"; c1.textContent = fmtT(e.samples / e.rate);
          const c2 = tr.insertCell(); c2.className = "num"; c2.textContent = e.rate + " Hz";
          const c3 = tr.insertCell(); c3.className = "num"; c3.textContent = fmtB(e.bytes);
          const c4 = tr.insertCell(); c4.className = "num";
          const bp = document.createElement("button"); bp.className = "small";
          if (S.nowPlaying === e) { bp.textContent = "Stop"; bp.dataset.stop = "1"; bp.classList.add("primary"); bp.onclick = stop; }
          else { bp.textContent = "Play"; bp.onclick = () => { S.job = playStored(s, e); }; }
          const br = document.createElement("button"); br.className = "small"; br.textContent = "Rename"; br.style.marginLeft = "6px";
          br.onclick = () => renameEntry(s, k);
          const bd = document.createElement("button"); bd.className = "small"; bd.textContent = "Delete"; bd.style.marginLeft = "6px";
          bd.onclick = () => removeEntry(s, k);
          c4.append(bp, br, bd);
        });
        div.appendChild(t);
      }
      root.appendChild(div);
    }
    refresh();
  }

  async function playOnChip() {
    const s = S.song;
    if (!s || !S.board || S.busy) return;
    stopPreview();
    setBusy("stream");
    const body = bodyFromStart(), st = UADPCM.newState();
    const run = { stop: false, done: false, t0: 0, pausedAt: 0, pausedFor: 0 };
    S.stream = run;
    let pos = 0;
    const source = (max) => {
      if (run.done) return new Uint8Array(0);
      if (run.stop) { run.done = true; return UADPCM.pack(UADPCM.tail(st, s.rate)); }
      const b = body.subarray(pos, pos + max);
      pos += b.length;
      UADPCM.decode(UADPCM.unpack(b), st);
      return b;
    };
    let sent = 0;
    const anim = () => {
      if (S.stream !== run) return;
      if (run.t0) {
        const played = Math.min(sent * 2, ((run.pausedAt || performance.now()) - run.t0 - run.pausedFor) / 1000 * s.rate);
        S.cursor = Math.min(s.samples - 1, S.start + played);
        draw();
      }
      requestAnimationFrame(anim);
    };
    requestAnimationFrame(anim);
    log("Playing " + s.name + (S.start ? " from " + fmtT(S.start / s.rate) : ""));
    try {
      const r = await S.board.play(s.rate, source, (n) => {
        sent = n;
        // the board starts when it holds two blocks (or the whole stream)
        if (!run.t0 && (n >= 2 * UABoard.BLOCK || n >= body.length)) run.t0 = performance.now();
      });
      log((run.stop ? "Stopped" : "Finished") + (r.late ? "; " + r.late + " blocks arrived late (audible glitches)" : ""));
    } catch (e) { fail(e); }
    S.stream = null; S.cursor = -1;
    draw();
    if (S.board) setBusy("");
  }

  function libProgress(e, bytes) {
    const now = $("libnow");
    now.classList.toggle("hidden", !e);
    if (!e) return;
    $("libprog").value = bytes / e.bytes;
    $("libtext").textContent = e.name + "  " + fmtT(bytes * 2 / e.rate) + " / " + fmtT(e.samples / e.rate);
  }

  async function playStored(store, e) {
    if (!S.board || S.busy) return;
    stopPreview();
    S.nowPlaying = e;
    setBusy("stored");
    renderLibrary();
    libProgress(e, 0);
    log("Board plays " + e.name + " from " + store.label);
    try {
      // the board reports what it has read, which is two blocks ahead of what is heard
      const r = await S.board.playStored(store.i, e.offset, e.bytes, e.rate,
                                         (p) => libProgress(e, Math.max(0, p - 2 * UABoard.BLOCK)));
      log(r.stopped ? "Stopped" : "Finished");
    } catch (err) { fail(err); }
    S.nowPlaying = null;
    libProgress(null);
    if (S.board) { setBusy(""); renderLibrary(); }
  }

  async function writeDir(store) {
    await S.board.save(store.i, 0, UADPCM.makeDir(store.entries));
    store.formatted = true;
  }

  async function saveSong() {
    const s = S.song, store = S.stores.find((x) => x.i === +$("savestore").value);
    if (!s || !store || !S.board || S.busy) return;
    const name = ($("savename").value.trim() || s.name).slice(0, 23);
    const offset = UADPCM.allocate(store.entries, s.body.length, store.size);
    if (offset < 0) { log("No room in " + store.label + " for " + fmtB(s.body.length) + ": delete a song first"); return; }
    if (store.flash && !store.formatted &&
        !window.confirm("The flash has no song library yet. Songs are written from address 0x1000 up and the directory at 0; " +
                        "whatever is stored there now is erased as they are written. Continue?")) return;
    setBusy("save");
    progress(0);
    log("Saving " + name + " to " + store.label + " (" + fmtB(s.body.length) + ")");
    const t0 = performance.now();
    try {
      await S.board.save(store.i, offset, s.body, (n) => progress(n / s.body.length));
      store.entries.push({ name, offset, bytes: s.body.length, rate: s.rate, samples: s.samples });
      await writeDir(store);
      log("Saved and verified in " + ((performance.now() - t0) / 1000).toFixed(1) + " s");
    } catch (e) { fail(e); }
    progress(null);
    renderLibrary();
    if (S.board) setBusy("");
  }

  async function removeEntry(store, k) {
    if (!S.board || S.busy) return;
    const e = store.entries[k];
    if (!window.confirm("Delete " + e.name + " from " + store.label + "?")) return;
    setBusy("save");
    try {
      store.entries.splice(k, 1);
      await writeDir(store);
      log("Deleted " + e.name);
    } catch (err) { fail(err); }
    renderLibrary();
    if (S.board) setBusy("");
  }

  async function renameEntry(store, k) {
    if (!S.board || S.busy) return;
    const e = store.entries[k];
    let name = window.prompt("New name for " + e.name + " (" + store.label + ")", e.name);
    if (name === null) return;
    name = name.trim();
    while (new TextEncoder().encode(name).length > 23) name = name.slice(0, -1);
    if (!name || name === e.name) return;
    setBusy("save");
    const old = e.name;
    try {
      e.name = name;
      await writeDir(store);          // only the 4 KiB directory is rewritten
      log("Renamed " + old + " to " + name);
    } catch (err) { e.name = old; fail(err); }
    renderLibrary();
    if (S.board) setBusy("");
  }

  function stop() {
    if (S.busy === "stream" && S.stream) {
      S.stream.stop = true;
      if (S.board && S.board.paused) togglePause();     // the fade-out has to be played
    } else if (S.busy === "stored" && S.board) S.board.stop();
  }

  async function togglePause() {
    const b = S.board;
    if (!b || !(S.busy === "stream" || S.busy === "stored")) return;
    try {
      if (b.paused) {
        await b.resume();
        if (S.stream && S.stream.pausedAt) { S.stream.pausedFor += performance.now() - S.stream.pausedAt; S.stream.pausedAt = 0; }
        log("Resumed");
      } else {
        await b.pause();
        if (S.stream) S.stream.pausedAt = performance.now();
        log("Paused");
      }
    } catch (e) { fail(e); }
    refresh();
  }

  // ----------------------------------------------------------------- wiring
  $("connect").addEventListener("click", () => connect().catch(fail));
  $("play").addEventListener("click", () => { S.job = playOnChip().catch(fail); });
  $("libstop").addEventListener("click", stop);
  $("pause").addEventListener("click", togglePause);
  $("libpause").addEventListener("click", togglePause);
  // the page is going away: a last word to the board, without waiting for it
  window.addEventListener("pagehide", () => {
    if (!S.writer) return;
    try {
      if (S.busy === "stored") S.writer.write(new Uint8Array([3]));          // Ctrl-C
      else if (S.busy === "stream") S.writer.write(new Uint8Array(2));       // "the end" for its next request
    } catch (e) { /* too late */ }
  });
  $("stop").addEventListener("click", stop);
  $("save").addEventListener("click", () => saveSong().catch(fail));
  const drop = $("drop");
  drop.addEventListener("click", () => $("file").click());
  $("file").addEventListener("change", (ev) => { if (ev.target.files[0]) loadFile(ev.target.files[0]).catch(fail); ev.target.value = ""; });
  for (const t of ["dragenter", "dragover"]) document.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.add("over"); });
  for (const t of ["dragleave", "drop"]) document.addEventListener(t, (ev) => { ev.preventDefault(); drop.classList.remove("over"); });
  document.addEventListener("drop", (ev) => { const f = ev.dataTransfer && ev.dataTransfer.files[0]; if (f) loadFile(f).catch(fail); });
  for (const id of ["rate", "channel", "start", "end", "trim", "trimkeep", "levelmode", "levelval", "limit", "ceiling", "fade"]) {
    $(id).addEventListener("change", convertSoon);
  }
  $("levelmode").addEventListener("change", () => {
    const auto = $("levelmode").value === "auto";
    $("levelunit").textContent = auto ? "% over" : "dB";
    $("levelval").value = auto ? 2 : 0;
  });
  if ("serial" in navigator) {
    navigator.serial.addEventListener("disconnect", (ev) => { if (S.port && ev.target === S.port) { log("The board was unplugged"); disconnect(true); } });
  } else $("nosupport").classList.remove("hidden");
  window.addEventListener("resize", draw);
  const canned = window.UA_SONGS || [];
  if (canned.length) {
    $("canned").classList.remove("hidden");
    for (const song of canned) {
      const b = document.createElement("button");
      b.className = "small";
      b.textContent = song.title;
      b.title = fmtT(song.samples / song.rate) + ", " + fmtB(song.bytes);
      b.onclick = () => loadCanned(song).catch(fail);
      $("cannedlist").appendChild(b);
    }
  }
  window.UAApp = S;      // for the console
  refresh();
})();
