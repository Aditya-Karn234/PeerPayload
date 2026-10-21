const fs = require("fs");
const path = require("path");

const { verifyCard } = require("./identity");
const { hashSecret } = require("./pairing");

// Local contact list and pending invites, in <identity dir>/contacts.json.
// Contacts are stored as the verified cards exchanged during pairing; the
// device ID (fingerprint) is the key. Invites are stored only as the hash
// of their secret, so a copy of this file can't be used to pair.
//
// status: "pending" — we opened their link and sent a pair request, no
//                     answer yet (we already have their verified card);
//         "paired"  — both sides hold each other's card.
function openContacts(dir) {
  const file = path.join(dir, "contacts.json");
  let data = { contacts: {}, invites: {} };

  if (fs.existsSync(file))
    data = JSON.parse(fs.readFileSync(file, "utf8"));

  function save() {
    const tmp = `${file}.tmp`;

    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  }

  const publicView = (c) => c && { fp: c.card.fp, name: c.card.name, status: c.status, addedAt: c.addedAt };

  return {
    list() {
      return Object.values(data.contacts).map(publicView).sort((a, b) => a.name.localeCompare(b.name));
    },

    get(fp) {
      return publicView(data.contacts[fp]) ?? null;
    },

    // The verified card (with key objects) for sending to / checking a contact.
    card(fp) {
      const entry = data.contacts[fp];

      return entry ? verifyCard(entry.card) : null;
    },

    // Adds or updates a contact from a card. Never downgrades "paired".
    upsert(card, status) {
      verifyCard(card);

      const strip = ({ v, name, fp, cert, box }) => ({ v, name, fp, cert, box });
      const existing = data.contacts[card.fp];

      data.contacts[card.fp] = {
        card: strip(card),
        status: existing?.status === "paired" ? "paired" : status,
        addedAt: existing?.addedAt ?? new Date().toISOString(),
      };
      save();

      return publicView(data.contacts[card.fp]);
    },

    remove(fp) {
      const existed = Boolean(data.contacts[fp]);

      delete data.contacts[fp];
      save();

      return existed;
    },

    addInvite({ secretHash, expiresAt }) {
      data.invites[secretHash] = { expiresAt, usedBy: null };
      save();
    },

    // Single use: true (and marks it used) only for an unused, unexpired
    // invite whose secret matches.
    consumeInvite(secret, byFp, now = Date.now()) {
      const invite = data.invites[hashSecret(secret)];

      if (!invite || invite.usedBy || invite.expiresAt < now)
        return false;

      invite.usedBy = byFp;
      save();

      return true;
    },

    pendingInvites(now = Date.now()) {
      return Object.values(data.invites).filter((i) => !i.usedBy && i.expiresAt >= now).length;
    },
  };
}

module.exports = { openContacts };
