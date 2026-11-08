import '@opentui/solid/preload'
import { realpathSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import solidPlugin from '@opentui/solid/bun-plugin'
import { type PluginBuilder, plugin } from 'bun'

const sourceDirectory = dirname(
  realpathSync(
    fileURLToPath(import.meta.resolve('@cortexkit/opencode-sidebar')),
  ),
)
const sourceFilter = new RegExp(
  `^${sourceDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[/\\\\][^/\\\\]+\\.tsx$`,
)

// OpenTUI deliberately skips node_modules TSX. Consumers compile the frame's
// source into their own output, so render tests must apply the same transform.
plugin({
  name: 'test-sidebar-source-peer',
  setup(build) {
    const peerBuild: PluginBuilder = Object.create(build)
    peerBuild.onLoad = (options, load) => {
      // Keep the TSX loader, not the plugin's separate Solid server-module loaders.
      if (options.filter.test(`${import.meta.dir}/sidebar-source-probe.tsx`))
        build.onLoad({ filter: sourceFilter }, load)
      return peerBuild
    }
    return solidPlugin.setup(peerBuild)
  },
})
