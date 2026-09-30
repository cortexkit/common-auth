export * from './store-user.js'
export const lazy = () => import('./store-user.js')
export default function View() {
  return <box />
}
