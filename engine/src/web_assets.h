// The web, embedded in the binary. The table is generated at build time by
// cmake/embed_web.cmake from web/dist.
#pragma once

#include <cstddef>

namespace ils {

struct WebAsset {
    const char* path;           // "/index.html", "/assets/index-abc123.js"
    const char* mime;
    const unsigned char* data;  // gzip-compressed
    size_t size;
};

struct WebAssets {
    const WebAsset* items = nullptr;
    size_t count = 0;
};

// Defined in the generated web_assets.cpp (library ils_web).
WebAssets embedded_web();

}  // namespace ils
