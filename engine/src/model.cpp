// LlamaModel: the Model interface on top of llama.cpp.
//
// One worker thread owns the llama_context: everything that touches it
// (decoding, memory, logits) runs there, and prefill/eval hand it the work
// and wait. The vocabulary is immutable, so tokenizing and reading token
// pieces run on the calling thread.
#include "model.h"

#include "lens.h"
#include "llama_gates.h"
#include "llama_lens.h"
#include "snapshots.h"

// chat.h pulls in Jinja headers that define unused static functions.
#if defined(__GNUC__)
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wunused-function"
#endif
#include "chat.h"
#if defined(__GNUC__)
#pragma GCC diagnostic pop
#endif
#include "llama.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <climits>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <filesystem>
#include <functional>
#include <future>
#include <mutex>
#include <stdexcept>
#include <thread>

namespace ils {
namespace {

using Clock = std::chrono::steady_clock;

// GGUF metadata value as text, or "" if the key is missing.
std::string meta_str(const llama_model* model, const char* key) {
    std::vector<char> buf(256);
    int32_t n = llama_model_meta_val_str(model, key, buf.data(), buf.size());
    if (n < 0) return "";
    if (static_cast<size_t>(n) >= buf.size()) {
        buf.resize(static_cast<size_t>(n) + 1);
        n = llama_model_meta_val_str(model, key, buf.data(), buf.size());
        if (n < 0) return "";
    }
    return std::string(buf.data(), static_cast<size_t>(n));
}

// The usual mistakes with the model file, said in one line before llama.cpp
// tries (its own messages are long and vague about them).
void check_gguf_file(const std::string& path) {
    std::error_code ec;
    if (!std::filesystem::exists(path, ec)) throw std::runtime_error("file not found: " + path);
    if (std::filesystem::is_directory(path, ec)) throw std::runtime_error("not a GGUF file (a directory): " + path);
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) throw std::runtime_error("cannot read file: " + path);
    char magic[4] = {};
    const size_t n = std::fread(magic, 1, sizeof(magic), f);
    std::fclose(f);
    if (n != sizeof(magic) || std::memcmp(magic, "GGUF", sizeof(magic)) != 0)
        throw std::runtime_error("not a GGUF file: " + path);
}

// llama.cpp logs every tensor while it loads a model. Only its warnings and
// errors reach stderr, unless ILS_LLAMA_LOG is set (`all` is then non-null).
void log_filter(ggml_log_level level, const char* text, void* all) {
    static std::atomic<bool> shown{false};
    // A continuation line follows the fate of the line it continues.
    if (level != GGML_LOG_LEVEL_CONT) shown = all != nullptr || level >= GGML_LOG_LEVEL_WARN;
    if (shown) std::fputs(text, stderr);
}

// The GPUs the models may use: dedicated ones only, never an integrated GPU.
bool is_dedicated_gpu(ggml_backend_dev_t dev) {
    return ggml_backend_dev_type(dev) == GGML_BACKEND_DEVICE_TYPE_GPU;
}

class LlamaModel final : public Model {
public:
    explicit LlamaModel(const LlamaOptions& o);
    ~LlamaModel() override;

    LlamaModel(const LlamaModel&) = delete;
    LlamaModel& operator=(const LlamaModel&) = delete;

    ModelInfo info() const override { return info_; }
    uint32_t n_vocab() const override { return n_vocab_; }
    uint32_t n_ctx() const override { return n_ctx_; }
    std::string library_version() const override { return llama_version(); }

    std::vector<int32_t> tokenize_prompt(const std::string& text, bool chat,
                                         const std::string& system) override;
    std::string piece(int32_t token) const override;
    uint8_t attr(int32_t token) const override;

    void prefill(const std::vector<int32_t>& path) override;
    void eval(const std::vector<int32_t>& path, EvalOutput& out) override;

    std::unique_ptr<Sampler> make_sampler(const GateSpec& spec) override { return make_llama_gate(spec, vocab_); }

    std::vector<int32_t> lens_layers() const override { return lens_ ? lens_->layers() : std::vector<int32_t>{}; }
    std::vector<std::string> lens_warnings() const override {
        return lens_ ? lens_->warnings() : std::vector<std::string>{};
    }
    void disable_lens() override {
        // The worker thread is the one that decodes, so the callback never
        // sees the lens go away in the middle of a decode.
        if (lens_) run_on_worker([this] { lens_.reset(); });
    }

private:
    // --- worker thread
    void worker_loop();
    void stop_worker();
    void run_on_worker(std::function<void()> fn);
    // Queues a job without waiting for it; what it throws is dropped.
    void post_on_worker(std::function<void()> fn);  // blocks; rethrows the job's exception

