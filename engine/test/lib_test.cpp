// In-process tests of the engine library's C API (peerpayload.h): sender
// and receiver running as library calls in one process, event routing
// between concurrent runs, and cancellation at each stage.
//
// Build: part of the CMake project (target engine_lib_test). Run it with no
// arguments; exits 0 if every check passes.
#include "peerpayload.h"

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <iostream>
#include <mutex>
#include <random>
#include <string>
#include <thread>
#include <vector>

#include "platform_socket.hpp"

namespace fs = std::filesystem;
using namespace std::chrono_literals;

namespace
{

int failures = 0;

void check(bool ok, const std::string &what)
{
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << '\n';

    if (!ok)
        failures++;
}

// Collects one run's events; lets a test wait for a particular one.
struct Events
{
    std::mutex mutex;
    std::condition_variable cv;
    std::vector<std::string> lines;

    static void callback(const char *json, void *user)
    {
        auto *self = static_cast<Events *>(user);

        {
            std::lock_guard<std::mutex> lock(self->mutex);
            self->lines.emplace_back(json);
        }

        self->cv.notify_all();
    }

    bool waitFor(const std::string &event, std::chrono::milliseconds timeout)
    {
        std::unique_lock<std::mutex> lock(mutex);

        return cv.wait_for(lock, timeout, [&] { return findLocked(event) != nullptr; });
    }

    std::string find(const std::string &event)
    {
        std::lock_guard<std::mutex> lock(mutex);
        const std::string *line = findLocked(event);
        return line ? *line : "";
    }

    size_t count(const std::string &event)
    {
        std::lock_guard<std::mutex> lock(mutex);
        size_t n = 0;
        for (auto &l : lines)
            if (l.find("\"event\":\"" + event + "\"") != std::string::npos)
                n++;
        return n;
    }

    bool allTagged(const std::string &transferId)
    {
        std::lock_guard<std::mutex> lock(mutex);
        for (auto &l : lines)
            if (l.find("\"transferId\":\"" + transferId + "\"") == std::string::npos)
                return false;
        return !lines.empty();
    }

private:
    const std::string *findLocked(const std::string &event)
    {
        for (auto &l : lines)
            if (l.find("\"event\":\"" + event + "\"") != std::string::npos)
                return &l;
        return nullptr;
    }
};

std::string field(const std::string &json, const std::string &key)
{
    std::string marker = "\"" + key + "\":\"";
    size_t start = json.find(marker);

    if (start == std::string::npos)
        return "";

    start += marker.size();
    return json.substr(start, json.find('"', start) - start);
}

int freePort()
{
    SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    bind(s, reinterpret_cast<sockaddr *>(&addr), sizeof(addr));
    platform_socklen_t len = sizeof(addr);
    getsockname(s, reinterpret_cast<sockaddr *>(&addr), &len);
    closesocket(s);
    return ntohs(addr.sin_port);
}

fs::path makeFile(const fs::path &dir, const std::string &name, size_t size, unsigned seed)
{
    fs::create_directories(dir);
    fs::path p = dir / name;
    std::mt19937 rng(seed);
    std::vector<char> data(size);
    for (auto &c : data)
        c = static_cast<char>(rng());
    std::ofstream(p, std::ios::binary).write(data.data(), static_cast<std::streamsize>(data.size()));
    return p;
}

bool sameContents(const fs::path &a, const fs::path &b)
{
    std::ifstream fa(a, std::ios::binary), fb(b, std::ios::binary);
    std::string ca((std::istreambuf_iterator<char>(fa)), {}), cb((std::istreambuf_iterator<char>(fb)), {});
    return !ca.empty() && ca == cb;
}

// Runs a receiver or sender on its own thread; join() returns its exit code.
struct Runner
{
    Events events;
    pp_run *run = nullptr;
    std::thread thread;
    std::atomic<int> rc{-1};
    std::vector<std::string> args;

    void start(bool sender, std::vector<std::string> a)
    {
        args = std::move(a);
        run = pp_run_new(&Events::callback, &events);
        thread = std::thread([this, sender] {
            std::vector<const char *> argv;
            for (auto &s : args)
                argv.push_back(s.c_str());
            rc = sender ? pp_run_sender(run, static_cast<int>(argv.size()), argv.data())
                        : pp_run_receiver(run, static_cast<int>(argv.size()), argv.data());
        });
    }

    int join()
    {
        thread.join();
        pp_run_free(run);
        return rc;
    }
};

double secondsSince(std::chrono::steady_clock::time_point t)
{
    return std::chrono::duration<double>(std::chrono::steady_clock::now() - t).count();
}

} // namespace

