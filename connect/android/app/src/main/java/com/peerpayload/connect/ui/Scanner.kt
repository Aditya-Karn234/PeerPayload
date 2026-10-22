package com.peerpayload.connect.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size as GeoSize
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.NotFoundException
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import com.peerpayload.connect.protocol.LINK_PREFIX
import java.util.concurrent.Executors

// The QR scanner, inside the app (CameraX + ZXing). The previous one was
// Google Play services' screen: while it was in front Android counted this
// app as in the background and cut its network, it needed Play services,
// and it downloaded itself on first use. This one keeps the app in front
// and accepts only PeerPayload pairing links.

/** Finds a QR code in a camera frame (the Y plane is already grayscale). */
private class QrAnalyzer(private val onText: (String) -> Unit) : ImageAnalysis.Analyzer {
    private val reader = QRCodeReader()
    private val hints = mapOf(DecodeHintType.POSSIBLE_FORMATS to listOf(BarcodeFormat.QR_CODE), DecodeHintType.TRY_HARDER to true)

    override fun analyze(image: ImageProxy) {
        try {
            val plane = image.planes[0]
            val buffer = plane.buffer
            val data = ByteArray(buffer.remaining()).also { buffer.get(it) }
            val source = PlanarYUVLuminanceSource(data, plane.rowStride, image.height, 0, 0, image.width, image.height, false)

            for (bitmap in listOf(BinaryBitmap(HybridBinarizer(source)), BinaryBitmap(HybridBinarizer(source.invert())))) {
                try {
                    onText(reader.decode(bitmap, hints).text)
                    return
                } catch (_: NotFoundException) {
                } catch (_: Exception) {
                } finally {
                    reader.reset()
                }
            }
        } finally {
            image.close()
        }
    }
}

@Composable
fun ScannerScreen(onLink: (String) -> Unit, onClose: () -> Unit) {
    val context = LocalContext.current
    val t = LocalTokens.current
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var asked by remember { mutableStateOf(false) }
    val request = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        granted = it
        asked = true
    }

    LaunchedEffect(Unit) {
        if (!granted) request.launch(Manifest.permission.CAMERA)
    }

    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            if (granted)
                CameraWithFinder(onLink)
            else if (asked)
                Column(
                    Modifier.fillMaxSize().padding(32.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text("Camera access is off", color = Color.White, fontWeight = FontWeight.SemiBold, fontSize = 18.sp)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "PeerPayload uses the camera only to read pairing codes. Allow it in Settings, or paste the invite link instead.",
                        color = Color(0xFFB3B2AA), textAlign = TextAlign.Center,
                    )
                    Spacer(Modifier.height(16.dp))
                    Primary("Open settings") {
                        context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
                    }
                }

            Row(Modifier.fillMaxWidth().statusBarsPadding().padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Scan pairing code", color = Color.White, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f).padding(start = 12.dp))
                TextButton(onClose) { Text("Close", color = t.accent) }
            }
        }
    }
}

@Composable
private fun CameraWithFinder(onLink: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    var camera by remember { mutableStateOf<Camera?>(null) }
    var torch by remember { mutableStateOf(false) }
    var hint by remember { mutableStateOf<String?>(null) }
    var done by remember { mutableStateOf(false) }

    val previewView = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }

    DisposableEffect(Unit) {
        val providerFuture = ProcessCameraProvider.getInstance(context)

        providerFuture.addListener({
            val provider = providerFuture.get()
            val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
            val analysis = ImageAnalysis.Builder()
                .setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)).build())
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()

            analysis.setAnalyzer(executor, QrAnalyzer { text ->
                previewView.post {
                    if (done)
                        return@post

                    if (text.trim().startsWith(LINK_PREFIX)) {
                        done = true
                        onLink(text.trim())
                    } else {
                        hint = "That's not a PeerPayload pairing code"
                    }
                }
            })

            runCatching {
                provider.unbindAll()
                camera = provider.bindToLifecycle(lifecycle, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            }.onFailure { hint = "Couldn't start the camera: ${it.message}" }
        }, ContextCompat.getMainExecutor(context))

        onDispose {
            runCatching { providerFuture.get().unbindAll() }
            executor.shutdown()
        }
    }

    Box(Modifier.fillMaxSize()) {
        AndroidView({ previewView }, Modifier.fillMaxSize())

        // Dim everything but a square window, with an orange frame.
        Canvas(Modifier.fillMaxSize().graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)) {
            val side = size.minDimension * 0.68f
            val topLeft = Offset((size.width - side) / 2, (size.height - side) / 2.4f)

            drawRect(Color.Black.copy(alpha = 0.55f))
            drawRoundRect(Color.Transparent, topLeft, GeoSize(side, side), CornerRadius(12f), blendMode = BlendMode.Clear)
            drawRoundRect(Color(0xFFFF6818), topLeft, GeoSize(side, side), CornerRadius(12f), style = Stroke(width = 4.dp.toPx()))
        }

        Column(
            Modifier.align(Alignment.BottomCenter).fillMaxWidth().navigationBarsPadding().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                hint ?: "Point at the QR code on the other device's invite screen (PC: Devices › Create invite link).",
                color = if (hint != null) Color(0xFFF0874A) else Color.White,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(12.dp))

            if (camera?.cameraInfo?.hasFlashUnit() == true)
                TextButton({
                    torch = !torch
                    camera?.cameraControl?.enableTorch(torch)
                }) { Text(if (torch) "Light off" else "Light on", color = Color.White) }
        }
    }
}
