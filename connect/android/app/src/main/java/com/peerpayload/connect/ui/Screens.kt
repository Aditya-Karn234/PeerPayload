package com.peerpayload.connect.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.peerpayload.connect.R
import com.peerpayload.connect.app.ConnectViewModel
import com.peerpayload.connect.core.Contact
import com.peerpayload.connect.core.Rate
import com.peerpayload.connect.core.formatRemaining
import com.peerpayload.connect.core.Transfer
import com.peerpayload.connect.engine.NativeEngine

// ---- formatting ----

fun formatBytes(n: Long): String {
    val units = listOf("B", "KB", "MB", "GB", "TB")
    var v = n.toDouble()
    var i = 0

    while (v >= 1024 && i < units.size - 1) {
        v /= 1024
        i++
    }

    return if (i == 0) "$n B" else "%.1f %s".format(v, units[i])
}

private fun shortId(fp: String) = fp.chunked(4).take(4).joinToString(" ").uppercase()

private val STATE_LABEL = mapOf(
    "offered" to "Offered", "waiting" to "Waiting", "sending" to "Sending", "receiving" to "Receiving",
    "complete" to "Complete", "failed" to "Failed", "cancelled" to "Cancelled", "declined" to "Declined",
    "timed_out" to "No answer", "interrupted" to "Paused",
)

// "Stay ready to receive": ConnectService keeps the mailbox connection in
// the background so offers arrive as notifications. Turning it on asks for
// notifications (Android 13+) and then to be left out of battery
// optimisation, without which a dozing phone holds offers back.
@SuppressLint("BatteryLife")
@Composable
private fun ReadyToReceivePanel(vm: ConnectViewModel) {
    val ready by vm.readyToReceive.collectAsState()
    val context = LocalContext.current
    val t = LocalTokens.current

    fun askBatteryExemption() {
        val power = context.getSystemService(PowerManager::class.java)

        if (!power.isIgnoringBatteryOptimizations(context.packageName))
            runCatching {
                context.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")))
            }
    }

    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        vm.setReadyToReceive(true)

        if (!granted)
            vm.message.value = "Notifications are off: offers will only show in the app. Allow them in Settings to get alerts."

        askBatteryExemption()
    }

    fun turnOn() {
        if (Build.VERSION.SDK_INT >= 33)
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        else {
            vm.setReadyToReceive(true)
            askBatteryExemption()
        }
    }

    Panel {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Stay ready to receive", fontWeight = FontWeight.SemiBold, color = t.ink)
                Text(
                    if (ready) "Offers arrive as notifications even when the app is closed."
                    else "Off: offers arrive only while the app is open.",
                    fontSize = 13.sp, color = t.inkSecondary,
                )
            }
            Switch(ready, { on -> if (on) turnOn() else vm.setReadyToReceive(false) })
        }
        Spacer(Modifier.height(8.dp))
        Text(
            "Keeps a small notification while on, and uses some battery. On Samsung phones, also set " +
                "Settings › Apps › PeerPayload Connect › Battery to Unrestricted. Transfers keep going " +
                "when you switch apps either way.",
            fontSize = 12.sp, color = t.inkMuted,
        )
    }
}

// ---- building blocks ----

@Composable
internal fun Label(text: String, modifier: Modifier = Modifier) =
    Text(text.uppercase(), style = LabelStyle, color = LocalTokens.current.inkMuted, modifier = modifier)

@Composable
internal fun Panel(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val t = LocalTokens.current

    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(4.dp))
            .background(t.surface)
            .border(1.dp, t.border, RoundedCornerShape(4.dp))
            .padding(14.dp),
    ) { content() }
}

@Composable
internal fun Primary(text: String, enabled: Boolean = true, modifier: Modifier = Modifier, onClick: () -> Unit) =
    Button(onClick, modifier, enabled = enabled, shape = RoundedCornerShape(4.dp)) { Text(text, fontWeight = FontWeight.SemiBold) }

@Composable
internal fun Secondary(text: String, modifier: Modifier = Modifier, onClick: () -> Unit) =
    OutlinedButton(onClick, modifier, shape = RoundedCornerShape(4.dp), colors = ButtonDefaults.outlinedButtonColors(contentColor = LocalTokens.current.ink)) {
        Text(text)
    }

@Composable
private fun StatusDot(on: Boolean) {
    val t = LocalTokens.current

    Box(Modifier.size(8.dp).clip(RoundedCornerShape(4.dp)).background(if (on) t.good else t.inkMuted))
}

