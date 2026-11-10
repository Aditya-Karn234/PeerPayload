package com.peerpayload.connect.app

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import com.peerpayload.connect.core.Transfer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// Keeps the process, and with it the network, alive while the app isn't on
// screen. Android otherwise cuts a backgrounded app's network within
// seconds and may end the process, which stopped transfers whenever you
// switched apps. Runs while any of these holds, then stops itself:
//
//   - a transfer is moving bytes (sending or receiving)  -> dataSync
//   - an offer this device sent is waiting for an answer  -> dataSync
//   - "Stay ready to receive" is on (keeps the mailbox
//     connection, so offers arrive as notifications)     -> specialUse
//
// The node itself lives in ConnectApp; this only keeps it running.

/** What needs the service: bytes moving, or waiting to start moving them. */
fun needsTransferService(transfers: List<Transfer>) =
    transfers.any { it.state == "sending" || it.state == "receiving" || (it.direction == "out" && it.state == "offered") }

class ConnectService : Service() {
    private val app get() = application as ConnectApp
    private var watcher: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var lastUpdate = 0L
    private var lastShape: Any? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Started with startForegroundService, Android requires
        // startForeground within seconds, even if what asked for the service
        // has finished meanwhile (stopping without it crashes the app). So
        // always promote first; refresh then stops at once if not needed.
        val transfers = app.node.transfers.value
        val ready = app.readyToReceive.value

        if (!promote(app.notifications.service(transfers, ready), needsTransferService(transfers), ready))
            return START_NOT_STICKY

        refresh(transfers, ready, force = true)

        if (watcher == null)
            watcher = app.scope.launch {
                combine(app.node.transfers, app.readyToReceive) { t, r -> t to r }.collect { (t, r) ->
                    withContext(Dispatchers.Main) { refresh(t, r) }
                }
            }

        // Restarted by Android after it had to end the process: the
        // watcher stops it again straight away if nothing needs it.
        return START_STICKY
    }

    private fun refresh(transfers: List<Transfer>, ready: Boolean, force: Boolean = false) {
        val moving = transfers.any { it.state == "sending" || it.state == "receiving" }
        val forTransfers = needsTransferService(transfers)

        if (!forTransfers && !ready) {
            stop()
            return
        }

        holdCpu(moving)

        // Progress changes many times a second; Android drops updates faster
        // than about one a second anyway. Anything else (a transfer starting
        // or ending, the switch) updates at once.
        val shape = transfers.filter { it.state in setOf("sending", "receiving", "offered") }.map { it.transferId to it.state } to ready
        val now = SystemClock.elapsedRealtime()

        if (!force && shape == lastShape && now - lastUpdate < 1000)
            return

        lastShape = shape
        lastUpdate = now

        promote(app.notifications.service(transfers, ready), forTransfers, ready)
    }

    // startForeground with the types for what's needed now (Android 14+
    // checks them against the manifest and the permissions). False if
    // Android refused, in which case the service has stopped.
    private fun promote(notification: android.app.Notification, forTransfers: Boolean, ready: Boolean): Boolean {
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                var types = 0

                if (forTransfers || !ready) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                if (ready) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE

                startForeground(SERVICE_NOTIFICATION_ID, notification, types)
            } else {
                startForeground(SERVICE_NOTIFICATION_ID, notification)
            }

            return true
        } catch (e: Exception) {
            // Not allowed right now (Android 12+ background rules, or the
            // daily dataSync time used up): the transfer still runs while
            // the process lives.
            Log.w("PeerPayload", "foreground service refused: ${e.message}")
            stop()
            return false
        }
    }

    // Keeps the CPU running with the screen off, only while bytes move.
    private fun holdCpu(on: Boolean) {
        if (on && wakeLock == null) {
            wakeLock = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PeerPayload:transfer")
                .apply { acquire(6 * 60 * 60 * 1000L) }
        } else if (!on) {
            wakeLock?.takeIf { it.isHeld }?.release()
            wakeLock = null
        }
    }

    private fun stop() {
        holdCpu(false)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    // Android 15 limits dataSync services to 6 hours a day. When that runs
    // out, Android asks us to stop: transfers then continue only while the
    // app is open.
    override fun onTimeout(startId: Int, fgsType: Int) {
        Log.w("PeerPayload", "foreground service time limit reached (type $fgsType)")
        stop()
    }

    override fun onDestroy() {
        watcher?.cancel()
        watcher = null
        holdCpu(false)
        super.onDestroy()
    }

    companion object {
        /** Starts the service if it isn't running; it decides itself whether it's needed. */
        fun start(context: Context) {
            try {
                context.startForegroundService(Intent(context, ConnectService::class.java))
            } catch (e: Exception) {
                // Android 12+: apps in the background may not start one.
                Log.w("PeerPayload", "couldn't start the foreground service: ${e.message}")
            }
        }
    }
}
