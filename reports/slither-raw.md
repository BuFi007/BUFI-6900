'forge clean' running (wd: /Users/criptopoeta/coding-dojo/BUFI/BUFI-6900/contracts)
'forge config --json' running
'forge build --build-info --deny never --skip ./test/** ./script/** --force' running (wd: /Users/criptopoeta/coding-dojo/BUFI/BUFI-6900/contracts)
**THIS CHECKLIST IS NOT COMPLETE**. Use `--show-ignored-findings` to show all the results.
Summary
 - [reentrancy-balance](#reentrancy-balance) (4 results) (High)
 - [incorrect-equality](#incorrect-equality) (1 results) (Medium)
 - [uninitialized-local](#uninitialized-local) (10 results) (Medium)
 - [unused-return](#unused-return) (4 results) (Medium)
 - [calls-loop](#calls-loop) (1 results) (Low)
 - [reentrancy-events](#reentrancy-events) (6 results) (Low)
 - [timestamp](#timestamp) (1 results) (Low)
 - [assembly](#assembly) (10 results) (Informational)
## reentrancy-balance
Impact: High
Confidence: Medium
 - [ ] ID-0
Reentrancy in [BufiEarnModule.autoEarn(address,uint256)](src/bufi/v0.7/earn/BufiEarnModule.sol#L260-L292):
	External call allowing reentrancy:
	- [IPluginExecutor(account).executeFromPluginExternal(vaultAddress,0,abi.encodeCall(IERC4626.deposit,(amountToSave,account)))](src/bufi/v0.7/earn/BufiEarnModule.sol#L280-L281)
	Balance read before the call:
	- [tokenBefore = IERC20(token).balanceOf(account)](src/bufi/v0.7/earn/BufiEarnModule.sol#L275)
	Possible stale balance used after the call in a condition:
	- [tokenSpent != amountToSave](src/bufi/v0.7/earn/BufiEarnModule.sol#L287)
		- stale variable `tokenSpent`

src/bufi/v0.7/earn/BufiEarnModule.sol#L260-L292


 - [ ] ID-1
Reentrancy in [BufiEarnModule.autoEarn(address,uint256)](src/bufi/v0.7/earn/BufiEarnModule.sol#L260-L292):
	External call allowing reentrancy:
	- [IPluginExecutor(account).executeFromPluginExternal(token,0,abi.encodeCall(IERC20.approve,(vaultAddress,amountToSave)))](src/bufi/v0.7/earn/BufiEarnModule.sol#L278-L279)
	Balance read before the call:
	- [tokenBefore = IERC20(token).balanceOf(account)](src/bufi/v0.7/earn/BufiEarnModule.sol#L275)
	Possible stale balance used after the call in a condition:
	- [tokenSpent != amountToSave](src/bufi/v0.7/earn/BufiEarnModule.sol#L287)
		- stale variable `tokenSpent`

src/bufi/v0.7/earn/BufiEarnModule.sol#L260-L292


 - [ ] ID-2
Reentrancy in [BufiEarnModule.autoEarn(address,uint256)](src/bufi/v0.7/earn/BufiEarnModule.sol#L260-L292):
	External call allowing reentrancy:
	- [IPluginExecutor(account).executeFromPluginExternal(token,0,abi.encodeCall(IERC20.approve,(vaultAddress,amountToSave)))](src/bufi/v0.7/earn/BufiEarnModule.sol#L278-L279)
	Balance read before the call:
	- [sharesBefore = IERC20(vaultAddress).balanceOf(account)](src/bufi/v0.7/earn/BufiEarnModule.sol#L276)
	Possible stale balance used after the call in a condition:
	- [sharesMinted == 0](src/bufi/v0.7/earn/BufiEarnModule.sol#L284)
		- stale variable `sharesMinted`

src/bufi/v0.7/earn/BufiEarnModule.sol#L260-L292


 - [ ] ID-3
Reentrancy in [BufiEarnModule.autoEarn(address,uint256)](src/bufi/v0.7/earn/BufiEarnModule.sol#L260-L292):
	External call allowing reentrancy:
	- [IPluginExecutor(account).executeFromPluginExternal(vaultAddress,0,abi.encodeCall(IERC4626.deposit,(amountToSave,account)))](src/bufi/v0.7/earn/BufiEarnModule.sol#L280-L281)
	Balance read before the call:
	- [sharesBefore = IERC20(vaultAddress).balanceOf(account)](src/bufi/v0.7/earn/BufiEarnModule.sol#L276)
	Possible stale balance used after the call in a condition:
	- [sharesMinted == 0](src/bufi/v0.7/earn/BufiEarnModule.sol#L284)
		- stale variable `sharesMinted`

src/bufi/v0.7/earn/BufiEarnModule.sol#L260-L292


## incorrect-equality
Impact: Medium
Confidence: High
 - [ ] ID-4
[BufiEarnModule.autoEarn(address,uint256)](src/bufi/v0.7/earn/BufiEarnModule.sol#L260-L292) uses a dangerous strict equality:
	- [sharesMinted == 0](src/bufi/v0.7/earn/BufiEarnModule.sol#L284)

src/bufi/v0.7/earn/BufiEarnModule.sol#L260-L292


## uninitialized-local
Impact: Medium
Confidence: Medium
 - [ ] ID-5
[BufiEarnModule.pluginMetadata().metadata](src/bufi/v0.7/earn/BufiEarnModule.sol#L366) is a local variable never initialized

src/bufi/v0.7/earn/BufiEarnModule.sol#L366


 - [ ] ID-6
[SessionKeyPermissions._checkSpendLimitUsage(uint256,SessionKeyPermissionsBase.SpendLimitTimeInfo,SessionKeyPermissionsBase.SpendLimit).validAfter](src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L283) is a local variable never initialized

src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L283


 - [ ] ID-7
[SessionKeyPermissions._getMaxGasCost(PackedUserOperation).paymasterPostOpGasLimit](src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L175) is a local variable never initialized

src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L175


 - [ ] ID-8
[SessionKeyPermissions._updateLimitsPreExec(address,Call[],address).newNativeTokenUsage](src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L226) is a local variable never initialized

src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L226


 - [ ] ID-9
[BufiSessionKeyPlugin.pluginMetadata().metadata](src/bufi/v0.7/session/BufiSessionKeyPlugin.sol#L355) is a local variable never initialized

src/bufi/v0.7/session/BufiSessionKeyPlugin.sol#L355


 - [ ] ID-10
[SessionKeyPermissions._checkAndUpdateGasLimitUsage(uint256,SessionKeyPermissionsBase.SessionKeyData).validAfter](src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L335) is a local variable never initialized

src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L335


 - [ ] ID-11
[SessionKeyPermissions._getMaxGasCost(PackedUserOperation).paymasterVerificationGasLimit](src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L174) is a local variable never initialized

src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L174


 - [ ] ID-12
[BufiEarnModule._manifest().manifest](src/bufi/v0.7/earn/BufiEarnModule.sol#L398) is a local variable never initialized

src/bufi/v0.7/earn/BufiEarnModule.sol#L398


 - [ ] ID-13
[SessionKeyPermissions._checkUserOpPermissions(PackedUserOperation,Call[],address).nativeTokenSpend](src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L93) is a local variable never initialized

src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L93


 - [ ] ID-14
[BufiSessionKeyPlugin.pluginManifest().manifest](src/bufi/v0.7/session/BufiSessionKeyPlugin.sol#L272) is a local variable never initialized

src/bufi/v0.7/session/BufiSessionKeyPlugin.sol#L272


## unused-return
Impact: Medium
Confidence: Medium
 - [ ] ID-15
[BufiEarnModule.autoEarn(address,uint256)](src/bufi/v0.7/earn/BufiEarnModule.sol#L260-L292) ignores return value by [IPluginExecutor(account).executeFromPluginExternal(token,0,abi.encodeCall(IERC20.approve,(vaultAddress,amountToSave)))](src/bufi/v0.7/earn/BufiEarnModule.sol#L278-L279)

src/bufi/v0.7/earn/BufiEarnModule.sol#L260-L292


 - [ ] ID-16
[BufiEarnModule.autoEarn(address,uint256)](src/bufi/v0.7/earn/BufiEarnModule.sol#L260-L292) ignores return value by [IPluginExecutor(account).executeFromPluginExternal(vaultAddress,0,abi.encodeCall(IERC4626.deposit,(amountToSave,account)))](src/bufi/v0.7/earn/BufiEarnModule.sol#L280-L281)

src/bufi/v0.7/earn/BufiEarnModule.sol#L260-L292


 - [ ] ID-17
[BufiSessionKeyPlugin.userOpValidationFunction(uint8,PackedUserOperation,bytes32)](src/bufi/v0.7/session/BufiSessionKeyPlugin.sol#L240-L266) ignores return value by [(recoveredSig,err,None) = hash.tryRecover(userOp.signature)](src/bufi/v0.7/session/BufiSessionKeyPlugin.sol#L249)

src/bufi/v0.7/session/BufiSessionKeyPlugin.sol#L240-L266


 - [ ] ID-18
[SessionKeyPermissions._getMaxGasCost(PackedUserOperation)](src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L173-L183) ignores return value by [(None,paymasterVerificationGasLimit,paymasterPostOpGasLimit) = UserOperationLib.unpackPaymasterStaticFields(userOp.paymasterAndData)](src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L177-L178)

src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L173-L183


## calls-loop
Impact: Low
Confidence: Medium
 - [ ] ID-19
[BufiSessionKeyPlugin.executeWithSessionKey(Call[],address)](src/bufi/v0.7/session/BufiSessionKeyPlugin.sol#L91-L108) has external calls inside a loop: [results[i] = IPluginExecutor(msg.sender).executeFromPluginExternal(call.target,call.value,call.data)](src/bufi/v0.7/session/BufiSessionKeyPlugin.sol#L104)

src/bufi/v0.7/session/BufiSessionKeyPlugin.sol#L91-L108


## reentrancy-events
Impact: Low
Confidence: Medium
 - [ ] ID-20
Reentrancy in [GatewayExecutionModule.authorizeDelegate(address,address)](src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L190-L199):
	External calls:
	- [_gatewayWallet.addDelegate(token,delegate)](src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L196)
	Event emitted after the call(s):
	- [DelegateAuthorized(msg.sender,token,delegate)](src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L198)

src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L190-L199


 - [ ] ID-21
Reentrancy in [GatewayExecutionModule.depositToGateway(address,uint256)](src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L217-L229):
	External calls:
	- [IERC20(token).safeIncreaseAllowance(address(_gatewayWallet),amount)](src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L223)
	- [_gatewayWallet.deposit(token,amount)](src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L226)
	Event emitted after the call(s):
	- [DepositedToGateway(msg.sender,token,amount)](src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L228)

src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L217-L229


 - [ ] ID-22
Reentrancy in [GatewayExecutionModule.revokeDelegate(address,address)](src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L204-L212):
	External calls:
	- [_gatewayWallet.removeDelegate(token,delegate)](src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L209)
	Event emitted after the call(s):
	- [DelegateRevoked(msg.sender,token,delegate)](src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L211)

src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L204-L212


 - [ ] ID-23
Reentrancy in [BufiEarnModule.autoEarn(address,uint256)](src/bufi/v0.7/earn/BufiEarnModule.sol#L260-L292):
	External calls:
	- [IPluginExecutor(account).executeFromPluginExternal(token,0,abi.encodeCall(IERC20.approve,(vaultAddress,amountToSave)))](src/bufi/v0.7/earn/BufiEarnModule.sol#L278-L279)
	- [IPluginExecutor(account).executeFromPluginExternal(vaultAddress,0,abi.encodeCall(IERC4626.deposit,(amountToSave,account)))](src/bufi/v0.7/earn/BufiEarnModule.sol#L280-L281)
	Event emitted after the call(s):
	- [AutoEarnExecuted(account,token,amountToSave)](src/bufi/v0.7/earn/BufiEarnModule.sol#L291)

src/bufi/v0.7/earn/BufiEarnModule.sol#L260-L292


 - [ ] ID-24
Reentrancy in [GatewayExecutionModule.completeWithdrawal(address)](src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L247-L257):
	External calls:
	- [_gatewayWallet.withdraw(token)](src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L254)
	Event emitted after the call(s):
	- [WithdrawalCompleted(msg.sender,token,withdrawable)](src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L256)

src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L247-L257


 - [ ] ID-25
Reentrancy in [GatewayExecutionModule.initiateWithdrawal(address,uint256)](src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L234-L242):
	External calls:
	- [_gatewayWallet.initiateWithdrawal(token,amount)](src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L239)
	Event emitted after the call(s):
	- [WithdrawalInitiated(msg.sender,token,amount)](src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L241)

src/bufi/v0.8/gateway/GatewayExecutionModule.sol#L234-L242


## timestamp
Impact: Low
Confidence: Medium
 - [ ] ID-26
[SessionKeyPermissions._runtimeUpdateSpendLimitUsage(uint256,SessionKeyPermissionsBase.SpendLimitTimeInfo,SessionKeyPermissionsBase.SpendLimit)](src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L410-L450) uses timestamp for comparisons
	Dangerous comparisons:
	- [refreshInterval == 0 || lastUsed + refreshInterval > block.timestamp](src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L420)

src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L410-L450


## assembly
Impact: Informational
Confidence: High
 - [ ] ID-27
[SessionKeyPermissions._getTokenSpendAmount(bytes)](src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L461-L487) uses assembly
	- [INLINE ASM](src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L479-L482)

src/bufi/v0.7/session/permissions/SessionKeyPermissions.sol#L461-L487


 - [ ] ID-28
[SessionKeyPermissionsBase._toSessionKeyData(StoragePointer)](src/bufi/v0.7/session/permissions/SessionKeyPermissionsBase.sol#L216-L220) uses assembly
	- [INLINE ASM](src/bufi/v0.7/session/permissions/SessionKeyPermissionsBase.sol#L217-L219)

src/bufi/v0.7/session/permissions/SessionKeyPermissionsBase.sol#L216-L220


 - [ ] ID-29
[SessionKeyPermissionsBase._toContractData(StoragePointer)](src/bufi/v0.7/session/permissions/SessionKeyPermissionsBase.sol#L222-L226) uses assembly
	- [INLINE ASM](src/bufi/v0.7/session/permissions/SessionKeyPermissionsBase.sol#L223-L225)

src/bufi/v0.7/session/permissions/SessionKeyPermissionsBase.sol#L222-L226


 - [ ] ID-30
[BufiSessionKeyPlugin.onInstall(bytes)](src/bufi/v0.7/session/BufiSessionKeyPlugin.sol#L184-L219) uses assembly
	- [INLINE ASM](src/bufi/v0.7/session/BufiSessionKeyPlugin.sol#L193-L206)

src/bufi/v0.7/session/BufiSessionKeyPlugin.sol#L184-L219


 - [ ] ID-31
[SessionKeyPermissionsBase._toFunctionData(StoragePointer)](src/bufi/v0.7/session/permissions/SessionKeyPermissionsBase.sol#L228-L232) uses assembly
	- [INLINE ASM](src/bufi/v0.7/session/permissions/SessionKeyPermissionsBase.sol#L229-L231)

src/bufi/v0.7/session/permissions/SessionKeyPermissionsBase.sol#L228-L232


 - [ ] ID-32
[PluginStorageLib.allocateAssociatedStorageKey(address,uint256,uint8)](src/bufi/v0.7/session/libraries/PluginStorageLib.sol#L29-L52) uses assembly
	- [INLINE ASM](src/bufi/v0.7/session/libraries/PluginStorageLib.sol#L34-L51)

src/bufi/v0.7/session/libraries/PluginStorageLib.sol#L29-L52


 - [ ] ID-33
[SessionKeyPermissionsBase._updateSessionKeyId(address,address,SessionKeyPermissionsBase.SessionKeyId)](src/bufi/v0.7/session/permissions/SessionKeyPermissionsBase.sol#L147-L156) uses assembly
	- [INLINE ASM](src/bufi/v0.7/session/permissions/SessionKeyPermissionsBase.sol#L153-L155)

src/bufi/v0.7/session/permissions/SessionKeyPermissionsBase.sol#L147-L156


 - [ ] ID-34
[PluginStorageLib.associatedStorageLookup(bytes,bytes32)](src/bufi/v0.7/session/libraries/PluginStorageLib.sol#L54-L59) uses assembly
	- [INLINE ASM](src/bufi/v0.7/session/libraries/PluginStorageLib.sol#L55-L58)

src/bufi/v0.7/session/libraries/PluginStorageLib.sol#L54-L59


 - [ ] ID-35
[PluginStorageLib.associatedStorageLookup(bytes,bytes32,bytes32)](src/bufi/v0.7/session/libraries/PluginStorageLib.sol#L61-L71) uses assembly
	- [INLINE ASM](src/bufi/v0.7/session/libraries/PluginStorageLib.sol#L66-L70)

src/bufi/v0.7/session/libraries/PluginStorageLib.sol#L61-L71


 - [ ] ID-36
[SessionKeyPermissionsBase._sessionKeyIdOf(address,address)](src/bufi/v0.7/session/permissions/SessionKeyPermissionsBase.sol#L127-L136) uses assembly
	- [INLINE ASM](src/bufi/v0.7/session/permissions/SessionKeyPermissionsBase.sol#L133-L135)

src/bufi/v0.7/session/permissions/SessionKeyPermissionsBase.sol#L127-L136