private fun qrBitmap(text: String, size: Int = 720): Bitmap {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 1))
    val pixels = IntArray(size * size) { i -> if (matrix[i % size, i / size]) 0xFF1A1A1A.toInt() else 0xFFFFFFFF.toInt() }

    return Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888)
}

private fun copy(context: Context, text: String) {
    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("PeerPayload", text))
}

// ---- app ----

private enum class Tab(val label: String) { TRANSFERS("Transfers"), CONTACTS("Contacts"), DEVICE("Device") }

@Composable
fun ConnectScreen(vm: ConnectViewModel, incomingLink: String?, onLinkHandled: () -> Unit) {
    val status by vm.status.collectAsState()
    val message by vm.message.collectAsState()
    val paired by vm.paired.collectAsState()
    val transfers by vm.transfers.collectAsState()
    val draft by vm.draft.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    var tab by rememberSaveable { mutableStateOf(Tab.TRANSFERS) }
    val offers = transfers.filter { it.direction == "in" && it.state == "offered" }

    LaunchedEffect(message) {
        message?.let {
            snackbar.showSnackbar(it)
            vm.message.value = null
        }
    }

    LaunchedEffect(paired) {
        paired?.let {
            snackbar.showSnackbar("Paired with ${it.name}. Safety code ${it.safetyCode}")
            vm.paired.value = null
        }
    }

    // A pairing link opened from another app.
    LaunchedEffect(incomingLink, status.hasIdentity) {
        if (incomingLink != null && status.hasIdentity) {
            vm.addContact(incomingLink)
            tab = Tab.CONTACTS
            onLinkHandled()
        }
    }

    Scaffold(
        containerColor = LocalTokens.current.page,
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = { if (status.hasIdentity) TopBar(status.connected) },
        bottomBar = {
            if (status.hasIdentity) {
                NavigationBar(containerColor = LocalTokens.current.surface) {
                    Tab.entries.forEach { t ->
                        NavigationBarItem(
                            selected = tab == t,
                            onClick = { tab = t },
                            icon = {
                                BadgedBox(badge = { if (t == Tab.TRANSFERS && offers.isNotEmpty()) Badge(containerColor = LocalTokens.current.accent) { Text("${offers.size}", color = LocalTokens.current.accentInk) } }) {
                                    Box(Modifier.size(width = 18.dp, height = 3.dp).background(if (tab == t) LocalTokens.current.accent else LocalTokens.current.border))
                                }
                            },
                            label = { Text(t.label, fontFamily = Mono, fontSize = 12.sp) },
                            colors = NavigationBarItemDefaults.colors(indicatorColor = LocalTokens.current.accentSoft),
                        )
                    }
                }
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            // Offers can't be missed: above every tab, like the desktop's banner.
            if (status.hasIdentity)
                offers.forEach { OfferBanner(it, vm) { tab = Tab.TRANSFERS } }

            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (!status.hasIdentity)
                    SetupScreen(vm)
                else when (tab) {
                    Tab.TRANSFERS -> TransfersScreen(vm)
                    Tab.CONTACTS -> ContactsScreen(vm)
                    Tab.DEVICE -> DeviceScreen(vm)
                }
            }
        }
    }

    // Picked or shared files wait here for review; once set up.
    if (status.hasIdentity)
        draft?.let { SendSheet(it, vm) }
}

