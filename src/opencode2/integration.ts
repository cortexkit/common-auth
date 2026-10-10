import type { Credential, Plugin } from '@opencode/plugin'
import type {
  IntegrationOAuthAuthorization,
  IntegrationOAuthMethod,
  IntegrationOAuthMethodRegistration,
} from '@opencode/plugin/promise/integration'
import type { Registration } from '@opencode/plugin/promise/registration'

/** The host's form answer handed to `authorize`. */
export type FormAnswer = Parameters<
  IntegrationOAuthMethodRegistration['authorize']
>[0]

/**
 * Prefix of every placeholder secret. No provider issues tokens of this
 * shape, so a placeholder that escaped to the wire is refused by the
 * provider and recognisable in any log.
 */
export const PLACEHOLDER_PREFIX = 'common-auth-placeholder'

/** How long a placeholder claims to be valid; refresh simply issues another. */
export const PLACEHOLDER_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000

/** Metadata key marking a host credential as a placeholder. */
export const PLACEHOLDER_METADATA_KEY = 'commonAuthPlaceholder'

/** The non-routable secret the host holds for an integration. */
export function placeholderSecret(integrationID: string): string {
  return `${PLACEHOLDER_PREFIX}.${integrationID}`
}

/**
 * The credential the host stores for an integration whose real accounts live
 * in the plugin's pool. It keeps the provider catalogued and usable in the
 * host, and carries nothing that works against the provider.
 */
export function placeholderCredential(input: {
  integrationID: string
  methodID: string
  now: number
}): Credential.OAuth {
  const secret = placeholderSecret(input.integrationID)
  return {
    type: 'oauth',
    methodID: input.methodID as Credential.OAuth['methodID'],
    access: secret,
    refresh: secret,
    expires: input.now + PLACEHOLDER_LIFETIME_MS,
    metadata: { [PLACEHOLDER_METADATA_KEY]: true },
  }
}

/** Whether a host credential is a placeholder (for any integration, or the one named). */
export function isPlaceholderCredential(
  value: Credential.Value | undefined,
  integrationID?: string,
): boolean {
  if (value?.type !== 'oauth') return false
  const expected =
    integrationID === undefined ? undefined : placeholderSecret(integrationID)
  const matches = (secret: string) =>
    expected === undefined
      ? secret.startsWith(`${PLACEHOLDER_PREFIX}.`)
      : secret === expected
  return matches(value.access) && matches(value.refresh)
}

/**
 * The plugin's half of an OAuth login. It has the same shape as the host's
 * authorization, except that `callback` resolves to the plugin's own login
 * result instead of a host credential.
 */
export type PoolAuthorization<T> = {
  readonly url: string
  readonly instructions: string
  readonly expiresAt?: number
} & (
  | { readonly mode: 'auto'; readonly callback: Promise<T> }
  | {
      readonly mode: 'code'
      readonly callback: (code: string) => Promise<T>
    }
)

export interface PoolLoginMethod<T> {
  readonly method: IntegrationOAuthMethod
  authorize(answer: FormAnswer): Promise<PoolAuthorization<T>>
}

/** What `activate` and `onLogin` are told about the login they serve. */
export interface LoginContext {
  readonly integrationID: string
  readonly methodID: string
}

/**
 * Shown by `opencode auth login` when the vault method starts. The host has no
 * page to open for this method, so the text only says what happens instead.
 */
export const VAULT_ACTIVATION_INSTRUCTIONS =
  'No browser sign-in: this connects the plugin to the accounts in its vault.'

/**
 * A login method for a host whose accounts all come from a vault. Choosing it
 * signs in to nothing and writes nothing to the plugin's pool: once
 * `activate` resolves, the host only receives this integration's placeholder,
 * which marks later requests as the plugin's to serve from the vault.
 */
export interface VaultActivationMethod {
  /** Must not share an ID with any of the pool login methods. */
  readonly method: IntegrationOAuthMethod
  /**
   * Confirms the host may use this method, normally by checking that
   * `enrollmentAuthority` reports `'vault'`. Throw to refuse: the host shows
   * the error's message and stores nothing, so it must be a fixed text that
   * carries no credential.
   */
  activate(context: LoginContext): Promise<void> | void
  /** Replaces `VAULT_ACTIVATION_INSTRUCTIONS`. */
  readonly instructions?: string
}

