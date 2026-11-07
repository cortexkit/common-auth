// Tests choose hosted vault mode themselves. An agent running this suite inside
// a host that Thalamus started inherits CORTEXKIT_VAULT_HOST=thalamus, which
// would otherwise put every vault test in hosted mode without saying so.
// Bun.spawn without an `env` option hands a child the environment this process
// started with, not process.env, so a test that spawns children passes
// `env: process.env` for the deletion to reach them.
delete process.env.CORTEXKIT_VAULT_HOST
