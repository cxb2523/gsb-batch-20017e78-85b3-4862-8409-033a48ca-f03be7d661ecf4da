// A scripted model for tests and for the fake engine: deterministic, no
// llama.cpp, no GPU. It writes a canned English text in a loop, with
// alternatives whose weight changes from position to position, so the
// entropy moves between very sure and doubtful. The text has "café",
// "naïve" and an emoji, whose bytes are split into single-byte tokens.
//
// Vocabulary: control tokens, the 256 single bytes (so any text can be
// tokenized) and some words with a leading space.
//
// With `lens`, every eval also gives a synthetic logit lens over the default
// layers of its n_layer (lens.h): the probability of the model's most likely
// token grows with the layer, the earlier layers prefer other words (some of
// them not among the candidates), and the last layer agrees with the model.
#pragma once

#include "fake_gates.h"
#include "lens.h"
#include "model.h"
#include "snapshots.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace ils {

struct FakeOptions {
    uint32_t n_ctx = 4096;
    int delay_ms = 0;        // added to every eval, like a real decode
    uint32_t eos_after = 0;  // <eos> wins once this many tokens are generated; 0: never
    int fail_at_eval = 0;    // the n-th eval (from 1) throws; 0: never
    // Not 0: a second opinion, for pairs. At about one position in seven
    // (from the path hash mixed with it) an alternative beats the script's
    // token; elsewhere the weights move a little, so the divergence is never 0.
    uint64_t variant = 0;
    // false: like a recurrent model, the context cannot be trimmed. An eval
    // that is not a continuation of the context restores a snapshot, or is
    // approximate if there is none.
    bool can_trim = true;
    // Snapshots, as the real model takes them (snapshots.h): the blob is a
    // copy of the tokens padded to `snapshot_blob_bytes`.
    size_t snapshot_every = SNAPSHOT_EVERY;  // 0: no snapshots at all, not even the prompt's
    size_t snapshot_limit = 0;               // bytes; 0: unlimited
    size_t snapshot_blob_bytes = 1024;
    std::string extra_piece;  // not empty: added to the vocabulary (another tokenizer)
    int32_t n_layer = 4;      // reported in info(); the lens takes its default layers
    bool lens = false;        // a synthetic logit lens in every eval
    std::string lens_warning;  // not empty: what lens_warnings() reports
    std::string file;          // not empty: the file name info() reports
};

class FakeModel : public Model {
public:
    enum : int32_t { BOS = 0, EOS = 1, SYS = 2, USER = 3, ASSISTANT = 4, END = 5, N_CONTROL = 6, BYTE0 = 6 };

    static constexpr const char* kScript =
        "The quick brown fox jumps over the lazy dog. I ordered a caf\xC3\xA9 au lait and a croissant. "
        "It was a na\xC3\xAFve plan, but it worked \xF0\x9F\x99\x82. Then the story starts again.\n\n";

    explicit FakeModel(FakeOptions o = {}) : fail_at_eval(o.fail_at_eval), opt_(o), lens_on_(o.lens) {
        pieces_ = {"<s>", "<eos>", "<|system|>", "<|user|>", "<|assistant|>", "<|end|>"};
        for (int b = 0; b < 256; ++b) pieces_.push_back(std::string(1, static_cast<char>(b)));
        first_word_ = static_cast<int32_t>(pieces_.size());
        for (const char* w : {"The", " The", " quick", " brown", " fox", " jumps", " over", " the", " lazy",
                              " dog", ".", " I", " ordered", " a", " caf", " au", " lait", " and", " croissant",
                              " It", " was", " na", "ve", " plan", ",", " but", " it", " worked", " Then",
                              " story", " starts", " again", "\n\n", " cat", " sat", " on", " mat", " slow",
                              " red", " bird", " tea", " good", " idea", " failed", " ends", " here", " hello",
                              " world", " is", " of", " to", " in", " my", " old", " small", " cold", " coffee"}) {
            pieces_.push_back(w);
        }
        if (!o.extra_piece.empty()) pieces_.push_back(o.extra_piece);
        script_ = tokenize(kScript, false);
    }

    // ---------------------------------------------------------------- Model

