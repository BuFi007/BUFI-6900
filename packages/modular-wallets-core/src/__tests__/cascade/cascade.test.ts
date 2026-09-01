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

import { zeroHash } from 'viem'

import {
  MockAccountAddress,
  MockBufiGrant,
  MockPublicKey,
  MockRecipients,
  MockSandboxDeployment,
  MockSessionKeyAddress,
} from '../../__mocks__'
import {
  buildBufiGrant,
  encodeAddSessionKey,
  encodeInstallAddressBook,
  encodeInstallSessionKeyPlugin,
  encodeUpdateMultisigWeights,
} from '../../actions'
import { buildAgentFaceCalls, buildTreasuryBootstrapCalls } from '../../cascade'

describe('Cascade > buildTreasuryBootstrapCalls', () => {
  const weights = {
    publicKeyOwners: [{ publicKey: MockPublicKey[0], weight: 1n }],
    thresholdWeight: 1n,
  }

  it('should return the re-weighting and the address book install as two separate calls', () => {
    const calls = buildTreasuryBootstrapCalls({
      account: MockAccountAddress,
      weights,
      allowedRecipients: MockRecipients,
    })

    expect(Object.keys(calls)).toEqual([
      'updateMultisigWeights',
      'installAddressBook',
    ])
    expect(calls.updateMultisigWeights).toEqual({
      to: MockAccountAddress,
      value: 0n,
      data: encodeUpdateMultisigWeights(weights),
    })
    expect(calls.installAddressBook).toEqual(
      encodeInstallAddressBook({
        account: MockAccountAddress,
        recipients: MockRecipients,
      }),
    )
  })

  it('should target the address book of a sandbox deployment', () => {
    const calls = buildTreasuryBootstrapCalls({
      account: MockAccountAddress,
      weights,
      allowedRecipients: [],
      deployment: MockSandboxDeployment,
    })

    expect(calls.installAddressBook).toEqual(
      encodeInstallAddressBook({
        account: MockAccountAddress,
        recipients: [],
        deployment: MockSandboxDeployment,
      }),
    )
    expect(calls.installAddressBook.data.toLowerCase()).toContain(
      MockSandboxDeployment.coldStorageAddressBook.address
        .slice(2)
        .toLowerCase(),
    )
  })
})

describe('Cascade > buildAgentFaceCalls', () => {
  const tag = `0x${'cc'.repeat(32)}` as const

  it('should build the plugin install and the addSessionKey calls from grants', () => {
    const calls = buildAgentFaceCalls({
      account: MockAccountAddress,
      agents: [
        { sessionKey: MockSessionKeyAddress, tag, grant: MockBufiGrant },
        { sessionKey: MockRecipients[0], grant: MockBufiGrant },
      ],
      deployment: MockSandboxDeployment,
    })
    const permissionUpdates = buildBufiGrant(MockBufiGrant)

    expect(calls.registrations).toEqual([
      { sessionKey: MockSessionKeyAddress, tag, permissionUpdates },
      { sessionKey: MockRecipients[0], tag: zeroHash, permissionUpdates },
    ])
    expect(calls.installSessionKeyPlugin).toEqual(
      encodeInstallSessionKeyPlugin({
        account: MockAccountAddress,
        registrations: calls.registrations,
        deployment: MockSandboxDeployment,
      }),
    )
    expect(calls.addSessionKeys).toEqual(
      calls.registrations.map((registration) => ({
        to: MockAccountAddress,
        value: 0n,
        data: encodeAddSessionKey(registration),
      })),
    )
  })

  it('should fail closed without a session key plugin', () => {
    expect(() =>
      buildAgentFaceCalls({
        account: MockAccountAddress,
        agents: [{ sessionKey: MockSessionKeyAddress, grant: MockBufiGrant }],
        deployment: { ...MockSandboxDeployment, bufiSessionKey: undefined },
      }),
    ).toThrow('The stack deployment has no BUFI session key plugin.')
  })

  it('should fail closed on an invalid grant', () => {
    expect(() =>
      buildAgentFaceCalls({
        account: MockAccountAddress,
        agents: [
          {
            sessionKey: MockSessionKeyAddress,
            grant: { ...MockBufiGrant, scope: { allow: [] } },
          },
        ],
        deployment: MockSandboxDeployment,
      }),
    ).toThrow('A BUFI grant must allow at least one target.')
  })
})
