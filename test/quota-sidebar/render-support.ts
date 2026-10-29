import { RGBA } from '@opentui/core'
import { type JSX, testRender } from '@opentui/solid'
import { HEIGHT } from './cases.js'

export const theme = {
  text: RGBA.fromHex('#f0f0f0'),
  textMuted: RGBA.fromHex('#888888'),
  accent: RGBA.fromHex('#55aaff'),
  background: RGBA.fromHex('#101010'),
  borderActive: RGBA.fromHex('#55aaff'),
  success: RGBA.fromHex('#00cc55'),
  warning: RGBA.fromHex('#ffaa00'),
  error: RGBA.fromHex('#ff0055'),
}
export const appearance = {
  barWidth: 10,
  barFilledChar: '█',
  barEmptyChar: '░',
  warnThreshold: 70,
  errorThreshold: 90,
}

export async function capture(render: () => JSX.Element, width: number) {
  const view = await testRender(render, { width, height: HEIGHT })
  try {
    // Layout measures the allocated width before fitted text is painted.
    for (let pass = 0; pass < 3; pass++) await view.renderOnce()
    return { chars: view.captureCharFrame(), spans: view.captureSpans() }
  } finally {
    view.renderer.destroy()
  }
}
