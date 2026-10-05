import { describe, expect, it, vi } from 'vitest'
import { reconcileSubscriptions, reconcileSubscriptionsAsync } from './subscriptions'

// Both adapters must implement the same partial-success and retry policy.
for (const mode of ['sync', 'async'] as const) {
  describe(`${mode} subscription reconciliation`, () => {
    const reconcile = async (
      current: Map<string, object>,
      target: Map<string, string>,
      create: (key: string, config: string) => object,
      dispose: (subscription: object) => void,
    ) =>
      mode === 'sync'
        ? reconcileSubscriptions(current, target, { create, dispose })
        : reconcileSubscriptionsAsync(current, target, {
            create: async (key, config) => create(key, config),
            dispose,
          })

    it('keeps partial success and retries only missing subscriptions', async () => {
      const first = {}
      const second = {}
      const failure = new Error('creation failed')
      const target = new Map([
        ['first', 'config1'],
        ['second', 'config2'],
      ])
      const create = vi.fn((key: string) => {
        if (key === 'second') throw failure
        return first
      })
      const dispose = vi.fn()
      const failed = await reconcile(new Map(), target, create, dispose)
      expect(failed.subscriptions.get('first')).toBe(first)
      expect(failed.subscriptions.has('second')).toBe(false)
      expect(failed.error).toBeInstanceOf(AggregateError)
      expect((failed.error as AggregateError).errors[0].cause).toBe(failure)
      create.mockClear().mockReturnValue(second)
      const recovered = await reconcile(failed.subscriptions, target, create, dispose)
      expect(create).toHaveBeenCalledExactlyOnceWith('second', 'config2')
      expect(recovered.subscriptions.get('first')).toBe(first)
      expect(recovered.subscriptions.get('second')).toBe(second)
      expect(recovered.error).toBeUndefined()
      expect(dispose).not.toHaveBeenCalled()
      expect(target.size).toBe(2)
    })

    it('retains failed removals for retry while completing independent work', async () => {
      const removed = {}
      const failedRemoval = {}
      const added = {}
      const current = new Map([
        ['remove', removed],
        ['retry', failedRemoval],
      ])
      const target = new Map([['new', 'config']])
      const failure = new Error('disposal failed')
      const dispose = vi.fn((subscription: object) => {
        if (subscription === failedRemoval) throw failure
      })
      const create = vi.fn(() => added)
      const failed = await reconcile(current, target, create, dispose)
      expect(failed.subscriptions.has('remove')).toBe(false)
      expect(failed.subscriptions.get('retry')).toBe(failedRemoval)
      expect(failed.subscriptions.get('new')).toBe(added)
      expect((failed.error as AggregateError).errors[0].cause).toBe(failure)
      expect(current.size).toBe(2)
      create.mockClear()
      dispose.mockClear().mockImplementation(() => {})
      const recovered = await reconcile(failed.subscriptions, target, create, dispose)
      expect(dispose).toHaveBeenCalledExactlyOnceWith(failedRemoval)
      expect(create).not.toHaveBeenCalled()
      expect([...recovered.subscriptions.keys()]).toEqual(['new'])
      expect(recovered.error).toBeUndefined()
    })
  })
}