    // --- worker-thread only
    void clear_memory();
    // Decodes path[from, to) at positions from..to-1, in one batch. Asks for
    // the logits of the last token only if `want_logits`.
    void decode(const std::vector<int32_t>& path, size_t from, size_t to, bool want_logits);
    // Same, split into batches of at most n_batch_, without logits.
    void decode_batched(const std::vector<int32_t>& path, size_t from, size_t to);
    // Copies the whole state of the sequence into the cache, as a snapshot
    // of held_. Gives up quietly if llama.cpp cannot save it.
    void take_snapshot(bool pinned);
    // A periodic snapshot, if the context is exact and holds a multiple of
    // snapshot_every_ tokens that has none yet.
    void maybe_snapshot();
    // cb_eval of the context, with this model as user data: forwarded to the
    // lens while there is one.
    static bool lens_callback(ggml_tensor* t, bool ask, void* self);

    std::vector<int32_t> tokenize(const std::string& text, bool add_special, bool parse_special) const;
    bool valid(int32_t token) const { return token >= 0 && static_cast<uint32_t>(token) < n_vocab_; }
    void check_path(const std::vector<int32_t>& path) const;

    llama_model* model_ = nullptr;
    const llama_vocab* vocab_ = nullptr;
    llama_context* ctx_ = nullptr;  // owned by the worker thread
    uint32_t n_vocab_ = 0;
    uint32_t n_ctx_ = 0;
    uint32_t n_batch_ = 0;
    ModelInfo info_;

    std::vector<int32_t> held_;  // tokens in the context, positions 0.. (worker thread)
    bool can_trim_ = true;       // false once llama_memory_seq_rm has failed (worker thread)
    // Snapshots are only taken of an exact context: one built by prefill and
    // then token by token, or restored from a snapshot. A context rebuilt in
    // batches (Clear) is not bit-exact, and neither is anything decoded on
    // top of it, so it takes none until a restore or a prefill (worker thread).
    bool exact_ = true;
    size_t snapshot_every_ = SNAPSHOT_EVERY;  // 0: only the prompt's pinned one
    SnapshotCache snapshots_;                 // worker thread
    // The logit lens, if on. Used on the worker thread; set before it starts
    // decoding and only reset there (disable_lens).
    std::unique_ptr<LlamaLens> lens_;

    std::mutex tmpl_mu_;
    common_chat_templates_ptr tmpls_;  // built on first chat prompt

    std::thread worker_;
    std::mutex mu_;
    std::condition_variable cv_;
    std::deque<std::packaged_task<void()>> jobs_;
    bool stopping_ = false;
    std::mutex call_mu_;  // one job at a time
};

LlamaModel::LlamaModel(const LlamaOptions& o) {
    // --snapshot-mem 0 (or less) turns the periodic snapshots off; the
    // prompt's pinned one is still taken, whatever its size.
    if (o.snapshot_mb > 0) {
        snapshots_.set_limit(static_cast<size_t>(o.snapshot_mb) << 20);
    } else {
        snapshot_every_ = 0;
    }
    // Discrete GPUs only, NULL-terminated, for llama_model_params::devices.
    // An integrated GPU is never used, not even as the only one (llama.cpp
    // would pick it when there is no discrete GPU): without a discrete GPU the
    // models run on the CPU.
    static std::vector<ggml_backend_dev_t> gpus;
    static std::once_flag backend_once;
    std::call_once(backend_once, [] {
        static int all;
        llama_log_set(log_filter, std::getenv("ILS_LLAMA_LOG") ? &all : nullptr);
        llama_backend_init();
        // Without a GPU llama.cpp quietly runs everything on the CPU: say which
        // GPU is used, or that there is none.
        for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
            ggml_backend_dev_t dev = ggml_backend_dev_get(i);
            const auto type = ggml_backend_dev_type(dev);
            if (is_dedicated_gpu(dev)) {
                gpus.push_back(dev);
                std::fprintf(stderr, "inside-llm: GPU %s (%s)\n", ggml_backend_dev_description(dev),
                             ggml_backend_dev_name(dev));
            } else if (type == GGML_BACKEND_DEVICE_TYPE_IGPU) {
                std::fprintf(stderr, "inside-llm: integrated GPU %s (%s) not used\n", ggml_backend_dev_description(dev),
                             ggml_backend_dev_name(dev));
            }
        }
        if (gpus.empty())
#ifdef _WIN32
            std::fprintf(stderr, "inside-llm: warning: no dedicated GPU found, the models run on the CPU and much "
                                 "slower (is the GPU driver installed?)\n");
#else
            std::fprintf(stderr, "inside-llm: warning: no dedicated GPU found, the models run on the CPU and much "
                                 "slower (in Docker, is --gpus all missing?)\n");
#endif
        gpus.push_back(nullptr);
    });
    if (o.n_ctx <= 0) throw std::runtime_error("the context size must be positive");

