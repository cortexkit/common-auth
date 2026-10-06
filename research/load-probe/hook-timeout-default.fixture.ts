import { beforeEach, test } from 'bun:test'

// Run explicitly, not as a passing suite test: the runner must abandon this
// unresolved hook using its own default, with no explicit timeout argument.
beforeEach(() => new Promise<void>(() => {}))
test('default Bun hook timeout probe', () => {})
