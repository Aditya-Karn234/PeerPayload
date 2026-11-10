// PeerPayload Connect for Android. Build from this folder:
//   gradlew assembleDebug        (app)
//   gradlew testDebugUnitTest    (protocol tests against the JS test vectors)
// The engine library comes from engine/build-engine.sh (see docs/CONNECT.md).
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "PeerPayloadConnect"
include(":app")
