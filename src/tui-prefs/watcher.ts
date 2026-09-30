import { readFileSync, watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { clearTimeout, setTimeout } from 'node:timers'

export interface TuiPreferencesWatchOptions {
  watchDirectory?: typeof watch
}

/** Watch the directory so atomic file replacement does not detach the watcher. */
export function watchTuiPreferences(
  file: string,
  onChange: () => void,
  options: TuiPreferencesWatchOptions = {},
): () => void {
  const name = basename(file)
  let timer: ReturnType<typeof setTimeout> | null = null
  // An asynchronous seed could absorb a write made immediately after returning.
  let lastSeen: string | null = null
  try {
    lastSeen = readFileSync(file, 'utf8')
  } catch {
    // Missing files can be created later.
  }
  let disposed = false
  const checkForChange = async () => {
    const text = await readFile(file, 'utf8').catch(() => null)
    if (disposed || text === null || text === lastSeen) return
    lastSeen = text
    onChange()
  }
  const scheduleCheck = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void checkForChange()
    }, 150)
  }

  let watcher: ReturnType<typeof watch> | null = null
  try {
    watcher = (options.watchDirectory ?? watch)(
      dirname(file),
      (_event, filename) => {
        const eventName = filename?.toString()
        const isOurs =
          eventName === name ||
          (eventName?.startsWith(`${name}.`) && eventName.endsWith('.tmp'))
        if (eventName != null && !isOurs) return
        scheduleCheck()
      },
    )
    watcher.on('error', () => {
      // Polling continues if the native watcher fails after construction.
      watcher?.close()
    })
  } catch {
    if (lastSeen === null) return () => {}
  }

  // Poll independently: directory watchers can miss rename events.
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  const schedulePoll = () => {
    if (disposed || pollTimer) return
    pollTimer = setTimeout(() => {
      pollTimer = null
      if (disposed) return
      void checkForChange().finally(schedulePoll)
    }, 100)
    pollTimer.unref()
  }
  schedulePoll()
  return () => {
    disposed = true
    if (timer) clearTimeout(timer)
    if (pollTimer) clearTimeout(pollTimer)
    watcher?.close()
  }
}
