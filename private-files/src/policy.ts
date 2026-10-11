export type PrivateKind = 'file' | 'directory'

/** Pure policy input; only the OS descriptor from the actual opened object can certify access. */
export interface PrivateDescriptor {
  owner: string
  currentUser: string
  defaultOwner: string
  kind: PrivateKind
  parent?: PrivateDescriptor
  reparse: boolean
  daclPresent: boolean
  daclProtected: boolean
  aces: null | { type: number; flags: number; mask: number; sid: string }[]
}

export function isPrivateDescriptor(
  descriptor: PrivateDescriptor,
  kind: PrivateKind,
): boolean {
  const ace = descriptor.aces?.[0]
  return (
    (descriptor.owner === descriptor.currentUser ||
      descriptor.owner === descriptor.defaultOwner) &&
    descriptor.kind === kind &&
    !descriptor.reparse &&
    descriptor.daclPresent &&
    ((descriptor.daclProtected &&
      ace?.flags === (kind === 'directory' ? 3 : 0)) ||
      (kind === 'file' &&
        !descriptor.daclProtected &&
        ace?.flags === 16 &&
        !!descriptor.parent &&
        descriptor.parent.currentUser === descriptor.currentUser &&
        descriptor.parent.defaultOwner === descriptor.defaultOwner &&
        isPrivateDescriptor(descriptor.parent, 'directory'))) &&
    descriptor.aces?.length === 1 &&
    ace?.type === 0 &&
    ace.mask === 0x1f01ff &&
    ace.sid === descriptor.currentUser
  )
}