    ModelInfo info() const override {
        ModelInfo m;
        m.name = "Fake";
        // A variant is another model: its own file name, as two different
        // GGUF would have (the e2e tests tell a pair from the same file twice by it).
        m.file = opt_.variant == 0 ? "fake.gguf" : "fake-v" + std::to_string(opt_.variant) + ".gguf";
        if (!opt_.file.empty()) m.file = opt_.file;
        m.quant = "F32";
        m.arch = "fake";
        m.n_params = 1000000;
        m.size_bytes = 4000000;
        m.n_layer = opt_.n_layer;
        m.n_embd = 64;
        m.n_ctx = static_cast<int32_t>(opt_.n_ctx);
        return m;
    }
    uint32_t n_vocab() const override { return static_cast<uint32_t>(pieces_.size()); }
    uint32_t n_ctx() const override { return opt_.n_ctx; }
    std::string library_version() const override { return "fake"; }

    std::vector<int32_t> tokenize_prompt(const std::string& text, bool chat, const std::string& system) override {
        std::vector<int32_t> out{BOS};
        auto add = [&](const std::vector<int32_t>& v) { out.insert(out.end(), v.begin(), v.end()); };
        if (!chat) {
            add(tokenize(text, true));
            return out;
        }
        if (!system.empty()) {
            out.push_back(SYS);
            add(tokenize(system, false));
            out.push_back(END);
        }
        out.push_back(USER);
        add(tokenize(text, false));
        out.push_back(END);
        out.push_back(ASSISTANT);
        return out;
    }

    std::string piece(int32_t token) const override {
        return token >= 0 && token < static_cast<int32_t>(pieces_.size()) ? pieces_[token] : std::string();
    }

    uint8_t attr(int32_t token) const override {
        if (token == EOS) return ATTR_CONTROL | ATTR_EOG;
        return token >= 0 && token < N_CONTROL ? ATTR_CONTROL : 0;
    }

    void prefill(const std::vector<int32_t>& path) override {
        if (fail_prefill) throw std::runtime_error("fake prefill failure");
        if (path.size() >= opt_.n_ctx) throw std::runtime_error("prompt does not fit in the context");
        prompt_len_ = static_cast<uint32_t>(path.size()) + 1;
        held_ = path;
        exact_ = true;
        snapshots_.clear();
        if (opt_.snapshot_every > 0 && !path.empty()) snapshots_.add(held_, blob_of(held_), true);
    }

