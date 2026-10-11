import { describe, expect, test } from 'bun:test'
import { openBrowserForMenu } from '../../src/auth-menu/login.js'

const oauthUrl =
  "https://auth.openai.com/oauth/authorize?client_id=client&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&scope=openid%20email&state=it's 50% done&code_challenge=challenge-value&code_challenge_method=S256"

describe('auth menu browser opener', () => {
  test('Windows encodes an OAuth URL intact without a shell', () => {
    const calls: unknown[][] = []
    const events: string[] = []

    const opened = openBrowserForMenu(
      oauthUrl,
      'win32',
      () => {
        throw new Error('Windows must not wait on a synchronous opener')
      },
      (file, args, options) => {
        calls.push([file, args, options])
        return {
          pid: 4242,
          on: (event) => events.push(`on:${event}`),
          unref: () => events.push('unref'),
        }
      },
    )

    expect(opened).toBe(true)
    // Detached and unreferenced: the caller never waits for PowerShell, whose
    // cold start can outlast any fixed wait, and a late launch error is caught.
    expect(events).toEqual(['on:error', 'unref'])
    const expectedCommand =
      "Start-Process 'https://auth.openai.com/oauth/authorize?client_id=client&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&scope=openid%20email&state=it''s 50% done&code_challenge=challenge-value&code_challenge_method=S256'"
    const encodedCommand = Buffer.from(expectedCommand, 'utf16le').toString(
      'base64',
    )
    expect(calls).toEqual([
      [
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-EncodedCommand',
          encodedCommand,
        ],
        { detached: true, stdio: 'ignore', windowsHide: true },
      ],
    ])

    const args = calls[0]?.[1] as string[]
    const decodedCommand = Buffer.from(args[5]!, 'base64').toString('utf16le')
    expect(decodedCommand).toBe(expectedCommand)
    const quotedUrl = decodedCommand.match(
      /^Start-Process '((?:[^']|'')*)'$/,
    )?.[1]
    expect(quotedUrl?.replaceAll("''", "'")).toBe(oauthUrl)
  })

  test('macOS and Linux keep their native opener arguments', () => {
    const calls: unknown[][] = []
    const execFileSync = (file: string, args: string[], options: unknown) => {
      calls.push([file, args, options])
    }

    expect(openBrowserForMenu(oauthUrl, 'darwin', execFileSync)).toBe(true)
    expect(openBrowserForMenu(oauthUrl, 'linux', execFileSync)).toBe(true)
    expect(calls).toEqual([
      ['open', [oauthUrl], { stdio: 'ignore', timeout: 3000 }],
      ['xdg-open', [oauthUrl], { stdio: 'ignore', timeout: 3000 }],
    ])
  })

  test('returns false when the platform opener fails', () => {
    expect(
      openBrowserForMenu(oauthUrl, 'linux', () => {
        throw new Error('opener unavailable')
      }),
    ).toBe(false)
    expect(
      openBrowserForMenu(
        oauthUrl,
        'win32',
        () => {},
        () => {
          throw new Error('spawn unavailable')
        },
      ),
    ).toBe(false)
    // Node reports an unstartable process with an undefined pid.
    expect(
      openBrowserForMenu(
        oauthUrl,
        'win32',
        () => {},
        () => ({ pid: undefined, on: () => {}, unref: () => {} }),
      ),
    ).toBe(false)
  })
})
