cmake_minimum_required(VERSION 3.18.1)

project("zayrosecurity")

add_library(zayrosecurity SHARED native-lib.cpp)

find_library(log-lib log)

target_link_libraries(zayrosecurity ${log-lib})
