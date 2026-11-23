// Encoding of every frame type, byte by byte, against the wire protocol.
#include "check.h"
#include "frames.h"

#include <nlohmann/json.hpp>

#include <cstring>
#include <string>
#include <vector>

using namespace ils;

static uint32_t u32(const uint8_t* p) {
    return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}

static float f32(const uint8_t* p) {
    const uint32_t u = u32(p);
    float f;
    std::memcpy(&f, &u, sizeof(f));
    return f;
}

static nlohmann::json body_json(const FrameView& f) {
    return nlohmann::json::parse(std::string(reinterpret_cast<const char*>(f.body), f.length));
}

int main() {
    // CURSOR: the whole frame, header included.
    {
        Bytes b;
        write_cursor(b, 0x01020304, 5, NONE);
        const Bytes expected = {7, 0, 0, 0, 8, 0, 0, 0, 0x04, 0x03, 0x02, 0x01,
                                5, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF};
        CHECK(b == expected);
    }

    // NODE: 17-byte body.
    {
        Bytes b;
        write_node(b, 1, {7, 6, 0x00012345, 9, ORIGIN_MODEL});
        const Bytes expected = {4, 0, 0, 0, 17, 0, 0, 0, 1, 0, 0, 0,
                                7, 0, 0, 0, 6, 0, 0, 0, 0x45, 0x23, 0x01, 0, 9, 0, 0, 0, 1};
        CHECK(b == expected);
    }

    // STOP: 6-byte body.
    {
        Bytes b;
        write_stop(b, 2, 300, SLOT_A, StopReason::MaxTokens);
        const Bytes expected = {8, 0, 0, 0, 6, 0, 0, 0, 2, 0, 0, 0, 0x2C, 0x01, 0, 0, 0, 1};
        CHECK(b == expected);
    }

    // PAIR: 25-byte body. 0.5f is 0x3F000000, 0.25f is 0x3E800000, 2.0f is 0x40000000.
    {
        PairRec p;
        p.node = 9;
        p.js = 0.5f;
        p.kl_ab = 0.25f;
        p.kl_ba = 2.0f;
        p.rank_a_in_b = 3;
        p.rank_b_in_a = NONE;
        p.flags = PAIR_SAME_PICK | PAIR_APPROX;
        Bytes b;
        write_pair(b, 7, p);
        const Bytes expected = {6, 0, 0, 0, 25, 0, 0, 0, 7, 0, 0, 0,
                                9, 0, 0, 0,
                                0, 0, 0, 0x3F, 0, 0, 0x80, 0x3E, 0, 0, 0, 0x40,
                                3, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0xFF,
                                6};
        CHECK(b == expected);
    }

    // VOCAB: count, then token, attr, length and raw bytes per entry.
    {
        Bytes b;
        write_vocab(b, 0, {{258, ATTR_CONTROL | ATTR_EOG, "<e>"}, {3, 0, std::string("\xC3", 1)}});
        const Bytes expected = {2, 0, 0, 0, 22, 0, 0, 0, 0, 0, 0, 0,
                                2, 0, 0, 0,
                                0x02, 0x01, 0, 0, 3, 3, 0, '<', 'e', '>',
                                3, 0, 0, 0, 0, 1, 0, 0xC3};
        CHECK(b == expected);
    }

    // EVAL without gates: 24 bytes of fixed fields, then 8 per entry.
    {
        EvalRec e;
        e.node = 11;
        e.slot = SLOT_A;
        e.pick = 1;
        e.entropy = 1.5f;
        e.raw_mass = 0.75f;
        e.decode_ms = 4.25f;
        e.entries = {{100, 0.5f}, {200, 0.25f}};
        Bytes b;
        write_eval(b, 9, e);
        std::vector<FrameView> f;
        CHECK(split_frames(b, f));
        CHECK_EQ(f.size(), 1u);
        CHECK(f[0].type == FrameType::Eval);
        CHECK_EQ(f[0].t_ms, 9u);
        CHECK_EQ(f[0].length, 24u + 2 * 8);
        const uint8_t* p = f[0].body;
        CHECK_EQ(u32(p), 11u);
        CHECK_EQ(p[4], 0);  // slot
        CHECK_EQ(p[5], 2);  // n_raw
        CHECK_EQ(p[6], 0);  // n_extra
        CHECK_EQ(p[7], 0);  // n_gates
        CHECK_EQ(p[8], 1);  // pick
        CHECK_EQ(p[9], 0);  // flags
        CHECK_EQ(p[10], 0);
        CHECK_EQ(p[11], 0);
        CHECK_EQ(f32(p + 12), 1.5f);
        CHECK_EQ(f32(p + 16), 0.75f);
        CHECK_EQ(f32(p + 20), 4.25f);
        CHECK_EQ(u32(p + 24), 100u);
        CHECK_EQ(f32(p + 28), 0.5f);
        CHECK_EQ(u32(p + 32), 200u);
        CHECK_EQ(f32(p + 36), 0.25f);
    }

    // EVAL with gates and an extra candidate: survivors, then one stage_p row per gate.
    {
        EvalRec e;
        e.node = 1;
        e.n_extra = 1;
        e.pick = 2;
        e.entries = {{10, 0.5f}, {20, 0.25f}, {30, 0.125f}};
        e.survivors = {40, 2};
        e.stage_p = {0.5f, 0.25f, 0.125f, 0.0f, 0.0f, 1.0f};
        Bytes b;
        write_eval(b, 0, e);
        std::vector<FrameView> f;
        CHECK(split_frames(b, f));
        CHECK_EQ(f[0].length, 24u + 3 * 8 + 2 * 4 + 6 * 4);
        const uint8_t* p = f[0].body;
        CHECK_EQ(p[5], 2);  // n_raw
        CHECK_EQ(p[6], 1);  // n_extra
        CHECK_EQ(p[7], 2);  // n_gates
        CHECK_EQ(u32(p + 48), 40u);
        CHECK_EQ(u32(p + 52), 2u);
        CHECK_EQ(f32(p + 56), 0.5f);
        CHECK_EQ(f32(p + 76), 1.0f);

        // Inconsistent sizes are refused.
        e.stage_p.pop_back();
        bool threw = false;
        try {
            write_eval(b, 0, e);
        } catch (const std::exception&) {
            threw = true;
        }
        CHECK(threw);
    }

    // EVAL with a logit-lens section: flag bit 0, then n_lens, three reserved
    // bytes and 16 bytes per layer, after stage_p.
    {
        EvalRec e;
        e.node = 3;
        e.entries = {{10, 0.5f}, {20, 0.25f}};
        e.survivors = {2};
        e.stage_p = {0.75f, 0.25f};
        e.lens = {{20, 0.25f, 0.125f, 3.5f}, {10, 0.5f, 0.5f, 1.5f}};
        Bytes b;
        write_eval(b, 0, e);
        std::vector<FrameView> f;
        CHECK(split_frames(b, f));
        const size_t lens_at = 24u + 2 * 8 + 1 * 4 + 2 * 4;
        CHECK_EQ(f[0].length, lens_at + 4 + 2 * 16);
        const uint8_t* p = f[0].body;
        CHECK_EQ(p[9], EVAL_LENS);  // flags
        CHECK_EQ(p[lens_at], 2);    // n_lens
        CHECK_EQ(p[lens_at + 1], 0);
        CHECK_EQ(p[lens_at + 2], 0);
        CHECK_EQ(p[lens_at + 3], 0);
        CHECK_EQ(u32(p + lens_at + 4), 20u);
        CHECK_EQ(f32(p + lens_at + 8), 0.25f);
        CHECK_EQ(f32(p + lens_at + 12), 0.125f);
        CHECK_EQ(f32(p + lens_at + 16), 3.5f);
        CHECK_EQ(u32(p + lens_at + 20), 10u);
        CHECK_EQ(f32(p + lens_at + 32), 1.5f);

        // Without layers there is no section and no flag, whatever `flags` says.
        e.lens.clear();
        e.flags = EVAL_LENS;
        Bytes b2;
        write_eval(b2, 0, e);
        CHECK(split_frames(b2, f));
        CHECK_EQ(f[0].length, lens_at);
        CHECK_EQ(f[0].body[9], 0);
    }

    // HELLO and CONFIG: JSON bodies with the documented fields.
    {
        Hello h;
        h.app = "0.1.0";
        h.llama_cpp = "0.9.0";
        h.created = "2026-01-15T10:00:00Z";
        h.n_vocab = 248320;
        h.n_raw = 32;
        ModelInfo m;
        m.name = "Qwen3.5-4B";
        m.file = "Qwen3.5-4B-Q2_K.gguf";
        m.quant = "Q2_K";
        m.arch = "qwen35";
        m.n_params = 4000000000ull;
        m.size_bytes = 2190000000ull;
        m.n_layer = 32;
        m.n_embd = 2560;
        m.n_ctx = 4096;
        h.models = {m};
        h.warnings = {"w1"};
        Config c;
        c.max_tokens = 20;

        Bytes b;
        write_hello(b, 0, h);
        write_config(b, 0, c);
        std::vector<FrameView> f;
        CHECK(split_frames(b, f));
        CHECK_EQ(f.size(), 2u);
        CHECK(f[0].type == FrameType::Hello);
        CHECK(f[1].type == FrameType::Config);

        const nlohmann::json jh = body_json(f[0]);
        CHECK_EQ(jh["protocol"], 1);
        CHECK_EQ(jh["app"], "0.1.0");
        CHECK_EQ(jh["llama_cpp"], "0.9.0");
        CHECK_EQ(jh["created"], "2026-01-15T10:00:00Z");
        CHECK_EQ(jh["n_vocab"], 248320);
        CHECK_EQ(jh["n_raw"], 32);
        CHECK_EQ(jh["models"].size(), 1u);
        CHECK_EQ(jh["models"][0]["slot"], "A");
        CHECK_EQ(jh["models"][0]["name"], "Qwen3.5-4B");
        CHECK_EQ(jh["models"][0]["file"], "Qwen3.5-4B-Q2_K.gguf");
        CHECK_EQ(jh["models"][0]["quant"], "Q2_K");
        CHECK_EQ(jh["models"][0]["arch"], "qwen35");
        CHECK_EQ(jh["models"][0]["n_params"], 4000000000ull);
        CHECK_EQ(jh["models"][0]["size_bytes"], 2190000000ull);
        CHECK_EQ(jh["models"][0]["n_layer"], 32);
        CHECK_EQ(jh["models"][0]["n_embd"], 2560);
        CHECK_EQ(jh["models"][0]["n_ctx"], 4096);
        CHECK_EQ(jh["lens"]["enabled"], false);
        CHECK(jh["lens"]["layers"].empty());
        CHECK_EQ(jh["warnings"][0], "w1");

        // With the logit lens: the layers of every EVAL's lens section.
        h.lens_enabled = true;
        h.lens_layers = {0, 15, 31};
        Bytes bl;
        write_hello(bl, 0, h);
        std::vector<FrameView> fl;
        CHECK(split_frames(bl, fl));
        const nlohmann::json jl = body_json(fl[0]);
        CHECK_EQ(jl["lens"]["enabled"], true);
        CHECK(jl["lens"]["layers"] == nlohmann::json({0, 15, 31}));

        const nlohmann::json jc = body_json(f[1]);
        CHECK_EQ(jc["mode"], "lockstep");
        CHECK_EQ(jc["driver"], "A");
        CHECK_EQ(jc["seed"], 42);
        CHECK_EQ(jc["max_tokens"], 20);
        CHECK(jc["gates"].is_array());
        CHECK(jc["gates"].empty());
    }

    // Metadata that is not valid UTF-8 does not break HELLO.
    {
        Hello h;
        ModelInfo m;
        m.name = std::string("bad\xFF", 4);
        h.models = {m};
        Bytes b;
        write_hello(b, 0, h);
        std::vector<FrameView> f;
        CHECK(split_frames(b, f));
        CHECK(body_json(f[0])["models"][0]["name"].is_string());
    }

    // A truncated buffer is not a list of frames.
    {
        Bytes b;
        write_cursor(b, 0, 1, 2);
        b.pop_back();
        std::vector<FrameView> f;
        CHECK(!split_frames(b, f));
    }

    return test_result();
}
