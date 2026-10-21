package com.peerpayload.connect.app

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.peerpayload.connect.core.Contact
import com.peerpayload.connect.core.InviteLink
import com.peerpayload.connect.core.NodeStatus
import com.peerpayload.connect.core.Transfer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// What the screens see and can do. Every action reports failure as a
// one-line [message] instead of throwing into the UI.
class ConnectViewModel(app: Application) : AndroidViewModel(app) {
    private val connect = app as ConnectApp
    private val node = connect.node

    val status: StateFlow<NodeStatus> = node.status
    val contacts: StateFlow<List<Contact>> = node.contactList
    val transfers: StateFlow<List<Transfer>> = node.transfers
    val paired: MutableStateFlow<Contact?> = node.paired

    /** A short note for the snackbar (errors, confirmations). */
    val message = MutableStateFlow<String?>(null)
    val busy = MutableStateFlow(false)

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

    fun send(fp: String, uris: List<Uri>) = act {
        val dir = connect.outgoingDir()
        val files = withContext(Dispatchers.IO) { copyPicked(getApplication(), uris, dir) }

        try {
            node.send(fp, files, dir)
        } catch (e: Exception) {
            dir.deleteRecursively()
            throw e
        }
    }

    fun accept(id: String) = quick { node.accept(id) }
    fun decline(id: String) = quick { node.decline(id) }
    fun cancelOffer(id: String) = quick { node.cancelOffer(id) }
    fun pause(id: String) = quick { node.pause(id) }
    fun resume(id: String) = quick { node.resume(id) }
    fun forget(id: String) = quick { node.forget(id) }
    fun clearFinished() = quick { node.clearFinished() }
}
