// The logit lens on the GPU: with the default layers, the last one must give
// the model's most likely token in at least 99 % of the EVALs; every EVAL
// carries the section; and the last layer's answer_p must be close to the
// model's own probability (not equal: the GPU multiplies with the quantized
// matrix, the lens with the dequantized one). Prints the agreement and the
// speed.
// Usage: test_lens_coherence <model.gguf> [<b.gguf>]
//   With B, the pair runs in lockstep with the lens on both, as the real
//   binary would, and the checks apply to both models: a measure of the cost.
#include "check.h"
#include "frames.h"
#include "log.h"
#include "model.h"
#include "session.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <exception>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

#ifndef _WIN32
#include <sys/resource.h>
#endif

using namespace ils;
using json = nlohmann::json;

namespace {

constexpr const char* PROMPT =
    "The history of computing is a long story of people trying to make machines "
    "do arithmetic faster than they could themselves. It begins, in most tellings, with";
constexpr uint32_t STEPS = 100;
const auto TIMEOUT = std::chrono::seconds(120);

uint32_t u32(const uint8_t* p) {
    return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
float f32(const uint8_t* p) {
    const uint32_t bits = u32(p);
    float f;
    std::memcpy(&f, &bits, sizeof f);
    return f;
}

struct Eval {
    uint8_t slot = 0;
    float entropy = 0;
    uint32_t top = 0;  // entries[0]
    float p_top = 0;
    std::vector<LensLayer> lens;
};

std::unique_ptr<Model> load(const char* path, int n_models) {
    LlamaOptions o;
    o.path = path;
    o.lens = true;
    o.lens_optional = n_models == 2;
    o.lens_threads = std::max(1, static_cast<int>(std::thread::hardware_concurrency()) / n_models);
    const auto t0 = std::chrono::steady_clock::now();
    std::unique_ptr<Model> m = load_llama_model(o);
    std::printf("loaded %s in %.1f s\n", path,
                std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count());
    return m;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: test_lens_coherence <model.gguf> [<b.gguf>]\n");
        return 2;
    }
    const int n_models = argc > 2 ? 2 : 1;
    std::unique_ptr<Model> a, b;
    try {
        a = load(argv[1], n_models);
        if (n_models == 2) b = load(argv[2], n_models);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "cannot load: %s\n", e.what());
        return 1;
    }
    const std::vector<int32_t> layers = a->lens_layers();
    const int32_t n_layer = a->info().n_layer;
    CHECK(!layers.empty());
    CHECK(!layers.empty() && layers.back() == n_layer - 1);  // the default layers end with the last one

    Log log;
    std::mutex events_mu;
    std::vector<std::string> errors;
    Session::Sinks sinks;
    sinks.event = [&](const std::string& ev) {
        std::lock_guard<std::mutex> lk(events_mu);
        std::fprintf(stderr, "event: %s\n", ev.c_str());
        const json j = json::parse(ev, nullptr, /*allow_exceptions=*/false);
        if (!j.is_object() || j.value("ev", "") == "error") errors.push_back(ev);
    };
    double seconds = 0;
    {
        Session session(*a, b.get(), log, sinks);
        session.post(R"({"cmd":"speed","tps":0})");
        const json start = {{"cmd", "start"},
                            {"prompt", PROMPT},
                            {"format", "raw"},
                            {"config", {{"max_tokens", STEPS}, {"gates", json::array()}}}};
        session.post(start.dump());
        CHECK(session.wait_idle(TIMEOUT));
        const auto t0 = std::chrono::steady_clock::now();
        session.post(R"({"cmd":"run"})");
        CHECK(session.wait_idle(TIMEOUT));
        seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    }
    CHECK(errors.empty());

