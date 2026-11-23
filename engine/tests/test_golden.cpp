// The protocol contract. Five small synthetic sessions are written with the
// frame encoder, with fixed date, times and values and without a model.
//
//   test_golden <dir>          checks that the files hold exactly these frames
//   test_golden --write <dir>  rewrites the files (after a protocol change)
//
// web/src/source/golden.test.ts, golden-pair.test.ts, golden-gates.test.ts,
// golden-branches.test.ts and golden-lens.test.ts read the same files and
// expect this content. Change both sides together.
//
// single.ils, one model: prompt "<s>The", then the model writes
// " cat caf\xC3\xA9<eos>". The "é" is split between two tokens, "<s>" and
// "<eos>" are control tokens, and "<eos>" ends the generation.
//
// pair.ils, two models: prompt "<s>The"; two lockstep steps driven by A (the
// second one a disagreement); free mode, where the models agree once and then
// split: A writes " mat.<eos>" and B " dog<eos>"; and back to lockstep driven
// by B, which moves A's cursor to B's node.
//
// gates.ils, one model with gates: prompt "<s>The"; a step with the chain
// grammar, top_k 2 and temp 0.5, where the grammar rules out three of the
// four main candidates, an added candidate (" dog") survives and is the pick;
// a `config` command that changes the chain to top_p 0.5 and the seed; and a
// step with the new chain. The first EVAL keeps the gates it was decided with.
//
// branches.ils, two models in free mode: prompt "<s>The"; a step together; a
// step where they split (A at node 3, B at node 4); a step apart; a `branch`
// under node 3 for A only (node 7, origin 2); a step; a `goto` of B to node 3,
// which only A had evaluated; and a step where B evaluates it, with an
// approximate PAIR whose rank of B's top in A is unknown, and A stops.
//
// lens.ils, one model with the logit lens on layers 0, 1 and 3 of 4: prompt
// "<s>The" and two steps whose EVALs carry the lens section. In the first one
// the early layers prefer tokens that are not among the candidates (" on" and
// " mat"), so they travel in the VOCAB of the step; the last layer agrees with
// the model.
//
// Every probability and divergence is a sum of powers of two, so it is exact
// in a float (except 0.9 and 0.1 after the temperature in gates.ils, which
// are the float nearest to each).
#include "check.h"
#include "frames.h"
#include "gzip.h"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>

using namespace ils;

enum Tok : uint32_t {
    T_BOS = 0, T_EOS = 1, T_THE = 2, T_CAT = 3, T_SAT = 4, T_CAF = 5,
    T_E1 = 6, T_E2 = 7, T_DOT = 8, T_DOG = 9, T_ON = 10, T_MAT = 11,
};

static VocabEntry vocab(uint32_t t) {
    switch (t) {
        case T_BOS: return {t, ATTR_CONTROL, "<s>"};
        case T_EOS: return {t, ATTR_CONTROL | ATTR_EOG, "<eos>"};
        case T_THE: return {t, 0, "The"};
        case T_CAT: return {t, 0, " cat"};
        case T_SAT: return {t, 0, " sat"};
        case T_CAF: return {t, 0, " caf"};
        case T_E1:  return {t, 0, "\xC3"};
        case T_E2:  return {t, 0, "\xA9"};
        case T_DOT: return {t, 0, "."};
        case T_DOG: return {t, 0, " dog"};
        case T_ON:  return {t, 0, " on"};
        default:    return {t, 0, " mat"};
    }
}

// One step: [VOCAB] EVAL(node) NODE(child) CURSOR(child). The pick is entry 0.
static void step(Bytes& b, uint32_t t_ms, uint32_t node, std::vector<uint32_t> new_tokens,
                 std::vector<Candidate> entries, float entropy, float decode_ms) {
    if (!new_tokens.empty()) {
        std::vector<VocabEntry> v;
        for (uint32_t t : new_tokens) v.push_back(vocab(t));
        write_vocab(b, t_ms, v);
    }
    EvalRec e;
    e.node = node;
    e.entropy = entropy;
    e.decode_ms = decode_ms;
    e.entries = std::move(entries);
    for (const Candidate& c : e.entries) e.raw_mass += c.p_raw;
    write_eval(b, t_ms, e);
    write_node(b, t_ms, {node + 1, node, e.entries[0].token, node + 1, ORIGIN_MODEL});
    write_cursor(b, t_ms, node + 1, NONE);
}

