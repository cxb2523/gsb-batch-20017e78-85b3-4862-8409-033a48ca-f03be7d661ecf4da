// The models folder: GGUF headers, tokenizer fingerprint and VRAM estimate
// (catalog.h).
#include "catalog.h"

#include <gguf.h>

#include <algorithm>
#include <cstdio>
#include <memory>
#include <stdexcept>
#include <system_error>

namespace fs = std::filesystem;

namespace ils {

namespace {

// Compute buffers, the backend's context and allocator slack: what a model
// takes on the GPU besides its weights and KV cache. Calibrated with
// nvidia-smi (CUDA, n_ctx 4096) on Qwen3.5 and Gemma 4 models, alone and in
// pairs: the estimate lands within 10% of the measured memory.
constexpr uint64_t VRAM_MARGIN = 650ull << 20;

// llama.cpp's llama_ftype values (llama.h), named as GGUF files are.
const char* quant_name(uint32_t ftype) {
    switch (ftype) {
        case 0: return "F32";
        case 1: return "F16";
        case 2: return "Q4_0";
        case 3: return "Q4_1";
        case 7: return "Q8_0";
        case 8: return "Q5_0";
        case 9: return "Q5_1";
        case 10: return "Q2_K";
        case 11: return "Q3_K_S";
        case 12: return "Q3_K_M";
        case 13: return "Q3_K_L";
        case 14: return "Q4_K_S";
        case 15: return "Q4_K_M";
        case 16: return "Q5_K_S";
        case 17: return "Q5_K_M";
        case 18: return "Q6_K";
        case 19: return "IQ2_XXS";
        case 20: return "IQ2_XS";
        case 21: return "Q2_K_S";
        case 22: return "IQ3_XS";
        case 23: return "IQ3_XXS";
        case 24: return "IQ1_S";
        case 25: return "IQ4_NL";
        case 26: return "IQ3_S";
        case 27: return "IQ3_M";
        case 28: return "IQ2_S";
        case 29: return "IQ2_M";
        case 30: return "IQ4_XS";
        case 31: return "IQ1_M";
        case 32: return "BF16";
        case 36: return "TQ1_0";
        case 37: return "TQ2_0";
        case 38: return "MXFP4_MOE";
        case 39: return "NVFP4";
        case 40: return "Q1_0";
        case 41: return "Q2_0";
        case 42: return "F8_E4M3";
        default: return "";
    }
}

struct GgufFree {
    void operator()(gguf_context* c) const { gguf_free(c); }
};
using Gguf = std::unique_ptr<gguf_context, GgufFree>;

bool is_int_type(gguf_type t) {
    switch (t) {
        case GGUF_TYPE_UINT8:
        case GGUF_TYPE_INT8:
        case GGUF_TYPE_UINT16:
        case GGUF_TYPE_INT16:
        case GGUF_TYPE_UINT32:
        case GGUF_TYPE_INT32:
        case GGUF_TYPE_UINT64:
        case GGUF_TYPE_INT64:
        case GGUF_TYPE_BOOL: return true;
        default: return false;
    }
}

// Element `i` of raw data of an integer type, as int64 (negative stays negative).
int64_t int_at(const void* data, gguf_type t, size_t i) {
    switch (t) {
        case GGUF_TYPE_UINT8: return static_cast<const uint8_t*>(data)[i];
        case GGUF_TYPE_INT8: return static_cast<const int8_t*>(data)[i];
        case GGUF_TYPE_UINT16: return static_cast<const uint16_t*>(data)[i];
        case GGUF_TYPE_INT16: return static_cast<const int16_t*>(data)[i];
        case GGUF_TYPE_UINT32: return static_cast<const uint32_t*>(data)[i];
        case GGUF_TYPE_INT32: return static_cast<const int32_t*>(data)[i];
        case GGUF_TYPE_UINT64: return static_cast<int64_t>(static_cast<const uint64_t*>(data)[i]);
        case GGUF_TYPE_INT64: return static_cast<const int64_t*>(data)[i];
        case GGUF_TYPE_BOOL: return static_cast<const int8_t*>(data)[i] != 0;
        default: return 0;
    }
}

std::optional<std::string> get_str(const gguf_context* c, const std::string& key) {
    const int64_t id = gguf_find_key(c, key.c_str());
    if (id < 0 || gguf_get_kv_type(c, id) != GGUF_TYPE_STRING) return std::nullopt;
    return std::string(gguf_get_val_str(c, id));
}

std::optional<int64_t> get_int(const gguf_context* c, const std::string& key) {
    const int64_t id = gguf_find_key(c, key.c_str());
    if (id < 0) return std::nullopt;
    const gguf_type t = gguf_get_kv_type(c, id);
    if (!is_int_type(t)) return std::nullopt;
    return int_at(gguf_get_val_data(c, id), t, 0);
}

// An integer key that may be a scalar or a per-layer array.
std::optional<std::vector<int64_t>> get_ints(const gguf_context* c, const std::string& key) {
    const int64_t id = gguf_find_key(c, key.c_str());
    if (id < 0) return std::nullopt;
    const gguf_type t = gguf_get_kv_type(c, id);
    if (is_int_type(t)) return std::vector<int64_t>{int_at(gguf_get_val_data(c, id), t, 0)};
    if (t != GGUF_TYPE_ARRAY) return std::nullopt;
    const gguf_type at = gguf_get_arr_type(c, id);
    if (!is_int_type(at)) return std::nullopt;
    const size_t n = gguf_get_arr_n(c, id);
    const void* data = gguf_get_arr_data(c, id);
    std::vector<int64_t> out(n);
    for (size_t i = 0; i < n; ++i) out[i] = int_at(data, at, i);
    return out;
}

uint32_t to_u32(int64_t v) {
    return v < 0 ? 0 : v > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(v);
}

// FNV-1a 64. Every field is tagged and length-prefixed, so different splits
// of the same bytes never collide by construction.
struct Fnv {
    uint64_t h = 14695981039346656037ull;
    void bytes(const void* p, size_t n) {
        const auto* b = static_cast<const unsigned char*>(p);
        for (size_t i = 0; i < n; ++i) {
            h ^= b[i];
            h *= 1099511628211ull;
        }
    }
    void u8(uint8_t v) { bytes(&v, 1); }
    void u64(uint64_t v) {
        unsigned char b[8];
        for (int i = 0; i < 8; ++i) b[i] = static_cast<unsigned char>(v >> (8 * i));
        bytes(b, 8);
    }
    void str(const char* s) {
        const size_t n = std::char_traits<char>::length(s);
        u64(n);
        bytes(s, n);
    }
    void absent() { u8(0); }
    void present() { u8(1); }
};

std::string tokenizer_fingerprint(const gguf_context* c) {
    Fnv f;
    for (const char* key : {"tokenizer.ggml.model", "tokenizer.ggml.pre"}) {
        if (const auto s = get_str(c, key)) {
            f.present();
            f.str(s->c_str());
        } else {
            f.absent();
        }
    }
    const int64_t tok = gguf_find_key(c, "tokenizer.ggml.tokens");
    if (tok >= 0 && gguf_get_kv_type(c, tok) == GGUF_TYPE_ARRAY && gguf_get_arr_type(c, tok) == GGUF_TYPE_STRING) {
        const size_t n = gguf_get_arr_n(c, tok);
        f.present();
        f.u64(n);
        for (size_t i = 0; i < n; ++i) f.str(gguf_get_arr_str(c, tok, i));
    } else {
        f.absent();
    }
    if (const auto types = get_ints(c, "tokenizer.ggml.token_type")) {
        f.present();
        f.u64(types->size());
        for (int64_t t : *types) f.u64(static_cast<uint64_t>(t));
    } else {
        f.absent();
    }
    // Not pad, unk or sep: they change neither the tokens nor where
    // generation ends, and quantizers set pad differently (catalog.h).
    for (const char* key : {"tokenizer.ggml.bos_token_id", "tokenizer.ggml.eos_token_id",
                            "tokenizer.ggml.eot_token_id", "tokenizer.ggml.eom_token_id"}) {
        if (const auto v = get_int(c, key)) {
            f.present();
            f.u64(static_cast<uint64_t>(*v));
        } else {
            f.absent();
        }
    }
    char hex[17];
    std::snprintf(hex, sizeof hex, "%016llx", static_cast<unsigned long long>(f.h));
    return hex;
}

// The KV cache's shape. Layers without attention get head_count_kv 0: a 0
// in a per-layer array, the recurrent layers of a hybrid model
// (<arch>.attention.recurrent_layers, or <arch>.full_attention_interval as
// llama.cpp reads it for Qwen3.5) and the multi-token-prediction layers
// llama.cpp does not run (<arch>.nextn_predict_layers). Empty when the
// header does not say.
KvShape kv_shape(const gguf_context* c, const std::string& arch, uint32_t n_layer_all, uint32_t n_nextn) {
    KvShape kv;
    if (n_layer_all == 0) return kv;
    auto hkv = get_ints(c, arch + ".attention.head_count_kv");
    const auto heads = get_ints(c, arch + ".attention.head_count");
    if (!hkv) hkv = heads;  // llama.cpp's default: as many KV heads as heads
    if (!hkv || hkv->empty()) return kv;
    kv.head_count_kv.assign(n_layer_all, 0);
    for (uint32_t i = 0; i < n_layer_all; ++i) {
        kv.head_count_kv[i] = to_u32(hkv->size() == 1 ? (*hkv)[0] : i < hkv->size() ? (*hkv)[i] : 0);
    }
    const uint32_t n_layer = n_layer_all - std::min(n_nextn, n_layer_all);
    if (const auto recurrent = get_ints(c, arch + ".attention.recurrent_layers");
        recurrent && recurrent->size() > 1) {
        for (uint32_t i = 0; i < n_layer_all && i < recurrent->size(); ++i) {
            if ((*recurrent)[i]) kv.head_count_kv[i] = 0;
        }
    } else if (const auto interval = get_int(c, arch + ".full_attention_interval"); interval && *interval > 0) {
        for (uint32_t i = 0; i < n_layer; ++i) {
            if ((i + 1) % static_cast<uint64_t>(*interval) != 0) kv.head_count_kv[i] = 0;
        }
    }
    for (uint32_t i = n_layer; i < n_layer_all; ++i) kv.head_count_kv[i] = 0;

    kv.key_length = to_u32(get_int(c, arch + ".attention.key_length").value_or(0));
    kv.value_length = to_u32(get_int(c, arch + ".attention.value_length").value_or(0));
    if (!kv.key_length || !kv.value_length) {
        const int64_t n_embd = get_int(c, arch + ".embedding_length").value_or(0);
        int64_t n_head = 0;
        if (heads) {
            for (int64_t h : *heads) {
                if (h > 0) {
                    n_head = h;
                    break;
                }
            }
        }
        const uint32_t per_head = n_head > 0 ? to_u32(n_embd / n_head) : 0;
        if (!kv.key_length) kv.key_length = per_head;
        if (!kv.value_length) kv.value_length = per_head;
    }
    if (!kv.key_length || !kv.value_length) kv = KvShape{};
    return kv;
}

// Bytes of the tensors llama.cpp keeps in RAM, not on the GPU: those of the
// input layer (token_embd, per_layer_token_embd). With tied embeddings (no
// output.weight) token_embd also serves as the output matrix, on the GPU.
uint64_t host_tensor_bytes(const gguf_context* c) {
    auto size_of = [&](const char* name) -> uint64_t {
        const int64_t id = gguf_find_tensor(c, name);
        return id < 0 ? 0 : static_cast<uint64_t>(gguf_get_tensor_size(c, id));
    };
    uint64_t bytes = size_of("per_layer_token_embd.weight");
    if (gguf_find_tensor(c, "output.weight") >= 0) bytes += size_of("token_embd.weight");
    return bytes;
}

bool ends_with(const std::string& s, const std::string& suffix) {
    return s.size() >= suffix.size() && s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}

bool is_digits(const std::string& s, size_t pos, size_t n) {
    if (pos + n > s.size()) return false;
    for (size_t i = pos; i < pos + n; ++i) {
        if (s[i] < '0' || s[i] > '9') return false;
    }
    return true;
}

}  // namespace

bool is_plain_gguf_name(const std::string& name) {
    static const std::string ext = ".gguf";
    if (name.size() <= ext.size() || !ends_with(name, ext)) return false;
    if (name.find_first_of("/\\:") != std::string::npos) return false;
    if (name.find("..") != std::string::npos) return false;
    for (unsigned char ch : name) {
        if (ch < 0x20 || ch == 0x7f) return false;
    }
    // "-00001-of-00003.gguf": 20 characters before the end.
    const size_t n = name.size();
    if (n >= 20) {
        const size_t p = n - 20;
        if (name[p] == '-' && is_digits(name, p + 1, 5) && name.compare(p + 6, 4, "-of-") == 0 &&
            is_digits(name, p + 10, 5)) {
            return false;
        }
    }
    return true;
}

uint64_t estimate_vram(uint64_t file_size, const KvShape& kv, int n_ctx) {
    uint64_t per_token = 0;
    for (uint32_t h : kv.head_count_kv) {
        per_token += static_cast<uint64_t>(h) * (static_cast<uint64_t>(kv.key_length) + kv.value_length) * 2;
    }
    return file_size + per_token * static_cast<uint64_t>(std::max(n_ctx, 0)) + VRAM_MARGIN;
}

CatalogEntry read_gguf_header(const fs::path& path, int n_ctx) {
    CatalogEntry e;
    try {
        gguf_init_params params{};
        params.no_alloc = true;
        params.ctx = nullptr;
        Gguf c(gguf_init_from_file(path.u8string().c_str(), params));
        if (!c) {
            e.error = "cannot read the GGUF header";
            return e;
        }
        const gguf_context* g = c.get();
        e.arch = get_str(g, "general.architecture").value_or("");
        e.name = get_str(g, "general.name").value_or("");
        if (e.name.empty()) e.name = path.stem().u8string();
        e.size_label = get_str(g, "general.size_label").value_or("");
        if (const auto ft = get_int(g, "general.file_type"); ft && *ft >= 0) {
            e.quant = quant_name(static_cast<uint32_t>(*ft));
        }
        uint32_t n_layer_all = 0, n_nextn = 0;
        if (!e.arch.empty()) {
            n_layer_all = to_u32(get_int(g, e.arch + ".block_count").value_or(0));
            n_nextn = std::min(to_u32(get_int(g, e.arch + ".nextn_predict_layers").value_or(0)), n_layer_all);
        }
        // As llama_model_n_layer counts them: without the MTP layers.
        e.n_layer = static_cast<int32_t>(std::min<uint32_t>(n_layer_all - n_nextn, INT32_MAX));
        const int64_t tok = gguf_find_key(g, "tokenizer.ggml.tokens");
        if (tok >= 0 && gguf_get_kv_type(g, tok) == GGUF_TYPE_ARRAY) {
            e.n_vocab = static_cast<uint32_t>(gguf_get_arr_n(g, tok));
        }
        e.tok = tokenizer_fingerprint(g);
        const KvShape kv = e.arch.empty() ? KvShape{} : kv_shape(g, e.arch, n_layer_all, n_nextn);
        std::error_code ec;
        const uintmax_t size = fs::file_size(path, ec);
        const uint64_t file_size = ec ? 0 : static_cast<uint64_t>(size);
        const uint64_t host = std::min(host_tensor_bytes(g), file_size);
        e.vram = estimate_vram(file_size - host, kv, n_ctx);
    } catch (const std::exception& ex) {
        CatalogEntry bad;
        bad.error = std::string("cannot read the GGUF header: ") + ex.what();
        return bad;
    }
    return e;
}

Catalog::Catalog(fs::path dir, int n_ctx) : dir_(std::move(dir)), n_ctx_(n_ctx) {
    std::error_code ec;
    fs::create_directories(dir_, ec);
    if (!fs::is_directory(dir_, ec)) {
        throw std::runtime_error("cannot create the models folder '" + dir_.u8string() + "'");
    }
}

std::vector<CatalogEntry> Catalog::scan() {
    std::lock_guard<std::mutex> lock(mu_);
    std::map<std::string, CatalogEntry> seen;
    std::error_code ec;
    for (fs::directory_iterator it(dir_, ec), end; !ec && it != end; it.increment(ec)) {
        std::error_code fec;
        if (!it->is_regular_file(fec)) continue;
        const std::string file = it->path().filename().u8string();
        if (!is_plain_gguf_name(file)) continue;
        const uintmax_t size = it->file_size(fec);
        if (fec) continue;
        const auto mtime = it->last_write_time(fec);
        if (fec) continue;
        const int64_t mt = static_cast<int64_t>(mtime.time_since_epoch().count());
        const auto cached = cache_.find(file);
        if (cached != cache_.end() && cached->second.size == size && cached->second.mtime == mt) {
            seen.emplace(file, cached->second);
            continue;
        }
        CatalogEntry e = read_gguf_header(it->path(), n_ctx_);
        e.file = file;
        e.size = static_cast<uint64_t>(size);
        e.mtime = mt;
        seen.emplace(file, std::move(e));
    }
    cache_ = seen;  // forgets the files that are gone
    std::vector<CatalogEntry> out;
    out.reserve(seen.size());
    for (auto& kv : seen) out.push_back(std::move(kv.second));
    return out;  // std::map: sorted by file name
}

std::optional<fs::path> Catalog::resolve(const std::string& file) const {
    if (!is_plain_gguf_name(file)) return std::nullopt;
    const fs::path p = dir_ / fs::u8path(file);
    std::error_code ec;
    if (!fs::is_regular_file(p, ec)) return std::nullopt;
    return p;
}

}  // namespace ils
