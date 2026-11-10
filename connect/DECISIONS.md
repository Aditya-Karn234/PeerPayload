# PeerPayload Connect: launch decisions

Decisions made while preparing Connect's first public release, with the
reasoning at the time. Newest last. A decision that changes later gets a new
entry that says what it replaces; old entries stay.

Moves to `docs/DECISIONS.md` in the public repository in Phase 1.

## Phases

| Phase | What | Status |
|---|---|---|
| 0 | Decisions: repository, license, hosting, signing, builds | Done 2026-11-10 |
| 1 | Safe to publish: public repo, license, security policy, security model, security pass | Not started |
| 2 | Three real builds (Android APK, Windows EXE, Linux AppImage) and a release workflow | Not started |
| 3 | First public release, checksums, verification steps, download tracking, landing page | Not started |
| 4 | Launch: demo, hosting upgrade, r/SideProject first, then wider | Not started |
| 5 | Later: Google Play, F-Droid, Flathub, more connection options | Not started |

## Decisions

### D1. A separate public repository, with filtered history (2026-11-10)

Connect is published as its own repository, `peerpayload-connect`, containing
only what Connect needs: `connect/`, `engine/`, `shared/`, `sender/`,
`receiver/`, `protocol/`, `relay/`, `packages/ui/` and `tools/`. Those paths
keep their commit history. The organisation edition (accounts, backend,
directory) stays private.

Why: the existing repository mixes the two products, and Connect lives on a
side branch. A Connect-only repository has one product, one README and one
default branch, and its history still shows how the code was built.

To do in Phase 1: scan the filtered history for secrets (gitleaks) before
publishing. Known in the history: throwaway test identities in the Android
interop vectors and a local-only development database password. Neither
grants access to anything, but both should be labelled or removed so scanners
and readers don't mistake them for leaks.

### D2. License: Apache-2.0 (2026-11-10)

Why: permissive, compatible with the bundled OpenSSL 3 (also Apache-2.0), and
it includes an explicit patent grant. Needs `LICENSE`, a `NOTICE` file, and
the third-party licenses of what's bundled in the apps (OpenSSL, Electron and
npm dependencies, CameraX, ZXing).

### D3. Hosting: free plan now, paid before a big launch (2026-11-10)

The mailbox and relay stay on Render's free plan for the first release and
the first small launch (r/SideProject). Before Show HN or wider promotion
they move to paid hosting (about $7-14 a month): a mailbox with a disk using
its SQLite storage (`MAILBOX_DB`), and the relay on a paid plan or a VPS.

Why: early traffic is small, and the free plan's limits (sleeps after 15
minutes idle, about a minute to wake; limited bandwidth; the in-memory
mailbox loses queued messages on restart) are acceptable if they're stated
plainly. A large launch would hit all of them at once.

Until the upgrade, the README lists these limits under known limitations.

### D4. Windows installer: unsigned for now (2026-11-10)

The Windows installer ships without a code-signing certificate. Windows
SmartScreen will show "Windows protected your PC" until enough people have
installed it. The install instructions explain that prompt honestly
("More info > Run anyway" for a file whose checksum and build attestation
you've verified). They never suggest turning off SmartScreen or antivirus.

Why: signing costs money and identity verification. Checksums and build
attestations (D5) still let anyone confirm the installer came from this
repository's source. Revisit once there are regular users: Azure Trusted
Signing or an open-source code-signing certificate.

### D5. Release builds in CI, Android key as a GitHub secret (2026-11-10)

Pushing a version tag (`v*`) builds all three apps on GitHub Actions from that
tag's source: the Android APK, the Windows installer and the Linux AppImage.
The workflow signs the APK with the release key stored as an encrypted GitHub
secret, writes `SHA256SUMS`, adds GitHub artifact attestations for every
file, and creates a draft release with notes.

Why: it's the strongest link between the public source code and the files
people download. Anyone can check that a file was built by this repository's
workflow from a specific commit.

Replaces: the earlier choice to keep secrets out of CI. The release key is
the only secret. A local, offline backup of it stays the source of truth:
without it, no update can be installed over an APK that has already been
shared.
