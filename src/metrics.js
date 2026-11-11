function requestTracker(req, res, next) {
    const startedAt = Date.now();
    
    res.once('finish', () => {
        const durationMs = Date.now() - startedAt;

        console.log({
            method: req.method,
            statusCode: res.statusCode,
            durationMs,
        });
    });

    next();
}

module.exports = { requestTracker };
