// The models folder: GGUF headers, tokenizer fingerprint, VRAM estimate,
// scan and resolve (catalog.h), on metadata-only fixtures. With the real
// files of models/, if they are there, it also checks their fingerprints and
// prints the VRAM estimates.
#include "catalog.h"
#include "check.h"
#include "gguf_fixture.h"

#include <cstdio>
#include <fstream>
#include <string>

using namespace ils;
namespace fs = std::filesystem;

namespace {

const int N_CTX = 4096;

fs::path scratch_dir() {
    const fs::path d = fs::temp_directory_path() / "ils_test_catalog";
    fs::remove_all(d);
    fs::create_directories(d);
    return d;
}

CatalogEntry fixture_entry(const fs::path& dir, const std::string& file, const FixtureGguf& f) {
    write_fixture_gguf(dir / file, f);
    return read_gguf_header(dir / file, N_CTX);
}

void write_text(const fs::path& p, const std::string& s) {
    std::ofstream out(p, std::ios::binary);
    out << s;
}

double gb(uint64_t b) { return static_cast<double>(b) / 1e9; }

void real_files() {
    const fs::path dir = "models";
    auto entry = [&](const char* file) -> std::optional<CatalogEntry> {
        if (!fs::exists(dir / file)) return std::nullopt;
        CatalogEntry e = read_gguf_header(dir / file, N_CTX);
        e.file = file;
        e.size = fs::file_size(dir / file);
        return e;
    };
    const char* files[] = {"Qwen3.5-0.8B-Q4_K_M.gguf", "Qwen3.5-0.8B-Q8_0.gguf",    "Qwen3.5-2B-UD-Q2_K_XL.gguf",
                           "Qwen3.5-2B-Q8_0.gguf",     "Qwen_Qwen3.5-4B-Q2_K.gguf", "Qwen_Qwen3.5-4B-Q8_0.gguf",
                           "google_gemma-4-E4B-it-Q2_K.gguf"};
    std::map<std::string, CatalogEntry> got;
    for (const char* f : files) {
        if (auto e = entry(f)) {
            CHECK(e->error.empty());
            std::printf("%-34s %-8s %-4s %-7s layers %2d vocab %6u tok %s file %.2f GB vram %.2f GB\n", f,
                        e->arch.c_str(), e->size_label.c_str(), e->quant.c_str(), e->n_layer, e->n_vocab,
                        e->tok.c_str(), gb(e->size), gb(e->vram));
            got[f] = *e;
        } else {
            std::printf("%-34s missing, skipped\n", f);
        }
    }
    auto same = [&](const char* a, const char* b) {
        if (!got.count(a) || !got.count(b)) return;
        CHECK_EQ(got[a].tok, got[b].tok);
    };
    auto pair = [&](const char* label, const char* a, const char* b, double measured_gb) {
        if (!got.count(a) || !got.count(b)) return;
        const double est = gb(got[a].vram + got[b].vram);
        std::printf("%s pair: estimate %.2f GB, measured %.2f GB (%+.1f %%)\n", label, est, measured_gb,
                    100.0 * (est - measured_gb) / measured_gb);
    };
    same("Qwen3.5-2B-UD-Q2_K_XL.gguf", "Qwen3.5-2B-Q8_0.gguf");
    same("Qwen_Qwen3.5-4B-Q2_K.gguf", "Qwen_Qwen3.5-4B-Q8_0.gguf");
    same("Qwen3.5-0.8B-Q4_K_M.gguf", "Qwen3.5-0.8B-Q8_0.gguf");
    // Every Qwen3.5 size, unsloth's and bartowski's: one tokenizer.
    same("Qwen3.5-0.8B-Q8_0.gguf", "Qwen3.5-2B-Q8_0.gguf");
    same("Qwen3.5-2B-Q8_0.gguf", "Qwen_Qwen3.5-4B-Q8_0.gguf");
    if (got.count("Qwen3.5-2B-Q8_0.gguf") && got.count("google_gemma-4-E4B-it-Q2_K.gguf")) {
        CHECK(got["Qwen3.5-2B-Q8_0.gguf"].tok != got["google_gemma-4-E4B-it-Q2_K.gguf"].tok);
    }
    if (got.count("Qwen3.5-2B-Q8_0.gguf")) {
        const CatalogEntry& e = got["Qwen3.5-2B-Q8_0.gguf"];
        CHECK_EQ(e.arch, std::string("qwen35"));
        CHECK_EQ(e.quant, std::string("Q8_0"));
        CHECK_EQ(e.n_layer, 24);
        CHECK_EQ(e.n_vocab, 248320u);
    }
    if (got.count("Qwen_Qwen3.5-4B-Q8_0.gguf")) CHECK_EQ(got["Qwen_Qwen3.5-4B-Q8_0.gguf"].n_layer, 32);  // 33 - MTP
    // The engine's process in nvidia-smi at n_ctx 4096, in MiB (CUDA, a
    // 16 GB GPU).
    const double mib = 1048576.0 / 1e9;
    pair("Development", "Qwen3.5-2B-UD-Q2_K_XL.gguf", "Qwen3.5-2B-Q8_0.gguf", 4194 * mib);
    pair("Demo", "Qwen_Qwen3.5-4B-Q2_K.gguf", "Qwen_Qwen3.5-4B-Q8_0.gguf", 7838 * mib);
    auto single = [&](const char* f, double measured_gb) {
        if (!got.count(f)) return;
        const double est = gb(got[f].vram);
        std::printf("%s alone: estimate %.2f GB, measured %.2f GB (%+.1f %%)\n", f, est, measured_gb,
                    100.0 * (est - measured_gb) / measured_gb);
    };
    single("Qwen3.5-0.8B-Q4_K_M.gguf", 1288 * mib);
    single("Qwen3.5-2B-UD-Q2_K_XL.gguf", 1710 * mib);
    single("Qwen3.5-2B-Q8_0.gguf", 2708 * mib);
    single("Qwen_Qwen3.5-4B-Q8_0.gguf", 5190 * mib);
    single("google_gemma-4-E4B-it-Q2_K.gguf", 3066 * mib);
}

}  // namespace

