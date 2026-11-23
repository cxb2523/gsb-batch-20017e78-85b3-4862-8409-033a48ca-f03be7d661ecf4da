// The logit lens without llama.cpp (lens.h): default layers, --lens-layers,
// the RMS norm, the one-pass projection with one and several threads, the
// statistics of a layer and the softcap.
#include "check.h"
#include "lens.h"

#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

using namespace ils;

namespace {

bool parse_fails(const std::string& text, int32_t n_layer) {
    try {
        parse_lens_layers(text, n_layer);
    } catch (const std::invalid_argument& e) {
        return std::string(e.what()).find("--lens-layers") != std::string::npos;
    }
    return false;
}

// A deterministic value in [-1, 1).
float noise(uint64_t i) {
    i = (i + 0x9E3779B97F4A7C15ull) * 0xBF58476D1CE4E5B9ull;
    i ^= i >> 31;
    return static_cast<float>(static_cast<double>(i >> 11) / 9007199254740992.0 * 2.0 - 1.0);
}

void test_default_layers() {
    CHECK(default_lens_layers(0).empty());
    CHECK(default_lens_layers(-3).empty());
    CHECK((default_lens_layers(1) == std::vector<int32_t>{0}));
    CHECK((default_lens_layers(4) == std::vector<int32_t>{0, 1, 2, 3}));
    CHECK((default_lens_layers(8) == std::vector<int32_t>{0, 1, 2, 3, 4, 5, 6, 7}));
    // Qwen3.5-2B (24 layers): eight layers spread from the first to the last.
    CHECK((default_lens_layers(24) == std::vector<int32_t>{0, 3, 7, 10, 13, 16, 20, 23}));
    for (int32_t n = 1; n <= 80; ++n) {
        const std::vector<int32_t> l = default_lens_layers(n);
        CHECK_EQ(l.size(), static_cast<size_t>(std::min(n, LENS_DEFAULT_LAYERS)));
        CHECK_EQ(l.front(), 0);
        CHECK_EQ(l.back(), n - 1);
        for (size_t i = 1; i < l.size(); ++i) CHECK(l[i] > l[i - 1]);
    }
}

void test_parse_layers() {
    CHECK((parse_lens_layers("0,3,7", 24) == std::vector<int32_t>{0, 3, 7}));
    CHECK((parse_lens_layers("23", 24) == std::vector<int32_t>{23}));
    CHECK((parse_lens_layers("7,0,3,3", 24) == std::vector<int32_t>{0, 3, 7}));  // sorted, no duplicates
    CHECK(parse_fails("", 24));
    CHECK(parse_fails("0,,3", 24));
    CHECK(parse_fails("0,3,", 24));
    CHECK(parse_fails("a", 24));
    CHECK(parse_fails("-1", 24));
    CHECK(parse_fails("1.5", 24));
    CHECK(parse_fails(" 1", 24));
    CHECK(parse_fails("24", 24));                    // out of range
    CHECK(parse_fails("99999999999999999999", 24));  // no overflow
    std::string many;
    for (int i = 0; i <= LENS_MAX_LAYERS; ++i) many += (i ? "," : "") + std::to_string(i);
    CHECK(parse_fails(many, 100));
    many = many.substr(0, many.rfind(','));
    CHECK_EQ(parse_lens_layers(many, 100).size(), static_cast<size_t>(LENS_MAX_LAYERS));
    CHECK_EQ(lens_layers_text({0, 3, 7}), std::string("0,3,7"));
}

void test_rms_norm() {
    const float x[4] = {1, -2, 3, -4};
    const float w[4] = {1, 0.5f, 2, 1};
    float y[4];
    rms_norm(x, w, y, 4, 1e-6f);
    const double scale = 1.0 / std::sqrt((1 + 4 + 9 + 16) / 4.0 + 1e-6);
    for (int i = 0; i < 4; ++i) CHECK_NEAR(y[i], x[i] * scale * w[i], 1e-6);
}

void test_parallel_chunks() {
    for (int threads : {1, 3, 8}) {
        std::vector<int> hits(1000, 0);
        parallel_chunks(1000, 7, threads, [&](int64_t b, int64_t e) {
            for (int64_t i = b; i < e; ++i) ++hits[static_cast<size_t>(i)];
        });
        bool once = true;
        for (int h : hits) once = once && h == 1;
        CHECK(once);
    }
    int calls = 0;
    parallel_chunks(0, 4, 4, [&](int64_t, int64_t) { ++calls; });
    CHECK_EQ(calls, 0);
}

void test_projection() {
    // Odd sizes: rows that do not fill a chunk, n_embd not a multiple of the
    // vector width.
    const int64_t n_rows = 1037;
    const int n_embd = 45;
    const int k = 3;
    std::vector<float> m(static_cast<size_t>(n_rows) * n_embd), x(static_cast<size_t>(k) * n_embd);
    for (size_t i = 0; i < m.size(); ++i) m[i] = noise(i);
    for (size_t i = 0; i < x.size(); ++i) x[i] = noise(1000000 + i);
    std::vector<double> direct(static_cast<size_t>(k) * n_rows);
    for (int i = 0; i < k; ++i)
        for (int64_t r = 0; r < n_rows; ++r) {
            double acc = 0;
            for (int j = 0; j < n_embd; ++j) acc += double(m[r * n_embd + j]) * x[static_cast<size_t>(i) * n_embd + j];
            direct[static_cast<size_t>(i) * n_rows + r] = acc;
        }
    for (int threads : {1, 4}) {
        std::vector<float> out(static_cast<size_t>(k) * n_rows, -99.0f);
        lens_project(m.data(), n_rows, n_embd, x.data(), k, out.data(), threads);
        double worst = 0;
        for (size_t i = 0; i < out.size(); ++i) worst = std::max(worst, std::fabs(out[i] - direct[i]));
        CHECK(worst < 1e-4);
    }
}

void test_stats() {
    // A small distribution against a direct softmax.
    std::vector<float> z = {1.0f, 3.0f, -2.0f, 3.0f, 0.5f, -INFINITY};
    const std::vector<float> orig = z;
    double sum = 0;
    for (float v : orig) sum += std::exp(double(v));
    double h = 0;
    for (float v : orig) {
        const double p = std::exp(double(v)) / sum;
        if (p > 0) h -= p * std::log2(p);
    }
    const LensLayer s = lens_stats(z.data(), static_cast<int64_t>(z.size()), 0, 4);
    CHECK_EQ(s.top_id, 1u);  // a tie goes to the lowest id, as in the EVAL candidates
    CHECK_NEAR(s.top_p, std::exp(3.0) / sum, 1e-6);
    CHECK_NEAR(s.answer_p, std::exp(0.5) / sum, 1e-6);
    CHECK_NEAR(s.entropy, h, 1e-5);
    CHECK(z == orig);  // no softcap: untouched
    CHECK_EQ(lens_stats(z.data(), static_cast<int64_t>(z.size()), 0, 5).answer_p, 0.0f);   // -inf logit
    CHECK_EQ(lens_stats(z.data(), static_cast<int64_t>(z.size()), 0, 99).answer_p, 0.0f);  // out of range

    // Large logits: no overflow.
    std::vector<float> big = {1000.0f, 999.0f};
    const LensLayer b = lens_stats(big.data(), 2, 0, 1);
    CHECK_NEAR(b.top_p, 1.0 / (1.0 + std::exp(-1.0)), 1e-6);
    CHECK_NEAR(b.answer_p, std::exp(-1.0) / (1.0 + std::exp(-1.0)), 1e-6);

    // Uniform: entropy log2(n).
    std::vector<float> flat(64, 0.25f);
    CHECK_NEAR(lens_stats(flat.data(), 64, 0, 0).entropy, 6.0, 1e-5);
}

void test_softcap() {
    std::vector<float> z = {40.0f, 10.0f, -50.0f};
    const float f = 30.0f;
    std::vector<double> c;
    for (float v : z) c.push_back(f * std::tanh(double(v) / f));
    const double sum = std::exp(c[0]) + std::exp(c[1]) + std::exp(c[2]);
    const LensLayer s = lens_stats(z.data(), 3, f, 1);
    for (size_t i = 0; i < z.size(); ++i) CHECK_NEAR(z[i], c[i], 1e-4);  // capped in place
    CHECK_EQ(s.top_id, 0u);
    CHECK_NEAR(s.top_p, std::exp(c[0]) / sum, 1e-5);
    CHECK_NEAR(s.answer_p, std::exp(c[1]) / sum, 1e-5);
}

void test_compute() {
    // The whole step against norm, product and softmax done by hand.
    LensWeights w;
    w.n_embd = 8;
    w.n_rows = 50;
    w.eps = 1e-5f;
    w.norm.resize(8);
    for (int i = 0; i < 8; ++i) w.norm[i] = 0.5f + 0.1f * i;
    w.matrix.resize(50 * 8);
    for (size_t i = 0; i < w.matrix.size(); ++i) w.matrix[i] = noise(7 + i);
    const int k = 2;
    std::vector<float> rows(k * 8);
    for (size_t i = 0; i < rows.size(); ++i) rows[i] = 3.0f * noise(500 + i);
    const int32_t answer = 17;

    for (float softcap : {0.0f, 2.0f}) {
        w.softcap = softcap;
        std::vector<float> scratch;
        const std::vector<LensLayer> got = lens_compute(w, rows.data(), k, answer, 3, scratch);
        CHECK_EQ(got.size(), size_t(k));
        if (got.size() != size_t(k)) continue;
        for (int i = 0; i < k; ++i) {
            const float* x = rows.data() + i * 8;
            double ss = 0;
            for (int j = 0; j < 8; ++j) ss += double(x[j]) * x[j];
            const double scale = 1.0 / std::sqrt(ss / 8 + w.eps);
            std::vector<double> z(50);
            for (int r = 0; r < 50; ++r) {
                double acc = 0;
                for (int j = 0; j < 8; ++j) acc += w.matrix[r * 8 + j] * (x[j] * scale * w.norm[j]);
                z[r] = softcap > 0 ? softcap * std::tanh(acc / softcap) : acc;
            }
            int top = 0;
            for (int r = 1; r < 50; ++r)
                if (z[r] > z[top]) top = r;
            double sum = 0;
            for (double v : z) sum += std::exp(v - z[top]);
            double h = 0;
            for (double v : z) {
                const double p = std::exp(v - z[top]) / sum;
                h -= p * std::log2(p);
            }
            CHECK_EQ(got[i].top_id, uint32_t(top));
            CHECK_NEAR(got[i].top_p, 1.0 / sum, 1e-5);
            CHECK_NEAR(got[i].answer_p, std::exp(z[answer] - z[top]) / sum, 1e-5);
            CHECK_NEAR(got[i].entropy, h, 1e-4);
        }
    }
}

}  // namespace

int main() {
    test_default_layers();
    test_parse_layers();
    test_rms_norm();
    test_parallel_chunks();
    test_projection();
    test_stats();
    test_softcap();
    test_compute();
    return test_result();
}
