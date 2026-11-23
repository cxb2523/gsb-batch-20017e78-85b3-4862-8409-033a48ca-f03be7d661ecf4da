// Checks and URL of the Hugging Face downloads (hf.h). No network.
#include "check.h"
#include "hf.h"

#include <cstdlib>
#include <string>

using namespace ils;

namespace {

bool valid(const std::string& repo, const std::string& path) {
    try {
        validate_download({repo, path});
        return true;
    } catch (const std::invalid_argument&) {
        return false;
    }
}

void set_env(const char* name, const char* value) {
#ifdef _WIN32
    _putenv_s(name, value ? value : "");
#else
    if (value) {
        setenv(name, value, 1);
    } else {
        unsetenv(name);
    }
#endif
}

}  // namespace

int main() {
    // Valid requests.
    CHECK(valid("unsloth/Qwen3.5-0.8B-GGUF", "Qwen3.5-0.8B-Q8_0.gguf"));
    CHECK(valid("bartowski/Qwen_Qwen3.5-4B-GGUF", "Qwen_Qwen3.5-4B-Q2_K.gguf"));
    CHECK(valid("a_b.c-d/e", "sub/dir/model.gguf"));

    // Repo: user/name with letters, digits, '_', '.', '-'.
    CHECK(!valid("", "m.gguf"));
    CHECK(!valid("unsloth", "m.gguf"));
    CHECK(!valid("unsloth/", "m.gguf"));
    CHECK(!valid("/repo", "m.gguf"));
    CHECK(!valid("a/b/c", "m.gguf"));
    CHECK(!valid("../b", "m.gguf"));
    CHECK(!valid("a/..", "m.gguf"));
    CHECK(!valid("./b", "m.gguf"));
    CHECK(!valid("a b/c", "m.gguf"));
    CHECK(!valid("a/b?x=1", "m.gguf"));
    CHECK(!valid("a/b#c", "m.gguf"));

    // Path: a .gguf, no "..", no backslash, no leading '/', not a split part.
    CHECK(!valid("a/b", ""));
    CHECK(!valid("a/b", "model.bin"));
    CHECK(!valid("a/b", "model.gguf.part"));
    CHECK(!valid("a/b", ".gguf"));
    CHECK(!valid("a/b", "../model.gguf"));
    CHECK(!valid("a/b", "dir/../model.gguf"));
    CHECK(!valid("a/b", "dir\\model.gguf"));
    CHECK(!valid("a/b", "/model.gguf"));
    CHECK(!valid("a/b", "dir//model.gguf"));
    CHECK(!valid("a/b", "dir/"));
    CHECK(!valid("a/b", "model-00001-of-00003.gguf"));
    CHECK(!valid("a/b", "Q8_0/model-00002-of-00002.gguf"));
    CHECK(!valid("a/b", "model?.gguf"));
    CHECK(!valid("a/b", "my model.gguf"));
    CHECK(!valid("a/b", "model%2e.gguf"));
    CHECK(!valid("a/b", "C:model.gguf"));

    // The message is for the user.
    try {
        validate_download({"nope", "m.gguf"});
        CHECK(false);
    } catch (const std::invalid_argument& e) {
        CHECK(std::string(e.what()).find("user/name") != std::string::npos);
    }

    // File name in the folder: the last part of the path.
    CHECK_EQ(download_file_name({"a/b", "m.gguf"}), std::string("m.gguf"));
    CHECK_EQ(download_file_name({"a/b", "Q8_0/sub/m.gguf"}), std::string("m.gguf"));

    // URL, with and without HF_ENDPOINT.
    set_env("HF_ENDPOINT", nullptr);
    CHECK_EQ(hf_file_url({"unsloth/Qwen3.5-0.8B-GGUF", "Qwen3.5-0.8B-Q8_0.gguf"}),
             std::string("https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q8_0.gguf"));
    CHECK_EQ(hf_file_url({"a/b", "dir/m.gguf"}), std::string("https://huggingface.co/a/b/resolve/main/dir/m.gguf"));
    set_env("HF_ENDPOINT", "http://127.0.0.1:9000/");
    CHECK_EQ(hf_file_url({"a/b", "m.gguf"}), std::string("http://127.0.0.1:9000/a/b/resolve/main/m.gguf"));
    set_env("HF_ENDPOINT", "https://hf-mirror.example//");
    CHECK_EQ(hf_file_url({"a/b", "m.gguf"}), std::string("https://hf-mirror.example/a/b/resolve/main/m.gguf"));
    set_env("HF_ENDPOINT", "");
    CHECK_EQ(hf_file_url({"a/b", "m.gguf"}), std::string("https://huggingface.co/a/b/resolve/main/m.gguf"));
    set_env("HF_ENDPOINT", nullptr);

    // A cancelled transfer is told apart from a failed one.
    try {
        throw DownloadCancelled();
    } catch (const std::runtime_error& e) {
        CHECK_EQ(std::string(e.what()), std::string("download cancelled"));
    }

    return test_result();
}
