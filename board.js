// SPDX-License-Identifier: Apache-2.0
// board.js - talks to the Tiny Tapeout demo board's MicroPython over a
// serial link (WebSerial in the browser, any byte pipe in Node): enters the
// raw REPL, loads the player below, and then streams uADPCM blocks to it,
// saves them to the QSPI Pmod's flash or PSRAM, or has the board play from
// there.  Browser (global UABoard) or Node (module.exports).
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else root.UABoard = m;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const BLOCK = 4096;       // bytes per block: 8192 samples, a quarter second at 31250 Hz

  // The MicroPython side.  %PROJECT%, %CLOCK% and %PROBE% are filled in.
  //
  // Streaming: a PIO state machine puts one 4-bit code on ui[3:0] and pulses
  // ui[4] per sample; two DMA channels chained to each other feed it from two
  // buffers, and Python refills the one that is not playing.
  //
  // Storage: the Tiny Tapeout QSPI Pmod on the uio port (uio0 flash CS, uio1
  // MOSI, uio2 MISO, uio3 SCK, uio4/5 the flash's WP and HOLD, uio6 and uio7
  // the two PSRAMs' CS), driven from the RP2 with a second PIO as plain SPI:
  // the micro tile has no uio, so the pins are free.
  const BOARD_PY = String.raw`
import sys, time, json, micropython, rp2, select, binascii
from machine import Pin
from ttboard.boot.demoboard_detect import DemoboardDetect
from ttboard.demoboard import DemoBoard
DemoboardDetect.probe()
tt = DemoBoard()
PROJECT = "%PROJECT%"
BITFILE = "/bitstreams/" + PROJECT + ".bin"
FPGA = type(tt.shuttle).__name__ == "FPGAMux"
CODE = tt.pins.ui_in0.gpio_num
STROBE = tt.pins.ui_in4.gpio_num
U = tt.pins.uio0.gpio_num
BLOCK = 4096
PIO0_TXF0 = 0x50200010
bufs = [bytearray(BLOCK), bytearray(BLOCK)]
mvs = [memoryview(b) for b in bufs]
hdr = memoryview(bytearray(2))
inp = sys.stdin.buffer
poll = select.poll()
poll.register(sys.stdin, select.POLLIN)

@rp2.asm_pio(out_init=(rp2.PIO.OUT_LOW,) * 4, sideset_init=rp2.PIO.OUT_LOW,
             out_shiftdir=rp2.PIO.SHIFT_RIGHT, autopull=True, pull_thresh=8, fifo_join=rp2.PIO.JOIN_TX)
def _stream():
    out(pins, 4).side(0)[7]
    nop().side(1)[7]

# the same, one code per word: for home()
@rp2.asm_pio(out_init=(rp2.PIO.OUT_LOW,) * 4, sideset_init=rp2.PIO.OUT_LOW,
             out_shiftdir=rp2.PIO.SHIFT_RIGHT, autopull=True, pull_thresh=4, fifo_join=rp2.PIO.JOIN_TX)
def _one():
    out(pins, 4).side(0)[7]
    nop().side(1)[7]

HOMED = False

def home():
    # Bring the decoder to its reset state (predictor 0x8000, step 16) with
    # codes, not with reset: reset drives the output to 0 and back, which is a
    # pop, and this is a ramp.  The chip shows the top 5 bits of its predictor
    # on uo[4:0].  Small codes let the step fall to 15, where a code moves the
    # predictor by exactly 1 (magnitude 0) or 11 (magnitude 3); the predictor
    # is walked to where uo[4:0] changes from 16 to 15, which is 0x7FFF; 15
    # more down and one magnitude 4 up (+16, step 15 -> 16) end at 0x8000, 16.
    global HOMED
    if HOMED:
        return
    uo = [Pin(getattr(tt.pins, "uo_out%d" % i).gpio_num, Pin.IN) for i in range(5)]
    sm = rp2.StateMachine(0, _one, freq=16 * 62500, out_base=Pin(CODE), sideset_base=Pin(STROBE))
    def send(code, n=1):
        for _ in range(n):
            sm.put(code)
    def duty():
        while sm.tx_fifo():
            pass
        time.sleep_us(150)
        return uo[0]() | uo[1]() << 1 | uo[2]() << 2 | uo[3]() << 3 | uo[4]() << 4
    sm.active(1)
    try:
        a = 8 if duty() >= 16 else 0         # the first, largest move is toward the middle
        for _ in range(90):
            send(a); send(a ^ 8)
        ok = False
        for _ in range(60):
            d = duty()
            if d == 15:
                ok = True
                break
            if d >= 16:
                send(0xB, 150 if d == 16 else (d - 16) * 186)
            else:
                send(0x3, (15 - d) * 186)
        n = 0
        while ok and duty() == 15 and n < 600:
            send(0x3, 4); n += 1
        n = 0
        while ok and duty() == 16 and n < 100:
            send(0x8); n += 1
        ok = ok and duty() == 15
        if ok:
            send(0x8, 15)
            send(0x4)
            duty()
    finally:
        sm.active(0)
    if not ok:                               # no answer on uo: the hard way
        tt.reset_project(True); time.sleep_ms(1); tt.reset_project(False)
    HOMED = True

def _recv(mv, n):
    k = 0
    while k < n:
        k += inp.readinto(mv[k:n])

SM = [None, False]                       # the stream's state machine, and whether it is running

def _pause():
    # Pause: the state machine that clocks the codes out stops, and with it
    # the DMA behind it.  The chip gets no strobe, keeps its state and holds
    # its output; the next two bytes from the host (FE FF) resume.
    run = SM[1]
    if run:
        SM[0].active(0)
    sys.stdout.write("PAUSED\n")
    _recv(hdr, 2)
    if run:
        SM[0].active(1)
    sys.stdout.write("RESUMED\n")

def _ctl():
    # between blocks the only thing the host sends is FF FF: pause
    if poll.poll(0):
        _recv(hdr, 2)
        if hdr[0] == 0xFF and hdr[1] == 0xFF:
            _pause()

def _req(mv):
    # ask the host for a block: it answers with a 2-byte length (0: the end) and the bytes
    sys.stdout.write("R\n")
    if not poll.poll(4000):
        raise OSError("host timeout")
    _recv(hdr, 2)
    n = hdr[0] | hdr[1] << 8
    if n == 0xFFFF:                      # a pause that crossed the request
        _pause()
        _recv(hdr, 2)
        n = hdr[0] | hdr[1] << 8
    if n:
        _recv(mv, n)
    return n

def hello():
    # what is on the board, before anything is enabled
    bit = None
    if FPGA:
        try:
            n, crc = 0, 0
            with open(BITFILE, "rb") as f:
                while True:
                    k = f.readinto(bufs[0])
                    if not k:
                        break
                    crc = binascii.crc32(mvs[0][:k], crc)
                    n += k
            bit = [n, crc]
        except OSError:
            pass
    print("J " + json.dumps({"fpga": FPGA, "run": str(tt.shuttle.run), "has": hasattr(tt.shuttle, PROJECT), "bit": bit}))

def putfile(path, n):
    # a file from the host (the FPGA bitstream)
    import os
    try:
        os.mkdir(path[:path.rfind("/")])
    except OSError:
        pass
    micropython.kbd_intr(-1)
    try:
        with open(path + ".part", "wb") as f:
            while n:
                k = _req(mvs[0])
                if not k:
                    break
                f.write(mvs[0][:k])
                n -= k
    finally:
        micropython.kbd_intr(3)
    if n == 0:                           # whole: only then does it replace the old one
        try:
            os.remove(path)
        except OSError:
            pass
        os.rename(path + ".part", path)
    sys.stdout.write("DONE\n")

def start():
    # enable the project, clock it, look for the QSPI Pmod
    getattr(tt.shuttle, PROJECT).enable()
    tt.ui_in.value = 0
    tt.clock_project_PWM(%CLOCK%)
    # out of reset from here on: in reset the output is 0, and the step to
    # mid-scale is heard once, now, and not before every song
    global HOMED
    tt.reset_project(True); time.sleep_ms(1); tt.reset_project(False)
    HOMED = True
    if %PROBE%:
        try:
            storage_init()
        except Exception as e:
            print("storage:", repr(e))
    print("J " + json.dumps({"code": CODE, "strobe": STROBE, "uio": U, "block": BLOCK, "stores": STORES}))

def _engine(rate, loader):
    dma = [rp2.DMA(), rp2.DMA()]
    def ctrl(i, chain):
        return dma[i].pack_ctrl(size=0, inc_read=True, inc_write=False, treq_sel=0,
                                chain_to=dma[i ^ 1 if chain else i].channel)
    def arm(i):
        n = loader(mvs[i])
        if n:
            dma[i].config(read=bufs[i], write=PIO0_TXF0, count=n, ctrl=ctrl(i, True), trigger=False)
        return n
    global HOMED
    home()
    sm = rp2.StateMachine(0, _stream, freq=16 * rate, out_base=Pin(CODE), sideset_base=Pin(STROBE))
    HOMED = False
    SM[0] = sm; SM[1] = False
    try:
        if arm(0):
            more = arm(1)
            if not more:
                dma[0].ctrl = ctrl(0, False)
            sm.active(1)
            SM[1] = True
            dma[0].active(1)
            cur = 0
            while True:
                while dma[cur].active():
                    _ctl()
                    time.sleep_ms(1)
                if not more:
                    break
                more = arm(cur)
                if not more:
                    dma[cur ^ 1].ctrl = ctrl(cur ^ 1, False)
                elif not dma[cur ^ 1].active():
                    sys.stdout.write("U\n")        # the block came too late
                cur ^= 1
            time.sleep_ms(2)
    finally:
        SM[1] = False
        sm.active(0)
        dma[0].close(); dma[1].close()
        try:
            home()                       # leave the output at mid-scale, ready for the next one
        except Exception:
            pass

def play(rate):
    micropython.kbd_intr(-1)            # the stream is binary: 0x03 is data
    try:
        _engine(rate, _req)
    finally:
        micropython.kbd_intr(3)
    sys.stdout.write("DONE\n")

# ------------------------------------------------------------ the QSPI Pmod
# Two state machines share SCK, and a PIO has one output latch: an
# instruction that waits with a side-set value keeps writing it and would
# hold the clock against the other one, so the instructions that can wait
# (the pulls and the push) carry no side-set.
@rp2.asm_pio(out_init=rp2.PIO.OUT_LOW, sideset_init=rp2.PIO.OUT_LOW, out_shiftdir=rp2.PIO.SHIFT_LEFT)
def _spi_tx():
    pull()
    set(x, 7)
    label("bit")
    out(pins, 1).side(0)
    jmp(x_dec, "bit").side(1)
    nop().side(0)

# the byte count - 1 is written first
@rp2.asm_pio(sideset_init=rp2.PIO.OUT_LOW, in_shiftdir=rp2.PIO.SHIFT_LEFT)
def _spi_rx():
    pull()
    mov(x, osr)
    label("byte")
    set(y, 7)
    label("bit")
    in_(pins, 1).side(1)
    jmp(y_dec, "bit").side(0)
    push()
    jmp(x_dec, "byte")

cs = tx = rx = None
STORES = []                              # [kind, chip select index, size]

def _x(c, head, rd=None, wr=None):
    cs[c](0)
    tx.put(head, 24)
    if wr is not None:
        tx.put(wr, 24)
    while tx.tx_fifo():
        pass
    time.sleep_us(6)            # the byte in the shifter
    if rd is not None:
        rx.put(len(rd) - 1)
        rx.get(rd)
    cs[c](1)

def _a(op, a):
    return bytes((op, (a >> 16) & 255, (a >> 8) & 255, a & 255))

def storage_init():
    global cs, tx, rx
    cs = [Pin(U + 0, Pin.OUT, value=1), Pin(U + 6, Pin.OUT, value=1), Pin(U + 7, Pin.OUT, value=1)]
    io = [Pin(U + 1, Pin.OUT, value=1), Pin(U + 2, Pin.OUT, value=1), Pin(U + 4, Pin.OUT, value=1), Pin(U + 5, Pin.OUT, value=1)]
    sck = Pin(U + 3, Pin.OUT, value=0)
    cs[0](0)                             # the flash: leave a continuous read mode
    for _ in range(16):
        sck(1); sck(0)
    cs[0](1)
    for c in cs[1:]:                     # the PSRAMs: leave QPI mode (F5h on four lines)
        c(0)
        for nib in (0xF, 0x5):
            for b in range(4):
                io[b]((nib >> b) & 1)
            sck(1); sck(0)
        c(1)
    Pin(U + 2, Pin.IN)
    Pin(U + 4, Pin.OUT, value=1); Pin(U + 5, Pin.OUT, value=1)
    tx = rp2.StateMachine(4, _spi_tx, freq=16_000_000, out_base=Pin(U + 1), sideset_base=Pin(U + 3))
    rx = rp2.StateMachine(5, _spi_rx, freq=16_000_000, in_base=Pin(U + 2), sideset_base=Pin(U + 3))
    tx.active(1); rx.active(1)
    b = bytearray(3)
    _x(0, b'\x9f', b)
    if b[0] not in (0, 255) and 16 <= b[2] <= 25:
        STORES.append(["flash", 0, 1 << b[2], binascii.hexlify(b).decode()])
    for c in (1, 2):                     # a PSRAM is one that keeps what is written to it
        a = 0x7FFFF0
        old = bytearray(16); got = bytearray(16)
        _x(c, _a(3, a), old)
        pat = bytes((i * 37 + c * 91 + 5) & 255 for i in range(16))
        _x(c, _a(2, a), wr=pat)
        _x(c, _a(3, a), got)
        _x(c, _a(2, a), wr=old)
        if bytes(got) == pat:
            STORES.append(["ram", c, 8 << 20, "RAM " + "AB"[c - 1]])
    if not STORES:                       # nothing there: let go of the pins
        tx.active(0); rx.active(0)
        for i in range(8):
            Pin(U + i, Pin.IN)

def _busy():
    b = bytearray(1)
    while True:
        _x(0, b'\x05', b)
        if not b[0] & 1:
            return

def mem_read(s, a, mv):
    c = STORES[s][1]
    if c == 0:
        _x(0, _a(3, a), mv)
    else:
        for o in range(0, len(mv), 512):     # short bursts: a PSRAM refreshes while CS is high
            _x(c, _a(3, a + o), mv[o:o + 512])

def mem_write(s, a, mv):
    c = STORES[s][1]
    step = 256 if c == 0 else 512
    for o in range(0, len(mv), step):
        if c == 0:
            _x(0, b'\x06')
        _x(c, _a(2, a + o), wr=mv[o:o + step])
        if c == 0:
            _busy()

def rd(s, a, n):
    mv = mvs[0][:n]
    mem_read(s, a, mv)
    print("H " + binascii.hexlify(mv).decode())

def save(s, a, n):
    # n bytes from the host to store s at a (a multiple of 4096), verified
    flash = STORES[s][1] == 0
    end = a + ((n + 4095) & ~4095)
    erased = a
    bad = 0
    micropython.kbd_intr(-1)
    try:
        while n:
            k = _req(mvs[0])
            if not k:
                break
            if flash and a >= erased:
                if a & 0xFFFF == 0 and end - a >= 0x10000:
                    op, sz = 0xD8, 0x10000
                else:
                    op, sz = 0x20, 0x1000
                _x(0, b'\x06'); _x(0, _a(op, a)); _busy()
                erased = a + sz
            mem_write(s, a, mvs[0][:k])
            mem_read(s, a, mvs[1][:k])
            if bufs[0][:k] != bufs[1][:k]:
                bad += 1
            a += k; n -= k
    finally:
        micropython.kbd_intr(3)
    sys.stdout.write("V %d\nDONE\n" % bad)

def splay(s, a, n, rate):
    # play n bytes of store s from a; Ctrl-C stops
    pos = [a, n]
    def loader(mv):
        k = min(BLOCK, pos[1])
        if k:
            mem_read(s, pos[0], mv[:k])
            pos[0] += k; pos[1] -= k
            sys.stdout.write("P %d\n" % (n - pos[1]))
        return k
    try:
        _engine(rate, loader)
        sys.stdout.write("DONE\n")
    except KeyboardInterrupt:
        sys.stdout.write("STOP\nDONE\n")

hello()
`;

  const enc = new TextEncoder(), dec = new TextDecoder();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class Board {
    // io: { write(Uint8Array) -> Promise }.  Feed received bytes to feed().
    constructor(io, log) {
      this.io = io;
      this.log = log || (() => {});
      this.rx = new Uint8Array(0);
      this.waiter = null;
      this.info = null;
      this.busy = false;
      this.stopFlag = false;
      this.paused = false;
      this.playing = false;
    }

    feed(chunk) {
      const n = new Uint8Array(this.rx.length + chunk.length);
      n.set(this.rx); n.set(chunk, this.rx.length);
      this.rx = n;
      if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
    }

    async _wait(ms) {
      let timer;
      await new Promise((res) => { this.waiter = res; timer = setTimeout(res, ms); });
      clearTimeout(timer);
      this.waiter = null;
    }

    // up to and including the first occurrence of any of the byte strings
    async readUntil(pats, timeoutMs) {
      const list = (Array.isArray(pats) ? pats : [pats]).map((p) => (typeof p === "string" ? enc.encode(p) : p));
      const end = Date.now() + timeoutMs;
      let from = 0;
      for (;;) {
        const b = this.rx;
        for (let i = from; i < b.length; i++) {
          for (const p of list) {
            if (i + 1 >= p.length) {
              let ok = true;
              for (let k = 0; k < p.length; k++) if (b[i + 1 - p.length + k] !== p[k]) { ok = false; break; }
              if (ok) { this.rx = b.slice(i + 1); return b.slice(0, i + 1); }
            }
          }
        }
        from = b.length;
        const left = end - Date.now();
        if (left <= 0) throw new Error("timeout waiting for the board (" + dec.decode(b.slice(-80)).trim() + ")");
        await this._wait(left);
      }
    }

    async write(data) { await this.io.write(typeof data === "string" ? enc.encode(data) : data); }

    async _tryRaw(ms) {
      await this.write("\r\x03\x03");
      await sleep(150);
      this.rx = new Uint8Array(0);
      await this.write("\r\x01");
      await this.readUntil("raw REPL; CTRL-B to exit\r\n", ms);
    }

    // a soft reset in the raw REPL: a clean interpreter
    async softReset() {
      await this.readUntil(">", 3000);
      await this.write("\x04");
      await this.readUntil("soft reboot\r\n", 3000);
      await this.readUntil("raw REPL; CTRL-B to exit\r\n", 8000);
    }

    async enterRaw() {
      try { await this._tryRaw(4000); return; } catch (e) { /* perhaps it is waiting for a block */ }
      await this.write(new Uint8Array(BLOCK + 2));        // completes a block, then says "the end"
      await sleep(500);
      await this._tryRaw(8000);
    }

    async execStart(code) {
      await this.readUntil(">", 5000);
      const b = enc.encode(code);
      for (let i = 0; i < b.length; i += 256) { await this.write(b.subarray(i, i + 256)); await sleep(8); }
      await this.write("\x04");
      const ok = await this.readUntil("OK", 5000);
      if (ok.length < 2) throw new Error("the board did not accept the code");
    }

    // the rest of a command's output and its error text
    async execEnd(timeoutMs) {
      const out = await this.readUntil("\x04", timeoutMs);
      const err = await this.readUntil("\x04", 5000);
      const e = dec.decode(err.slice(0, -1)).trim();
      if (e) throw new Error(e.split("\n").slice(-1)[0] + (e.includes("\n") ? "  [" + e.split("\n").slice(-2, -1)[0].trim() + "]" : ""));
      return dec.decode(out.slice(0, -1));
    }

    async exec(code, timeoutMs) {
      await this.execStart(code);
      return this.execEnd(timeoutMs || 10000);
    }

    // a line of the running command's output; throws its error if it ended
    async line(timeoutMs) {
      const b = await this.readUntil(["\n", "\x04"], timeoutMs);
      if (b[b.length - 1] === 4) {
        const err = await this.readUntil("\x04", 5000);
        throw new Error(dec.decode(err.slice(0, -1)).trim().split("\n").slice(-1)[0] || "the board stopped");
      }
      return dec.decode(b).trim();
    }

    _json(out) {
      const j = out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("J "));
      if (!j) throw new Error("no answer from the player: " + out.slice(-200));
      return JSON.parse(j.slice(2));
    }

    // cfg: { project, clock, probe, bitstream: { crc, bytes } or null,
    //        confirm(text) -> Promise<bool>: asked before a design that is
    //        running is replaced and before a bitstream file is overwritten }
    async connect(cfg) {
      const code = BOARD_PY.replace("%PROJECT%", cfg.project).replace("%CLOCK%", String(cfg.clock))
        .replace("%PROBE%", cfg.probe ? "True" : "False");
      const ask = cfg.confirm || (async () => true);
      await this.enterRaw();
      // what the board is running now, from the interpreter as it stands
      let running = "";
      try {
        const o = await this.exec("try:\n print('E', tt.shuttle.enabled)\nexcept Exception as e:\n print('E')\n", 5000);
        const m = /E <\w+ ([\w.]+)>/.exec(o) || /E (\w+)/.exec(o);
        if (m && m[1] !== "None") running = m[1];
      } catch (e) { /* no SDK objects yet */ }
      this.running = running;
      if (running && running !== cfg.project &&
          !(await ask("The board is running " + running + ". Replace it with " + cfg.project + "?"))) {
        throw new Error("left " + running + " running");
      }
      await this.softReset();
      let a = this._json(await this.exec(code, 30000));
      const bs = cfg.bitstream;
      if (a.fpga && bs && !(a.bit && a.bit[0] === bs.bytes.length && a.bit[1] === bs.crc)) {
        if (a.bit && !(await ask("The board already has a " + cfg.project + " bitstream that differs from this page's (" +
                                 a.bit[0] + " bytes). Overwrite it?"))) {
          bs.skipped = true;
        }
      }
      if (a.fpga && bs && !bs.skipped && !(a.bit && a.bit[0] === bs.bytes.length && a.bit[1] === bs.crc)) {
        this.log(a.bit ? "Updating the bitstream on the board"
                       : "The FPGA board has no " + cfg.project + " bitstream: uploading it");
        await this.execStart('putfile(BITFILE,' + bs.bytes.length + ')');
        let pos = 0;
        await this._feedBlocks((max) => { const b = bs.bytes.subarray(pos, pos + max); pos += b.length; return b; });
        await this.softReset();                           // the board lists its bitstreams when it starts
        a = this._json(await this.exec(code, 30000));
        if (!(a.bit && a.bit[1] === bs.crc)) throw new Error("the bitstream did not arrive intact");
        this.log("Bitstream uploaded (" + bs.bytes.length + " bytes)");
        a.uploaded = true;
      }
      if (!a.has) {
        throw new Error(a.fpga ? "the FPGA board has no bitstream for " + cfg.project + " and this page has none to send"
                               : "the chip on this board (" + a.run + ") has no project " + cfg.project);
      }
      const out = await this.exec("start()", 30000);
      for (const l of out.split("\n")) if (l.startsWith("storage:")) this.log(l.trim());
      this.info = Object.assign(a, this._json(out));
      return this.info;
    }

    async _guard(fn) {
      if (this.busy) throw new Error("the board is busy");
      this.busy = true; this.stopFlag = false; this.paused = false;
      try { return await fn(); } finally { this.busy = false; this.paused = false; this.playing = false; }
    }

    // answer the board's block requests from source(max) -> Uint8Array (empty: the end)
    async _feedBlocks(source, onSent, onLine) {
      let sent = 0, ended = false, late = 0;
      for (;;) {
        let l;
        try { l = await this.line(15000); } catch (e) {
          if (this.paused && /^timeout/.test(e.message)) continue;      // a paused board says nothing
          throw e;
        }
        if (l === "R") {
          while (this.paused) await sleep(20);                          // answered after the resume
          const blk = ended ? new Uint8Array(0) : source(BLOCK);
          if (!blk.length) ended = true;
          const msg = new Uint8Array(2 + blk.length);
          msg[0] = blk.length & 255; msg[1] = blk.length >> 8;
          msg.set(blk, 2);
          await this.write(msg);
          sent += blk.length;
          if (onSent) onSent(sent);
        } else if (l === "U") late++;
        else if (l === "DONE") break;
        else if (onLine) onLine(l);
      }
      await this.execEnd(5000);
      return { sent, late };
    }

    // stream: source(max) gives the next bytes; stop() makes the caller's source end
    play(rate, source, onSent) {
      return this._guard(async () => {
        await this.execStart("play(" + rate + ")");
        this.playing = true;
        return this._feedBlocks(source, onSent);
      });
    }

    save(store, addr, bytes, onSent) {
      return this._guard(async () => {
        let pos = 0, bad = -1;
        await this.execStart("save(" + store + "," + addr + "," + bytes.length + ")");
        const r = await this._feedBlocks((max) => { const b = bytes.subarray(pos, pos + max); pos += b.length; return b; },
          onSent, (l) => { if (l.startsWith("V ")) bad = parseInt(l.slice(2), 10); });
        if (bad !== 0) throw new Error(bad < 0 ? "no verify result" : bad + " blocks did not verify");
        return r;
      });
    }

    read(store, addr, n) {
      return this._guard(async () => {
        const out = await this.exec("rd(" + store + "," + addr + "," + n + ")", 10000);
        const h = out.split("\n").map((l) => l.trim()).find((l) => l.startsWith("H "));
        if (!h) throw new Error("read failed");
        const hex = h.slice(2), b = new Uint8Array(hex.length >> 1);
        for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(2 * i, 2), 16);
        return b;
      });
    }

    // the board plays from its storage; onPos(bytes read so far)
    playStored(store, addr, n, rate, onPos) {
      return this._guard(async () => {
        await this.execStart("splay(" + store + "," + addr + "," + n + "," + rate + ")");
        this.playing = true;
        let stopped = false, sentStop = false;
        for (;;) {
          if (this.stopFlag && !sentStop) { sentStop = true; await this.write("\x03"); }
          let l;
          try { l = await this.line(sentStop ? 3000 : 500); } catch (e) {
            if (/^timeout/.test(e.message) && !sentStop) continue;
            throw e;
          }
          if (l.startsWith("P ")) { if (onPos) onPos(parseInt(l.slice(2), 10)); }
          else if (l === "STOP") stopped = true;
          else if (l === "DONE") break;
        }
        await this.execEnd(5000);
        return { stopped };
      });
    }

    stop() { this.stopFlag = true; }

    // Pause what is playing: the board stops clocking codes out, and the
    // chip holds its output and its state until resume().
    async pause() {
      if (!this.playing || this.paused) return;
      this.paused = true;
      await this.write(new Uint8Array([0xff, 0xff]));
    }

    async resume() {
      if (!this.paused) return;
      await this.write(new Uint8Array([0xfe, 0xff]));
      this.paused = false;
    }
  }

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      c ^= bytes[i];
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  }

  return { Board, BLOCK, BOARD_PY, crc32 };
});
