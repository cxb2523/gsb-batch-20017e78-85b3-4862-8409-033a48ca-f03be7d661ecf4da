// The engine with the scripted fake model: the real server, the real hub and
// the real web, without a real GGUF, without the GPU and offline. For
// developing and testing the web.
//
//   fake_engine [app options] [--delay-ms N] [--eos-after N] [--ctx N] [--snapshot-mem MIB]
//               [--pair | --empty] [--lens] [--load-ms N]
//
// The models folder (default build/fake-models) gets GGUF files with
// metadata only (gguf_fixture.h), padded with a sparse hole to a realistic
// size. Loading one of them gives a FakeModel; a file with another tokenizer
// gives a FakeModel with another vocabulary. Downloads are simulated: about
// 3 s of progress, then a fixture GGUF under the requested name (a repo
// whose name has "fail" in it fails halfway).
#include "app.h"
#include "catalog.h"
#include "fake_model.h"
#include "gguf_fixture.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <exception>
#include <filesystem>
#include <fstream>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>

namespace {

namespace fs = std::filesystem;

constexpr uint64_t kMiB = 1ull << 20;
constexpr uint64_t kGpuTotal = 16384 * kMiB;  // a 16 GB card
constexpr uint64_t kGpuOther = 1200 * kMiB;   // taken by the desktop and other programs

void usage() {
    std::printf("usage: fake_engine [options]\n\n%s"
                "  --delay-ms N          milliseconds added to every decode (default 5)\n"
                "  --eos-after N         <eos> wins after N generated tokens (default 0: never)\n"
                "  --ctx N               context size (default 4096)\n"
                "  --snapshot-mem MIB    MiB of snapshots each model may keep (default 0: unlimited)\n"
                "  --pair                load two fake models at startup; B disagrees now and then\n"
                "                        and cannot trim its context (approximate placements)\n"
                "  --empty               load nothing at startup: the browser picks the models\n"
                "  --lens                a synthetic logit lens in every EVAL\n"
                "  --load-ms N           milliseconds a load takes (default 800)\n"
                "\nThe models folder defaults to build/fake-models.\n",
                ils::app_options_help());
}

int to_int(const std::string& name, const char* v) {
    size_t used = 0;
    int n = -1;
    try {
        n = std::stoi(v, &used);
    } catch (const std::exception&) {
        used = 0;
    }
    if (used == 0 || v[used] != '\0' || n < 0) throw std::runtime_error(name + " must be a number >= 0");
    return n;
}

// A fixture GGUF, then a sparse hole up to `size` bytes: the catalog shows
// a believable size and VRAM estimate, and the disk holds a few KB.
void write_fixture(const fs::path& path, const ils::FixtureGguf& f, uint64_t size) {
    ils::write_fixture_gguf(path, f);
    if (fs::file_size(path) < size) fs::resize_file(path, size);
}

ils::FixtureGguf small_family(const std::string& name, int32_t file_type) {
    ils::FixtureGguf f;
    f.name = name;
    f.size_label = "1B";
    f.file_type = file_type;
    f.n_layer = 16;
    f.head_count_kv = {8};
    f.n_head = 32;
    f.n_embd = 2048;
    return f;
}

// The folder's starting files; existing ones are left alone.
void fill_models_dir(const fs::path& dir) {
    fs::create_directories(dir);
    auto add = [&](const char* file, const ils::FixtureGguf& f, uint64_t size) {
        if (!fs::exists(dir / file)) write_fixture(dir / file, f, size);
    };
    add("fake-small-Q8_0.gguf", small_family("Fake Small", 7), 1310 * kMiB);
    add("fake-small-Q2_K.gguf", small_family("Fake Small", 10), 560 * kMiB);

    ils::FixtureGguf other;
    other.name = "Other Family";
    other.size_label = "3B";
    other.file_type = 15;  // Q4_K_M
    other.n_layer = 28;
    other.head_count_kv = {4};
    other.n_head = 24;
    other.n_embd = 3072;
    other.tok_model = "llama";
    other.tokens = {"<s>", "</s>", "x", "y", "z", "w"};
    add("other-family-Q4_K_M.gguf", other, 2020 * kMiB);

    // A file whose header cannot be read: listed with an error, fails to load.
    if (!fs::exists(dir / "broken-Q4_0.gguf")) {
        std::ofstream(dir / "broken-Q4_0.gguf", std::ios::binary) << "not a gguf file";
    }
}

// A FakeModel that gives its pretend VRAM back when freed.
class CountedFake : public ils::FakeModel {
public:
    CountedFake(ils::FakeOptions o, std::atomic<uint64_t>& used, uint64_t bytes)
        : FakeModel(std::move(o)), used_(used), bytes_(bytes) {
        used_ += bytes_;
    }
    ~CountedFake() override { used_ -= bytes_; }

private:
    std::atomic<uint64_t>& used_;
    uint64_t bytes_;
};

}  // namespace

