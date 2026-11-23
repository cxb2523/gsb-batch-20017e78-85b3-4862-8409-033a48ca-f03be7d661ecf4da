// Downloads from Hugging Face into the models folder (the `download`
// command). The checks and the URL are here, in the core; the transfer
// itself (hf_download, hf_download.cpp) needs llama.cpp's common library
// built with TLS, so only the real binary links it. The hub takes the
// transfer as a function, and tests and the fake engine pass their own.
#pragma once

#include <atomic>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <stdexcept>
#include <string>

namespace ils {

struct DownloadRequest {
    std::string repo;  // "user/name"
    std::string path;  // path of the file in the repo, may have folders
};

// Throws std::invalid_argument with a message for the user unless `repo` is
// "user/name" (letters, digits, '_', '.', '-'; neither part "." or "..") and
// `path` ends in ".gguf", has no "..", no backslash and no leading '/', and
// its file name is a plain GGUF name (is_plain_gguf_name, catalog.h).
void validate_download(const DownloadRequest& req);

// The name the file gets in the models folder: the last part of `path`.
std::string download_file_name(const DownloadRequest& req);

// ${HF_ENDPOINT:-https://huggingface.co}/<repo>/resolve/main/<path>, with
// no trailing slash on the endpoint.
std::string hf_file_url(const DownloadRequest& req);

struct DownloadProgress {
    uint64_t done = 0;
    uint64_t total = 0;  // 0 while unknown
};

// Thrown by a transfer that stopped because `cancel` was set.
struct DownloadCancelled : std::runtime_error {
    DownloadCancelled() : std::runtime_error("download cancelled") {}
};

// A transfer: downloads `req` to `dest` (the final path), resuming a partial
// file left by an earlier attempt, calling `progress` as it goes (from the
// calling thread) and checking `cancel` often. On success `dest` exists and
// is complete; on failure or cancel it does not (the partial stays, under
// another name, for resuming). Throws DownloadCancelled, or
// std::runtime_error with a message for the user.
using DownloadFn = std::function<void(const DownloadRequest& req, const std::filesystem::path& dest,
                                      const std::function<void(const DownloadProgress&)>& progress,
                                      const std::atomic<bool>& cancel)>;

// The real transfer, with llama.cpp's common_download_file_single over
// HTTPS. Sends HF_TOKEN, if set, as a bearer token. Defined in
// hf_download.cpp, which only the real binary links.
void hf_download(const DownloadRequest& req, const std::filesystem::path& dest,
                 const std::function<void(const DownloadProgress&)>& progress, const std::atomic<bool>& cancel);

}  // namespace ils
