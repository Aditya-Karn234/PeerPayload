package com.peerpayload.connect.app

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import java.io.File

// Files in and out of the app, on Android's terms. The engine works with
// plain paths, so what the user picks (content:// URIs from the system
// picker) is copied into app-private storage first, and what arrives is
// staged in app storage and then published into Downloads/PeerPayload.

const val DOWNLOAD_SUBDIR = "PeerPayload"

/** The display name of a picked document. */
fun displayName(context: Context, uri: Uri): String {
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst() && !c.isNull(0))
            return c.getString(0)
    }

    return uri.lastPathSegment?.substringAfterLast('/') ?: "file"
}

/** A name that doesn't clash in [dir]: "a.pdf", "a (2).pdf", ... */
private fun freeName(dir: File, name: String): String {
    val dot = name.lastIndexOf('.').takeIf { it > 0 } ?: name.length
    val stem = name.substring(0, dot)
    val ext = name.substring(dot)

    return generateSequence(1) { it + 1 }
        .map { n -> if (n == 1) name else "$stem ($n)$ext" }
        .first { !File(dir, it).exists() }
}

private fun safeName(name: String) = name.replace(Regex("[/\\\\\u0000]"), "_").trim().ifEmpty { "file" }

/** Copies picked documents into [dest] (created). Returns the copies. */
fun copyPicked(context: Context, uris: List<Uri>, dest: File): List<File> {
    dest.mkdirs()

    return uris.map { uri ->
        val target = File(dest, freeName(dest, safeName(displayName(context, uri))))

        context.contentResolver.openInputStream(uri).use { input ->
            requireNotNull(input) { "couldn't open ${uri.lastPathSegment}" }
            target.outputStream().use { input.copyTo(it, 1 shl 20) }
        }

        target
    }
}

/**
 * Publishes everything in a finished transfer's staging folder into
 * Downloads/PeerPayload (keeping sub-folders), then the caller deletes the
 * staging folder. Returns the top-level names as saved.
 */
fun deliverToDownloads(context: Context, staging: File): List<String> {
    val top = staging.listFiles { f -> !f.name.startsWith("transfer.state") }.orEmpty().sortedBy { it.name }

    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        // Android 8-9: no MediaStore Downloads; keep them in the app's own
        // Downloads folder (Android/data/<app>/files/Download).
        val dir = File(context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: context.filesDir, DOWNLOAD_SUBDIR).apply { mkdirs() }

        return top.map { f ->
            val name = freeName(dir, f.name)

            f.copyRecursively(File(dir, name))
            name
        }
    }

    val resolver = context.contentResolver

    for (f in staging.walkTopDown().filter { it.isFile && !it.name.startsWith("transfer.state") }) {
        val rel = f.parentFile!!.relativeTo(staging).path.replace('\\', '/')
        val values = ContentValues().apply {
            put(MediaStore.Downloads.DISPLAY_NAME, f.name)
            put(MediaStore.Downloads.RELATIVE_PATH, listOf(Environment.DIRECTORY_DOWNLOADS, DOWNLOAD_SUBDIR, rel).filter { it.isNotEmpty() }.joinToString("/"))
            put(MediaStore.Downloads.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: error("couldn't create ${f.name} in Downloads")

        try {
            resolver.openOutputStream(uri).use { out ->
                requireNotNull(out)
                f.inputStream().use { it.copyTo(out, 1 shl 20) }
            }
            resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            throw e
        }
    }

    return top.map { it.name }
}
