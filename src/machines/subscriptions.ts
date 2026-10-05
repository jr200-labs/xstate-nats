import { SubscriptionSyncResult } from '../actions/subscriptions'

type SubscriptionContext<Config, Subscription> = {
  subscriptionConfigs: Map<string, Config>
  subscriptions: Map<string, Subscription>
  syncRequired: number
  error?: Error
}

export function hasPendingSync({ context }: { context: { syncRequired: number } }) {
  return context.syncRequired > 0
}

export function updateSubscriptionTarget<Config>(
  context: { subscriptionConfigs: Map<string, Config>; syncRequired: number },
  key: string,
  config?: Config,
) {
  const subscriptionConfigs = new Map(context.subscriptionConfigs)
  if (config === undefined) subscriptionConfigs.delete(key)
  else subscriptionConfigs.set(key, config)
  return { subscriptionConfigs, syncRequired: context.syncRequired + 1 }
}

export function beginSubscriptionSync() {
  // One reconciliation covers the whole target snapshot. Changes arriving during
  // an asynchronous sync increment this marker and trigger another pass.
  return { syncRequired: 0, error: undefined }
}

export function finishSubscriptionSync<Subscription>(
  context: { syncRequired: number },
  result: SubscriptionSyncResult<Subscription>,
) {
  return {
    ...result,
    // Error states stop automatic retries; CONNECT must still retry failed work.
    syncRequired: result.error ? Math.max(context.syncRequired, 1) : context.syncRequired,
  }
}

export function detachSubscriptions<Config, Subscription>(
  context: SubscriptionContext<Config, Subscription>,
) {
  return {
    subscriptions: new Map<string, Subscription>(),
    syncRequired:
      context.subscriptionConfigs.size > 0
        ? Math.max(context.syncRequired, 1)
        : context.syncRequired,
  }
}
