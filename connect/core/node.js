const { EventEmitter } = require("events");

const { makeMessage, parseMessage } = require("peerpayload-protocol");

const { createIdentity, loadIdentity, hasIdentity, contactCard, safetyCode } = require("./identity");
const { seal } = require("./envelope");
const { createInvite, parseInvite } = require("./pairing");
const { openContacts } = require("./contacts");
const { postEnvelope, createMailboxClient } = require("./mailboxClient");
const { createTransferManager } = require("./transfers");

// One Connect device: identity, contacts, pairing, mailbox connection and
// transfers, wired together. Apps (desktop now, Android later) are a UI
// over this; nothing here knows about Electron.
//
//   dir        where this device keeps its identity and contacts
//   keygenPath the engine's ppkeygen, to create the identity
//   engine     { senderPath, receiverPath }
//   mailboxUrl where this device collects messages (http(s)://...)
//   relayUrl   ws(s)://.../v1/connect for transfers that can't go direct, or null
//
// Events (node.on):
//   "status"    { connected }                    mailbox connection changed
//   "contacts"  [contact, ...]                   contact list changed
//   "paired"    contact                          a pairing completed
//   "transfer"  transfer                         a transfer changed (see transfers.js)
//   "transfer-removed" transferId                one was deleted (forget)
//   "log"       message
// How often unanswered pair requests are sent again (and on every mailbox
// reconnect), until answered or the invite expires.
const PAIR_RETRY_MS = 60_000;