@Composable
private fun OfferBanner(x: Transfer, vm: ConnectViewModel, onAccepted: () -> Unit) {
    val t = LocalTokens.current
    val names = x.files.joinToString(", ") { it.name } + if (x.fileCount > x.files.size) " ..." else ""

    Row(
        Modifier.fillMaxWidth().background(t.surface).padding(start = 0.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(3.dp).height(64.dp).background(t.accent))
        Column(Modifier.weight(1f).padding(horizontal = 12.dp, vertical = 8.dp)) {
            Label("Incoming from ${x.peerName}")
            Text(names, color = t.ink, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(formatBytes(x.totalBytes), fontFamily = Mono, fontSize = 12.sp, color = t.inkSecondary)
        }
        TextButton({ vm.decline(x.transferId) }) { Text("Decline", color = t.inkSecondary) }
        Primary("Accept", modifier = Modifier.padding(end = 12.dp)) {
            vm.accept(x.transferId)
            onAccepted()
        }
    }
    HorizontalDivider(color = t.border)
}

@Composable
private fun TopBar(connected: Boolean) {
    val t = LocalTokens.current

    Row(
        Modifier.fillMaxWidth().background(t.surface).statusBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Image(painterResource(R.drawable.raven), null, Modifier.size(28.dp).clip(RoundedCornerShape(4.dp)))
        Spacer(Modifier.width(10.dp))
        Text("PeerPayload", fontWeight = FontWeight.Bold, fontSize = 17.sp, color = t.ink)
        Text(" Connect", fontSize = 17.sp, color = t.inkSecondary)
        Spacer(Modifier.weight(1f))
        StatusDot(connected)
        Spacer(Modifier.width(6.dp))
        Text(if (connected) "ONLINE" else "OFFLINE", style = LabelStyle, color = t.inkSecondary)
    }
    HorizontalDivider(color = t.border)
}

// ---- setup ----

@Composable
private fun SetupScreen(vm: ConnectViewModel) {
    val t = LocalTokens.current
    val busy by vm.busy.collectAsState()
    var name by rememberSaveable { mutableStateOf(android.os.Build.MODEL ?: "") }

    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center) {
        Image(painterResource(R.drawable.raven), null, Modifier.size(72.dp).clip(RoundedCornerShape(6.dp)))
        Spacer(Modifier.height(20.dp))
        Text("PeerPayload Connect", fontSize = 26.sp, fontWeight = FontWeight.Bold, color = t.ink)
        Spacer(Modifier.height(8.dp))
        Text(
            "Send files straight to your own devices and people you pair with. No account: this phone gets its own keys, which never leave it.",
            color = t.inkSecondary,
        )
        Spacer(Modifier.height(28.dp))
        Label("Device name")
        Spacer(Modifier.height(6.dp))
        OutlinedTextField(name, { name = it.take(64) }, Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text("e.g. Aditya's phone") })
        Spacer(Modifier.height(6.dp))
        Text("Shown to the people you pair with.", fontSize = 13.sp, color = t.inkMuted)
        Spacer(Modifier.height(20.dp))
        Primary(if (busy) "Creating keys..." else "Create this device", enabled = !busy && name.isNotBlank(), Modifier.fillMaxWidth()) { vm.setup(name) }
    }
}

// ---- transfers ----

@Composable
private fun TransfersScreen(vm: ConnectViewModel) {
    val transfers by vm.transfers.collectAsState()
    val rates by vm.rates.collectAsState()
    val t = LocalTokens.current

    if (transfers.isEmpty()) {
        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            Label("No transfers yet")
            Spacer(Modifier.height(8.dp))
            Text("Pick a contact to send files. Offers from your contacts show up here.", color = t.inkSecondary)
        }
        return
    }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Label("History", Modifier.weight(1f))
                TextButton({ vm.clearFinished() }) { Text("Clear finished", color = t.inkSecondary, fontSize = 13.sp) }
            }
        }
        items(transfers, key = { it.transferId }) { TransferCard(it, rates[it.transferId], vm) }
    }
}

