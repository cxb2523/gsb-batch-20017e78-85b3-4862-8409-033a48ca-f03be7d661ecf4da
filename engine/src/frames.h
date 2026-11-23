// Binary frames of the wire protocol. This file and web/src/source/frames.ts
// are the two sides of the contract: change them together, and with the
// synthetic sessions of sessions/golden/.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace ils {

using Bytes = std::vector<uint8_t>;

constexpr uint32_t NONE = 0xFFFFFFFFu;  // "no node"
constexpr int PROTOCOL_VERSION = 1;
constexpr size_t FRAME_HEADER_SIZE = 12;

enum class FrameType : uint8_t {
    Hello = 1,
    Vocab = 2,
    Config = 3,
    Node = 4,
    Eval = 5,
    Pair = 6,
    Cursor = 7,
    Stop = 8,
};

enum Origin : uint8_t { ORIGIN_PROMPT = 0, ORIGIN_MODEL = 1, ORIGIN_USER = 2 };
enum Slot : uint8_t { SLOT_A = 0, SLOT_B = 1, SLOT_BOTH = 2 };
enum class StopReason : uint8_t { EndOfGeneration = 0, MaxTokens = 1, ContextFull = 2 };

// VOCAB attr bits.
constexpr uint8_t ATTR_CONTROL = 1;
constexpr uint8_t ATTR_EOG = 2;

struct ModelInfo {
    std::string slot = "A";
    std::string name;
    std::string file;  // file name only, never the path
    std::string quant;
    std::string arch;
    uint64_t n_params = 0;
    uint64_t size_bytes = 0;
    int32_t n_layer = 0;
    int32_t n_embd = 0;
    int32_t n_ctx = 0;
};

struct Hello {
    std::string app;        // app version
    std::string llama_cpp;  // library version
    std::string created;    // ISO 8601, UTC
    uint32_t n_vocab = 0;
    uint32_t n_raw = 0;
    std::vector<ModelInfo> models;
    bool lens_enabled = false;
    std::vector<int32_t> lens_layers;  // layer indices from 0, ascending
    std::vector<std::string> warnings;
};

// One gate of CONFIG.gates: a sampler and its parameters. Flat: only the
// fields of its `type` count, and only those are written to the frame.
struct GateSpec {
    std::string type;     // "grammar", "penalties", "top_k", "top_p", "min_p" or "temp"
    int32_t k = 40;       // top_k
    double p = 0.95;      // top_p, min_p
    double t = 0.8;       // temp
    int32_t last_n = 64;  // penalties: how many of the last tokens count
    double repeat = 1.0;  // penalties
    double frequency = 0.0;
    double presence = 0.0;
    std::string gbnf;     // grammar: the GBNF text
};

// With no gates the pick is the most likely candidate.
struct Config {
    std::string mode = "lockstep";
    std::string driver = "A";
    uint64_t seed = 42;
    uint32_t max_tokens = 256;
    std::vector<GateSpec> gates;  // in the order they are applied
};

struct VocabEntry {
    uint32_t token = 0;
    uint8_t attr = 0;
    std::string bytes;  // raw bytes, possibly an incomplete UTF-8 sequence
};

struct NodeRec {
    uint32_t id = 0;
    uint32_t parent = NONE;
    uint32_t token = 0;
    uint32_t depth = 0;
    uint8_t origin = ORIGIN_PROMPT;
};

struct Candidate {
    uint32_t token = 0;
    float p_raw = 0;
};

// EVAL flag bits.
constexpr uint8_t EVAL_LENS = 1;  // a logit-lens section follows stage_p

// What one layer of the logit lens says about the next token.
struct LensLayer {
    uint32_t top_id = 0;  // most likely token according to this layer
    float top_p = 0;      // its probability
    float answer_p = 0;   // probability of the model's most likely token (entries[0])
    float entropy = 0;    // bits
};

struct EvalRec {
    uint32_t node = 0;
    uint8_t slot = SLOT_A;
    uint8_t n_extra = 0;  // the last n_extra entries; the rest are the n_raw main ones
    uint8_t pick = 0;     // index into entries
    uint8_t flags = 0;    // EVAL_LENS is set by the writer when `lens` is not empty
    float entropy = 0;    // bits
    float raw_mass = 0;
    float decode_ms = 0;
    std::vector<Candidate> entries;   // n_raw + n_extra
    std::vector<uint32_t> survivors;  // one per gate
    std::vector<float> stage_p;       // gates x entries, row per gate
    std::vector<LensLayer> lens;      // one per layer of HELLO lens.layers, or empty
};

// PAIR flag bits.
constexpr uint8_t PAIR_SAME_TOP = 1;   // same most likely token
constexpr uint8_t PAIR_SAME_PICK = 2;  // same pick: no disagreement
constexpr uint8_t PAIR_APPROX = 4;     // computed from stored candidates

// The comparison of A and B at a node both have evaluated.
struct PairRec {
    uint32_t node = 0;
    float js = 0;     // Jensen-Shannon divergence, bits, 0..1
    float kl_ab = 0;  // KL of A with respect to B, bits
    float kl_ba = 0;
    uint32_t rank_a_in_b = 0;  // rank in B of A's most likely token; 0 is first
    uint32_t rank_b_in_a = 0;
    uint8_t flags = 0;         // PAIR_*
};

// Each writer appends one complete frame (header and body) to `out`.
void write_hello(Bytes& out, uint32_t t_ms, const Hello& hello);
void write_config(Bytes& out, uint32_t t_ms, const Config& config);
void write_vocab(Bytes& out, uint32_t t_ms, const std::vector<VocabEntry>& entries);
void write_node(Bytes& out, uint32_t t_ms, const NodeRec& node);
void write_eval(Bytes& out, uint32_t t_ms, const EvalRec& eval);
void write_pair(Bytes& out, uint32_t t_ms, const PairRec& pair);
void write_cursor(Bytes& out, uint32_t t_ms, uint32_t node_a, uint32_t node_b);
void write_stop(Bytes& out, uint32_t t_ms, uint32_t node, uint8_t slot, StopReason reason);

// Minimal reader, for tests and tools: walks the frames of a buffer.
struct FrameView {
    FrameType type;
    uint32_t t_ms;
    const uint8_t* body;
    uint32_t length;
};
// Returns false if the buffer does not hold whole frames.
bool split_frames(const Bytes& buf, std::vector<FrameView>& out);

}  // namespace ils
