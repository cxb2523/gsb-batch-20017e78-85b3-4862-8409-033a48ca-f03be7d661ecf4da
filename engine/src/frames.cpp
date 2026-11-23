#include "frames.h"

#include <nlohmann/json.hpp>

#include <cstring>
#include <stdexcept>

namespace ils {

namespace {

using json = nlohmann::ordered_json;  // keeps the protocol's key order

void put_u8(Bytes& b, uint8_t v) { b.push_back(v); }

void put_u16(Bytes& b, uint16_t v) {
    b.push_back(static_cast<uint8_t>(v));
    b.push_back(static_cast<uint8_t>(v >> 8));
}

void put_u32(Bytes& b, uint32_t v) {
    for (int i = 0; i < 4; ++i) b.push_back(static_cast<uint8_t>(v >> (8 * i)));
}

void put_f32(Bytes& b, float v) {
    uint32_t u;
    std::memcpy(&u, &v, sizeof(u));
    put_u32(b, u);
}

uint32_t get_u32(const uint8_t* p) {
    return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}

// Writes the header with a zero length and returns where the frame starts.
size_t begin_frame(Bytes& b, FrameType type, uint32_t t_ms) {
    const size_t start = b.size();
    put_u8(b, static_cast<uint8_t>(type));
    put_u8(b, 0);   // flags
    put_u16(b, 0);  // reserved
    put_u32(b, 0);  // length, patched by end_frame
    put_u32(b, t_ms);
    return start;
}

void end_frame(Bytes& b, size_t start) {
    const uint32_t length = static_cast<uint32_t>(b.size() - start - FRAME_HEADER_SIZE);
    for (int i = 0; i < 4; ++i) b[start + 4 + i] = static_cast<uint8_t>(length >> (8 * i));
}

void put_json(Bytes& b, const json& j) {
    // Model metadata is not guaranteed to be valid UTF-8: replace, do not throw.
    const std::string s = j.dump(-1, ' ', false, json::error_handler_t::replace);
    b.insert(b.end(), s.begin(), s.end());
}

}  // namespace

void write_hello(Bytes& out, uint32_t t_ms, const Hello& h) {
    json models = json::array();
    for (const ModelInfo& m : h.models) {
        json jm;
        jm["slot"] = m.slot;
        jm["name"] = m.name;
        jm["file"] = m.file;
        jm["quant"] = m.quant;
        jm["arch"] = m.arch;
        jm["n_params"] = m.n_params;
        jm["size_bytes"] = m.size_bytes;
        jm["n_layer"] = m.n_layer;
        jm["n_embd"] = m.n_embd;
        jm["n_ctx"] = m.n_ctx;
        models.push_back(std::move(jm));
    }
    json j;
    j["protocol"] = PROTOCOL_VERSION;
    j["app"] = h.app;
    j["llama_cpp"] = h.llama_cpp;
    j["created"] = h.created;
    j["n_vocab"] = h.n_vocab;
    j["n_raw"] = h.n_raw;
    j["models"] = std::move(models);
    j["lens"] = {{"enabled", h.lens_enabled}, {"layers", h.lens_layers}};
    j["warnings"] = h.warnings;

    const size_t start = begin_frame(out, FrameType::Hello, t_ms);
    put_json(out, j);
    end_frame(out, start);
}

void write_config(Bytes& out, uint32_t t_ms, const Config& c) {
    json j;
    j["mode"] = c.mode;
    j["driver"] = c.driver;
    j["seed"] = c.seed;
    j["max_tokens"] = c.max_tokens;
    json gates = json::array();
    for (const GateSpec& g : c.gates) {
        json jg;
        jg["type"] = g.type;
        if (g.type == "grammar") {
            jg["gbnf"] = g.gbnf;
        } else if (g.type == "penalties") {
            jg["last_n"] = g.last_n;
            jg["repeat"] = g.repeat;
            jg["frequency"] = g.frequency;
            jg["presence"] = g.presence;
        } else if (g.type == "top_k") {
            jg["k"] = g.k;
        } else if (g.type == "top_p" || g.type == "min_p") {
            jg["p"] = g.p;
        } else if (g.type == "temp") {
            jg["t"] = g.t;
        }
        gates.push_back(std::move(jg));
    }
    j["gates"] = std::move(gates);

    const size_t start = begin_frame(out, FrameType::Config, t_ms);
    put_json(out, j);
    end_frame(out, start);
}

void write_vocab(Bytes& out, uint32_t t_ms, const std::vector<VocabEntry>& entries) {
    const size_t start = begin_frame(out, FrameType::Vocab, t_ms);
    put_u32(out, static_cast<uint32_t>(entries.size()));
    for (const VocabEntry& e : entries) {
        if (e.bytes.size() > 0xFFFF) throw std::length_error("token text longer than 65535 bytes");
        put_u32(out, e.token);
        put_u8(out, e.attr);
        put_u16(out, static_cast<uint16_t>(e.bytes.size()));
        out.insert(out.end(), e.bytes.begin(), e.bytes.end());
    }
    end_frame(out, start);
}

void write_node(Bytes& out, uint32_t t_ms, const NodeRec& n) {
    const size_t start = begin_frame(out, FrameType::Node, t_ms);
    put_u32(out, n.id);
    put_u32(out, n.parent);
    put_u32(out, n.token);
    put_u32(out, n.depth);
    put_u8(out, n.origin);
    end_frame(out, start);
}

void write_eval(Bytes& out, uint32_t t_ms, const EvalRec& e) {
    const size_t n_entries = e.entries.size();
    const size_t n_gates = e.survivors.size();
    if (n_entries > 255 || e.n_extra > n_entries || n_gates > 255 || e.pick >= n_entries ||
        e.stage_p.size() != n_gates * n_entries || e.lens.size() > 255) {
        throw std::invalid_argument("inconsistent EVAL");
    }
    const size_t start = begin_frame(out, FrameType::Eval, t_ms);
    put_u32(out, e.node);
    put_u8(out, e.slot);
    put_u8(out, static_cast<uint8_t>(n_entries - e.n_extra));  // n_raw
    put_u8(out, e.n_extra);
    put_u8(out, static_cast<uint8_t>(n_gates));
    put_u8(out, e.pick);
    put_u8(out, static_cast<uint8_t>(e.lens.empty() ? e.flags & ~EVAL_LENS : e.flags | EVAL_LENS));
    put_u16(out, 0);  // reserved
    put_f32(out, e.entropy);
    put_f32(out, e.raw_mass);
    put_f32(out, e.decode_ms);
    for (const Candidate& c : e.entries) {
        put_u32(out, c.token);
        put_f32(out, c.p_raw);
    }
    for (uint32_t s : e.survivors) put_u32(out, s);
    for (float p : e.stage_p) put_f32(out, p);
    if (!e.lens.empty()) {
        put_u8(out, static_cast<uint8_t>(e.lens.size()));
        put_u8(out, 0);  // reserved
        put_u16(out, 0);
        for (const LensLayer& l : e.lens) {
            put_u32(out, l.top_id);
            put_f32(out, l.top_p);
            put_f32(out, l.answer_p);
            put_f32(out, l.entropy);
        }
    }
    end_frame(out, start);
}

void write_pair(Bytes& out, uint32_t t_ms, const PairRec& p) {
    const size_t start = begin_frame(out, FrameType::Pair, t_ms);
    put_u32(out, p.node);
    put_f32(out, p.js);
    put_f32(out, p.kl_ab);
    put_f32(out, p.kl_ba);
    put_u32(out, p.rank_a_in_b);
    put_u32(out, p.rank_b_in_a);
    put_u8(out, p.flags);
    end_frame(out, start);
}

void write_cursor(Bytes& out, uint32_t t_ms, uint32_t node_a, uint32_t node_b) {
    const size_t start = begin_frame(out, FrameType::Cursor, t_ms);
    put_u32(out, node_a);
    put_u32(out, node_b);
    end_frame(out, start);
}

void write_stop(Bytes& out, uint32_t t_ms, uint32_t node, uint8_t slot, StopReason reason) {
    const size_t start = begin_frame(out, FrameType::Stop, t_ms);
    put_u32(out, node);
    put_u8(out, slot);
    put_u8(out, static_cast<uint8_t>(reason));
    end_frame(out, start);
}

bool split_frames(const Bytes& buf, std::vector<FrameView>& out) {
    out.clear();
    size_t pos = 0;
    while (pos < buf.size()) {
        if (buf.size() - pos < FRAME_HEADER_SIZE) return false;
        const uint8_t* h = buf.data() + pos;
        const uint32_t length = get_u32(h + 4);
        if (buf.size() - pos - FRAME_HEADER_SIZE < length) return false;
        out.push_back({static_cast<FrameType>(h[0]), get_u32(h + 8), h + FRAME_HEADER_SIZE, length});
        pos += FRAME_HEADER_SIZE + length;
    }
    return true;
}

}  // namespace ils
