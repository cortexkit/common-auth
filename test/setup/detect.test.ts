import { describe, expect, test } from 'bun:test'
import { runResolvedCommand } from '../../src/setup/command-runner.js'
import {
  detectHosts,
  detectOpenCodeGeneration,
  findExecutableOnPath,
  openCodeDesktopMarkers,
} from '../../src/setup/index.js'
import { setupPaths } from '../../src/setup/paths.js'
import { fakeIO, plugin } from './helpers.js'

describe('setup detection', () => {
  test('Windows cmd launcher alone is installed', async () => {
    const io = fakeIO('win32')
    io.files.set('C:\\npm\\opencode.cmd', '@echo off')
    const result = await detectHosts(plugin(), io)
    expect(result.opencode.installed).toBe(true)
    expect(result.opencode.executable).toBe('C:\\npm\\opencode.cmd')
    expect(result.opencode.version).toBe('1.9.0')
    expect(io.commands).toEqual([
      {
        file: 'cmd.exe',
        args: ['/d', '/s', '/c', '""C:\\npm\\opencode.cmd" --version"'],
      },
    ])
  })

  test('Windows exe launcher alone is installed', async () => {
    const io = fakeIO('win32')
    io.files.set('C:\\npm\\opencode.exe', '')
    expect((await detectHosts(plugin(), io)).opencode.installed).toBe(true)
    expect(io.commands[0]?.file).toBe('C:\\npm\\opencode.exe')
  })

  test('Desktop markers alone are installed on every OS', async () => {
    const expected: Record<string, string[]> = {
      darwin: [
        '/Applications/OpenCode.app',
        '/Applications/OpenCode Beta.app',
        '/home/test/Applications/OpenCode.app',
        '/home/test/Applications/OpenCode Beta.app',
      ],
      win32: [
        'C:\\Users\\test\\AppData\\Local\\Programs\\opencode',
        'C:\\Users\\test\\AppData\\Local\\opencode',
      ],
      linux: [
        '/opt/OpenCode',
        '/usr/lib/opencode',
        '/home/test/.local/share/applications/opencode.desktop',
      ],
    }
    for (const [platform, markers] of Object.entries(expected)) {
      expect(openCodeDesktopMarkers(fakeIO(platform))).toEqual(markers)
      for (const marker of markers) {
        const io = fakeIO(platform)
        io.folders.add(marker)
        expect((await detectHosts(plugin(), io)).opencode.installed).toBe(true)
        expect(io.commands).toEqual([])
      }
    }
  })

  test('config folder without a config file is installed', async () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const io = fakeIO(platform)
      io.folders.add(setupPaths(io).opencode)
      expect((await detectHosts(plugin(), io)).opencode.installed).toBe(true)
      expect(io.files.size).toBe(0)
      expect(io.commands).toEqual([])
    }
  })

  test('nothing present is not installed', async () => {
    const result = await detectHosts(plugin(), fakeIO())
    expect(result.opencode.installed).toBe(false)
    expect(result.pi.installed).toBe(false)
    expect(result.claustrum.available).toBe(false)
  })

  test('failed cmd version probe remains installed with unknown version', async () => {
    const io = fakeIO('win32')
    io.files.set('C:\\npm\\opencode.cmd', '')
    io.runner = {
      async run() {
        return { exitCode: 1, stdout: '', stderr: 'not executable' }
      },
    }
    const result = await detectHosts(plugin(), io)
    expect(result.opencode.installed).toBe(true)
    expect(result.opencode.version).toBeNull()
  })

  test('PATH lookup skips empty entries and directories and requires POSIX execute permission', () => {
    const io = fakeIO()
    io.env = { PATH: ':/folder:/bin' }
    io.folders.add('/folder/opencode')
    io.files.set('/bin/opencode', '')
    expect(findExecutableOnPath('opencode', io)).toBe('/bin/opencode')
    io.fs = { ...io.fs!, isExecutable: () => false }
    expect(findExecutableOnPath('opencode', io)).toBeNull()
  })

  test('Windows lookup accepts bat and quoted Path and prefers runnable npm shims', () => {
    const io = fakeIO('win32')
    io.env = { Path: ';"C:\\npm"' }
    io.files.set('C:\\npm\\pi', '#!/bin/sh')
    io.files.set('C:\\npm\\pi.bat', '')
    expect(findExecutableOnPath('pi', io)).toBe('C:\\npm\\pi.bat')
  })

  test('config and Pi directories honor environment rules', async () => {
    const io = fakeIO('win32')
    io.env = {
      OPENCODE_CONFIG_DIR: 'C:\\custom',
      XDG_CONFIG_HOME: 'C:\\xdg',
      PI_CODING_AGENT_DIR: '~\\coding',
    }
    io.folders.add('C:\\custom')
    io.folders.add('C:\\Users\\test\\coding')
    const result = await detectHosts(plugin(), io)
    expect(result.opencode.directory).toBe('C:\\custom')
    expect(result.pi.directory).toBe('C:\\Users\\test\\coding')
    expect(result.pi.installed).toBe(true)
    io.env.OPENCODE_CONFIG_DIR = undefined
    expect(setupPaths(io).opencode).toBe('C:\\xdg\\opencode')
    const unix = fakeIO()
    unix.env = {
      PI_CODING_AGENT_DIR: 'file:///tmp/pi',
      XDG_CONFIG_HOME: '/xdg',
    }
    expect(setupPaths(unix).pi).toBe('/tmp/pi')
    expect(setupPaths(unix).opencode).toBe('/xdg/opencode')
  })

  test('Pi CLI is installed even if its version probe fails', async () => {
    const io = fakeIO()
    io.files.set('/bin/pi', '')
    io.runner = {
      async run() {
        throw new Error('failed')
      },
    }
    expect((await detectHosts(plugin(), io)).pi).toMatchObject({
      installed: true,
      version: null,
      executable: '/bin/pi',
    })
  })

  test('Claustrum requires ck and a two second handshake and closes the connection', async () => {
    const io = fakeIO()
    let calls = 0
    let closed = 0
    io.connect = async (options) => {
      expect(options).toEqual({
        connectionFile: '/fixture/connection.json',
        handshakeTimeoutMs: 2000,
      })
      calls++
      return {
        close() {
          closed++
        },
        async enrollPropose() {
          throw new Error('unexpected')
        },
        async enrollPoll() {
          throw new Error('unexpected')
        },
      }
    }
    io.files.set('/fixture/connection.json', '{}')
    expect((await detectHosts(plugin(), io)).claustrum.available).toBe(false)
    expect(calls).toBe(0)
    io.files.set('/bin/ck', '')
    expect((await detectHosts(plugin(), io)).claustrum.available).toBe(true)
    expect(closed).toBe(1)
    io.connect = async () => {
      throw new Error('handshake timeout')
    }
    expect((await detectHosts(plugin(), io)).claustrum.available).toBe(false)
  })

  test('generation is read from owning npm metadata without launching OpenCode', () => {
    const io = fakeIO('win32')
    io.files.set(
      'C:\\npm\\opencode.cmd',
      '"%dp0%\\node.exe" "%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"',
    )
    io.files.set('C:\\npm\\node_modules\\@opencode\\cli\\bin\\opencode.exe', '')
    io.files.set(
      'C:\\npm\\node_modules\\@opencode\\cli\\package.json',
      '{"name":"@opencode/cli","version":"2.0.22"}',
    )
    expect(detectOpenCodeGeneration(io)).toBe('2')
    expect(io.commands).toEqual([])
  })

  test('unclassified CLI or folder infers plural config and otherwise defaults to one', () => {
    const io = fakeIO()
    expect(detectOpenCodeGeneration(io)).toBe('1')
    io.files.set(
      '/home/test/.config/opencode/opencode.jsonc',
      '{ // existing v2\n "plugins": [] }',
    )
    expect(detectOpenCodeGeneration(io)).toBe('2')
    io.files.set('/bin/opencode', '')
    expect(detectOpenCodeGeneration(io)).toBe('2')
    io.files.clear()
    io.files.set('/bin/opencode', '')
    expect(detectOpenCodeGeneration(io)).toBe('1')
  })

  test('distinct v1 and v2 executables are ambiguous but shared npm targets are not', () => {
    const io = fakeIO()
    io.files.set('/bin/opencode', '')
    io.files.set('/bin/opencode2', '')
    expect(detectOpenCodeGeneration(io)).toBe('ambiguous')
    io.fs = { ...io.fs!, realpath: () => '/shared/opencode' }
    expect(detectOpenCodeGeneration(io)).toBe('2')
  })

  test('batch execution rejects shell expansions and untrusted arguments', async () => {
    const io = fakeIO('win32')
    expect(() =>
      runResolvedCommand(
        io.runner!,
        'win32',
        'C:\\%EVIL%\\opencode.cmd',
        ['--version'],
        {},
      ),
    ).toThrow('Unsafe')
    expect(() =>
      runResolvedCommand(
        io.runner!,
        'win32',
        'C:\\npm\\pi.cmd',
        ['install', 'npm:test & calc'],
        {},
      ),
    ).toThrow('Unsafe')
    expect(io.commands).toEqual([])
  })
})
