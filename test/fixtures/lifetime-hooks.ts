import { afterAll, afterEach, beforeEach, it, test } from 'bun:test'
import { TestLifetime } from './test-lifetime.js'

/** Create once in each file so hooks and ownership remain scoped to that file. */
export function lifetimeHooks() {
  let lifetime = new TestLifetime()
  beforeEach(async () => {
    // When a file has setup but no cleanup, wait for the previous test body to
    // finish before the next setup replaces shared state.
    await lifetime.drain(() => {})
    lifetime = new TestLifetime()
  })
  afterAll(() => lifetime.drain(() => {}))

  function registrar<T extends typeof test>(register: T, owner?: unknown): T {
    return new Proxy(register, {
      apply: (target, receiver, args: unknown[]) => {
        const body = args[1]
        if (typeof body === 'function') {
          args[1] = (...values: unknown[]) =>
            lifetime.tracked(() => {
              if (body.length <= values.length)
                return Reflect.apply(body, undefined, values)
              return new Promise<void>((resolve, reject) => {
                Reflect.apply(body, undefined, [
                  ...values,
                  (error?: unknown) =>
                    error === undefined ? resolve() : reject(error),
                ])
              })
            })
        }
        return Reflect.apply(target, owner ?? receiver, args)
      },
      get: (target, key, receiver) => {
        const value: unknown = Reflect.get(target, key, receiver)
        if (
          ['each', 'skipIf', 'todoIf', 'if'].includes(String(key)) &&
          typeof value === 'function'
        )
          return (...args: unknown[]) =>
            registrar(Reflect.apply(value, target, args) as typeof test)
        return typeof value === 'function'
          ? registrar(value as typeof test, target)
          : value
      },
    })
  }

  function hook(body: Parameters<typeof afterEach>[0]): Promise<unknown> {
    if (body.length === 0)
      return Promise.resolve().then(() => Reflect.apply(body, undefined, []))
    return new Promise<void>((resolve, reject) => {
      Reflect.apply(body, undefined, [
        (error?: unknown) => (error === undefined ? resolve() : reject(error)),
      ])
    })
  }

  return {
    it: registrar(it),
    test: registrar(test),
    afterEach: ((body, timeout) =>
      afterEach(
        () => lifetime.drain(() => hook(body)),
        timeout,
      )) as typeof afterEach,
    afterAll: ((body, timeout) =>
      afterAll(
        () => lifetime.drain(() => hook(body)),
        timeout,
      )) as typeof afterAll,
    get lifetime() {
      return lifetime
    },
  }
}
