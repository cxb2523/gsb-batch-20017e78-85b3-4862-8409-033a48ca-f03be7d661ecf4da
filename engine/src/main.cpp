// inside-llm: loads GGUF models with llama.cpp and serves the web that shows
// what they do while they generate. --help lists the command line.
// Without -a it starts with nothing loaded and the browser picks the models.
#include "app.h"
#include "hf.h"
#include "lens.h"
#include "model.h"
#include "web_assets.h"

#include <algorithm>
#include <chrono>
#include <climits>
#include <cstdio>
#include <cstring>
#include <exception>
#include <filesystem>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>

#ifdef _WIN32
#include <windows.h>
#endif

namespace {

// Started by a double click, the console window closes as soon as the
// process ends: keep it open so the help or the error can be read. Only
// when the console is this process's alone, not in a terminal.
void pause_if_own_console() {
#ifdef _WIN32
    DWORD ids[2];
    if (GetConsoleProcessList(ids, 2) != 1) return;
    std::fprintf(stderr, "\npress Enter to close this window\n");
    std::getchar();
#endif
}

void print_help() {
    std::printf(
        "usage: inside-llm [-a <a.gguf> [-b <b.gguf>]] [options]\n"
        "\n"
        "Without -a the engine starts with no model: pick one in the browser, from the\n"
        "models folder (--models-dir) or downloaded from Hugging Face.\n"
        "\n"
        "  -a FILE               model A (GGUF), loaded at startup; any folder\n"
        "  -b FILE               model B (GGUF), to compare with A; same tokenizer\n"
        "  --ctx N               context size of each model (default 4096)\n"
        "  --gpu-layers-a N      layers of A on the GPU (default: all)\n"
        "  --gpu-layers-b N      layers of B on the GPU (default: all)\n"
        "  --snapshot-mem MIB    MiB of snapshots each model may keep in RAM (default 3072)\n"
        "  --lens                logit lens: what each layer would predict, projected on the CPU\n"
        "                        (about 2 GB of RAM per model and some 30 ms per step)\n"
        "  --lens-layers LIST    layers of the lens, from 0, like 0,6,12,23 (at most 16; implies\n"
        "                        --lens; default: 8 spread evenly, the last one included)\n"
        "%s"
        "  --help                show this help\n",
        ils::app_options_help());
}

// Value of the option at argv[i]; leaves i on the value.
const char* take_value(int argc, char** argv, int& i) {
    if (i + 1 >= argc) throw std::runtime_error(std::string("missing value for ") + argv[i]);
    return argv[++i];
}

int parse_int(const char* option, const char* text, int min) {
    size_t used = 0;
    int v = 0;
    try {
        v = std::stoi(text, &used);
    } catch (const std::exception&) {
        used = 0;
    }
    if (used == 0 || text[used] != '\0' || v < min)
        throw std::runtime_error(std::string("invalid value for ") + option + ": '" + text + "'");
    return v;
}

std::unique_ptr<ils::Model> load(const ils::LlamaOptions& o) {
    const std::string file = std::filesystem::path(o.path).filename().string();
    std::fprintf(stderr, "inside-llm: loading %s ...\n", file.c_str());
    const auto t0 = std::chrono::steady_clock::now();
    std::unique_ptr<ils::Model> model = ils::load_llama_model(o);
    const double s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    std::fprintf(stderr, "inside-llm: loaded %s in %.1f s\n", file.c_str(), s);
    return model;
}

}  // namespace

int main(int argc, char** argv) {
#ifdef _WIN32
    SetConsoleOutputCP(CP_UTF8);  // the code page is UTF-8 too (engine/win/inside-llm.manifest)
#endif
    // What every load starts from; the path, the GPU layers and the lens
    // threads are set per load.
    ils::LlamaOptions base;
    int gpu_layers_a = base.gpu_layers;
    int gpu_layers_b = base.gpu_layers;
    std::string path_a, path_b;
    ils::AppOptions app_opts;

    try {
        for (int i = 1; i < argc; ++i) {
            const char* arg = argv[i];
            if (std::strcmp(arg, "--help") == 0 || std::strcmp(arg, "-h") == 0) {
                print_help();
                return 0;
            } else if (std::strcmp(arg, "-a") == 0) {
                path_a = take_value(argc, argv, i);
            } else if (std::strcmp(arg, "-b") == 0) {
                path_b = take_value(argc, argv, i);
            } else if (std::strcmp(arg, "--ctx") == 0) {
                base.n_ctx = parse_int(arg, take_value(argc, argv, i), 1);
            } else if (std::strcmp(arg, "--gpu-layers-a") == 0) {
                gpu_layers_a = parse_int(arg, take_value(argc, argv, i), -1);
            } else if (std::strcmp(arg, "--gpu-layers-b") == 0) {
                gpu_layers_b = parse_int(arg, take_value(argc, argv, i), -1);
            } else if (std::strcmp(arg, "--snapshot-mem") == 0) {
                base.snapshot_mb = parse_int(arg, take_value(argc, argv, i), 0);
            } else if (std::strcmp(arg, "--lens") == 0) {
                base.lens = true;
            } else if (std::strcmp(arg, "--lens-layers") == 0) {
                base.lens = true;
                base.lens_layers = take_value(argc, argv, i);
                // The syntax now, before loading anything; the range once
                // the model says how many layers it has.
                try {
                    ils::parse_lens_layers(base.lens_layers, INT32_MAX);
                } catch (const std::invalid_argument& e) {
                    throw std::runtime_error(e.what());
                }
            } else if (!ils::parse_app_option(argc, argv, i, app_opts)) {
                throw std::runtime_error(std::string("unknown option: ") + arg);
            }
        }
        if (path_a.empty() && !path_b.empty()) throw std::runtime_error("-b needs -a");
    } catch (const std::exception& e) {
        std::fprintf(stderr, "inside-llm: %s (see --help)\n", e.what());
        pause_if_own_console();
        return 1;
    }

    ils::AppModels models;
    models.n_ctx = base.n_ctx;
    models.a = path_a;
    models.b = path_b;
    models.backend.load_model = [base, gpu_layers_a, gpu_layers_b](const std::string& path, int slot,
                                                                   int n_models) {
        ils::LlamaOptions o = base;
        o.path = path;
        o.gpu_layers = slot == 0 ? gpu_layers_a : gpu_layers_b;
        // A list that does not fit B is the case of two models with different
        // numbers of layers: the session turns the lens off with a warning.
        o.lens_optional = slot != 0;
        // With two models both project at the same time.
        const int cores = static_cast<int>(std::thread::hardware_concurrency());
        o.lens_threads = std::max(1, cores / std::max(1, n_models));
        return load(o);
    };
    models.backend.download = ils::hf_download;
    models.backend.gpu_memory = ils::dedicated_gpu_memory;

    try {
        const int rc = ils::run_app(app_opts, std::move(models), ils::embedded_web());
        if (rc != 0) pause_if_own_console();
        return rc;
    } catch (const std::exception& e) {
        std::fprintf(stderr, "inside-llm: error: %s\n", e.what());
        pause_if_own_console();
        return 1;
    }
}
