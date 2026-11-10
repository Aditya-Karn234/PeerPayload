package com.peerpayload.connect.core

import com.peerpayload.connect.protocol.Card
import com.peerpayload.connect.protocol.VerifiedCard
import com.peerpayload.connect.protocol.verifyCard
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import java.io.File
import java.security.MessageDigest

// Local contact list and pending invites (connect/core/contacts.js), in
// <identity dir>/contacts.json. Contacts are the verified cards exchanged
// during pairing, keyed by device ID. Invites are stored only as the hash
// of their secret, so a copy of this file can't be used to pair.
//
// status "pending": we opened their link and sent a pair request, no answer
// yet; "paired": both sides hold each other's card. While pending, the
// invite's secret and expiry are kept so the request can be sent again
// until it's answered.

@Serializable
data class PendingPairing(val secret: String, val expiresAt: Long)

@Serializable
data class StoredContact(val card: Card, val status: String, val mailbox: String? = null, val addedAt: Long, val pairing: PendingPairing? = null)

@Serializable
private data class StoredInvite(val expiresAt: Long, val usedBy: String? = null)

@Serializable
private data class ContactsFile(
    val contacts: MutableMap<String, StoredContact> = mutableMapOf(),
    val invites: MutableMap<String, StoredInvite> = mutableMapOf(),
)

data class Contact(val fp: String, val name: String, val status: String, val mailbox: String?, val addedAt: Long, val safetyCode: String)

fun hashSecret(secret: String): String =
    MessageDigest.getInstance("SHA-256").digest(secret.toByteArray()).joinToString("") { "%02x".format(it) }

class Contacts(dir: File, private val ownFingerprint: String) {
    private val file = File(dir, "contacts.json")
    private val data: ContactsFile =
        if (file.isFile) runCatching { store.decodeFromString<ContactsFile>(file.readText()) }.getOrElse { ContactsFile() } else ContactsFile()

    @Synchronized private fun save() = writeAtomically(file, store.encodeToString(data).toByteArray())

    private fun view(c: StoredContact) =
        Contact(c.card.fp, c.card.name, c.status, c.mailbox, c.addedAt, com.peerpayload.connect.protocol.safetyCode(ownFingerprint, c.card.fp))

    @Synchronized fun list(): List<Contact> = data.contacts.values.map(::view).sortedBy { it.name.lowercase() }

    @Synchronized fun get(fp: String): Contact? = data.contacts[fp]?.let(::view)

    /** The verified card, for sending to / checking a contact. */
    @Synchronized fun card(fp: String): VerifiedCard? = data.contacts[fp]?.let { verifyCard(it.card) }

    /** Adds or updates a contact. Never downgrades "paired"; keeps the known mailbox unless a new one is given. */
    @Synchronized fun upsert(card: Card, status: String, mailbox: String? = null, pairing: PendingPairing? = null): Contact {
        verifyCard(card)

        val existing = data.contacts[card.fp]
        val finalStatus = if (existing?.status == "paired") "paired" else status
        val entry = StoredContact(
            card = card,
            status = finalStatus,
            mailbox = mailbox ?: existing?.mailbox,
            addedAt = existing?.addedAt ?: System.currentTimeMillis(),
            pairing = if (finalStatus == "paired") null else pairing ?: existing?.pairing,
        )

        data.contacts[card.fp] = entry
        save()

        return view(entry)
    }

    /** Pair requests still waiting for an answer (unexpired): fp to pairing. */
    @Synchronized fun pendingPairings(now: Long = System.currentTimeMillis()): List<Pair<String, PendingPairing>> =
        data.contacts.values
            .filter { it.status == "pending" && it.pairing != null && it.pairing.expiresAt >= now }
            .map { it.card.fp to it.pairing!! }

    @Synchronized fun remove(fp: String): Boolean {
        val existed = data.contacts.remove(fp) != null

        save()

        return existed
    }

    @Synchronized fun addInvite(secretHash: String, expiresAt: Long) {
        data.invites[secretHash] = StoredInvite(expiresAt)
        // Forget long-expired ones.
        data.invites.entries.removeAll { it.value.expiresAt < System.currentTimeMillis() - 7L * 24 * 3600 * 1000 }
        save()
    }

    /** Single use: true (and marks it used) only for an unused, unexpired invite whose secret matches. */
    @Synchronized fun consumeInvite(secret: String, byFp: String, now: Long = System.currentTimeMillis()): Boolean {
        val key = hashSecret(secret)
        val invite = data.invites[key]

        if (invite == null || invite.usedBy != null || invite.expiresAt < now)
            return false

        data.invites[key] = invite.copy(usedBy = byFp)
        save()

        return true
    }
}
