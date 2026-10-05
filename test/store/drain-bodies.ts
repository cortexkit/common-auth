export async function drainBodies(
  releases: Array<() => void>,
  bodies: Iterable<Promise<unknown>>,
  cleanup: () => void,
  operations: Iterable<Promise<unknown>> = [],
): Promise<void> {
  for (const release of releases) release()
  // A provider returning is not the end of a test: its body may still read
  // persisted state. Keep the scenario alive through those final reads.
  await Promise.allSettled(bodies)
  await Promise.allSettled(operations)
  cleanup()
}