static Bytes build_golden_single() {
    Bytes b;

    Hello h;
    h.app = "0.1.0";
    h.llama_cpp = "0.9.0";
    h.created = "2026-01-01T00:00:00Z";
    h.n_vocab = 12;
    h.n_raw = 4;
    ModelInfo m;
    m.slot = "A";
    m.name = "Golden-1";
    m.file = "golden.gguf";
    m.quant = "Q8_0";
    m.arch = "golden";
    m.n_params = 1000;
    m.size_bytes = 2000;
    m.n_layer = 2;
    m.n_embd = 8;
    m.n_ctx = 64;
    h.models = {m};
    h.warnings = {"synthetic session"};
    write_hello(b, 0, h);

    Config c;
    c.seed = 42;
    c.max_tokens = 16;
    write_config(b, 0, c);

    // Prompt: nodes 0 and 1.
    write_vocab(b, 100, {vocab(T_BOS), vocab(T_THE)});
    write_node(b, 100, {0, NONE, T_BOS, 0, ORIGIN_PROMPT});
    write_node(b, 100, {1, 0, T_THE, 1, ORIGIN_PROMPT});
    write_cursor(b, 100, 1, NONE);

    step(b, 200, 1, {T_CAT, T_DOG, T_CAF, T_DOT},
         {{T_CAT, 0.5f}, {T_DOG, 0.25f}, {T_CAF, 0.125f}, {T_DOT, 0.0625f}}, 1.75f, 1.5f);
    step(b, 300, 2, {T_SAT, T_ON},
         {{T_CAF, 0.5f}, {T_SAT, 0.25f}, {T_ON, 0.125f}, {T_DOT, 0.0625f}}, 2.0f, 2.5f);
    step(b, 400, 3, {T_E1, T_E2, T_EOS},
         {{T_E1, 0.75f}, {T_DOT, 0.125f}, {T_E2, 0.0625f}, {T_EOS, 0.03125f}}, 1.25f, 3.5f);
    step(b, 500, 4, {},
         {{T_E2, 0.875f}, {T_DOT, 0.0625f}, {T_CAT, 0.03125f}, {T_DOG, 0.015625f}}, 0.75f, 4.5f);
    step(b, 600, 5, {T_MAT},
         {{T_EOS, 0.5f}, {T_DOT, 0.25f}, {T_MAT, 0.125f}, {T_ON, 0.0625f}}, 1.875f, 5.5f);

    // Node 6 is "<eos>": the model cannot go on.
    write_stop(b, 600, 6, SLOT_A, StopReason::EndOfGeneration);
    return b;
}

// An EVAL of the pair session. The pick is entry 0.
static void pair_eval(Bytes& b, uint32_t t_ms, uint32_t node, uint8_t slot, std::vector<Candidate> entries,
                      float entropy, float decode_ms) {
    EvalRec e;
    e.node = node;
    e.slot = slot;
    e.entropy = entropy;
    e.decode_ms = decode_ms;
    e.entries = std::move(entries);
    for (const Candidate& c : e.entries) e.raw_mass += c.p_raw;
    write_eval(b, t_ms, e);
}

static void pair_vocab(Bytes& b, uint32_t t_ms, std::vector<uint32_t> tokens) {
    std::vector<VocabEntry> v;
    for (uint32_t t : tokens) v.push_back(vocab(t));
    write_vocab(b, t_ms, v);
}