int main() {
    // Plain names.
    CHECK(is_plain_gguf_name("Qwen3.5-2B-Q8_0.gguf"));
    CHECK(is_plain_gguf_name("a.gguf"));
    CHECK(!is_plain_gguf_name(".gguf"));
    CHECK(!is_plain_gguf_name("model.GGUF"));
    CHECK(!is_plain_gguf_name("model.gguf.downloadInProgress"));
    CHECK(!is_plain_gguf_name("model-00001-of-00003.gguf"));
    CHECK(is_plain_gguf_name("model-0001-of-0003.gguf"));
    CHECK(!is_plain_gguf_name("../x.gguf"));
    CHECK(!is_plain_gguf_name("a/b.gguf"));
    CHECK(!is_plain_gguf_name("a\\b.gguf"));
    CHECK(!is_plain_gguf_name("C:x.gguf"));
    CHECK(!is_plain_gguf_name("a..b.gguf"));
    CHECK(!is_plain_gguf_name(""));

    const fs::path dir = scratch_dir();

    // Header fields and the fingerprint.
    const FixtureGguf base;
    const CatalogEntry e0 = fixture_entry(dir, "base.gguf", base);
    CHECK(e0.error.empty());
    CHECK_EQ(e0.name, std::string("Fixture"));
    CHECK_EQ(e0.arch, std::string("llama"));
    CHECK_EQ(e0.size_label, std::string("1B"));
    CHECK_EQ(e0.quant, std::string("Q8_0"));
    CHECK_EQ(e0.n_layer, 4);
    CHECK_EQ(e0.n_vocab, 5u);
    CHECK_EQ(e0.tok.size(), 16u);
    CHECK(e0.tok.find_first_not_of("0123456789abcdef") == std::string::npos);
    {
        // Same tokenizer, other model metadata: same fingerprint.
        FixtureGguf f = base;
        f.name = "Other";
        f.file_type = 15;
        f.n_layer = 8;
        const CatalogEntry e = fixture_entry(dir, "same.gguf", f);
        CHECK_EQ(e.tok, e0.tok);
        CHECK_EQ(e.quant, std::string("Q4_K_M"));
    }
    {
        FixtureGguf f = base;
        f.tokens[2] = "x";
        CHECK(fixture_entry(dir, "text.gguf", f).tok != e0.tok);
    }
    {
        FixtureGguf f = base;
        f.token_type = {3, 3, 1, 1, 1};
        CHECK(fixture_entry(dir, "type.gguf", f).tok != e0.tok);
    }
    {
        FixtureGguf f = base;
        f.eos = 2;
        CHECK(fixture_entry(dir, "eos.gguf", f).tok != e0.tok);
    }
    {
        // The pad id does not count (quantizers set it differently).
        write_fixture_gguf(dir / "pad.gguf", base);
        gguf_context* c = gguf_init_from_file((dir / "pad.gguf").string().c_str(), {true, nullptr});
        CHECK(c != nullptr);
        gguf_context* w = gguf_init_empty();
        gguf_set_kv(w, c);
        gguf_free(c);
        gguf_set_val_u32(w, "tokenizer.ggml.padding_token_id", 3);
        CHECK(gguf_write_to_file(w, (dir / "pad.gguf").string().c_str(), false));
        gguf_free(w);
        CHECK_EQ(read_gguf_header(dir / "pad.gguf", N_CTX).tok, e0.tok);
    }
    {
        FixtureGguf f = base;
        f.bos = 4;
        CHECK(fixture_entry(dir, "bos.gguf", f).tok != e0.tok);
    }
    {
        FixtureGguf f = base;
        f.tok_pre = "qwen35";
        CHECK(fixture_entry(dir, "pre.gguf", f).tok != e0.tok);
    }
    {
        // Tokens split differently ("ab" + "c" against "a" + "bc").
        FixtureGguf f = base, g = base;
        f.tokens = {"<s>", "</s>", "ab", "c", "d"};
        g.tokens = {"<s>", "</s>", "a", "bc", "d"};
        CHECK(fixture_entry(dir, "split1.gguf", f).tok != fixture_entry(dir, "split2.gguf", g).tok);
    }

    // VRAM: weights + KV (f16) + margin. 4 layers x 2 KV heads x (32 + 32)
    // x 2 bytes = 1024 bytes per token (n_embd 256 / 8 heads = 32).
    {
        const uint64_t size = fs::file_size(dir / "base.gguf");
        const uint64_t no_kv = estimate_vram(size, KvShape{}, N_CTX);
        CHECK_EQ(e0.vram - no_kv, 1024ull * N_CTX);
        KvShape kv;
        kv.head_count_kv = {2, 0, 2};
        kv.key_length = 128;
        kv.value_length = 64;
        CHECK_EQ(estimate_vram(0, kv, 10) - estimate_vram(0, KvShape{}, 10), 10ull * 4 * 192 * 2);
    }
    {
        // Per-layer KV heads with layers without attention, explicit lengths.
        FixtureGguf f = base;
        f.head_count_kv = {0, 2, 0, 4};
        f.key_length = 64;
        f.value_length = 32;
        const CatalogEntry e = fixture_entry(dir, "perlayer.gguf", f);
        const uint64_t no_kv = estimate_vram(fs::file_size(dir / "perlayer.gguf"), KvShape{}, N_CTX);
        CHECK_EQ(e.vram - no_kv, 6ull * (64 + 32) * 2 * N_CTX);
    }
    {
        // No head_count_kv: as many as head_count (8). No name: the stem.
        FixtureGguf f = base;
        f.head_count_kv.clear();
        f.name.clear();
        f.size_label.clear();
        f.file_type = -1;
        const CatalogEntry e = fixture_entry(dir, "bare-model.gguf", f);
        CHECK(e.error.empty());
        CHECK_EQ(e.name, std::string("bare-model"));
        CHECK(e.size_label.empty());
        CHECK(e.quant.empty());
        const uint64_t no_kv = estimate_vram(fs::file_size(dir / "bare-model.gguf"), KvShape{}, N_CTX);
        CHECK_EQ(e.vram - no_kv, 4ull * 8 * 64 * 2 * N_CTX);
    }
    {
        // Almost nothing in the header: no KV, no tokens, still a fingerprint.
        gguf_context* c = gguf_init_empty();
        gguf_set_val_str(c, "general.architecture", "mystery");
        CHECK(gguf_write_to_file(c, (dir / "empty.gguf").string().c_str(), false));
        gguf_free(c);
        const CatalogEntry e = read_gguf_header(dir / "empty.gguf", N_CTX);
        CHECK(e.error.empty());
        CHECK_EQ(e.arch, std::string("mystery"));
        CHECK_EQ(e.n_layer, 0);
        CHECK_EQ(e.n_vocab, 0u);
        CHECK_EQ(e.tok.size(), 16u);
        CHECK_EQ(e.vram, estimate_vram(fs::file_size(dir / "empty.gguf"), KvShape{}, N_CTX));
    }
    {
        // Qwen3.5-like: recurrent layers by full_attention_interval, and an
        // MTP layer (nextn_predict_layers) that is not counted.
        FixtureGguf f = base;
        f.n_layer = 9;
        f.key_length = 16;
        f.value_length = 16;
        write_fixture_gguf(dir / "hybrid.gguf", f);
        gguf_context* c = gguf_init_from_file((dir / "hybrid.gguf").string().c_str(), {true, nullptr});
        CHECK(c != nullptr);
        gguf_context* w = gguf_init_empty();
        gguf_set_kv(w, c);
        gguf_free(c);
        gguf_set_val_u32(w, "llama.full_attention_interval", 4);
        gguf_set_val_u32(w, "llama.nextn_predict_layers", 1);
        CHECK(gguf_write_to_file(w, (dir / "hybrid.gguf").string().c_str(), false));
        gguf_free(w);
        const CatalogEntry e = read_gguf_header(dir / "hybrid.gguf", N_CTX);
        CHECK_EQ(e.n_layer, 8);
        // Attention in layers 3 and 7 only, 2 KV heads each.
        const uint64_t no_kv = estimate_vram(fs::file_size(dir / "hybrid.gguf"), KvShape{}, N_CTX);
        CHECK_EQ(e.vram - no_kv, 2ull * 2 * 32 * 2 * N_CTX);
    }
    {
        // Not a GGUF: an entry with the error and nothing else.
        write_text(dir / "corrupt.gguf", "this is not a gguf file at all");
        const CatalogEntry e = read_gguf_header(dir / "corrupt.gguf", N_CTX);
        CHECK(!e.error.empty());
        CHECK(e.name.empty());
        CHECK(e.tok.empty());
        CHECK_EQ(e.vram, 0u);
    }

    // The folder: scan, cache, resolve.
    {
        const fs::path md = dir / "models";
        Catalog cat(md, N_CTX);  // created
        CHECK(fs::is_directory(md));
        CHECK(cat.scan().empty());

        write_fixture_gguf(md / "b.gguf", base);
        FixtureGguf other = base;
        other.tokens.push_back("d");
        write_fixture_gguf(md / "a.gguf", other);
        write_fixture_gguf(md / "split-00001-of-00002.gguf", base);
        write_fixture_gguf(md / "c.gguf.downloadInProgress", base);
        write_text(md / "c.gguf.lock", "");
        write_text(md / "notes.txt", "hello");
        write_text(md / "bad.gguf", "garbage");
        fs::create_directories(md / "sub");
        write_fixture_gguf(md / "sub" / "inner.gguf", base);
        fs::create_directories(md / "dir.gguf");

        std::vector<CatalogEntry> list = cat.scan();
        CHECK_EQ(list.size(), 3u);
        if (list.size() == 3) {
            CHECK_EQ(list[0].file, std::string("a.gguf"));
            CHECK_EQ(list[1].file, std::string("b.gguf"));
            CHECK_EQ(list[2].file, std::string("bad.gguf"));
            CHECK_EQ(list[1].size, static_cast<uint64_t>(fs::file_size(md / "b.gguf")));
            CHECK_EQ(list[1].tok, e0.tok);
            CHECK(list[0].tok != e0.tok);
            CHECK(!list[2].error.empty());
            CHECK_EQ(list[2].size, 7u);
        }

        // Cached by (file, size, mtime): bytes changed behind the catalog's
        // back, with the same size and mtime, are not read again...
        const auto mtime = fs::last_write_time(md / "b.gguf");
        const uint64_t size = fs::file_size(md / "b.gguf");
        {
            std::fstream io(md / "b.gguf", std::ios::in | std::ios::out | std::ios::binary);
            io.seekp(0);
            io.write("XXXX", 4);  // the magic
        }
        fs::last_write_time(md / "b.gguf", mtime);
        CHECK_EQ(fs::file_size(md / "b.gguf"), size);
        list = cat.scan();
        CHECK(list.size() == 3 && list[1].error.empty() && list[1].tok == e0.tok);

        // ...and a rewritten file is.
        FixtureGguf changed = base;
        changed.tokens = {"<s>", "</s>", "p", "q", "r", "s"};
        write_fixture_gguf(md / "b.gguf", changed);
        list = cat.scan();
        CHECK(list.size() == 3 && list[1].tok != e0.tok && list[1].n_vocab == 6);

        // A removed file goes away.
        fs::remove(md / "a.gguf");
        list = cat.scan();
        CHECK(list.size() == 2 && list[0].file == "b.gguf");

        // resolve: plain names that exist, never outside the folder.
        CHECK(cat.resolve("b.gguf").has_value());
        if (auto p = cat.resolve("b.gguf")) CHECK(*p == md / "b.gguf");
        CHECK(!cat.resolve("a.gguf"));
        CHECK(!cat.resolve("zz.gguf"));
        CHECK(!cat.resolve("../base.gguf"));
        CHECK(!cat.resolve("sub/inner.gguf"));
        CHECK(!cat.resolve("split-00001-of-00002.gguf"));
        CHECK(!cat.resolve("dir.gguf"));
        CHECK(!cat.resolve("notes.txt"));
        CHECK_EQ(cat.n_ctx(), N_CTX);
    }

    fs::remove_all(dir);
    real_files();
    return test_result();
}