int main(int argc, char** argv) {
    ils::AppOptions opts;
    opts.models_dir = "build/fake-models";
    ils::FakeOptions fake;
    fake.delay_ms = 5;
    bool pair = false;
    bool empty = false;
    int load_ms = 800;
    try {
        for (int i = 1; i < argc; ++i) {
            const std::string a = argv[i];
            if (ils::parse_app_option(argc, argv, i, opts)) continue;
            if (a == "-h" || a == "--help") {
                usage();
                return 0;
            }
            if (a == "--pair") {
                pair = true;
                continue;
            }
            if (a == "--empty") {
                empty = true;
                continue;
            }
            if (a == "--lens") {
                fake.lens = true;
                continue;
            }
            if ((a == "--delay-ms" || a == "--eos-after" || a == "--ctx" || a == "--snapshot-mem" ||
                 a == "--load-ms") &&
                i + 1 < argc) {
                const int n = to_int(a, argv[++i]);
                if (a == "--delay-ms") fake.delay_ms = n;
                else if (a == "--eos-after") fake.eos_after = static_cast<uint32_t>(n);
                else if (a == "--snapshot-mem") fake.snapshot_limit = static_cast<size_t>(n) << 20;
                else if (a == "--load-ms") load_ms = n;
                else if (n > 0) fake.n_ctx = static_cast<uint32_t>(n);
                else throw std::runtime_error("--ctx must be > 0");
                continue;
            }
            throw std::runtime_error("unknown or incomplete option: " + a);
        }
        if (pair && empty) throw std::runtime_error("--pair and --empty do not go together");
    } catch (const std::exception& e) {
        std::fprintf(stderr, "error: %s\n\n", e.what());
        usage();
        return 2;
    }

    const fs::path dir = opts.models_dir;
    try {
        fill_models_dir(dir);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "error: cannot fill the models folder %s: %s\n", dir.string().c_str(), e.what());
        return 1;
    }
    const int n_ctx = static_cast<int>(fake.n_ctx);
    // The tokenizer of the FakeModel's own vocabulary; any other gets one more token.
    const std::string base_tok = ils::read_gguf_header(dir / "fake-small-Q8_0.gguf", n_ctx).tok;
    auto used = std::make_shared<std::atomic<uint64_t>>(0);

    ils::AppModels models;
    models.n_ctx = n_ctx;
    if (!empty) {
        models.a = (dir / "fake-small-Q8_0.gguf").string();
        if (pair) models.b = (dir / "fake-small-Q2_K.gguf").string();
    }
    models.backend.load_model = [fake, base_tok, used, load_ms, n_ctx](const std::string& path, int slot,
                                                                     int) -> std::unique_ptr<ils::Model> {
        std::this_thread::sleep_for(std::chrono::milliseconds(load_ms));
        const std::string file = fs::path(path).filename().string();
        const ils::CatalogEntry e = ils::read_gguf_header(path, n_ctx);
        if (!e.error.empty()) throw std::runtime_error("cannot load " + file + ": " + e.error);
        ils::FakeOptions o = fake;
        o.file = file;
        if (e.n_layer > 0) o.n_layer = e.n_layer;
        if (e.tok != base_tok) o.extra_piece = "<tok " + e.tok + ">";
        if (slot == 1) {
            o.variant = 1;
            o.can_trim = false;
        }
        std::fprintf(stderr, "fake_engine: loaded %s as %c\n", file.c_str(), slot == 0 ? 'A' : 'B');
        return std::make_unique<CountedFake>(o, *used, e.vram);
    };
    models.backend.download = [](const ils::DownloadRequest& req, const fs::path& dest,
                                 const std::function<void(const ils::DownloadProgress&)>& progress,
                                 const std::atomic<bool>& cancel) {
        const uint64_t total = 900 * kMiB;
        const int steps = 30;  // 100 ms each
        for (int i = 1; i <= steps; ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            if (cancel) throw ils::DownloadCancelled();
            if (i == steps / 2 && req.repo.find("fail") != std::string::npos)
                throw std::runtime_error("HTTP 404 (simulated)");
            progress({total * static_cast<uint64_t>(i) / steps, total});
        }
        ils::FixtureGguf f = small_family(dest.stem().string(), 7);
        write_fixture(dest, f, total);
    };
    models.backend.gpu_memory = [used] {
        const uint64_t taken = kGpuOther + used->load();
        return ils::GpuMemory{kGpuTotal, taken < kGpuTotal ? kGpuTotal - taken : 0};
    };
    return ils::run_app(opts, std::move(models), ils::embedded_web());
}