static Bytes build_golden_pair() {
    Bytes b;

    Hello h;
    h.app = "0.1.0";
    h.llama_cpp = "0.9.0";
    h.created = "2026-01-01T00:00:00Z";
    h.n_vocab = 12;
    h.n_raw = 4;
    ModelInfo m;
    m.name = "Golden-2";
    m.arch = "golden";
    m.n_params = 1000;
    m.n_layer = 2;
    m.n_embd = 8;
    m.n_ctx = 64;
    m.slot = "A";
    m.file = "golden-q2.gguf";
    m.quant = "Q2_K";
    m.size_bytes = 1000;
    h.models.push_back(m);
    m.slot = "B";
    m.file = "golden-q8.gguf";
    m.quant = "Q8_0";
    m.size_bytes = 2000;
    h.models.push_back(m);
    h.warnings = {"synthetic session"};
    write_hello(b, 0, h);

    Config c;
    c.seed = 42;
    c.max_tokens = 16;
    write_config(b, 0, c);  // lockstep, driver A

    // Prompt: nodes 0 and 1.
    pair_vocab(b, 100, {T_BOS, T_THE});
    write_node(b, 100, {0, NONE, T_BOS, 0, ORIGIN_PROMPT});
    write_node(b, 100, {1, 0, T_THE, 1, ORIGIN_PROMPT});
    write_cursor(b, 100, 1, 1);

    // Lockstep, node 1: both pick " cat".
    pair_vocab(b, 200, {T_CAT, T_DOG, T_CAF, T_DOT});
    pair_eval(b, 200, 1, SLOT_A, {{T_CAT, 0.5f}, {T_DOG, 0.25f}, {T_CAF, 0.125f}, {T_DOT, 0.0625f}}, 1.75f, 1.5f);
    pair_eval(b, 200, 1, SLOT_B, {{T_CAT, 0.5f}, {T_CAF, 0.25f}, {T_DOG, 0.125f}, {T_DOT, 0.0625f}}, 1.875f, 2.5f);
    write_pair(b, 200, {1, 0.03125f, 0.125f, 0.0625f, 0, 0, PAIR_SAME_TOP | PAIR_SAME_PICK});
    write_node(b, 200, {2, 1, T_CAT, 2, ORIGIN_MODEL});
    write_cursor(b, 200, 2, 2);

    // Lockstep, node 2: A picks " sat", B would have picked " on". A drives.
    pair_vocab(b, 300, {T_SAT, T_ON});
    pair_eval(b, 300, 2, SLOT_A, {{T_SAT, 0.5f}, {T_ON, 0.25f}, {T_DOT, 0.125f}, {T_DOG, 0.0625f}}, 2.0f, 1.5f);
    pair_eval(b, 300, 2, SLOT_B, {{T_ON, 0.5f}, {T_SAT, 0.25f}, {T_DOT, 0.125f}, {T_DOG, 0.0625f}}, 2.25f, 2.5f);
    write_pair(b, 300, {2, 0.25f, 0.5f, 0.75f, 1, 1, 0});
    write_node(b, 300, {3, 2, T_SAT, 3, ORIGIN_MODEL});
    write_cursor(b, 300, 3, 3);

    // The `config` command: free mode. The cursors do not move.
    c.mode = "free";
    write_config(b, 350, c);

    // Free, node 3: both pick " on" and stay together.
    pair_vocab(b, 400, {T_MAT});
    pair_eval(b, 400, 3, SLOT_A, {{T_ON, 0.5f}, {T_DOT, 0.25f}, {T_MAT, 0.125f}, {T_CAT, 0.0625f}}, 1.5f, 1.5f);
    pair_eval(b, 400, 3, SLOT_B, {{T_ON, 0.75f}, {T_DOT, 0.125f}, {T_MAT, 0.0625f}, {T_CAT, 0.03125f}}, 1.25f, 2.5f);
    write_pair(b, 400, {3, 0.0625f, 0.25f, 0.125f, 0, 0, PAIR_SAME_TOP | PAIR_SAME_PICK});
    write_node(b, 400, {4, 3, T_ON, 4, ORIGIN_MODEL});
    write_cursor(b, 400, 4, 4);

    // Free, node 4: A picks " mat" and B " dog". The cursors split.
    pair_eval(b, 500, 4, SLOT_A, {{T_MAT, 0.5f}, {T_DOG, 0.25f}, {T_DOT, 0.125f}, {T_CAT, 0.0625f}}, 1.75f, 1.5f);
    pair_eval(b, 500, 4, SLOT_B, {{T_DOG, 0.5f}, {T_MAT, 0.25f}, {T_DOT, 0.125f}, {T_CAT, 0.0625f}}, 2.0f, 2.5f);
    write_pair(b, 500, {4, 0.5f, 1.0f, 1.5f, 1, 1, 0});
    write_node(b, 500, {5, 4, T_MAT, 5, ORIGIN_MODEL});
    write_node(b, 500, {6, 4, T_DOG, 5, ORIGIN_MODEL});
    write_cursor(b, 500, 5, 6);

    // Free, A at node 5 and B at node 6: no PAIR. B writes "<eos>" and stops.
    pair_vocab(b, 600, {T_EOS});
    pair_eval(b, 600, 5, SLOT_A, {{T_DOT, 0.75f}, {T_EOS, 0.125f}, {T_ON, 0.0625f}, {T_CAT, 0.03125f}}, 1.25f, 1.5f);
    pair_eval(b, 600, 6, SLOT_B, {{T_EOS, 0.5f}, {T_DOT, 0.25f}, {T_ON, 0.125f}, {T_CAT, 0.0625f}}, 1.875f, 2.5f);
    write_node(b, 600, {7, 5, T_DOT, 6, ORIGIN_MODEL});
    write_node(b, 600, {8, 6, T_EOS, 6, ORIGIN_MODEL});
    write_cursor(b, 600, 7, 8);
    write_stop(b, 600, 8, SLOT_B, StopReason::EndOfGeneration);

    // Free, only A goes on, and stops too.
    pair_eval(b, 700, 7, SLOT_A, {{T_EOS, 0.875f}, {T_DOT, 0.0625f}, {T_CAT, 0.03125f}, {T_DOG, 0.015625f}}, 0.75f, 1.5f);
    write_node(b, 700, {9, 7, T_EOS, 7, ORIGIN_MODEL});
    write_cursor(b, 700, 9, 8);
    write_stop(b, 700, 9, SLOT_A, StopReason::EndOfGeneration);

    // The `config` command: lockstep driven by B. A's cursor moves to B's node.
    c.mode = "lockstep";
    c.driver = "B";
    write_config(b, 800, c);
    write_cursor(b, 800, 8, 8);
    return b;
}