    // The log: HELLO, VOCAB and EVAL.
    const Bytes bytes = log.snapshot();
    std::vector<FrameView> frames;
    CHECK(split_frames(bytes, frames));
    std::set<uint32_t> vocab;
    std::vector<Eval> evals;
    for (const FrameView& f : frames) {
        const uint8_t* p = f.body;
        if (f.type == FrameType::Hello) {
            const json h = json::parse(std::string(reinterpret_cast<const char*>(p), f.length));
            CHECK(h["lens"]["enabled"].get<bool>());
            CHECK(h["lens"]["layers"].get<std::vector<int32_t>>() == layers);
            CHECK(h["warnings"].empty());
        } else if (f.type == FrameType::Vocab) {
            const uint32_t count = u32(p);
            size_t off = 4;
            for (uint32_t i = 0; i < count; ++i) {
                vocab.insert(u32(p + off));
                off += 7 + (p[off + 5] | p[off + 6] << 8);
            }
        } else if (f.type == FrameType::Eval) {
            Eval e;
            e.slot = p[4];
            const size_t n = size_t(p[5]) + p[6];
            const size_t n_gates = p[7];
            const uint8_t flags = p[9];
            e.entropy = f32(p + 12);
            e.top = u32(p + 24);
            e.p_top = f32(p + 28);
            size_t pos = 24 + 8 * n + 4 * n_gates + 4 * n_gates * n;
            CHECK(flags & EVAL_LENS);
            if (flags & EVAL_LENS) {
                const size_t n_lens = p[pos];
                pos += 4;
                for (size_t i = 0; i < n_lens; ++i, pos += 16)
                    e.lens.push_back({u32(p + pos), f32(p + pos + 4), f32(p + pos + 8), f32(p + pos + 12)});
            }
            CHECK_EQ(pos, size_t(f.length));
            for (const LensLayer& l : e.lens) CHECK(vocab.count(l.top_id));  // VOCAB before the EVAL
            evals.push_back(e);
        }
    }

    for (int slot = 0; slot < n_models; ++slot) {
        size_t n = 0, with_lens = 0, agree = 0;
        double sum_diff = 0, max_diff = 0, sum_h = 0;
        for (const Eval& e : evals) {
            if (e.slot != slot) continue;
            ++n;
            if (e.lens.size() != layers.size()) continue;
            ++with_lens;
            const LensLayer& last = e.lens.back();
            if (last.top_id == e.top) ++agree;
            const double d = std::fabs(double(last.answer_p) - e.p_top);
            sum_diff += d;
            max_diff = std::max(max_diff, d);
            sum_h += std::fabs(double(last.entropy) - e.entropy);
            for (const LensLayer& l : e.lens) {
                CHECK(std::isfinite(l.top_p) && std::isfinite(l.answer_p) && std::isfinite(l.entropy));
                CHECK(l.answer_p <= l.top_p + 1e-6f);
            }
        }
        const double pct = with_lens ? 100.0 * agree / with_lens : 0;
        std::printf("model %c: %zu EVAL, %zu with the lens; last layer agrees with the model in %.1f %%; "
                    "|answer_p - p_raw| mean %.4f, max %.4f; |entropy diff| mean %.4f bits\n",
                    slot == 0 ? 'A' : 'B', n, with_lens, pct, with_lens ? sum_diff / with_lens : 0.0, max_diff,
                    with_lens ? sum_h / with_lens : 0.0);
        CHECK(n >= STEPS / 2);  // the generation was long enough to say something
        CHECK_EQ(with_lens, n);
        CHECK(pct >= 99.0);
        CHECK(with_lens > 0 && sum_diff / with_lens < 0.02);
        CHECK(max_diff < 0.15);
    }
    const size_t steps = evals.size() / n_models;
    if (seconds > 0) std::printf("speed: %zu steps in %.2f s, %.1f steps/s\n", steps, seconds, steps / seconds);
#ifndef _WIN32
    rusage ru{};
    if (getrusage(RUSAGE_SELF, &ru) == 0) std::printf("peak RSS: %.0f MiB\n", ru.ru_maxrss / 1024.0);
#endif

    // The models go before the log ends, so their lens summaries are printed.
    b.reset();
    a.reset();
    return test_result();
}
