cmake_minimum_required(VERSION 3.18.1)
project(nativesecurity CXX)

add_library(nativesecurity SHARED native-security.cpp)

find_library(log-lib log)
target_link_libraries(nativesecurity ${log-lib})
