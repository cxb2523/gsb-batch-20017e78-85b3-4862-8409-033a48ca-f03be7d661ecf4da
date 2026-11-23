# Everyday commands. Everything runs inside Docker; nothing is installed on the host.

CUDA_TAG  := 12.9.2-devel-ubuntu24.04
NODE_TAG  := 24-bookworm-slim
IMAGE     := inside-llm-build:2
WEB_IMAGE := inside-llm-web:1
# Headless Chromium for `make web-shots`. The npm package of the same version
# is installed inside the container, not in web/package.json.
PLAYWRIGHT := 1.56.1
SHOTS_IMAGE := mcr.microsoft.com/playwright:v$(PLAYWRIGHT)-noble
# Toolchain of the distributable Linux packages (Ubuntu 22.04, glibc 2.35).
DIST_CUDA_TAG := 12.9.2-devel-ubuntu22.04
DIST_IMAGE := inside-llm-dist:1
# The version comes from CMakeLists.txt only: project(inside_llm VERSION x.y.z).
VERSION   := $(shell sed -nE 's/^project.inside_llm VERSION ([0-9.]+).*/\1/p' CMakeLists.txt)
# GPU backend of the development build: cuda (build/app) or vulkan
# (build/app-vulkan), e.g. make test-gpu BACKEND=vulkan.
BACKEND   ?= cuda
ifeq ($(BACKEND),vulkan)
BUILD     := build/app-vulkan
CMAKE_BACKEND := -DILS_BACKEND=VULKAN
# Vulkan on an NVIDIA card needs the driver's graphics libraries in the container.
GPU_CAPS  := -e NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics
else ifeq ($(BACKEND),cuda)
BUILD     := build/app
CMAKE_BACKEND := -DILS_BACKEND=CUDA
GPU_CAPS  :=
else
$(error BACKEND must be cuda or vulkan)
endif
PORT      ?= 8642
WEB_PORT  ?= 5173
STATIC_PORT ?= 4173
# What `make test-e2e` runs: every e2e file, or one (E2E=src/e2e/gates.e2e.test.ts).
E2E       ?= src/e2e
# CUDA architecture of the kernels. Fixed (RTX 50, Blackwell) because the
# build runs without the GPU and nvcc cannot resolve "native" then. For another
# card: make build CUDA_ARCH=89-real (RTX 40), 86-real (RTX 30)...
CUDA_ARCH ?= 120-real

DOCKER := docker run --rm -u $(shell id -u):$(shell id -g) -e HOME=/tmp \
          -v $(CURDIR):/work -w /work
# Compiling, unit tests and the fake engine never touch the GPU.
RUN_CPU := $(DOCKER) -e NVIDIA_VISIBLE_DEVICES=void $(IMAGE)
RUN_GPU := $(DOCKER) --gpus all $(GPU_CAPS) $(IMAGE)
NODE    := $(DOCKER) -w /work/web $(WEB_IMAGE)

# Origins of the Vite dev server, accepted by the engine while developing.
DEV_ORIGINS := --allow-origin http://localhost:$(WEB_PORT) --allow-origin http://127.0.0.1:$(WEB_PORT)

# <hugging face repo>/<file>
MODELS := \
  unsloth/Qwen3.5-0.8B-GGUF/Qwen3.5-0.8B-Q4_K_M.gguf \
  unsloth/Qwen3.5-0.8B-GGUF/Qwen3.5-0.8B-Q8_0.gguf \
  unsloth/Qwen3.5-2B-GGUF/Qwen3.5-2B-UD-Q2_K_XL.gguf \
  unsloth/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q8_0.gguf \
  bartowski/Qwen_Qwen3.5-4B-GGUF/Qwen_Qwen3.5-4B-Q2_K.gguf \
  bartowski/Qwen_Qwen3.5-4B-GGUF/Qwen_Qwen3.5-4B-Q8_0.gguf \
  bartowski/google_gemma-4-E4B-it-GGUF/google_gemma-4-E4B-it-Q2_K.gguf

.PHONY: image models build web-deps web-build engine-build run run-fake web-dev \
        test test-unit test-engine test-web test-e2e test-gpu golden
.PHONY: web-static web-static-serve web-shots

# Builds the three toolchain images: build (development), web and dist.
image:
	docker build -t $(IMAGE) --target build --build-arg CUDA_TAG=$(CUDA_TAG) -f docker/Dockerfile docker
	docker build -t $(WEB_IMAGE) --target web --build-arg NODE_TAG=$(NODE_TAG) -f docker/Dockerfile docker
	docker build -t $(DIST_IMAGE) --target dist --build-arg DIST_CUDA_TAG=$(DIST_CUDA_TAG) -f docker/Dockerfile docker

# Downloads the GGUF files into models/ (resumable).
models:
	$(DOCKER) $(IMAGE) bash docker/fetch-models.sh $(MODELS)

# ------------------------------------------------------------------ build

