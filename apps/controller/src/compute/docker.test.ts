import { describe, expect, test } from 'bun:test'
import { composeBrowserHarnessUrl, composeHarnessUrl } from './docker'

describe('composeHarnessUrl', () => {
  test('default — base + port', () => {
    expect(composeHarnessUrl({ hostUrlBase: 'http://localhost', hostPort: '49183' })).toBe(
      'http://localhost:49183',
    )
  })

  test('publicUrl wins verbatim, ignoring port', () => {
    expect(
      composeHarnessUrl({
        publicUrl: 'https://omega.logosflux.com/harness',
        hostUrlBase: 'http://ignored',
        hostPort: '49183',
      }),
    ).toBe('https://omega.logosflux.com/harness')
  })

  test('publicUrl preserved with trailing path / no port', () => {
    expect(
      composeHarnessUrl({
        publicUrl: 'https://omega.example/h/sessionid',
        hostUrlBase: 'http://localhost',
        hostPort: '8080',
      }),
    ).toBe('https://omega.example/h/sessionid')
  })
})

describe('composeBrowserHarnessUrl', () => {
  test('appends /harness/<name> to the base', () => {
    expect(composeBrowserHarnessUrl('https://omega.example.com', 'harness-abc123')).toBe(
      'https://omega.example.com/harness/harness-abc123',
    )
  })

  test('trims trailing slashes on the base so the path never doubles up', () => {
    expect(composeBrowserHarnessUrl('https://omega.example.com//', 'harness-abc123')).toBe(
      'https://omega.example.com/harness/harness-abc123',
    )
  })

  test('distinct containers get distinct paths (per-session routing)', () => {
    const a = composeBrowserHarnessUrl('https://h', 'harness-aaa')
    const b = composeBrowserHarnessUrl('https://h', 'harness-bbb')
    expect(a).not.toBe(b)
  })
})