static Bytes build_golden_gates() {
    Bytes b;

    Hello h;
    h.app = "0.1.0";
    h.llama_cpp = "0.9.0";
    h.created = "2026-01-01T00:00:00Z";
    h.n_vocab = 12;
    h.n_raw = 4;
    ModelInfo m;
    m.slot = "A";
    m.name = "Golden-3";
    m.file = "golden.gguf";
    m.quant = "Q8_0";
    m.arch = "golden";
    m.n_params = 1000;
    m.size_bytes = 2000;
    m.n_layer = 2;
    m.n_embd = 8;
    m.n_ctx = 64;
    h.models = {m};
    h.warnings = {"synthetic session"};
    write_hello(b, 0, h);

    Config c;
    c.seed = 7;
    c.max_tokens = 16;
    GateSpec grammar;
    grammar.type = "grammar";
    grammar.gbnf = "root ::= [a-z ]+";
    GateSpec top_k;
    top_k.type = "top_k";
    top_k.k = 2;
    GateSpec temp;
    temp.type = "temp";
    temp.t = 0.5;
    c.gates = {grammar, top_k, temp};
    write_config(b, 0, c);

    // Prompt: nodes 0 and 1.
    write_vocab(b, 100, {vocab(T_BOS), vocab(T_THE)});
    write_node(b, 100, {0, NONE, T_BOS, 0, ORIGIN_PROMPT});
    write_node(b, 100, {1, 0, T_THE, 1, ORIGIN_PROMPT});
    write_cursor(b, 100, 1, NONE);

    // Node 1, three gates. The grammar keeps 7 of the 12 tokens and none of
    // ".", the two bytes of "é"; top_k keeps " cat" and " dog"; the
    // temperature sharpens them. " dog" is not a main candidate: it is added,
    // and it is the pick.
    {
        write_vocab(b, 200, {vocab(T_DOT), vocab(T_E1), vocab(T_CAT), vocab(T_E2), vocab(T_DOG)});
        EvalRec e;
        e.node = 1;
        e.entropy = 2.25f;
        e.decode_ms = 1.5f;
        e.entries = {{T_DOT, 0.5f}, {T_E1, 0.125f}, {T_CAT, 0.09375f}, {T_E2, 0.0625f}, {T_DOG, 0.03125f}};
        e.n_extra = 1;
        e.raw_mass = 0.78125f;  // the four main candidates
        e.pick = 4;
        e.survivors = {7, 2, 2};
        e.stage_p = {
            0.0f, 0.0f, 0.375f, 0.0f, 0.125f,  // grammar
            0.0f, 0.0f, 0.75f,  0.0f, 0.25f,   // top_k 2
            0.0f, 0.0f, 0.9f,   0.0f, 0.1f,    // temp 0.5
        };
        write_eval(b, 200, e);
        write_node(b, 200, {2, 1, T_DOG, 2, ORIGIN_MODEL});
        write_cursor(b, 200, 2, NONE);
    }

    // The `config` command: another chain and another seed.
    GateSpec top_p;
    top_p.type = "top_p";
    top_p.p = 0.5;
    c.gates = {top_p};
    c.seed = 9;
    write_config(b, 250, c);

    // Node 2, one gate: top_p 0.5 leaves only " sat".
    {
        write_vocab(b, 300, {vocab(T_SAT), vocab(T_ON), vocab(T_MAT)});
        EvalRec e;
        e.node = 2;
        e.entropy = 1.875f;
        e.decode_ms = 2.5f;
        e.entries = {{T_SAT, 0.5f}, {T_ON, 0.25f}, {T_DOT, 0.125f}, {T_MAT, 0.0625f}};
        e.raw_mass = 0.9375f;
        e.pick = 0;
        e.survivors = {1};
        e.stage_p = {1.0f, 0.0f, 0.0f, 0.0f};
        write_eval(b, 300, e);
        write_node(b, 300, {3, 2, T_SAT, 3, ORIGIN_MODEL});
        write_cursor(b, 300, 3, NONE);
    }
    return b;
}

