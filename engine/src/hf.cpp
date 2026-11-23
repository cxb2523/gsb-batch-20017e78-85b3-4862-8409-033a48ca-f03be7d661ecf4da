// Checks and URL of a Hugging Face download (hf.h). The transfer is in
// hf_download.cpp.
#include "hf.h"

#include "catalog.h"

#include <cstdlib>

namespace ils {

namespace {

bool is_repo_char(char ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' ||
           ch == '.' || ch == '-';
}

bool is_repo_part(const std::string& s) {
    if (s.empty() || s == "." || s == "..") return false;
    for (char ch : s) {
        if (!is_repo_char(ch)) return false;
    }
    return true;
}

}  // namespace

void validate_download(const DownloadRequest& req) {
    const size_t slash = req.repo.find('/');
    if (slash == std::string::npos || req.repo.find('/', slash + 1) != std::string::npos ||
        !is_repo_part(req.repo.substr(0, slash)) || !is_repo_part(req.repo.substr(slash + 1))) {
        throw std::invalid_argument("the repo must be user/name (letters, digits, '_', '.' and '-')");
    }
    const std::string& p = req.path;
    if (p.size() < 5 || p.compare(p.size() - 5, 5, ".gguf") != 0) {
        throw std::invalid_argument("the file must be a .gguf");
    }
    if (p.find("..") != std::string::npos || p.find('\\') != std::string::npos || p.front() == '/' ||
        p.find("//") != std::string::npos) {
        throw std::invalid_argument("invalid file path in the repo");
    }
    for (unsigned char ch : p) {
        // Characters that would need escaping in the URL.
        if (ch <= 0x20 || ch == 0x7f || ch == '?' || ch == '#' || ch == '%') {
            throw std::invalid_argument("invalid character in the file path");
        }
    }
    if (!is_plain_gguf_name(download_file_name(req))) {
        throw std::invalid_argument("not a single GGUF file (split GGUF files are not supported)");
    }
}

std::string download_file_name(const DownloadRequest& req) {
    const size_t slash = req.path.rfind('/');
    return slash == std::string::npos ? req.path : req.path.substr(slash + 1);
}

std::string hf_file_url(const DownloadRequest& req) {
    const char* env = std::getenv("HF_ENDPOINT");
    std::string endpoint = env && *env ? env : "https://huggingface.co";
    while (!endpoint.empty() && endpoint.back() == '/') endpoint.pop_back();
    return endpoint + "/" + req.repo + "/resolve/main/" + req.path;
}

}  // namespace ils
