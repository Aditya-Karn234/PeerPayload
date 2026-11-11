# Releasing PeerPayload Connect

Releases are built by GitHub Actions (`.github/workflows/release.yml`) from
a tag, for Android, Windows and Linux, with one version for all three.
The workflow creates a **draft**: nothing is public until it's published by
hand. Enterprise isn't released here (docs/DECISIONS.md D15).

## Once: the Android signing secrets

The APK is signed with the release key in `connect/android/signing/` (never
committed). The workflow gets it from two repository secrets. To add them,
on the machine that has the key, in PowerShell:

```powershell
cd <repo>\connect\android\signing
# 1. Copies the keystore (base64) to the clipboard. Nothing is printed.
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\peerpayload-connect-release.jks")) | Set-Clipboard
```

On GitHub: Settings › Secrets and variables › Actions › New repository
secret. Name `CONNECT_ANDROID_KEYSTORE_B64`, paste, Add secret. Then:

```powershell
# 2. Copies keystore.properties (base64) to the clipboard.
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\keystore.properties")) | Set-Clipboard
```

New secret `CONNECT_ANDROID_PROPERTIES_B64`, paste, Add secret. Then clear
the clipboard (copy anything else). GitHub stores secrets encrypted and
never shows them again; the workflow deletes the key from the build machine
when it's done, and refuses an APK not signed with the expected
certificate (SHA-256 `b91712ae…2f8e44`).

The encrypted offline backup of the key stays the master copy.

## Each release

1. Set the same version in `connect/desktop/package.json` (`npm version
   X.Y.Z --no-git-tag-version` in `connect/desktop`) and in
   `connect/android/app/build.gradle.kts` (`versionName`, and raise
   `versionCode` by one). Update the version in `README.md` and
   `docs/CONNECT.md`. Commit and push to `main`; wait for the tests to pass.
2. Tag and push:

   ```sh
   git tag connect-vX.Y.Z
   git push origin connect-vX.Y.Z
   ```

   The workflow stops at once if the tag and the two versions differ.
3. When it finishes (about 30-45 minutes), open Releases on GitHub: there's
   a draft with the APK, the Windows installer, the AppImage,
   `SHA256SUMS.txt` and a build attestation for each file.
4. Download the three files and try them (install over the previous
   version; pair; send a file each way).
5. Edit the draft's notes (what changed), then **Publish release**.

To withdraw a bad release: unpublish or delete it on GitHub, fix, and
release a new version. Don't reuse a version number: Android won't install
the same `versionCode` twice as an update.

## Checking a published file

```sh
sha256sum -c SHA256SUMS.txt --ignore-missing
gh attestation verify PeerPayload-Connect-X.Y.Z-android.apk --repo Aditya-Karn234/PeerPayload
```
