package com.peerpayload.connect.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.peerpayload.connect.app.ConnectViewModel
import com.peerpayload.connect.app.SendDraft

// The review step before sending (like the desktop's Transfer page): what
// was picked or shared, its size, who it goes to. Nothing is copied or
// offered until Send.
@Composable
fun SendSheet(draft: SendDraft, vm: ConnectViewModel) {
    val t = LocalTokens.current
    val contacts by vm.contacts.collectAsState()
    val paired = contacts.filter { it.status == "paired" }
    val known = draft.files.mapNotNull { it.size }
    val total = known.sum()
    val recipient = paired.firstOrNull { it.fp == draft.recipient }
    val more = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris: List<Uri> -> vm.addToDraft(uris) }

    Dialog(onDismissRequest = vm::discardDraft, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Column(Modifier.fillMaxSize().background(t.page).statusBarsPadding().navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().background(t.surface).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Send files", fontWeight = FontWeight.Bold, fontSize = 18.sp, color = t.ink, modifier = Modifier.weight(1f))
                TextButton(vm::discardDraft) { Text("Cancel", color = t.inkSecondary) }
            }
            HorizontalDivider(color = t.border)

            LazyColumn(Modifier.weight(1f), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Label("Selected", Modifier.weight(1f))
                        Text(
                            "${draft.files.size} file${if (draft.files.size == 1) "" else "s"}" + if (known.size == draft.files.size) " · ${formatBytes(total)}" else "",
                            fontFamily = Mono, fontSize = 12.sp, color = t.inkSecondary,
                        )
                    }
                }

                items(draft.files, key = { it.uri.toString() }) { f ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(f.name, color = t.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            f.size?.let { Text(formatBytes(it), fontFamily = Mono, fontSize = 12.sp, color = t.inkMuted) }
                        }
                        TextButton({ vm.removeFromDraft(f.uri) }) { Text("Remove", color = t.inkSecondary, fontSize = 13.sp) }
                    }
                    HorizontalDivider(color = t.border)
                }

                item {
                    TextButton({ more.launch(arrayOf("*/*")) }) { Text("+ Add more files", color = t.accent) }
                    Spacer(Modifier.height(12.dp))
                    Label("Send to")
                    Spacer(Modifier.height(6.dp))

                    if (paired.isEmpty())
                        Text("No paired contacts yet. Pair one in Contacts first; your selection stays here.", color = t.inkSecondary)
                }

                items(paired, key = { it.fp }) { c ->
                    val selected = c.fp == draft.recipient

                    Row(
                        Modifier.fillMaxWidth()
                            .background(if (selected) t.accentSoft else t.surface)
                            .clickable { vm.chooseRecipient(c.fp) }
                            .padding(12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(c.name, color = t.ink, fontWeight = FontWeight.Medium)
                            Text(c.fp.chunked(4).take(4).joinToString(" ").uppercase(), fontFamily = Mono, fontSize = 11.sp, color = t.inkMuted)
                        }
                        Box(
                            Modifier.size(16.dp).clip(CircleShape)
                                .background(if (selected) t.accent else t.border)
                                .padding(if (selected) 4.dp else 1.dp)
                                .clip(CircleShape)
                                .background(if (selected) t.accentInk else t.surface),
                        )
                    }
                }
            }

            HorizontalDivider(color = t.border)
            Column(Modifier.fillMaxWidth().background(t.surface).padding(16.dp)) {
                Primary("Send", enabled = recipient != null && draft.files.isNotEmpty(), modifier = Modifier.fillMaxWidth(), onClick = vm::sendDraft)
                Spacer(Modifier.height(6.dp))
                Text(
                    if (recipient == null) "Choose who to send to" else "To ${recipient.name}, encrypted end to end",
                    fontSize = 12.sp, color = t.inkSecondary, modifier = Modifier.align(Alignment.CenterHorizontally),
                )
            }
        }
    }
}
