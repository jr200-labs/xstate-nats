import { describe, expect, it } from 'vitest'
import {
  byteLength,
  createEmptyTrafficMetrics,
  recordTrafficMetric,
  resetTrafficAll,
  resetTrafficDownload,
  resetTrafficUpload,
} from './traffic'

describe('traffic metrics', () => {
  it('counts UTF-8 payload bytes', () => {
    expect(byteLength('hello')).toBe(5)
    expect(byteLength('£')).toBe(2)
    expect(byteLength({ msg: 'hello' })).toBe(15)
    expect(byteLength(new Uint8Array([1, 2, 3]))).toBe(3)
  })

  it('records upload and download bytes by source', () => {
    const metrics = recordTrafficMetric(createEmptyTrafficMetrics(), {
      type: 'METRICS.RECORD',
      source: 'nats.request',
      uploadBytes: 10,
      downloadBytes: 25,
    })

    expect(metrics.uploadBytes).toBe(10)
    expect(metrics.downloadBytes).toBe(25)
    expect(metrics.bySource['nats.request']).toEqual({ uploadBytes: 10, downloadBytes: 25 })
  })

  it('resets upload and download independently', () => {
    const metrics = recordTrafficMetric(
      recordTrafficMetric(createEmptyTrafficMetrics(), {
        type: 'METRICS.RECORD',
        source: 'nats.request',
        uploadBytes: 10,
        downloadBytes: 25,
      }),
      {
        type: 'METRICS.RECORD',
        source: 'nats.subscribe',
        downloadBytes: 7,
      },
    )

    const uploadReset = resetTrafficUpload(metrics)
    expect(uploadReset.uploadBytes).toBe(0)
    expect(uploadReset.downloadBytes).toBe(32)
    expect(uploadReset.bySource['nats.request']).toEqual({ uploadBytes: 0, downloadBytes: 25 })

    const requestDownloadReset = resetTrafficDownload(metrics, 'nats.request')
    expect(requestDownloadReset.uploadBytes).toBe(10)
    expect(requestDownloadReset.downloadBytes).toBe(7)
    expect(requestDownloadReset.bySource['nats.request']).toEqual({
      uploadBytes: 10,
      downloadBytes: 0,
    })

    expect(resetTrafficAll(metrics)).toEqual(createEmptyTrafficMetrics())
  })
})
