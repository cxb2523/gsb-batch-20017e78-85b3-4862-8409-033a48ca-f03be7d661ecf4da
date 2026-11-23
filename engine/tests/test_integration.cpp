// Integration with the test model on the GPU: a fixed prompt and the most
// likely pick give the same text twice; the same GGUF loaded twice as A and
// B never diverges; gates with a seed give the same text twice, and the JSON
// grammar gives valid JSON.
// Usage: test_integration <model.gguf>
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
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <vector>

using namespace ils;
using json = nlohmann::json;

namespace {

constexpr const char* PROMPT =
    "The history of computing is a long story of people trying to make machines "
    "do arithmetic faster than they could themselves. It begins, in most tellings, with";
constexpr uint32_t MAX_TOKENS = 32;
constexpr uint32_t PAIR_TOKENS = 200;
const auto TIMEOUT = std::chrono::seconds(60);

uint32_t u32(const uint8_t* p) {
    return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
uint16_t u16(const uint8_t* p) { return uint16_t(p[0] | p[1] << 8); }
float f32(const uint8_t* p) {
    const uint32_t bits = u32(p);
    float f;
    std::memcpy(&f, &bits, sizeof f);
    return f;
}

struct Eval {
    uint32_t node = 0;
    uint8_t n_gates = 0;
    float entropy = 0;
    std::vector<uint32_t> tokens;
    std::vector<float> p;
    std::vector<uint32_t> survivors;  // one per gate
};

// What one generation left in the log.
struct Run {
    std::vector<uint32_t> prompt;     // NODE tokens with origin 0
    std::vector<uint32_t> generated;  // NODE tokens with origin 1
    std::vector<Eval> evals;
    std::map<uint32_t, uint8_t> attr;  // VOCAB
    std::map<uint32_t, std::string> text;
    int stop_reason = -1;  // of the last STOP
    double seconds = 0;

    std::string generated_text() const {
        std::string s;
        for (uint32_t t : generated) s += text.count(t) ? text.at(t) : "?";
        return s;
    }

    // The generated text without its end-of-generation tokens.
    std::string text_without_eog() const {
        std::string s;
        for (uint32_t t : generated)
            if (!attr.count(t) || !(attr.at(t) & ATTR_EOG)) s += text.count(t) ? text.at(t) : "?";
        return s;
    }
};

Run read_log(const Log& log) {
    Run r;
    const Bytes bytes = log.snapshot();
    std::vector<FrameView> frames;
    CHECK(split_frames(bytes, frames));
    for (const FrameView& f : frames) {
        const uint8_t* b = f.body;
        if (f.type == FrameType::Vocab) {
            const uint32_t count = u32(b);
            size_t off = 4;
            for (uint32_t i = 0; i < count && off + 7 <= f.length; ++i) {
                const uint32_t token = u32(b + off);
                const uint8_t attr = b[off + 4];
                const uint16_t len = u16(b + off + 5);
                r.attr[token] = attr;
                r.text[token] = std::string(reinterpret_cast<const char*>(b + off + 7), len);
                off += 7 + len;
            }
        } else if (f.type == FrameType::Node) {
            const uint32_t token = u32(b + 8);
            const uint8_t origin = b[16];
            if (origin == ORIGIN_PROMPT) r.prompt.push_back(token);
            if (origin == ORIGIN_MODEL) r.generated.push_back(token);
        } else if (f.type == FrameType::Eval) {
            Eval e;
            e.node = u32(b);
            const size_t n = size_t(b[5]) + b[6];  // n_raw + n_extra
            e.n_gates = b[7];
            e.entropy = f32(b + 12);
            for (size_t i = 0; i < n; ++i) {
                e.tokens.push_back(u32(b + 24 + 8 * i));
                e.p.push_back(f32(b + 28 + 8 * i));
            }
            for (size_t g = 0; g < e.n_gates; ++g) e.survivors.push_back(u32(b + 24 + 8 * n + 4 * g));
            r.evals.push_back(e);
        } else if (f.type == FrameType::Stop) {
            r.stop_reason = b[5];
        }
    }
    return r;
}

std::string start_cmd(const std::string& prompt, const char* format, const std::string& system, uint32_t max_tokens,
                      const json& gates = json::array(), uint64_t seed = 42) {
    json cmd = {{"cmd", "start"},
                {"prompt", prompt},
                {"format", format},
                {"config", {{"max_tokens", max_tokens}, {"seed", seed}, {"gates", gates}}}};
    if (!system.empty()) cmd["system"] = system;
    return cmd.dump();
}

// A file of the repository as text ("" if it cannot be read). CTest runs
// from the root of the repository.
std::string read_file(const char* path) {
    std::ifstream f(path, std::ios::binary);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

Run generate(Session& session, const Log& log, const std::string& start) {
    session.post(start);
    CHECK(session.wait_idle(TIMEOUT));
    const auto t0 = std::chrono::steady_clock::now();
    session.post(R"({"cmd":"run"})");
    CHECK(session.wait_idle(TIMEOUT));
    const double s = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    Run r = read_log(log);
    r.seconds = s;
    return r;
}

// The frames of a two-model run that the identity test looks at.
struct PairRun {
    std::vector<float> js;
    std::vector<uint8_t> flags;
    size_t generated = 0;
    size_t split_cursors = 0;  // CURSOR frames with A and B on different nodes
};

PairRun read_pair_log(const Log& log) {
    PairRun r;
    const Bytes bytes = log.snapshot();
    std::vector<FrameView> frames;
    CHECK(split_frames(bytes, frames));
    for (const FrameView& f : frames) {
        if (f.type == FrameType::Pair) {
            r.js.push_back(f32(f.body + 4));
            r.flags.push_back(f.body[24]);
        } else if (f.type == FrameType::Node && f.body[16] == ORIGIN_MODEL) {
            ++r.generated;
        } else if (f.type == FrameType::Cursor && u32(f.body) != u32(f.body + 4)) {
            ++r.split_cursors;
        }
    }
    return r;
}

void check_run(const Run& r) {
    CHECK(!r.prompt.empty());
    CHECK(!r.generated.empty());
    CHECK(r.generated.size() <= MAX_TOKENS);
    // 32 generated tokens, unless the model ended the generation earlier.
    if (r.generated.size() < MAX_TOKENS && !r.generated.empty()) {
        const auto it = r.attr.find(r.generated.back());
        CHECK(it != r.attr.end() && (it->second & ATTR_EOG));
    }
    CHECK_EQ(r.evals.size(), r.generated.size());
    for (const Eval& e : r.evals) {
        CHECK(std::isfinite(e.entropy));
        CHECK(e.entropy >= 0);
        double sum = 0;
        for (float p : e.p) sum += p;
        CHECK(sum <= 1.0 + 1e-5);
    }
}

}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::fprintf(stderr, "usage: test_integration <model.gguf>\n");
        return 2;
    }