@Composable
private fun TransferCard(x: Transfer, rate: Rate?, vm: ConnectViewModel) {
    val t = LocalTokens.current
    var confirmRemove by remember { mutableStateOf(false) }
    val incoming = x.direction == "in"
    val names = x.files.joinToString(", ") { it.name } + if (x.fileCount > x.files.size) " ..." else ""
    val stateColor = when (x.state) {
        "complete" -> t.good
        "failed", "timed_out" -> t.critical
        "sending", "receiving" -> t.accent
        "interrupted", "waiting" -> t.warning
        else -> t.inkSecondary
    }

    Panel {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Label(if (incoming) "From ${x.peerName}" else "To ${x.peerName}", Modifier.weight(1f))
            Text(STATE_LABEL[x.state]?.uppercase() ?: x.state, style = LabelStyle, color = stateColor)
        }
        Spacer(Modifier.height(6.dp))
        Text(names, color = t.ink, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Text(
            "${x.fileCount} file${if (x.fileCount == 1L) "" else "s"} · ${formatBytes(x.totalBytes)}" + (x.path?.let { " · $it" } ?: ""),
            fontFamily = Mono, fontSize = 12.sp, color = t.inkSecondary,
        )

        val progress = x.progress

        if (x.state == "sending" || x.state == "receiving" || (progress != null && x.state != "complete")) {
            val fraction = if (progress != null && progress.total > 0) progress.bytes.toFloat() / progress.total else 0f

            Spacer(Modifier.height(10.dp))
            LinearProgressIndicator(
                progress = { fraction },
                modifier = Modifier.fillMaxWidth().height(4.dp),
                color = t.accent,
                trackColor = t.track,
                strokeCap = androidx.compose.ui.graphics.StrokeCap.Butt,
                gapSize = 0.dp,
                drawStopIndicator = {},
            )
            Spacer(Modifier.height(4.dp))
            Text(
                "${formatBytes(progress?.bytes ?: 0)} of ${formatBytes(x.totalBytes)}  ${(fraction * 100).toInt()}%",
                fontFamily = Mono, fontSize = 12.sp, color = t.inkSecondary,
            )

            // Measured speed and time left, as on the desktop.
            val speed = when (rate) {
                null -> null
                Rate.Measuring -> "measuring speed"
                Rate.Stalled -> "no data for a few seconds"
                is Rate.Speed -> "${formatBytes(rate.bytesPerSec.toLong())}/s" + (rate.secondsLeft?.let { " · ${formatRemaining(it)} left" } ?: "")
            }

            speed?.let { Text(it, fontFamily = Mono, fontSize = 12.sp, color = if (rate == Rate.Stalled) t.warning else t.inkSecondary) }
        }

        x.retry?.let { Text(it, fontSize = 12.sp, color = t.warning) }

        // Via the relay: works anywhere, but only as fast as the slower
        // side's upload. Say why, and what makes it direct.
        if (x.path == "relay" && x.state in setOf("sending", "receiving", "complete"))
            Text(
                if (incoming) "Came via the relay: ${x.peerName} couldn't connect to this phone directly. Mobile data and public Wi-Fi block that; on the same Wi-Fi or this phone's hotspot it goes direct and faster."
                else "Went via the relay: ${x.peerName} couldn't be reached directly (its firewall or network blocks incoming connections).",
                fontSize = 12.sp, color = t.inkMuted,
            )

        if (x.error != null && x.state != "complete")
            Text(x.error, fontSize = 13.sp, color = if (x.state == "interrupted") t.inkSecondary else t.critical)

        if (x.state == "complete" && incoming && x.savedAs != null)
            Text("Saved to Downloads/PeerPayload", fontSize = 13.sp, color = t.inkSecondary)

        val actions = buildList<Pair<String, () -> Unit>> {
            when {
                incoming && x.state == "offered" -> {
                    add("Accept" to { vm.accept(x.transferId) })
                    add("Decline" to { vm.decline(x.transferId) })
                }
                !incoming && x.state == "offered" -> add("Cancel" to { vm.cancelOffer(x.transferId) })
                x.state == "sending" || x.state == "receiving" -> add("Pause" to { vm.pause(x.transferId) })
                x.resumable -> {
                    add("Resume" to { vm.resume(x.transferId) })
                    add("Remove" to { confirmRemove = true })
                }
                !x.active -> add("Remove" to { vm.forget(x.transferId) })
            }
        }

        if (actions.isNotEmpty()) {
            Spacer(Modifier.height(10.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                actions.forEachIndexed { i, (label, action) ->
                    if (i == 0 && label in setOf("Accept", "Resume")) Primary(label, onClick = action) else Secondary(label, onClick = action)
                }
            }
        }
    }

    // Removing a resumable transfer loses its progress on both devices.
    if (confirmRemove)
        AlertDialog(
            onDismissRequest = { confirmRemove = false },
            confirmButton = {
                TextButton({
                    confirmRemove = false
                    vm.forget(x.transferId)
                }) { Text("Remove", color = t.critical) }
            },
            dismissButton = { TextButton({ confirmRemove = false }) { Text("Keep") } },
            title = { Text("Remove this transfer?") },
            text = {
                Text(
                    "It can't be resumed afterwards" + (if (incoming) ", and the part already received is deleted" else "") +
                        ". ${x.peerName} is told too.",
                )
            },
        )
}

// ---- contacts ----

@Composable
private fun ContactsScreen(vm: ConnectViewModel) {
    val contacts by vm.contacts.collectAsState()
    val context = LocalContext.current
    val t = LocalTokens.current
    var invite by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }
    var sendTo by rememberSaveable { mutableStateOf<String?>(null) }
    var removing by remember { mutableStateOf<Contact?>(null) }

    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris: List<Uri> ->
        val fp = sendTo

        if (fp != null && uris.isNotEmpty())
            vm.addToDraft(uris, fp)

        sendTo = null
    }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Primary("Invite", modifier = Modifier.weight(1f)) { invite = vm.createInvite()?.link }
                Secondary("Add contact", Modifier.weight(1f)) { adding = true }
            }
        }

        if (contacts.isEmpty())
            item {
                Spacer(Modifier.height(16.dp))
                Text(
                    "No contacts yet. Invite someone (they scan your code), or add someone by scanning theirs. Either way both devices end up holding each other's keys.",
                    color = t.inkSecondary,
                )
            }
        else
            item { Label("Contacts") }

        items(contacts, key = { it.fp }) { c ->
            Panel(Modifier.clickable(enabled = c.status == "paired") {
                sendTo = c.fp
                pick.launch(arrayOf("*/*"))
            }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(c.name, fontWeight = FontWeight.SemiBold, color = t.ink)
                        Text(shortId(c.fp), fontFamily = Mono, fontSize = 12.sp, color = t.inkMuted)
                    }
                    Text(if (c.status == "paired") "PAIRED" else "PENDING", style = LabelStyle, color = if (c.status == "paired") t.good else t.warning)
                }
                Spacer(Modifier.height(8.dp))
                Label("Safety code")
                Text(c.safetyCode, fontFamily = Mono, fontSize = 14.sp, color = t.inkSecondary)
                Spacer(Modifier.height(8.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (c.status == "paired")
                        Primary("Send files") {
                            sendTo = c.fp
                            pick.launch(arrayOf("*/*"))
                        }
                    Secondary("Remove") { removing = c }
                }
            }
        }
    }

    invite?.let { link ->
        AlertDialog(
            onDismissRequest = { invite = null },
            confirmButton = {
                TextButton({
                    context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link), "Share invite"))
                }) { Text("Share link") }
            },
            dismissButton = { TextButton({ invite = null }) { Text("Done") } },
            title = { Text("Invite a device") },
            text = {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Image(qrBitmap(link).asImageBitmap(), "Invite QR code", Modifier.size(240.dp))
                    Spacer(Modifier.height(10.dp))
                    Text(
                        "On the other device: Add contact, then scan this. Or share the link over a channel you trust. Single use, valid 24 hours.",
                        fontSize = 13.sp, color = t.inkSecondary,
                    )
                }
            },
        )
    }

    if (adding) AddContactDialog(vm) { adding = false }

    removing?.let { c ->
        AlertDialog(
            onDismissRequest = { removing = null },
            confirmButton = { TextButton({ vm.removeContact(c.fp); removing = null }) { Text("Remove", color = t.critical) } },
            dismissButton = { TextButton({ removing = null }) { Text("Keep") } },
            title = { Text("Remove ${c.name}?") },
            text = { Text("You'd need a new invite to pair again.") },
        )
    }
}

