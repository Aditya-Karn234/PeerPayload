# PeerPayload: open-source launch decisions

Decisions made while open-sourcing PeerPayload and preparing PeerPayload
Connect's first public release, with the reasoning at the time. Newest last.
A decision that changes later gets a new entry that says what it replaces;
old entries stay.

Moves to `docs/DECISIONS.md` on `main` in Phase 1.

## Phases

| Phase | What | Status |
|---|---|---|
| 0 | Decisions: repository, license, hosting, signing, builds | Done 2026-11-10 |
| 1 | Open-source ready: license (done), one `main` with both products, README, security policy, security model, security pass | In progress |
| 2 | Three real builds (Android APK, Windows EXE, Linux AppImage) and a release workflow | Not started |
| 3 | First public release, checksums, verification steps, download tracking, landing page | Not started |
| 4 | Launch: demo, hosting upgrade, r/SideProject first, then wider | Not started |
| 5 | Later: Google Play, F-Droid, Flathub, more connection options | Not started |

## Decisions

### D1. A separate public repository, with filtered history (2026-11-10, replaced by D6)

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

### D6. The whole repository is open source, both products (2026-11-10)

Replaces D1. The existing repository, `Aditya-Karn234/PeerPayload`, was made
public with its full history: PeerPayload Connect and PeerPayload Enterprise
together. There is no separate Connect repository and no history filtering.

Why: the aim is to open-source the project completely, not only Connect.

Checked when it went public: a scan of the full history found no real
credentials. Every match was test data (throwaway keys and tokens in test
vectors and tests) or the local-only development database password in
`backend/.env.example` and `docker-compose.yml`. The live services don't
depend on any secret in the code: the Enterprise relay secret is generated by
Render and kept in its settings, Enterprise sessions are random tokens stored
in the database, and the Connect relay has no shared secret (it accepts only
tickets signed by a device's own key).

### D7. Apache-2.0 for the whole repository, added at once (2026-11-10)

Extends D2 from Connect to everything, Enterprise included. `LICENSE` and
`NOTICE` were added to `main` and `connect-foundation` on the day the
repository was found public without a license, since until then nobody could
legally reuse the code. Per-package `license` fields and full third-party
notices follow in Phase 1.

### D8. One `main` branch with both products (2026-11-10)

`connect-foundation` is merged into `main` in Phase 1, so the default branch
has both products and one README covers both. Render's Connect mailbox and
relay switch to deploy from `main`, and `connect-foundation` is retired.

Why: visitors land on `main`, which until now held only Enterprise.
`connect-foundation` already contains everything Enterprise has (as
equivalent commits), so merging it loses nothing. All tests run before the
merge is pushed.

Done 2026-11-10. Found while merging: Enterprise's backend and relay on
Render set `rootDir`, but now depend on `protocol/` outside it, and Render
makes nothing outside a service's `rootDir` available. Both now build and
start from the repository root (`cd backend && ...`), as Connect's services
already did. Checked with a fresh clone running the same commands.
