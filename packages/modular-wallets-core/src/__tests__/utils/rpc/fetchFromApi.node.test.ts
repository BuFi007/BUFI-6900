/*
 * Copyright (c) 2026, BUFI. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fetchMock from 'jest-fetch-mock'

import { fetchFromApi } from '../../../utils'

beforeAll(() => {
  fetchMock.enableMocks()
})

afterEach(() => {
  fetchMock.resetMocks()
})

describe('Utils > rpc > fetchFromApi (headless)', () => {
  const originalWindow = global.window

  beforeEach(() => {
    Object.defineProperty(global, 'window', {
      value: undefined,
      writable: true,
    })
  })

  afterEach(() => {
    global.window = originalWindow
  })

  it('should report an unknown uri when window is not defined', async () => {
    fetchMock.mockResponseOnce(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }),
      { status: 200 },
    )

    const response = await fetchFromApi(
      'http://127.0.0.1:8788/v1/rpc/w3s/buidl',
      'test-client-key',
      { method: 'eth_chainId', params: [], id: 1 },
    )

    const requestOptions = fetchMock.mock.calls[0]?.[1]
    const headers = requestOptions?.headers as Record<string, string>

    expect(headers['X-AppInfo']).toContain('uri=unknown')
    expect(response).toEqual({ jsonrpc: '2.0', id: 1, result: '0x1' })
  })
})
