# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue or pull
request:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**. This opens a private advisory that
   only you and the maintainer can see.

Include what's affected (Connect desktop, Connect Android, Enterprise
backend, relay, mailbox, engine), the version or commit, steps to
reproduce, and what an attacker gains.

You'll get a reply within 7 days. Once a fix is released, the advisory is
published with credit to you, unless you'd rather stay anonymous.

## Supported versions

PeerPayload is maintained by one person, so fixes go into the latest
release of each app and the `main` branch only:

| Component | Supported |
|---|---|
| PeerPayload Connect (desktop, Android) | Latest release |
| PeerPayload Enterprise (desktop, CLI, backend) | Latest release |
| Relay and mailbox | `main` |

## Scope

In scope: anything that lets someone read, change or forge files,
messages, keys or accounts; pair with or send to a device without its
owner's consent; impersonate a device, user or server; or run code on a
user's machine.

What the design deliberately doesn't protect against, such as the metadata
the relay and mailbox can see, is described in
[docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md). Reports showing that the
code doesn't match that document are very welcome.

Please don't run tests against the hosted services that degrade them for
other people (load tests, flooding). Run your own copy instead: see
[docs/CONNECT.md](docs/CONNECT.md) and [docs/ENTERPRISE.md](docs/ENTERPRISE.md).
