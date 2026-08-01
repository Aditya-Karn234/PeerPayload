#pragma once

#include <condition_variable>
#include <deque>
#include <mutex>
#include <optional>
#include <utility>

// A blocking, fixed-capacity queue connecting one pipeline stage to the
// next (disk reader -> hasher -> network sender). Bounding capacity is what
// stops a fast stage from reading arbitrarily far ahead of a slow one and
// growing memory without limit; blocking (rather than a lock-free ring
// buffer) is enough here since each stage is one thread, not many.
template <typename T>
class BoundedQueue
{
public:
    explicit BoundedQueue(size_t capacity)
        : capacity_(capacity)
    {
    }

    // Blocks until there is room or the queue is closed. Returns false only
    // when closed before room became available — the item is dropped, which
    // only happens during shutdown/error unwind.
    bool push(T item)
    {
        std::unique_lock<std::mutex> lock(mutex_);

        notFull_.wait(lock, [&] { return items_.size() < capacity_ || closed_; });

        if (closed_)
            return false;

        items_.push_back(std::move(item));

        lock.unlock();

        notEmpty_.notify_one();

        return true;
    }

    // Blocks until an item is available, or returns nullopt once closed and
    // drained — the signal for "no more items are coming."
    std::optional<T> pop()
    {
        std::unique_lock<std::mutex> lock(mutex_);

        notEmpty_.wait(lock, [&] { return !items_.empty() || closed_; });

        if (items_.empty())
            return std::nullopt;

        T item = std::move(items_.front());

        items_.pop_front();

        lock.unlock();

        notFull_.notify_one();

        return item;
    }

    // Marks the queue done: no more pushes will succeed, and pop() drains
    // whatever remains before returning nullopt. Idempotent and safe to call
    // from any thread, including on an error-unwind path.
    void close()
    {
        {
            std::lock_guard<std::mutex> lock(mutex_);

            closed_ = true;
        }

        notEmpty_.notify_all();
        notFull_.notify_all();
    }

private:
    std::mutex mutex_;
    std::condition_variable notEmpty_;
    std::condition_variable notFull_;
    std::deque<T> items_;
    size_t capacity_;
    bool closed_ = false;
};
