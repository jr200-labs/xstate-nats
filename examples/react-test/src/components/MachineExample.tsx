import React, { useState } from 'react'
import { natsMachine, KvSubscriptionKey, parseNatsResult } from '@jr200/xstate-nats'
import { useActor, useSelector } from '@xstate/react'
import { KvEntry, KvStatus } from '@nats-io/kv'
import configContent from '/config.yaml.txt?raw'
import { format as prettyFormat } from 'pretty-format'
import yaml from 'js-yaml'

export const MachineExample = () => {
  const [state, send, actor] = useActor(natsMachine)
  const [subjectInput, setSubjectInput] = useState('test.hello')
  const [allMessages, setAllMessages] = useState<any[]>([])

  // Fix: Use useSelector to properly subscribe to child actor state changes
  const subjectRef = useSelector(actor, state => state.children.subject)
  const subjectState = useSelector(subjectRef, state => state)
  const kvRef = useSelector(actor, state => state.children.kv)
  const kvState = useSelector(kvRef, state => state)

  // Request-reply state
  const [requestPayload, setRequestPayload] = useState('{"message": "Hello, NATS!"}')

  // KV state
  const [kvBucket, setKvBucket] = useState('test-bucket')
  const [kvKey, setKvKey] = useState('test-key')
  const [kvValue, setKvValue] = useState('{"message": "Hello, NATS KV!"}')

  // Extract active subscriptions and received messages with better error handling
  const activeSubscriptions = subjectState?.context?.subscriptionConfigs
    ? Array.from<string>(subjectState.context.subscriptionConfigs.keys())
    : []

  const activeKvSubscriptions = kvState?.context?.subscriptionConfigs
    ? Array.from<string>(kvState.context.subscriptionConfigs.keys())
    : []

  const handleConfigure = async () => {
    try {
      const yamlConfig = yaml.load(configContent)
      send({ type: 'CONFIGURE', config: yamlConfig })
    } catch (error) {
      console.error('Failed to load config:', error)
    }
  }

  const handleSubscribe = () => {
    if (subjectInput.trim()) {
      const currentSubject = subjectInput.trim()
      send({
        type: 'SUBJECT.SUBSCRIBE',
        config: {
          subject: currentSubject,
          callback: data => {
            setAllMessages(prevMessages => [
              {
                type: 'SUBSCRIPTION',
                subject: currentSubject,
                payload: data,
                timestamp: Date.now(),
              },
              ...prevMessages,
            ])
          },
        },
      })
    }
  }

  const handleRequestReply = () => {
    if (subjectInput.trim() && requestPayload.trim()) {
      try {
        send({
          type: 'SUBJECT.REQUEST',
          subject: subjectInput.trim(),
          payload: requestPayload,
          callback: (reply: any) => {
            setAllMessages(prevMessages => [
              {
                type: 'REQUEST_REPLY',
                subject: subjectInput.trim(),
                request: requestPayload,
                reply,
                timestamp: Date.now(),
              },
              ...prevMessages,
            ])
          },
        })
      } catch (error) {
        console.error('Invalid JSON payload:', error)
        alert('Invalid JSON payload. Please check your input.')
      }
    }
  }

  const handlePublish = () => {
    if (subjectInput.trim() && requestPayload.trim()) {
      try {
        send({
          type: 'SUBJECT.PUBLISH',
          subject: subjectInput.trim(),
          payload: requestPayload,
          onPublishResult: (result: { ok: true } | { ok: false; error: Error }) => {
            setAllMessages(prevMessages => [
              {
                type: 'PUBLISH',
                subject: subjectInput.trim(),
                payload: requestPayload,
                result,
                timestamp: Date.now(),
              },
              ...prevMessages,
            ])
          },
        })
      } catch (error) {
        console.error('Invalid JSON payload:', error)
        alert('Invalid JSON payload. Please check your input.')
      }
    }
  }

  const handleUnsubscribeAll = () => {
    send({ type: 'SUBJECT.UNSUBSCRIBE_ALL' })
  }

  const handleUnsubscribeOne = (subject: string) => {
    send({
      type: 'SUBJECT.UNSUBSCRIBE',
      subject,
    })
  }

  const handleClearAllMessages = () => {
    setAllMessages([])
  }

  const handleKvPut = () => {
    if (kvBucket.trim() && kvKey.trim() && kvValue.trim()) {
      try {
        send({
          type: 'KV.PUT',
          bucket: kvBucket.trim(),
          key: kvKey.trim(),
          value: kvValue.trim(),
          onResult: (result: { ok: true } | { ok: false } | { error: Error }) => {
            setAllMessages(prevMessages => [
              {
                type: 'KV_PUT',
                bucket: kvBucket.trim(),
                key: kvKey.trim(),
                value: kvValue.trim(),
                result,
                timestamp: Date.now(),
              },
              ...prevMessages,
            ])
          },
        })
      } catch (error) {
        console.error('Invalid JSON value:', error)
        alert('Invalid JSON value. Please check your input.')
      }
    }
  }

  const handleKvGet = () => {
    if (kvBucket.trim() && kvKey.trim()) {
      send({
        type: 'KV.GET',
        bucket: kvBucket.trim(),
        key: kvKey.trim(),
        onResult: (result: KvEntry | null | { error: Error }) => {
          if (!result) {
            return
          }

          if ('error' in result) {
            setAllMessages(prevMessages => [
              {
                type: 'KV_GET',
                bucket: kvBucket.trim(),
                key: kvKey.trim(),
                result: { error: result.error },
                timestamp: Date.now(),
              },
              ...prevMessages,
            ])
            return
          }

          const data = parseNatsResult(result)
          setAllMessages(prevMessages => [
            {
              type: 'KV_GET',
              bucket: result.bucket,
              key: result.key,
              value: data,
              result: { ok: true },
              timestamp: Date.now(),
            },
            ...prevMessages,
          ])
        },
      })
    }
  }

  const handleKvDelete = () => {
    if (kvBucket.trim() && kvKey.trim()) {
      send({
        type: 'KV.DELETE',
        bucket: kvBucket.trim(),
        key: kvKey.trim(),
        onResult: (result: { ok: true } | { ok: false } | { error: Error }) => {
          setAllMessages(prevMessages => [
            {
              type: 'KV_DELETE',
              bucket: kvBucket.trim(),
              key: kvKey.trim(),
              result,
              timestamp: Date.now(),
            },
            ...prevMessages,
          ])
        },
      })
    }
  }

  const handleKvBucketCreate = () => {
    if (kvBucket.trim()) {
      send({
        type: 'KV.BUCKET_CREATE',
        bucket: kvBucket.trim(),
        onResult: (result: { ok: true } | { ok: false } | { error: Error }) => {
          setAllMessages(prevMessages => [
            {
              type: 'KV_BUCKET_CREATE',
              bucket: kvBucket.trim(),
              result,
              timestamp: Date.now(),
            },
            ...prevMessages,
          ])
        },
      })
    }
  }

  const handleKvBucketDelete = () => {
    if (kvBucket.trim()) {
      send({
        type: 'KV.BUCKET_DELETE',
        bucket: kvBucket.trim(),
        onResult: (result: { ok: true } | { ok: false } | { error: Error }) => {
          setAllMessages(prevMessages => [
            {
              type: 'KV_BUCKET_DELETE',
              bucket: kvBucket.trim(),
              result,
              timestamp: Date.now(),
            },
            ...prevMessages,
          ])
        },
      })
    }
  }

  const handleKvBucketList = () => {
    send({
      type: 'KV.BUCKET_LIST',
      onResult: (result: KvStatus[] | string[] | { error: Error }) => {
        // Check if result is an error object first
        if ('error' in result) {
          setAllMessages(prevMessages => [
            {
              type: 'KV_BUCKET_LIST',
              result: { error: result.error },
              timestamp: Date.now(),
            },
            ...prevMessages,
          ])
          return
        }

        // Now we know result is an array (KvStatus[] | string[])
        const newItems = result.map((item: KvStatus | string) => {
          if (typeof item === 'string') {
            return {
              type: 'KV_BUCKET_LIST',
              bucket: item,
              result: { ok: true },
              timestamp: Date.now(),
            }
          } else {
            return {
              type: 'KV_BUCKET_LIST',
              bucket: item.bucket,
              result: { ok: true },
              value: {
                description: item.description,
                values: item.values || 0,
                size: item.size || 0,
              },
              timestamp: Date.now(),
            }
          }
        })

        setAllMessages(prevMessages => [...newItems, ...prevMessages])
      },
    })
  }

  const handleKvSubscribe = () => {
    if (kvBucket.trim() && kvKey.trim()) {
      const bucket = kvBucket.trim()
      const key = kvKey.trim()

      send({
        type: 'KV.SUBSCRIBE',
        config: {
          bucket,
          key,
          callback: (data: any) => {
            setAllMessages(prevMessages => [
              {
                type: 'KV_SUBSCRIPTION',
                bucket,
                key,
                value: data,
                result: { ok: true },
                timestamp: Date.now(),
              },
              ...prevMessages,
            ])
          },
        },
      })
    }
  }

  const handleKvUnsubscribe = (bucket: string, key: string) => {
    if (bucket.trim() && key.trim()) {
      send({
        type: 'KV.UNSUBSCRIBE',
        bucket,
        key,
      })
    }
  }

  const handleKvUnsubscribeAll = () => {
    send({
      type: 'KV.UNSUBSCRIBE_ALL',
    })
  }

  const isConnected = state.matches('connected')
  const canSubscribe = isConnected && subjectInput.trim().length > 0
  const hasSubscriptions = activeSubscriptions.length > 0
  const canRequestReply = isConnected && subjectInput.trim().length > 0 && requestPayload.trim().length > 0
  const canPublish = isConnected && subjectInput.trim().length > 0 && requestPayload.trim().length > 0
  const canKvPut = isConnected && kvBucket.trim().length > 0 && kvKey.trim().length > 0 && kvValue.trim().length > 0
  const canKvGet = isConnected && kvBucket.trim().length > 0 && kvKey.trim().length > 0
  const canKvDelete = isConnected && kvBucket.trim().length > 0 && kvKey.trim().length > 0
  const canKvBucketCreate = isConnected && kvBucket.trim().length > 0
  const canKvBucketDelete = isConnected && kvBucket.trim().length > 0
  const canKvBucketList = isConnected
  const canKvSubscribe = isConnected && kvBucket.trim().length > 0 && kvKey.trim().length > 0
  const canKvUnsubscribe = isConnected && kvBucket.trim().length > 0 && kvKey.trim().length > 0
  const canKvUnsubscribeAll = isConnected

  return (
    <div className='min-h-screen bg-gray-50 flex'>
      {/* Main content area */}
      <div className='flex-1 p-4 mr-96'>
        <div className='mb-8'>
          {/* Canvas at the top */}
          <div className='flex justify-center gap-4 bg-white rounded-xl shadow-lg p-4 border border-gray-200'>
            <button
              onClick={handleConfigure}
              disabled={!state.can({ type: 'CONFIGURE', config: { opts: {}, maxRetries: 0 } })}
              className='bg-green-600 hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-lg shadow-md transition-colors duration-200'
            >
              Configure
            </button>
            <button
              onClick={() => send({ type: 'CONNECT' })}
              disabled={!state.can({ type: 'CONNECT' })}
              className='bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-lg shadow-md transition-colors duration-200'
            >
              Connect to NATS
            </button>
            <button
              onClick={() => send({ type: 'DISCONNECT' })}
              disabled={!state.can({ type: 'DISCONNECT' })}
              className='bg-red-600 hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-lg shadow-md transition-colors duration-200'
            >
              Disconnect
            </button>
            <button
              onClick={() => send({ type: 'RESET' })}
              disabled={!state.can({ type: 'RESET' })}
              className='bg-gray-600 hover:bg-gray-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-lg shadow-md transition-colors duration-200'
            >
              Reset
            </button>
          </div>
        </div>

        {/* Subscription + Request-Reply Controls Side by Side */}
        <div className='grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8'>
          {/* Left Panel - Active Subscriptions + Messages & Results */}
          <div className='bg-white rounded-xl shadow-lg p-4 border border-gray-200 flex flex-col gap-8'>
            {/* Active Subscriptions */}
            <div>
              <h3 className='text-lg font-semibold text-gray-800 mb-3'>Active Subscriptions</h3>
              {activeSubscriptions.length + activeKvSubscriptions.length === 0 ? (
                <div className='text-gray-500 text-center py-8'>No active subscriptions</div>
              ) : (
                <div className='space-y-2'>
                  {activeSubscriptions.map(subject => (
                    <div key={subject} className='flex items-center justify-between bg-gray-50 p-3 rounded-lg'>
                      <span className='font-mono text-sm text-gray-700'>{subject}</span>
                      <button
                        onClick={() => handleUnsubscribeOne(subject)}
                        className='text-red-600 hover:text-red-800 hover:bg-red-50 p-1 rounded transition-colors duration-200'
                        title='Unsubscribe from this subject'
                      >
                        <svg className='w-5 h-5' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                          <path strokeLinecap='round' strokeLinejoin='round' strokeWidth={2} d='M6 18L18 6M6 6l12 12' />
                        </svg>
                      </button>
                    </div>
                  ))}

                  <div className='space-y-2 max-h-32 overflow-auto'>
                    {activeKvSubscriptions.map((item, index) => {
                      const sub = KvSubscriptionKey.fromKey<string, string>(item)
                      return (
                        <div
                          key={`kv-sub-${index}`}
                          className='flex items-center justify-between bg-indigo-50 p-2 rounded-lg'
                        >
                          <span className='font-mono text-sm text-indigo-700'>
                            {sub.x} / {sub.y}
                          </span>
                          <button
                            onClick={() => {
                              handleKvUnsubscribe(sub.x, sub.y)
                            }}
                            className='text-red-600 hover:text-red-800 hover:bg-red-50 p-1 rounded transition-colors duration-200'
                            title='Unsubscribe from this KV subscription'
                          >
                            <svg className='w-4 h-4' fill='none' stroke='currentColor' viewBox='0 0 24 24'>
                              <path
                                strokeLinecap='round'
                                strokeLinejoin='round'
                                strokeWidth={2}
                                d='M6 18L18 6M6 6l12 12'
                              />
                            </svg>
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Messages */}
            <div>
              <div className='flex items-center justify-between mb-3'>
                <h3 className='text-lg font-semibold text-gray-800'>All Messages</h3>
                <button
                  onClick={handleClearAllMessages}
                  disabled={allMessages.length === 0}
                  className='bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-semibold py-1 px-3 rounded text-sm transition-colors duration-200'
                >
                  Clear Messages
                </button>
              </div>
              {allMessages.length === 0 ? (
                <div className='text-gray-500 text-center py-8'>No messages</div>
              ) : (
                <div className='space-y-4 max-h-96 overflow-auto'>
                  {allMessages.map((message, index) => {
                    const getMessageStyle = (type: string) => {
                      switch (type) {
                        case 'SUBSCRIPTION':
                          return 'bg-blue-50 border-l-4 border-blue-400'
                        case 'REQUEST_REPLY':
                          return 'bg-purple-50 border-l-4 border-purple-400'
                        case 'PUBLISH':
                          return 'bg-green-50 border-l-4 border-green-400'
                        default:
                          return 'bg-indigo-50 border-l-4 border-indigo-400'
                      }
                    }

                    const getTypeLabel = (type: string) => {
                      switch (type) {
                        case 'SUBSCRIPTION':
                          return 'SUBSCRIPTION'
                        case 'REQUEST_REPLY':
                          return 'REQUEST-REPLY'
                        case 'PUBLISH':
                          return 'PUBLISH'
                        case 'KV_PUT':
                          return 'KV PUT'
                        case 'KV_GET':
                          return 'KV GET'
                        case 'KV_DELETE':
                          return 'KV DELETE'
                        case 'KV_BUCKET_CREATE':
                          return 'KV BUCKET CREATE'
                        case 'KV_BUCKET_DELETE':
                          return 'KV BUCKET DELETE'
                        case 'KV_BUCKET_LIST':
                          return 'KV BUCKET LIST'
                        case 'KV_SUBSCRIPTION':
                          return 'KV SUBSCRIPTION'
                        default:
                          return type
                      }
                    }

                    const getTypeColor = (type: string) => {
                      switch (type) {
                        case 'SUBSCRIPTION':
                          return 'text-blue-600 bg-blue-100'
                        case 'REQUEST_REPLY':
                          return 'text-purple-600 bg-purple-100'
                        case 'PUBLISH':
                          return 'text-green-600 bg-green-100'
                        default:
                          return 'text-indigo-600 bg-indigo-100'
                      }
                    }

                    return (
                      <div key={`message-${index}`} className={`${getMessageStyle(message.type)} p-4 rounded-lg`}>
                        <div className='flex items-center justify-between mb-3'>
                          <div className='flex items-center gap-2'>
                            {message.subject && (
                              <span className='font-mono text-sm text-gray-600 bg-gray-100 px-2 py-1 rounded'>
                                {message.subject}
                              </span>
                            )}
                            {message.bucket && (
                              <span className='font-mono text-sm text-gray-600 bg-gray-100 px-2 py-1 rounded'>
                                {message.bucket}
                                {message.key ? ` / ${message.key}` : ''}
                              </span>
                            )}
                            <span className={`text-xs px-2 py-1 rounded font-medium ${getTypeColor(message.type)}`}>
                              {getTypeLabel(message.type)}
                            </span>
                          </div>
                          <span className='text-xs text-gray-500'>
                            {new Date(message.timestamp).toLocaleTimeString()}
                          </span>
                        </div>

                        {/* Message content based on type */}
                        {message.type === 'SUBSCRIPTION' && (
                          <div>
                            <h4 className='text-sm font-semibold text-gray-700 mb-2'>Message:</h4>
                            <pre className='text-xs text-gray-700 bg-white p-2 rounded border whitespace-pre-wrap overflow-auto'>
                              {typeof message.payload === 'string'
                                ? message.payload
                                : JSON.stringify(message.payload, null, 2)}
                            </pre>
                          </div>
                        )}

                        {message.type === 'REQUEST_REPLY' && (
                          <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
                            <div>
                              <h4 className='text-sm font-semibold text-gray-700 mb-2'>Request:</h4>
                              <pre className='text-xs text-gray-700 bg-white p-2 rounded border whitespace-pre-wrap overflow-auto'>
                                {JSON.stringify(message.request, null, 2)}
                              </pre>
                            </div>
                            <div>
                              <h4 className='text-sm font-semibold text-gray-700 mb-2'>Reply:</h4>
                              <pre className='text-xs text-gray-700 bg-white p-2 rounded border whitespace-pre-wrap overflow-auto'>
                                {typeof message.reply === 'string'
                                  ? message.reply
                                  : JSON.stringify(message.reply, null, 2)}
                              </pre>
                            </div>
                          </div>
                        )}

                        {message.type === 'PUBLISH' && (
                          <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
                            <div>
                              <h4 className='text-sm font-semibold text-gray-700 mb-2'>Payload:</h4>
                              <pre className='text-xs text-gray-700 bg-white p-2 rounded border whitespace-pre-wrap overflow-auto'>
                                {JSON.stringify(message.payload, null, 2)}
                              </pre>
                            </div>
                            <div>
                              <h4 className='text-sm font-semibold text-gray-700 mb-2'>Result:</h4>
                              <pre className='text-xs text-gray-700 bg-white p-2 rounded border whitespace-pre-wrap overflow-auto'>
                                {message.result.ok ? (
                                  <span className='text-green-600'>✓ Published successfully</span>
                                ) : (
                                  <span className='text-red-600'>✗ Error: {message.result.error?.message}</span>
                                )}
                              </pre>
                            </div>
                          </div>
                        )}

                        {/* KV Operations */}
                        {message.type.startsWith('KV_') && (
                          <div>
                            <pre className='text-xs text-gray-700 bg-white p-2 rounded border whitespace-pre-wrap overflow-auto'>
                              {JSON.stringify(message.result, null, 2)}
                            </pre>
                            {message.value && (
                              <>
                                <div className='text-xs text-gray-500 mt-1'>Value:</div>
                                <pre className='text-xs text-gray-700 bg-white p-2 rounded border whitespace-pre-wrap overflow-auto'>
                                  {JSON.stringify(message.value, null, 2)}
                                </pre>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Right Panel - Combined Controls */}
          <div className='bg-white rounded-xl shadow-lg p-4 border border-gray-200 flex flex-col gap-8'>
            {/* Subscription Controls */}
            <div>
              <h3 className='text-lg font-semibold text-gray-800 mb-4'>Subject Controls</h3>
              <div className='flex flex-col gap-4'>
                <div>
                  <label htmlFor='subject-input' className='block text-sm font-medium text-gray-700 mb-2'>
                    Subject
                  </label>
                  <input
                    id='subject-input'
                    type='text'
                    value={subjectInput}
                    onChange={e => setSubjectInput(e.target.value)}
                    placeholder='Enter NATS subject (e.g., test.hello)'
                    className='w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
                    disabled={!isConnected}
                  />
                </div>
                <div>
                  <label htmlFor='request-payload' className='block text-sm font-medium text-gray-700 mb-2'>
                    Payload (JSON)
                  </label>
                  <textarea
                    id='request-payload'
                    value={requestPayload}
                    onChange={e => setRequestPayload(e.target.value)}
                    placeholder='Enter JSON payload'
                    rows={3}
                    className='w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm'
                    disabled={!isConnected}
                  />
                </div>
                <div className='flex gap-2'>
                  <button
                    onClick={handleSubscribe}
                    disabled={!canSubscribe}
                    className='bg-green-600 hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded-lg shadow-md transition-colors duration-200'
                  >
                    Subscribe
                  </button>
                  <button
                    onClick={handlePublish}
                    disabled={!canPublish}
                    className='bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded-lg shadow-md transition-colors duration-200'
                  >
                    Publish
                  </button>
                  <button
                    onClick={handleRequestReply}
                    disabled={!canRequestReply}
                    className='bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded-lg shadow-md transition-colors duration-200'
                  >
                    Send Request
                  </button>
                  <div className='flex gap-8' />
                  <button
                    onClick={handleUnsubscribeAll}
                    disabled={!hasSubscriptions}
                    className='bg-red-600 hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded-lg shadow-md transition-colors duration-200'
                  >
                    Unsubscribe All
                  </button>
                </div>
              </div>
            </div>

            <h3 className='text-lg font-semibold text-gray-800 mb-4'>KV (Key-Value) Panel</h3>
            <div className='flex flex-col gap-4'>
              <div>
                <label htmlFor='kv-bucket' className='block text-sm font-medium text-gray-700 mb-2'>
                  Bucket
                </label>
                <input
                  id='kv-bucket'
                  type='text'
                  value={kvBucket}
                  onChange={e => setKvBucket(e.target.value)}
                  placeholder='Enter bucket name'
                  className='w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
                  disabled={!isConnected}
                />
              </div>
              <div>
                <label htmlFor='kv-key' className='block text-sm font-medium text-gray-700 mb-2'>
                  Key
                </label>
                <input
                  id='kv-key'
                  type='text'
                  value={kvKey}
                  onChange={e => setKvKey(e.target.value)}
                  placeholder='Enter key'
                  className='w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
                  disabled={!isConnected}
                />
              </div>
              <div>
                <label htmlFor='kv-value' className='block text-sm font-medium text-gray-700 mb-2'>
                  Value (JSON)
                </label>
                <textarea
                  id='kv-value'
                  value={kvValue}
                  onChange={e => setKvValue(e.target.value)}
                  placeholder='Enter JSON value'
                  rows={2}
                  className='w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm'
                  disabled={!isConnected}
                />
              </div>
              <div className='flex gap-2 flex-wrap'>
                <button
                  onClick={handleKvBucketCreate}
                  disabled={!canKvBucketCreate}
                  className='bg-purple-600 hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded-lg shadow-md transition-colors duration-200'
                >
                  Create Bucket
                </button>
                <button
                  onClick={handleKvBucketDelete}
                  disabled={!canKvBucketDelete}
                  className='bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded-lg shadow-md transition-colors duration-200'
                >
                  Delete Bucket
                </button>
                <button
                  onClick={handleKvBucketList}
                  disabled={!isConnected}
                  className='bg-gray-600 hover:bg-gray-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded-lg shadow-md transition-colors duration-200'
                >
                  List Buckets
                </button>
                <button
                  onClick={handleKvPut}
                  disabled={!canKvPut}
                  className='bg-green-600 hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded-lg shadow-md transition-colors duration-200'
                >
                  KV Put
                </button>
                <button
                  onClick={handleKvGet}
                  disabled={!canKvGet}
                  className='bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded-lg shadow-md transition-colors duration-200'
                >
                  KV Get
                </button>
                <button
                  onClick={handleKvDelete}
                  disabled={!canKvDelete}
                  className='bg-red-600 hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded-lg shadow-md transition-colors duration-200'
                >
                  KV Delete
                </button>
                <button
                  onClick={handleKvSubscribe}
                  disabled={!canKvSubscribe}
                  className='bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded-lg shadow-md transition-colors duration-200'
                >
                  Subscribe
                </button>
                <button
                  onClick={() => handleKvUnsubscribe(kvBucket, kvKey)}
                  disabled={!canKvUnsubscribe}
                  className='bg-orange-600 hover:bg-orange-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded-lg shadow-md transition-colors duration-200'
                >
                  Unsubscribe
                </button>
                <button
                  onClick={handleKvUnsubscribeAll}
                  disabled={!canKvUnsubscribeAll}
                  className='bg-red-600 hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded-lg shadow-md transition-colors duration-200'
                >
                  Unsubscribe All
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right side - Combined State Panel */}
        <div className='h-screen w-96 bg-white shadow-lg border-l border-gray-200 p-4 overflow-y-auto fixed right-0 top-0 flex flex-col z-20'>
          <h3 className='text-lg font-semibold text-gray-800 mb-4 sticky top-0 bg-white'>System State</h3>
          <div className='bg-gray-100 text-red-500 p-3 rounded-lg font-mono text-sm'>
            <pre>{state.value}</pre>
          </div>

          {/* Main State */}
          <div className='mb-6 mt-3'>
            <h4 className='text-md font-semibold text-gray-700 mb-2'>Root State</h4>
            <div className='bg-gray-50 p-3 rounded-lg'>
              <pre className='text-xs text-gray-700 whitespace-pre-wrap overflow-auto max-h-48'>
                {prettyFormat(state)}
              </pre>
            </div>
          </div>

          {/* Subject State */}
          <div className='mb-6'>
            <h4 className='text-md font-semibold text-gray-700 mb-2'>Subject State</h4>
            <div className='bg-gray-50 p-3 rounded-lg'>
              <pre className='text-xs text-gray-700 whitespace-pre-wrap overflow-auto max-h-48'>
                {prettyFormat(subjectState)}
              </pre>
            </div>
          </div>

          {/* KV State */}
          <div>
            <h4 className='text-md font-semibold text-gray-700 mb-2'>KV State</h4>
            <div className='bg-gray-50 p-3 rounded-lg'>
              <pre className='text-xs text-gray-700 whitespace-pre-wrap overflow-auto max-h-48'>
                {prettyFormat(kvState)}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
