import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "com.peerpayload.connect"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.peerpayload.connect"
        minSdk = 26 // Android 8.0; the engine is built for this API level
        targetSdk = 35
        versionCode = 4
        versionName = "0.1.3"

        ndk {
            // Phones, and the x86_64 emulator. Must match engine/build-engine.sh.
            abiFilters += listOf("arm64-v8a", "x86_64")
        }
    }

    // Release signing key: connect/android/signing/ (git-ignored, never
    // pushed; see its keystore.properties). Without it, release builds
    // are left unsigned and can't be installed.
    val signingProps = rootProject.file("signing/keystore.properties").takeIf { it.isFile }?.let { f ->
        Properties().apply { f.inputStream().use(::load) }
    }

    signingConfigs {
        if (signingProps != null) {
            create("release") {
                storeFile = rootProject.file("signing/${signingProps.getProperty("storeFile")}")
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
    }

    packaging {
        // BouncyCastle's jars each carry the same JPMS/OSGi metadata.
        resources.excludes += listOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF", "META-INF/versions/*/module-info.class")
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.12.01")

    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    // Ed25519 / X25519 / HKDF and X.509 parsing, identical on every Android
    // version (the platform's own support varies).
    implementation("org.bouncycastle:bcprov-jdk18on:1.80")
    implementation("org.bouncycastle:bcpkix-jdk18on:1.80")
    // Mailbox: HTTPS POSTs and the inbox WebSocket.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // Pairing QR codes: ZXing draws them and decodes camera frames from
    // CameraX (the scanner is in the app, not Play services').
    implementation("com.google.zxing:core:3.5.3")
    implementation("androidx.camera:camera-camera2:1.4.1")
    implementation("androidx.camera:camera-lifecycle:1.4.1")
    implementation("androidx.camera:camera-view:1.4.1")

    debugImplementation("androidx.compose.ui:ui-tooling")

    testImplementation("junit:junit:4.13.2")
    // A stand-in relay for the bridge tests.
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
