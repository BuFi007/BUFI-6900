/*
 * Copyright (c) 2026, Circle Internet Group, Inc. All rights reserved.
 * Modifications Copyright (c) 2026 BUFI. Licensed under the Apache License, Version 2.0.
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

/**
 * Check if the URL is a Circle URL.
 * @param url - The URL to check.
 * @param trustedHosts - Additional hosts (`host` or `host:port`, as returned by `URL.host`) to treat as Circle URLs,
 * for example a local mock of the Modular Wallets API. BUFI modification.
 * @returns True if the URL is a Circle URL, false otherwise.
 */
export function isCircleUrl(
  url: string,
  trustedHosts: readonly string[] = [],
): boolean {
  try {
    const parsedUrl = new URL(url)

    const allowedHosts = [
      'modular-sdk.circle.com',
      'modular-sdk-staging.circle.com',
      ...trustedHosts,
    ]

    return allowedHosts.includes(parsedUrl.host)
  } catch {
    return false
  }
}
