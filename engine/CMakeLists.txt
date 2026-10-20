# The transfer engine as a library: the sender and receiver programs'
# logic (sender/src/sender.cpp, receiver/src/receiver.cpp) plus a small C
# API (include/peerpayload.h). Compiled once, packaged two ways:
#
#   ppengine     static — linked into the sender/receiver executables
#   peerpayload  shared (.dll/.so) — for apps that load the engine
#                in-process, e.g. Android via JNI

add_library(ppengine_obj OBJECT
    ${PROJECT_SOURCE_DIR}/sender/src/sender.cpp
    ${PROJECT_SOURCE_DIR}/receiver/src/receiver.cpp
    src/peerpayload.cpp
)

set_target_properties(ppengine_obj PROPERTIES POSITION_INDEPENDENT_CODE ON)

target_include_directories(ppengine_obj PUBLIC include)
target_link_libraries(ppengine_obj PUBLIC shared Threads::Threads)

# Exports the C API from the DLL. Harmless in the static library too.
target_compile_definitions(ppengine_obj PRIVATE PEERPAYLOAD_BUILDING_DLL)

add_library(ppengine STATIC $<TARGET_OBJECTS:ppengine_obj>)
target_include_directories(ppengine PUBLIC include)
target_link_libraries(ppengine PUBLIC shared Threads::Threads)

add_library(peerpayload SHARED $<TARGET_OBJECTS:ppengine_obj>)
target_include_directories(peerpayload PUBLIC include)
target_link_libraries(peerpayload PRIVATE shared Threads::Threads)

if(WIN32)
    target_link_libraries(ppengine PUBLIC ws2_32)
    target_link_libraries(peerpayload PRIVATE ws2_32)

    # Same reasoning as the executables: no MinGW runtime DLLs needed
    # next to peerpayload.dll (OpenSSL is linked statically via shared/).
    target_link_options(peerpayload PRIVATE -static)
else()
    target_link_options(peerpayload PRIVATE -static-libgcc -static-libstdc++)
endif()

# In-process tests of the C API (concurrent runs, event routing, cancel).
add_executable(engine_lib_test test/lib_test.cpp)
target_link_libraries(engine_lib_test PRIVATE ppengine Threads::Threads)

if(WIN32)
    target_link_options(engine_lib_test PRIVATE -static)
endif()
