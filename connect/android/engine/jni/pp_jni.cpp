// JNI bridge: the engine's C API (engine/include/peerpayload.h) for the
// Kotlin class com.peerpayload.connect.engine.NativeEngine. Built into the
// same libpeerpayload.so as the engine by build-engine.sh.
//
// A run's events arrive on engine threads, which the JVM doesn't know: each
// is attached on its first event and detached when the thread exits.

#include <jni.h>
#include <pthread.h>

#include <string>
#include <vector>

#include "peerpayload.h"

namespace {

JavaVM *g_vm = nullptr;
jmethodID g_onEvent = nullptr; // EventListener.onEvent(String)
pthread_key_t g_detachKey;

// Runs at exit of a thread we attached.
void detachThread(void *)
{
    g_vm->DetachCurrentThread();
}

JNIEnv *envForThisThread()
{
    JNIEnv *env = nullptr;

    if (g_vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) == JNI_OK)
        return env;

    if (g_vm->AttachCurrentThread(&env, nullptr) != JNI_OK)
        return nullptr;

    // Any non-null value makes the destructor run when the thread ends.
    pthread_setspecific(g_detachKey, env);

    return env;
}

struct Run
{
    pp_run *run = nullptr;
    jobject listener = nullptr; // global ref
};

void onEvent(const char *jsonEvent, void *userData)
{
    auto *r = static_cast<Run *>(userData);
    JNIEnv *env = envForThisThread();

    if (!env || !r->listener)
        return;

    jstring s = env->NewStringUTF(jsonEvent);

    env->CallVoidMethod(r->listener, g_onEvent, s);
    env->DeleteLocalRef(s);

    // A listener that threw must not leave the exception pending on an
    // engine thread.
    if (env->ExceptionCheck())
        env->ExceptionClear();
}

std::vector<std::string> toStrings(JNIEnv *env, jobjectArray args)
{
    std::vector<std::string> out;
    jsize n = env->GetArrayLength(args);

    for (jsize i = 0; i < n; i++)
    {
        auto s = static_cast<jstring>(env->GetObjectArrayElement(args, i));
        const char *chars = env->GetStringUTFChars(s, nullptr);

        out.emplace_back(chars);
        env->ReleaseStringUTFChars(s, chars);
        env->DeleteLocalRef(s);
    }

    return out;
}

using RunFn = int (*)(pp_run *, int, const char *const *);

jint callRun(JNIEnv *env, jlong handle, jobjectArray args, RunFn fn)
{
    auto *r = reinterpret_cast<Run *>(handle);
    std::vector<std::string> strings = toStrings(env, args);
    std::vector<const char *> argv;

    for (auto &s : strings)
        argv.push_back(s.c_str());

    return fn(r->run, static_cast<int>(argv.size()), argv.data());
}

} // namespace

extern "C" {

JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *)
{
    g_vm = vm;
    pthread_key_create(&g_detachKey, detachThread);

    JNIEnv *env = nullptr;

    if (vm->GetEnv(reinterpret_cast<void **>(&env), JNI_VERSION_1_6) != JNI_OK)
        return JNI_ERR;

    jclass listener = env->FindClass("com/peerpayload/connect/engine/EventListener");

    if (!listener)
        return JNI_ERR;

    g_onEvent = env->GetMethodID(listener, "onEvent", "(Ljava/lang/String;)V");

    return g_onEvent ? JNI_VERSION_1_6 : JNI_ERR;
}

#define NATIVE(name) Java_com_peerpayload_connect_engine_NativeEngine_##name

JNIEXPORT jint JNICALL NATIVE(protocolVersion)(JNIEnv *, jobject)
{
    return pp_protocol_version();
}

JNIEXPORT jlong JNICALL NATIVE(newRun)(JNIEnv *env, jobject, jobject listener)
{
    auto *r = new Run();

    r->listener = env->NewGlobalRef(listener);
    r->run = pp_run_new(onEvent, r);

    return reinterpret_cast<jlong>(r);
}

JNIEXPORT jint JNICALL NATIVE(runSender)(JNIEnv *env, jobject, jlong handle, jobjectArray args)
{
    return callRun(env, handle, args, pp_run_sender);
}

JNIEXPORT jint JNICALL NATIVE(runReceiver)(JNIEnv *env, jobject, jlong handle, jobjectArray args)
{
    return callRun(env, handle, args, pp_run_receiver);
}

JNIEXPORT jint JNICALL NATIVE(runKeygen)(JNIEnv *env, jobject, jlong handle, jobjectArray args)
{
    return callRun(env, handle, args, pp_run_keygen);
}

JNIEXPORT void JNICALL NATIVE(cancel)(JNIEnv *, jobject, jlong handle)
{
    pp_run_cancel(reinterpret_cast<Run *>(handle)->run);
}

// Only after the blocking run* call has returned (pp_run_free's contract).
JNIEXPORT void JNICALL NATIVE(free)(JNIEnv *env, jobject, jlong handle)
{
    auto *r = reinterpret_cast<Run *>(handle);

    pp_run_free(r->run);
    env->DeleteGlobalRef(r->listener);
    delete r;
}

} // extern "C"
