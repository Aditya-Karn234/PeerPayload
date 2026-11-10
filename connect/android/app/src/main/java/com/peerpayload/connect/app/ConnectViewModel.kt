package com.peerpayload.connect.app

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.peerpayload.connect.core.Contact
import com.peerpayload.connect.core.InviteLink
import com.peerpayload.connect.core.NodeStatus
import com.peerpayload.connect.core.Rate
import com.peerpayload.connect.core.RateMeter
import com.peerpayload.connect.core.Transfer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** A picked or shared document: its name and size, when the provider tells. */
data class PickedFile(val uri: Uri, val name: String, val size: Long?)

/** What's about to be sent, shown for review before anything is copied or offered. */
data class SendDraft(val files: List<PickedFile>, val recipient: String?)

// What the screens see and can do. Every action reports failure as a
// one-line [message] instead of throwing into the UI.
class ConnectViewModel(app: Application) : AndroidViewModel(app) {
    private val connect = app as ConnectApp
    private val node = connect.node
    private val meter = RateMeter()

    val status: StateFlow<NodeStatus> = node.status
    val contacts: StateFlow<List<Contact>> = node.contactList
    val transfers: StateFlow<List<Transfer>> = node.transfers
    val paired: MutableStateFlow<Contact?> = node.paired

    /** Speed / time left of running transfers, refreshed on progress and every second (so a stall shows). */
    val rates: StateFlow<Map<String, Rate>> = combine(transfers, flow { while (true) { emit(Unit); delay(1000) } }) { list, _ -> meter.update(list) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyMap())

    /** A short note for the snackbar (errors, confirmations). */
    val message = MutableStateFlow<String?>(null)
    val busy = MutableStateFlow(false)
    val draft = MutableStateFlow<SendDraft?>(null)

    private fun act(work: suspend () -> Unit) {
        viewModelScope.launch {
            busy.value = true
            try {
                work()
            } catch (e: Exception) {
                message.value = e.message ?: e.javaClass.simpleName
            } finally {
                busy.value = false
            }
        }
    }

    private fun quick(work: () -> Unit) = try {
        work()
    } catch (e: Exception) {
        message.value = e.message ?: e.javaClass.simpleName
    }

    fun setup(name: String) = act { withContext(Dispatchers.IO) { node.setup(name) } }

    fun createInvite(): InviteLink? = try {
        node.createInvite()
    } catch (e: Exception) {
        message.value = e.message
        null
    }

    fun addContact(link: String) = act {
        val contact = node.addContact(link)

        message.value = "Asked ${contact.name} to pair. It completes when their device answers."
    }

    fun removeContact(fp: String) = quick { node.removeContact(fp) }

    // ---- sending: pick (or share) -> review -> send ----

    private fun describe(uri: Uri): PickedFile {
        val name = displayName(getApplication(), uri)
        var size: Long? = null

        runCatching {
            getApplication<Application>().contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst() && !c.isNull(0))
                    size = c.getLong(0)
            }
        }

        return PickedFile(uri, name, size)
    }

    /** Adds documents to the draft (starting one if needed); [recipient] preselects who it's for. */
    fun addToDraft(uris: List<Uri>, recipient: String? = null) {
        if (uris.isEmpty())
            return

        viewModelScope.launch {
            val picked = withContext(Dispatchers.IO) { uris.map(::describe) }
            val current = draft.value
            val known = current?.files?.map { it.uri }?.toSet() ?: emptySet()

            draft.value = SendDraft(
                files = (current?.files ?: emptyList()) + picked.filter { it.uri !in known },
                recipient = recipient ?: current?.recipient,
            )
        }
    }

    fun removeFromDraft(uri: Uri) {
        val current = draft.value ?: return
        val files = current.files.filter { it.uri != uri }

        draft.value = if (files.isEmpty()) null else current.copy(files = files)
    }

    fun chooseRecipient(fp: String) {
        draft.value = draft.value?.copy(recipient = fp)
    }

    fun discardDraft() {
        draft.value = null
    }

    fun sendDraft() {
        val d = draft.value ?: return
        val fp = d.recipient ?: return

        draft.value = null
        act {
            val dir = connect.outgoingDir()
            val files = withContext(Dispatchers.IO) { copyPicked(getApplication(), d.files.map { it.uri }, dir) }

            try {
                node.send(fp, files, dir)
            } catch (e: Exception) {
                dir.deleteRecursively()
                throw e
            }
        }
    }

    // ---- transfers ----

    fun accept(id: String) = quick { node.accept(id) }
    fun decline(id: String) = quick { node.decline(id) }
    fun cancelOffer(id: String) = quick { node.cancelOffer(id) }
    fun pause(id: String) = quick { node.pause(id) }
    fun resume(id: String) = quick { node.resume(id) }
    fun forget(id: String) = quick { node.forget(id) }
    fun clearFinished() = quick { node.clearFinished() }
}
