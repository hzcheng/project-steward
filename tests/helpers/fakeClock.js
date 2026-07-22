'use strict';

function createFakeClock(startMs) {
    let nowMs = startMs;
    let nextHandle = 1;
    let nextOrder = 1;
    const timers = new Map();

    function normalizeDelay(delay, minimum) {
        return Math.max(minimum, Number.isFinite(delay) ? delay : minimum);
    }

    function schedule(callback, delay, interval) {
        const handle = nextHandle++;
        const intervalMs = interval ? normalizeDelay(delay, 1) : undefined;
        timers.set(handle, {
            callback,
            dueAtMs: nowMs + normalizeDelay(delay, 0),
            handle,
            intervalMs,
            order: nextOrder++,
        });
        return handle;
    }

    function nextDueTimer(targetMs) {
        let candidate;
        for (const timer of timers.values()) {
            if (timer.dueAtMs > targetMs) {
                continue;
            }
            if (!candidate
                || timer.dueAtMs < candidate.dueAtMs
                || (timer.dueAtMs === candidate.dueAtMs && timer.order < candidate.order)) {
                candidate = timer;
            }
        }
        return candidate;
    }

    return {
        get nowMs() {
            return nowMs;
        },
        setTimeout(callback, delay = 0) {
            return schedule(callback, delay, false);
        },
        clearTimeout(handle) {
            timers.delete(handle);
        },
        setInterval(callback, delay = 0) {
            return schedule(callback, delay, true);
        },
        clearInterval(handle) {
            timers.delete(handle);
        },
        advanceBy(durationMs) {
            if (!Number.isFinite(durationMs) || durationMs < 0) {
                throw new Error('durationMs must be a non-negative finite number');
            }
            const targetMs = nowMs + durationMs;
            for (let timer = nextDueTimer(targetMs); timer; timer = nextDueTimer(targetMs)) {
                nowMs = timer.dueAtMs;
                if (timer.intervalMs === undefined) {
                    timers.delete(timer.handle);
                }
                timer.callback();
                if (timer.intervalMs !== undefined && timers.get(timer.handle) === timer) {
                    timer.dueAtMs += timer.intervalMs;
                    timer.order = nextOrder++;
                }
            }
            nowMs = targetMs;
        },
        get pendingCount() {
            return timers.size;
        },
    };
}

module.exports = {
    createFakeClock,
};