function createConnectNode({ dir, keygenPath, engine, mailboxUrl = null, relayUrl = null, pairRetryMs = PAIR_RETRY_MS }) {
  const events = new EventEmitter();
  let identity = null;
  let contacts = null;
  let client = null;
  let transfers = null;
  let connected = false;
  let pairTimer = null;

  const emit = (name, data) => events.emit(name, data);
  const log = (message) => emit("log", message);

  const contactView = (c) => c && { ...c, safetyCode: safetyCode(identity.fingerprint, c.fp) };
  const listContacts = () => contacts.list().map(contactView);
  const contactsChanged = () => emit("contacts", listContacts());

  function requireStarted() {
    if (!identity)
      throw new Error("this device has no identity yet");
  }

  // Contacts may collect their messages at a different mailbox from ours.
  function sendEnvelope(envelope) {
    const url = contacts.get(envelope.to)?.mailbox || mailboxUrl;

    if (!url)
      throw new Error("no mailbox configured");

    return postEnvelope(url, envelope);
  }

  function sendMessage(card, type, fields) {
    return sendEnvelope(seal({ identity, recipient: card, payload: makeMessage(type, fields) }));
  }

  async function handlePairing({ from, payload }) {
    const message = parseMessage(payload);

    if (!message)
      return;

    if (message.type === "pair-request") {
      if (message.card.fp !== from)
        return;

      const existing = contacts.get(from);

      // Already paired (e.g. our answer was lost): just answer again.
      if (existing?.status !== "paired") {
        if (!contacts.consumeInvite(message.secret, from))
          return log(`ignored a pair request from ${message.card.name}: invite unknown, used or expired`);

        contacts.upsert(message.card, "paired", { mailbox: message.mailbox });
        contactsChanged();
        emit("paired", contactView(contacts.get(from)));
      }

      await sendMessage(contacts.card(from), "pair-accept");
    } else if (message.type === "pair-accept") {
      const contact = contacts.get(from);

      // Only someone whose invite we answered can accept.
      if (contact?.status !== "pending")
        return;

      contacts.upsert(contacts.card(from), "paired");
      contactsChanged();
      emit("paired", contactView(contacts.get(from)));
    }
  }

  function pairRequest(secret) {
    return { secret, card: contactCard(identity), ...(mailboxUrl && { mailbox: mailboxUrl }) };
  }

  // The other device answers a repeated request again without needing the
  // invite twice (see handlePairing), so resending is harmless.
  function resendPairRequests() {
    for (const { fp, secret } of contacts.pendingPairings())
      sendMessage(contacts.card(fp), "pair-request", pairRequest(secret)).catch((err) => log(`pair request to ${fp.slice(0, 8)} not sent yet: ${err.message}`));
  }

  async function onEnvelope(opened) {
    if (!transfers.handleEnvelope(opened))
      await handlePairing(opened);
  }

  function start() {
    if (identity || !hasIdentity(dir))
      return;

    identity = loadIdentity(dir);
    contacts = openContacts(dir);
    transfers = createTransferManager({
      identity,
      contacts,
      sendEnvelope,
      engine,
      relayUrl,
      onUpdate: (t) => emit("transfer", t),
      onRemove: (transferId) => emit("transfer-removed", transferId),
      log,
    });

    if (mailboxUrl) {
      client = createMailboxClient({
        url: mailboxUrl,
        identity,
        onEnvelope,
        log,
        onStatus: (state, detail) => {
          if (detail)
            log(`mailbox: ${detail}`);

          if ((state === "connected") !== connected) {
            connected = state === "connected";
            emit("status", { connected });
          }

          if (state === "connected")
            resendPairRequests();
        },
      });
      client.start();
      pairTimer = setInterval(resendPairRequests, pairRetryMs);
      pairTimer.unref?.();
    }
  }

  function stop() {
    clearInterval(pairTimer);
    pairTimer = null;
    client?.stop();
    client = null;
    connected = false;
  }

  start();

  return {
    on: (name, fn) => events.on(name, fn),
    off: (name, fn) => events.off(name, fn),
    start,
    stop,
    // The network just came back: reconnect now rather than after the backoff.
    reconnectNow() {
      client?.reconnectNow();
    },

    status() {
      return {
        hasIdentity: Boolean(identity),
        name: identity?.name ?? null,
        fingerprint: identity?.fingerprint ?? null,
        mailboxUrl,
        relayUrl,
        connected,
      };
    },

    // Creates this device's identity (once) and starts it.
    setup(name) {
      if (identity || hasIdentity(dir))
        throw new Error("this device already has an identity");

      createIdentity({ dir, name, keygenPath });
      start();

      return this.status();
    },

    // A one-time link (24 h) for someone to add this device.
    createInvite({ ttlMs } = {}) {
      requireStarted();

      if (!mailboxUrl)
        throw new Error("set a mailbox first: the other device needs somewhere to reach you");

      const invite = createInvite(identity, { mailbox: mailboxUrl, ttlMs });

      contacts.addInvite(invite);

      return { link: invite.link, expiresAt: invite.expiresAt };
    },

    // Adds the device behind someone's invite link and asks it to pair.
    // The contact is "pending" until that device accepts.
    async addContact(link) {
      requireStarted();

      const invite = parseInvite(link);

      if (invite.card.fp === identity.fingerprint)
        throw new Error("that's this device's own invite link");

      // Kept until answered, so a request that's lost or can't be sent
      // right now goes again (resendPairRequests).
      contacts.upsert(invite.card, "pending", { mailbox: invite.mailbox, pairing: { secret: invite.secret, expiresAt: invite.expiresAt } });
      contactsChanged();

      await sendMessage(invite.card, "pair-request", pairRequest(invite.secret)).catch((err) =>
        log(`pair request not sent yet, will retry: ${err.message}`));

      return contactView(contacts.get(invite.card.fp));
    },

    contacts() {
      requireStarted();
      return listContacts();
    },

    removeContact(fp) {
      requireStarted();

      const removed = contacts.remove(fp);

      contactsChanged();

      return removed;
    },

    send(fp, paths) {
      requireStarted();
      return transfers.send(fp, paths);
    },
    accept(transferId, outputDir) {
      requireStarted();
      return transfers.accept(transferId, outputDir);
    },
    decline(transferId) {
      requireStarted();
      return transfers.decline(transferId);
    },
    cancelOffer(transferId) {
      requireStarted();
      return transfers.cancelOffer(transferId);
    },
    // Stops a running transfer on both sides; it can be resumed later.
    pause(transferId) {
      requireStarted();
      return transfers.pause(transferId);
    },
    // Picks up an interrupted transfer, from either side.
    resume(transferId) {
      requireStarted();
      return transfers.resume(transferId);
    },
    clearFinished() {
      requireStarted();
      return transfers.clearFinished();
    },
    // Deletes one transfer that isn't running (and any partly received
    // files); the other device is told, so it stops waiting to resume it.
    forget(transferId) {
      requireStarted();
      return transfers.forget(transferId);
    },
    transfers() {
      return transfers ? transfers.list() : [];
    },
  };
}

module.exports = { createConnectNode };
