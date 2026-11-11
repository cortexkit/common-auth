export type ValueDescriptor =
  | { readonly kind: 'boolean' }
  | { readonly kind: 'integer'; readonly min?: number; readonly max?: number }
  | { readonly kind: 'number'; readonly min?: number; readonly max?: number }
  | { readonly kind: 'string' }
  | { readonly kind: 'oneOf'; readonly values: readonly string[] }
  | { readonly kind: 'list'; readonly item: ValueDescriptor }
  | {
      readonly kind: 'object'
      readonly fields: Readonly<Record<string, ValueDescriptor>>
    }
  | { readonly kind: 'record'; readonly value: ValueDescriptor }

type SettingsValue =
  | boolean
  | number
  | string
  | SettingsValue[]
  | { [key: string]: SettingsValue }

export type ValueOf<D extends ValueDescriptor> = ValueDescriptor extends D
  ? SettingsValue
  : D extends { kind: 'boolean' }
    ? boolean
    : D extends { kind: 'integer' | 'number' }
      ? number
      : D extends { kind: 'string' }
        ? string
        : D extends { kind: 'oneOf'; values: infer V extends readonly string[] }
          ? V[number]
          : D extends { kind: 'list'; item: infer I extends ValueDescriptor }
            ? ValueOf<I>[]
            : D extends {
                  kind: 'object'
                  fields: infer F extends Readonly<
                    Record<string, ValueDescriptor>
                  >
                }
              ? { -readonly [K in keyof F]: ValueOf<F[K]> }
              : D extends {
                    kind: 'record'
                    value: infer V extends ValueDescriptor
                  }
                ? Record<string, ValueOf<V>>
                : never

type Bounds = { readonly min?: number; readonly max?: number }

export function boolean() {
  return Object.freeze({ kind: 'boolean' } as const)
}

export function integer({ min, max }: Bounds = {}) {
  return Object.freeze({ kind: 'integer', min, max } as const)
}

export function number({ min, max }: Bounds = {}) {
  return Object.freeze({ kind: 'number', min, max } as const)
}

export function string() {
  return Object.freeze({ kind: 'string' } as const)
}

export function oneOf<const V extends readonly string[]>(values: V) {
  return Object.freeze({
    kind: 'oneOf',
    values: Object.freeze([...values]) as Readonly<V>,
  } as const)
}

export function list<const D extends ValueDescriptor>(item: D) {
  return deepFreeze({ kind: 'list', item } as const)
}

export function object<
  const F extends Readonly<Record<string, ValueDescriptor>>,
>(fields: F) {
  return deepFreeze({ kind: 'object', fields: { ...fields } } as const)
}

export function record<const D extends ValueDescriptor>(value: D) {
  return deepFreeze({ kind: 'record', value } as const)
}

/** Internal validation policy shared by file readers, updates and migration maps. */
export interface ValueValidationOptions {
  readonly completeObjects?: boolean
  readonly allowUnknownFields?: boolean
}

/** JSON objects exclude arrays and objects such as Date that serialize differently. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Missing fields can be filled from lower levels, but list and record objects must be complete. */
export function validateValue(
  descriptor: ValueDescriptor,
  value: unknown,
  options: ValueValidationOptions = {},
): boolean {
  switch (descriptor.kind) {
    case 'boolean':
      return typeof value === 'boolean'
    case 'integer':
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (descriptor.kind !== 'integer' || Number.isInteger(value)) &&
        (descriptor.min === undefined || value >= descriptor.min) &&
        (descriptor.max === undefined || value <= descriptor.max)
      )
    case 'string':
      return typeof value === 'string'
    case 'oneOf':
      return typeof value === 'string' && descriptor.values.includes(value)
    case 'list':
      return (
        Array.isArray(value) &&
        Array.from(value).every((item) =>
          validateValue(descriptor.item, item, {
            ...options,
            completeObjects: true,
          }),
        )
      )
    case 'object':
      return (
        isJsonObject(value) &&
        Object.entries(value).every(([key, field]) =>
          Object.hasOwn(descriptor.fields, key)
            ? validateValue(
                descriptor.fields[key] as ValueDescriptor,
                field,
                options,
              )
            : options.allowUnknownFields === true,
        ) &&
        (!options.completeObjects ||
          Object.keys(descriptor.fields).every((key) =>
            Object.hasOwn(value, key),
          ))
      )
    case 'record':
      return (
        isJsonObject(value) &&
        Object.values(value).every((item) =>
          validateValue(descriptor.value, item, {
            ...options,
            completeObjects: true,
          }),
        )
      )
  }
}

/** Internal helper; definitions and descriptor payloads are immutable at runtime. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}