static Bytes build_golden_branches() {
    Bytes b;

    Hello h;
    h.app = "0.1.0";
    h.llama_cpp = "0.9.0";
    h.created = "2026-01-01T00:00:00Z";
    h.n_vocab = 12;
    h.n_raw = 4;
    ModelInfo m;
    m.name = "Golden-4";
    m.arch = "golden";
    m.n_params = 1000;
    m.n_layer = 2;
    m.n_embd = 8;
    m.n_ctx = 64;
    m.slot = "A";
    m.file = "golden-q2.gguf";
    m.quant = "Q2_K";
    m.size_bytes = 1000;
    h.models.push_back(m);
    m.slot = "B";
    m.file = "golden-q8.gguf";
    m.quant = "Q8_0";
    m.size_bytes = 2000;
    h.models.push_back(m);
    h.warnings = {"synthetic session"};
    write_hello(b, 0, h);

    Config c;
    c.mode = "free";
    c.seed = 42;
    c.max_tokens = 16;
    write_config(b, 0, c);

    // Prompt: nodes 0 and 1.
    pair_vocab(b, 100, {T_BOS, T_THE});
    write_node(b, 100, {0, NONE, T_BOS, 0, ORIGIN_PROMPT});
    write_node(b, 100, {1, 0, T_THE, 1, ORIGIN_PROMPT});
    write_cursor(b, 100, 1, 1);

    // Node 1: both pick " cat" and stay together.
    pair_vocab(b, 200, {T_CAT, T_DOG, T_CAF, T_DOT});
    pair_eval(b, 200, 1, SLOT_A, {{T_CAT, 0.5f}, {T_DOG, 0.25f}, {T_CAF, 0.125f}, {T_DOT, 0.0625f}}, 1.75f, 1.5f);
    pair_eval(b, 200, 1, SLOT_B, {{T_CAT, 0.5f}, {T_CAF, 0.25f}, {T_DOG, 0.125f}, {T_DOT, 0.0625f}}, 1.875f, 2.5f);
    write_pair(b, 200, {1, 0.03125f, 0.125f, 0.0625f, 0, 0, PAIR_SAME_TOP | PAIR_SAME_PICK});
    write_node(b, 200, {2, 1, T_CAT, 2, ORIGIN_MODEL});
    write_cursor(b, 200, 2, 2);

    // Node 2: A picks " sat" (node 3) and B " on" (node 4). The cursors split.
    pair_vocab(b, 300, {T_SAT, T_ON});
    pair_eval(b, 300, 2, SLOT_A, {{T_SAT, 0.5f}, {T_ON, 0.25f}, {T_DOT, 0.125f}, {T_DOG, 0.0625f}}, 2.0f, 1.5f);
    pair_eval(b, 300, 2, SLOT_B, {{T_ON, 0.5f}, {T_SAT, 0.25f}, {T_DOT, 0.125f}, {T_DOG, 0.0625f}}, 2.25f, 2.5f);
    write_pair(b, 300, {2, 0.25f, 0.5f, 0.75f, 1, 1, 0});
    write_node(b, 300, {3, 2, T_SAT, 3, ORIGIN_MODEL});
    write_node(b, 300, {4, 2, T_ON, 3, ORIGIN_MODEL});
    write_cursor(b, 300, 3, 4);

    // A at node 3 and B at node 4: no PAIR. A's EVAL of node 3 stays the only
    // one of that node until B goes there.
    pair_vocab(b, 400, {T_MAT});
    pair_eval(b, 400, 3, SLOT_A, {{T_ON, 0.5f}, {T_DOT, 0.25f}, {T_MAT, 0.125f}, {T_CAT, 0.0625f}}, 1.5f, 1.5f);
    pair_eval(b, 400, 4, SLOT_B, {{T_DOT, 0.5f}, {T_MAT, 0.25f}, {T_CAT, 0.125f}, {T_DOG, 0.0625f}}, 1.875f, 2.5f);
    write_node(b, 400, {5, 3, T_ON, 4, ORIGIN_MODEL});
    write_node(b, 400, {6, 4, T_DOT, 4, ORIGIN_MODEL});
    write_cursor(b, 400, 5, 6);

    // The `branch` command: under node 3, A's third candidate " mat", for A.
    write_node(b, 500, {7, 3, T_MAT, 4, ORIGIN_USER});
    write_cursor(b, 500, 7, 6);

    // A at node 7 and B at node 6.
    pair_vocab(b, 600, {T_EOS});
    pair_eval(b, 600, 7, SLOT_A, {{T_DOT, 0.75f}, {T_EOS, 0.125f}, {T_ON, 0.0625f}, {T_CAT, 0.03125f}}, 1.25f, 1.5f);
    pair_eval(b, 600, 6, SLOT_B, {{T_CAF, 0.5f}, {T_DOT, 0.25f}, {T_CAT, 0.125f}, {T_DOG, 0.0625f}}, 1.875f, 2.5f);
    write_node(b, 600, {8, 7, T_DOT, 5, ORIGIN_MODEL});
    write_node(b, 600, {9, 6, T_CAF, 5, ORIGIN_MODEL});
    write_cursor(b, 600, 8, 9);

    // The `goto` command: B to node 3, which A evaluated at t=400.
    write_cursor(b, 700, 8, 3);

    // A at node 8 and B at node 3. B's EVAL of node 3 meets A's old one: an
    // approximate PAIR. B's most likely token, " dog", is not among A's
    // candidates of node 3, so its rank in A is unknown. A writes "<eos>".
    pair_eval(b, 800, 8, SLOT_A, {{T_EOS, 0.875f}, {T_DOT, 0.0625f}, {T_CAT, 0.03125f}, {T_DOG, 0.015625f}}, 0.75f, 1.5f);
    pair_eval(b, 800, 3, SLOT_B, {{T_DOG, 0.5f}, {T_ON, 0.25f}, {T_DOT, 0.125f}, {T_MAT, 0.0625f}}, 2.0f, 2.5f);
    write_pair(b, 800, {3, 0.375f, 1.25f, 1.5f, 1, NONE, PAIR_APPROX});
    write_node(b, 800, {10, 8, T_EOS, 6, ORIGIN_MODEL});
    write_node(b, 800, {11, 3, T_DOG, 4, ORIGIN_MODEL});
    write_cursor(b, 800, 10, 11);
    write_stop(b, 800, 10, SLOT_A, StopReason::EndOfGeneration);
    return b;
}

