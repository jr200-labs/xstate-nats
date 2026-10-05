/** Shared reconciliation policy; adapters retain their own setup timing and callbacks. */
export type SubscriptionSyncResult<Subscription> = {
  subscriptions: Map<string, Subscription>
  error?: Error
}

type Adapter<Config, Subscription, Created> = {
  create: (key: string, config: Config) => Created
  dispose: (subscription: Subscription) => void
}

function plan<Config, Subscription>(
  current: Map<string, Subscription>,
  target: Map<string, Config>,
  dispose: (subscription: Subscription) => void,
) {
  const subscriptions = new Map(current)
  const errors: Error[] = []
  const fail = (key: string, cause: unknown) => {
    errors.push(new Error(`Subscription sync failed for "${key}"`, { cause }))
  }
  for (const [key, subscription] of current) {
    if (target.has(key)) continue
    try {
      dispose(subscription)
      subscriptions.delete(key)
    } catch (cause) {
      // Retain the handle so a failed removal can be retried.
      fail(key, cause)
    }
  }
  return {
    subscriptions,
    additions: [...target].filter(([key]) => !current.has(key)),
    fail,
    result: (): SubscriptionSyncResult<Subscription> => ({
      subscriptions,
      error: errors.length ? new AggregateError(errors, 'Subscription sync failed') : undefined,
    }),
  }
}

export function reconcileSubscriptions<Config, Subscription>(
  current: Map<string, Subscription>,
  target: Map<string, Config>,
  adapter: Adapter<Config, Subscription, Subscription>,
): SubscriptionSyncResult<Subscription> {
  const sync = plan(current, target, adapter.dispose)
  for (const [key, config] of sync.additions) {
    try {
      sync.subscriptions.set(key, adapter.create(key, config))
    } catch (cause) {
      sync.fail(key, cause)
    }
  }
  return sync.result()
}

export async function reconcileSubscriptionsAsync<Config, Subscription>(
  current: Map<string, Subscription>,
  target: Map<string, Config>,
  adapter: Adapter<Config, Subscription, Promise<Subscription>>,
): Promise<SubscriptionSyncResult<Subscription>> {
  const sync = plan(current, target, adapter.dispose)
  for (const [key, config] of sync.additions) {
    try {
      sync.subscriptions.set(key, await adapter.create(key, config))
    } catch (cause) {
      sync.fail(key, cause)
    }
  }
  return sync.result()
}
