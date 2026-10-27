cmake_minimum_required(VERSION 3.20)
project(TimiBot VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include(FetchContent)
set(DPP_BUILD_TEST OFF CACHE BOOL "" FORCE)
set(DPP_BUILD_VOICE OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
  dpp
  GIT_REPOSITORY https://github.com/brainboxdotcc/DPP.git
  GIT_TAG v10.1.3
)
FetchContent_MakeAvailable(dpp)

add_executable(timi src/main.cpp)
target_link_libraries(timi PRIVATE dpp)
target_compile_options(timi PRIVATE -Wall -Wextra -Wpedantic)