    check_gguf_file(o.path);
    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = o.gpu_layers;
    mp.devices = gpus.data();  // never NULL: llama.cpp would add an integrated GPU
    model_ = llama_model_load_from_file(o.path.c_str(), mp);
    if (!model_)
        throw std::runtime_error("cannot load model '" + o.path +
                                 "' (see the llama.cpp log above; if the GPU ran out of memory, put fewer layers "
                                 "on it with --gpu-layers-a / --gpu-layers-b)");
    vocab_ = llama_model_get_vocab(model_);
    n_vocab_ = static_cast<uint32_t>(llama_vocab_n_tokens(vocab_));

    // The logit lens reads its weights from the GGUF before the context
    // exists: the context's cb_eval is only set when there is a lens.
    if (o.lens) {
        try {
            const int32_t n_layer = llama_model_n_layer(model_);
            std::vector<int32_t> layers;
            bool fits = true;
            if (o.lens_layers.empty()) {
                layers = default_lens_layers(n_layer);
            } else {
                try {
                    layers = parse_lens_layers(o.lens_layers, n_layer);
                } catch (const std::invalid_argument&) {
                    if (!o.lens_optional) throw;
                    fits = false;
                }
            }
            if (fits)
                lens_ = std::make_unique<LlamaLens>(o.path, llama_model_n_embd(model_), static_cast<int>(n_vocab_),
                                                    std::move(layers), o.lens_threads);
        } catch (const std::exception& e) {
            llama_model_free(model_);
            throw std::runtime_error(e.what());
        }
    }

    // The context is created and freed on the worker thread, its owner.
    worker_ = std::thread(&LlamaModel::worker_loop, this);
    try {
        run_on_worker([this, &o] {
            llama_context_params cp = llama_context_default_params();
            cp.n_ctx = static_cast<uint32_t>(o.n_ctx);
            cp.n_batch = static_cast<uint32_t>(o.n_ctx);  // a whole path fits in one batch
            if (lens_) {
                cp.cb_eval = &LlamaModel::lens_callback;
                cp.cb_eval_user_data = this;
            }
            ctx_ = llama_init_from_model(model_, cp);
            if (!ctx_)
                throw std::runtime_error("cannot create a context of " + std::to_string(o.n_ctx) +
                                         " tokens (if the GPU ran out of memory, try a smaller --ctx or fewer "
                                         "layers with --gpu-layers-a / --gpu-layers-b)");
            n_ctx_ = llama_n_ctx(ctx_);
            n_batch_ = llama_n_batch(ctx_);
        });
    } catch (...) {
        stop_worker();
        llama_model_free(model_);
        throw;
    }
    if (n_batch_ == 0) n_batch_ = 1;

    const std::filesystem::path file(o.path);
    info_.file = file.filename().string();
    info_.name = meta_str(model_, "general.name");
    if (info_.name.empty()) info_.name = file.stem().string();
    info_.arch = meta_str(model_, "general.architecture");
    std::string quant = llama_ftype_name(llama_model_ftype(model_));
    const size_t dash = quant.find(" - ");
    if (dash != std::string::npos) quant.resize(dash);  // "Q2_K - Medium" -> "Q2_K"
    info_.quant = quant;
    info_.n_params = llama_model_n_params(model_);
    info_.size_bytes = llama_model_size(model_);
    info_.n_layer = llama_model_n_layer(model_);
    info_.n_embd = llama_model_n_embd(model_);
    info_.n_ctx = static_cast<int32_t>(n_ctx_);
}

LlamaModel::~LlamaModel() {
    stop_worker();  // frees the context
    lens_.reset();
    tmpls_.reset();
    llama_model_free(model_);
}

// ------------------------------------------------------------ worker thread

