const requestMetrics = {
  total: 0,
  byMethod: { GET: 0, PUT: 0, POST: 0, DELETE: 0 },
  latencyByEndpoint: {},
};

// Cumulative login counters. The exporter can later send these to Grafana,
// where the change in each counter can be displayed as attempts per minute.
const authMetrics = {
    successful: 0,
    failed: 0,
};

function recordAuthAttempt(outcome) {
    if (outcome === 'success') {
        authMetrics.successful += 1;
    } else if (outcome === 'failure') {
        authMetrics.failed += 1;
    }
}

// Keep the last activity time for each authenticated user in this process.
// User IDs stay local; the metric we report later is only the count.
const activeUsers = new Map();
const ACTIVE_USER_WINDOW_MS = 60 * 1000;

function requestTracker(req, res, next) {

    const startedAt = Date.now();
    
    res.once('finish', () => {
        const durationMs = Date.now() - startedAt;

        requestMetrics.total += 1;

        if (Object.hasOwn(requestMetrics.byMethod, req.method)) {
            requestMetrics.byMethod[req.method] += 1;
        }

        const endpoint = req.route
        ? `${req.baseUrl}${req.route.path}`
        : 'unmatched';

        const stats = requestMetrics.latencyByEndpoint[endpoint] ??= {
        count: 0,
        totalMs: 0,
        };

        stats.count += 1;
        stats.totalMs += durationMs;

        // A valid authenticated request makes this user active for one minute.
        if (req.user?.id !== undefined) {
            activeUsers.set(req.user.id, Date.now());
        }
    });

    next();
}

function getActiveUserCount(now = Date.now()) {
    // Expire users whose last authenticated request is outside the time window.
    for (const [userId, lastSeen] of activeUsers) {
        if (now - lastSeen >= ACTIVE_USER_WINDOW_MS) {
            activeUsers.delete(userId);
        }
    }

    return activeUsers.size;
}

module.exports = { requestTracker, requestMetrics, authMetrics, recordAuthAttempt, getActiveUserCount };
