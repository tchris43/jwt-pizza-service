const os = require('os');

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

// Purchase metrics use explicit units: sold is individual pizzas, failures is
// failed factory order attempts, and revenue is the value of successful orders.
// Latency covers every factory attempt, whether it succeeds or fails.
const pizzaMetrics = {
    sold: 0,
    creationFailures: 0,
    revenue: 0,
    factoryLatency: {
        count: 0,
        totalMs: 0,
    },
};

function pizzaPurchase(success, latencyMs, price, pizzaCount) {
    // Keep latency for both successful and failed factory attempts so failures
    // that are slow still appear in the latency measurements.
    const elapsedMs = Number(latencyMs);
    pizzaMetrics.factoryLatency.count += 1;
    pizzaMetrics.factoryLatency.totalMs += Number.isFinite(elapsedMs) ? elapsedMs : 0;

    if (success) {
        // Count each pizza in the order, and add revenue only after acceptance.
        const count = Number(pizzaCount);
        const orderPrice = Number(price);
        pizzaMetrics.sold += Number.isFinite(count) ? count : 0;
        pizzaMetrics.revenue += Number.isFinite(orderPrice) ? orderPrice : 0;
    } else {
        // One failed factory order is one creation failure, even if it contained
        // multiple requested pizzas.
        pizzaMetrics.creationFailures += 1;
    }
}

function getCpuUsagePercentage() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return cpuUsage.toFixed(2) * 100;
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const memoryUsage = (usedMemory / totalMemory) * 100;
  return memoryUsage.toFixed(2);
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

// These helpers turn the values collected above into groups the exporter can send.
function getHttpMetrics() {
    const routeStats = Object.entries(requestMetrics.latencyByEndpoint);
    const metrics = [
        {
            name: 'http_requests_total',
            type: 'sum',
            unit: '1',
            points: [{ value: requestMetrics.total }],
        },
        {
            name: 'http_requests_by_method_total',
            type: 'sum',
            unit: '1',
            points: Object.entries(requestMetrics.byMethod).map(([method, value]) => ({
                value,
                attributes: { method },
            })),
        },
    ];

    if (routeStats.length > 0) {
        metrics.push(
            {
                name: 'http_request_duration_ms_sum',
                type: 'sum',
                unit: 'ms',
                points: routeStats.map(([route, stats]) => ({
                    value: stats.totalMs,
                    attributes: { route },
                })),
            },
            {
                name: 'http_request_duration_count',
                type: 'sum',
                unit: '1',
                points: routeStats.map(([route, stats]) => ({
                    value: stats.count,
                    attributes: { route },
                })),
            }
        );
    }

    return metrics;
}

function getUserMetrics() {
    return [{
        name: 'active_users',
        type: 'gauge',
        unit: '1',
        points: [{ value: getActiveUserCount() }],
    }];
}

function getAuthMetrics() {
    return [{
        name: 'auth_attempts_total',
        type: 'sum',
        unit: '1',
        points: [
            { value: authMetrics.successful, attributes: { outcome: 'success' } },
            { value: authMetrics.failed, attributes: { outcome: 'failure' } },
        ],
    }];
}

function getSystemMetrics() {
    return [
        {
            name: 'cpu_usage_percent',
            type: 'gauge',
            unit: '%',
            points: [{ value: getCpuUsagePercentage(), valueType: 'asDouble' }],
        },
        {
            name: 'memory_usage_percent',
            type: 'gauge',
            unit: '%',
            points: [{ value: getMemoryUsagePercentage(), valueType: 'asDouble' }],
        },
    ];
}

function getPurchaseMetrics() {
    return [
        { name: 'pizzas_sold_total', type: 'sum', unit: '1', points: [{ value: pizzaMetrics.sold }] },
        { name: 'pizza_creation_failures_total', type: 'sum', unit: '1', points: [{ value: pizzaMetrics.creationFailures }] },
        { name: 'pizza_revenue_total', type: 'sum', unit: 'USD', points: [{ value: pizzaMetrics.revenue, valueType: 'asDouble' }] },
        { name: 'pizza_factory_duration_ms_sum', type: 'sum', unit: 'ms', points: [{ value: pizzaMetrics.factoryLatency.totalMs }] },
        { name: 'pizza_factory_duration_count', type: 'sum', unit: '1', points: [{ value: pizzaMetrics.factoryLatency.count }] },
    ];
}

module.exports = {
    requestTracker,
    requestMetrics,
    authMetrics,
    recordAuthAttempt,
    pizzaMetrics,
    pizzaPurchase,
    getActiveUserCount,
    getCpuUsagePercentage,
    getMemoryUsagePercentage,
    getHttpMetrics,
    getUserMetrics,
    getAuthMetrics,
    getSystemMetrics,
    getPurchaseMetrics,
};
