add_executable(sender
    src/main.cpp
)

target_link_libraries(sender
    PRIVATE
    shared
    Threads::Threads
)

if(WIN32)
    target_link_libraries(sender PRIVATE ws2_32)

    # std::thread pulls in libwinpthread-1.dll dynamically by default on
    # MinGW, so the exe would only run on a machine with MSYS2's bin/ on
    # PATH — a silent trap for anything that spawns this as a subprocess
    # (the backend does) on a machine without that toolchain installed.
    # -static also happens to statically link OpenSSL (see shared/
    # CMakeLists.txt), making the binary fully self-contained.
    target_link_options(sender PRIVATE -static)
else()
    # Full -static on Linux risks the classic glibc/NSS problem (a fully
    # static binary's getaddrinfo() can silently fail to load NSS modules
    # for DNS resolution). Static libgcc/libstdc++ is the safe subset —
    # it removes the compiler-runtime DLL dependency without touching how
    # the binary talks to the system's name resolution.
    target_link_options(sender PRIVATE -static-libgcc -static-libstdc++)
endif()