# Configures and builds CMake targets ($(1), empty for all) without the GPU.
# The lock lets several builds be requested at once without clashing.
define cmake_build
@mkdir -p $(BUILD)
flock $(BUILD)/.lock $(RUN_CPU) bash -c '\
  cmake -S . -B $(BUILD) -G Ninja -DCMAKE_BUILD_TYPE=Release $(CMAKE_BACKEND) \
    -DCMAKE_CUDA_ARCHITECTURES=$(CUDA_ARCH) >$(BUILD)/configure.log 2>&1 \
    || { cat $(BUILD)/configure.log; exit 1; }; \
  cmake --build $(BUILD) $(if $(1),--target $(1),)'
endef

web/node_modules/.stamp: web/package.json web/package-lock.json
	$(NODE) npm ci
	@touch $@

web-deps: web/node_modules/.stamp

# Compiles the web into web/dist.
web-build: web-deps
	$(NODE) npm run build

# Static web, without engine: the gallery of sessions/index.json and the
# replays of the sessions it lists, in web/dist-static. Nothing is published.
web-static: web-deps
	$(DOCKER) -w /work/web -e VITE_ILS_STATIC=1 $(WEB_IMAGE) npx vite build --outDir dist-static --emptyOutDir
	$(NODE) node scripts/static-sessions.mjs dist-static

# Serves web/dist-static on http://localhost:$(STATIC_PORT) (after `make web-static`).
web-static-serve: web-deps
	@test -f web/dist-static/index.html || { echo "run make web-static first"; exit 1; }
	$(DOCKER) --init -p 127.0.0.1:$(STATIC_PORT):$(STATIC_PORT) -w /work/web $(WEB_IMAGE) \
	  npx vite preview --outDir dist-static --host 0.0.0.0 --port $(STATIC_PORT) --strictPort

# Compiles engine targets only: make engine-build T="unit_tests"
engine-build:
	$(call cmake_build,$(T))

# Screenshots of the recorded sessions in web/$(SHOTS_OUT), with headless
# Chromium and no engine: the visual check of the interface. SHOTS='[{...}]'
# picks other shots (see web/scripts/shots.mjs).
SHOTS_OUT ?= .shots
web-shots: web-deps
	$(DOCKER) --init --ipc=host -w /work/web -e SHOTS -e VITE_ILS_STATIC -e SHOTS_OUT=$(SHOTS_OUT) $(SHOTS_IMAGE) sh -c \
	  'mkdir -p /tmp/pw && cd /tmp/pw && npm i --silent --no-audit --no-fund playwright@$(PLAYWRIGHT) >/dev/null && cd /work/web && node scripts/shots.mjs'

# Compiles the web and the binary (the web is embedded in it).
build: web-build
	$(call cmake_build,)

# -------------------------------------------------------------------- run

# Starts the engine: make run [A=<file in models/> [B=<file in models/>]] [ARGS="--ctx 8192"]
# Without A it starts with no model and the web opens the model picker over
# models/ (the --models-dir default, inside the mounted repo). B is the second
# model, to compare with A. HF_TOKEN and HF_ENDPOINT, if set, reach the
# engine's downloads. The port is published on 127.0.0.1 only. Ctrl-C stops it.
ENGINE_MODELS = $(if $(A),-a models/$(A) $(if $(B),-b models/$(B),),)
run:
	@test -z "$(B)" || test -n "$(A)" || { echo "B needs A: make run A=<file> B=<file>"; exit 1; }
	$(DOCKER) --gpus all $(GPU_CAPS) --init -e HF_TOKEN -e HF_ENDPOINT -p 127.0.0.1:$(PORT):$(PORT) $(IMAGE) \
	  $(BUILD)/inside-llm $(ENGINE_MODELS) --host 0.0.0.0 --port $(PORT) --no-browser $(ARGS)

# Starts the engine with a scripted fake model: no GGUF and no GPU. For
# developing and testing the web and the server. Its models folder is
# build/fake-models (fixture GGUFs; downloads are simulated). ARGS=--empty
# starts with nothing loaded, ARGS=--pair with two models.
run-fake:
	$(DOCKER) -e NVIDIA_VISIBLE_DEVICES=void --init -p 127.0.0.1:$(PORT):$(PORT) $(IMAGE) \
	  $(BUILD)/fake_engine --host 0.0.0.0 --port $(PORT) --no-browser $(DEV_ORIGINS) $(ARGS)

# Vite dev server on http://localhost:$(WEB_PORT), forwarding /ws and /api to
# the engine. With A=<file> [B=<file>] it also starts the engine with those
# models, and with LIVE=1 it starts it with none (the web's model picker);
# otherwise only Vite (enough for ?session=… and for an engine started elsewhere).
DEV_ENGINE = $(if $(or $(A),$(LIVE)),1,)
web-dev: web-deps
ifneq ($(DEV_ENGINE),)
	-docker rm -f inside-llm-dev >/dev/null 2>&1
	$(DOCKER) --gpus all $(GPU_CAPS) --init -d --name inside-llm-dev -e HF_TOKEN -e HF_ENDPOINT -p 127.0.0.1:$(PORT):$(PORT) $(IMAGE) \
	  $(BUILD)/inside-llm $(ENGINE_MODELS) --host 0.0.0.0 --port $(PORT) --no-browser $(DEV_ORIGINS) $(ARGS)
