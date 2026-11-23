// HTTP and WebSocket server.
// It has no logic of its own: browser commands go to a callback, and the log
// goes to every browser. One thread per connection reads commands; one
// broadcaster thread sends what each connection is missing.
#pragma once

#include "log.h"
#include "session.h"
#include "web_assets.h"

#include <functional>
#include <memory>
#include <string>
#include <vector>

namespace ils {

struct ServerOptions {
    std::string host = "127.0.0.1";
    int port = 8642;                         // 0 picks a free port
    std::vector<std::string> allow_origins;  // accepted besides "http://" + Host
};

class Server {
public:
    struct Handlers {
        std::function<void(const std::string& text)> command;  // a text message from a browser
        std::function<Status()> status;                        // for the `status` event
        // JSON events for a browser that has just connected, sent after the
        // log and its first `status` (the hub's `models`). May be empty.
        std::function<std::vector<std::string>()> connect_events;
    };

    // Becomes the log's listener, so it must be built before anything else
    // uses the log. Serves nothing until start().
    Server(Log& log, WebAssets web, Handlers handlers);
    ~Server();  // stop()

    Server(const Server&) = delete;
    Server& operator=(const Server&) = delete;

    // Binds and serves on background threads. False if it cannot bind.
    bool start(const ServerOptions& options);
    int port() const;  // the bound port, valid after start()

    // An `error` or `warning` event (JSON text) for every connection. Any thread.
    void push_event(const std::string& json);
    // Sends a `status` event to every connection. Any thread.
    void notify_status();

    size_t clients() const;  // open WebSocket connections

    // Closes the WebSocket connections, then stops the server. Idempotent.
    void stop();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace ils
