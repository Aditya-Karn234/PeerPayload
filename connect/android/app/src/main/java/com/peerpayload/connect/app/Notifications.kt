package com.peerpayload.connect.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import com.peerpayload.connect.MainActivity
import com.peerpayload.connect.R
import com.peerpayload.connect.core.Transfer
import com.peerpayload.connect.ui.formatBytes

// Every notification the app shows. Built with the platform API (minSdk 26
// has channels), so no extra library.
//
//   transfer  the foreground service's own notification: progress of what's
//             running, or "Ready to receive" (low priority, silent)
//   offers    someone wants to send you files: Accept / Decline (high
//             priority, pops up)
//   done      a transfer to this device finished (default priority)

const val CHANNEL_TRANSFER = "transfer"
const val CHANNEL_OFFERS = "offers"
const val CHANNEL_DONE = "done"

const val SERVICE_NOTIFICATION_ID = 1

const val ACTION_ACCEPT = "com.peerpayload.connect.ACCEPT"
const val ACTION_DECLINE = "com.peerpayload.connect.DECLINE"
const val ACTION_PAUSE = "com.peerpayload.connect.PAUSE"
const val EXTRA_TRANSFER_ID = "transferId"

class ConnectNotifications(private val context: Context) {
    private val manager = context.getSystemService(NotificationManager::class.java)

    init {
        manager.createNotificationChannels(listOf(
            NotificationChannel(CHANNEL_TRANSFER, "Transfers in progress", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Progress of running transfers, and \"Ready to receive\" while that's on"
                setShowBadge(false)
            },
            NotificationChannel(CHANNEL_OFFERS, "Incoming files", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "A contact wants to send you files"
            },
            NotificationChannel(CHANNEL_DONE, "Finished transfers", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Files you received"
            },
        ))
    }

    /** Android 13+ asks; without permission notifications are simply not shown. */
    fun allowed(): Boolean =
        Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun openApp(): PendingIntent =
        PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    private fun action(action: String, id: String, label: String): Notification.Action {
        val intent = Intent(context, NotificationActionReceiver::class.java).setAction(action).putExtra(EXTRA_TRANSFER_ID, id)
        // A distinct request code per (action, transfer), or Android would
        // reuse one PendingIntent for all of them.
        val pending = PendingIntent.getBroadcast(context, (action + id).hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        return Notification.Action.Builder(null, label, pending).build()
    }

    private fun builder(channel: String) =
        Notification.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_stat_connect)
            .setContentIntent(openApp())

    /** The service's notification for what it's currently keeping alive. */
    fun service(transfers: List<Transfer>, ready: Boolean): Notification {
        val running = transfers.filter { it.state == "sending" || it.state == "receiving" }
        val waiting = transfers.filter { it.direction == "out" && it.state == "offered" }
        val b = builder(CHANNEL_TRANSFER).setOngoing(true).setOnlyAlertOnce(true).setShowWhen(false)

        when {
            running.size == 1 -> {
                val t = running[0]
                val done = t.progress?.bytes ?: 0
                val percent = if (t.totalBytes > 0) (done * 100 / t.totalBytes).toInt() else 0

                b.setContentTitle(if (t.direction == "out") "Sending to ${t.peerName}" else "Receiving from ${t.peerName}")
                    .setContentText("$percent% · ${formatBytes(done)} of ${formatBytes(t.totalBytes)}")
                    .setProgress(100, percent, t.progress == null)
                    .addAction(action(ACTION_PAUSE, t.transferId, "Pause"))
            }
            running.isNotEmpty() -> {
                val done = running.sumOf { it.progress?.bytes ?: 0 }
                val total = running.sumOf { it.totalBytes }

                b.setContentTitle("${running.size} transfers running")
                    .setContentText("${formatBytes(done)} of ${formatBytes(total)}")
                    .setProgress(100, if (total > 0) (done * 100 / total).toInt() else 0, false)
            }
            waiting.isNotEmpty() ->
                b.setContentTitle(if (waiting.size == 1) "Waiting for ${waiting[0].peerName} to accept" else "Waiting for ${waiting.size} contacts to accept")
                    .setContentText("Sending starts as soon as they accept")
            else ->
                b.setContentTitle("Ready to receive")
                    .setContentText("Offers from your contacts will show up here")
        }

        if (ready && (running.isNotEmpty() || waiting.isNotEmpty()))
            b.setSubText("Ready to receive")

        return b.build()
    }

    fun showOffer(t: Transfer) {
        if (!allowed())
            return

        val what = if (t.fileCount == 1L) t.files.firstOrNull()?.name ?: "1 file" else "${t.fileCount} files"
        val n = builder(CHANNEL_OFFERS)
            .setContentTitle("${t.peerName} wants to send you $what")
            .setContentText("${formatBytes(t.totalBytes)} · tap to review")
            .setCategory(Notification.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .addAction(action(ACTION_ACCEPT, t.transferId, "Accept"))
            .addAction(action(ACTION_DECLINE, t.transferId, "Decline"))
            .build()

        manager.notify(offerId(t.transferId), n)
    }

    fun cancelOffer(id: String) = manager.cancel(offerId(id))

    fun showReceived(t: Transfer) {
        if (!allowed())
            return

        val what = if (t.fileCount == 1L) t.files.firstOrNull()?.name ?: "1 file" else "${t.fileCount} files"
        val n = builder(CHANNEL_DONE)
            .setContentTitle("Received $what from ${t.peerName}")
            .setContentText("${formatBytes(t.totalBytes)} · in Downloads/PeerPayload")
            .setAutoCancel(true)
            .build()

        manager.notify(doneId(t.transferId), n)
    }

    // Two id spaces per transfer, kept clear of the service's id (1).
    private fun offerId(id: String) = (id.hashCode() and 0x3FFFFFFF) or 0x40000000
    private fun doneId(id: String) = id.hashCode() and 0x3FFFFFFF or 0x10000000
}