void LlamaModel::worker_loop() {
    for (;;) {
        std::packaged_task<void()> job;
        {
            std::unique_lock<std::mutex> lk(mu_);
            cv_.wait(lk, [this] { return stopping_ || !jobs_.empty(); });
            if (jobs_.empty()) break;  // stopping, nothing left
            job = std::move(jobs_.front());
            jobs_.pop_front();
        }
        job();  // exceptions are stored in the job's future
    }
    if (ctx_) {
        llama_free(ctx_);
        ctx_ = nullptr;
    }
}

void LlamaModel::stop_worker() {
    {
        std::lock_guard<std::mutex> lk(mu_);
        stopping_ = true;
    }
    cv_.notify_one();
    if (worker_.joinable()) worker_.join();
}

void LlamaModel::post_on_worker(std::function<void()> fn) {
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (stopping_) return;
        jobs_.emplace_back(std::move(fn));
    }
    cv_.notify_one();
}

void LlamaModel::run_on_worker(std::function<void()> fn) {
    std::lock_guard<std::mutex> call(call_mu_);
    std::packaged_task<void()> job(std::move(fn));
    std::future<void> done = job.get_future();
    {
        std::lock_guard<std::mutex> lk(mu_);
        if (stopping_) throw std::runtime_error("model is shutting down");
        jobs_.push_back(std::move(job));
    }
    cv_.notify_one();
    done.get();
}

// ---------------------------------------------------------------- decoding

bool LlamaModel::lens_callback(ggml_tensor* t, bool ask, void* self) {
    LlamaLens* lens = static_cast<LlamaModel*>(self)->lens_.get();
    return lens ? lens->on_eval(t, ask) : !ask;
}

void LlamaModel::clear_memory() {
    llama_memory_clear(llama_get_memory(ctx_), true);
    held_.clear();
}

void LlamaModel::decode(const std::vector<int32_t>& path, size_t from, size_t to, bool want_logits) {
    if (to <= from) return;
    const int32_t n = static_cast<int32_t>(to - from);
    llama_batch b = llama_batch_init(n, 0, 1);
    for (int32_t i = 0; i < n; ++i) {
        b.token[i] = path[from + i];
        b.pos[i] = static_cast<llama_pos>(from + i);
        b.n_seq_id[i] = 1;
        b.seq_id[i][0] = 0;
        b.logits[i] = want_logits && i == n - 1;
    }
    b.n_tokens = n;
    const int32_t rc = llama_decode(ctx_, b);
    llama_batch_free(b);
    if (rc != 0) {
        // What the context holds is uncertain now: start again from empty.
        clear_memory();
        throw std::runtime_error("llama_decode failed with code " + std::to_string(rc) + " at position " +
                                 std::to_string(from));
    }
    held_.insert(held_.end(), path.begin() + from, path.begin() + to);
}

void LlamaModel::decode_batched(const std::vector<int32_t>& path, size_t from, size_t to) {
    for (size_t i = from; i < to; i += n_batch_) decode(path, i, std::min(to, i + n_batch_), false);
}

void LlamaModel::take_snapshot(bool pinned) {
    // Flags 0: the whole state, valid whatever the context holds later (a
    // partial one keeps only the recurrent state of a hybrid model and gives
    // wrong numbers, silently, once the context holds another path). It does
    // not touch the logits.
    const size_t size = llama_state_seq_get_size_ext(ctx_, 0, 0);
    if (size == 0) return;
    if (!pinned && snapshots_.limit() > 0 && size > snapshots_.limit()) return;  // would not be kept
    std::vector<uint8_t> blob(size);
    if (llama_state_seq_get_data_ext(ctx_, blob.data(), size, 0, 0) != size) return;
    snapshots_.add(held_, std::move(blob), pinned);
}

void LlamaModel::maybe_snapshot() {
    if (exact_ && snapshot_due(held_.size(), snapshot_every_) && !snapshots_.has(held_, held_.size()))
        take_snapshot(false);
}

// Length of the common prefix of a and b.
static size_t common_prefix(const std::vector<int32_t>& a, const std::vector<int32_t>& b) {
    size_t n = 0;
    while (n < a.size() && n < b.size() && a[n] == b[n]) ++n;
    return n;
}

