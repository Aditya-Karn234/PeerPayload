find_package(OpenSSL REQUIRED COMPONENTS SSL Crypto)

add_library(shared INTERFACE)

target_include_directories(shared
    INTERFACE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
)

if(WIN32)
    target_include_directories(shared INTERFACE ${OPENSSL_INCLUDE_DIR})

    # MSYS2's OpenSSLConfig.cmake always resolves OpenSSL::SSL/OpenSSL::Crypto
    # to the .dll.a import libraries regardless of OPENSSL_USE_STATIC_LIBS, so
    # the static .a files are referenced directly here instead — same
    # motivation as the -static link flag on sender/receiver for the pthread
    # runtime: the built exes shouldn't need OpenSSL's DLLs on PATH to run.
    # crypt32/bcrypt are what OpenSSL 3.x's static libcrypto needs from
    # Windows for its certificate store and RNG calls. None of this applies
    # on Linux, where dynamic linking against the system libssl/libcrypto is
    # the normal, expected thing to do — see the else() branch.
    find_library(OPENSSL_SSL_STATIC_LIB NAMES libssl.a PATHS ${OPENSSL_INCLUDE_DIR}/../lib REQUIRED)
    find_library(OPENSSL_CRYPTO_STATIC_LIB NAMES libcrypto.a PATHS ${OPENSSL_INCLUDE_DIR}/../lib REQUIRED)

    target_link_libraries(shared
        INTERFACE
        ${OPENSSL_SSL_STATIC_LIB}
        ${OPENSSL_CRYPTO_STATIC_LIB}
        ws2_32
        crypt32
        bcrypt
    )
else()
    target_link_libraries(shared
        INTERFACE
        OpenSSL::SSL
        OpenSSL::Crypto
    )
endif()