    void eval(const std::vector<int32_t>& path, EvalOutput& out) override {
        const auto t0 = std::chrono::steady_clock::now();
        const int n = ++evals_;
        if (fail_at_eval > 0 && n == fail_at_eval) throw std::runtime_error("fake decode failure");
        if (path.empty()) throw std::runtime_error("empty path");
        if (path.size() > opt_.n_ctx) throw std::runtime_error("context overflow");
        if (opt_.delay_ms > 0) std::this_thread::sleep_for(std::chrono::milliseconds(opt_.delay_ms));

        // Placed like the real model (snapshots.h): continue, trim, restore
        // a snapshot or rebuild in batches (approximate).
        const size_t d = path.size() - 1;
        const Placement pl = plan_placement(held_, path, opt_.can_trim, snapshots_);
        out.approximate = pl.kind == Placement::Clear;
        switch (pl.kind) {
            case Placement::Continue:
                break;
            case Placement::Trim:
                held_.resize(pl.from);
                break;
            case Placement::Restore:
                if (blob_of(pl.snapshot->tokens) != pl.snapshot->blob)
                    throw std::runtime_error("fake snapshot does not match its tokens");
                held_ = pl.snapshot->tokens;
                exact_ = true;
                snapshots_.touch(pl.snapshot);
                ++restores;
                break;
            case Placement::Clear:
                held_.assign(path.begin(), path.begin() + d);
                exact_ = false;
                break;
        }
        // The rest one at a time, the last token included.
        while (held_.size() < path.size()) {
            held_.push_back(path[held_.size()]);
            ++single_decodes;
            if (exact_ && snapshot_due(held_.size(), opt_.snapshot_every) && !snapshots_.has(held_, held_.size()))
                snapshots_.add(held_, blob_of(held_));
        }

        uint64_t h = 14695981039346656037ull;  // FNV-1a over the path
        for (int32_t t : path) {
            h ^= static_cast<uint32_t>(t);
            h *= 1099511628211ull;
        }

        // Background: low logits with noise, control tokens nearly impossible.
        const uint32_t nv = n_vocab();
        out.logits.assign(nv, 0.0f);
        for (uint32_t t = 0; t < nv; ++t) {
            const double u = unit(mix(h ^ (0x9E3779B97F4A7C15ull * (t + 1))));
            out.logits[t] = static_cast<float>(t < N_CONTROL ? -30.0 : -6.0 + 4.0 * u);
        }
        out.logits[EOS] = -8.0f;

        const uint32_t generated = path.size() > prompt_len_ ? static_cast<uint32_t>(path.size()) - prompt_len_ : 0;
        if (opt_.eos_after > 0 && generated >= opt_.eos_after) {
            out.logits[EOS] = 10.0f;
        } else {
            // The next token of the script, with one or two alternatives.
            const int32_t next = script_[generated % script_.size()];
            const int32_t n_words = nv - first_word_;
            const int32_t alt1 = first_word_ + static_cast<int32_t>(mix(h + 1) % n_words);
            const int32_t alt2 = first_word_ + static_cast<int32_t>(mix(h + 2) % n_words);
            switch (mix(h + 3) % 5) {
                case 0:
                case 1:  // very sure
                    out.logits[next] = 9.0f;
                    break;
                case 2:
                case 3:  // fairly sure
                    out.logits[alt1] = std::max(out.logits[alt1], 1.5f);
                    out.logits[next] = 3.0f;
                    break;
                default:  // doubtful
                    out.logits[alt1] = std::max(out.logits[alt1], 1.7f);
                    out.logits[alt2] = std::max(out.logits[alt2], 1.4f);
                    out.logits[next] = 2.0f;
                    break;
            }
            if (opt_.variant != 0) {
                // Small noise everywhere (it never swaps the script's token
                // with its alternatives), and now and then alt1 wins.
                const uint64_t v = mix(h ^ opt_.variant);
                for (uint32_t t = N_CONTROL; t < nv; ++t)
                    out.logits[t] += static_cast<float>(0.2 * (unit(mix(v ^ (0xD1B54A32D192ED03ull * (t + 1)))) - 0.5));
                if (v % 7 == 0) {
                    const int32_t alt = alt1 != next ? alt1 : first_word_ + (alt1 - first_word_ + 1) % n_words;
                    out.logits[alt] = out.logits[next] + 1.0f;
                }
            }
        }
        out.lens.clear();
        if (lens_on_) out.lens = synthetic_lens(out.logits, h);
        out.decode_ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    }

    std::vector<int32_t> lens_layers() const override {
        return lens_on_ ? default_lens_layers(opt_.n_layer) : std::vector<int32_t>{};
    }
    std::vector<std::string> lens_warnings() const override {
        if (!lens_on_ || opt_.lens_warning.empty()) return {};
        return {opt_.lens_warning};
    }
    void disable_lens() override {
        lens_on_ = false;
        ++lens_disabled;
    }

    // Reference samplers (fake_gates.h) that record what they accept.
    std::unique_ptr<Sampler> make_sampler(const GateSpec& spec) override {
        auto inner = make_reference_gate(spec, *this);
        ++samplers_made;
        return std::make_unique<Recorder>(std::move(inner), spec.type, *this);
    }

    // ---------------------------------------------------------------- tests

    std::vector<std::pair<std::string, int32_t>> accepted;  // gate type and token of every accept
    int samplers_made = 0;
    // Faults, counted over every sampler of this model; 0: never.
    int refuse_admit_at = 0;  // the n-th admits() (from 1) says no, whatever the token
    int empty_apply_at = 0;   // the n-th apply() leaves no candidate alive
    int admits_asked = 0;
    int applies_done = 0;
    std::atomic<bool> fail_prefill{false};
    std::atomic<int> fail_at_eval;  // see FakeOptions
    int evals() const { return evals_; }
    int lens_disabled = 0;   // calls to disable_lens
    int restores = 0;        // placements from a snapshot
    int single_decodes = 0;  // tokens decoded one at a time, the last of every eval included
    const SnapshotCache& snapshots() const { return snapshots_; }
    const std::vector<int32_t>& script() const { return script_; }

