package com.peerpayload.connect

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import com.peerpayload.connect.app.ConnectApp
import com.peerpayload.connect.app.ConnectViewModel
import com.peerpayload.connect.protocol.LINK_PREFIX
import com.peerpayload.connect.ui.ConnectScreen
import com.peerpayload.connect.ui.ConnectTheme

class MainActivity : ComponentActivity() {
    private val vm: ConnectViewModel by viewModels()

    // A peerpayload://pair link this activity was opened with, until handled.
    private val incomingLink = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        takeLink(intent)

        setContent {
            val transfers by vm.transfers.collectAsState()
            val running = transfers.any { it.state == "sending" || it.state == "receiving" }

            // v1 transfers only while the app is open: keep the screen (and
            // with it the network) awake while one runs.
            LaunchedEffect(running) {
                if (running) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }

            ConnectTheme {
                ConnectScreen(vm, incomingLink.value) { incomingLink.value = null }
            }
        }
    }

    override fun onStart() {
        super.onStart()

        // Back from the QR scanner, the file picker or another app: Android
        // may have cut our network meanwhile, so don't wait out the backoff.
        if (!vm.status.value.connected)
            (application as ConnectApp).node.reconnectNow()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        takeLink(intent)
    }

    private fun takeLink(intent: Intent?) {
        intent ?: return

        // Files shared from another app go to the send review.
        val shared = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(intent.streamExtra())
            Intent.ACTION_SEND_MULTIPLE -> intent.streamListExtra()
            else -> emptyList()
        }

        if (shared.isNotEmpty()) {
            vm.addToDraft(shared)
            return
        }

        val data = intent.dataString ?: return

        if (data.startsWith(LINK_PREFIX))
            incomingLink.value = data
    }

    private fun Intent.streamExtra(): Uri? =
        if (Build.VERSION.SDK_INT >= 33) getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else @Suppress("DEPRECATION") getParcelableExtra(Intent.EXTRA_STREAM)

    private fun Intent.streamListExtra(): List<Uri> =
        (if (Build.VERSION.SDK_INT >= 33) getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else @Suppress("DEPRECATION") getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()
}