endif
	-$(DOCKER) --network host -e ILS_ENGINE=http://127.0.0.1:$(PORT) -w /work/web $(WEB_IMAGE) \
	  npm run dev -- --host 127.0.0.1 --port $(WEB_PORT) --strictPort
ifneq ($(DEV_ENGINE),)
	-docker rm -f inside-llm-dev >/dev/null 2>&1
endif

# ------------------------------------------------------------------- test

# Engine unit tests and the golden contract: no model, no GPU.
test-engine:
	$(call cmake_build,unit_tests)
	$(RUN_CPU) ctest --test-dir $(BUILD) -LE gpu --output-on-failure

# Type check and Vitest.
test-web: web-deps
	$(NODE) npm run check
	$(NODE) npm test

test-unit: test-engine test-web

# Acceptance checks of the protocol against an engine that is already running
# on $(PORT) (`make run` or `make run-fake`). SAVE=<file> records a sample
# session: pass E2E=<one file> with it, since two of them record.
# ENGINE=<url> points at another engine (e.g. the Windows VM); off the GPU,
# MIN_STEPS=<steps/s> and RESUME_MS=<ms> relax the two speed thresholds.
ENGINE ?= http://127.0.0.1:$(PORT)
test-e2e: web-deps
	$(DOCKER) --network host -e ILS_ENGINE_URL=$(ENGINE) -e ILS_SAVE=$(SAVE) \
	  $(if $(MIN_STEPS),-e ILS_MIN_STEPS=$(MIN_STEPS)) $(if $(RESUME_MS),-e ILS_RESUME_MS=$(RESUME_MS)) \
	  -w /work/web $(WEB_IMAGE) npx vitest run --no-file-parallelism $(E2E)

# Integration tests with the test model, on the GPU (BACKEND=vulkan: with Vulkan).
test-gpu:
	$(call cmake_build,gpu_tests)
	$(RUN_GPU) ctest --test-dir $(BUILD) -L gpu --output-on-failure

test: test-unit test-gpu

# Rewrites the synthetic sessions of sessions/golden/ after a protocol change.
golden:
	$(call cmake_build,test_golden)
	$(RUN_CPU) $(BUILD)/test_golden --write sessions/golden

# ------------------------------------------------------------------- dist

# Native Linux packages:
#   dist/inside-llm-v$(VERSION)-linux-cuda.tar.gz, ...-linux-vulkan.tar.gz
# Portable binary (ILS_DIST: no -march=native, no NCCL, RUNPATH $ORIGIN)
# compiled on Ubuntu 22.04 ($(DIST_IMAGE)) with the libraries it carries next
# to it; packaging/linux/build.sh fails if anything needs a glibc newer than
# 2.35, packaging/linux/check.sh if ldd in a clean ubuntu:22.04 finds a
# missing library other than libcuda.so.1 / libvulkan.so.1 (the driver's).
# The Windows zips are built natively with packaging/windows/build.ps1;
# `make dist-sums` writes dist/SHA256SUMS of the four.
# CUDA kernels for Turing (RTX 20) to Blackwell (RTX 50).
DIST_CUDA_ARCH ?= 75-real;80-real;86-real;89-real;120a-real
# nvcc compiling several architectures takes 1-2 GB per job: few jobs.
DIST_JOBS ?= 6

.PHONY: dist-linux-cuda dist-linux-vulkan dist-sums

# $(1): cuda|vulkan.
define dist_linux
@docker image inspect $(DIST_IMAGE) >/dev/null 2>&1 || { echo "$(DIST_IMAGE) is missing: run make image"; exit 1; }
@mkdir -p build/dist-$(1) dist
flock build/dist-$(1)/.lock $(DOCKER) -e NVIDIA_VISIBLE_DEVICES=void $(DIST_IMAGE) \
  bash packaging/linux/build.sh $(1) $(VERSION) $(DIST_JOBS) "$(DIST_CUDA_ARCH)"
docker run --rm -v $(CURDIR):/work:ro -w /work ubuntu:22.04 \
  bash packaging/linux/check.sh build/dist-$(1)/inside-llm-v$(VERSION)-linux-$(1)
tar -czf dist/inside-llm-v$(VERSION)-linux-$(1).tar.gz --owner=0 --group=0 --numeric-owner \
  -C build/dist-$(1) inside-llm-v$(VERSION)-linux-$(1)
@ls -lh dist/inside-llm-v$(VERSION)-linux-$(1).tar.gz
endef

dist-linux-cuda: web-build
	$(call dist_linux,cuda)

dist-linux-vulkan: web-build
	$(call dist_linux,vulkan)

# dist/SHA256SUMS of the four packages of this version: sha256sum -c SHA256SUMS.
DIST_FILES = inside-llm-v$(VERSION)-linux-cuda.tar.gz inside-llm-v$(VERSION)-linux-vulkan.tar.gz \
             inside-llm-v$(VERSION)-windows-cuda.zip inside-llm-v$(VERSION)-windows-vulkan.zip
dist-sums:
	cd dist && sha256sum $(DIST_FILES) > SHA256SUMS
	@cat dist/SHA256SUMS

# Optional local targets.
-include media.mk