export interface RegisterOpenCode2AuthMethodsOptions<T> {
  readonly integrationID: string
  readonly methods: readonly PoolLoginMethod<T>[]
  /**
   * Adds a login method that activates the plugin for vault accounts without
   * creating a local account. Leave it out when the plugin has no vault.
   */
  readonly vault?: VaultActivationMethod
  /**
   * Writes a completed login into the plugin's pool. The host only receives
   * a placeholder once this resolves; if it throws, the login fails in the
   * host and nothing is stored there.
   */
  onLogin(result: T, context: LoginContext): Promise<void> | void
  /** Label the host shows for its (placeholder) connection. */
  readonly label?: string
  readonly now?: () => number
}

/**
 * Registers the plugin's own login methods with the host so that a login lands
 * in the plugin's pool and the host keeps only a placeholder credential.
 *
 * With `vault`, one more method lets a host whose accounts all live in a vault
 * activate the plugin: it calls `activate`, writes nothing to the pool and
 * hands the host the same placeholder under its own method ID.
 *
 * Host-driven refresh never reaches the pool: it renews only this integration's
 * placeholder and refuses every other credential without replacing it. Plugins
 * must register under their own method IDs; a plugin importing an existing
 * host login should read it through `ctx.integration.connection` instead.
 */
export async function registerOpenCode2AuthMethods<T>(
  ctx: {
    readonly integration: Pick<Plugin.Context['integration'], 'transform'>
  },
  options: RegisterOpenCode2AuthMethodsOptions<T>,
): Promise<Registration> {
  const now = options.now ?? Date.now
  const { integrationID } = options
  const placeholderFor = (methodID: string) =>
    placeholderCredential({ integrationID, methodID, now: now() })
  const store = async (result: T, methodID: string) => {
    await options.onLogin(result, { integrationID, methodID })
    return placeholderFor(methodID)
  }
  const authorizeWith =
    (login: PoolLoginMethod<T>) =>
    async (answer: FormAnswer): Promise<IntegrationOAuthAuthorization> => {
      const methodID = login.method.id
      const pending = await login.authorize(answer)
      const common = {
        url: pending.url,
        instructions: pending.instructions,
        ...(pending.expiresAt === undefined
          ? {}
          : { expiresAt: pending.expiresAt }),
      }
      if (pending.mode === 'auto') {
        return {
          ...common,
          mode: 'auto',
          callback: pending.callback.then((result) => store(result, methodID)),
        }
      }
      const callback = pending.callback
      return {
        ...common,
        mode: 'code',
        callback: async (code: string) => store(await callback(code), methodID),
      }
    }
  return ctx.integration.transform((editor) => {
    const label =
      options.label === undefined ? {} : { label: () => options.label }
    for (const login of options.methods) {
      editor.method.update({
        integrationID,
        method: login.method,
        authorize: authorizeWith(login),
        refresh: async (credential) => {
          if (!isPlaceholderCredential(credential, integrationID)) {
            throw new Error(
              "This login method refreshes only its pool placeholder; sign in again with the plugin's login method.",
            )
          }
          return placeholderFor(credential.methodID)
        },
        ...label,
      })
    }
    const vault = options.vault
    if (vault === undefined) return
    const methodID = vault.method.id
    editor.method.update({
      integrationID,
      method: vault.method,
      // OpenCode 2 has no login method kind that needs no user step: OAuth
      // expects a page, a key method a typed secret, a command method a
      // program. An automatic OAuth authorization with an empty `url` fits:
      // on 2.0.22 the CLI's and the TUI's browser openers refuse anything but
      // an http(s) URL, and the host stores what `callback` resolves to as
      // soon as it settles, so the login completes with no browser.
      authorize: async () => ({
        url: '',
        instructions: vault.instructions ?? VAULT_ACTIVATION_INSTRUCTIONS,
        mode: 'auto',
        // Activation runs in the callback, not before returning, so a refusal
        // marks the host's login attempt failed with the plugin's own message,
        // which the host shows as is.
        callback: Promise.resolve()
          .then(() => vault.activate({ integrationID, methodID }))
          .then(() => placeholderFor(methodID)),
      }),
      // Nothing to renew in the vault: only this method's own placeholder is
      // reissued, and anything else must be signed in again.
      refresh: async (credential) => {
        if (
          !isPlaceholderCredential(credential, integrationID) ||
          credential.methodID !== methodID
        ) {
          throw new Error(
            "This login method refreshes only its vault placeholder; choose the plugin's vault login method again.",
          )
        }
        return placeholderFor(methodID)
      },
      ...label,
    })
  })
}
