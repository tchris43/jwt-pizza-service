const config = require('./config.js');
const metrics = require('./metrics.js');
const OtelMetricBuilder = require('./otelMetricBuilder.js');

function sendMetricsPeriodically(periodMs = 10_000) {
  // This flag prevents a slow Grafana request from overlapping the next timer run.
  let sending = false;

  // setInterval repeats this callback after each period (10 seconds by default).
  return setInterval(async () => {
    // If the previous export is still running, skip this tick and try next time.
    if (sending) return;

    sending = true;
    try {
      // The builder knows how to format the data and send it to Grafana.
      const builder = new OtelMetricBuilder(config.metrics);

      // Each helper reads its current values from metrics.js and groups related metrics.
      builder.add(metrics.getHttpMetrics());
      builder.add(metrics.getSystemMetrics());
      builder.add(metrics.getUserMetrics());
      builder.add(metrics.getPurchaseMetrics());
      builder.add(metrics.getAuthMetrics());

      // Send all five groups together in one Grafana request.
      await builder.sendToGrafana();
    } catch (error) {
      // Keep an export problem from interrupting the Express server.
      console.error('Error sending metrics to Grafana:', error.message);
    } finally {
      // Allow the next timer run, whether this send succeeded or failed.
      sending = false;
    }
  }, periodMs);
}

module.exports = { sendMetricsPeriodically };