    std::unique_ptr<Model> model;
    try {
        LlamaOptions opts;
        opts.path = argv[1];
        model = load_llama_model(opts);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "cannot load %s: %s\n", argv[1], e.what());
        return 1;
    }

    Log log;
    std::mutex events_mu;
    std::vector<std::string> events;
    Session::Sinks sinks;
    sinks.event = [&](const std::string& ev) {
        std::lock_guard<std::mutex> lk(events_mu);
        std::fprintf(stderr, "event: %s\n", ev.c_str());
        const json j = json::parse(ev, nullptr, /*allow_exceptions=*/false);
        if (!j.is_object() || j.value("ev", "") == "error") events.push_back(ev);
    };
    {
        Session session(*model, nullptr, log, sinks);
        session.post(R"({"cmd":"speed","tps":0})");

        // --- raw prompt, twice
        const std::string start = start_cmd(PROMPT, "raw", "", MAX_TOKENS);
        const Run a = generate(session, log, start);
        const Run b = generate(session, log, start);
        check_run(a);
        check_run(b);
        std::printf("text: %s\n", a.generated_text().c_str());

        CHECK(a.prompt == b.prompt);
        CHECK(a.generated == b.generated);
        CHECK_EQ(a.evals.size(), b.evals.size());
        for (size_t i = 0; i < a.evals.size() && i < b.evals.size(); ++i) {
            const Eval& x = a.evals[i];
            const Eval& y = b.evals[i];
            CHECK(x.tokens == y.tokens);
            CHECK_EQ(x.p.size(), y.p.size());
            for (size_t j = 0; j < x.p.size() && j < y.p.size(); ++j) CHECK_NEAR(x.p[j], y.p[j], 1e-4);
            CHECK_NEAR(x.entropy, y.entropy, 1e-4);
        }
        if (a.seconds > 0)
            std::printf("speed: %zu tokens in %.2f s, about %.1f tokens/s\n", a.generated.size(), a.seconds,
                        a.generated.size() / a.seconds);

        // --- chat template with a system message
        const Run c = generate(session, log,
                               start_cmd("Say hello.", "chat", "You are a helpful assistant.", 8));
        CHECK(!c.prompt.empty());
        if (!c.prompt.empty()) {
            CHECK(c.attr.count(c.prompt.front()));
            if (c.attr.count(c.prompt.front())) CHECK(c.attr.at(c.prompt.front()) & ATTR_CONTROL);
        }
        CHECK(!c.generated.empty());
        CHECK(c.generated.size() <= 8);
        std::printf("chat: %zu prompt tokens, text: %s\n", c.prompt.size(), c.generated_text().c_str());

        // --- gates and a seed, twice: the same text
        const json gates = json::array({{{"type", "penalties"}, {"repeat", 1.1}},
                                        {{"type", "top_k"}, {"k", 40}},
                                        {{"type", "top_p"}, {"p", 0.95}},
                                        {{"type", "temp"}, {"t", 0.8}}});
        const std::string seeded = start_cmd(PROMPT, "raw", "", MAX_TOKENS, gates, 1234);
        const Run g1 = generate(session, log, seeded);
        const Run g2 = generate(session, log, seeded);
        check_run(g1);
        check_run(g2);
        CHECK(g1.generated == g2.generated);
        for (const Eval& e : g1.evals) CHECK_EQ(e.n_gates, 4);
        std::printf("gates, seed 1234: %s\n", g1.generated_text().c_str());

        // --- the JSON grammar: the text up to the end of generation is JSON
        const std::string gbnf = read_file("third_party/llama.cpp/grammars/json.gbnf");
        CHECK(!gbnf.empty());
        const json json_gates =
            json::array({{{"type", "grammar"}, {"gbnf", gbnf}}, {{"type", "temp"}, {"t", 0}}});
        const Run j = generate(session, log,
                               start_cmd("Describe a cat as a JSON object with the keys \"name\" and \"age\". "
                                         "Reply with the JSON object only.",
                                         "chat", "", 256, json_gates));
        CHECK_EQ(j.stop_reason, static_cast<int>(StopReason::EndOfGeneration));
        const std::string text = j.text_without_eog();
        std::printf("json grammar: %zu tokens, text: %s\n", j.generated.size(), text.c_str());
        if (!j.evals.empty() && !j.evals[0].survivors.empty())
            std::printf("json grammar: %u of %u tokens survive the grammar at the first step\n", j.evals[0].survivors[0],
                        model->n_vocab());
        try {
            const json parsed = json::parse(text);
            CHECK(parsed.is_object());
        } catch (const std::exception& e) {
            std::fprintf(stderr, "json grammar: not JSON: %s\n", e.what());
            CHECK(false);
        }
    }

    // --- identity: the same GGUF as A and as B
    std::unique_ptr<Model> model_b;
    try {
        LlamaOptions opts;
        opts.path = argv[1];
        model_b = load_llama_model(opts);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "cannot load %s again: %s\n", argv[1], e.what());
        return 1;
    }
    CHECK(!tokenizer_difference(*model, *model_b));
    {
        Log pair_log;
        Session pair(*model, model_b.get(), pair_log, sinks);
        pair.post(R"({"cmd":"speed","tps":0})");
        for (const char* mode : {"lockstep", "free"}) {
            const json start = {{"cmd", "start"},
                                {"prompt", "Once upon a time, in a small village by the sea,"},
                                {"config", {{"max_tokens", PAIR_TOKENS}, {"mode", mode}}}};
            pair.post(start.dump());
            CHECK(pair.wait_idle(TIMEOUT));
            const auto t0 = std::chrono::steady_clock::now();
            pair.post(R"({"cmd":"run"})");
            CHECK(pair.wait_idle(TIMEOUT));
            const double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
            const PairRun r = read_pair_log(pair_log);
            CHECK(r.generated > 0);
            CHECK_EQ(r.js.size(), r.generated);  // a PAIR at every step
            float max_js = 0;
            for (size_t i = 0; i < r.js.size(); ++i) {
                CHECK(r.js[i] < 1e-6f);
                CHECK(r.flags[i] & PAIR_SAME_PICK);
                max_js = std::max(max_js, r.js[i]);
            }
            CHECK_EQ(r.split_cursors, 0u);
            std::printf("identity, %s: %zu steps in %.2f s, %.1f steps/s, max js %g\n", mode, r.generated, secs,
                        secs > 0 ? r.generated / secs : 0.0, static_cast<double>(max_js));
        }
    }

    // --- placement: Qwen3.5 cannot trim its context (recurrent layers), so
    // going back to an ancestor with no snapshot rebuilds it in batches; then
    // it continues exactly.
    // (Trimming everything always works: it is emptying the context.)
    try {
        const std::vector<int32_t> p = model_b->tokenize_prompt("Hello there, how are you today", false, "");
        CHECK(p.size() >= 4);
        EvalOutput out;
        model_b->eval(p, out);
        const std::vector<int32_t> back(p.begin(), p.end() - 2);
        model_b->eval(back, out);
        CHECK(out.approximate);
        CHECK_EQ(out.logits.size(), model_b->n_vocab());
        std::vector<int32_t> next = back;
        next.push_back(p[p.size() - 2]);
        model_b->eval(next, out);
        CHECK(!out.approximate);

        // With the prompt's snapshot (taken by prefill), going back to the
        // prompt's last node restores it: exact, the same logits bit for bit.
        model_b->prefill(std::vector<int32_t>(p.begin(), p.end() - 1));
        EvalOutput first;
        model_b->eval(p, first);
        std::vector<int32_t> ahead = p;
        ahead.push_back(p[1]);
        model_b->eval(ahead, out);
        model_b->eval(p, out);
        CHECK(!out.approximate);
        CHECK(out.logits == first.logits);
    } catch (const std::exception& e) {
        std::fprintf(stderr, "placement: %s\n", e.what());
        CHECK(false);
    }

    {
        std::lock_guard<std::mutex> lk(events_mu);
        CHECK(events.empty());
    }
    return test_result();
}
