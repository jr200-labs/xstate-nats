export type NatsTrafficMetricSource = 'nats.publish' | 'nats.request' | 'nats.subscribe' | 'nats.kv'

export type NatsTrafficDirection = 'upload' | 'download'

export interface NatsTrafficMetricBucket {
  uploadBytes: number
  downloadBytes: number
}

export interface NatsTrafficMetrics extends NatsTrafficMetricBucket {
  bySource: Partial<Record<NatsTrafficMetricSource, NatsTrafficMetricBucket>>
}

export type NatsTrafficRecordEvent = {
  type: 'METRICS.RECORD'
  source: NatsTrafficMetricSource
  uploadBytes?: number
  downloadBytes?: number
}

export type NatsTrafficResetEvent =
  | { type: 'METRICS.RESET_UPLOAD'; source?: NatsTrafficMetricSource }
  | { type: 'METRICS.RESET_DOWNLOAD'; source?: NatsTrafficMetricSource }
  | { type: 'METRICS.RESET_ALL'; source?: NatsTrafficMetricSource }

export type NatsTrafficEvent = NatsTrafficRecordEvent | NatsTrafficResetEvent

const textEncoder = new TextEncoder()

export function createEmptyTrafficMetrics(): NatsTrafficMetrics {
  return {
    uploadBytes: 0,
    downloadBytes: 0,
    bySource: {},
  }
}

export function byteLength(value: unknown): number {
  if (value == null) return 0
  if (value instanceof Uint8Array) return value.byteLength
  if (value instanceof ArrayBuffer) return value.byteLength
  if (ArrayBuffer.isView(value)) return value.byteLength
  if (typeof value === 'string') return textEncoder.encode(value).byteLength

  try {
    return textEncoder.encode(JSON.stringify(value)).byteLength
  } catch {
    return 0
  }
}

export function recordTrafficMetric(
  metrics: NatsTrafficMetrics,
  event: NatsTrafficRecordEvent,
): NatsTrafficMetrics {
  const uploadBytes = normaliseByteCount(event.uploadBytes)
  const downloadBytes = normaliseByteCount(event.downloadBytes)

  if (uploadBytes === 0 && downloadBytes === 0) return metrics

  const currentSource = metrics.bySource[event.source] ?? { uploadBytes: 0, downloadBytes: 0 }
  return {
    uploadBytes: metrics.uploadBytes + uploadBytes,
    downloadBytes: metrics.downloadBytes + downloadBytes,
    bySource: {
      ...metrics.bySource,
      [event.source]: {
        uploadBytes: currentSource.uploadBytes + uploadBytes,
        downloadBytes: currentSource.downloadBytes + downloadBytes,
      },
    },
  }
}

export function resetTrafficUpload(
  metrics: NatsTrafficMetrics,
  source?: NatsTrafficMetricSource,
): NatsTrafficMetrics {
  return resetTrafficDirection(metrics, 'upload', source)
}

export function resetTrafficDownload(
  metrics: NatsTrafficMetrics,
  source?: NatsTrafficMetricSource,
): NatsTrafficMetrics {
  return resetTrafficDirection(metrics, 'download', source)
}

export function resetTrafficAll(
  metrics: NatsTrafficMetrics,
  source?: NatsTrafficMetricSource,
): NatsTrafficMetrics {
  if (!source) return createEmptyTrafficMetrics()

  const sourceMetrics = metrics.bySource[source] ?? { uploadBytes: 0, downloadBytes: 0 }
  const bySource = { ...metrics.bySource }
  delete bySource[source]

  return {
    uploadBytes: metrics.uploadBytes - sourceMetrics.uploadBytes,
    downloadBytes: metrics.downloadBytes - sourceMetrics.downloadBytes,
    bySource,
  }
}

function resetTrafficDirection(
  metrics: NatsTrafficMetrics,
  direction: NatsTrafficDirection,
  source?: NatsTrafficMetricSource,
): NatsTrafficMetrics {
  const key = direction === 'upload' ? 'uploadBytes' : 'downloadBytes'

  if (!source) {
    const bySource = Object.fromEntries(
      Object.entries(metrics.bySource).map(([sourceName, sourceMetrics]) => [
        sourceName,
        {
          ...sourceMetrics,
          [key]: 0,
        },
      ]),
    ) as NatsTrafficMetrics['bySource']

    return {
      ...metrics,
      [key]: 0,
      bySource,
    }
  }

  const sourceMetrics = metrics.bySource[source]
  if (!sourceMetrics) return metrics

  return {
    ...metrics,
    [key]: metrics[key] - sourceMetrics[key],
    bySource: {
      ...metrics.bySource,
      [source]: {
        ...sourceMetrics,
        [key]: 0,
      },
    },
  }
}

function normaliseByteCount(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) return 0
  return Math.floor(value)
}
