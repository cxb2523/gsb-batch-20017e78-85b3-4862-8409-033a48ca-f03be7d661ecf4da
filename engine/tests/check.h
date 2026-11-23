// Minimal test helpers: no framework, one executable per test file.
//   CHECK(cond); CHECK_EQ(a, b); CHECK_NEAR(a, b, eps);  ...  return test_result();
#pragma once

#include <cmath>
#include <cstdio>

namespace ils_test {

inline int& failures() {
    static int n = 0;
    return n;
}

inline void fail(const char* file, int line, const char* what) {
    std::fprintf(stderr, "%s:%d: FAILED: %s\n", file, line, what);
    ++failures();
}

}  // namespace ils_test

#define CHECK(cond) \
    do { \
        if (!(cond)) ils_test::fail(__FILE__, __LINE__, #cond); \
    } while (0)

#define CHECK_EQ(a, b) \
    do { \
        if (!((a) == (b))) ils_test::fail(__FILE__, __LINE__, #a " == " #b); \
    } while (0)

#define CHECK_NEAR(a, b, eps) \
    do { \
        if (!(std::fabs(static_cast<double>(a) - static_cast<double>(b)) <= (eps))) \
            ils_test::fail(__FILE__, __LINE__, #a " ~= " #b); \
    } while (0)

// Call at the end of main: prints the verdict and gives the exit code.
inline int test_result() {
    if (ils_test::failures() == 0) {
        std::printf("OK\n");
        return 0;
    }
    std::printf("%d check(s) FAILED\n", ils_test::failures());
    return 1;
}
