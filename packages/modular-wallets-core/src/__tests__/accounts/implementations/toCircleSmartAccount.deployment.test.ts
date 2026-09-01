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

import { custom } from 'viem'
import { createBundlerClient } from 'viem/account-abstraction'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

import {
  MockEoaAccount,
  MockModularWalletsProvider,
  MockSandboxDeployment,
} from '../../../__mocks__'
import { toCircleSmartAccount } from '../../../accounts'
import { CIRCLE_CANONICAL_DEPLOYMENT, FACTORY } from '../../../constants'
import { AccountType } from '../../../types'
import { computeAddress } from '../../../utils'

import type { LocalAccount } from 'viem'

let owner: LocalAccount

// A transport WITHOUT the Modular Wallets key so the address is computed locally instead of through circle_getAddress
const client = createBundlerClient({
  transport: custom(new MockModularWalletsProvider(AccountType.Local)),
  chain: sepolia,
})

beforeAll(() => {
  owner = privateKeyToAccount(MockEoaAccount.privateKey)
})

describe('Accounts > implementations > toCircleSmartAccount (deployment)', () => {
  it('should default to the canonical deployment', async () => {
    const account = await toCircleSmartAccount({ client, owner })
    account.isDeployed = jest.fn().mockResolvedValue(false)
    const factoryArgs = await account.getFactoryArgs()

    expect(account.address).toBe(computeAddress(owner))
    expect(account.entryPoint.address).toBe(
      CIRCLE_CANONICAL_DEPLOYMENT.entryPoint,
    )
    expect(factoryArgs.factory).toBe(FACTORY.address)
    expect(account.factory.address).toBe(FACTORY.address)
  })

  it('should compute the address, factory args and entry point from a sandbox deployment', async () => {
    const account = await toCircleSmartAccount({
      client,
      owner,
      deployment: MockSandboxDeployment,
    })
    account.isDeployed = jest.fn().mockResolvedValue(false)
    const factoryArgs = await account.getFactoryArgs()

    expect(account.address).toBe(computeAddress(owner, MockSandboxDeployment))
    expect(account.address).not.toBe(computeAddress(owner))
    expect(account.entryPoint.address).toBe(MockSandboxDeployment.entryPoint)
    expect(factoryArgs.factory).toBe(
      MockSandboxDeployment.upgradableMscaFactory,
    )
    expect(account.factory.address).toBe(
      MockSandboxDeployment.upgradableMscaFactory,
    )
    expect(factoryArgs.factoryData?.toLowerCase()).toContain(
      MockSandboxDeployment.weightedWebauthnMultisig.address
        .slice(2)
        .toLowerCase(),
    )
  })

  it('should produce deployment-specific signatures', async () => {
    const canonical = await toCircleSmartAccount({ client, owner })
    const sandbox = await toCircleSmartAccount({
      client,
      owner,
      deployment: MockSandboxDeployment,
    })
    const message = 'hello bufi'

    expect(await sandbox.signMessage({ message })).not.toBe(
      await canonical.signMessage({ message }),
    )
  })
})
