export function routingHandle(
  sessionId: string,
): Record<string, unknown> | undefined {
  // The bridge can load after the auth plugin, so never cache the accessor.
  const routing: unknown = Reflect.get(
    globalThis,
    Symbol.for('cortexkit.routing'),
  )
  if (typeof routing !== 'function') return undefined
  const handle: unknown = routing(sessionId)
  return typeof handle === 'object' && handle !== null
    ? (handle as Record<string, unknown>)
    : undefined
}
