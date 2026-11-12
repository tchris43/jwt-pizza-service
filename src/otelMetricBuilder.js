class OtelMetricBuilder {
  constructor(metricsConfig) {
    this.metricsConfig = metricsConfig;
    this.metrics = [];
  }

  // A group is just an array of metric definitions, such as all HTTP metrics.
  add(metricGroup) {
    this.metrics.push(...metricGroup);
  }

  async sendToGrafana() {
    if (!this.metricsConfig?.endpointUrl || !this.metricsConfig.accountId || !this.metricsConfig.apiKey) {
      throw new Error('Grafana metrics endpoint or credentials are missing from config.metrics');
    }

    const nowUnixNano = String(BigInt(Date.now()) * 1_000_000n);
    const payload = {
      resourceMetrics: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: this.metricsConfig.source || 'jwt-pizza-service' } },
          ],
        },
        scopeMetrics: [{
          scope: { name: 'jwt-pizza-service.metrics' },
          metrics: this.metrics.map((metric) => this.makeMetric(metric, nowUnixNano)),
        }],
      }],
    };

    const response = await fetch(this.metricsConfig.endpointUrl, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: {
        Authorization: `Bearer ${this.metricsConfig.accountId}:${this.metricsConfig.apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Grafana returned ${response.status}: ${await response.text()}`);
    }
  }

  makeMetric(metric, nowUnixNano) {
    const dataPoints = metric.points.map((point) => {
      const valueType = point.valueType || 'asInt';
      const dataPoint = {
        [valueType]: valueType === 'asInt' ? String(Math.trunc(point.value)) : Number(point.value),
        timeUnixNano: nowUnixNano,
        attributes: Object.entries(point.attributes || {}).map(([key, value]) => ({
          key,
          value: { stringValue: String(value) },
        })),
      };
      return dataPoint;
    });

    const result = {
      name: metric.name,
      unit: metric.unit,
      [metric.type]: { dataPoints },
    };

    if (metric.type === 'sum') {
      result.sum.aggregationTemporality = 'AGGREGATION_TEMPORALITY_CUMULATIVE';
      result.sum.isMonotonic = true;
    }

    return result;
  }
}

module.exports = OtelMetricBuilder;
