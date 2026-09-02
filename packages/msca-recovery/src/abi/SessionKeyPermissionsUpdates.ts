/**
 * Copyright 2026 BUFI. All rights reserved.
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
 *
 * SPDX-License-Identifier: Apache-2.0
 */

// Generated from contracts/out/ISessionKeyPermissionsUpdates.sol/ISessionKeyPermissionsUpdates.json (contracts/src/bufi/v0.7/session/permissions/ISessionKeyPermissionsUpdates.sol). These functions are never called on-chain: each ABI-encoded call is one element of the bytes[] that addSessionKey / updateKeyPermissions / onInstall accept.

export const SessionKeyPermissionsUpdatesABI = [
  {
    type: "function",
    name: "setAccessListType",
    inputs: [
      {
        name: "contractAccessControlType",
        type: "uint8",
        internalType: "enum IBufiSessionKeyPlugin.ContractAccessControlType",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setERC20SpendLimit",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "spendLimit",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "refreshInterval",
        type: "uint48",
        internalType: "uint48",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setGasSpendLimit",
    inputs: [
      {
        name: "spendLimit",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "refreshInterval",
        type: "uint48",
        internalType: "uint48",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setNativeTokenSpendLimit",
    inputs: [
      {
        name: "spendLimit",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "refreshInterval",
        type: "uint48",
        internalType: "uint48",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setRequiredPaymaster",
    inputs: [
      {
        name: "requiredPaymaster",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "updateAccessListAddressEntry",
    inputs: [
      {
        name: "contractAddress",
        type: "address",
        internalType: "address",
      },
      {
        name: "isOnList",
        type: "bool",
        internalType: "bool",
      },
      {
        name: "checkSelectors",
        type: "bool",
        internalType: "bool",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "updateAccessListFunctionEntry",
    inputs: [
      {
        name: "contractAddress",
        type: "address",
        internalType: "address",
      },
      {
        name: "selector",
        type: "bytes4",
        internalType: "bytes4",
      },
      {
        name: "isOnList",
        type: "bool",
        internalType: "bool",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "updateTimeRange",
    inputs: [
      {
        name: "validAfter",
        type: "uint48",
        internalType: "uint48",
      },
      {
        name: "validUntil",
        type: "uint48",
        internalType: "uint48",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;
