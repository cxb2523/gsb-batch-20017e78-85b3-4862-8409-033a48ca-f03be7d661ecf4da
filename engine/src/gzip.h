// gzip for the session file: .ils = gzip(frame ‖ frame ‖ …).
#pragma once

#include "frames.h"

namespace ils {

// Deterministic for a given zlib: no file name and no timestamp in the header.
Bytes gzip(const Bytes& data);

// Returns false if `data` is not a valid gzip stream.
bool gunzip(const Bytes& data, Bytes& out);

}  // namespace ils
