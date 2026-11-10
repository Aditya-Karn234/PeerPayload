package com.peerpayload.connect.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Accept / Decline / Pause buttons on notifications. */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as ConnectApp
        val id = intent.getStringExtra(EXTRA_TRANSFER_ID) ?: return

        try {
            when (intent.action) {
                ACTION_ACCEPT -> {
                    app.node.accept(id)
                    // Tapping a notification button allows starting the
                    // service from the background; do it now, not later.
                    ConnectService.start(context)
                }
                ACTION_DECLINE -> app.node.decline(id)
                ACTION_PAUSE -> app.node.pause(id)
            }
        } catch (e: Exception) {
            // Gone meanwhile (expired, cancelled by the sender): nothing to do.
        }

        if (intent.action != ACTION_PAUSE)
            app.notifications.cancelOffer(id)
    }
}

/** After a restart or an app update: back to "ready to receive" if it was on. */
class StartupReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED)
            return

        val app = context.applicationContext as ConnectApp

        if (app.readyToReceive.value)
            ConnectService.start(context)
    }
}
