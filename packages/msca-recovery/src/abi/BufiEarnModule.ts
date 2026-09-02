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

// Generated from contracts/out/BufiEarnModule.sol/BufiEarnModule.json (forge artifact of contracts/src/bufi/v0.7/earn/BufiEarnModule.sol). Regenerate after a contract change; do not hand-edit.

export const BufiEarnModuleABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "_authorizedRelayer",
        type: "address",
        internalType: "address",
      },
      {
        name: "_owner",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "FUNCTION_ID_RUNTIME_VALIDATION_RELAYER",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint8",
        internalType: "uint8",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "OWNER_RUNTIME_VALIDATION_DEPENDENCY_INDEX",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "OWNER_USER_OP_VALIDATION_DEPENDENCY_INDEX",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "accountConfig",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "addAuthorizedRelayer",
    inputs: [
      {
        name: "newRelayer",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "authorizedRelayers",
    inputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "autoEarn",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "amountToSave",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "changeConfigHash",
    inputs: [
      {
        name: "newConfigHash",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "config",
    inputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getAllConfigs",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        internalType: "struct BufiEarnModule.ConfigWithToken[]",
        components: [
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "vault",
            type: "address",
            internalType: "address",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getTokens",
    inputs: [
      {
        name: "configHash_",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "chainId_",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "address[]",
        internalType: "address[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isInitialized",
    inputs: [
      {
        name: "smartAccount",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "manifestHash",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "onInstall",
    inputs: [
      {
        name: "data",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "onUninstall",
    inputs: [
      {
        name: "",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pluginManifest",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct PluginManifest",
        components: [
          {
            name: "interfaceIds",
            type: "bytes4[]",
            internalType: "bytes4[]",
          },
          {
            name: "dependencyInterfaceIds",
            type: "bytes4[]",
            internalType: "bytes4[]",
          },
          {
            name: "executionFunctions",
            type: "bytes4[]",
            internalType: "bytes4[]",
          },
          {
            name: "permittedExecutionSelectors",
            type: "bytes4[]",
            internalType: "bytes4[]",
          },
          {
            name: "permitAnyExternalAddress",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "canSpendNativeToken",
            type: "bool",
            internalType: "bool",
          },
          {
            name: "permittedExternalCalls",
            type: "tuple[]",
            internalType: "struct ManifestExternalCallPermission[]",
            components: [
              {
                name: "externalAddress",
                type: "address",
                internalType: "address",
              },
              {
                name: "permitAnySelector",
                type: "bool",
                internalType: "bool",
              },
              {
                name: "selectors",
                type: "bytes4[]",
                internalType: "bytes4[]",
              },
            ],
          },
          {
            name: "userOpValidationFunctions",
            type: "tuple[]",
            internalType: "struct ManifestAssociatedFunction[]",
            components: [
              {
                name: "executionSelector",
                type: "bytes4",
                internalType: "bytes4",
              },
              {
                name: "associatedFunction",
                type: "tuple",
                internalType: "struct ManifestFunction",
                components: [
                  {
                    name: "functionType",
                    type: "uint8",
                    internalType: "enum ManifestAssociatedFunctionType",
                  },
                  {
                    name: "functionId",
                    type: "uint8",
                    internalType: "uint8",
                  },
                  {
                    name: "dependencyIndex",
                    type: "uint256",
                    internalType: "uint256",
                  },
                ],
              },
            ],
          },
          {
            name: "runtimeValidationFunctions",
            type: "tuple[]",
            internalType: "struct ManifestAssociatedFunction[]",
            components: [
              {
                name: "executionSelector",
                type: "bytes4",
                internalType: "bytes4",
              },
              {
                name: "associatedFunction",
                type: "tuple",
                internalType: "struct ManifestFunction",
                components: [
                  {
                    name: "functionType",
                    type: "uint8",
                    internalType: "enum ManifestAssociatedFunctionType",
                  },
                  {
                    name: "functionId",
                    type: "uint8",
                    internalType: "uint8",
                  },
                  {
                    name: "dependencyIndex",
                    type: "uint256",
                    internalType: "uint256",
                  },
                ],
              },
            ],
          },
          {
            name: "preUserOpValidationHooks",
            type: "tuple[]",
            internalType: "struct ManifestAssociatedFunction[]",
            components: [
              {
                name: "executionSelector",
                type: "bytes4",
                internalType: "bytes4",
              },
              {
                name: "associatedFunction",
                type: "tuple",
                internalType: "struct ManifestFunction",
                components: [
                  {
                    name: "functionType",
                    type: "uint8",
                    internalType: "enum ManifestAssociatedFunctionType",
                  },
                  {
                    name: "functionId",
                    type: "uint8",
                    internalType: "uint8",
                  },
                  {
                    name: "dependencyIndex",
                    type: "uint256",
                    internalType: "uint256",
                  },
                ],
              },
            ],
          },
          {
            name: "preRuntimeValidationHooks",
            type: "tuple[]",
            internalType: "struct ManifestAssociatedFunction[]",
            components: [
              {
                name: "executionSelector",
                type: "bytes4",
                internalType: "bytes4",
              },
              {
                name: "associatedFunction",
                type: "tuple",
                internalType: "struct ManifestFunction",
                components: [
                  {
                    name: "functionType",
                    type: "uint8",
                    internalType: "enum ManifestAssociatedFunctionType",
                  },
                  {
                    name: "functionId",
                    type: "uint8",
                    internalType: "uint8",
                  },
                  {
                    name: "dependencyIndex",
                    type: "uint256",
                    internalType: "uint256",
                  },
                ],
              },
            ],
          },
          {
            name: "executionHooks",
            type: "tuple[]",
            internalType: "struct ManifestExecutionHook[]",
            components: [
              {
                name: "selector",
                type: "bytes4",
                internalType: "bytes4",
              },
              {
                name: "preExecHook",
                type: "tuple",
                internalType: "struct ManifestFunction",
                components: [
                  {
                    name: "functionType",
                    type: "uint8",
                    internalType: "enum ManifestAssociatedFunctionType",
                  },
                  {
                    name: "functionId",
                    type: "uint8",
                    internalType: "uint8",
                  },
                  {
                    name: "dependencyIndex",
                    type: "uint256",
                    internalType: "uint256",
                  },
                ],
              },
              {
                name: "postExecHook",
                type: "tuple",
                internalType: "struct ManifestFunction",
                components: [
                  {
                    name: "functionType",
                    type: "uint8",
                    internalType: "enum ManifestAssociatedFunctionType",
                  },
                  {
                    name: "functionId",
                    type: "uint8",
                    internalType: "uint8",
                  },
                  {
                    name: "dependencyIndex",
                    type: "uint256",
                    internalType: "uint256",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "pluginMetadata",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "tuple",
        internalType: "struct PluginMetadata",
        components: [
          {
            name: "name",
            type: "string",
            internalType: "string",
          },
          {
            name: "version",
            type: "string",
            internalType: "string",
          },
          {
            name: "author",
            type: "string",
            internalType: "string",
          },
          {
            name: "permissionDescriptors",
            type: "tuple[]",
            internalType: "struct SelectorPermission[]",
            components: [
              {
                name: "functionSelector",
                type: "bytes4",
                internalType: "bytes4",
              },
              {
                name: "permissionDescription",
                type: "string",
                internalType: "string",
              },
            ],
          },
        ],
      },
    ],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "postExecutionHook",
    inputs: [
      {
        name: "",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "preExecutionHook",
    inputs: [
      {
        name: "",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "",
        type: "address",
        internalType: "address",
      },
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "preRuntimeValidationHook",
    inputs: [
      {
        name: "",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "",
        type: "address",
        internalType: "address",
      },
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "preUserOpValidationHook",
    inputs: [
      {
        name: "",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "",
        type: "tuple",
        internalType: "struct PackedUserOperation",
        components: [
          {
            name: "sender",
            type: "address",
            internalType: "address",
          },
          {
            name: "nonce",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "initCode",
            type: "bytes",
            internalType: "bytes",
          },
          {
            name: "callData",
            type: "bytes",
            internalType: "bytes",
          },
          {
            name: "accountGasLimits",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "preVerificationGas",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "gasFees",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "paymasterAndData",
            type: "bytes",
            internalType: "bytes",
          },
          {
            name: "signature",
            type: "bytes",
            internalType: "bytes",
          },
        ],
      },
      {
        name: "",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "removeAuthorizedRelayer",
    inputs: [
      {
        name: "relayer",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "renounceOwnership",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "runtimeValidationFunction",
    inputs: [
      {
        name: "functionId",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "sender",
        type: "address",
        internalType: "address",
      },
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "",
        type: "bytes",
        internalType: "bytes",
      },
    ],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "setConfig",
    inputs: [
      {
        name: "newConfigs",
        type: "tuple[]",
        internalType: "struct BufiEarnModule.ConfigInput[]",
        components: [
          {
            name: "chainId",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "vault",
            type: "address",
            internalType: "address",
          },
        ],
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "supportsInterface",
    inputs: [
      {
        name: "interfaceId",
        type: "bytes4",
        internalType: "bytes4",
      },
    ],
    outputs: [
      {
        name: "",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "pure",
  },
  {
    type: "function",
    name: "transferOwnership",
    inputs: [
      {
        name: "newOwner",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "userOpValidationFunction",
    inputs: [
      {
        name: "",
        type: "uint8",
        internalType: "uint8",
      },
      {
        name: "",
        type: "tuple",
        internalType: "struct PackedUserOperation",
        components: [
          {
            name: "sender",
            type: "address",
            internalType: "address",
          },
          {
            name: "nonce",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "initCode",
            type: "bytes",
            internalType: "bytes",
          },
          {
            name: "callData",
            type: "bytes",
            internalType: "bytes",
          },
          {
            name: "accountGasLimits",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "preVerificationGas",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "gasFees",
            type: "bytes32",
            internalType: "bytes32",
          },
          {
            name: "paymasterAndData",
            type: "bytes",
            internalType: "bytes",
          },
          {
            name: "signature",
            type: "bytes",
            internalType: "bytes",
          },
        ],
      },
      {
        name: "",
        type: "bytes32",
        internalType: "bytes32",
      },
    ],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "pure",
  },
  {
    type: "event",
    name: "AddAuthorizedRelayer",
    inputs: [
      {
        name: "relayer",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "AutoEarnExecuted",
    inputs: [
      {
        name: "smartAccount",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "token",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amountIn",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ConfigHashChanged",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "oldConfigHash",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "newConfigHash",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ConfigSet",
    inputs: [
      {
        name: "configHash",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "chainId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "token",
        type: "address",
        indexed: false,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ModuleInitialized",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ModuleUninitialized",
    inputs: [
      {
        name: "account",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      {
        name: "previousOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "newOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "RemoveAuthorizedRelayer",
    inputs: [
      {
        name: "relayer",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "ConfigNotFound",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "EmptyConfigList",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidConfigHash",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidFunctionId",
    inputs: [
      {
        name: "functionId",
        type: "uint8",
        internalType: "uint8",
      },
    ],
  },
  {
    type: "error",
    name: "ModuleAlreadyInitialized",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "ModuleNotInitialized",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "NotAuthorized",
    inputs: [
      {
        name: "caller",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "NotImplemented",
    inputs: [],
  },
  {
    type: "error",
    name: "OwnableInvalidOwner",
    inputs: [
      {
        name: "owner",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "OwnableUnauthorizedAccount",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "TooManyTokens",
    inputs: [],
  },
] as const;
