package com.peerpayload.connect.app

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import com.peerpayload.connect.core.ConnectNode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import java.io.File

// The hosted Connect services (connect/render.yaml). The mailbox only ever
// sees sealed envelopes and the relay only TLS ciphertext.
const val MAILBOX_URL = "https://peerpayload-connect-mailbox.onrender.com"
const val RELAY_URL = "wss://peerpayload-connect-relay.onrender.com/v1/connect"

/**
 * Owns the one ConnectNode for the process. v1 receives only while the app
 * is running: the mailbox connection lives as long as the process does,
 * and Android ends that some time after the app leaves the screen.
 */
class ConnectApp : Application() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    lateinit var node: ConnectNode
        private set

    override fun onCreate() {
        super.onCreate()

        node = ConnectNode(
            dir = File(filesDir, "identity"),
            incomingDir = File(getExternalFilesDir(null) ?: filesDir, "incoming"),
            mailboxUrl = MAILBOX_URL,
            relayUrl = RELAY_URL,
            scope = scope,
            deliver = { staging -> deliverToDownloads(this, staging) },
            log = { Log.i("PeerPayload", it) },
        )
        node.start()
        watchNetwork()
    }

    // Wi-Fi to mobile data, airplane mode off, hotspot changes: the mailbox
    // connection is then usually dead, so replace it straight away.
    private fun watchNetwork() {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        var current: Network? = null

        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                // The first call just reports the network we started on.
                if (current != null && current != network)
                    node.reconnectNow()

                current = network
            }
        })
    }

    /** Where picked files are copied before sending, one folder per send. */
    fun outgoingDir(): File = File(filesDir, "outgoing/${System.nanoTime()}")
}
