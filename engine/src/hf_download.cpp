// The real transfer of a Hugging Face download (hf.h), with llama.cpp's
// common_download_file_single over HTTPS (LibreSSL, built statically).
//
// What common_download_file_single does with `dest` (common/download.cpp):
//   <dest>.downloadInProgress       the partial; kept on failure or cancel and
//                                   resumed with a Range request next time
//   <dest>.downloadInProgress.etag  the server's ETag of that partial: a
//                                   partial of another version is discarded
//   <dest>.etag                     written on success (removed here)
//   <dest>.lock                     cross-process lock, never deleted by it
//                                   (removed here: one engine owns its folder)
// The partial is renamed to <dest> only once complete, so <dest> never exists
// half written. None of these extras ends in .gguf: the catalog skips them.
#include "hf.h"

#include "download.h"

#include <cstdlib>
#include <system_error>

namespace fs = std::filesystem;

namespace ils {

namespace {

class Callback : public common_download_callback {
public:
    Callback(const std::function<void(const DownloadProgress&)>& progress, const std::atomic<bool>& cancel)
        : progress_(progress), cancel_(cancel) {}
    void on_start(const common_download_progress&) override {}
    void on_update(const common_download_progress& p) override {
        if (progress_) progress_(DownloadProgress{p.downloaded, p.total});
    }
    void on_done(const common_download_progress&, bool) override {}
    bool is_cancelled() const override { return cancel_.load(); }

private:
    const std::function<void(const DownloadProgress&)>& progress_;
    const std::atomic<bool>& cancel_;
};

void remove_quietly(const fs::path& p) {
    std::error_code ec;
    fs::remove(p, ec);
}

std::string failure_message(int status) {
    if (status == 401 || status == 403) {
        return "access denied by Hugging Face (HTTP " + std::to_string(status) +
               "): for a gated or private repo, accept its terms on the website and set HF_TOKEN";
    }
    if (status == 404) return "file not found on Hugging Face (HTTP 404)";
    if (status > 0) return "download failed (HTTP " + std::to_string(status) + ")";
    return "download failed (network error); download again to resume";
}

}  // namespace

void hf_download(const DownloadRequest& req, const fs::path& dest,
                 const std::function<void(const DownloadProgress&)>& progress, const std::atomic<bool>& cancel) {
    validate_download(req);
    std::error_code ec;
    if (fs::exists(dest, ec)) throw std::runtime_error("'" + dest.filename().u8string() + "' already exists");

    common_download_opts opts;
    if (const char* token = std::getenv("HF_TOKEN"); token && *token) opts.bearer_token = token;
    Callback callback(progress, cancel);
    opts.callback = &callback;

    const std::string path = dest.u8string();
    int status = -1;
    std::string error;
    try {
        // skip_etag false: the partial's ETag guards the resume against a
        // file that changed on the server.
        status = common_download_file_single(hf_file_url(req), path, opts, /*skip_etag=*/false);
    } catch (const std::exception& e) {
        error = e.what();
    }
    remove_quietly(path + ".etag");
    remove_quietly(path + ".lock");

    const bool complete = fs::exists(dest, ec);
    if (complete && error.empty() && status >= 200 && status < 300) return;
    // A complete file is kept only after a success: anything else leaves no
    // <dest> behind (the partial stays under its own name, for resuming).
    if (complete) remove_quietly(dest);
    if (cancel.load()) throw DownloadCancelled();
    throw std::runtime_error(error.empty() ? failure_message(status) : "download failed: " + error);
}

}  // namespace ils
