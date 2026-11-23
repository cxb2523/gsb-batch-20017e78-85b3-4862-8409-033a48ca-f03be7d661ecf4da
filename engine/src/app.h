// Assembly shared by the real binary and by the fake engine of the tests:
// log + catalog + server + hub. The models are loaded by the hub, at startup
// (-a, -b) or when a browser asks.
#pragma once

#include "hub.h"
#include "web_assets.h"

#include <string>
#include <vector>

namespace ils {

struct AppOptions {
    std::string host = "127.0.0.1";
    int port = 8642;
    std::vector<std::string> allow_origins;  // extra origins accepted on the WebSocket
    bool no_browser = false;
    bool verify_seek = false;  // --verify-seek (SessionOptions)
    std::string models_dir = "models";  // --models-dir: the folder the browser chooses from
};

// If argv[i] is one of --host, --port, --allow-origin, --no-browser,
// --verify-seek or --models-dir, stores it in `out` and returns true, leaving `i` on the last argument it consumed
// (the option itself, or its value): the caller's loop steps past it. Returns
// false, with `i` untouched, for anything else. Throws std::runtime_error on
// a missing or invalid value.
bool parse_app_option(int argc, char** argv, int& i, AppOptions& out);

// Help text of those options, one per line, for --help.
const char* app_options_help();

struct AppModels {
    HubBackend backend;  // how to load, download and measure the GPU
    int n_ctx = 4096;    // the engine's context size, for the catalog's VRAM estimates
    // Loaded before serving if `a` is not empty (-a and -b): full paths,
    // anywhere on disk. A failure ends run_app with 1. If B's tokenizer
    // differs from A's, B is freed and the engine goes on with A and a
    // warning in HELLO.
    std::string a, b;
};

// Serves until SIGINT or SIGTERM, then shuts down in order (WebSocket
// connections first, then the server, then the hub). Prints the models
// folder and the URL when ready and opens the browser unless told not to.
// Returns the process exit code.
int run_app(const AppOptions& options, AppModels models, WebAssets web);

}  // namespace ils
