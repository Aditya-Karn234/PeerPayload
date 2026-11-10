# Release shrinking (R8) rules for PeerPayload Connect.

# The engine's JNI bridge (connect/android/engine/jni/pp_jni.cpp) binds to
# these by name: native methods of NativeEngine, and onEvent(String) of the
# listener it calls back.
-keep class com.peerpayload.connect.engine.NativeEngine {
    native <methods>;
}
-keep interface com.peerpayload.connect.engine.EventListener { *; }
-keep class * implements com.peerpayload.connect.engine.EventListener {
    void onEvent(java.lang.String);
}

# BouncyCastle references JDK classes Android doesn't have (unused here).
-dontwarn org.bouncycastle.**
-dontwarn javax.naming.**
