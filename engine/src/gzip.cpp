#include "gzip.h"

#include <zlib.h>

#include <stdexcept>

namespace ils {

namespace {
constexpr int kGzipWindow = 15 + 16;  // 32 KiB window, gzip wrapper
}

Bytes gzip(const Bytes& data) {
    z_stream s{};
    if (deflateInit2(&s, Z_DEFAULT_COMPRESSION, Z_DEFLATED, kGzipWindow, 8, Z_DEFAULT_STRATEGY) != Z_OK) {
        throw std::runtime_error("deflateInit2 failed");
    }
    Bytes out(deflateBound(&s, static_cast<uLong>(data.size())));
    s.next_in = const_cast<Bytef*>(data.data());
    s.avail_in = static_cast<uInt>(data.size());
    s.next_out = out.data();
    s.avail_out = static_cast<uInt>(out.size());
    const int rc = deflate(&s, Z_FINISH);
    const size_t written = s.total_out;
    deflateEnd(&s);
    if (rc != Z_STREAM_END) throw std::runtime_error("deflate failed");
    out.resize(written);
    return out;
}

bool gunzip(const Bytes& data, Bytes& out) {
    out.clear();
    z_stream s{};
    if (inflateInit2(&s, kGzipWindow) != Z_OK) return false;
    s.next_in = const_cast<Bytef*>(data.data());
    s.avail_in = static_cast<uInt>(data.size());
    uint8_t buf[64 * 1024];
    int rc = Z_OK;
    while (rc == Z_OK) {
        s.next_out = buf;
        s.avail_out = sizeof(buf);
        rc = inflate(&s, Z_NO_FLUSH);
        if (rc != Z_OK && rc != Z_STREAM_END) break;
        out.insert(out.end(), buf, buf + (sizeof(buf) - s.avail_out));
    }
    inflateEnd(&s);
    return rc == Z_STREAM_END;
}

}  // namespace ils
