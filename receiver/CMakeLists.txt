add_executable(receiver
    src/main.cpp
)

# All the logic is in the engine library (engine/); src/main.cpp is just
# main() calling it, so the program and the library can't drift apart.
target_link_libraries(receiver
    PRIVATE
    ppengine
    Threads::Threads
)

if(WIN32)
    target_link_libraries(receiver PRIVATE ws2_32)

    # See sender/CMakeLists.txt for why -static and its OpenSSL side effect.
    target_link_options(receiver PRIVATE -static)
else()
    # See sender/CMakeLists.txt: full -static is unsafe for getaddrinfo()
    # on glibc, so only the compiler runtime is statically linked here.
    target_link_options(receiver PRIVATE -static-libgcc -static-libstdc++)
endif()