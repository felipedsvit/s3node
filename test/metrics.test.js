import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MetricsRegistry } from '../dist/src/metrics.js'

describe('MetricsRegistry', () => {
  it('renders nothing for metrics that were never touched', () => {
    const metrics = new MetricsRegistry()
    assert.equal(metrics.renderPrometheus(), '\n')
  })

  it('renders a counter with HELP/TYPE lines and label sets', () => {
    const metrics = new MetricsRegistry()
    metrics.httpRequestsTotal.inc({ action: 's3:PutObject', method: 'PUT', status: '200' })
    metrics.httpRequestsTotal.inc({ action: 's3:PutObject', method: 'PUT', status: '200' })
    const text = metrics.renderPrometheus()
    assert.match(text, /# HELP s3node_http_requests_total /)
    assert.match(text, /# TYPE s3node_http_requests_total counter/)
    assert.match(text, /s3node_http_requests_total\{action="s3:PutObject",method="PUT",status="200"\} 2/)
  })

  it('keeps separate label combinations as separate series', () => {
    const metrics = new MetricsRegistry()
    metrics.httpErrorsTotal.inc({ code: 'NoSuchKey' })
    metrics.httpErrorsTotal.inc({ code: 'AccessDenied' })
    metrics.httpErrorsTotal.inc({ code: 'AccessDenied' })
    const text = metrics.renderPrometheus()
    assert.match(text, /s3node_http_errors_total\{code="NoSuchKey"\} 1/)
    assert.match(text, /s3node_http_errors_total\{code="AccessDenied"\} 2/)
  })

  it('renders a gauge that can go up and down', () => {
    const metrics = new MetricsRegistry()
    metrics.activeMultipartUploads.set({}, 3)
    metrics.activeMultipartUploads.dec({}, 1)
    const text = metrics.renderPrometheus()
    assert.match(text, /^s3node_active_multipart_uploads 2$/m)
  })

  it('renders a histogram with cumulative buckets, sum and count', () => {
    const metrics = new MetricsRegistry()
    metrics.httpRequestDurationSeconds.observe({ action: 's3:GetObject' }, 0.01)
    metrics.httpRequestDurationSeconds.observe({ action: 's3:GetObject' }, 2)
    const text = metrics.renderPrometheus()
    assert.match(text, /s3node_http_request_duration_seconds_bucket\{action="s3:GetObject",le="0.025"\} 1/)
    assert.match(text, /s3node_http_request_duration_seconds_bucket\{action="s3:GetObject",le="\+Inf"\} 2/)
    assert.match(text, /s3node_http_request_duration_seconds_sum\{action="s3:GetObject"\} 2\.01/)
    assert.match(text, /s3node_http_request_duration_seconds_count\{action="s3:GetObject"\} 2/)
  })

  it('escapes quotes and backslashes in label values', () => {
    const metrics = new MetricsRegistry()
    metrics.httpErrorsTotal.inc({ code: 'weird"value\\here' })
    const text = metrics.renderPrometheus()
    assert.match(text, /code="weird\\"value\\\\here"/)
  })
})
