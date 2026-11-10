# Security model

What PeerPayload protects, how, and what it doesn't protect against. This
describes the code in this repository. It has not been independently
audited. If you find something here that the code doesn't live up to,
please report it as described in [SECURITY.md](../SECURITY.md).

## PeerPayload Connect

### Device identity

Each device creates its own identity on first run, and the keys never
leave it:

- an **Ed25519 signing key** with a self-signed certificate. The SHA-256
  fingerprint of that certificate is the device's ID;
- an **X25519 key** that other devices encrypt messages to.

There are no accounts, and no server issues, holds or vouches for keys.

Where the keys are stored:

- **Desktop:** in the app's data folder. On Linux the files are created
  readable by the owner only (mode 600). On Windows that mode has no effect,
  and the files are protected only by the user profile's normal permissions.
- **Android:** in app-private storage. Android backup is turned off for the
  app, so the keys aren't copied into device or cloud backups.

Anyone who can read those files (another program running as you, malware,
someone with your unlocked device) can act as that device.

### Pairing

Device A creates an invite: a `peerpayload://pair#...` link or the same
link as a QR code. It contains A's contact card (name, ID, certificate,
X25519 key), a random 16-byte secret, A's mailbox address and an expiry
(24 hours by default). A keeps only a hash of the secret.

Device B opens the link and sends A a pair request carrying the secret
and B's own card. A accepts it only if the secret matches an unexpired,
unused invite. Each invite works once. Both apps then show the same
**safety code**, derived from both device IDs. Compare it in person or on a
call to rule out a swapped link.

The invite link is a credential. Until it's used or expires, whoever holds
it can pair with your device. Share it the way you'd share a one-time
password. The part after `#` is never sent to a web server if the link is
opened in a browser.

### Messages through the mailbox

Pair requests, transfer offers and answers are small messages (at most
32 KiB) that go through the mailbox, so they arrive even if the other
device is offline. Each message is:

- **encrypted** to the recipient's X25519 key: a fresh ephemeral key per
  message, ECDH, HKDF-SHA256, then AES-256-GCM. Sender, recipient, message
  ID and time are bound into the authentication tag;
- **signed** with the sender's Ed25519 key over every field.

The mailbox checks the signature before storing a message and drops forged
ones. It can't read the content. A device collects its messages with a
short-lived token (at most 15 minutes) signed by its own key, so only that
device can collect them. Undelivered messages are deleted after 7 days.

### File transfers

The engine moves the files over **mutual TLS** (TLS 1.2 minimum; the two
engines negotiate TLS 1.3). Each side presents its device certificate and
accepts only the paired device's certificate, by fingerprint. Each
transfer also has a random token, exchanged inside the encrypted offer.
Every chunk is checked against its SHA-256 hash before it's written.

A transfer takes the first of these that works:

1. **Direct:** the sender connects to the receiver. The receiver listens on
   one port, on all of its network interfaces, only while a transfer it has
   accepted is waiting or running. It refuses any certificate but the
   paired sender's, and stops listening after a timeout.
2. **Reversed:** the receiver dials out to the sender. The dialer must first
   present a one-time 32-byte key that was only ever sent inside the
   encrypted offer. Without it, the connection is dropped before it reaches
   the engine.
3. **Relay:** both sides connect out to the relay, which pairs them and
   forwards bytes. Each side proves which device it is with a ticket signed
   by its own key, and the relay only pairs two devices that name each
   other. The mutual TLS session runs end to end through the relay, so the
   relay only ever forwards ciphertext and can't stand in for either side.

Only paired devices can make offers: messages from any other device are
dropped. Nothing is received until the user accepts the offer. The one
exception is resuming a paused or interrupted transfer, which continues
one the user already accepted without asking again.

### What the servers can see

The mailbox and relay can't read files or messages. They do see
**metadata**:

- **Mailbox:** which device IDs message each other, when, how big each
  message is, and the devices' IP addresses.
- **Relay:** the IP addresses and device IDs of relayed transfers, when they
  happen, how long they take and how many bytes pass.

Either server can also drop or delay traffic, so a hostile or broken one
can stop pairing or transfers, but it can't forge or read them. The
project's hosted mailbox and relay run on Render. You can run your own
(`connect/mailbox/`, `relay/`) and point the apps at it in Settings.

### Not protected against

- **A compromised device**, or anyone who can read its key files (see
  above).
- **A paired device you no longer trust.** There is no revocation yet:
  remove the contact on your side, and it can't send to you, but its old
  copy of your card still exists.
- **Metadata** visible to the mailbox, the relay and your network, as
  listed above.
- **Denial of service.** The servers cap connections per IP address, but
  the free-plan hosted services are easy to overload.
- **Files after they arrive.** Received files are stored unencrypted, in
  the downloads folder (desktop) or `Downloads/PeerPayload` (Android).
- **A source file changed during a paused transfer.** Resume only checks
  the file's size and chunk size. If a file is edited between a pause and
  its resume but stays the same size, the result mixes old and new bytes
  without an error.

## PeerPayload Enterprise

Enterprise trusts its backend, run by the organisation:

- **Accounts:** created by an admin, no self-registration. Passwords are
  hashed with bcrypt (cost 12). Failed logins are rate limited per IP
  address and username, in memory per backend process.
- **Sessions:** random tokens stored in the database, so an admin
  deactivating an account ends its sessions at once.
- **Transfers:** the receiver makes a throwaway certificate for each
  transfer, and its fingerprint reaches the sender through the backend.
  The sender pins it, so nobody on the network can stand in for the
  receiver. But a compromised backend could substitute its own
  fingerprint.
- **Relay:** access by short-lived tickets the backend signs with a secret
  shared only with the relay. The relay forwards TLS ciphertext.
- **The backend never sees file contents.** It records what was sent, to
  whom and whether it finished. Those records are reported by the clients
  themselves, so they aren't tamper-proof.

## The engine on its own

Run directly (`sender`, `receiver`) without `--pin-sha256`, the sender
accepts any certificate: the connection is encrypted, but the receiver
isn't authenticated. Both apps always pin. See [ENGINE.md](ENGINE.md)
for the flags.
