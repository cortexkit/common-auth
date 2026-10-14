import { setTimeout as delay } from 'node:timers/promises'
import { writeEnrollmentTokenFile } from '@cortexkit/claustrum-client'
import { type MenuTerminal, printLine } from '../auth-menu/terminal.js'
import {
  ClaustrumEnrollmentManager,
  connectClaustrumEnrollmentClient,
  hostEnrollmentPaths,
} from '../claustrum/enrollment.js'
import {
  ProcessFenceViolationError,
  ProcessInspectionError,
} from './process-fence.js'
import type { SetupHost, SetupIO, SetupPlugin } from './types.js'

/** Enroll an independently revocable host; plugin callbacks choose its credential store and account permissions. */
export async function connectSetupHost(
  plugin: SetupPlugin,
  host: SetupHost,
  io: SetupIO,
  terminal: MenuTerminal,
  fence: () => Promise<void>,
): Promise<void> {
  const { name, paths: input } = plugin.vault.hosts[host]
  const paths = hostEnrollmentPaths(input)
  await fence()
  const client = await (io.connect ?? connectClaustrumEnrollmentClient)({
    connectionFile: plugin.vault.connectionFile,
    handshakeTimeoutMs: 2000,
  }).catch(() => {
    throw new Error('Claustrum connection failed; start ck and rerun setup.')
  })
  try {
    const manager = new ClaustrumEnrollmentManager({
      proposedName: name,
      paths,
      client: {
        enrollPropose: async (input) => {
          await fence()
          return client.enrollPropose(input)
        },
        enrollPoll: async (input) => {
          await fence()
          return client.enrollPoll(input)
        },
      },
      writeTokenFile: async (path, file) => {
        await fence()
        await writeEnrollmentTokenFile(path, file)
      },
    })
    let printedRequest: string | undefined
    for (let tick = 0; tick < 300; tick++) {
      await fence()
      const status = await manager.reconcile()
      if (status.state === 'approved') {
        printLine(terminal, `Connected ${host} to Claustrum.`)
        return
      }
      if (status.state !== 'pending' && status.state !== 'busy')
        throw new Error(
          'Claustrum enrollment refused; inspect its status with ck before rerunning setup.',
        )
      if (
        status.state === 'pending' &&
        status.requestId &&
        status.requestId !== printedRequest
      ) {
        if (!/^[a-zA-Z0-9_-]+$/.test(status.requestId))
          throw new Error('Invalid enrollment request id.')
        printedRequest = status.requestId
        printLine(terminal, 'Waiting for approval. In another terminal, run:')
        printLine(
          terminal,
          `  ck auth enroll approve --request-id ${status.requestId} --name ${name}`,
        )
        printLine(
          terminal,
          `Enrollment files: ${paths.statePath}, ${paths.tokenPath}`,
        )
      }
      await (io.wait ?? delay)(1000)
    }
    throw new Error(
      'Claustrum approval is still pending; approve with ck and rerun setup.',
    )
  } catch (error) {
    if (
      error instanceof ProcessFenceViolationError ||
      error instanceof ProcessInspectionError
    )
      throw error
    // Enrollment exceptions can carry request secrets or bearer tokens; never display them.
    throw new Error(
      'Claustrum enrollment did not complete. Inspect and approve with ck, then rerun setup.',
    )
  } finally {
    client.close()
  }
}