void LlamaModel::check_path(const std::vector<int32_t>& path) const {
    if (path.size() > n_ctx_)
        throw std::runtime_error("the path has " + std::to_string(path.size()) + " tokens and the context holds " +
                                 std::to_string(n_ctx_));
    for (int32_t t : path)
        if (!valid(t)) throw std::runtime_error("token " + std::to_string(t) + " is out of the vocabulary");
}

void LlamaModel::prefill(const std::vector<int32_t>& path) {
    check_path(path);
    run_on_worker([this, &path] {
        const size_t common = common_prefix(held_, path);
        if (common < held_.size()) clear_memory();  // something extra: start again
        decode_batched(path, held_.size(), path.size());
        llama_synchronize(ctx_);
        // The prompt is the reference: its numbers are exact by definition.
        exact_ = true;
        snapshots_.clear();
        if (!path.empty()) take_snapshot(true);
    });
}

void LlamaModel::eval(const std::vector<int32_t>& path, EvalOutput& out) {
    if (path.empty()) throw std::runtime_error("eval of an empty path");
    check_path(path);
    run_on_worker([this, &path, &out] {
        const size_t d = path.size() - 1;
        llama_memory_t mem = llama_get_memory(ctx_);
        out.approximate = false;

        // A context whose restore failed is dirty: plan as if it held a token
        // that matches nothing and cannot be trimmed, which leaves an older
        // snapshot or Clear. Each failure removes a snapshot and a failed
        // trim is not tried again, so this ends.
        static const std::vector<int32_t> dirty_context{-1};
        bool dirty = false;
        for (;;) {
            const Placement pl =
                plan_placement(dirty ? dirty_context : held_, path, can_trim_ && !dirty, snapshots_);
            if (pl.kind == Placement::Continue) break;
            if (pl.kind == Placement::Trim) {
                // Recurrent models (Qwen3.5) cannot trim; once it fails it is
                // not tried again, and the context counts as dirty.
                if (llama_memory_seq_rm(mem, 0, static_cast<llama_pos>(pl.from), -1)) {
                    held_.resize(pl.from);
                    break;
                }
                can_trim_ = false;
                continue;
            }
            if (pl.kind == Placement::Restore) {
                // Like llama-server: set the state, then drop whatever the
                // memory holds past the snapshot's last position.
                const SnapshotCache::Entry* s = pl.snapshot;
                const std::vector<uint8_t>& blob = s->blob;
                if (llama_state_seq_set_data_ext(ctx_, blob.data(), blob.size(), 0, 0) == blob.size() &&
                    llama_memory_seq_rm(mem, 0, static_cast<llama_pos>(s->tokens.size()), -1)) {
                    held_ = s->tokens;
                    exact_ = true;
                    snapshots_.touch(s);
                    break;
                }
                snapshots_.remove(s);
                clear_memory();
                dirty = true;
                continue;
            }
            // Clear: the last resort (no usable context, no snapshot);
            // rebuilt in batches, so not bit-exact.
            clear_memory();
            decode_batched(path, 0, d);
            exact_ = false;
            out.approximate = true;
            break;
        }

        // Missing tokens one at a time: a batch would change the numbers.
        for (size_t i = held_.size(); i < d; ++i) {
            decode(path, i, i + 1, false);
            maybe_snapshot();
        }

        // The lens captures its layers in this decode only: armed, its
        // callback cuts the graph and synchronizes at each captured layer.
        struct Armed {
            LlamaLens* lens;
            explicit Armed(LlamaLens* l) : lens(l) {
                if (lens) lens->arm();
            }
            ~Armed() {
                if (lens) lens->disarm();
            }
        };
        const auto t0 = Clock::now();
        {
            const Armed armed(lens_.get());
            decode(path, d, d + 1, true);
            llama_synchronize(ctx_);
        }
        out.decode_ms = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();

        const float* logits = llama_get_logits_ith(ctx_, -1);
        if (!logits) throw std::runtime_error("llama_get_logits_ith returned no logits");
        out.logits.assign(logits, logits + n_vocab_);

        // The lens, outside decode_ms, with the model's most likely token as
        // the answer (the first of the EVAL's candidates: lowest id on a tie).
        out.lens.clear();
        if (lens_) {
            uint32_t top = 0;
            for (uint32_t i = 1; i < n_vocab_; ++i)
                if (logits[i] > logits[top]) top = i;
            out.lens = lens_->compute(static_cast<int32_t>(top));
        }
    });
    // The periodic snapshot is taken once the logits are on their way, not
    // before: saving costs tens of ms, which would delay the EVAL of a node
    // the user is waiting for (the first after a branch). It only delays the
    // next step, as in any other step that takes one.
    post_on_worker([this] { maybe_snapshot(); });
}