static Bytes build_golden_lens() {
    Bytes b;

    Hello h;
    h.app = "0.1.0";
    h.llama_cpp = "0.9.0";
    h.created = "2026-01-01T00:00:00Z";
    h.n_vocab = 12;
    h.n_raw = 4;
    ModelInfo m;
    m.slot = "A";
    m.name = "Golden-5";
    m.file = "golden.gguf";
    m.quant = "Q8_0";
    m.arch = "golden";
    m.n_params = 1000;
    m.size_bytes = 2000;
    m.n_layer = 4;
    m.n_embd = 8;
    m.n_ctx = 64;
    h.models = {m};
    h.lens_enabled = true;
    h.lens_layers = {0, 1, 3};
    h.warnings = {"synthetic session"};
    write_hello(b, 0, h);

    Config c;
    c.seed = 42;
    c.max_tokens = 16;
    write_config(b, 0, c);

    // Prompt: nodes 0 and 1.
    write_vocab(b, 100, {vocab(T_BOS), vocab(T_THE)});
    write_node(b, 100, {0, NONE, T_BOS, 0, ORIGIN_PROMPT});
    write_node(b, 100, {1, 0, T_THE, 1, ORIGIN_PROMPT});
    write_cursor(b, 100, 1, NONE);

    // Node 1: the model's answer is " cat". Layer 0 is flat and prefers " on",
    // layer 1 leans to " mat" and the last layer has decided.
    {
        write_vocab(b, 200, {vocab(T_CAT), vocab(T_DOG), vocab(T_CAF), vocab(T_DOT), vocab(T_ON), vocab(T_MAT)});
        EvalRec e;
        e.node = 1;
        e.entropy = 1.75f;
        e.decode_ms = 1.5f;
        e.entries = {{T_CAT, 0.5f}, {T_DOG, 0.25f}, {T_CAF, 0.125f}, {T_DOT, 0.0625f}};
        e.raw_mass = 0.9375f;
        e.lens = {
            {T_ON, 0.125f, 0.0625f, 3.5f},
            {T_MAT, 0.25f, 0.125f, 2.75f},
            {T_CAT, 0.5f, 0.5f, 1.75f},
        };
        write_eval(b, 200, e);
        write_node(b, 200, {2, 1, T_CAT, 2, ORIGIN_MODEL});
        write_cursor(b, 200, 2, NONE);
    }

    // Node 2: the answer is " sat", and every layer already says so.
    {
        write_vocab(b, 300, {vocab(T_SAT)});
        EvalRec e;
        e.node = 2;
        e.entropy = 1.25f;
        e.decode_ms = 2.5f;
        e.entries = {{T_SAT, 0.75f}, {T_ON, 0.125f}, {T_DOT, 0.0625f}, {T_MAT, 0.03125f}};
        e.raw_mass = 0.96875f;
        e.lens = {
            {T_SAT, 0.25f, 0.25f, 3.0f},
            {T_SAT, 0.5f, 0.5f, 2.0f},
            {T_SAT, 0.75f, 0.75f, 1.25f},
        };
        write_eval(b, 300, e);
        write_node(b, 300, {3, 2, T_SAT, 3, ORIGIN_MODEL});
        write_cursor(b, 300, 3, NONE);
    }
    return b;
}

