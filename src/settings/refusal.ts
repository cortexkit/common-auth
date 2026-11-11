export const SETTINGS_REFUSAL_CODES = Object.freeze([
  'settings-unparseable',
  'settings-newer-version',
  'settings-invalid-value',
  'settings-busy',
  'settings-unavailable',
] as const)

export type SettingsRefusalCode = (typeof SETTINGS_REFUSAL_CODES)[number]

export class SettingsRefusal extends Error {
  override readonly name = 'SettingsRefusal'

  constructor(
    readonly code: SettingsRefusalCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