// ------------------------------------------------------------ vocabulary

std::vector<int32_t> LlamaModel::tokenize(const std::string& text, bool add_special, bool parse_special) const {
    if (text.size() > static_cast<size_t>(INT32_MAX) / 2) throw std::runtime_error("the prompt is too long");
    const int32_t len = static_cast<int32_t>(text.size());
    std::vector<llama_token> out(text.size() + 8);
    int32_t n = llama_tokenize(vocab_, text.data(), len, out.data(), static_cast<int32_t>(out.size()), add_special,
                               parse_special);
    if (n < 0 && n != INT32_MIN) {
        out.resize(static_cast<size_t>(-n));
        n = llama_tokenize(vocab_, text.data(), len, out.data(), static_cast<int32_t>(out.size()), add_special,
                           parse_special);
    }
    if (n < 0) throw std::runtime_error("cannot tokenize the prompt");
    out.resize(static_cast<size_t>(n));
    return out;
}

std::vector<int32_t> LlamaModel::tokenize_prompt(const std::string& text, bool chat, const std::string& system) {
    std::vector<int32_t> tokens;
    if (!chat) {
        tokens = tokenize(text, /*add_special=*/true, /*parse_special=*/true);
    } else {
        common_chat_params params;
        try {
            std::lock_guard<std::mutex> lk(tmpl_mu_);
            if (!tmpls_) tmpls_ = common_chat_templates_init(model_, "");
            common_chat_templates_inputs in;
            if (!system.empty()) {
                common_chat_msg sys;
                sys.role = "system";
                sys.content = system;
                in.messages.push_back(sys);
            }
            common_chat_msg usr;
            usr.role = "user";
            usr.content = text;
            in.messages.push_back(usr);
            in.add_generation_prompt = true;
            in.use_jinja = true;
            params = common_chat_templates_apply(tmpls_.get(), in);
        } catch (const std::exception& e) {
            throw std::runtime_error(std::string("cannot apply the chat template: ") + e.what());
        }
        // Like llama-server: the template's leading BOS text has already been
        // stripped when the vocabulary adds BOS itself, so add it once here.
        // Template parts parse special tokens; the user's and system's text don't.
        if (llama_vocab_get_add_bos(vocab_) && llama_vocab_bos(vocab_) != LLAMA_TOKEN_NULL)
            tokens.push_back(llama_vocab_bos(vocab_));
        for (const common_chat_prompt_part& part : params.prompt.parts) {
            const std::vector<int32_t> t = tokenize(part.text, /*add_special=*/false, /*parse_special=*/!part.is_input);
            tokens.insert(tokens.end(), t.begin(), t.end());
        }
    }
    if (tokens.empty()) throw std::runtime_error("the prompt has no tokens");
    return tokens;
}

std::string LlamaModel::piece(int32_t token) const {
    if (!valid(token)) return "";
    std::string buf(32, '\0');
    int32_t n = llama_token_to_piece(vocab_, token, &buf[0], static_cast<int32_t>(buf.size()), 0, /*special=*/true);
    if (n < 0) {
        buf.resize(static_cast<size_t>(-n));
        n = llama_token_to_piece(vocab_, token, &buf[0], static_cast<int32_t>(buf.size()), 0, true);
    }
    buf.resize(n > 0 ? static_cast<size_t>(n) : 0);
    return buf;
}

uint8_t LlamaModel::attr(int32_t token) const {
    if (!valid(token)) return 0;
    uint8_t a = 0;
    if (llama_vocab_is_control(vocab_, token)) a |= ATTR_CONTROL;
    if (llama_vocab_is_eog(vocab_, token)) a |= ATTR_EOG;
    return a;
}

}  // namespace

std::unique_ptr<Model> load_llama_model(const LlamaOptions& options) {
    return std::make_unique<LlamaModel>(options);
}

GpuMemory dedicated_gpu_memory() {
    GpuMemory m;
    for (size_t i = 0; i < ggml_backend_dev_count(); ++i) {
        ggml_backend_dev_t dev = ggml_backend_dev_get(i);
        if (!is_dedicated_gpu(dev)) continue;
        size_t free = 0, total = 0;
        ggml_backend_dev_memory(dev, &free, &total);
        m.free += free;
        m.total += total;
    }
    return m;
}

}  // namespace ils
