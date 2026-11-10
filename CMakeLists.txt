# 3.13: object libraries with target_link_libraries (engine/).
cmake_minimum_required(VERSION 3.13)

project(DataTransferSystem CXX)

# std::filesystem needs C++17; don't leave it to whatever the compiler
# happens to default to.
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# MinGW's std::thread/std::mutex are backed by winpthreads and need explicit
# linkage — without this, thread creation fails at link or at runtime.
set(THREADS_PREFER_PTHREAD_FLAG ON)
find_package(Threads REQUIRED)

add_subdirectory(shared)
add_subdirectory(engine)
add_subdirectory(sender)
add_subdirectory(receiver)