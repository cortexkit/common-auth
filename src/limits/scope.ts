/** Applicability is a plugin fact, never a substring match on a model id. */
export type Scope =
  | { readonly kind: 'pool' }
  | { readonly kind: 'family'; readonly family: string }
  | { readonly kind: 'model'; readonly model: string }

export type FamilyOf = (model: string) => string | undefined

export function scopeCovers(
  scope: Scope,
  model: string,
  familyOf: FamilyOf,
): boolean {
  switch (scope.kind) {
    case 'pool':
      return true
    case 'family':
      return familyOf(model) === scope.family
    case 'model':
      return scope.model === model
  }
}
