#!/usr/bin/env bash
# Checks a Linux package folder in a clean container of the oldest supported
# distribution (ubuntu:22.04, nothing installed): every library the binary
# needs is either in the folder or in the base system, except the two the GPU
# driver brings. `make dist-linux-cuda|vulkan` calls it.
#
#   packaging/linux/check.sh <package folder>
set -euo pipefail

out=$(ldd "$1/inside-llm")
echo "$out"
missing=$(echo "$out" | grep 'not found' | grep -v -E '^\s*(libcuda\.so\.1|libvulkan\.so\.1) ' || true)
if [ -n "$missing" ]; then
  echo "error: libraries not found:" >&2
  echo "$missing" >&2
  exit 1
fi
