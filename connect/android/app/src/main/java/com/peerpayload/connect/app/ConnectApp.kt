package com.peerpayload.connect.app

import android.app.Activity
import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.os.Bundle
import android.net.Network
import android.util.Log
import com.peerpayload.connect.core.ConnectNode
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.File

// The hosted Connect services (connect/render.yaml). The mailbox only ever
// sees sealed envelopes and the relay only TLS ciphertext.
const val MAILBOX_URL = "https://peerpayload-connect-mailbox.onrender.com"
const val RELAY_URL = "wss://peerpayload-connect-relay.onrender.com/v1/connect"

/**
 * Owns the one ConnectNode for the process. The mailbox connection lives as
 * long as the process does; ConnectService keeps the process alive while a
 * transfer runs or "Stay ready to receive" is on (otherwise Android ends it
 * some time after the app leaves the screen).
 */
class ConnectApp : Application() {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    lateinit var node: ConnectNode
        private set

    lateinit var notifications: ConnectNotifications
        private set

    private val prefs by lazy { getSharedPreferences("settings", Context.MODE_PRIVATE) }

    private val _readyToReceive = MutableStateFlow(false)

    /** "Stay ready to receive": keep listening for offers in the background. */
    val readyToReceive: StateFlow<Boolean> = _readyToReceive.asStateFlow()

    fun setReadyToReceive(on: Boolean) {
        prefs.edit().putBoolean(KEY_READY, on).apply()
        _readyToReceive.value = on

        if (on)
            ConnectService.start(this)
    }

    // Activities started and not stopped: > 0 means the app is on screen,
    // where offers already show as a banner.
    private var visible = 0
    val onScreen get() = visible > 0

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

        notifications = ConnectNotifications(this)
        _readyToReceive.value = prefs.getBoolean(KEY_READY, false)
        trackVisibility()
        watchTransfers()

        if (_readyToReceive.value)
            ConnectService.start(this)
    }

    private fun trackVisibility() = registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
        override fun onActivityStarted(activity: Activity) { visible++ }
        override fun onActivityStopped(activity: Activity) { visible-- }
        override fun onActivityCreated(activity: Activity, state: Bundle?) {}
        override fun onActivityResumed(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {}
    })

    // Reacts to transfers changing state:
    //   - a transfer starts, or this device's offer goes out: start the
    //     service, so switching apps doesn't stop it
    //   - an offer arrives while the app isn't on screen: notify, with
    //     Accept / Decline; the notification goes once it's answered
    //   - a transfer to this device finishes off screen: notify
    private fun watchTransfers() = scope.launch {
        var before = emptyMap<String, String>()
        var serviceWanted = false

        node.transfers.collect { list ->
            val now = list.associate { it.transferId to it.state }
            val wanted = needsTransferService(list)

            if (wanted && !serviceWanted)
                ConnectService.start(this@ConnectApp)

            serviceWanted = wanted

            for (t in list) {
                val was = before[t.transferId]

                if (t.direction == "in" && t.state == "offered" && was != "offered" && !onScreen)
                    notifications.showOffer(t)

                if (was == "offered" && t.state != "offered")
                    notifications.cancelOffer(t.transferId)

                if (t.direction == "in" && t.state == "complete" && was != null && was != "complete" && !onScreen)
                    notifications.showReceived(t)
            }

            for (id in before.keys - now.keys)
                notifications.cancelOffer(id)

            before = now
        }
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

    private companion object {
        const val KEY_READY = "readyToReceive"
    }
}
