import { describe, expect, test } from 'bun:test'
import { composeHarnessUrl } from './docker'

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
