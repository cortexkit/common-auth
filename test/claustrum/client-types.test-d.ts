import type { ClaustrumClient } from '@cortexkit/claustrum-client'
import type {
  ClaustrumConsumer,
  ClaustrumDiscoveryHub,
  ClaustrumScopedClient,
  ClaustrumScopedCustody,
} from '../../src/claustrum/index.js'

// New vault auth methods must not make an otherwise compatible client unusable.
type Inventory = Awaited<ReturnType<ClaustrumClient['listScoped']>>
type ExtendedRow = Omit<Inventory['rows'][number], 'authMethod'> & {
  readonly authMethod?: 'gateway' | 'future-auth-method'
}
type ExtendedClient = Omit<ClaustrumClient, 'listScoped'> & {
  listScoped(
    enrollmentToken?: string,
  ): Promise<
    Omit<Inventory, 'rows'> & { readonly rows: readonly ExtendedRow[] }
  >
}

declare const extended: ExtendedClient
const extendedScoped: ClaustrumScopedClient = extended
void extendedScoped

declare const client: ClaustrumClient
const scoped: ClaustrumScopedClient = client
const custodyClient: NonNullable<
  ConstructorParameters<typeof ClaustrumScopedCustody>[0]['client']
> = client
const consumerConnect: NonNullable<
  ConstructorParameters<typeof ClaustrumConsumer>[0]['connect']
> = async () => client
const hubConnect: NonNullable<
  ConstructorParameters<typeof ClaustrumDiscoveryHub>[0]['connect']
> = async () => client
void scoped
void custodyClient
void consumerConnect
void hubConnect
