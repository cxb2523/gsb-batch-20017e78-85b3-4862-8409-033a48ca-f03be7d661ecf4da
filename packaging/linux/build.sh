#!/usr/bin/env bash
# Builds the portable Linux binary of one GPU backend and lays out its package
# folder. Runs in the dist stage of docker/Dockerfile (Ubuntu 22.04), from
# the repository root; `make dist-linux-cuda|vulkan` calls it.
#
#   packaging/linux/build.sh <cuda|vulkan> <version> <jobs> <cuda architectures>
#
#   build/dist-<backend>/inside-llm-v<version>-linux-<backend>/
#     inside-llm            stripped, RUNPATH $ORIGIN
#     libgomp.so.1          ggml's CPU threads
#     libcudart.so.12, libcublas.so.12, libcublasLt.so.12   (cuda only)
#     LICENSE, LICENSE.llama.cpp, LICENSE.libressl (TLS of the Hugging Face downloads),
#     LICENSE.GPL-3         libgomp's license (GPL-3.0 with the GCC Runtime Library Exception)
#     THIRD_PARTY_NOTICES   every third-party component and its license text
#
# libcuda.so.1 and libvulkan.so.1 are not packaged: the GPU driver brings them.
set -euo pipefail

backend=$1 version=$2 jobs=$3 arch=$4
case $backend in
  cuda) cmake_backend=CUDA ;;
  vulkan) cmake_backend=VULKAN ;;
  *) echo "backend must be cuda or vulkan" >&2; exit 1 ;;
esac
# The oldest glibc the package may need: Ubuntu 22.04's, Debian 12 has 2.36.
max_glibc=2.35

build=build/dist-$backend
pkg=$build/inside-llm-v$version-linux-$backend

mkdir -p "$build"
cmake -S . -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DILS_DIST=ON -DILS_BACKEND=$cmake_backend \
  "-DCMAKE_CUDA_ARCHITECTURES=$arch" >"$build/configure.log" 2>&1 \
  || { cat "$build/configure.log"; exit 1; }
cmake --build "$build" --target inside-llm -j "$jobs"

rm -rf "$pkg"
mkdir -p "$pkg"
strip -o "$pkg/inside-llm" "$build/inside-llm"
cp LICENSE "$pkg/LICENSE"
cp third_party/llama.cpp/LICENSE "$pkg/LICENSE.llama.cpp"
cp "$build/_deps/libressl-src/COPYING" "$pkg/LICENSE.libressl"
cp THIRD_PARTY_NOTICES "$pkg/THIRD_PARTY_NOTICES"
cp -L "$(gcc -print-file-name=libgomp.so.1)" "$pkg/"
cp /usr/share/common-licenses/GPL-3 "$pkg/LICENSE.GPL-3"
if [ "$backend" = cuda ]; then
  for lib in libcudart.so.12 libcublas.so.12 libcublasLt.so.12; do
    cp -L "/usr/local/cuda/lib64/$lib" "$pkg/"
  done
fi
chmod 0755 "$pkg/inside-llm"
chmod 0644 "$pkg"/*.so.* "$pkg"/LICENSE* "$pkg/THIRD_PARTY_NOTICES"

# ---------------------------------------------------------------- checks
fail=0
for f in "$pkg/inside-llm" "$pkg"/*.so.*; do
  need=$(objdump -T "$f" | grep -o 'GLIBC_[0-9][0-9.]*' | sed 's/GLIBC_//' | sort -Vu | tail -n 1)
  if [ "$(printf '%s\n%s\n' "$need" "$max_glibc" | sort -V | tail -n 1)" != "$max_glibc" ]; then
    echo "error: $(basename "$f") needs GLIBC_$need (at most $max_glibc)" >&2
    fail=1
  else
    echo "$(basename "$f"): GLIBC_$need"
  fi
done
if ! readelf -d "$pkg/inside-llm" | grep -E '\((RUNPATH|RPATH)\)' | grep -qF '[$ORIGIN]'; then
  echo "error: inside-llm has no RUNPATH \$ORIGIN" >&2
  readelf -d "$pkg/inside-llm" | grep -E 'RUNPATH|RPATH' >&2 || true
  fail=1
fi
[ $fail -eq 0 ]
du -sh "$pkg"/*
