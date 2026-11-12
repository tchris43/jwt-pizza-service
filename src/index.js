const app = require('./service.js');
const metricsGenerator = require('./metricsGenerator.js');

const port = process.argv[2] || 3000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
  // Start exporting the real in-memory metrics after the service begins listening.
  metricsGenerator.sendMetricsPeriodically();
});
