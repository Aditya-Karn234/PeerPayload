# PeerPayload Connect

The consumer edition of PeerPayload, alongside the organisation tool
([PeerPayload Enterprise](ENTERPRISE.md)). No accounts and no backend: each
device makes its own key on first run, people add each other with a
one-time invite link or QR code, and files go device to device over mutual
TLS with those keys, directly or through the relay.

- `connect/core/`: everything a Connect device does (`createConnectNode`);
  the desktop app is a UI over it.
- `connect/mailbox/`: store-and-forward for the small encrypted messages
  (pairing, transfer offers) between devices that aren't both online. It
  can't read them or forge them. Messages are kept in memory, or in SQLite
  with `MAILBOX_DB=<file>` so they survive a restart.
- `connect/desktop/`: the Electron app (0.2.5).
- `connect/android/`: the Android app (0.1.3, Android 8+), described
  [below](#android).

## Running it from source

To try it on one machine with two devices:

```sh
cd connect/mailbox && npm start                      # mailbox on :4300
cd connect/desktop && npm install && npm run build
CONNECT_USER_DATA=/tmp/alice PEERPAYLOAD_MAILBOX=http://localhost:4300 npx electron .
CONNECT_USER_DATA=/tmp/bob   PEERPAYLOAD_MAILBOX=http://localhost:4300 npx electron .
```

`npm run test:ui` in `connect/desktop` drives two app windows through
setup, pairing and a transfer.

## How it behaves

The desktop app runs in the tray: closing the window keeps it receiving, offers
and finished transfers show as notifications, and it can start when you
sign in (tray menu, installed app only). On Windows the installed app
opens `peerpayload://pair` links (from a browser, email or chat) on
Devices with the link filled in. It's only added once you click Add device.

Transfers can be paused from either side and resumed from either side,
even after both apps restart. Each incoming transfer goes to its own
staging folder (`<downloads>/.incoming/<id>`) and its files only move into
the downloads folder once complete. History (the last 200 transfers) is
saved in `<identity dir>/transfers.json`. A transfer that was running when
the app stopped comes back as "interrupted".

How a transfer connects, in order:

1. **Direct:** the sender connects to the receiver's addresses.
2. **Reversed:** if it can't (a firewall, mobile data, a laptop's own
   hotspot), it asks the receiver to dial out to it instead. A one-time key
   in the encrypted offer authenticates the dial. Older apps ignore the
   request and the sender moves on after 8 s.
3. **Relay:** the slowest option, limited by the slower side's upload.
   Both apps show a hint under relayed transfers explaining why it happened
   and what to change.

The engines' pinned mutual TLS runs end to end on all three paths: the
reversed and relay paths go through local bridges, so the engines never
see the difference.

## Hosted services

Hosted services (Render free plan, `connect/render.yaml`, from `main`)
are the app's defaults; either can be changed in Settings:

- mailbox: `https://peerpayload-connect-mailbox.onrender.com`
- relay: `wss://peerpayload-connect-relay.onrender.com/v1/connect`

On the free plan they sleep after 15 minutes idle (about a minute to
wake), and the mailbox keeps undelivered messages in memory only, so a
restart drops them.

## Speed

Direct transfers on a network run at about 130 MiB/s on one
machine (1 MiB chunks; the engine's 64 KiB default managed 12-17 MiB/s).
Between networks the limit is the internet connections themselves,
usually the sender's upload: a relayed test ran at 0.23-0.37 MiB/s,
matching that test machine's own ~3 Mbit/s upload, so the relay's
capacity wasn't what was measured.

## Android

A native Kotlin app (Jetpack Compose, minSdk 26, targetSdk 35) that speaks
the same protocol as the desktop app. It runs the same C++ engine,
`libpeerpayload.so`, through a JNI bridge (`engine/jni/`). The protocol,
mailbox client, relay and reverse bridges, and the transfer manager are
Kotlin ports of the JavaScript ones.

- Pairing: show an invite QR or link, scan one with the in-app scanner
  (CameraX + ZXing; it reads only `peerpayload://pair` codes), or paste a
  link. Tapping a pairing link opens the app.
- Sending: pick files from a contact, or Share from any other app. Both go
  through a review step (files, total size, recipient) before anything is
  sent.
- Receiving: offers show as a banner on every tab. Received files go to
  `Downloads/PeerPayload`.
- Running transfers show speed and time left, and can be paused, resumed
  or removed as on the desktop.

Building it, from `connect/android`:

```sh
# 1. The engine for arm64-v8a and x86_64 (NDK r27c, static OpenSSL), in Docker.
#    Rerun after engine or JNI changes; the .so files are git-ignored.
docker run --rm -v "<repo>:/src" -v pp-android-cache:/cache \
  debian:bookworm bash /src/connect/android/engine/build-engine.sh

# 2. The app, with JDK 17 and Gradle 8.11.1
gradle :app:assembleDebug        # or :app:assembleRelease
gradle :app:testDebugUnitTest    # then: node tools/check-kotlin.js
```

Release builds are signed only when `signing/keystore.properties` is
present. That folder is git-ignored. Keep a backup of it somewhere else:
without the key, no update can be installed over an APK that's already
been shared. R8 shrinking keeps the APK at about 19 MB.

Interop is tested both ways. `VectorsTest` checks the Kotlin code against
vectors from the JavaScript reference (`tools/make-vectors.js`), and
`tools/check-kotlin.js` opens envelopes sealed by Kotlin with the
JavaScript code. Tested on a Galaxy A14 5G (Android 15) against the
desktop app: pairing and transfers both ways over the same Wi-Fi, the
laptop's hotspot (reversed) and the relay.

## Not done yet

No messaging, multi-device or revocation; no iOS. How Connect protects
files and keys, and what it doesn't protect against, is in
[the security model](SECURITY_MODEL.md).
