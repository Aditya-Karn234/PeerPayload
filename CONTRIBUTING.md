# Contributing

Thanks for helping. The most useful things right now:

- **Testing Connect on your own devices**: pairing, transfers between
  different networks, phones on mobile data. Report what worked and what
  didn't, with the devices, OS versions and network setup.
- **Bug reports** with steps to reproduce.
- **Pull requests** for bugs and for the known limitations in the docs.

Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Reporting a bug

Open an issue with:

- which app and version (Connect desktop or Android, Enterprise desktop or
  CLI), and the OS;
- what you did, what you expected and what happened;
- for transfer problems: whether the transfer went direct, reversed or
  through the relay (the apps say so), and the two devices' network setup.

`node tools/diagnose.js` checks the engine, a loopback transfer and the
network on a desktop machine (it never prints the stored login token).

## Making a change

1. Fork the repository and create a branch from `main`.
2. Build and run the tests (see [README.md](README.md#building-and-testing)):

   ```sh
   npm test
   ```

   For Android changes, also run the unit tests and the interop check
   described in [docs/CONNECT.md](docs/CONNECT.md#android).
3. Add or update tests for what you changed. Engine behaviour is tested
   through the real `sender`/`receiver` programs in `tests/engine/`;
   Connect in `connect/core/test/`; wire formats in `protocol/test/`.
4. If you change a wire format in `protocol/`, the Android app's Kotlin
   port must change with it, and the vectors must be regenerated with
   `tools/make-vectors.js`.
5. Open a pull request saying what changed and why. CI runs every test
   suite on Windows and Linux; it has to pass.

## Style

Match the code around you: plain JavaScript (CommonJS), Kotlin with
Jetpack Compose, C++17. Comments explain why, not what. Commit messages
have a short summary line, then a body explaining the reason for the
change.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same as the rest of the project.