    // Longest match over the vocabulary; control tokens only if `special`.
    std::vector<int32_t> tokenize(const std::string& text, bool special) const {
        std::vector<int32_t> out;
        size_t pos = 0;
        while (pos < text.size()) {
            int32_t best = BYTE0 + static_cast<uint8_t>(text[pos]);
            size_t best_len = 1;
            for (int32_t t = 0; t < static_cast<int32_t>(pieces_.size()); ++t) {
                if (t >= N_CONTROL && t < first_word_) continue;  // single bytes: the fallback
                if (t < N_CONTROL && !special) continue;
                const std::string& p = pieces_[t];
                if (p.size() > best_len && text.compare(pos, p.size(), p) == 0) {
                    best = t;
                    best_len = p.size();
                }
            }
            out.push_back(best);
            pos += best_len;
        }
        return out;
    }

private:
    class Recorder : public Sampler {
    public:
        Recorder(std::unique_ptr<Sampler> inner, std::string type, FakeModel& model)
            : inner_(std::move(inner)), type_(std::move(type)), model_(model) {}
        void apply(TokenArray& cur) override {
            inner_->apply(cur);
            if (++model_.applies_done == model_.empty_apply_at)
                for (size_t i = 0; i < cur.size; ++i) cur.data[i].logit = -INFINITY;
        }
        void accept(int32_t token) override {
            model_.accepted.emplace_back(type_, token);
            inner_->accept(token);
        }
        bool admits(int32_t token) override {
            if (++model_.admits_asked == model_.refuse_admit_at) return false;
            return inner_->admits(token);
        }

    private:
        std::unique_ptr<Sampler> inner_;
        std::string type_;
        FakeModel& model_;
    };

    static uint64_t mix(uint64_t x) {  // splitmix64 finalizer
        x += 0x9E3779B97F4A7C15ull;
        x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ull;
        x = (x ^ (x >> 27)) * 0x94D049BB133111EBull;
        return x ^ (x >> 31);
    }
    static double unit(uint64_t x) { return static_cast<double>(x >> 11) * (1.0 / 9007199254740992.0); }

    // The lens of one eval, from its logits and the hash of its path.
    std::vector<LensLayer> synthetic_lens(const std::vector<float>& logits, uint64_t h) const {
        const uint32_t nv = static_cast<uint32_t>(logits.size());
        uint32_t top = 0;
        for (uint32_t t = 1; t < nv; ++t)
            if (logits[t] > logits[top]) top = t;
        double sum = 0, weighted = 0;
        for (uint32_t t = 0; t < nv; ++t) {
            const double d = static_cast<double>(logits[t]) - logits[top];
            const double e = std::exp(d);
            sum += e;
            weighted += e * d;
        }
        const double p_top = 1.0 / sum;
        const double entropy = std::max(0.0, (std::log(sum) - weighted / sum) / std::log(2.0));
        const size_t k = lens_layers().size();
        std::vector<LensLayer> out(k);
        for (size_t i = 0; i < k; ++i) {
            LensLayer& l = out[i];
            const double frac = static_cast<double>(i + 1) / static_cast<double>(k);
            l.answer_p = static_cast<float>(p_top * frac * frac);
            if (i + 1 == k) {
                l.top_id = top;
                l.top_p = static_cast<float>(p_top);
                l.entropy = static_cast<float>(entropy);
                continue;
            }
            // Any word or single byte, so that some are not candidates.
            const uint64_t r = mix(h ^ (0xA24BAED4963EE407ull * (i + 1)));
            l.top_id = BYTE0 + static_cast<uint32_t>(r % (nv - BYTE0));
            l.top_p = l.top_id == top ? l.answer_p : std::max(l.answer_p, static_cast<float>(0.1 + 0.5 * unit(mix(r))));
            l.entropy = static_cast<float>(entropy + 1.5 * static_cast<double>(k - 1 - i));
        }
        return out;
    }

    // A snapshot's blob: the bytes of its tokens, padded to snapshot_blob_bytes.
    std::vector<uint8_t> blob_of(const std::vector<int32_t>& tokens) const {
        std::vector<uint8_t> b(std::max(opt_.snapshot_blob_bytes, tokens.size() * sizeof(int32_t)), 0);
        std::memcpy(b.data(), tokens.data(), tokens.size() * sizeof(int32_t));
        return b;
    }

    FakeOptions opt_;
    std::vector<std::string> pieces_;
    int32_t first_word_ = 0;
    std::vector<int32_t> script_;
    uint32_t prompt_len_ = 0;
    std::vector<int32_t> held_;  // the tokens in the "context"
    bool exact_ = true;          // not rebuilt in batches: snapshots may be taken
    SnapshotCache snapshots_{opt_.snapshot_limit};
    bool lens_on_ = false;
    int evals_ = 0;
};

}  // namespace ils
