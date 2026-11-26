# Micro ADPCM player

**Open it: https://kdp1965.github.io/uadpcm-player/** (Chrome or Edge on a computer)

A web page that turns a music file into a uADPCM stream and plays it through
[`tt_um_pettit_adpcm`](https://github.com/kdp1965/ttsky26e-um-pettit-adpcm), a streaming audio
decoder in a Tiny Tapeout micro tile, over Web Serial. Nothing is installed and nothing leaves
the computer: decoding, conversion and encoding all run in the browser.

- **Connect** to a Tiny Tapeout demo board. On the FPGA breakout the page uploads the design's
  bitstream if the board does not have it (it asks before replacing anything).
- **Drop a song** (mp3, m4a, wav, flac, ogg, or a `.ua` stream) or click one of the ready-made
  songs. Rate, channel, trimming, level, limiter and fades are settings on the page.
- **Play, pause, stop**, starting anywhere in the song.
- With a **Tiny Tapeout QSPI Pmod** on the `uio` port, **save songs** to its flash or PSRAM,
  and have the board play them on its own.

This repository is the published copy of the `web/` folder of
[ttsky26e-um-pettit-adpcm](https://github.com/kdp1965/ttsky26e-um-pettit-adpcm), where the
player is developed and where the chip, the codec and the protocol are documented
([web/README.md](https://github.com/kdp1965/ttsky26e-um-pettit-adpcm/blob/main/web/README.md)).
Changes are made there and copied here with `web/publish.sh`.

To run it locally: `python3 -m http.server 8000 --bind 127.0.0.1`, then open
`http://127.0.0.1:8000`.
