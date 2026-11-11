const requestMetrics = {
  total: 0,
  byMethod: { GET: 0, PUT: 0, POST: 0, DELETE: 0 },
};

function requestTracker(req, res, next) {
    
    res.once('finish', () => {
        requestMetrics.total += 1;

        if (Object.hasOwn(requestMetrics.byMethod, req.method)) {
            requestMetrics.byMethod[req.method] += 1;
        }
    });

    next();
}

module.exports = { requestTracker, requestMetrics };
