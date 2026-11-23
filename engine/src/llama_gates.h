// The gate table: the llama.cpp sampler that implements each gate. Only code
// that links llama.cpp includes this file. Adding a sampler is adding a row
// to the table.
#pragma once

#include "gates.h"

struct llama_sampler;
struct llama_vocab;

namespace ils {

// The llama.cpp sampler of a gate, as llama.cpp gives it. Never null: throws
// std::runtime_error with a message for the user (unknown type, invalid
// grammar). The caller owns it: llama_sampler_free, or a chain.
// top_p and min_p use min_keep = 1; the grammar root is "root".
llama_sampler* make_llama_sampler(const GateSpec& spec, const llama_vocab* vocab);

// The same sampler wrapped for the engine. admits() asks a grammar by
// applying it to an array with that single candidate.
std::unique_ptr<Sampler> make_llama_gate(const GateSpec& spec, const llama_vocab* vocab);

}  // namespace ils
