# SPDX-License-Identifier: Apache-2.0
cmake_minimum_required(VERSION 3.20)
project(mirror_sfu_worker C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

# Homebrew installs OpenSSL keg-only; find it without making contributors export paths.
if(APPLE AND NOT OPENSSL_ROOT_DIR AND NOT DEFINED ENV{OPENSSL_ROOT_DIR})
  execute_process(
    COMMAND brew --prefix openssl@3
    OUTPUT_VARIABLE BREW_OPENSSL
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET)
  if(BREW_OPENSSL)
    set(OPENSSL_ROOT_DIR ${BREW_OPENSSL})
  endif()
endif()

find_package(OpenSSL 3.0 REQUIRED)
find_package(PkgConfig REQUIRED)
pkg_check_modules(SRTP2 REQUIRED IMPORTED_TARGET libsrtp2)
pkg_check_modules(LIBUV REQUIRED IMPORTED_TARGET libuv)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_compile_definitions(_GNU_SOURCE)
endif()

add_library(sfucore STATIC
  src/json.c
  src/stun.c
  src/dtls.c
  src/rtp.c
  src/codec.c
  src/recorder.c
  src/net.c
  src/pacer.c
  src/room.c
  src/ipc.c)
target_include_directories(sfucore PUBLIC src)
target_link_libraries(sfucore PUBLIC OpenSSL::SSL OpenSSL::Crypto PkgConfig::SRTP2 PkgConfig::LIBUV)
target_compile_options(sfucore PRIVATE -Wall -Wextra -Wno-unused-parameter)

add_executable(sfu-worker src/main.c)
target_link_libraries(sfu-worker PRIVATE sfucore)
target_compile_options(sfu-worker PRIVATE -Wall -Wextra -Wno-unused-parameter)

enable_testing()
add_executable(sfu-tests tests/test_main.c)
target_link_libraries(sfu-tests PRIVATE sfucore)
add_test(NAME sfu-tests COMMAND sfu-tests)
