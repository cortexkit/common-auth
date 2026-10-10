import { describe, expect, test } from 'bun:test'
import { openBrowserForMenu } from '../../src/auth-menu/login.js'

const oauthUrl =
  "https://auth.openai.com/oauth/authorize?client_id=client&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&scope=openid%20email&state=it's 50% done&code_challenge=challenge-value&code_challenge_method=S256"

describe('auth menu browser opener', () => {
  test('Windows encodes an OAuth URL intact without a shell', () => {
    const calls: unknown[][] = []

    const opened = openBrowserForMenu(
      oauthUrl,
      'win32',
      (file, args, options) => {
        calls.push([file, args, options])
      },
    )

    expect(opened).toBe(true)
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
        { stdio: 'ignore', timeout: 3000 },
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
      openBrowserForMenu(oauthUrl, 'win32', () => {
        throw new Error('opener unavailable')
      }),
    ).toBe(false)
  })
})