@Composable
private fun AddContactDialog(vm: ConnectViewModel, onClose: () -> Unit) {
    var link by remember { mutableStateOf("") }
    var scanning by remember { mutableStateOf(false) }

    if (scanning)
        return ScannerScreen(
            onLink = {
                vm.addContact(it)
                onClose()
            },
            onClose = { scanning = false },
        )

    AlertDialog(
        onDismissRequest = onClose,
        confirmButton = { TextButton({ vm.addContact(link); onClose() }, enabled = link.isNotBlank()) { Text("Add") } },
        dismissButton = { TextButton(onClose) { Text("Cancel") } },
        title = { Text("Add contact") },
        text = {
            Column {
                Primary("Scan QR code", modifier = Modifier.fillMaxWidth()) { scanning = true }
                Spacer(Modifier.height(14.dp))
                Label("Or paste their invite link")
                Spacer(Modifier.height(6.dp))
                OutlinedTextField(link, { link = it }, Modifier.fillMaxWidth(), placeholder = { Text("peerpayload://pair#...") }, maxLines = 4)
            }
        },
    )
}

// ---- device ----

@Composable
private fun DeviceScreen(vm: ConnectViewModel) {
    val status by vm.status.collectAsState()
    val context = LocalContext.current
    val t = LocalTokens.current
    val fp = status.fingerprint ?: ""

    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Panel {
            Label("This device")
            Text(status.name ?: "", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = t.ink)
            Spacer(Modifier.height(10.dp))
            Label("Device ID")
            Text(fp.chunked(4).joinToString(" "), fontFamily = Mono, fontSize = 13.sp, color = t.inkSecondary)
            TextButton({ copy(context, fp); vm.message.value = "Device ID copied" }) { Text("Copy device ID") }
        }
        Panel {
            Label("Mailbox")
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(status.connected)
                Spacer(Modifier.width(8.dp))
                Text(if (status.connected) "Connected: offers and pairings arrive now" else "Not connected: retrying", color = t.inkSecondary)
            }
        }
        ReadyToReceivePanel(vm)
        Panel {
            Label("Engine")
            Text("Wire protocol ${NativeEngine.protocolVersion()}", fontFamily = Mono, fontSize = 13.sp, color = t.inkSecondary)
        }
    }
}