int main()
{
    std::string err;
    platformSocketStartup(err);

    fs::path root = fs::temp_directory_path() / ("pp-libtest-" + std::to_string(std::random_device{}()));

    std::cout << "protocol version\n";
    check(pp_protocol_version() == 12, "pp_protocol_version() == 12");

    std::cout << "in-process pinned transfer\n";
    {
        fs::path src = makeFile(root / "src1", "blob.bin", 3 * 1024 * 1024 + 11, 1);
        int port = freePort();
        Runner rx, tx;
        rx.start(false, {"-p", std::to_string(port), "-o", (root / "out1").string(), "--transfer-id", "rx1", "--listen-timeout", "20"});
        check(rx.events.waitFor("listening", 10s), "receiver reports listening through the callback");
        std::string pin = field(rx.events.find("listening"), "certSha256");
        check(pin.size() == 64, "listening event carries the certificate fingerprint");

        tx.start(true, {"-h", "127.0.0.1", "-p", std::to_string(port), "--transfer-id", "tx1", "--pin-sha256", pin, src.string()});
        int txRc = tx.join();
        int rxRc = rx.join();
        check(txRc == 0 && rxRc == 0, "both runs return 0");
        check(tx.events.count("transfer_complete") == 1 && rx.events.count("transfer_complete") == 1, "both report transfer_complete");
        check(field(tx.events.find("session_start"), "tlsSummary").find("TLSv1.3") != std::string::npos, "TLS 1.3 negotiated");
        check(sameContents(src, root / "out1" / "blob.bin"), "received file is byte-identical");
        check(tx.events.allTagged("tx1") && rx.events.allTagged("rx1"), "each run's callback saw only its own events");
    }

    std::cout << "two simultaneous transfers in one process\n";
    {
        fs::path srcA = makeFile(root / "srcA", "a.bin", 2 * 1024 * 1024, 2);
        fs::path srcB = makeFile(root / "srcB", "b.bin", 2 * 1024 * 1024 + 5, 3);
        int portA = freePort(), portB = freePort();
        Runner rxA, rxB, txA, txB;
        rxA.start(false, {"-p", std::to_string(portA), "-o", (root / "outA").string(), "--transfer-id", "rxA", "--no-tls", "--listen-timeout", "20"});
        rxB.start(false, {"-p", std::to_string(portB), "-o", (root / "outB").string(), "--transfer-id", "rxB", "--listen-timeout", "20"});
        rxA.events.waitFor("listening", 10s);
        rxB.events.waitFor("listening", 10s);
        txA.start(true, {"-h", "127.0.0.1", "-p", std::to_string(portA), "--transfer-id", "txA", "--no-tls", "--chunk-size", "4096", srcA.string()});
        txB.start(true, {"-h", "127.0.0.1", "-p", std::to_string(portB), "--transfer-id", "txB", "--chunk-size", "8192", srcB.string()});
        bool ok = txA.join() == 0 && txB.join() == 0 && rxA.join() == 0 && rxB.join() == 0;
        check(ok, "all four runs return 0");
        check(sameContents(srcA, root / "outA" / "a.bin") && sameContents(srcB, root / "outB" / "b.bin"), "both files byte-identical");
        check(txA.events.allTagged("txA") && txB.events.allTagged("txB") && rxA.events.allTagged("rxA") && rxB.events.allTagged("rxB"),
              "no events leaked between concurrent runs");
    }

    std::cout << "cancel while listening\n";
    {
        Runner rx;
        rx.start(false, {"-p", std::to_string(freePort()), "-o", (root / "outC").string(), "--transfer-id", "rxC"});
        rx.events.waitFor("listening", 10s);
        auto t0 = std::chrono::steady_clock::now();
        pp_run_cancel(rx.run);
        int rc = rx.join();
        check(rc == 1, "cancelled receiver returns 1");
        check(field(rx.events.find("transfer_failed"), "reason") == "cancelled", "reason is \"cancelled\"");
        check(secondsSince(t0) < 2.0, "returns promptly (" + std::to_string(secondsSince(t0)) + " s)");
    }

    std::cout << "cancel while connecting\n";
    {
        Runner tx;
        fs::path src = makeFile(root / "srcD", "d.bin", 1024, 4);
        // TEST-NET-3: never answers, so the sender sits in connect().
        tx.start(true, {"-h", "203.0.113.1", "-p", "9", "--transfer-id", "txD", src.string()});
        std::this_thread::sleep_for(400ms);
        auto t0 = std::chrono::steady_clock::now();
        pp_run_cancel(tx.run);
        int rc = tx.join();
        check(rc == 1, "cancelled sender returns 1");
        check(field(tx.events.find("transfer_failed"), "reason") == "cancelled", "reason is \"cancelled\"");
        check(secondsSince(t0) < 2.0, "returns promptly (" + std::to_string(secondsSince(t0)) + " s)");
    }

    std::cout << "cancel mid-transfer\n";
    {
        fs::path src = makeFile(root / "srcE", "e.bin", 48 * 1024 * 1024, 5);
        int port = freePort();
        Runner rx, tx;
        rx.start(false, {"-p", std::to_string(port), "-o", (root / "outE").string(), "--transfer-id", "rxE"});
        rx.events.waitFor("listening", 10s);
        // Small chunks and window so the transfer is still running when we cancel.
        tx.start(true, {"-h", "127.0.0.1", "-p", std::to_string(port), "--transfer-id", "txE", "--chunk-size", "4096", "--window", "1", src.string()});
        tx.events.waitFor("chunk_verified", 10s);
        auto t0 = std::chrono::steady_clock::now();
        pp_run_cancel(tx.run);
        int txRc = tx.join();
        int rxRc = rx.join();
        check(txRc == 1, "cancelled sender returns 1");
        check(field(tx.events.find("transfer_failed"), "reason") == "cancelled", "sender reason is \"cancelled\"");
        check(rxRc == 1 && rx.events.count("transfer_failed") == 1, "receiver sees the connection end and fails");
        check(secondsSince(t0) < 3.0, "both return promptly (" + std::to_string(secondsSince(t0)) + " s)");
        check(fs::exists(root / "outE" / "transfer.state"), "resume state is kept for a later retry");
    }

    std::error_code ec;
    fs::remove_all(root, ec);
    platformSocketCleanup();

    std::cout << (failures ? std::to_string(failures) + " check(s) failed\n" : "all checks passed\n");
    return failures ? 1 : 0;
}
