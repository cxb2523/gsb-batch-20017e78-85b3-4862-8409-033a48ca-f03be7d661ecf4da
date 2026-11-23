#include "lens.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <thread>

namespace ils {

std::vector<int32_t> default_lens_layers(int32_t n_layer) {
    std::vector<int32_t> out;
    if (n_layer <= 0) return out;
    if (n_layer <= LENS_DEFAULT_LAYERS) {
        for (int32_t i = 0; i < n_layer; ++i) out.push_back(i);
        return out;
    }
    const int steps = LENS_DEFAULT_LAYERS - 1;
    for (int i = 0; i <= steps; ++i) {
        const int32_t il = static_cast<int32_t>(std::lround(static_cast<double>(i) * (n_layer - 1) / steps));
        if (out.empty() || out.back() != il) out.push_back(il);
    }
    return out;
}

std::vector<int32_t> parse_lens_layers(const std::string& text, int32_t n_layer) {
    const std::string what = "--lens-layers '" + text + "': ";
    std::vector<int32_t> out;
    size_t pos = 0;
    for (;;) {
        const size_t comma = text.find(',', pos);
        const std::string item = text.substr(pos, comma == std::string::npos ? std::string::npos : comma - pos);
        if (item.empty() || item.size() > 9 || item.find_first_not_of("0123456789") != std::string::npos)
            throw std::invalid_argument(what + "expected layer numbers separated by commas, like 0,3,7");
        const int64_t il = std::stoll(item);
        if (il >= n_layer)
            throw std::invalid_argument(what + "layer " + item + " does not exist; the model has " +
                                        std::to_string(n_layer) + " layers, from 0 to " + std::to_string(n_layer - 1));
        out.push_back(static_cast<int32_t>(il));
        if (comma == std::string::npos) break;
        pos = comma + 1;
    }
    std::sort(out.begin(), out.end());
    out.erase(std::unique(out.begin(), out.end()), out.end());
    if (out.size() > static_cast<size_t>(LENS_MAX_LAYERS))
        throw std::invalid_argument(what + "at most " + std::to_string(LENS_MAX_LAYERS) + " layers");
    return out;
}

std::string lens_layers_text(const std::vector<int32_t>& layers) {
    std::string s;
    for (int32_t il : layers) s += (s.empty() ? "" : ",") + std::to_string(il);
    return s;
}

void parallel_chunks(int64_t n, int64_t chunk, int n_threads, const std::function<void(int64_t, int64_t)>& fn) {
    if (n <= 0) return;
    chunk = std::max<int64_t>(chunk, 1);
    const int64_t n_chunks = (n + chunk - 1) / chunk;
    const int workers = static_cast<int>(std::min<int64_t>(std::max(n_threads, 1), n_chunks));
    std::atomic<int64_t> next{0};
    auto work = [&] {
        for (int64_t c; (c = next.fetch_add(1, std::memory_order_relaxed)) < n_chunks;)
            fn(c * chunk, std::min(n, (c + 1) * chunk));
    };
    std::vector<std::thread> pool;
    pool.reserve(static_cast<size_t>(workers - 1));
    for (int i = 1; i < workers; ++i) pool.emplace_back(work);
    work();
    for (std::thread& t : pool) t.join();
}

void rms_norm(const float* x, const float* weight, float* y, int n, float eps) {
    double sum = 0;
    for (int i = 0; i < n; ++i) sum += static_cast<double>(x[i] * x[i]);
    const float mean = static_cast<float>(sum / n);
    const float scale = 1.0f / std::sqrt(mean + eps);
    for (int i = 0; i < n; ++i) y[i] = x[i] * scale * weight[i];
}

namespace {

// a . b with independent partial sums, so that the compiler can vectorize it
// without reordering a single running sum.
inline float dot(const float* a, const float* b, int n) {
    constexpr int L = 16;
    float acc[L] = {};
    int j = 0;
    for (; j + L <= n; j += L)
        for (int l = 0; l < L; ++l) acc[l] += a[j + l] * b[j + l];
    float s = 0;
    for (int l = 0; l < L; ++l) s += acc[l];
    for (; j < n; ++j) s += a[j] * b[j];
    return s;
}

}  // namespace

void lens_project(const float* matrix, int64_t n_rows, int n_embd, const float* x, int k, float* out, int n_threads) {
    // Chunks of rows small enough to balance the threads, large enough that
    // taking one costs nothing next to the work.
    parallel_chunks(n_rows, 512, n_threads, [&](int64_t begin, int64_t end) {
        for (int64_t r = begin; r < end; ++r) {
            const float* row = matrix + r * n_embd;
            for (int i = 0; i < k; ++i) out[static_cast<size_t>(i) * n_rows + r] = dot(row, x + static_cast<size_t>(i) * n_embd, n_embd);
        }
    });
}

LensLayer lens_stats(float* z, int64_t n, float softcap, int32_t answer) {
    LensLayer s;
    if (n <= 0) return s;
    if (softcap > 0)
        for (int64_t i = 0; i < n; ++i) z[i] = softcap * std::tanh(z[i] / softcap);
    int64_t top = 0;
    for (int64_t i = 1; i < n; ++i)
        if (z[i] > z[top]) top = i;
    const double mx = z[top];
    if (!std::isfinite(mx)) {
        s.top_id = static_cast<uint32_t>(top);
        return s;
    }
    // With d = z - max and e = exp(d): p = e / sum, H = ln(sum) - sum(e d) / sum.
    const double neg_inf = -std::numeric_limits<double>::infinity();
    double sum = 0, weighted = 0;
    for (int64_t i = 0; i < n; ++i) {
        const double d = static_cast<double>(z[i]) - mx;
        if (!(d > neg_inf)) continue;  // -inf and NaN contribute nothing
        const double e = std::exp(d);
        sum += e;
        weighted += e * d;
    }
    const double log_sum = std::log(sum);
    s.top_id = static_cast<uint32_t>(top);
    s.top_p = static_cast<float>(1.0 / sum);
    if (answer >= 0 && answer < n) {
        const double d = static_cast<double>(z[answer]) - mx;
        s.answer_p = d > neg_inf ? static_cast<float>(std::exp(d - log_sum)) : 0.0f;
    }
    s.entropy = static_cast<float>(std::max(0.0, (log_sum - weighted / sum) / std::log(2.0)));
    return s;
}

std::vector<LensLayer> lens_compute(const LensWeights& w, const float* rows, int k, int32_t answer, int n_threads,
                                    std::vector<float>& scratch) {
    std::vector<LensLayer> out(static_cast<size_t>(std::max(k, 0)));
    if (k <= 0 || w.n_rows <= 0) return out;
    const size_t n_norm = static_cast<size_t>(k) * w.n_embd;
    scratch.resize(n_norm + static_cast<size_t>(k) * w.n_rows);
    float* xn = scratch.data();
    float* z = xn + n_norm;
    for (int i = 0; i < k; ++i)
        rms_norm(rows + static_cast<size_t>(i) * w.n_embd, w.norm.data(), xn + static_cast<size_t>(i) * w.n_embd,
                 w.n_embd, w.eps);
    lens_project(w.matrix.data(), w.n_rows, w.n_embd, xn, k, z, n_threads);
    parallel_chunks(k, 1, n_threads, [&](int64_t begin, int64_t end) {
        for (int64_t i = begin; i < end; ++i)
            out[static_cast<size_t>(i)] = lens_stats(z + static_cast<size_t>(i) * w.n_rows, w.n_rows, w.softcap, answer);
    });
    return out;
}

}  // namespace ils
