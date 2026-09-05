cmake_minimum_required(VERSION 3.18.1)
project(nativesecurity CXX)

# libnativesecurity.so — existing checks (native-security.cpp) + popup HTML
# native payload loader (native-payload.cpp + crypto/). Existing sources ko
# chheda nahi gaya; naye sources additive hain.
add_library(nativesecurity SHARED
    native-security.cpp
    native-payload.cpp
    crypto/sha256.cpp
    crypto/aes.cpp
    crypto/payload_crypto.cpp
)

target_include_directories(nativesecurity PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

find_library(log-lib log)
target_link_libraries(nativesecurity ${log-lib})