static bool read_file(const std::string& path, Bytes& out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    out.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
    return true;
}

static bool write_file(const std::string& path, const Bytes& session) {
    const Bytes z = gzip(session);
    std::ofstream f(path, std::ios::binary | std::ios::trunc);
    f.write(reinterpret_cast<const char*>(z.data()), static_cast<std::streamsize>(z.size()));
    if (!f) {
        std::fprintf(stderr, "cannot write %s\n", path.c_str());
        return false;
    }
    std::printf("wrote %s (%zu bytes)\n", path.c_str(), z.size());
    return true;
}

// The file in the repository holds exactly these bytes once decompressed.
static void check_file(const std::string& path, const Bytes& expected) {
    Bytes file, actual;
    CHECK(read_file(path, file));
    CHECK(gunzip(file, actual));
    CHECK(actual == expected);
    if (actual != expected) {
        std::fprintf(stderr, "%s does not match the encoder: if the protocol changed on purpose, "
                             "run `make golden` and update the web test\n", path.c_str());
    }
}

int main(int argc, char** argv) {
    if (argc == 3 && std::strcmp(argv[1], "--write") == 0) {
        const std::string dir = argv[2];
        const bool ok = write_file(dir + "/single.ils", build_golden_single()) &&
                        write_file(dir + "/pair.ils", build_golden_pair()) &&
                        write_file(dir + "/gates.ils", build_golden_gates()) &&
                        write_file(dir + "/branches.ils", build_golden_branches()) &&
                        write_file(dir + "/lens.ils", build_golden_lens());
        return ok ? 0 : 1;
    }
    if (argc != 2) {
        std::fprintf(stderr, "usage: test_golden [--write] <directory>\n");
        return 2;
    }
    const std::string dir = argv[1];

    // single.ils: 2 + 4 + 5 steps of 3 or 4 frames + STOP.
    {
        const Bytes expected = build_golden_single();
        std::vector<FrameView> frames;
        CHECK(split_frames(expected, frames));
        CHECK_EQ(frames.size(), 2u + 4u + (4u + 4u + 4u + 3u + 4u) + 1u);
        CHECK(frames[0].type == FrameType::Hello);
        CHECK(frames[1].type == FrameType::Config);
        CHECK(frames.back().type == FrameType::Stop);
        check_file(dir + "/single.ils", expected);
    }

    // pair.ils: 2 + 4, two lockstep steps, CONFIG, four free steps, CONFIG and CURSOR.
    {
        const Bytes expected = build_golden_pair();
        std::vector<FrameView> frames;
        CHECK(split_frames(expected, frames));
        CHECK_EQ(frames.size(), 2u + 4u + (6u + 6u) + 1u + (6u + 6u + 7u + 4u) + 2u);
        CHECK(frames[0].type == FrameType::Hello);
        CHECK(frames[1].type == FrameType::Config);
        CHECK(frames.back().type == FrameType::Cursor);
        size_t pairs = 0;
        for (const FrameView& f : frames) {
            if (f.type != FrameType::Pair) continue;
            ++pairs;
            CHECK_EQ(f.length, 25u);
        }
        CHECK_EQ(pairs, 4u);
        check_file(dir + "/pair.ils", expected);
    }

    // gates.ils: 2 + 4, a step with three gates, CONFIG and a step with one.
    {
        const Bytes expected = build_golden_gates();
        std::vector<FrameView> frames;
        CHECK(split_frames(expected, frames));
        CHECK_EQ(frames.size(), 2u + 4u + 4u + 1u + 4u);
        CHECK(frames[0].type == FrameType::Hello);
        CHECK(frames[1].type == FrameType::Config);
        CHECK(frames[10].type == FrameType::Config);
        CHECK(frames.back().type == FrameType::Cursor);
        // EVAL: 24 bytes, 8 per entry, 4 per gate and 4 per gate and entry.
        CHECK(frames[7].type == FrameType::Eval);
        CHECK_EQ(frames[7].length, 24u + 5u * 8u + 3u * 4u + 3u * 5u * 4u);
        CHECK(frames[12].type == FrameType::Eval);
        CHECK_EQ(frames[12].length, 24u + 4u * 8u + 1u * 4u + 1u * 4u * 4u);
        check_file(dir + "/gates.ils", expected);
    }

    // branches.ils: 2 + 4, two steps together, a step apart, `branch`, a step,
    // `goto` and the step with the approximate PAIR and a STOP.
    {
        const Bytes expected = build_golden_branches();
        std::vector<FrameView> frames;
        CHECK(split_frames(expected, frames));
        CHECK_EQ(frames.size(), 2u + 4u + (6u + 7u + 6u) + 2u + 6u + 1u + 7u);
        CHECK(frames[0].type == FrameType::Hello);
        CHECK(frames[1].type == FrameType::Config);
        CHECK(frames[25].type == FrameType::Node);    // the branch, origin 2
        CHECK(frames[26].type == FrameType::Cursor);
        CHECK(frames[33].type == FrameType::Cursor);  // the goto
        CHECK(frames[36].type == FrameType::Pair);    // approximate
        CHECK(frames.back().type == FrameType::Stop);
        size_t pairs = 0;
        for (const FrameView& f : frames) {
            if (f.type != FrameType::Pair) continue;
            ++pairs;
            CHECK_EQ(f.length, 25u);
        }
        CHECK_EQ(pairs, 3u);
        check_file(dir + "/branches.ils", expected);
    }

    // lens.ils: 2 + 4 and two steps whose EVALs carry three lens layers.
    {
        const Bytes expected = build_golden_lens();
        std::vector<FrameView> frames;
        CHECK(split_frames(expected, frames));
        CHECK_EQ(frames.size(), 2u + 4u + 4u + 4u);
        CHECK(frames[0].type == FrameType::Hello);
        CHECK(frames[1].type == FrameType::Config);
        CHECK(frames.back().type == FrameType::Cursor);
        for (size_t i : {size_t(7), size_t(11)}) {
            CHECK(frames[i].type == FrameType::Eval);
            CHECK_EQ(frames[i].body[9], EVAL_LENS);
            CHECK_EQ(frames[i].length, 24u + 4u * 8u + 4u + 3u * 16u);
        }
        check_file(dir + "/lens.ils", expected);
    }

    return test_result();
}
