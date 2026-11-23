// The log (batches, epochs, late readers) and gzip.
#include "check.h"
#include "gzip.h"
#include "log.h"

using namespace ils;

static Bytes fill(size_t n, uint8_t v) { return Bytes(n, v); }

int main() {
    Log log;
    int notified = 0;
    log.set_listener([&] { ++notified; });

    // An empty log has nothing to read.
    {
        const Log::Chunk c = log.read(0, 0, 1024);
        CHECK(c.bytes.empty());
        CHECK_EQ(c.next, 0u);
    }

    log.reset(fill(10, 1));
    const uint64_t e1 = log.epoch();
    log.append(fill(20, 2));
    log.append(fill(30, 3));
    log.append(Bytes{});  // ignored
    CHECK_EQ(notified, 3);
    CHECK_EQ(log.size(), 60u);

    // A late reader (another epoch) gets everything from the start.
    {
        const Log::Chunk c = log.read(e1 + 99, 12345, 1 << 20);
        CHECK_EQ(c.epoch, e1);
        CHECK_EQ(c.bytes.size(), 60u);
        CHECK_EQ(c.next, 60u);
        CHECK(c.bytes == log.snapshot());
    }

    // Chunks are cut at batch boundaries and hold at least one batch.
    {
        Log::Chunk c = log.read(e1, 0, 5);  // smaller than the first batch
        CHECK_EQ(c.bytes.size(), 10u);
        CHECK_EQ(c.next, 10u);
        c = log.read(e1, 0, 35);  // two batches fit, the third does not
        CHECK_EQ(c.bytes.size(), 30u);
        CHECK_EQ(c.next, 30u);
        c = log.read(e1, 30, 1 << 20);
        CHECK_EQ(c.bytes.size(), 30u);
        CHECK_EQ(c.bytes[0], 3);
        CHECK_EQ(c.next, 60u);
        c = log.read(e1, 60, 1 << 20);  // up to date
        CHECK(c.bytes.empty());
        CHECK_EQ(c.next, 60u);
    }

    // A reset starts another log: readers of the old one restart from 0.
    {
        log.reset(fill(7, 9));
        const uint64_t e2 = log.epoch();
        CHECK(e2 != e1);
        CHECK_EQ(log.size(), 7u);
        const Log::Chunk c = log.read(e1, 60, 1 << 20);
        CHECK_EQ(c.epoch, e2);
        CHECK_EQ(c.bytes.size(), 7u);
        CHECK_EQ(c.bytes[0], 9);
        CHECK_EQ(c.next, 7u);
    }

    // gzip round trip, deterministic output, and rejection of garbage.
    {
        Bytes data;
        for (int i = 0; i < 100000; ++i) data.push_back(static_cast<uint8_t>((i * 7) % 251));
        const Bytes z = gzip(data);
        CHECK(z.size() < data.size());
        CHECK_EQ(z[0], 0x1F);
        CHECK_EQ(z[1], 0x8B);
        CHECK(z == gzip(data));
        Bytes back;
        CHECK(gunzip(z, back));
        CHECK(back == data);

        Bytes empty_back;
        CHECK(gunzip(gzip(Bytes{}), empty_back));
        CHECK(empty_back.empty());

        Bytes junk;
        CHECK(!gunzip(Bytes{1, 2, 3, 4}, junk));
        Bytes cut = z;
        cut.resize(cut.size() / 2);
        CHECK(!gunzip(cut, junk));
    }

    return test_result();
}
