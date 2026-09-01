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

import { isCircleUrl } from '../../../utils'

describe('Utils > rpc > isCircleUrl (trusted hosts)', () => {
  const sandboxUrl = 'http://127.0.0.1:8788/v1/rpc/w3s/buidl'

  it('should not trust a sandbox host by default', () => {
    expect(isCircleUrl(sandboxUrl)).toBe(false)
    expect(isCircleUrl(sandboxUrl, [])).toBe(false)
  })

  it('should trust an explicitly listed host and port', () => {
    expect(isCircleUrl(sandboxUrl, ['127.0.0.1:8788'])).toBe(true)
  })

  it('should match the port as part of the host', () => {
    expect(isCircleUrl(sandboxUrl, ['127.0.0.1'])).toBe(false)
    expect(isCircleUrl(sandboxUrl, ['127.0.0.1:8789'])).toBe(false)
  })

  it('should keep trusting the Circle hosts alongside extra hosts', () => {
    expect(
      isCircleUrl('https://modular-sdk.circle.com/v1/rpc/w3s/buidl', [
        '127.0.0.1:8788',
      ]),
    ).toBe(true)
  })

  it('should still reject invalid urls', () => {
    expect(isCircleUrl('hello', ['127.0.0.1:8788'])).toBe(false)
  })
})
