// The coordinator: owns the tree, the cursors and the
// configuration. It takes commands from a queue, runs steps on a thread of
// its own and appends frames to the log. One or two models (lockstep and
// free modes), each with its chain of gates (gates.h).
#pragma once

#include "frames.h"
#include "log.h"
#include "model.h"

#include <chrono>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace ils {

constexpr uint32_t N_RAW = 32;           // main candidates per EVAL
constexpr double DEFAULT_TPS_LIMIT = 12; // tokens per second; 0 is unlimited

enum class RunState { Idle, Running, Paused };  // Idle: no prompt yet
const char* to_string(RunState s);              // "idle", "running", "paused"

struct Status {
    RunState state = RunState::Idle;
    double tps = 0;        // measured tokens per second
    double tps_limit = 0;  // 0 is unlimited
    uint32_t nodes = 0;
};

// Whether a model can continue from a node: it stops at an end-of-generation
// token, at max_tokens generated tokens (the prompt not counted) and with the
// context full (no context shift). Computed from the node and the
// configuration, never stored.
//   depth:      depth of the node
//   prompt_len: number of prompt tokens of the session
//   origin:     origin of the node; a prompt token is never an end of generation
//   is_eog:     the node's token is an end-of-generation token
std::optional<StopReason> stop_reason(uint32_t depth, uint32_t prompt_len, uint8_t origin, bool is_eog,
                                      uint32_t max_tokens, uint32_t n_ctx);

// Why A and B do not share a tokenizer (a message for the user), or nullopt
// if they do: same number of tokens, and the same text and attributes in each.
std::optional<std::string> tokenizer_difference(const Model& a, const Model& b);

struct SessionOptions {
    // --verify-seek: when a model evaluates again a node it had evaluated
    // (after a branch or a goto) and the placement is exact, the new p_raw of
    // the candidates kept from the first EVAL are compared with the old ones;
    // a difference above 0.0001 is a `warning` event and a counted mismatch.
    bool verify_seek = false;
};

struct SeekStats {
    uint64_t verified = 0;    // re-evaluations checked
    uint64_t mismatches = 0;  // of them, those that differed
};

class Session {
public:
    struct Sinks {
        // `error` and `warning` events, as JSON text ready to send. Not stored in the log.
        std::function<void(const std::string& json)> event;
        // The status changed, or a second has passed while generating.
        std::function<void()> status_changed;
    };

    // Writes HELLO and CONFIG to the log and starts the coordinator thread.
    // `b` may be null (one model); otherwise it must share A's tokenizer.
    // `warnings` go to HELLO. The logit lens is on if A has one and, with B,
    // B projects the same layers; otherwise the models' lenses are turned off
    // and, for a pair, HELLO says why. The models and `log` must outlive the session.
    Session(Model& a, Model* b, Log& log, Sinks sinks = {}, std::vector<std::string> warnings = {},
            SessionOptions options = {});
    ~Session();  // stops the coordinator thread

    Session(const Session&) = delete;
    Session& operator=(const Session&) = delete;

    // Queues a command (JSON text of the wire protocol). Any thread.
    // The coordinator runs it between steps; failures come back as `error` events.
    void post(const std::string& command_json);

    Status status() const;  // any thread

    SeekStats seek_stats() const;  // any thread; all zero without verify_seek

    // Blocks until the queue is empty and nothing is generating, or until the
    // timeout. For tests and tools. Returns false on timeout.
    bool wait_idle(std::chrono::milliseconds timeout);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace ils
