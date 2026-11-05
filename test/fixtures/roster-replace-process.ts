import { mutateVaultRoster } from '../../src/claustrum/roster.js'

const path = process.argv[2]
if (!path) throw new Error('missing roster path')
await mutateVaultRoster(path, (current) => {
  if (!current) throw new Error('missing roster')
  return { next: { ...current, view: 'peer' }, result: undefined }
})
