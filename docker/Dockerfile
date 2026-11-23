# Toolchain images only. The repository is mounted at /work; the build tree
# lives in build/ and the web dependencies in web/node_modules, so llama.cpp
# is compiled once and reused. Nothing is distributed as an image: the dist
# stage builds the native Linux packages (packaging/linux/build.sh).
ARG CUDA_TAG=12.9.2-devel-ubuntu24.04
ARG DIST_CUDA_TAG=12.9.2-devel-ubuntu22.04
ARG NODE_TAG=24-bookworm-slim
ARG VULKAN_SDK_VERSION=1.4.357.0
ARG VULKAN_SDK_SHA256=0f09bf6a0625e346bf004be70b92907e934a4c76606b323441b2baf3a5a0e66d

# Web stage: Node for Vite, Vitest and svelte-check.
FROM node:${NODE_TAG} AS web
WORKDIR /work/web

# Build stage: C++ toolchain with CUDA and Vulkan. ILS_BACKEND=VULKAN needs
# the Vulkan loader (Ubuntu's), and the headers, glslc and SPIRV-Headers of
# the LunarG SDK: Ubuntu 24.04's glslc lacks the extensions of ggml-vulkan's
# fast shaders (NV_cooperative_matrix2, integer dot product, bfloat16).
# NVIDIA's Vulkan driver in a container without a display (make test-gpu
# BACKEND=vulkan): the toolkit mounts it with an ICD file for libGLX_nvidia,
# which fails in vkCreateInstance there; a second ICD file for
# libEGL_nvidia works (ggml-vulkan drops a device seen twice). libX11 and
# libXext are dependencies of those libraries.
FROM nvidia/cuda:${CUDA_TAG} AS build
ARG VULKAN_SDK_VERSION
ARG VULKAN_SDK_SHA256

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build git curl ca-certificates zlib1g-dev xz-utils libvulkan-dev \
      libx11-6 libxext6 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /usr/share/vulkan/icd.d \
 && printf '{"file_format_version": "1.0.1", "ICD": {"library_path": "libEGL_nvidia.so.0", "api_version": "1.3.0"}}\n' \
      > /usr/share/vulkan/icd.d/nvidia_egl_icd.json

RUN curl -fsSL -o /tmp/vulkan_sdk.tar.xz \
      https://sdk.lunarg.com/sdk/download/${VULKAN_SDK_VERSION}/linux/vulkan_sdk.tar.xz \
 && echo "${VULKAN_SDK_SHA256}  /tmp/vulkan_sdk.tar.xz" | sha256sum -c - \
 && mkdir -p /opt/vulkan-sdk \
 && tar -xJf /tmp/vulkan_sdk.tar.xz -C /opt/vulkan-sdk --strip-components=2 \
      ${VULKAN_SDK_VERSION}/x86_64/bin/glslc \
      ${VULKAN_SDK_VERSION}/x86_64/include/vulkan \
      ${VULKAN_SDK_VERSION}/x86_64/include/vk_video \
      ${VULKAN_SDK_VERSION}/x86_64/include/spirv \
      ${VULKAN_SDK_VERSION}/x86_64/share/cmake/SPIRV-Headers \
 && rm /tmp/vulkan_sdk.tar.xz
ENV VULKAN_SDK=/opt/vulkan-sdk
ENV PATH=/opt/vulkan-sdk/bin:${PATH}

WORKDIR /work

# Dist stage: the same toolchain on Ubuntu 22.04, so the packaged binary asks
# for glibc 2.35 at most (a binary built on an older distribution runs on the
# newer ones, not the other way round). Ubuntu 22.04's CMake is 3.22 and the
# project needs 3.24: Kitware's official binary instead. The LunarG glslc
# again, never Ubuntu's (see the build stage).
FROM nvidia/cuda:${DIST_CUDA_TAG} AS dist
ARG VULKAN_SDK_VERSION
ARG VULKAN_SDK_SHA256
ARG CMAKE_VERSION=3.31.12
ARG CMAKE_SHA256=0dc2e9a6860f06bf10bd8fadc03e35d9eeb4df46e33763a7e480e987758f385c

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential ninja-build git curl ca-certificates zlib1g-dev xz-utils libvulkan-dev \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL -o /tmp/cmake.tar.gz \
      https://github.com/Kitware/CMake/releases/download/v${CMAKE_VERSION}/cmake-${CMAKE_VERSION}-linux-x86_64.tar.gz \
 && echo "${CMAKE_SHA256}  /tmp/cmake.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/cmake \
 && tar -xzf /tmp/cmake.tar.gz -C /opt/cmake --strip-components=1 \
 && rm /tmp/cmake.tar.gz

RUN curl -fsSL -o /tmp/vulkan_sdk.tar.xz \
      https://sdk.lunarg.com/sdk/download/${VULKAN_SDK_VERSION}/linux/vulkan_sdk.tar.xz \
 && echo "${VULKAN_SDK_SHA256}  /tmp/vulkan_sdk.tar.xz" | sha256sum -c - \
 && mkdir -p /opt/vulkan-sdk \
 && tar -xJf /tmp/vulkan_sdk.tar.xz -C /opt/vulkan-sdk --strip-components=2 \
      ${VULKAN_SDK_VERSION}/x86_64/bin/glslc \
      ${VULKAN_SDK_VERSION}/x86_64/include/vulkan \
      ${VULKAN_SDK_VERSION}/x86_64/include/vk_video \
      ${VULKAN_SDK_VERSION}/x86_64/include/spirv \
      ${VULKAN_SDK_VERSION}/x86_64/share/cmake/SPIRV-Headers \
 && rm /tmp/vulkan_sdk.tar.xz \
 && /opt/vulkan-sdk/bin/glslc --version
ENV VULKAN_SDK=/opt/vulkan-sdk
ENV PATH=/opt/cmake/bin:/opt/vulkan-sdk/bin:${PATH}

WORKDIR /work
